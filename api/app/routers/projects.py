import os
import json
from fastapi import APIRouter, UploadFile, File, HTTPException, BackgroundTasks, Depends
from app.db import db, now
from app.storage import new_id, project_dir, relpath
from app.schemas import ProjectCreate, ProjectOut, ProjectUpdateSettings
from app.pipeline.run_pipeline import run_pipeline_for_project, continue_pipeline_after_alignment, PipelineOptions
from app.pipeline.dxf_export import write_detectors_to_dxf
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

    add("input", r["input_path"])
    add("dxf", r["dxf_path"])
    add("render_png", r["render_png_path"])
    add("mapping_json", r["mapping_json_path"])
    add("mask_png", r["mask_png_path"])
    add("aligned_mask", r["aligned_mask_path"])
    add("fixed_wall", r["fixed_wall_path"])
    add("rooms_json", r["rooms_json_path"])
    add("output_dxf", r["output_dxf_path"])
    add("output_preview_png", r["output_preview_png_path"])
    add("output_preview_mapping", preview_mapping_path if os.path.exists(preview_mapping_path) else None)

    return ProjectOut(
        id=r["id"],
        name=r["name"],
        status=r["status"],
        error=r["error"],
        files=files,
    )

@router.post("/projects", response_model=ProjectOut)
def create_project(payload: ProjectCreate, user=Depends(get_current_user)):
    pid = new_id()
    project_dir(pid)
    with db() as con:
        con.execute(
            """INSERT INTO projects
                (id,owner_id,name,status,created_at,updated_at,settings_json)
                VALUES (?,?,?,?,?,?,?)""",
            (pid, user["id"], payload.name, "created", now(), now(), json.dumps({})),
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

        con.execute(
            "UPDATE projects SET output_dxf_path=?, status=?, error=NULL, updated_at=? WHERE id=?",
            (out_dxf, "ready", now(), project_id),
        )
        r2 = con.execute("SELECT * FROM projects WHERE id=? AND owner_id=?", (project_id, user["id"])).fetchone()

    return _project_row_to_out(r2)
