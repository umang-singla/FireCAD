import os
import traceback
import time
import logging

from app.db import db, now
from app.storage import project_dir
from app.pipeline.options import PipelineOptions
from app.pipeline.convert import dwg_to_dxf
from app.pipeline.render import (
    render_dxf_to_png_and_mapping,
    render_dwg_to_png_with_qcad,
    write_mapping_from_dxf_and_png,
)
from app.pipeline.gemini_mask import generate_mask_image
from app.pipeline.mask_align import align_perfect_tight_box
from app.pipeline.wall_fix import fix_walls
from app.pipeline.rooms_from_image import extract_rooms
from app.pipeline.dxf_export import write_detectors_to_dxf
from app.pipeline.place_detectors_advanced import place_detectors_from_rooms_json

logger = logging.getLogger("firecad.pipeline")

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
    start_ts = time.perf_counter()

    def stage_start(name: str):
        logger.info("pipeline project=%s stage=%s status=start", project_id, name)

    def stage_done(name: str, stage_ts: float, **extra):
        suffix = " ".join(f"{k}={v}" for k, v in extra.items())
        if suffix:
            suffix = f" {suffix}"
        logger.info(
            "pipeline project=%s stage=%s status=done elapsed=%.2fs%s",
            project_id,
            name,
            time.perf_counter() - stage_ts,
            suffix,
        )

    logger.info("pipeline project=%s status=start", project_id)
    try:
        stage_ts = time.perf_counter()
        stage_start("validate_input")
        with db() as con:
            p = _get_project(con, project_id)
            if not p:
                logger.warning("pipeline project=%s status=aborted reason=project_not_found", project_id)
                return
            in_path = p["input_path"]
            if not in_path or not os.path.exists(in_path):
                _set_project(con, project_id, status="failed", error="No input file uploaded.")
                logger.error("pipeline project=%s status=failed reason=no_input_file", project_id)
                return
        stage_done("validate_input", stage_ts, input=in_path)

        pdir = project_dir(project_id)

        # 1) Ensure DXF exists
        stage_ts = time.perf_counter()
        stage_start("ensure_dxf")
        ext = os.path.splitext(in_path.lower())[1]
        if ext == ".dxf":
            dxf_path = os.path.join(pdir, "input.dxf")
            if in_path != dxf_path:
                import shutil
                shutil.copy2(in_path, dxf_path)
        else:
            dxf_path = dwg_to_dxf(in_path, pdir)
        stage_done("ensure_dxf", stage_ts, ext=ext, dxf=dxf_path)

        # 2) Render DXF -> PNG + mapping.json
        stage_ts = time.perf_counter()
        stage_start("render_input")
        render_png = os.path.join(pdir, "render.png")
        mapping_json = os.path.join(pdir, "mapping.json")
        used_qcad = False
        if ext == ".dwg" and os.getenv("USE_QCAD_DWG2BMP", "1").strip().lower() not in ("0", "false", "no"):
            try:
                render_dwg_to_png_with_qcad(
                    dwg_path=in_path,
                    out_png=render_png,
                    background="white",
                )
                write_mapping_from_dxf_and_png(
                    dxf_path=dxf_path,
                    png_path=render_png,
                    out_json=mapping_json,
                    pad_frac=opts.pad_frac,
                )
                used_qcad = True
            except Exception:
                logger.exception("pipeline project=%s stage=render_input renderer=qcad status=failed fallback=ezdxf", project_id)

        if not used_qcad:
            render_dxf_to_png_and_mapping(
                dxf_path=dxf_path,
                out_png=render_png,
                out_json=mapping_json,
                target_long_side_px=opts.target_long_side_px,
                dpi=opts.dpi,
                pad_frac=opts.pad_frac,
            )

        stage_done(
            "render_input",
            stage_ts,
            render=render_png,
            mapping=mapping_json,
            renderer=("qcad" if used_qcad else "ezdxf"),
        )

        # Save project pointers
        with db() as con:
            _set_project(con, project_id,
                         status="rendered",
                         dxf_path=dxf_path,
                         render_png_path=render_png,
                         mapping_json_path=mapping_json)

        # 3) Gemini mask (optional)
        stage_ts = time.perf_counter()
        stage_start("gemini_mask")
        mask_png = os.path.join(pdir, "mask_generated.png")
        if opts.use_gemini:
            generate_mask_image(
                input_png=render_png,
                out_mask_png=mask_png,
                model=opts.gemini_model,
            )
            stage_done("gemini_mask", stage_ts, model=opts.gemini_model, mask=mask_png)
        else:
            # If no Gemini key, we stop here (manual editing still works).
            with db() as con:
                _set_project(con, project_id, status="ready_no_mask",
                             error="GEMINI_API_KEY not set; skipping auto-mask/rooms. You can still edit detectors manually.")
            logger.warning("pipeline project=%s status=ready_no_mask reason=gemini_key_missing", project_id)
            return

        with db() as con:
            _set_project(con, project_id, mask_png_path=mask_png, status="masked")

        # 4) Align mask to render
        stage_ts = time.perf_counter()
        stage_start("align_mask")
        aligned = os.path.join(pdir, "mask_aligned.png")
        align_perfect_tight_box(render_png, mask_png, aligned,
                                overlay_debug=os.path.join(pdir, "alignment_overlay.jpg"),
                                boxes_debug=os.path.join(pdir, "alignment_boxes.jpg"))
        stage_done("align_mask", stage_ts, aligned=aligned)
        with db() as con:
            _set_project(con, project_id, aligned_mask_path=aligned, status="aligned")

        # 5) Fix/solidify walls
        stage_ts = time.perf_counter()
        stage_start("fix_walls")
        fixed = os.path.join(pdir, "ultimate_fixed_wall.png")
        fix_walls(aligned, fixed, thickness=2)
        stage_done("fix_walls", stage_ts, fixed=fixed)
        with db() as con:
            _set_project(con, project_id, fixed_wall_path=fixed, status="walls_fixed")

        # 6) Extract rooms
        stage_ts = time.perf_counter()
        stage_start("extract_rooms")
        rooms_json = os.path.join(pdir, "rooms_from_image.json")
        debug_rooms = os.path.join(pdir, "rooms_debug.png")
        rooms = extract_rooms(fixed, mapping_json, rooms_json, debug_png_path=debug_rooms)
        stage_done("extract_rooms", stage_ts, rooms=len(rooms), rooms_json=rooms_json)
        with db() as con:
            _set_project(con, project_id, rooms_json_path=rooms_json, status="rooms_extracted")

        # 7) Autoplace detectors (MVP centroid-based; plug your advanced logic here)
        stage_ts = time.perf_counter()
        stage_start("place_detectors")
        placed, _regions = place_detectors_from_rooms_json(rooms, opts.detector_spacing_m, opts.wall_buffer_m, opts.world_to_m)
        import uuid
        dets = [{"id": str(uuid.uuid4())[:8], "x": x, "y": y, "z": 0.0, "dtype": "smoke", "locked": 0} for (x,y) in placed]
        with db() as con:
            _replace_detectors(con, project_id, dets)
        stage_done("place_detectors", stage_ts, detectors=len(dets))

        # 8) Export DXF with detectors
        stage_ts = time.perf_counter()
        stage_start("export_dxf")
        out_dxf = os.path.join(pdir, "detectors_overlay.dxf")
        write_detectors_to_dxf(dxf_path, out_dxf, dets, symbol_radius_world=150.0, text_height_world=150.0)
        stage_done("export_dxf", stage_ts, out_dxf=out_dxf)

        # 9) Render output preview PNG
        stage_ts = time.perf_counter()
        stage_start("render_output_preview")
        out_png = os.path.join(pdir, "detectors_preview.png")
        out_map = os.path.join(pdir, "detectors_preview_mapping.json")
        used_qcad_preview = False
        if os.getenv("USE_QCAD_DWG2BMP", "1").strip().lower() not in ("0", "false", "no"):
            try:
                render_dwg_to_png_with_qcad(
                    dwg_path=out_dxf,
                    out_png=out_png,
                    background="white",
                )
                write_mapping_from_dxf_and_png(
                    dxf_path=out_dxf,
                    png_path=out_png,
                    out_json=out_map,
                    pad_frac=opts.pad_frac,
                )
                used_qcad_preview = True
            except Exception:
                logger.exception("pipeline project=%s stage=render_output_preview renderer=qcad status=failed fallback=ezdxf", project_id)

        if not used_qcad_preview:
            render_dxf_to_png_and_mapping(
                dxf_path=out_dxf,
                out_png=out_png,
                out_json=out_map,
                target_long_side_px=min(opts.target_long_side_px, 8000),
                dpi=opts.dpi,
                pad_frac=opts.pad_frac,
            )

        stage_done("render_output_preview", stage_ts, out_png=out_png, renderer=("qcad" if used_qcad_preview else "ezdxf"))

        with db() as con:
            _set_project(con, project_id,
                         status="ready",
                         output_dxf_path=out_dxf,
                         output_preview_png_path=out_png,
                         error=None)
        logger.info(
            "pipeline project=%s status=ready total_elapsed=%.2fs",
            project_id,
            time.perf_counter() - start_ts,
        )

    except Exception as e:
        err = f"{e}\n\n{traceback.format_exc()}"
        logger.exception("pipeline project=%s status=failed", project_id)
        with db() as con:
            _set_project(con, project_id, status="failed", error=err)
