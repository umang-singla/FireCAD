import os
import json
from fastapi import APIRouter, UploadFile, File, HTTPException, BackgroundTasks, Depends
from pydantic import BaseModel
from typing import Any, Dict, Optional
from app.db import db, now, log_activity
from app.storage import new_id, project_dir, relpath
from app import gcs
from app.schemas import ProjectOut, ProjectUpdateSettings
from app.pipeline.run_pipeline import (
    run_pipeline_for_project,
    continue_pipeline_after_floor_review,
    continue_pipeline_after_alignment,
    continue_pipeline_after_rooms,
    retry_mask_generation,
    PipelineOptions,
)
from app.pipeline.gemini_mask import generate_mask_image, DEFAULT_PROMPT
from app.pipeline.mask_align import align_perfect_tight_box
from app.pipeline.dxf_export import write_detectors_to_dxf, write_combined_sheets_dxf
from app.pipeline.render import get_dxf_bbox
from app.pipeline.nbc_rules import (
    get_questions as nbc_get_questions,
    evaluate_building,
    OCCUPANCY_DISPLAY_LABELS,
    FOLLOWUP_QUESTIONS,
)
from app.routers.auth import get_current_user

router = APIRouter(tags=["projects"])


def _parse_region_polygon(payload) -> list[tuple[float, float]] | None:
    """Extract an (x,y) polygon from a route_pipes request payload, or None."""
    if not payload or not isinstance(payload, dict):
        return None
    region = payload.get("region")
    if not isinstance(region, list) or len(region) < 3:
        return None
    pts: list[tuple[float, float]] = []
    for v in region:
        if isinstance(v, dict) and "x" in v and "y" in v:
            try:
                pts.append((float(v["x"]), float(v["y"])))
            except (TypeError, ValueError):
                return None
    return pts if len(pts) >= 3 else None


def _point_in_polygon(x: float, y: float, poly: list[tuple[float, float]]) -> bool:
    """Ray-cast point-in-polygon test (inclusive on edges is best-effort)."""
    inside = False
    n = len(poly)
    j = n - 1
    for i in range(n):
        xi, yi = poly[i]
        xj, yj = poly[j]
        if ((yi > y) != (yj > y)) and (x < (xj - xi) * (y - yi) / ((yj - yi) or 1e-12) + xi):
            inside = not inside
        j = i
    return inside


def _merge_pipes_file(path: str, new_pipes: list, new_sources: list) -> dict:
    """Append *new_pipes*/*new_sources* to an existing pipes JSON file and
    return the merged structure. If the file does not exist (or is corrupt)
    the new data is written as-is."""
    existing: dict = {"pipes": [], "sources": []}
    if os.path.exists(path):
        try:
            with open(path, "r", encoding="utf-8") as f:
                existing = json.load(f) or {"pipes": [], "sources": []}
        except (OSError, ValueError):
            existing = {"pipes": [], "sources": []}
    existing_pipes = list(existing.get("pipes") or [])
    existing_sources = list(existing.get("sources") or [])

    def _src_key(s):
        try:
            return (round(float(s.get("x", 0)), 3), round(float(s.get("y", 0)), 3))
        except (TypeError, ValueError):
            return None
    seen = {_src_key(s) for s in existing_sources if _src_key(s) is not None}
    for s in new_sources:
        k = _src_key(s)
        if k is None or k in seen:
            continue
        existing_sources.append(s)
        seen.add(k)

    merged = {
        "pipes": existing_pipes + list(new_pipes),
        "sources": existing_sources,
    }
    with open(path, "w", encoding="utf-8") as f:
        json.dump(merged, f, indent=2)
    return merged


# Keep MCP and Hooter as a tight side-by-side pair.
MCP_HOOTER_PAIR_OFFSET_M = 0.45


def _artifact_exists(path: str | None) -> bool:
    """True if the file exists locally OR in GCS.

    Avoids hiding artifacts that live in the bucket but haven't been pulled
    into the local cache yet (cold-started Cloud Run instances, etc.).
    """
    if not path:
        return False
    if os.path.exists(path):
        return True
    return gcs.blob_exists(path)


def _normalize_data_path(p: str | None) -> str | None:
    """Normalize persisted file paths to be rooted under DATA_DIR.

    Handles legacy relative values like "data/projects/..." or Windows-style
    separators so API serialization never crashes on relpath conversion.
    """
    if not p:
        return None

    s = str(p).strip()
    if not s:
        return None

    # If already absolute and valid, keep as-is.
    if os.path.isabs(s):
        return s

    norm = s.replace("\\", "/")
    base = os.getenv("DATA_DIR", "/data").replace("\\", "/").rstrip("/")

    if norm.startswith("data/"):
        rest = norm[len("data/"):]
        return os.path.join(base, *rest.split("/"))

    if norm.startswith("projects/"):
        return os.path.join(base, *norm.split("/"))

    return s


# Project SELECT with derived floor_plans count, used by hot read paths so a
# single round-trip returns everything the API serializer needs.
_PROJECT_SELECT_WITH_COUNT = (
    "SELECT p.*, "
    "(SELECT COUNT(*) FROM floor_plans WHERE project_id=p.id) AS fp_count "
    "FROM projects p"
)


def _authorize_project(con, project_id: str, user: dict):
    """Fetch a project row and verify the caller has access (owner or tenant member).
    Raises 404 if not found / not authorized.
    """
    r = con.execute(f"{_PROJECT_SELECT_WITH_COUNT} WHERE p.id=?", (project_id,)).fetchone()
    if not r:
        raise HTTPException(404, "project not found")
    # Owner always has access
    if r["owner_id"] == user["id"]:
        return r
    # Tenant member access
    tid = r["tenant_id"] if "tenant_id" in r.keys() else None
    if tid and tid == user.get("active_tenant_id"):
        return r
    raise HTTPException(404, "project not found")


def _authorize_project_write(con, project_id: str, user: dict):
    """Like _authorize_project, but also checks the user has write permissions (admin/editor)."""
    r = _authorize_project(con, project_id, user)
    if user.get("tenant_role") == "viewer":
        raise HTTPException(403, "Viewers have read-only access")
    return r


@router.get("/projects", response_model=list[ProjectOut])
def list_projects(user=Depends(get_current_user)):
    tid = user.get("active_tenant_id")
    with db() as con:
        if tid:
            # Show all projects belonging to the active tenant
            rows = con.execute(
                f"{_PROJECT_SELECT_WITH_COUNT} WHERE p.tenant_id=? ORDER BY p.updated_at DESC, p.created_at DESC",
                (tid,),
            ).fetchall()
        else:
            # Legacy fallback: user's own projects
            rows = con.execute(
                f"{_PROJECT_SELECT_WITH_COUNT} WHERE p.owner_id=? ORDER BY p.updated_at DESC, p.created_at DESC",
                (user["id"],),
            ).fetchall()
    return [_project_row_to_out(r) for r in rows]

def _project_row_to_out(r) -> ProjectOut:
    files = {}
    def add(k, p):
        if not p:
            files[k] = None
            return
        p_norm = _normalize_data_path(p)
        try:
            files[k] = f"/files/{relpath(p_norm)}" if p_norm and _artifact_exists(p_norm) else None
        except Exception:
            # Never fail project fetch due to malformed persisted file path.
            files[k] = None

    preview_mapping_path = os.path.join(project_dir(r["id"]), "detectors_preview_mapping.json")
    detectors_debug_path = os.path.join(project_dir(r["id"]), "detectors_global_snapping_debug.png")
    detectors_overlay_debug_path = os.path.join(project_dir(r["id"]), "detectors_global_snapping_overlay.png")
    rooms_debug_path = os.path.join(project_dir(r["id"]), "rooms_debug.png")

    add("input", r["input_path"])
    add("dxf", r["dxf_path"])
    add("render_png", r["render_png_path"])
    add("mapping_json", r["mapping_json_path"])
    add("mask_png", r["mask_png_path"])
    add("aligned_mask", r["aligned_mask_path"])
    add("fixed_wall", r["fixed_wall_path"])
    add("rooms_json", r["rooms_json_path"])
    add("rooms_debug", rooms_debug_path if _artifact_exists(rooms_debug_path) else None)
    add("output_dxf", r["output_dxf_path"])
    # DWG sibling of the combined DXF, derived from disk presence (no DB column).
    _combined_dwg = None
    try:
        _odxf = r["output_dxf_path"]
        if _odxf:
            _cand = os.path.splitext(_odxf)[0] + ".dwg"
            if _artifact_exists(_cand):
                _combined_dwg = _cand
    except Exception:
        _combined_dwg = None
    add("output_dwg", _combined_dwg)
    add("output_preview_png", r["output_preview_png_path"])
    add("output_preview_mapping", preview_mapping_path if _artifact_exists(preview_mapping_path) else None)
    add("detectors_global_snap_debug", detectors_debug_path if _artifact_exists(detectors_debug_path) else None)
    add("detectors_global_snap_overlay", detectors_overlay_debug_path if _artifact_exists(detectors_overlay_debug_path) else None)

    sprinkler_pipes_path = os.path.join(project_dir(r["id"]), "sprinkler_pipes.json")
    add("sprinkler_pipes", sprinkler_pipes_path if _artifact_exists(sprinkler_pipes_path) else None)

    # Floor plan block count: prefer pre-joined value, fall back for callers
    # that select straight from `projects` without the derived column.
    if "fp_count" in r.keys():
        fp_count = int(r["fp_count"] or 0)
    else:
        with db() as con:
            fp_count = con.execute(
                "SELECT COUNT(*) FROM floor_plans WHERE project_id=?",
                (r["id"],),
            ).fetchone()[0]

    parsed_settings = json.loads(r["settings_json"] or "{}")
    return ProjectOut(
        id=r["id"],
        name=r["name"],
        status=r["status"],
        error=r["error"],
        files=files,
        nbc_evaluation=parsed_settings.get("nbc_evaluation"),
        nbc_answers=parsed_settings.get("nbc_answers"),
        settings=parsed_settings,
        input_filename=r["input_filename"],
        floor_plans_count=fp_count,
    )

# ── Pipeline defaults (single source of truth lives in
#    app.pipeline.place_detectors_advanced; exposed here so the UI can
#    render coverage circles, etc. without hardcoding the constant). ──

@router.get("/config/defaults")
def config_defaults():
    from app.pipeline.place_detectors_advanced import (
        DETECTOR_SPACING_M,
        WALL_BUFFER_M,
        WORLD_TO_M,
    )
    from app.pipeline.options import PipelineOptions
    opts = PipelineOptions.from_env()
    return {
        "detector_spacing_m": float(DETECTOR_SPACING_M),
        "heat_detector_spacing_m": float(opts.heat_detector_spacing_m),
        "wall_buffer_m": float(WALL_BUFFER_M),
        "world_to_m": float(WORLD_TO_M),
    }


