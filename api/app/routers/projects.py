import os
import json
import shutil
from fastapi import APIRouter, UploadFile, File, HTTPException, BackgroundTasks
from app.db import db, now
from app.storage import new_id, project_dir, relpath
from app.schemas import ProjectCreate, ProjectOut, ProjectUpdateSettings
from app.pipeline.run_pipeline import run_pipeline_for_project, PipelineOptions

router = APIRouter(tags=["projects"])

def _project_row_to_out(r) -> ProjectOut:
    files = {}
    def add(k, p):
        files[k] = f"/files/{relpath(p)}" if p else None

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

    return ProjectOut(
        id=r["id"],
        name=r["name"],
        status=r["status"],
        error=r["error"],
        files=files,
    )

@router.post("/projects", response_model=ProjectOut)
def create_project(payload: ProjectCreate):
    pid = new_id()
    pdir = project_dir(pid)
    with db() as con:
        con.execute(
            """INSERT INTO projects
                (id,name,status,created_at,updated_at,settings_json)
                VALUES (?,?,?,?,?,?)""",
            (pid, payload.name, "created", now(), now(), json.dumps({})),
        )
        r = con.execute("SELECT * FROM projects WHERE id=?", (pid,)).fetchone()
    return _project_row_to_out(r)

@router.get("/projects/{project_id}", response_model=ProjectOut)
def get_project(project_id: str):
    with db() as con:
        r = con.execute("SELECT * FROM projects WHERE id=?", (project_id,)).fetchone()
        if not r:
            raise HTTPException(404, "project not found")
    return _project_row_to_out(r)

@router.post("/projects/{project_id}/settings", response_model=ProjectOut)
def update_settings(project_id: str, payload: ProjectUpdateSettings):
    with db() as con:
        r = con.execute("SELECT * FROM projects WHERE id=?", (project_id,)).fetchone()
        if not r:
            raise HTTPException(404, "project not found")
        con.execute("UPDATE projects SET settings_json=?, updated_at=? WHERE id=?",
                    (json.dumps(payload.settings), now(), project_id))
        r2 = con.execute("SELECT * FROM projects WHERE id=?", (project_id,)).fetchone()
    return _project_row_to_out(r2)

@router.post("/projects/{project_id}/upload", response_model=ProjectOut)
async def upload(project_id: str, file: UploadFile = File(...)):
    with db() as con:
        r = con.execute("SELECT * FROM projects WHERE id=?", (project_id,)).fetchone()
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
        r2 = con.execute("SELECT * FROM projects WHERE id=?", (project_id,)).fetchone()

    return _project_row_to_out(r2)

@router.post("/projects/{project_id}/run", response_model=ProjectOut)
def run_pipeline(project_id: str, bg: BackgroundTasks):
    # Run in background thread (simple MVP). For production use a real queue.
    with db() as con:
        r = con.execute("SELECT * FROM projects WHERE id=?", (project_id,)).fetchone()
        if not r:
            raise HTTPException(404, "project not found")
        if r["status"] in ("running",):
            raise HTTPException(409, "pipeline already running")
        con.execute("UPDATE projects SET status=?, error=NULL, updated_at=? WHERE id=?",
                    ("running", now(), project_id))

    # Load options from env + saved settings
    with db() as con:
        r = con.execute("SELECT * FROM projects WHERE id=?", (project_id,)).fetchone()
        settings = json.loads(r["settings_json"] or "{}")

    opts = PipelineOptions.from_env().merge_settings(settings)
    bg.add_task(run_pipeline_for_project, project_id, opts)

    with db() as con:
        r2 = con.execute("SELECT * FROM projects WHERE id=?", (project_id,)).fetchone()
    return _project_row_to_out(r2)

@router.post("/projects/{project_id}/reset_detectors", response_model=ProjectOut)
def reset_detectors(project_id: str):
    with db() as con:
        r = con.execute("SELECT * FROM projects WHERE id=?", (project_id,)).fetchone()
        if not r:
            raise HTTPException(404, "project not found")
        con.execute("DELETE FROM detectors WHERE project_id=?", (project_id,))
        con.execute("UPDATE projects SET updated_at=? WHERE id=?", (now(), project_id))
        r2 = con.execute("SELECT * FROM projects WHERE id=?", (project_id,)).fetchone()
    return _project_row_to_out(r2)
