import os
import re
import json
from fastapi import APIRouter, UploadFile, File, HTTPException, BackgroundTasks, Query
from fastapi.responses import FileResponse
from PIL import Image

from app.db import db, now
from app.storage import new_id, project_dir, relpath
from app.schemas import ProjectCreate, ProjectOut, ProjectUpdateSettings
from app.pipeline.run_pipeline import run_pipeline_for_project, PipelineOptions
from app.pipeline.dxf_export import write_detectors_to_dxf
from app.pipeline.convert import dxf_to_dwg, has_oda
from app.pipeline.render import render_dxf_to_png_and_mapping

router = APIRouter(tags=["projects"])

@router.get("/projects", response_model=list[ProjectOut])
def list_projects():
    with db() as con:
        rows = con.execute("SELECT * FROM projects ORDER BY updated_at DESC, created_at DESC").fetchall()
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
def create_project(payload: ProjectCreate):
    pid = new_id()
    project_dir(pid)
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

@router.post("/projects/{project_id}/save", response_model=ProjectOut)
def save_project_layout(project_id: str):
    with db() as con:
        r = con.execute("SELECT * FROM projects WHERE id=?", (project_id,)).fetchone()
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
        r2 = con.execute("SELECT * FROM projects WHERE id=?", (project_id,)).fetchone()

    return _project_row_to_out(r2)


def _safe_filename(name: str) -> str:
    name = (name or "project").strip()
    name = re.sub(r"[^a-zA-Z0-9._-]+", "_", name)
    name = name.strip("._-") or "project"
    return name[:80]


@router.get("/projects/{project_id}/download")
def download_project_file(
    project_id: str,
    format: str = Query("dxf", description="One of: dxf, dwg, png, pdf"),
    artifact: str = Query("output", description="One of: output, base, input"),
):
    """Download project artifacts with proper 'attachment' headers.

    Why this exists:
      - /files is served via StaticFiles (no Content-Disposition).
      - In the UI, the sidebar disappears when status==ready, so users lost access to the link.

    This endpoint makes downloads reliable across browsers and lets the UI offer DXF/DWG/PNG/PDF.
    """

    fmt = (format or "").strip().lower()
    art = (artifact or "").strip().lower()
    if fmt not in ("dxf", "dwg", "png", "pdf"):
        raise HTTPException(400, "format must be one of: dxf, dwg, png, pdf")
    if art not in ("output", "base", "input"):
        raise HTTPException(400, "artifact must be one of: output, base, input")

    with db() as con:
        r = con.execute("SELECT * FROM projects WHERE id=?", (project_id,)).fetchone()
        if not r:
            raise HTTPException(404, "project not found")

    project_name = _safe_filename(r["name"])
    pdir = project_dir(project_id)

    # Choose the underlying source paths
    base_dxf = r["dxf_path"]
    output_dxf = r["output_dxf_path"]
    output_png = r["output_preview_png_path"]
    render_png = r["render_png_path"]
    input_path = r["input_path"]

    if art == "input":
        if not input_path or not os.path.exists(input_path):
            raise HTTPException(404, "input file not available")
        # For input, we only support downloading the original file (dxf/dwg) as-is.
        ext = os.path.splitext(input_path)[1].lower().lstrip(".")
        if fmt in ("png", "pdf"):
            raise HTTPException(400, "For artifact=input, use the original DWG/DXF file.")
        if fmt == "dwg" and ext != "dwg":
            raise HTTPException(400, "Uploaded file is not DWG.")
        if fmt == "dxf" and ext != "dxf":
            raise HTTPException(400, "Uploaded file is not DXF.")
        path = input_path
        filename = f"{project_name}_input.{ext}"
        return FileResponse(path, media_type="application/octet-stream", filename=filename)

    if art == "base":
        if not base_dxf or not os.path.exists(base_dxf):
            raise HTTPException(404, "base DXF not available yet. Upload DWG/DXF and run the pipeline.")
        src_dxf = base_dxf
        src_png = render_png
        prefix = f"{project_name}_base"
    else:
        if not output_dxf or not os.path.exists(output_dxf):
            raise HTTPException(404, "output DXF not available yet. Run auto-placement (or click Save in editor).")
        src_dxf = output_dxf
        src_png = output_png
        prefix = f"{project_name}_detectors"

    # Ensure PNG exists if requested
    if fmt in ("png", "pdf"):
        if not src_png or not os.path.exists(src_png):
            # If we have DXF, we can render a quick preview.
            out_png = os.path.join(pdir, f"{prefix}.png")
            out_map = os.path.join(pdir, f"{prefix}_mapping.json")
            render_dxf_to_png_and_mapping(
                dxf_path=src_dxf,
                out_png=out_png,
                out_json=out_map,
                target_long_side_px=8000,
                dpi=200,
                pad_frac=0.05,
            )
            src_png = out_png

    if fmt == "dxf":
        filename = f"{prefix}.dxf"
        return FileResponse(src_dxf, media_type="application/octet-stream", filename=filename)

    if fmt == "dwg":
        if not has_oda():
            raise HTTPException(400, "DWG export requires ODA_PATH on the server. Set ODA_PATH or download DXF instead.")
        out_dir = os.path.join(pdir, "exports")
        os.makedirs(out_dir, exist_ok=True)
        out_dwg = os.path.join(out_dir, f"{prefix}.dwg")
        if not os.path.exists(out_dwg) or os.path.getmtime(out_dwg) < os.path.getmtime(src_dxf):
            produced = dxf_to_dwg(src_dxf, out_dir)
            # Normalize name for repeatability.
            try:
                import shutil
                shutil.copy2(produced, out_dwg)
            except Exception:
                out_dwg = produced
        return FileResponse(out_dwg, media_type="application/octet-stream", filename=f"{prefix}.dwg")

    if fmt == "png":
        return FileResponse(src_png, media_type="application/octet-stream", filename=f"{prefix}.png")

    # pdf
    out_dir = os.path.join(pdir, "exports")
    os.makedirs(out_dir, exist_ok=True)
    out_pdf = os.path.join(out_dir, f"{prefix}.pdf")
    if not os.path.exists(out_pdf) or os.path.getmtime(out_pdf) < os.path.getmtime(src_png):
        Image.MAX_IMAGE_PIXELS = None
        with Image.open(src_png) as im:
            if im.mode != "RGB":
                im = im.convert("RGB")
            im.save(out_pdf, "PDF", resolution=300.0)
    return FileResponse(out_pdf, media_type="application/octet-stream", filename=f"{prefix}.pdf")