# ── NBC rule engine endpoints ───────────────────────────────

@router.get("/nbc/questions")
def nbc_questions(occupancy_subtype: Optional[str] = None):
    return nbc_get_questions(occupancy_subtype)

@router.get("/nbc/occupancy_types")
def nbc_occupancy_types():
    return OCCUPANCY_DISPLAY_LABELS

@router.get("/nbc/followup_fields")
def nbc_followup_fields(occupancy_subtype: str):
    return FOLLOWUP_QUESTIONS.get(occupancy_subtype, [])

class NBCEvaluatePayload(BaseModel):
    answers: Dict[str, Any]

@router.post("/nbc/evaluate")
def nbc_evaluate(payload: NBCEvaluatePayload):
    return evaluate_building(payload.answers)

# ── Project CRUD ────────────────────────────────────────────

from typing import Optional, Any, Dict, List

class ProjectCreateWithNBC(BaseModel):
    name: str
    nbc_answers: Dict[str, Any]
    unit: Optional[str] = "mm"

@router.post("/projects", response_model=ProjectOut)
def create_project(payload: ProjectCreateWithNBC, user=Depends(get_current_user)):
    # Viewers cannot create projects
    if user.get("tenant_role") == "viewer":
        raise HTTPException(403, "Viewers cannot create projects")

    nbc_result = evaluate_building(payload.nbc_answers)
    settings = {
        "nbc_answers": payload.nbc_answers,
        "nbc_evaluation": nbc_result,
    }
    if payload.unit:
        settings["units"] = payload.unit

    pid = new_id()
    project_dir(pid)
    tid = user.get("active_tenant_id")
    with db() as con:
        con.execute(
            """INSERT INTO projects
                (id,owner_id,tenant_id,name,status,created_at,updated_at,settings_json)
                VALUES (?,?,?,?,?,?,?,?)""",
            (pid, user["id"], tid, payload.name, "created", now(), now(), json.dumps(settings)),
        )
        log_activity(con, user, "created_project", "project", pid, payload.name)
        r = con.execute("SELECT * FROM projects WHERE id=?", (pid,)).fetchone()
    return _project_row_to_out(r)

@router.get("/projects/{project_id}", response_model=ProjectOut)
def get_project(project_id: str, user=Depends(get_current_user)):
    with db() as con:
        r = _authorize_project(con, project_id, user)
    return _project_row_to_out(r)

@router.post("/projects/{project_id}/settings", response_model=ProjectOut)
def update_settings(project_id: str, payload: ProjectUpdateSettings, user=Depends(get_current_user)):
    with db() as con:
        r = _authorize_project_write(con, project_id, user)
        existing = json.loads(r["settings_json"] or "{}")
        merged = {**existing, **payload.settings}
        con.execute("UPDATE projects SET settings_json=?, updated_at=? WHERE id=?",
                    (json.dumps(merged), now(), project_id))
        r2 = _authorize_project(con, project_id, user)
    return _project_row_to_out(r2)

@router.post("/projects/{project_id}/upload", response_model=ProjectOut)
async def upload(project_id: str, file: UploadFile = File(...), user=Depends(get_current_user)):
    with db() as con:
        r = _authorize_project_write(con, project_id, user)

    filename = (file.filename or "upload").strip()
    ext = os.path.splitext(filename.lower())[1]
    if ext not in [".dxf", ".dwg"]:
        raise HTTPException(400, "Upload .dxf or .dwg")

    pdir = project_dir(project_id)
    in_path = os.path.join(pdir, f"input{ext}")

    data = await file.read()
    if len(data) < 100:
        raise HTTPException(400, "File too small")

    with open(in_path, "wb") as f:
        f.write(data)

    with db() as con:
        con.execute(
            "UPDATE projects SET status=?, error=NULL, input_filename=?, input_path=?, updated_at=? WHERE id=?",
            ("uploaded", filename, in_path, now(), project_id),
        )
        log_activity(con, user, "uploaded_file", "project", project_id, filename)
        r2 = _authorize_project(con, project_id, user)

    return _project_row_to_out(r2)

@router.post("/projects/{project_id}/run", response_model=ProjectOut)
def run_pipeline(project_id: str, bg: BackgroundTasks, user=Depends(get_current_user)):
    # Run in background thread (simple MVP). For production use a real queue.
    with db() as con:
        r = _authorize_project_write(con, project_id, user)
        if r["status"] in ("running",):
            raise HTTPException(409, "pipeline already running")
        con.execute("UPDATE projects SET status=?, error=NULL, updated_at=? WHERE id=?",
                    ("running", now(), project_id))
        log_activity(con, user, "ran_pipeline", "project", project_id, r["name"])

    # Load options from env + saved settings
    with db() as con:
        r = _authorize_project(con, project_id, user)
        settings = json.loads(r["settings_json"] or "{}")

    opts = PipelineOptions.from_env().merge_settings(settings)
    bg.add_task(run_pipeline_for_project, project_id, opts)
    bg.add_task(gcs.sync_project_to_gcs, project_id)

    with db() as con:
        r2 = _authorize_project(con, project_id, user)
    return _project_row_to_out(r2)

@router.post("/projects/{project_id}/aligned_mask", response_model=ProjectOut)
async def upload_aligned_mask(project_id: str, file: UploadFile = File(...), user=Depends(get_current_user)):
    with db() as con:
        r = _authorize_project_write(con, project_id, user)

    filename = (file.filename or "aligned_mask").strip().lower()
    ext = os.path.splitext(filename)[1]
    if ext not in [".png", ".jpg", ".jpeg", ".webp"]:
        raise HTTPException(400, "Upload aligned mask as .png/.jpg/.jpeg/.webp")

    data = await file.read()
    if len(data) < 100:
        raise HTTPException(400, "File too small")

    aligned_path = os.path.join(project_dir(project_id), "mask_aligned.png")
    with open(aligned_path, "wb") as f:
        f.write(data)

    with db() as con:
        con.execute(
            "UPDATE projects SET aligned_mask_path=?, status=?, error=NULL, updated_at=? WHERE id=?",
            (aligned_path, "awaiting_alignment_review", now(), project_id),
        )
        r2 = _authorize_project(con, project_id, user)

    return _project_row_to_out(r2)


@router.post("/projects/{project_id}/regenerate_mask", response_model=ProjectOut)
def regenerate_project_mask(project_id: str, payload: dict | None = None, user=Depends(get_current_user)):
    """Regenerate project mask via Gemini using optional instruction, then re-align it."""
    with db() as con:
        r = _authorize_project_write(con, project_id, user)

    render_path = r["render_png_path"]
    if not render_path or not os.path.exists(render_path):
        raise HTTPException(404, "project render image not available")

    settings = json.loads(r["settings_json"] or "{}")
    opts = PipelineOptions.from_env().merge_settings(settings)

    instruction = ((payload or {}).get("instruction") or "").strip()
    out_mask = r["mask_png_path"] or os.path.join(project_dir(project_id), "mask.png")
    out_aligned = r["aligned_mask_path"] or os.path.join(project_dir(project_id), "mask_aligned.png")
    retry_prompt = (
        f"{DEFAULT_PROMPT}\n\n"
        "You are given two images in this request: "
        "(1) the original floor plan image and "
        "(2) the current generated mask image. "
        "Improve the current mask using the original image as source of truth. "
        "Preserve geometry/relative positions and fix missed walls, doors, beams, and partitions."
    )
    if instruction:
        retry_prompt = f"{retry_prompt}\n\nAdditional user instruction:\n{instruction}"

    try:
        generate_mask_image(
            input_png=render_path,
            out_mask_png=out_mask,
            prompt=retry_prompt,
            model=opts.gemini_model,
            context_mask_png=out_mask if os.path.exists(out_mask) else None,
        )
        align_perfect_tight_box(render_path, out_mask, out_aligned)
    except RuntimeError as exc:
        raise HTTPException(400, str(exc)) from exc
    except (OSError, ValueError, TypeError) as exc:
        raise HTTPException(500, f"mask regeneration failed: {exc}") from exc

    with db() as con:
        con.execute(
            "UPDATE projects SET mask_png_path=?, aligned_mask_path=?, status=?, error=NULL, updated_at=? WHERE id=?",
            (out_mask, out_aligned, "awaiting_alignment_review", now(), project_id),
        )
        r2 = _authorize_project(con, project_id, user)
    return _project_row_to_out(r2)

@router.post("/projects/{project_id}/continue_floor_review", response_model=ProjectOut)
def continue_floor_review(project_id: str, bg: BackgroundTasks, user=Depends(get_current_user)):
    """Resume pipeline after user has reviewed / confirmed floor plan splits."""
    with db() as con:
        r = _authorize_project_write(con, project_id, user)
        if r["status"] in ("running",):
            raise HTTPException(409, "pipeline already running")
        if r["status"] not in ("awaiting_floor_review", "split"):
            raise HTTPException(409, "project is not awaiting floor plan review")

        con.execute("UPDATE projects SET status=?, error=NULL, updated_at=? WHERE id=?",
                    ("running", now(), project_id))

    with db() as con:
        r = _authorize_project(con, project_id, user)
        settings = json.loads(r["settings_json"] or "{}")

    opts = PipelineOptions.from_env().merge_settings(settings)
    bg.add_task(continue_pipeline_after_floor_review, project_id, opts)
    bg.add_task(gcs.sync_project_to_gcs, project_id)

    with db() as con:
        r2 = _authorize_project(con, project_id, user)
    return _project_row_to_out(r2)


@router.post("/projects/{project_id}/retry_mask_generation", response_model=ProjectOut)
def retry_mask_generation_endpoint(project_id: str, bg: BackgroundTasks, user=Depends(get_current_user)):
    """Resume pipeline by re-running ONLY the Gemini mask + auto-align step.

    Used when the previous mask generation failed (status == ``mask_failed``).
    Skips blocks that already have a valid mask file, so multi-block runs only
    retry what failed.
    """
    with db() as con:
        r = _authorize_project_write(con, project_id, user)
        if r["status"] == "running":
            raise HTTPException(409, "pipeline already running")
        if r["status"] != "mask_failed":
            raise HTTPException(409, "project is not in mask_failed state")

        con.execute(
            "UPDATE projects SET status=?, error=NULL, updated_at=? WHERE id=?",
            ("running", now(), project_id),
        )

    with db() as con:
        r = _authorize_project(con, project_id, user)
        settings = json.loads(r["settings_json"] or "{}")

    opts = PipelineOptions.from_env().merge_settings(settings)
    bg.add_task(retry_mask_generation, project_id, opts)
    bg.add_task(gcs.sync_project_to_gcs, project_id)

    with db() as con:
        r2 = _authorize_project(con, project_id, user)
    return _project_row_to_out(r2)


