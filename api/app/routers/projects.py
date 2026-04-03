import os
import json
from fastapi import APIRouter, UploadFile, File, HTTPException, BackgroundTasks, Depends
from pydantic import BaseModel
from typing import Any, Dict, Optional
from app.db import db, now, log_activity
from app.storage import new_id, project_dir, relpath
from app.schemas import ProjectOut, ProjectUpdateSettings
from app.pipeline.run_pipeline import (
    run_pipeline_for_project,
    continue_pipeline_after_floor_review,
    continue_pipeline_after_alignment,
    continue_pipeline_after_rooms,
    PipelineOptions,
)
from app.pipeline.dxf_export import write_detectors_to_dxf
from app.pipeline.render import render_dwg_to_png_with_qcad, write_mapping_from_dxf_and_png
from app.pipeline.nbc_rules import (
    get_questions as nbc_get_questions,
    evaluate_building,
    OCCUPANCY_DISPLAY_LABELS,
    FOLLOWUP_QUESTIONS,
)
from app.routers.auth import get_current_user

router = APIRouter(tags=["projects"])


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


def _authorize_project(con, project_id: str, user: dict):
    """Fetch a project row and verify the caller has access (owner or tenant member).
    Raises 404 if not found / not authorized.
    """
    r = con.execute("SELECT * FROM projects WHERE id=?", (project_id,)).fetchone()
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
                "SELECT * FROM projects WHERE tenant_id=? ORDER BY updated_at DESC, created_at DESC",
                (tid,),
            ).fetchall()
        else:
            # Legacy fallback: user's own projects
            rows = con.execute(
                "SELECT * FROM projects WHERE owner_id=? ORDER BY updated_at DESC, created_at DESC",
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
            files[k] = f"/files/{relpath(p_norm)}" if p_norm else None
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
    add("rooms_debug", rooms_debug_path if os.path.exists(rooms_debug_path) else None)
    add("output_dxf", r["output_dxf_path"])
    add("output_preview_png", r["output_preview_png_path"])
    add("output_preview_mapping", preview_mapping_path if os.path.exists(preview_mapping_path) else None)
    add("detectors_global_snap_debug", detectors_debug_path if os.path.exists(detectors_debug_path) else None)
    add("detectors_global_snap_overlay", detectors_overlay_debug_path if os.path.exists(detectors_overlay_debug_path) else None)

    sprinkler_pipes_path = os.path.join(project_dir(r["id"]), "sprinkler_pipes.json")
    add("sprinkler_pipes", sprinkler_pipes_path if os.path.exists(sprinkler_pipes_path) else None)

    # Count floor plan blocks
    with db() as con:
        fp_count = con.execute(
            "SELECT COUNT(*) FROM floor_plans WHERE project_id=?",
            (r["id"],),
        ).fetchone()[0]

    return ProjectOut(
        id=r["id"],
        name=r["name"],
        status=r["status"],
        error=r["error"],
        files=files,
        nbc_evaluation=json.loads(r["settings_json"] or "{}").get("nbc_evaluation"),
        nbc_answers=json.loads(r["settings_json"] or "{}").get("nbc_answers"),
        input_filename=r["input_filename"],
        floor_plans_count=fp_count,
    )

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
        settings["qcad_input_unit"] = payload.unit

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
        con.execute("UPDATE projects SET settings_json=?, updated_at=? WHERE id=?",
                    (json.dumps(payload.settings), now(), project_id))
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

    with db() as con:
        r2 = _authorize_project(con, project_id, user)
    return _project_row_to_out(r2)


@router.post("/projects/{project_id}/floor_plans")
def add_floor_plan(project_id: str, payload: dict, user=Depends(get_current_user)):
    """Add a user-defined floor plan block by specifying pixel bounding box on the master render.

    Payload: {"pixel_bbox": [x0, y0, x1, y1]}
    Converts pixel bbox to world coords and inserts into DB.
    Block rendering is deferred until the user confirms the floor plan review.
    """
    from app.pipeline.floor_plan_split import _pixel_to_dxf
    import uuid as _uuid

    with db() as con:
        r = _authorize_project_write(con, project_id, user)

    pixel_bbox = payload.get("pixel_bbox")
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
                json.dumps([bx0, by0, bx1, by1]),
                None, None,
                "created", now(), now(),
            ),
        )
        fp = con.execute("SELECT * FROM floor_plans WHERE id=?", (fp_id,)).fetchone()
    return _floor_plan_row_to_dict(fp)


