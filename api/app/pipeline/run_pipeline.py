import os
import traceback
import time
import logging

from app.db import db, now
from app.storage import project_dir
from app.pipeline.options import PipelineOptions
from app.pipeline.convert import dwg_to_dxf
from app.pipeline.render import (
    render_dwg_to_png_with_qcad,
    write_mapping_from_dxf_and_png,
)
from app.pipeline.gemini_mask import generate_mask_image
from app.pipeline.mask_align import align_perfect_tight_box
from app.pipeline.wall_fix import fix_walls
from app.pipeline.rooms_from_image import extract_rooms
from app.pipeline.dxf_export import write_detectors_to_dxf
from app.pipeline.place_detectors_advanced import place_detectors_from_rooms_json
from app.ws_manager import manager as ws_manager

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

    # Broadcast status change over WebSocket if status was updated
    if "status" in fields:
        ws_data: dict = {"type": "status", "status": fields["status"]}
        if "error" in fields:
            ws_data["error"] = fields["error"]
        ws_manager.broadcast_sync(project_id, ws_data)

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

def _run_post_alignment_steps(
    project_id: str,
    opts: PipelineOptions,
    pdir: str,
    dxf_path: str,
    mapping_json: str,
    aligned_mask_path: str,
    stage_start,
    stage_done,
):
    # 5) Fix/solidify walls
    stage_ts = time.perf_counter()
    stage_start("fix_walls")
    fixed = os.path.join(pdir, "ultimate_fixed_wall.png")
    fix_walls(aligned_mask_path, fixed, thickness=2)
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

    # ── Pause for user room review ──
    with db() as con:
        _set_project(con, project_id, status="awaiting_room_review", error=None)
    logger.info(
        "pipeline project=%s status=awaiting_room_review rooms=%d",
        project_id,
        len(rooms),
    )
    # Pipeline stops here.  Resumed by continue_pipeline_after_rooms().


def _run_post_room_review_steps(
    project_id: str,
    opts: PipelineOptions,
    pdir: str,
    dxf_path: str,
    mapping_json: str,
    stage_start,
    stage_done,
):
    """Stages 7-9: place detectors, export DXF, render output preview."""
    # Load the (possibly user-edited) rooms JSON
    rooms_json_path = os.path.join(pdir, "rooms_from_image.json")
    import json as _json
    with open(rooms_json_path, "r", encoding="utf-8") as f:
        rooms_data = _json.load(f)
    rooms = rooms_data.get("rooms", rooms_data) if isinstance(rooms_data, dict) else rooms_data

    # 7) Autoplace detectors
    stage_ts = time.perf_counter()
    stage_start("place_detectors")
    detectors_debug_png = os.path.join(pdir, "detectors_global_snapping_debug.png")
    detectors_overlay_debug_png = os.path.join(pdir, "detectors_global_snapping_overlay.png")
    placed, _regions = place_detectors_from_rooms_json(
        rooms,
        opts.detector_spacing_m,
        opts.wall_buffer_m,
        opts.world_to_m,
        debug_png_path=detectors_debug_png,
        debug_overlay_png_path=detectors_overlay_debug_png,
        mapping_json_path=mapping_json,
        base_png_path=os.path.join(pdir, "render.png"),
    )
    import uuid
    dets = [{"id": str(uuid.uuid4())[:8], "x": x, "y": y, "z": 0.0, "dtype": "smoke", "locked": 0} for (x,y) in placed]
    with db() as con:
        _replace_detectors(con, project_id, dets)
    stage_done(
        "place_detectors",
        stage_ts,
        detectors=len(dets),
        debug=detectors_debug_png,
        overlay=detectors_overlay_debug_png,
    )

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

    stage_done("render_output_preview", stage_ts, out_png=out_png, renderer="qcad")

    with db() as con:
        _set_project(con, project_id,
                     status="ready",
                     output_dxf_path=out_dxf,
                     output_preview_png_path=out_png,
                     error=None)