@router.post("/projects/{project_id}/floor_plans")
def add_floor_plan(project_id: str, payload: dict, user=Depends(get_current_user)):
    """Add a user-defined floor plan block.

    Accepts either:
    - Payload: {"pixel_bbox": [x0, y0, x1, y1]} - for pixel-based selection (legacy)
    - Payload: {"world_bbox": {"xmin": x0, "ymin": y0, "xmax": x1, "ymax": y1}} - for world coords (frontend)
    
    Block rendering is deferred until the user confirms the floor plan review.
    """
    from app.pipeline.floor_plan_split import _pixel_to_dxf
    import uuid as _uuid

    with db() as con:
        r = _authorize_project_write(con, project_id, user)

    # Support both world_bbox (from frontend) and pixel_bbox (legacy)
    world_bbox = payload.get("world_bbox")
    pixel_bbox = payload.get("pixel_bbox")
    
    if world_bbox:
        # Frontend is providing world coordinates directly
        wxmin = float(world_bbox.get("xmin", 0))
        wymin = float(world_bbox.get("ymin", 0))
        wxmax = float(world_bbox.get("xmax", 1))
        wymax = float(world_bbox.get("ymax", 1))
        if wxmax <= wxmin or wymax <= wymin:
            raise HTTPException(400, "invalid world bbox dimensions")
        pixel_bbox_data = None  # No pixel bbox for frontend submissions
    elif pixel_bbox:
        # Legacy pixel-based selection
        if not pixel_bbox or len(pixel_bbox) != 4:
            raise HTTPException(400, "pixel_bbox must be [x0, y0, x1, y1]")

        bx0, by0, bx1, by1 = [int(v) for v in pixel_bbox]
        if bx1 <= bx0 or by1 <= by0:
            raise HTTPException(400, "invalid bounding box dimensions")

        master_mapping_path = r["mapping_json_path"]
        if not master_mapping_path or not os.path.exists(master_mapping_path):
            raise HTTPException(400, "master mapping not available")

        with open(master_mapping_path, "r", encoding="utf-8") as f:
            master_map = json.load(f)

        # Convert pixel bbox to world coords
        dxf_tl_x, dxf_tl_y = _pixel_to_dxf(bx0, by0, master_map)
        dxf_br_x, dxf_br_y = _pixel_to_dxf(bx1, by1, master_map)
        wxmin = min(dxf_tl_x, dxf_br_x)
        wxmax = max(dxf_tl_x, dxf_br_x)
        wymin = min(dxf_tl_y, dxf_br_y)
        wymax = max(dxf_tl_y, dxf_br_y)
        pixel_bbox_data = [bx0, by0, bx1, by1]
    else:
        raise HTTPException(400, "Must provide either world_bbox or pixel_bbox")

    # Find next block index
    with db() as con:
        max_idx_row = con.execute(
            "SELECT MAX(block_index) FROM floor_plans WHERE project_id=?",
            (project_id,),
        ).fetchone()
    next_idx = (max_idx_row[0] + 1) if max_idx_row and max_idx_row[0] is not None else 0

    fp_id = str(_uuid.uuid4())
    with db() as con:
        con.execute(
            """INSERT INTO floor_plans
                (id, project_id, block_index, world_bbox_json, pixel_bbox_json,
                 render_png_path, mapping_json_path, status, created_at, updated_at)
                VALUES (?,?,?,?,?,?,?,?,?,?)""",
            (
                fp_id, project_id, next_idx,
                json.dumps({"xmin": wxmin, "ymin": wymin, "xmax": wxmax, "ymax": wymax}),
                json.dumps(pixel_bbox_data) if pixel_bbox_data else None,
                None, None,
                "created", now(), now(),
            ),
        )
        fp = con.execute("SELECT * FROM floor_plans WHERE id=?", (fp_id,)).fetchone()
    return _floor_plan_row_to_dict(fp)


@router.post("/projects/{project_id}/floor_plans/{fp_id}/render_image")
async def upload_floor_plan_render_image(
    project_id: str,
    fp_id: str,
    file: UploadFile = File(...),
    user=Depends(get_current_user),
):
    """Upload the frontend-generated floor-plan image used for mask generation."""
    with db() as con:
        _authorize_project_write(con, project_id, user)
        fp = con.execute("SELECT * FROM floor_plans WHERE id=? AND project_id=?", (fp_id, project_id)).fetchone()
        if not fp:
            raise HTTPException(404, "floor plan block not found")

    filename = (file.filename or "floor_plan.png").strip().lower()
    ext = os.path.splitext(filename)[1]
    if ext not in (".png", ".jpg", ".jpeg", ".webp"):
        raise HTTPException(400, "Upload floor plan image as .png/.jpg/.jpeg/.webp")

    data = await file.read()
    if len(data) < 100:
        raise HTTPException(400, "File too small")

    idx = fp["block_index"]
    blocks_dir = os.path.join(project_dir(project_id), "blocks")
    os.makedirs(blocks_dir, exist_ok=True)
    render_path = os.path.join(blocks_dir, f"block_{idx}.png")
    with open(render_path, "wb") as f:
        f.write(data)

    with db() as con:
        con.execute(
            "UPDATE floor_plans SET render_png_path=?, status=?, updated_at=? WHERE id=?",
            (render_path, "rendered", now(), fp_id),
        )
        fp2 = con.execute("SELECT * FROM floor_plans WHERE id=?", (fp_id,)).fetchone()
    return _floor_plan_row_to_dict(fp2)


@router.delete("/projects/{project_id}/floor_plans/{fp_id}")
def delete_floor_plan(project_id: str, fp_id: str, user=Depends(get_current_user)):
    """Delete a floor plan block."""
    with db() as con:
        r = _authorize_project_write(con, project_id, user)
        fp = con.execute("SELECT * FROM floor_plans WHERE id=? AND project_id=?", (fp_id, project_id)).fetchone()
        if not fp:
            raise HTTPException(404, "floor plan block not found")
        idx = int(fp["block_index"])
        con.execute("DELETE FROM floor_plans WHERE id=?", (fp_id,))
        con.execute("DELETE FROM detectors WHERE project_id=? AND floor_plan_id=?", (project_id, fp_id))

    # Best-effort cleanup for artifacts belonging to the removed block.
    blocks_dir = os.path.join(project_dir(project_id), "blocks")
    stale_files = [
        os.path.join(blocks_dir, f"block_{idx}.png"),
        os.path.join(blocks_dir, f"block_{idx}_mask.png"),
        os.path.join(blocks_dir, f"block_{idx}_aligned.png"),
        os.path.join(blocks_dir, f"block_{idx}_align_overlay.jpg"),
        os.path.join(blocks_dir, f"block_{idx}_align_boxes.jpg"),
        os.path.join(blocks_dir, f"block_{idx}_color.png"),
        os.path.join(blocks_dir, f"block_{idx}_mapping.json"),
        os.path.join(blocks_dir, f"block_{idx}_fixed_wall.png"),
        os.path.join(blocks_dir, f"block_{idx}_rooms.json"),
        os.path.join(blocks_dir, f"block_{idx}_rooms_debug.png"),
        os.path.join(project_dir(project_id), f"sprinkler_pipes_{idx}.json"),
    ]
    for p in stale_files:
        try:
            if os.path.isfile(p):
                os.remove(p)
        except OSError:
            # Do not fail deletion because optional artifacts could not be removed.
            pass
    return {"ok": True}


@router.post("/projects/{project_id}/continue", response_model=ProjectOut)
def continue_pipeline(project_id: str, bg: BackgroundTasks, user=Depends(get_current_user)):
    with db() as con:
        r = _authorize_project_write(con, project_id, user)
        if r["status"] in ("running",):
            raise HTTPException(409, "pipeline already running")
        if r["status"] not in ("awaiting_alignment_review", "aligned"):
            raise HTTPException(409, "project is not awaiting alignment review")

        con.execute("UPDATE projects SET status=?, error=NULL, updated_at=? WHERE id=?",
                    ("running", now(), project_id))

    with db() as con:
        r = _authorize_project(con, project_id, user)
        settings = json.loads(r["settings_json"] or "{}")

    opts = PipelineOptions.from_env().merge_settings(settings)
    bg.add_task(continue_pipeline_after_alignment, project_id, opts)
    bg.add_task(gcs.sync_project_to_gcs, project_id)

    with db() as con:
        r2 = _authorize_project(con, project_id, user)
    return _project_row_to_out(r2)

# ── Rooms review endpoints ──────────────────────────────────

@router.get("/projects/{project_id}/rooms")
def get_rooms(project_id: str, user=Depends(get_current_user)):
    """Return the extracted rooms JSON for the project."""
    with db() as con:
        r = _authorize_project(con, project_id, user)
    rooms_path = r["rooms_json_path"]
    if not rooms_path or not os.path.exists(rooms_path):
        raise HTTPException(404, "rooms not yet extracted")
    with open(rooms_path, "r", encoding="utf-8") as f:
        return json.load(f)


@router.put("/projects/{project_id}/rooms")
def update_rooms(project_id: str, payload: dict, user=Depends(get_current_user)):
    """Overwrite rooms JSON (user edits: rename, split, delete, re-draw)."""
    with db() as con:
        r = _authorize_project_write(con, project_id, user)
    rooms_path = r["rooms_json_path"]
    if not rooms_path:
        rooms_path = os.path.join(project_dir(project_id), "rooms_from_image.json")
    if os.path.exists(rooms_path):
        try:
            with open(rooms_path, "r", encoding="utf-8") as f:
                existing = json.load(f)
            if isinstance(existing, dict) and isinstance(payload, dict):
                if "doors" in existing and "doors" not in payload:
                    payload["doors"] = existing["doors"]
                if "staircases" in existing and "staircases" not in payload:
                    payload["staircases"] = existing["staircases"]
                if "shapes" in existing and "shapes" not in payload:
                    payload["shapes"] = existing["shapes"]
        except Exception:
            pass
    with open(rooms_path, "w", encoding="utf-8") as f:
        json.dump(payload, f, indent=2)
    return payload


