import os
import json
import traceback
from dataclasses import dataclass
from typing import Optional

from app.db import db, now
from app.storage import project_dir, relpath
from app.pipeline.options import PipelineOptions
from app.pipeline.convert import dwg_to_dxf
from app.pipeline.render import render_dxf_to_png_and_mapping
from app.pipeline.gemini_mask import generate_mask_image
from app.pipeline.mask_align import align_perfect_tight_box
from app.pipeline.wall_fix import fix_walls
from app.pipeline.rooms_from_image import extract_rooms
from app.pipeline.dxf_export import write_detectors_to_dxf
from app.pipeline.place_detectors_advanced import place_detectors_from_rooms_json

# NOTE:
# This uses your notebook flow. For production, split into a proper job queue.

def _set_project(con, project_id: str, **fields):
    cols = []
    vals = []
    for k,v in fields.items():
        cols.append(f"{k}=?")
        vals.append(v)
    cols.append("updated_at=?")
    vals.append(now())
    vals.append(project_id)
    con.execute(f"UPDATE projects SET {', '.join(cols)} WHERE id=?", vals)

def _get_project(con, project_id: str):
    return con.execute("SELECT * FROM projects WHERE id=?", (project_id,)).fetchone()

def _list_detectors(con, project_id: str):
    return con.execute("SELECT * FROM detectors WHERE project_id=? ORDER BY created_at ASC", (project_id,)).fetchall()

def _replace_detectors(con, project_id: str, dets: list[dict]):
    con.execute("DELETE FROM detectors WHERE project_id=?", (project_id,))
    for d in dets:
        con.execute(
            """INSERT INTO detectors (id,project_id,x,y,z,dtype,locked,created_at,updated_at)
                 VALUES (?,?,?,?,?,?,?,?,?)""",
            (d["id"], project_id, float(d["x"]), float(d["y"]), float(d.get("z",0.0)), d.get("dtype","smoke"),
             int(d.get("locked",0)), now(), now())
        )

def _centroid(poly_world: list[list[float]]):
    # simple polygon centroid
    xs = [p[0] for p in poly_world]; ys = [p[1] for p in poly_world]
    return (sum(xs)/len(xs), sum(ys)/len(ys))

def run_pipeline_for_project(project_id: str, opts: PipelineOptions):
    try:
        with db() as con:
            p = _get_project(con, project_id)
            if not p:
                return
            in_path = p["input_path"]
            if not in_path or not os.path.exists(in_path):
                _set_project(con, project_id, status="failed", error="No input file uploaded.")
                return

        pdir = project_dir(project_id)

        # 1) Ensure DXF exists
        ext = os.path.splitext(in_path.lower())[1]
        if ext == ".dxf":
            dxf_path = os.path.join(pdir, "input.dxf")
            if in_path != dxf_path:
                import shutil
                shutil.copy2(in_path, dxf_path)
        else:
            dxf_path = dwg_to_dxf(in_path, pdir)

        # 2) Render DXF -> PNG + mapping.json
        render_png = os.path.join(pdir, "render.png")
        mapping_json = os.path.join(pdir, "mapping.json")
        render_dxf_to_png_and_mapping(
            dxf_path=dxf_path,
            out_png=render_png,
            out_json=mapping_json,
            target_long_side_px=opts.target_long_side_px,
            dpi=opts.dpi,
            pad_frac=opts.pad_frac,
        )

        # Save project pointers
        with db() as con:
            _set_project(con, project_id,
                         status="rendered",
                         dxf_path=dxf_path,
                         render_png_path=render_png,
                         mapping_json_path=mapping_json)

        # 3) Gemini mask (optional)
        mask_png = os.path.join(pdir, "mask_generated.png")
        if opts.use_gemini:
            generate_mask_image(
                input_png=render_png,
                out_mask_png=mask_png,
                model=opts.gemini_model,
            )
        else:
            # If no Gemini key, we stop here (manual editing still works).
            with db() as con:
                _set_project(con, project_id, status="ready_no_mask",
                             error="GEMINI_API_KEY not set; skipping auto-mask/rooms. You can still edit detectors manually.")
            return

        with db() as con:
            _set_project(con, project_id, mask_png_path=mask_png, status="masked")

        # 4) Align mask to render
        aligned = os.path.join(pdir, "mask_aligned.png")
        align_perfect_tight_box(render_png, mask_png, aligned,
                                overlay_debug=os.path.join(pdir, "alignment_overlay.jpg"),
                                boxes_debug=os.path.join(pdir, "alignment_boxes.jpg"))
        with db() as con:
            _set_project(con, project_id, aligned_mask_path=aligned, status="aligned")

        # 5) Fix/solidify walls
        fixed = os.path.join(pdir, "ultimate_fixed_wall.png")
        fix_walls(aligned, fixed, thickness=2)
        with db() as con:
            _set_project(con, project_id, fixed_wall_path=fixed, status="walls_fixed")

        # 6) Extract rooms
        rooms_json = os.path.join(pdir, "rooms_from_image.json")
        debug_rooms = os.path.join(pdir, "rooms_debug.png")
        rooms = extract_rooms(fixed, mapping_json, rooms_json, debug_png_path=debug_rooms)
        with db() as con:
            _set_project(con, project_id, rooms_json_path=rooms_json, status="rooms_extracted")

        # 7) Autoplace detectors (MVP centroid-based; plug your advanced logic here)
        placed, _regions = place_detectors_from_rooms_json(rooms, opts.detector_spacing_m, opts.wall_buffer_m, opts.world_to_m)
        import uuid
        dets = [{"id": str(uuid.uuid4())[:8], "x": x, "y": y, "z": 0.0, "dtype": "smoke", "locked": 0} for (x,y) in placed]
        with db() as con:
            _replace_detectors(con, project_id, dets)

        # 8) Export DXF with detectors
        out_dxf = os.path.join(pdir, "detectors_overlay.dxf")
        write_detectors_to_dxf(dxf_path, out_dxf, dets, symbol_radius_world=150.0, text_height_world=150.0)

        # 9) Render output preview PNG
        out_png = os.path.join(pdir, "detectors_preview.png")
        out_map = os.path.join(pdir, "detectors_preview_mapping.json")
        render_dxf_to_png_and_mapping(
            dxf_path=out_dxf,
            out_png=out_png,
            out_json=out_map,
            target_long_side_px=min(opts.target_long_side_px, 8000),
            dpi=opts.dpi,
            pad_frac=opts.pad_frac,
        )

        with db() as con:
            _set_project(con, project_id,
                         status="ready",
                         output_dxf_path=out_dxf,
                         output_preview_png_path=out_png,
                         error=None)

    except Exception as e:
        err = f"{e}\n\n{traceback.format_exc()}"
        with db() as con:
            _set_project(con, project_id, status="failed", error=err)
