import os
import re
import subprocess
import time

from fastapi import FastAPI, HTTPException
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import FileResponse, RedirectResponse
from starlette.middleware.base import BaseHTTPMiddleware
from starlette.requests import Request

from app import gcs
from app.routers import projects, detectors, auth, ws, teams, activity, boq

DATA_DIR = os.getenv("DATA_DIR", "/data")
os.makedirs(DATA_DIR, exist_ok=True)

app = FastAPI(title="Mepit.AI API", version="0.1.0")

app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],  # tighten in production
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)


# ---------------------------------------------------------------------------
# GCS sync middleware
#
# We keep the local DATA_DIR as a working cache so existing pipeline code
# (subprocess tools, PIL, OpenCV, ezdxf) stays unchanged. The middleware:
#   * On GET requests that target a project, hydrates the local cache from
#     GCS so the route sees the latest artifacts.
#   * On mutating requests, uploads any files written under the project dir
#     to GCS after the response is produced.
# Disabled (no-op) when `GCS_BUCKET` is not configured.
# ---------------------------------------------------------------------------

_PROJECT_PATH_RE = re.compile(
    r"/(?:api/)?(?:projects|detectors|boq|activity)/(?P<pid>[0-9a-fA-F-]{8,})"
)
_MUTATING_METHODS = {"POST", "PUT", "PATCH", "DELETE"}


class GCSSyncMiddleware(BaseHTTPMiddleware):
    async def dispatch(self, request: Request, call_next):
        pid: str | None = None
        if gcs.enabled():
            m = _PROJECT_PATH_RE.search(request.url.path)
            if m:
                pid = m.group("pid")

        # Cache hydration policy: only download from GCS when the project dir
        # is MISSING locally (cold-start on a fresh container). Once we have a
        # local copy, do NOT re-pull — that races against the running pipeline
        # which is actively writing the same files, and would overwrite
        # half-written outputs with the previous run's stale GCS copy.
        if pid and request.method == "GET":
            local_project_dir = os.path.join(DATA_DIR, "projects", pid)
            if not os.path.isdir(local_project_dir):
                try:
                    n = gcs.ensure_project_cached(pid)
                    if n:
                        print(f"[gcs] cold-start hydrated {n} files for project {pid}")
                except Exception as exc:  # pragma: no cover - best-effort
                    print(f"[gcs] ensure_project_cached({pid}) failed: {exc!r}")

        start_ts = time.time()
        response = await call_next(request)

        # Upload anything written during this request (covers synchronous file
        # writes like /upload and /aligned_mask). Long-running pipeline tasks
        # are uploaded via a separate `gcs.sync_project_to_gcs` background task
        # chained after them in the route handlers.
        if pid and request.method in _MUTATING_METHODS:
            try:
                from app.storage import project_dir  # local import to avoid cycle
                n = gcs.upload_dir(project_dir(pid), since_ts=start_ts - 2.0)
                if n:
                    print(f"[gcs] uploaded {n} files for project {pid}")
            except Exception as exc:  # pragma: no cover - best-effort
                print(f"[gcs] post-request upload for {pid} failed: {exc!r}")

        return response


app.add_middleware(GCSSyncMiddleware)


# API
app.include_router(auth.router, prefix="/api")
app.include_router(projects.router, prefix="/api")
app.include_router(detectors.router, prefix="/api")
app.include_router(teams.router, prefix="/api")
app.include_router(activity.router, prefix="/api")
app.include_router(boq.router, prefix="/api")

# WebSocket (real-time pipeline status)
app.include_router(ws.router)


# ---------------------------------------------------------------------------
# /files/<rel>: serve project artifacts.
#
#   * When GCS is enabled and signing succeeds, redirect to a v4 signed URL
#     so the browser streams directly from the bucket.
#   * Otherwise, hydrate the local cache on demand and stream the file from
#     disk. This keeps local development (and any deployment without GCS
#     credentials) working unchanged.
# ---------------------------------------------------------------------------