@router.post("/projects/{project_id}/auto_place")
def auto_place_detectors(project_id: str, payload: dict = None, user=Depends(get_current_user)):
    """Run NBC-based auto-placement of detectors using current rooms, without changing project status.
    
    Optional payload: {"equipment_type": "smoke" | "sprinkler" | "fire_hose" | ...}
    If equipment_type given, only add those detectors (appending to existing).
    If not given, replace all with smoke detectors.
    """
    from app.pipeline.place_detectors_advanced import place_detectors_from_rooms_json
    from app.pipeline.mcp_hooter_placement import place_mcp_hooter_from_rooms_payload
    from app.pipeline.sprinkler_routing import place_sprinklers_only
    import uuid as _uuid

    equipment_type = (payload or {}).get("equipment_type", "smoke") if payload else "smoke"
    # Validate
    ALLOWED_TYPES = {"smoke", "sprinkler", "fire_hose", "panel", "hooter", "mcb", "mcp_hooter"}
    if equipment_type not in ALLOWED_TYPES:
        equipment_type = "smoke"

    with db() as con:
        r = _authorize_project_write(con, project_id, user)

    rooms_path = r["rooms_json_path"]
    if not rooms_path or not os.path.exists(rooms_path):
        raise HTTPException(404, "rooms not yet extracted")

    mapping_path = r["mapping_json_path"]
    if not mapping_path or not os.path.exists(mapping_path):
        raise HTTPException(404, "mapping not available")

    render_png = os.path.join(project_dir(project_id), "render.png")

    with open(rooms_path, "r", encoding="utf-8") as f:
        rooms_data = json.load(f)
    rooms = rooms_data.get("rooms", rooms_data) if isinstance(rooms_data, dict) else rooms_data

    settings = json.loads(r["settings_json"] or "{}")
    opts = PipelineOptions.from_env().merge_settings(settings)

    if equipment_type == "sprinkler":
        # Place sprinklers only (no pipe routing)
        sp_points = place_sprinklers_only(
            rooms,
            spacing_m=opts.sprinkler_spacing_m,
            wall_buffer_m=opts.wall_buffer_m,
            world_to_m=opts.world_to_m,
        )
        new_dets = [
            {"id": str(_uuid.uuid4())[:8], "x": x, "y": y, "z": 0.0, "dtype": "sprinkler", "locked": 0}
            for x, y in sp_points
        ]
    elif equipment_type == "mcp_hooter":
        rooms_payload = rooms_data if isinstance(rooms_data, dict) else {"rooms": rooms}
        stations = place_mcp_hooter_from_rooms_payload(
            rooms_payload,
            world_to_m=opts.world_to_m,
            gemini_model=opts.gemini_model,
        )
        # Place a centered left/right pair around each station.
        offset = MCP_HOOTER_PAIR_OFFSET_M / max(float(opts.world_to_m), 1e-9)
        new_dets = []
        for x, y in stations:
            half = offset * 0.5
            new_dets.append({"id": str(_uuid.uuid4())[:8], "x": x - half, "y": y, "z": 0.0, "dtype": "mcb", "locked": 0})
            new_dets.append({"id": str(_uuid.uuid4())[:8], "x": x + half, "y": y, "z": 0.0, "dtype": "hooter", "locked": 0})
    else:
        placed, _regions = place_detectors_from_rooms_json(
            rooms,
            opts.detector_spacing_m,
            opts.wall_buffer_m,
            opts.world_to_m,
            mapping_json_path=mapping_path,
            base_png_path=render_png,
        )
        new_dets = [
            {"id": str(_uuid.uuid4())[:8], "x": x, "y": y, "z": 0.0, "dtype": equipment_type, "locked": 0}
            for (x, y) in placed
        ]

    with db() as con:
        # Delete only detectors of this type, keep others.
        if equipment_type == "mcp_hooter":
            con.execute("DELETE FROM detectors WHERE project_id=? AND dtype IN ('mcb','hooter')", (project_id,))
        else:
            con.execute("DELETE FROM detectors WHERE project_id=? AND dtype=?", (project_id, equipment_type))
        for d in new_dets:
            con.execute(
                 """INSERT INTO detectors (id,project_id,x,y,z,rotation_deg,dtype,locked,created_at,updated_at)
                     VALUES (?,?,?,?,?,?,?,?,?,?)""",
                (d["id"], project_id, float(d["x"]), float(d["y"]), float(d.get("z", 0.0)),
                  float(d.get("rotation_deg", 0.0)), d.get("dtype", "smoke"), int(d.get("locked", 0)), now(), now()),
            )

    # Return placed detectors
    with db() as con:
        rows = con.execute(
            "SELECT id, project_id, x, y, z, rotation_deg, dtype, locked FROM detectors WHERE project_id=? ORDER BY created_at ASC",
            (project_id,),
        ).fetchall()
    return [dict(r) for r in rows]


@router.post("/projects/{project_id}/continue_rooms", response_model=ProjectOut)
def continue_after_rooms(project_id: str, bg: BackgroundTasks, user=Depends(get_current_user)):
    """Resume pipeline after user has reviewed / edited rooms."""
    with db() as con:
        r = _authorize_project_write(con, project_id, user)
        if r["status"] in ("running",):
            raise HTTPException(409, "pipeline already running")
        if r["status"] not in ("awaiting_room_review", "rooms_extracted"):
            raise HTTPException(409, "project is not awaiting room review")

        con.execute("UPDATE projects SET status=?, error=NULL, updated_at=? WHERE id=?",
                    ("running", now(), project_id))

    with db() as con:
        r = _authorize_project(con, project_id, user)
        settings = json.loads(r["settings_json"] or "{}")

    opts = PipelineOptions.from_env().merge_settings(settings)
    bg.add_task(continue_pipeline_after_rooms, project_id, opts)
    bg.add_task(gcs.sync_project_to_gcs, project_id)

    with db() as con:
        r2 = _authorize_project(con, project_id, user)
    return _project_row_to_out(r2)

# ─────────────────────────────────────────────────────────────

@router.post("/projects/{project_id}/reset_detectors", response_model=ProjectOut)
def reset_detectors(project_id: str, user=Depends(get_current_user)):
    with db() as con:
        r = _authorize_project_write(con, project_id, user)
        con.execute("DELETE FROM detectors WHERE project_id=?", (project_id,))
        con.execute("UPDATE projects SET updated_at=? WHERE id=?", (now(), project_id))
        r2 = _authorize_project(con, project_id, user)
    return _project_row_to_out(r2)


@router.put("/projects/{project_id}/bulk_save")
def bulk_save(project_id: str, payload: dict, user=Depends(get_current_user)):
    """Save rooms, detectors, and pipes in a single call."""
    with db() as con:
        r = _authorize_project_write(con, project_id, user)

        pdir = project_dir(project_id)
        floor_plan_id = payload.get("floor_plan_id")

        # ── 1. Save rooms / annotations ────────────────────────────────
        rooms = payload.get("rooms")
        shapes = payload.get("shapes")
        if rooms is not None:
            if floor_plan_id:
                fp = con.execute("SELECT * FROM floor_plans WHERE id=? AND project_id=?", (floor_plan_id, project_id)).fetchone()
                if not fp:
                    raise HTTPException(404, "floor plan not found")
                rooms_path = fp["rooms_json_path"]
            else:
                rooms_path = r["rooms_json_path"]
            if rooms_path and os.path.exists(rooms_path):
                with open(rooms_path, "r", encoding="utf-8") as f:
                    rooms_data = json.load(f)
                if isinstance(rooms_data, dict):
                    rooms_data["rooms"] = rooms
                else:
                    rooms_data = {"rooms": rooms}
                with open(rooms_path, "w", encoding="utf-8") as f:
                    json.dump(rooms_data, f, indent=2)

        # Save shapes/text annotations in rooms JSON alongside rooms.
        if shapes is not None:
            if floor_plan_id:
                fp = con.execute("SELECT * FROM floor_plans WHERE id=? AND project_id=?", (floor_plan_id, project_id)).fetchone()
                if not fp:
                    raise HTTPException(404, "floor plan not found")
                rooms_path = fp["rooms_json_path"]
            else:
                rooms_path = r["rooms_json_path"]
            if rooms_path:
                base: dict = {}
                if os.path.exists(rooms_path):
                    try:
                        with open(rooms_path, "r", encoding="utf-8") as f:
                            existing = json.load(f)
                        if isinstance(existing, dict):
                            base = existing
                        elif isinstance(existing, list):
                            base = {"rooms": existing}
                    except Exception:
                        base = {}
                base["shapes"] = shapes
                with open(rooms_path, "w", encoding="utf-8") as f:
                    json.dump(base, f, indent=2)

        # ── 2. Sync detectors ──────────────────────────────────────────
        det_list = payload.get("detectors")
        if det_list is not None:
            # Delete existing detectors for this scope
            if floor_plan_id:
                con.execute("DELETE FROM detectors WHERE project_id=? AND floor_plan_id=?", (project_id, floor_plan_id))
            else:
                con.execute("DELETE FROM detectors WHERE project_id=?", (project_id,))
            # Re-insert all
            t = now()
            for d in det_list:
                con.execute(
                    """INSERT INTO detectors (id,project_id,x,y,z,rotation_deg,dtype,locked,floor_plan_id,created_at,updated_at)
                        VALUES (?,?,?,?,?,?,?,?,?,?,?)""",
                    (d.get("id", str(__import__('uuid').uuid4())), project_id,
                     float(d["x"]), float(d["y"]), float(d.get("z", 0)),
                     float(d.get("rotation_deg", 0.0)), d.get("dtype", "smoke"), int(d.get("locked", False)),
                     d.get("floor_plan_id") or floor_plan_id, t, t),
                )

        # ── 3. Save pipes ──────────────────────────────────────────────
        pipes = payload.get("pipes")
        if pipes is not None:
            if floor_plan_id:
                fp = con.execute("SELECT * FROM floor_plans WHERE id=? AND project_id=?", (floor_plan_id, project_id)).fetchone()
                pipes_path = os.path.join(pdir, f"sprinkler_pipes_{fp['block_index']}.json") if fp else None
            else:
                pipes_path = os.path.join(pdir, "sprinkler_pipes.json")
            if pipes_path:
                with open(pipes_path, "w", encoding="utf-8") as f:
                    json.dump(pipes, f, indent=2)

        con.execute("UPDATE projects SET updated_at=? WHERE id=?", (now(), project_id))

    # Return updated detectors
    with db() as con:
        if floor_plan_id:
            rows = con.execute(
                "SELECT * FROM detectors WHERE project_id=? AND floor_plan_id=? ORDER BY created_at ASC",
                (project_id, floor_plan_id),
            ).fetchall()
        else:
            rows = con.execute(
                "SELECT * FROM detectors WHERE project_id=? ORDER BY created_at ASC",
                (project_id,),
            ).fetchall()

    return {
        "ok": True,
        "detectors": [
            {"id": row["id"], "project_id": row["project_id"],
             "x": float(row["x"]), "y": float(row["y"]), "z": float(row["z"]),
             "rotation_deg": float(row["rotation_deg"]) if "rotation_deg" in row.keys() and row["rotation_deg"] is not None else 0.0,
             "dtype": row["dtype"], "locked": bool(row["locked"]),
             "floor_plan_id": row["floor_plan_id"]}
            for row in rows
        ],
    }