@router.delete("/projects/{project_id}/floor_plans/{fp_id}")
def delete_floor_plan(project_id: str, fp_id: str, user=Depends(get_current_user)):
    """Delete a floor plan block."""
    with db() as con:
        r = _authorize_project_write(con, project_id, user)
        fp = con.execute("SELECT * FROM floor_plans WHERE id=? AND project_id=?", (fp_id, project_id)).fetchone()
        if not fp:
            raise HTTPException(404, "floor plan block not found")
        con.execute("DELETE FROM floor_plans WHERE id=?", (fp_id,))
        con.execute("DELETE FROM detectors WHERE project_id=? AND floor_plan_id=?", (project_id, fp_id))
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
    from app.pipeline.sprinkler_routing import place_sprinklers_only
    import uuid as _uuid

    equipment_type = (payload or {}).get("equipment_type", "smoke") if payload else "smoke"
    # Validate
    ALLOWED_TYPES = {"smoke", "sprinkler", "fire_hose", "panel", "hooter", "mcb"}
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
        # Delete only detectors of this type, keep others
        con.execute("DELETE FROM detectors WHERE project_id=? AND dtype=?", (project_id, equipment_type))
        for d in new_dets:
            con.execute(
                """INSERT INTO detectors (id,project_id,x,y,z,dtype,locked,created_at,updated_at)
                     VALUES (?,?,?,?,?,?,?,?,?)""",
                (d["id"], project_id, float(d["x"]), float(d["y"]), float(d.get("z", 0.0)),
                 d.get("dtype", "smoke"), int(d.get("locked", 0)), now(), now()),
            )

    # Return placed detectors
    with db() as con:
        rows = con.execute(
            "SELECT id, project_id, x, y, z, dtype, locked FROM detectors WHERE project_id=? ORDER BY created_at ASC",
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
    """Save rooms, detectors, and pipes in a single call. No QCAD rendering."""
    with db() as con:
        r = _authorize_project_write(con, project_id, user)

        pdir = project_dir(project_id)
        floor_plan_id = payload.get("floor_plan_id")

        # ── 1. Save rooms ──────────────────────────────────────────────
        rooms = payload.get("rooms")
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
                    """INSERT INTO detectors (id,project_id,x,y,z,dtype,locked,floor_plan_id,created_at,updated_at)
                         VALUES (?,?,?,?,?,?,?,?,?,?)""",
                    (d.get("id", str(__import__('uuid').uuid4())), project_id,
                     float(d["x"]), float(d["y"]), float(d.get("z", 0)),
                     d.get("dtype", "smoke"), int(d.get("locked", False)),
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
            "SELECT id, x, y, z, dtype, locked FROM detectors WHERE project_id=? ORDER BY created_at ASC",
            (project_id,),
        ).fetchall()

        dets = [
            {
                "id": row["id"],
                "x": float(row["x"]),
                "y": float(row["y"]),
                "z": float(row["z"]),
                "dtype": row["dtype"],
                "locked": bool(row["locked"]),
            }
            for row in det_rows
        ]

        settings = json.loads(r["settings_json"] or "{}")
        opts = PipelineOptions.from_env().merge_settings(settings)

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

        out_dxf = os.path.join(project_dir(project_id), "detectors_overlay.dxf")
        write_detectors_to_dxf(dxf_path, out_dxf, dets,
                               world_to_m=opts.world_to_m, world_bbox=world_bbox)

        # Write sprinkler pipes into the DXF if they exist
        # Collect pipes from project-level and per-floor-plan files
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
            a = _norm_pt(p_from)
            b = _norm_pt(p_to)
            key_endpoints = tuple(sorted([a, b]))
            key = (key_endpoints[0], key_endpoints[1], str(diameter))
            if key in seg_seen:
                return
            seg_seen.add(key)
            all_pipe_segments.append(((a, b), str(diameter)))

        def _add_source(src):
            s = _norm_pt(src)
            if s in src_seen:
                return
            src_seen.add(s)
            all_pipe_sources.append(s)

        pipes_json_path = os.path.join(project_dir(project_id), "sprinkler_pipes.json")
        if os.path.exists(pipes_json_path):
            with open(pipes_json_path, "r", encoding="utf-8") as pf:
                pipes_data = json.load(pf)
            for p in pipes_data.get("pipes", []):
                _add_segment(p["from"], p["to"], p.get("diameter", "32mm"))
            for s in pipes_data.get("sources", []):
                _add_source((s["x"], s["y"]))

        # Per-floor-plan pipes
        fp_rows = con.execute(
            "SELECT block_index FROM floor_plans WHERE project_id=? ORDER BY block_index ASC",
            (project_id,),
        ).fetchall()
        for fp_row in fp_rows:
            fp_pipes_path = os.path.join(project_dir(project_id), f"sprinkler_pipes_{fp_row['block_index']}.json")
            if os.path.exists(fp_pipes_path):
                with open(fp_pipes_path, "r", encoding="utf-8") as pf:
                    fp_pipes = json.load(pf)
                for p in fp_pipes.get("pipes", []):
                    _add_segment(p["from"], p["to"], p.get("diameter", "32mm"))
                for s in fp_pipes.get("sources", []):
                    _add_source((s["x"], s["y"]))

        sprinkler_dets = [(float(d["x"]), float(d["y"])) for d in dets if d["dtype"] == "sprinkler"]
        if sprinkler_dets or all_pipe_segments:
            write_sprinklers_to_dxf(
                out_dxf, out_dxf,
                sprinkler_dets, all_pipe_segments, all_pipe_sources,
                world_to_m=opts.world_to_m, world_bbox=world_bbox,
            )

        out_png = os.path.join(project_dir(project_id), "detectors_preview.png")
        out_map = os.path.join(project_dir(project_id), "detectors_preview_mapping.json")

        render_dwg_to_png_with_qcad(
            dwg_path=out_dxf,
            out_png=out_png,
            target_long_side_px=min(opts.target_long_side_px, 8000),
            background="white",
        )
        write_mapping_from_dxf_and_png(
            dxf_path=out_dxf,
            png_path=out_png,
            out_json=out_map,
            pad_frac=opts.pad_frac,
        )

        con.execute(
            "UPDATE projects SET output_dxf_path=?, output_preview_png_path=?, status=?, error=NULL, updated_at=? WHERE id=?",
            (out_dxf, out_png, "ready", now(), project_id),
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
        "world_bbox": json.loads(fp["world_bbox_json"]) if fp["world_bbox_json"] else None,
        "pixel_bbox": json.loads(fp["pixel_bbox_json"]) if fp["pixel_bbox_json"] else None,
        "files": {},
    }
    def add(k, p):
        d["files"][k] = f"/files/{relpath(p)}" if p and os.path.exists(p) else None
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
    add("sprinkler_pipes", pipes_path if os.path.exists(pipes_path) else None)
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


@router.get("/projects/{project_id}/floor_plans/{fp_id}")
def get_floor_plan(project_id: str, fp_id: str, user=Depends(get_current_user)):
    """Return a single floor-plan block."""
    with db() as con:
        r = _authorize_project(con, project_id, user)
        fp = con.execute("SELECT * FROM floor_plans WHERE id=? AND project_id=?", (fp_id, project_id)).fetchone()
        if not fp:
            raise HTTPException(404, "floor plan block not found")
    return _floor_plan_row_to_dict(fp)


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
        except Exception:
            pass
    with open(rooms_path, "w", encoding="utf-8") as f:
        json.dump(payload, f, indent=2)
    return payload


@router.post("/projects/{project_id}/floor_plans/{fp_id}/auto_place")
def auto_place_floor_plan(project_id: str, fp_id: str, payload: dict = None, user=Depends(get_current_user)):
    """Auto-place detectors for a specific floor-plan block using its rooms."""
    from app.pipeline.place_detectors_advanced import place_detectors_from_rooms_json
    import uuid as _uuid

    equipment_type = (payload or {}).get("equipment_type", "smoke") if payload else "smoke"
    ALLOWED_TYPES = {"smoke", "sprinkler", "fire_hose", "panel", "hooter", "mcb"}
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
    else:
        placed, _regions = place_detectors_from_rooms_json(
            rooms,
            opts.detector_spacing_m,
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

    with db() as con:
        # Delete only detectors of this type for this floor plan
        con.execute("DELETE FROM detectors WHERE project_id=? AND dtype=? AND floor_plan_id=?",
                    (project_id, equipment_type, fp_id))
        for d in new_dets:
            con.execute(
                """INSERT INTO detectors (id,project_id,x,y,z,dtype,locked,floor_plan_id,created_at,updated_at)
                     VALUES (?,?,?,?,?,?,?,?,?,?)""",
                (d["id"], project_id, float(d["x"]), float(d["y"]), float(d.get("z", 0.0)),
                 d.get("dtype", "smoke"), int(d.get("locked", 0)), fp_id, now(), now()),
            )

    # Return detectors for this floor plan
    with db() as con:
        rows = con.execute(
            "SELECT id, project_id, x, y, z, dtype, locked, floor_plan_id FROM detectors WHERE project_id=? AND floor_plan_id=? ORDER BY created_at ASC",
            (project_id, fp_id),
        ).fetchall()
    return [dict(r) for r in rows]


@router.get("/projects/{project_id}/sprinkler_pipes")
def get_sprinkler_pipes(project_id: str, user=Depends(get_current_user)):
    """Return sprinkler pipe routing data for the project."""
    with db() as con:
        r = _authorize_project(con, project_id, user)
    pipes_path = os.path.join(project_dir(project_id), "sprinkler_pipes.json")
    if not os.path.exists(pipes_path):
        raise HTTPException(404, "no sprinkler pipes data")
    with open(pipes_path, "r", encoding="utf-8") as f:
        return json.load(f)


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


@router.get("/projects/{project_id}/detect_sources")
def detect_sources(project_id: str, user=Depends(get_current_user)):
    """Return pipeline source points detected from the DXF drawing."""
    from app.pipeline.sprinkler_routing import detect_sources_from_dxf, SOURCE_LABELS

    with db() as con:
        r = _authorize_project(con, project_id, user)

    dxf_path = r["dxf_path"]
    if not dxf_path or not os.path.exists(dxf_path):
        raise HTTPException(400, "base DXF not available")

    settings = json.loads(r["settings_json"] or "{}")
    opts = PipelineOptions.from_env().merge_settings(settings)
    labels = opts.sprinkler_source_labels or SOURCE_LABELS

    sources = detect_sources_from_dxf(dxf_path, labels)
    return [{"x": s[0], "y": s[1]} for s in sources]


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

    pipes_data = {
        "pipes": [
            {"from": list(seg[0][0]), "to": list(seg[0][1]), "diameter": seg[1]}
            for seg in pipe_segments
        ],
        "sources": [{"x": s[0], "y": s[1]} for s in sources],
    }
    pipes_json_path = os.path.join(pdir, "sprinkler_pipes.json")
    with open(pipes_json_path, "w", encoding="utf-8") as f:
        json.dump(pipes_data, f, indent=2)

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

    pipes_data = {
        "pipes": [
            {"from": list(seg[0][0]), "to": list(seg[0][1]), "diameter": seg[1]}
            for seg in pipe_segments
        ],
        "sources": [{"x": s[0], "y": s[1]} for s in sources],
    }
    pipes_json_path = os.path.join(pdir, f"sprinkler_pipes_{fp['block_index']}.json")
    with open(pipes_json_path, "w", encoding="utf-8") as f:
        json.dump(pipes_data, f, indent=2)

    return pipes_data