@app.get("/files/{rel_path:path}")
def serve_file(rel_path: str):
    rel = rel_path.replace("\\", "/").lstrip("/")
    if ".." in rel.split("/"):
        raise HTTPException(status_code=400, detail="invalid path")

    local_path = os.path.join(DATA_DIR, rel.replace("/", os.sep))
    local_exists = os.path.isfile(local_path)

    # Prefer GCS only when the blob actually exists. Otherwise the browser
    # would follow a signed URL straight to a 404 on the bucket.
    if gcs.enabled() and gcs.blob_exists(local_path):
        url = gcs.signed_url_for_rel(rel)
        if url:
            return RedirectResponse(url, status_code=302)

    # Local fallback. Hydrate from GCS if we don't have it cached yet.
    if not local_exists and gcs.enabled():
        gcs.ensure_rel_cached(rel)
        local_exists = os.path.isfile(local_path)

    if not local_exists:
        raise HTTPException(status_code=404, detail="file not found")

    # Opportunistically push the local file to GCS so subsequent requests
    # can use the fast signed-URL path.
    if gcs.enabled():
        try:
            gcs.upload_path(local_path)
        except Exception:  # noqa: BLE001 — never block the response on a sync failure
            pass

    return FileResponse(local_path)


@app.on_event("startup")
async def _capture_event_loop() -> None:
    """Store the main asyncio loop so background threads can schedule WS broadcasts."""
    import asyncio
    from app.ws_manager import manager  # noqa: F811
    manager.set_loop(asyncio.get_running_loop())


@app.on_event("startup")
def _gcs_startup_diagnostics() -> None:
    try:
        gcs.log_startup_status()
    except Exception as exc:  # pragma: no cover
        print(f"[gcs] startup diagnostics crashed: {exc!r}")


@app.on_event("startup")
def qcad_runtime_diagnostics() -> None:
    qcad_dir = "/opt/qcad"
    qcad_bin = os.path.join(qcad_dir, "qcad-bin")
    qcad_wrapper = os.path.join(qcad_dir, "qcad")
    qcad_lib = os.path.join(qcad_dir, "libqcadecmaapi.so")
    qcad_dwg2bmp = os.path.join(qcad_dir, "dwg2bmp")

    if os.path.isfile(qcad_dwg2bmp):
        os.environ.setdefault("QCAD_DWG2BMP", qcad_dwg2bmp)
    if os.path.isdir(qcad_dir):
        current = os.getenv("LD_LIBRARY_PATH", "")
        if qcad_dir not in current.split(":"):
            os.environ["LD_LIBRARY_PATH"] = f"{qcad_dir}:{current}" if current else qcad_dir

    print(
        "[qcad-startup]",
        {
            "qcad_dir": qcad_dir,
            "dir_exists": os.path.isdir(qcad_dir),
            "qcad_wrapper_exists": os.path.isfile(qcad_wrapper),
            "qcad_bin_exists": os.path.isfile(qcad_bin),
            "qcad_lib_exists": os.path.isfile(qcad_lib),
            "qcad_dwg2bmp_exists": os.path.isfile(qcad_dwg2bmp),
            "QCAD_DWG2BMP": os.getenv("QCAD_DWG2BMP"),
            "LD_LIBRARY_PATH": os.getenv("LD_LIBRARY_PATH", ""),
        },
    )

    if os.path.isfile(qcad_wrapper):
        env = os.environ.copy()
        try:
            out = subprocess.check_output(
                [qcad_wrapper, "-platform", "offscreen", "-version"],
                stderr=subprocess.STDOUT,
                env=env,
                cwd=qcad_dir,
                timeout=20,
                text=True,
            )
            print("[qcad-startup] qcad-version-ok", out.strip().splitlines()[-1] if out.strip() else "ok")
        except Exception as exc:
            print(f"[qcad-startup] qcad-version-failed: {exc}")