@router.post("/projects/{project_id}/save", response_model=ProjectOut)
def save_project_layout(project_id: str, user=Depends(get_current_user)):
    with db() as con:
        r = _authorize_project_write(con, project_id, user)

        dxf_path = r["dxf_path"]
        if not dxf_path or not os.path.exists(dxf_path):
            raise HTTPException(400, "base DXF not available")

        det_rows = con.execute(
            "SELECT id, x, y, z, rotation_deg, dtype, locked FROM detectors WHERE project_id=? ORDER BY created_at ASC",
            (project_id,),
        ).fetchall()

        dets = [
            {
                "id": row["id"],
                "x": float(row["x"]),
                "y": float(row["y"]),
                "z": float(row["z"]),
                "rotation_deg": float(row["rotation_deg"]) if "rotation_deg" in row.keys() and row["rotation_deg"] is not None else 0.0,
                "dtype": row["dtype"],
                "locked": bool(row["locked"]),
            }
            for row in det_rows
        ]

        settings = json.loads(r["settings_json"] or "{}")
        opts = PipelineOptions.from_env().merge_settings(settings)

        def _mapping_scale(mapping_path: str | None) -> float | None:
            if not mapping_path or not os.path.exists(mapping_path):
                return None
            try:
                with open(mapping_path, "r", encoding="utf-8") as mf:
                    m = json.load(mf)
            except Exception:
                return None
            fit = m.get("pixel_fit") or {}
            s = fit.get("scale")
            if isinstance(s, (int, float)) and float(s) > 0:
                return float(s)
            wb = m.get("world_bbox") or {}
            xmin = float(wb.get("xmin", 0.0))
            xmax = float(wb.get("xmax", 0.0))
            ymin = float(wb.get("ymin", 0.0))
            ymax = float(wb.get("ymax", 0.0))
            wpx = float(m.get("width_px", 0.0) or 0.0)
            hpx = float(m.get("height_px", 0.0) or 0.0)
            span_x = max(1e-9, xmax - xmin)
            span_y = max(1e-9, ymax - ymin)
            if wpx <= 0 or hpx <= 0:
                return None
            return min(wpx / span_x, hpx / span_y)

        project_scale = _mapping_scale(r["mapping_json_path"]) if "mapping_json_path" in r.keys() else None

        def _pixel_to_world(mapping: dict, px: float, py: float) -> tuple[float, float]:
            wb = mapping.get("world_bbox") or {}
            xmin = float(wb.get("xmin", 0.0))
            xmax = float(wb.get("xmax", 1.0))
            ymin = float(wb.get("ymin", 0.0))
            ymax = float(wb.get("ymax", 1.0))
            fit = mapping.get("pixel_fit") or {}
            scale = fit.get("scale")
            if isinstance(scale, (int, float)) and float(scale) > 0:
                sx = float(scale)
                ox = float(fit.get("offset_x", 0.0))
                oy = float(fit.get("offset_y", 0.0))
                xw = xmin + (float(px) - ox) / sx
                yw = ymax - (float(py) - oy) / sx
                return xw, yw
            # Legacy mappings may omit pixel_fit; derive contain-fit transform
            # to match renderer behavior and avoid subtle coordinate drift.
            wpx = float(mapping.get("width_px", 1.0) or 1.0)
            hpx = float(mapping.get("height_px", 1.0) or 1.0)
            span_x = max(1e-9, xmax - xmin)
            span_y = max(1e-9, ymax - ymin)
            sx = min(wpx / span_x, hpx / span_y)
            draw_w = span_x * sx
            draw_h = span_y * sx
            ox = (wpx - draw_w) * 0.5
            oy = (hpx - draw_h) * 0.5
            xw = xmin + (float(px) - ox) / sx
            yw = ymax - (float(py) - oy) / sx
            return xw, yw

        def _collect_annotations_from_rooms(rooms_path: str | None, mapping_path: str | None) -> list[dict]:
            if not rooms_path or not mapping_path:
                return []
            if not os.path.exists(rooms_path) or not os.path.exists(mapping_path):
                return []
            try:
                with open(rooms_path, "r", encoding="utf-8") as rf:
                    rooms_data = json.load(rf)
                with open(mapping_path, "r", encoding="utf-8") as mf:
                    mapping_data = json.load(mf)
            except Exception:
                return []

            if not isinstance(rooms_data, dict):
                return []
            raw_shapes = rooms_data.get("shapes")
            if not isinstance(raw_shapes, list):
                return []

            anns: list[dict] = []
            for s in raw_shapes:
                if not isinstance(s, dict):
                    continue
                kind = str(s.get("kind", "rect")).lower()
                x = float(s.get("x", 0.0))
                y = float(s.get("y", 0.0))
                w = float(s.get("w", 0.0))
                h = float(s.get("h", 0.0))
                if w <= 0 or h <= 0:
                    continue
                wx1, wy1 = _pixel_to_world(mapping_data, x, y)
                wx2, wy2 = _pixel_to_world(mapping_data, x + w, y + h)
                ann = {
                    "kind": kind,
                    "xmin": min(wx1, wx2),
                    "ymin": min(wy1, wy2),
                    "xmax": max(wx1, wx2),
                    "ymax": max(wy1, wy2),
                }
                if kind == "text":
                    ann["text"] = str(s.get("text") or "Text")
                    fs = float(s.get("fontSize", 16.0))
                    tx, ty = _pixel_to_world(mapping_data, x + 2.0, y + fs)
                    _, wy_fs = _pixel_to_world(mapping_data, x, y + fs)
                    _, wy_base = _pixel_to_world(mapping_data, x, y)
                    ann["text_x"] = tx
                    ann["text_y"] = ty
                    ann["text_height"] = max(1e-6, abs(wy_fs - wy_base))
                anns.append(ann)
            return anns

        fp_rows = con.execute(
            "SELECT block_index, mapping_json_path, rooms_json_path FROM floor_plans WHERE project_id=? ORDER BY block_index ASC",
            (project_id,),
        ).fetchall()

        # Build world_bbox from floor-plan blocks or mapping.json
        world_bbox = None
        fp_bbox_rows = con.execute(
            "SELECT world_bbox_json FROM floor_plans WHERE project_id=? ORDER BY block_index ASC",
            (project_id,),
        ).fetchall()
        if fp_bbox_rows:
            xs_min, ys_min, xs_max, ys_max = [], [], [], []
            for row in fp_bbox_rows:
                wb = json.loads(row["world_bbox_json"]) if row["world_bbox_json"] else None
                if wb:
                    xs_min.append(float(wb["xmin"])); ys_min.append(float(wb["ymin"]))
                    xs_max.append(float(wb["xmax"])); ys_max.append(float(wb["ymax"]))
            if xs_min:
                world_bbox = {"xmin": min(xs_min), "ymin": min(ys_min),
                              "xmax": max(xs_max), "ymax": max(ys_max)}
        if world_bbox is None:
            mapping_path = r["mapping_json_path"]
            if mapping_path and os.path.exists(mapping_path):
                with open(mapping_path, "r", encoding="utf-8") as mf:
                    world_bbox = json.load(mf).get("world_bbox")

        # Global export nudge (applied to all exported entities in world units).
        # Preferred settings are drawing-relative fractions:
        #   export_nudge_frac_x, export_nudge_frac_y
        # where value 0.001 means 0.1% of drawing span along that axis.
        dx_world = 0.0
        dy_world = 0.0
        if world_bbox:
            span_x = max(1e-9, float(world_bbox["xmax"]) - float(world_bbox["xmin"]))
            span_y = max(1e-9, float(world_bbox["ymax"]) - float(world_bbox["ymin"]))
            frac_x = float(settings.get("export_nudge_frac_x", 0.0) or 0.0)
            frac_y = float(settings.get("export_nudge_frac_y", 0.0) or 0.0)
            if abs(frac_x) > 1e-12 or abs(frac_y) > 1e-12:
                dx_world = frac_x * span_x
                dy_world = frac_y * span_y
            else:
                # Backward compatibility: pixel-based nudges converted via mapping scale.
                # Y in pixels is screen-space (down positive), so invert for world-space Y.
                px_x = float(settings.get("export_nudge_px_x", settings.get("pipe_export_nudge_px_x", 0.0)) or 0.0)
                px_y = float(settings.get("export_nudge_px_y", settings.get("pipe_export_nudge_px_y", 0.0)) or 0.0)
                if abs(px_x) > 1e-9 or abs(px_y) > 1e-9:
                    scale_for_nudge = project_scale
                    if (not scale_for_nudge or scale_for_nudge <= 0) and fp_rows:
                        scale_for_nudge = _mapping_scale(fp_rows[0]["mapping_json_path"]) if "mapping_json_path" in fp_rows[0].keys() else None
                    if scale_for_nudge and scale_for_nudge > 0:
                        dx_world = px_x / float(scale_for_nudge)
                        dy_world = -px_y / float(scale_for_nudge)

        def _shift_xy(x: float, y: float) -> tuple[float, float]:
            return float(x) + dx_world, float(y) + dy_world

        dets_export = [
            {
                **d,
                "x": _shift_xy(float(d["x"]), float(d["y"]))[0],
                "y": _shift_xy(float(d["x"]), float(d["y"]))[1],
            }
            for d in dets
        ]

        all_annotations = _collect_annotations_from_rooms(r["rooms_json_path"], r["mapping_json_path"])

        for fp_row in fp_rows:
            all_annotations.extend(
                _collect_annotations_from_rooms(fp_row["rooms_json_path"], fp_row["mapping_json_path"])
            )

        anns_export = []
        for a in all_annotations:
            try:
                na = dict(a)
                na["xmin"] = float(na["xmin"]) + dx_world
                na["xmax"] = float(na["xmax"]) + dx_world
                na["ymin"] = float(na["ymin"]) + dy_world
                na["ymax"] = float(na["ymax"]) + dy_world
                if "text_x" in na:
                    na["text_x"] = float(na["text_x"]) + dx_world
                if "text_y" in na:
                    na["text_y"] = float(na["text_y"]) + dy_world
                anns_export.append(na)
            except Exception:
                anns_export.append(a)

        out_dxf = os.path.join(project_dir(project_id), "detectors_overlay.dxf")
        write_detectors_to_dxf(dxf_path, out_dxf, dets_export,
                               annotations=anns_export,
                               world_to_m=opts.world_to_m, world_bbox=world_bbox)

        # Write sprinkler pipes into the DXF if they exist.
        # Important: do not mix project-level and per-floor-plan pipe files,
        # otherwise stale/global segments can appear offset in exports.
        from app.pipeline.sprinkler_routing import write_sprinklers_to_dxf
        all_pipe_segments = []
        all_pipe_sources = []

        # Deduplicate by normalized coordinates + diameter to avoid
        # overlapping duplicate labels when both aggregate and per-block files exist.
        seg_seen = set()
        src_seen = set()

        def _norm_pt(pt):
            return (round(float(pt[0]), 4), round(float(pt[1]), 4))

        def _add_segment(p_from, p_to, diameter):
            p_from = _shift_xy(float(p_from[0]), float(p_from[1]))
            p_to = _shift_xy(float(p_to[0]), float(p_to[1]))
            a = _norm_pt(p_from)
            b = _norm_pt(p_to)
            key_endpoints = tuple(sorted([a, b]))
            key = (key_endpoints[0], key_endpoints[1], str(diameter))
            if key in seg_seen:
                return
            seg_seen.add(key)
            all_pipe_segments.append(((a, b), str(diameter)))

        def _add_source(src):
            sx, sy = _shift_xy(float(src[0]), float(src[1]))
            s = _norm_pt((sx, sy))
            if s in src_seen:
                return
            src_seen.add(s)
            all_pipe_sources.append(s)

        if fp_rows:
            # Per-floor-plan pipes are authoritative once floor blocks exist.
            for fp_row in fp_rows:
                fp_pipes_path = os.path.join(project_dir(project_id), f"sprinkler_pipes_{fp_row['block_index']}.json")
                if os.path.exists(fp_pipes_path):
                    with open(fp_pipes_path, "r", encoding="utf-8") as pf:
                        fp_pipes = json.load(pf)
                    for p in fp_pipes.get("pipes", []):
                        _add_segment(p["from"], p["to"], p.get("diameter", "32mm"))
                    for s in fp_pipes.get("sources", []):
                        _add_source((s["x"], s["y"]))
        else:
            # Single-plan mode: use project-level pipes.
            pipes_json_path = os.path.join(project_dir(project_id), "sprinkler_pipes.json")
            if os.path.exists(pipes_json_path):
                with open(pipes_json_path, "r", encoding="utf-8") as pf:
                    pipes_data = json.load(pf)
                for p in pipes_data.get("pipes", []):
                    _add_segment(p["from"], p["to"], p.get("diameter", "32mm"))
                for s in pipes_data.get("sources", []):
                    _add_source((s["x"], s["y"]))

        sprinkler_dets = [(float(d["x"]), float(d["y"])) for d in dets_export if d["dtype"] == "sprinkler"]
        if sprinkler_dets or all_pipe_segments:
            write_sprinklers_to_dxf(
                out_dxf, out_dxf,
                sprinkler_dets, all_pipe_segments, all_pipe_sources,
                world_to_m=opts.world_to_m, world_bbox=world_bbox,
            )

        # Combined multi-sheet DXF (separate tabs for fire alarm vs sprinkler)
        out_combined = os.path.join(project_dir(project_id), "detectors_combined_sheets.dxf")
        write_combined_sheets_dxf(
            base_dxf=dxf_path,
            out_combined_dxf=out_combined,
            detectors=dets_export,
            annotations=anns_export,
            sprinkler_pipes=all_pipe_segments,
            sprinkler_sources=list(all_pipe_sources),
            world_to_m=opts.world_to_m,
            world_bbox=world_bbox,
        )

        # Also produce a DWG sibling of the combined DXF for users who need DWG.
        # Failure here is non-fatal: the DXF is still saved.
        try:
            from app.pipeline.oda_convert import dxf_to_dwg
            out_combined_dwg = os.path.splitext(out_combined)[0] + ".dwg"
            dxf_to_dwg(out_combined, out_combined_dwg)
        except Exception as _dwg_err:
            import logging as _lg
            _lg.getLogger("mepit.api").warning(
                "DWG export skipped: %s", _dwg_err,
            )

        # No PNG preview rendering needed - frontend handles DXF visualization
        con.execute(
            "UPDATE projects SET output_dxf_path=?, error=NULL, updated_at=? WHERE id=?",
            (out_combined, now(), project_id),
        )
        log_activity(con, user, "saved_project", "project", project_id, r["name"])
        r2 = _authorize_project(con, project_id, user)

    return _project_row_to_out(r2)


