import os
import json
from fastapi import APIRouter, UploadFile, File, HTTPException, BackgroundTasks, Depends
from pydantic import BaseModel
from typing import Any, Dict, Optional
from app.db import db, now
from app.storage import new_id, project_dir, relpath
from app.schemas import ProjectOut, ProjectUpdateSettings
from app.pipeline.run_pipeline import (
    run_pipeline_for_project,
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

@router.get("/projects", response_model=list[ProjectOut])
def list_projects(user=Depends(get_current_user)):
    with db() as con:
        rows = con.execute(
            "SELECT * FROM projects WHERE owner_id=? ORDER BY updated_at DESC, created_at DESC",
            (user["id"],),
        ).fetchall()
    return [_project_row_to_out(r) for r in rows]

def _project_row_to_out(r) -> ProjectOut:
    files = {}
    def add(k, p):
        files[k] = f"/files/{relpath(p)}" if p else None

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

    return ProjectOut(
        id=r["id"],
        name=r["name"],
        status=r["status"],
        error=r["error"],
        files=files,
        nbc_evaluation=json.loads(r["settings_json"] or "{}").get("nbc_evaluation"),
        nbc_answers=json.loads(r["settings_json"] or "{}").get("nbc_answers"),
        input_filename=r["input_filename"],
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

class ProjectCreateWithNBC(BaseModel):
    name: str
    nbc_answers: Dict[str, Any]

@router.post("/projects", response_model=ProjectOut)
def create_project(payload: ProjectCreateWithNBC, user=Depends(get_current_user)):
    nbc_result = evaluate_building(payload.nbc_answers)
    settings = {
        "nbc_answers": payload.nbc_answers,
        "nbc_evaluation": nbc_result,
    }
    pid = new_id()
    project_dir(pid)
    with db() as con:
        con.execute(
            """INSERT INTO projects
                (id,owner_id,name,status,created_at,updated_at,settings_json)
                VALUES (?,?,?,?,?,?,?)""",
            (pid, user["id"], payload.name, "created", now(), now(), json.dumps(settings)),
        )
        r = con.execute("SELECT * FROM projects WHERE id=?", (pid,)).fetchone()
    return _project_row_to_out(r)

@router.get("/projects/{project_id}", response_model=ProjectOut)
def get_project(project_id: str, user=Depends(get_current_user)):
    with db() as con:
        r = con.execute("SELECT * FROM projects WHERE id=? AND owner_id=?", (project_id, user["id"])).fetchone()
        if not r:
            raise HTTPException(404, "project not found")
    return _project_row_to_out(r)

@router.post("/projects/{project_id}/settings", response_model=ProjectOut)
def update_settings(project_id: str, payload: ProjectUpdateSettings, user=Depends(get_current_user)):
    with db() as con:
        r = con.execute("SELECT * FROM projects WHERE id=? AND owner_id=?", (project_id, user["id"])).fetchone()
        if not r:
            raise HTTPException(404, "project not found")
        con.execute("UPDATE projects SET settings_json=?, updated_at=? WHERE id=?",
                    (json.dumps(payload.settings), now(), project_id))
        r2 = con.execute("SELECT * FROM projects WHERE id=? AND owner_id=?", (project_id, user["id"])).fetchone()
    return _project_row_to_out(r2)

@router.post("/projects/{project_id}/upload", response_model=ProjectOut)
async def upload(project_id: str, file: UploadFile = File(...), user=Depends(get_current_user)):
    with db() as con:
        r = con.execute("SELECT * FROM projects WHERE id=? AND owner_id=?", (project_id, user["id"])).fetchone()
        if not r:
            raise HTTPException(404, "project not found")

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
        r2 = con.execute("SELECT * FROM projects WHERE id=? AND owner_id=?", (project_id, user["id"])).fetchone()

    return _project_row_to_out(r2)

@router.post("/projects/{project_id}/run", response_model=ProjectOut)
def run_pipeline(project_id: str, bg: BackgroundTasks, user=Depends(get_current_user)):
    # Run in background thread (simple MVP). For production use a real queue.
    with db() as con:
        r = con.execute("SELECT * FROM projects WHERE id=? AND owner_id=?", (project_id, user["id"])).fetchone()
        if not r:
            raise HTTPException(404, "project not found")
        if r["status"] in ("running",):
            raise HTTPException(409, "pipeline already running")
        con.execute("UPDATE projects SET status=?, error=NULL, updated_at=? WHERE id=?",
                    ("running", now(), project_id))

    # Load options from env + saved settings
    with db() as con:
        r = con.execute("SELECT * FROM projects WHERE id=? AND owner_id=?", (project_id, user["id"])).fetchone()
        settings = json.loads(r["settings_json"] or "{}")

    opts = PipelineOptions.from_env().merge_settings(settings)
    bg.add_task(run_pipeline_for_project, project_id, opts)

    with db() as con:
        r2 = con.execute("SELECT * FROM projects WHERE id=? AND owner_id=?", (project_id, user["id"])).fetchone()
    return _project_row_to_out(r2)

@router.post("/projects/{project_id}/aligned_mask", response_model=ProjectOut)
async def upload_aligned_mask(project_id: str, file: UploadFile = File(...), user=Depends(get_current_user)):
    with db() as con:
        r = con.execute("SELECT * FROM projects WHERE id=? AND owner_id=?", (project_id, user["id"])).fetchone()
        if not r:
            raise HTTPException(404, "project not found")

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
        r2 = con.execute("SELECT * FROM projects WHERE id=? AND owner_id=?", (project_id, user["id"])).fetchone()

    return _project_row_to_out(r2)

@router.post("/projects/{project_id}/continue", response_model=ProjectOut)
def continue_pipeline(project_id: str, bg: BackgroundTasks, user=Depends(get_current_user)):
    with db() as con:
        r = con.execute("SELECT * FROM projects WHERE id=? AND owner_id=?", (project_id, user["id"])).fetchone()
        if not r:
            raise HTTPException(404, "project not found")
        if r["status"] in ("running",):
            raise HTTPException(409, "pipeline already running")
        if r["status"] not in ("awaiting_alignment_review", "aligned"):
            raise HTTPException(409, "project is not awaiting alignment review")

        con.execute("UPDATE projects SET status=?, error=NULL, updated_at=? WHERE id=?",
                    ("running", now(), project_id))

    with db() as con:
        r = con.execute("SELECT * FROM projects WHERE id=? AND owner_id=?", (project_id, user["id"])).fetchone()
        settings = json.loads(r["settings_json"] or "{}")

    opts = PipelineOptions.from_env().merge_settings(settings)
    bg.add_task(continue_pipeline_after_alignment, project_id, opts)

    with db() as con:
        r2 = con.execute("SELECT * FROM projects WHERE id=? AND owner_id=?", (project_id, user["id"])).fetchone()
    return _project_row_to_out(r2)

# ── Rooms review endpoints ──────────────────────────────────

@router.get("/projects/{project_id}/rooms")
def get_rooms(project_id: str, user=Depends(get_current_user)):
    """Return the extracted rooms JSON for the project."""
    with db() as con:
        r = con.execute("SELECT * FROM projects WHERE id=? AND owner_id=?", (project_id, user["id"])).fetchone()
        if not r:
            raise HTTPException(404, "project not found")
    rooms_path = r["rooms_json_path"]
    if not rooms_path or not os.path.exists(rooms_path):
        raise HTTPException(404, "rooms not yet extracted")
    with open(rooms_path, "r", encoding="utf-8") as f:
        return json.load(f)


@router.put("/projects/{project_id}/rooms")
def update_rooms(project_id: str, payload: dict, user=Depends(get_current_user)):
    """Overwrite rooms JSON (user edits: rename, split, delete, re-draw)."""
    with db() as con:
        r = con.execute("SELECT * FROM projects WHERE id=? AND owner_id=?", (project_id, user["id"])).fetchone()
        if not r:
            raise HTTPException(404, "project not found")
    rooms_path = r["rooms_json_path"]
    if not rooms_path:
        rooms_path = os.path.join(project_dir(project_id), "rooms_from_image.json")
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
    import uuid as _uuid

    equipment_type = (payload or {}).get("equipment_type", "smoke") if payload else "smoke"
    # Validate
    ALLOWED_TYPES = {"smoke", "sprinkler", "fire_hose", "panel", "hooter", "mcb"}
    if equipment_type not in ALLOWED_TYPES:
        equipment_type = "smoke"

    with db() as con:
        r = con.execute("SELECT * FROM projects WHERE id=? AND owner_id=?", (project_id, user["id"])).fetchone()
        if not r:
            raise HTTPException(404, "project not found")

    rooms_path = r["rooms_json_path"]
    if not rooms_path or not os.path.exists(rooms_path):
        raise HTTPException(404, "rooms not yet extracted")

    mapping_path = r["mapping_json_path"]
    if not mapping_path or not os.path.exists(mapping_path):
        raise HTTPException(404, "mapping not available")

    pdir = project_dir(project_id)
    render_png = os.path.join(pdir, "render.png")

    with open(rooms_path, "r", encoding="utf-8") as f:
        rooms_data = json.load(f)
    rooms = rooms_data.get("rooms", rooms_data) if isinstance(rooms_data, dict) else rooms_data

    settings = json.loads(r["settings_json"] or "{}")
    opts = PipelineOptions.from_env().merge_settings(settings)

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
        r = con.execute("SELECT * FROM projects WHERE id=? AND owner_id=?", (project_id, user["id"])).fetchone()
        if not r:
            raise HTTPException(404, "project not found")
        if r["status"] in ("running",):
            raise HTTPException(409, "pipeline already running")
        if r["status"] not in ("awaiting_room_review", "rooms_extracted"):
            raise HTTPException(409, "project is not awaiting room review")

        con.execute("UPDATE projects SET status=?, error=NULL, updated_at=? WHERE id=?",
                    ("running", now(), project_id))

    with db() as con:
        r = con.execute("SELECT * FROM projects WHERE id=? AND owner_id=?", (project_id, user["id"])).fetchone()
        settings = json.loads(r["settings_json"] or "{}")

    opts = PipelineOptions.from_env().merge_settings(settings)
    bg.add_task(continue_pipeline_after_rooms, project_id, opts)

    with db() as con:
        r2 = con.execute("SELECT * FROM projects WHERE id=? AND owner_id=?", (project_id, user["id"])).fetchone()
    return _project_row_to_out(r2)

# ─────────────────────────────────────────────────────────────

@router.post("/projects/{project_id}/reset_detectors", response_model=ProjectOut)
def reset_detectors(project_id: str, user=Depends(get_current_user)):
    with db() as con:
        r = con.execute("SELECT * FROM projects WHERE id=? AND owner_id=?", (project_id, user["id"])).fetchone()
        if not r:
            raise HTTPException(404, "project not found")
        con.execute("DELETE FROM detectors WHERE project_id=?", (project_id,))
        con.execute("UPDATE projects SET updated_at=? WHERE id=?", (now(), project_id))
        r2 = con.execute("SELECT * FROM projects WHERE id=? AND owner_id=?", (project_id, user["id"])).fetchone()
    return _project_row_to_out(r2)

@router.post("/projects/{project_id}/save", response_model=ProjectOut)
def save_project_layout(project_id: str, user=Depends(get_current_user)):
    with db() as con:
        r = con.execute("SELECT * FROM projects WHERE id=? AND owner_id=?", (project_id, user["id"])).fetchone()
        if not r:
            raise HTTPException(404, "project not found")

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

        out_dxf = os.path.join(project_dir(project_id), "detectors_overlay.dxf")
        write_detectors_to_dxf(dxf_path, out_dxf, dets, symbol_radius_world=150.0, text_height_world=150.0)

        out_png = os.path.join(project_dir(project_id), "detectors_preview.png")
        out_map = os.path.join(project_dir(project_id), "detectors_preview_mapping.json")

        settings = json.loads(r["settings_json"] or "{}")
        opts = PipelineOptions.from_env().merge_settings(settings)

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
        r2 = con.execute("SELECT * FROM projects WHERE id=? AND owner_id=?", (project_id, user["id"])).fetchone()

    return _project_row_to_out(r2)
