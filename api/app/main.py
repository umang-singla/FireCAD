import os
import subprocess
from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware
from fastapi.staticfiles import StaticFiles

from app.routers import projects, detectors, auth, ws, teams, activity

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

# API
app.include_router(auth.router, prefix="/api")
app.include_router(projects.router, prefix="/api")
app.include_router(detectors.router, prefix="/api")
app.include_router(teams.router, prefix="/api")
app.include_router(activity.router, prefix="/api")

# WebSocket (real-time pipeline status)
app.include_router(ws.router)

# Static: project artifacts (render.png, mapping.json, etc.)
app.mount("/files", StaticFiles(directory=DATA_DIR), name="files")


@app.on_event("startup")
async def _capture_event_loop() -> None:
    """Store the main asyncio loop so background threads can schedule WS broadcasts."""
    import asyncio
    from app.ws_manager import manager  # noqa: F811
    manager.set_loop(asyncio.get_running_loop())


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