# ── Floor plan (block) management endpoints ─────────────────

@router.get("/projects/{project_id}/floor_plans")
def list_floor_plans(project_id: str, user=Depends(get_current_user)):
    """Return all floor-plan blocks extracted from the project's DXF."""
    with db() as con:
        r = _authorize_project(con, project_id, user)
        rows = con.execute(
            "SELECT * FROM floor_plans WHERE project_id=? ORDER BY block_index ASC",
            (project_id,),
        ).fetchall()
    return [_floor_plan_row_to_dict(fp) for fp in rows]


def _floor_plan_row_to_dict(fp) -> dict:
    d: dict = {
        "id": fp["id"],
        "project_id": fp["project_id"],
        "block_index": fp["block_index"],
        "status": fp["status"],
        "height_m": float(fp["height_m"]) if fp["height_m"] is not None else None,
        "world_bbox": json.loads(fp["world_bbox_json"]) if fp["world_bbox_json"] else None,
        "pixel_bbox": json.loads(fp["pixel_bbox_json"]) if fp["pixel_bbox_json"] else None,
        "files": {},
    }
    def add(k, p):
        d["files"][k] = f"/files/{relpath(p)}" if p and _artifact_exists(p) else None
    add("render_png", fp["render_png_path"])
    add("mapping_json", fp["mapping_json_path"])
    add("mask_png", fp["mask_png_path"])
    add("aligned_mask", fp["aligned_mask_path"])
    add("fixed_wall", fp["fixed_wall_path"])
    add("rooms_json", fp["rooms_json_path"])
    # Per-floor-plan sprinkler pipes
    idx = fp["block_index"]
    pid = fp["project_id"]
    pipes_path = os.path.join(project_dir(pid), f"sprinkler_pipes_{idx}.json")
    add("sprinkler_pipes", pipes_path if _artifact_exists(pipes_path) else None)
    return d


@router.post("/projects/{project_id}/floor_plans/{fp_id}/aligned_mask")
async def upload_floor_plan_aligned_mask(
    project_id: str, fp_id: str,
    file: UploadFile = File(...),
    user=Depends(get_current_user),
):
    """Upload / replace the aligned mask for a specific floor-plan block."""
    with db() as con:
        r = _authorize_project_write(con, project_id, user)
        fp = con.execute("SELECT * FROM floor_plans WHERE id=? AND project_id=?", (fp_id, project_id)).fetchone()
        if not fp:
            raise HTTPException(404, "floor plan block not found")

    filename = (file.filename or "aligned_mask").strip().lower()
    ext = os.path.splitext(filename)[1]
    if ext not in (".png", ".jpg", ".jpeg", ".webp"):
        raise HTTPException(400, "Upload aligned mask as .png/.jpg/.jpeg/.webp")

    data = await file.read()
    if len(data) < 100:
        raise HTTPException(400, "File too small")

    idx = fp["block_index"]
    blocks_dir = os.path.join(project_dir(project_id), "blocks")
    os.makedirs(blocks_dir, exist_ok=True)
    aligned_path = os.path.join(blocks_dir, f"block_{idx}_aligned.png")
    with open(aligned_path, "wb") as f:
        f.write(data)

    with db() as con:
        con.execute(
            "UPDATE floor_plans SET aligned_mask_path=?, status=?, updated_at=? WHERE id=?",
            (aligned_path, "aligned", now(), fp_id),
        )
        fp2 = con.execute("SELECT * FROM floor_plans WHERE id=?", (fp_id,)).fetchone()
    return _floor_plan_row_to_dict(fp2)


@router.post("/projects/{project_id}/floor_plans/{fp_id}/regenerate_mask")
def regenerate_floor_plan_mask(project_id: str, fp_id: str, payload: dict | None = None, user=Depends(get_current_user)):
    """Regenerate a floor-plan block mask via Gemini using optional instruction, then re-align it."""
    with db() as con:
        r = _authorize_project_write(con, project_id, user)
        fp = con.execute("SELECT * FROM floor_plans WHERE id=? AND project_id=?", (fp_id, project_id)).fetchone()
        if not fp:
            raise HTTPException(404, "floor plan block not found")

    render_path = fp["render_png_path"]
    if not render_path or not os.path.exists(render_path):
        raise HTTPException(404, "floor plan render image not available")

    settings = json.loads(r["settings_json"] or "{}")
    opts = PipelineOptions.from_env().merge_settings(settings)

    instruction = ((payload or {}).get("instruction") or "").strip()

    idx = fp["block_index"]
    blocks_dir = os.path.join(project_dir(project_id), "blocks")
    os.makedirs(blocks_dir, exist_ok=True)
    out_mask = fp["mask_png_path"] or os.path.join(blocks_dir, f"block_{idx}_mask.png")
    out_aligned = fp["aligned_mask_path"] or os.path.join(blocks_dir, f"block_{idx}_aligned.png")
    retry_prompt = (
        f"{DEFAULT_PROMPT}\n\n"
        "You are given two images in this request: "
        "(1) the original floor plan image and "
        "(2) the current generated mask image. "
        "Improve the current mask using the original image as source of truth. "
        "Preserve geometry/relative positions and fix missed walls, doors, beams, and partitions."
    )
    if instruction:
        retry_prompt = f"{retry_prompt}\n\nAdditional user instruction:\n{instruction}"

    try:
        generate_mask_image(
            input_png=render_path,
            out_mask_png=out_mask,
            prompt=retry_prompt,
            model=opts.gemini_model,
            context_mask_png=out_mask if os.path.exists(out_mask) else None,
        )
        align_perfect_tight_box(render_path, out_mask, out_aligned)
    except RuntimeError as exc:
        raise HTTPException(400, str(exc)) from exc
    except (OSError, ValueError, TypeError) as exc:
        raise HTTPException(500, f"mask regeneration failed: {exc}") from exc

    with db() as con:
        con.execute(
            "UPDATE floor_plans SET mask_png_path=?, aligned_mask_path=?, status=?, updated_at=? WHERE id=?",
            (out_mask, out_aligned, "aligned", now(), fp_id),
        )
        con.execute(
            "UPDATE projects SET status=?, error=NULL, updated_at=? WHERE id=?",
            ("awaiting_alignment_review", now(), project_id),
        )
        fp2 = con.execute("SELECT * FROM floor_plans WHERE id=?", (fp_id,)).fetchone()
    return _floor_plan_row_to_dict(fp2)


@router.get("/projects/{project_id}/floor_plans/{fp_id}")
def get_floor_plan(project_id: str, fp_id: str, user=Depends(get_current_user)):
    """Return a single floor-plan block."""
    with db() as con:
        r = _authorize_project(con, project_id, user)
        fp = con.execute("SELECT * FROM floor_plans WHERE id=? AND project_id=?", (fp_id, project_id)).fetchone()
        if not fp:
            raise HTTPException(404, "floor plan block not found")
    return _floor_plan_row_to_dict(fp)