def run_pipeline_for_project(project_id: str, opts: PipelineOptions):
    start_ts = time.perf_counter()

    def stage_start(name: str):
        logger.info("pipeline project=%s stage=%s status=start", project_id, name)
        ws_manager.broadcast_sync(project_id, {"type": "stage", "stage": name, "event": "start"})

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
        ws_manager.broadcast_sync(project_id, {
            "type": "stage",
            "stage": name,
            "event": "done",
            "elapsed": round(time.perf_counter() - stage_ts, 2),
        })

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
        render_dwg_to_png_with_qcad(
            dwg_path=dxf_path,
            out_png=render_png,
            target_long_side_px=opts.target_long_side_px,
            background="white",
        )
        write_mapping_from_dxf_and_png(
            dxf_path=dxf_path,
            png_path=render_png,
            out_json=mapping_json,
            pad_frac=opts.pad_frac,
        )

        stage_done(
            "render_input",
            stage_ts,
            render=render_png,
            mapping=mapping_json,
            renderer="qcad",
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

        with db() as con:
            _set_project(con, project_id, status="awaiting_alignment_review", error=None)
        logger.info(
            "pipeline project=%s status=awaiting_alignment_review total_elapsed=%.2fs",
            project_id,
            time.perf_counter() - start_ts,
        )

    except Exception as e:
        err = f"{e}\n\n{traceback.format_exc()}"
        logger.exception("pipeline project=%s status=failed", project_id)
        with db() as con:
            _set_project(con, project_id, status="failed", error=err)

def continue_pipeline_after_alignment(project_id: str, opts: PipelineOptions):
    start_ts = time.perf_counter()

    def stage_start(name: str):
        logger.info("pipeline-continue project=%s stage=%s status=start", project_id, name)
        ws_manager.broadcast_sync(project_id, {"type": "stage", "stage": name, "event": "start"})

    def stage_done(name: str, stage_ts: float, **extra):
        suffix = " ".join(f"{k}={v}" for k, v in extra.items())
        if suffix:
            suffix = f" {suffix}"
        logger.info(
            "pipeline-continue project=%s stage=%s status=done elapsed=%.2fs%s",
            project_id,
            name,
            time.perf_counter() - stage_ts,
            suffix,
        )
        ws_manager.broadcast_sync(project_id, {
            "type": "stage",
            "stage": name,
            "event": "done",
            "elapsed": round(time.perf_counter() - stage_ts, 2),
        })

    logger.info("pipeline-continue project=%s status=start", project_id)
    try:
        with db() as con:
            p = _get_project(con, project_id)
            if not p:
                logger.warning("pipeline-continue project=%s status=aborted reason=project_not_found", project_id)
                return

            dxf_path = p["dxf_path"]
            mapping_json = p["mapping_json_path"]
            aligned = p["aligned_mask_path"]

            if not dxf_path or not os.path.exists(dxf_path):
                _set_project(con, project_id, status="failed", error="Base DXF not found for continue flow.")
                logger.error("pipeline-continue project=%s status=failed reason=missing_dxf", project_id)
                return
            if not mapping_json or not os.path.exists(mapping_json):
                _set_project(con, project_id, status="failed", error="Mapping JSON not found for continue flow.")
                logger.error("pipeline-continue project=%s status=failed reason=missing_mapping", project_id)
                return
            if not aligned or not os.path.exists(aligned):
                _set_project(con, project_id, status="failed", error="Aligned mask not found. Upload/alignment review required.")
                logger.error("pipeline-continue project=%s status=failed reason=missing_aligned_mask", project_id)
                return

        pdir = project_dir(project_id)
        _run_post_alignment_steps(
            project_id=project_id,
            opts=opts,
            pdir=pdir,
            dxf_path=dxf_path,
            mapping_json=mapping_json,
            aligned_mask_path=aligned,
            stage_start=stage_start,
            stage_done=stage_done,
        )

        logger.info(
            "pipeline-continue project=%s status=awaiting_room_review total_elapsed=%.2fs",
            project_id,
            time.perf_counter() - start_ts,
        )
    except Exception as e:
        err = f"{e}\n\n{traceback.format_exc()}"
        logger.exception("pipeline-continue project=%s status=failed", project_id)
        with db() as con:
            _set_project(con, project_id, status="failed", error=err)


def continue_pipeline_after_rooms(project_id: str, opts: PipelineOptions):
    """Resume pipeline after user has reviewed / edited rooms."""
    start_ts = time.perf_counter()

    def stage_start(name: str):
        logger.info("pipeline-rooms project=%s stage=%s status=start", project_id, name)
        ws_manager.broadcast_sync(project_id, {"type": "stage", "stage": name, "event": "start"})

    def stage_done(name: str, stage_ts: float, **extra):
        suffix = " ".join(f"{k}={v}" for k, v in extra.items())
        if suffix:
            suffix = f" {suffix}"
        logger.info(
            "pipeline-rooms project=%s stage=%s status=done elapsed=%.2fs%s",
            project_id,
            name,
            time.perf_counter() - stage_ts,
            suffix,
        )
        ws_manager.broadcast_sync(project_id, {
            "type": "stage",
            "stage": name,
            "event": "done",
            "elapsed": round(time.perf_counter() - stage_ts, 2),
        })

    logger.info("pipeline-rooms project=%s status=start", project_id)
    try:
        with db() as con:
            p = _get_project(con, project_id)
            if not p:
                logger.warning("pipeline-rooms project=%s status=aborted reason=project_not_found", project_id)
                return

            dxf_path = p["dxf_path"]
            mapping_json = p["mapping_json_path"]

            if not dxf_path or not os.path.exists(dxf_path):
                _set_project(con, project_id, status="failed", error="Base DXF not found for room-continue flow.")
                return
            if not mapping_json or not os.path.exists(mapping_json):
                _set_project(con, project_id, status="failed", error="Mapping JSON not found for room-continue flow.")
                return

        pdir = project_dir(project_id)
        _run_post_room_review_steps(
            project_id=project_id,
            opts=opts,
            pdir=pdir,
            dxf_path=dxf_path,
            mapping_json=mapping_json,
            stage_start=stage_start,
            stage_done=stage_done,
        )

        logger.info(
            "pipeline-rooms project=%s status=ready total_elapsed=%.2fs",
            project_id,
            time.perf_counter() - start_ts,
        )
    except Exception as e:
        err = f"{e}\n\n{traceback.format_exc()}"
        logger.exception("pipeline-rooms project=%s status=failed", project_id)
        with db() as con:
            _set_project(con, project_id, status="failed", error=err)