@router.put("/projects/{project_id}/floor_plans/{fp_id}")
def update_floor_plan(project_id: str, fp_id: str, payload: dict, user=Depends(get_current_user)):
    """Update editable floor-plan metadata (currently height in meters)."""
    with db() as con:
        _authorize_project_write(con, project_id, user)
        fp = con.execute("SELECT * FROM floor_plans WHERE id=? AND project_id=?", (fp_id, project_id)).fetchone()
        if not fp:
            raise HTTPException(404, "floor plan block not found")

    height_m_raw = payload.get("height_m")
    if height_m_raw is None:
        raise HTTPException(400, "height_m is required")

    try:
        height_m = float(height_m_raw)
    except (TypeError, ValueError) as exc:
        raise HTTPException(400, "height_m must be a number") from exc

    if height_m <= 0:
        raise HTTPException(400, "height_m must be greater than 0")

    with db() as con:
        con.execute(
            "UPDATE floor_plans SET height_m=?, updated_at=? WHERE id=?",
            (height_m, now(), fp_id),
        )
        fp2 = con.execute("SELECT * FROM floor_plans WHERE id=?", (fp_id,)).fetchone()

    return _floor_plan_row_to_dict(fp2)


# ── Per-floor-plan rooms endpoints ──────────────────────────

@router.get("/projects/{project_id}/floor_plans/{fp_id}/rooms")
def get_floor_plan_rooms(project_id: str, fp_id: str, user=Depends(get_current_user)):
    """Return rooms JSON for a specific floor-plan block."""
    with db() as con:
        r = _authorize_project(con, project_id, user)
        fp = con.execute("SELECT * FROM floor_plans WHERE id=? AND project_id=?", (fp_id, project_id)).fetchone()
        if not fp:
            raise HTTPException(404, "floor plan block not found")
    rooms_path = fp["rooms_json_path"]
    if not rooms_path or not os.path.exists(rooms_path):
        raise HTTPException(404, "rooms not yet extracted for this floor plan")
    with open(rooms_path, "r", encoding="utf-8") as f:
        return json.load(f)


@router.put("/projects/{project_id}/floor_plans/{fp_id}/rooms")
def update_floor_plan_rooms(project_id: str, fp_id: str, payload: dict, user=Depends(get_current_user)):
    """Overwrite rooms JSON for a specific floor-plan block."""
    with db() as con:
        r = _authorize_project_write(con, project_id, user)
        fp = con.execute("SELECT * FROM floor_plans WHERE id=? AND project_id=?", (fp_id, project_id)).fetchone()
        if not fp:
            raise HTTPException(404, "floor plan block not found")
    rooms_path = fp["rooms_json_path"]
    if not rooms_path:
        # Create rooms path for this floor plan
        blocks_dir = os.path.join(project_dir(project_id), "blocks")
        os.makedirs(blocks_dir, exist_ok=True)
        rooms_path = os.path.join(blocks_dir, f"block_{fp['block_index']}_rooms.json")
        with db() as con:
            con.execute("UPDATE floor_plans SET rooms_json_path=?, updated_at=? WHERE id=?",
                        (rooms_path, now(), fp_id))
    if os.path.exists(rooms_path):
        try:
            with open(rooms_path, "r", encoding="utf-8") as rf:
                existing = json.load(rf)
            if isinstance(existing, dict) and isinstance(payload, dict):
                if "doors" in existing and "doors" not in payload:
                    payload["doors"] = existing["doors"]
                if "staircases" in existing and "staircases" not in payload:
                    payload["staircases"] = existing["staircases"]
                if "shapes" in existing and "shapes" not in payload:
                    payload["shapes"] = existing["shapes"]
        except Exception:
            pass
    with open(rooms_path, "w", encoding="utf-8") as f:
        json.dump(payload, f, indent=2)
    return payload


@router.post("/projects/{project_id}/floor_plans/{fp_id}/auto_place")
def auto_place_floor_plan(project_id: str, fp_id: str, payload: dict = None, user=Depends(get_current_user)):
    """Auto-place detectors for a specific floor-plan block using its rooms."""
    from app.pipeline.place_detectors_advanced import place_detectors_from_rooms_json
    from app.pipeline.mcp_hooter_placement import place_mcp_hooter_from_rooms_payload
    import uuid as _uuid

    equipment_type = (payload or {}).get("equipment_type", "smoke") if payload else "smoke"
    ALLOWED_TYPES = {"smoke", "heat", "sprinkler", "fire_hose", "panel", "hooter", "mcb", "mcp_hooter"}
    if equipment_type not in ALLOWED_TYPES:
        equipment_type = "smoke"

    with db() as con:
        r = _authorize_project_write(con, project_id, user)
        fp = con.execute("SELECT * FROM floor_plans WHERE id=? AND project_id=?", (fp_id, project_id)).fetchone()
        if not fp:
            raise HTTPException(404, "floor plan block not found")

    rooms_path = fp["rooms_json_path"]
    if not rooms_path or not os.path.exists(rooms_path):
        raise HTTPException(404, "rooms not yet extracted for this floor plan")

    fp_mapping = fp["mapping_json_path"]
    fp_render = fp["render_png_path"]

    with open(rooms_path, "r", encoding="utf-8") as f:
        rooms_data = json.load(f)
    rooms = rooms_data.get("rooms", rooms_data) if isinstance(rooms_data, dict) else rooms_data

    settings = json.loads(r["settings_json"] or "{}")
    opts = PipelineOptions.from_env().merge_settings(settings)

    if equipment_type == "sprinkler":
        from app.pipeline.sprinkler_routing import place_sprinklers_only
        # Place sprinklers only (no pipe routing)
        sp_points = place_sprinklers_only(
            rooms,
            spacing_m=opts.sprinkler_spacing_m,
            wall_buffer_m=opts.wall_buffer_m,
            world_to_m=opts.world_to_m,
        )
        new_dets = [
            {"id": str(_uuid.uuid4())[:8], "x": x, "y": y, "z": 0.0,
             "dtype": "sprinkler", "locked": 0, "floor_plan_id": fp_id}
            for x, y in sp_points
        ]
    elif equipment_type == "mcp_hooter":
        rooms_payload = rooms_data if isinstance(rooms_data, dict) else {"rooms": rooms}
        stations = place_mcp_hooter_from_rooms_payload(
            rooms_payload,
            world_to_m=opts.world_to_m,
            gemini_model=opts.gemini_model,
        )
        offset = MCP_HOOTER_PAIR_OFFSET_M / max(float(opts.world_to_m), 1e-9)
        new_dets = []
        for x, y in stations:
            half = offset * 0.5
            new_dets.append({
                "id": str(_uuid.uuid4())[:8], "x": x - half, "y": y, "z": 0.0,
                "dtype": "mcb", "locked": 0, "floor_plan_id": fp_id,
            })
            new_dets.append({
                "id": str(_uuid.uuid4())[:8], "x": x + half, "y": y, "z": 0.0,
                "dtype": "hooter", "locked": 0, "floor_plan_id": fp_id,
            })
    else:
        # equipment_type is "smoke" or "heat".
        # Partition rooms via the DXF-text classifier so toilets, kitchens,
        # plant rooms, garages, etc. get HEAT and life-safety areas get SMOKE.
        # A debug PNG is written alongside the floor-plan render showing every
        # room polygon colour-coded by its classification with its DXF labels.
        from app.pipeline.dxf_text_filter import split_rooms_by_dxf_text
        dxf_path = r["dxf_path"] if "dxf_path" in r.keys() else None
        fp_dir = os.path.dirname(fp_render) if fp_render else None
        label_debug = (
            os.path.join(fp_dir, f"block_{fp['block_index']}_room_labels_debug.png")
            if fp_dir else None
        )
        try:
            smoke_rooms, heat_rooms = split_rooms_by_dxf_text(
                rooms,
                dxf_path or "",
                debug_png_path=label_debug,
                base_png_path=fp_render,
                mapping_json_path=fp_mapping,
            )
        except Exception:
            import logging as _logging
            _logging.getLogger("mepit.routers.projects").exception(
                "auto_place: split_rooms_by_dxf_text failed; falling back to all-smoke",
            )
            smoke_rooms, heat_rooms = list(rooms), []

        if equipment_type == "heat":
            target_rooms = heat_rooms
            spacing = opts.heat_detector_spacing_m
        else:
            target_rooms = smoke_rooms
            spacing = opts.detector_spacing_m

        if not target_rooms:
            placed = []
        else:
            placed, _regions = place_detectors_from_rooms_json(
                target_rooms,
                spacing,
                opts.wall_buffer_m,
                opts.world_to_m,
                mapping_json_path=fp_mapping,
                base_png_path=fp_render,
            )
        new_dets = [
            {"id": str(_uuid.uuid4())[:8], "x": x, "y": y, "z": 0.0,
             "dtype": equipment_type, "locked": 0, "floor_plan_id": fp_id}
            for (x, y) in placed
        ]

        # When the user clicked "smoke", also place heat detectors in
        # heat-classified rooms (kitchens, toilets, plant rooms, garages, ...)
        # so those rooms aren't left without coverage.
        if equipment_type == "smoke" and heat_rooms:
            heat_placed, _ = place_detectors_from_rooms_json(
                heat_rooms,
                opts.heat_detector_spacing_m,
                opts.wall_buffer_m,
                opts.world_to_m,
                mapping_json_path=fp_mapping,
                base_png_path=fp_render,
            )
            new_dets.extend(
                {"id": str(_uuid.uuid4())[:8], "x": x, "y": y, "z": 0.0,
                 "dtype": "heat", "locked": 0, "floor_plan_id": fp_id}
                for (x, y) in heat_placed
            )

    with db() as con:
        # Delete only detectors of this type for this floor plan
        if equipment_type == "mcp_hooter":
            con.execute(
                "DELETE FROM detectors WHERE project_id=? AND dtype IN ('mcb','hooter') AND floor_plan_id=?",
                (project_id, fp_id),
            )
        elif equipment_type == "smoke":
            # Smoke placement also (re)places heat detectors in heat rooms.
            con.execute(
                "DELETE FROM detectors WHERE project_id=? AND dtype IN ('smoke','heat') AND floor_plan_id=?",
                (project_id, fp_id),
            )
        else:
            con.execute("DELETE FROM detectors WHERE project_id=? AND dtype=? AND floor_plan_id=?",
                        (project_id, equipment_type, fp_id))
        for d in new_dets:
            con.execute(
                 """INSERT INTO detectors (id,project_id,x,y,z,rotation_deg,dtype,locked,floor_plan_id,created_at,updated_at)
                     VALUES (?,?,?,?,?,?,?,?,?,?,?)""",
                (d["id"], project_id, float(d["x"]), float(d["y"]), float(d.get("z", 0.0)),
                  float(d.get("rotation_deg", 0.0)), d.get("dtype", "smoke"), int(d.get("locked", 0)), fp_id, now(), now()),
            )

    # Return detectors for this floor plan
    with db() as con:
        rows = con.execute(
            "SELECT id, project_id, x, y, z, rotation_deg, dtype, locked, floor_plan_id FROM detectors WHERE project_id=? AND floor_plan_id=? ORDER BY created_at ASC",
            (project_id, fp_id),
        ).fetchall()
    return [dict(r) for r in rows]


@router.get("/projects/{project_id}/sprinkler_pipes")
def get_sprinkler_pipes(project_id: str, user=Depends(get_current_user)):
    """Return sprinkler pipe routing data for the project.

    Merges project-level ``sprinkler_pipes.json`` with any per-block
    ``sprinkler_pipes_{block_index}.json`` files so the viewer can show
    every routed pipe without forcing the user to select a block first.
    """
    with db() as con:
        _authorize_project(con, project_id, user)
        fp_rows = con.execute(
            "SELECT block_index FROM floor_plans WHERE project_id=? ORDER BY block_index ASC",
            (project_id,),
        ).fetchall()

    merged_pipes: list = []
    merged_sources: list = []

    def _ingest(path: str) -> None:
        if not os.path.exists(path):
            return
        try:
            with open(path, "r", encoding="utf-8") as f:
                data = json.load(f)
        except Exception:
            return
        if isinstance(data, dict):
            pipes = data.get("pipes")
            if isinstance(pipes, list):
                merged_pipes.extend(pipes)
            sources = data.get("sources")
            if isinstance(sources, list):
                merged_sources.extend(sources)

    pdir = project_dir(project_id)
    _ingest(os.path.join(pdir, "sprinkler_pipes.json"))
    for fp in fp_rows:
        idx = int(fp["block_index"]) if "block_index" in fp.keys() else None
        if idx is None:
            continue
        _ingest(os.path.join(pdir, f"sprinkler_pipes_{idx}.json"))

    if not merged_pipes and not merged_sources:
        raise HTTPException(404, "no sprinkler pipes data")
    return {"pipes": merged_pipes, "sources": merged_sources}


@router.put("/projects/{project_id}/sprinkler_pipes")
def update_sprinkler_pipes(project_id: str, payload: dict, user=Depends(get_current_user)):
    """Save modified sprinkler pipe data for the project."""
    with db() as con:
        r = _authorize_project_write(con, project_id, user)
    pipes_path = os.path.join(project_dir(project_id), "sprinkler_pipes.json")
    pipes_data = {
        "pipes": payload.get("pipes", []),
        "sources": payload.get("sources", []),
    }
    with open(pipes_path, "w", encoding="utf-8") as f:
        json.dump(pipes_data, f, indent=2)
    return pipes_data


@router.delete("/projects/{project_id}/sprinkler_pipes")
def clear_sprinkler_pipes(project_id: str, user=Depends(get_current_user)):
    """Clear sprinkler pipe routing data for the whole project."""
    with db() as con:
        _authorize_project_write(con, project_id, user)

    pipes_path = os.path.join(project_dir(project_id), "sprinkler_pipes.json")
    existed = os.path.exists(pipes_path)
    if existed:
        os.remove(pipes_path)
    return {"ok": True, "cleared": existed}


@router.get("/projects/{project_id}/floor_plans/{fp_id}/sprinkler_pipes")
def get_floor_plan_sprinkler_pipes(project_id: str, fp_id: str, user=Depends(get_current_user)):
    """Return sprinkler pipe routing data for a specific floor plan block."""
    with db() as con:
        r = _authorize_project(con, project_id, user)
        fp = con.execute("SELECT * FROM floor_plans WHERE id=? AND project_id=?", (fp_id, project_id)).fetchone()
        if not fp:
            raise HTTPException(404, "floor plan block not found")
    pipes_path = os.path.join(project_dir(project_id), f"sprinkler_pipes_{fp['block_index']}.json")
    if not os.path.exists(pipes_path):
        raise HTTPException(404, "no sprinkler pipes data for this floor plan")
    with open(pipes_path, "r", encoding="utf-8") as f:
        return json.load(f)


@router.delete("/projects/{project_id}/floor_plans/{fp_id}/sprinkler_pipes")
def clear_floor_plan_sprinkler_pipes(project_id: str, fp_id: str, user=Depends(get_current_user)):
    """Clear sprinkler pipe routing data for a specific floor plan block."""
    with db() as con:
        _authorize_project_write(con, project_id, user)
        fp = con.execute("SELECT * FROM floor_plans WHERE id=? AND project_id=?", (fp_id, project_id)).fetchone()
        if not fp:
            raise HTTPException(404, "floor plan block not found")

    pipes_path = os.path.join(project_dir(project_id), f"sprinkler_pipes_{fp['block_index']}.json")
    existed = os.path.exists(pipes_path)
    if existed:
        os.remove(pipes_path)
    return {"ok": True, "cleared": existed}


@router.get("/projects/{project_id}/detect_sources")
def detect_sources(project_id: str, user=Depends(get_current_user)):
    """Automatic DXF source detection has been removed.
    Endpoint kept for frontend compatibility; always returns an empty list so
    the UI falls through to manual source picking.
    """
    with db() as con:
        _authorize_project(con, project_id, user)
    return []


@router.post("/projects/{project_id}/route_pipes")
def route_pipes_project(project_id: str, payload: dict = None, user=Depends(get_current_user)):
    """Route pipes connecting existing sprinkler detectors for the project.
    
    Optional payload: {"source": {"x": ..., "y": ...}} to use a user-selected source.
    """
    from app.pipeline.sprinkler_routing import route_pipes_for_sprinklers

    with db() as con:
        r = _authorize_project_write(con, project_id, user)
        sprinkler_rows = con.execute(
            "SELECT x, y FROM detectors WHERE project_id=? AND dtype='sprinkler' ORDER BY created_at ASC",
            (project_id,),
        ).fetchall()

    if not sprinkler_rows:
        raise HTTPException(400, "no sprinklers placed yet")

    rooms_path = r["rooms_json_path"]
    if not rooms_path or not os.path.exists(rooms_path):
        raise HTTPException(404, "rooms not yet extracted")

    dxf_path = r["dxf_path"]
    if not dxf_path or not os.path.exists(dxf_path):
        raise HTTPException(400, "base DXF not available")

    pdir = project_dir(project_id)

    with open(rooms_path, "r", encoding="utf-8") as f:
        rooms_data = json.load(f)
    rooms = rooms_data.get("rooms", rooms_data) if isinstance(rooms_data, dict) else rooms_data

    settings = json.loads(r["settings_json"] or "{}")
    opts = PipelineOptions.from_env().merge_settings(settings)

    sprinkler_coords = [(float(row["x"]), float(row["y"])) for row in sprinkler_rows]

    region_poly = _parse_region_polygon(payload)
    if region_poly is not None:
        filtered = [p for p in sprinkler_coords if _point_in_polygon(p[0], p[1], region_poly)]
        if not filtered:
            raise HTTPException(400, "no sprinklers fall inside the selected region")
        sprinkler_coords = filtered

    user_source = None
    if payload and isinstance(payload.get("source"), dict):
        src = payload["source"]
        user_source = (float(src["x"]), float(src["y"]))

    pipe_segments, _snapped, sources = route_pipes_for_sprinklers(
        sprinkler_coords, rooms, dxf_path,
        spacing_m=opts.sprinkler_spacing_m,
        wall_buffer_m=opts.wall_buffer_m,
        world_to_m=opts.world_to_m,
        source_labels=opts.sprinkler_source_labels,
        override_source=user_source,
    )

    new_pipes = [
        {"from": list(seg[0][0]), "to": list(seg[0][1]), "diameter": seg[1]}
        for seg in pipe_segments
    ]
    new_sources = [{"x": s[0], "y": s[1]} for s in sources]
    pipes_json_path = os.path.join(pdir, "sprinkler_pipes.json")
    pipes_data = _merge_pipes_file(pipes_json_path, new_pipes, new_sources)

    return pipes_data


@router.post("/projects/{project_id}/floor_plans/{fp_id}/route_pipes")
def route_pipes_floor_plan(project_id: str, fp_id: str, payload: dict = None, user=Depends(get_current_user)):
    """Route pipes connecting existing sprinkler detectors for a floor plan block."""
    from app.pipeline.sprinkler_routing import route_pipes_for_sprinklers

    with db() as con:
        r = _authorize_project_write(con, project_id, user)
        fp = con.execute("SELECT * FROM floor_plans WHERE id=? AND project_id=?", (fp_id, project_id)).fetchone()
        if not fp:
            raise HTTPException(404, "floor plan block not found")
        sprinkler_rows = con.execute(
            "SELECT x, y FROM detectors WHERE project_id=? AND dtype='sprinkler' AND floor_plan_id=? ORDER BY created_at ASC",
            (project_id, fp_id),
        ).fetchall()

    if not sprinkler_rows:
        raise HTTPException(400, "no sprinklers placed in this floor plan")

    rooms_path = fp["rooms_json_path"]
    if not rooms_path or not os.path.exists(rooms_path):
        raise HTTPException(404, "rooms not yet extracted for this floor plan")

    dxf_path = r["dxf_path"]
    if not dxf_path or not os.path.exists(dxf_path):
        raise HTTPException(400, "base DXF not available")

    pdir = project_dir(project_id)

    with open(rooms_path, "r", encoding="utf-8") as f:
        rooms_data = json.load(f)
    rooms = rooms_data.get("rooms", rooms_data) if isinstance(rooms_data, dict) else rooms_data

    settings = json.loads(r["settings_json"] or "{}")
    opts = PipelineOptions.from_env().merge_settings(settings)

    sprinkler_coords = [(float(row["x"]), float(row["y"])) for row in sprinkler_rows]

    region_poly = _parse_region_polygon(payload)
    if region_poly is not None:
        filtered = [p for p in sprinkler_coords if _point_in_polygon(p[0], p[1], region_poly)]
        if not filtered:
            raise HTTPException(400, "no sprinklers fall inside the selected region")
        sprinkler_coords = filtered

    user_source = None
    if payload and isinstance(payload.get("source"), dict):
        src = payload["source"]
        user_source = (float(src["x"]), float(src["y"]))

    pipe_segments, _snapped, sources = route_pipes_for_sprinklers(
        sprinkler_coords, rooms, dxf_path,
        spacing_m=opts.sprinkler_spacing_m,
        wall_buffer_m=opts.wall_buffer_m,
        world_to_m=opts.world_to_m,
        source_labels=opts.sprinkler_source_labels,
        override_source=user_source,
    )

    new_pipes = [
        {"from": list(seg[0][0]), "to": list(seg[0][1]), "diameter": seg[1]}
        for seg in pipe_segments
    ]
    new_sources = [{"x": s[0], "y": s[1]} for s in sources]
    pipes_json_path = os.path.join(pdir, f"sprinkler_pipes_{fp['block_index']}.json")
    pipes_data = _merge_pipes_file(pipes_json_path, new_pipes, new_sources)

    return pipes_data
