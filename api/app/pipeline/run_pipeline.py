import os
import re
import traceback
import time
import logging
import uuid
import json as _json
import cv2

from app.db import db, now
from app.storage import project_dir
from app.pipeline.options import PipelineOptions
from app.pipeline.convert import dwg_to_dxf
from app.pipeline.gemini_mask import generate_mask_image
from app.pipeline.mask_align import align_perfect_tight_box
from app.pipeline.wall_fix import fix_walls
from app.pipeline.rooms_from_image import extract_rooms
from app.pipeline.dxf_export import write_detectors_to_dxf, write_combined_sheets_dxf
from app.pipeline.place_detectors_advanced import place_detectors_from_rooms_json
from app.pipeline.dxf_text_filter import filter_rooms_by_dxf_text
from app.pipeline.sprinkler_routing import (
    place_sprinklers_from_rooms_json,
    write_sprinklers_to_dxf,
)
from app.pipeline.mcp_hooter_placement import place_mcp_hooter_from_rooms_payload
from app.ws_manager import manager as ws_manager

logger = logging.getLogger("mepit.pipeline")

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

# ── Floor-plan helpers ──

def _insert_floor_plan(con, fp: dict):
    con.execute(
        """INSERT INTO floor_plans
            (id, project_id, block_index, world_bbox_json, pixel_bbox_json,
             render_png_path, mapping_json_path, status, created_at, updated_at)
            VALUES (?,?,?,?,?,?,?,?,?,?)""",
        (
            fp["id"], fp["project_id"], fp["block_index"],
            _json.dumps(fp["world_bbox"]),
            _json.dumps(fp["pixel_bbox"]),
            fp["render_png"], fp["mapping_json"],
            "created", now(), now(),
        ),
    )

def _set_floor_plan(con, fp_id: str, **fields):
    cols = [f"{k}=?" for k in fields]
    vals = list(fields.values())
    cols.append("updated_at=?"); vals.append(now()); vals.append(fp_id)
    con.execute(f"UPDATE floor_plans SET {', '.join(cols)} WHERE id=?", vals)

def _get_floor_plans(con, project_id: str):
    return con.execute(
        "SELECT * FROM floor_plans WHERE project_id=? ORDER BY block_index ASC",
        (project_id,),
    ).fetchall()


def _cleanup_orphan_block_artifacts(project_id: str, valid_block_indices: set[int]):
    """Remove stale block files not tied to current floor-plan rows.

    This prevents old block_* artifacts from previous runs from being mistaken
    as current inputs/outputs in debugging and review flows.
    """
    pdir = project_dir(project_id)
    blocks_dir = os.path.join(pdir, "blocks")
    if not os.path.isdir(blocks_dir):
        return

    block_file_re = re.compile(r"^block_(\d+)(?:_.+)?\.(?:png|jpg|jpeg|json)$", re.IGNORECASE)
    for name in os.listdir(blocks_dir):
        m = block_file_re.match(name)
        if not m:
            continue
        idx = int(m.group(1))
        if idx in valid_block_indices:
            continue
        path = os.path.join(blocks_dir, name)
        try:
            if os.path.isfile(path):
                os.remove(path)
        except OSError:
            logger.warning("cleanup project=%s skipped file=%s", project_id, path)


def _build_block_mapping_from_world_bbox(
    *,
    world_bbox: dict,
    width_px: int,
    height_px: int,
) -> dict:
    """Create a mapping payload matching the renderer's contain-fit behavior."""
    xmin = float(world_bbox["xmin"])
    xmax = float(world_bbox["xmax"])
    ymin = float(world_bbox["ymin"])
    ymax = float(world_bbox["ymax"])

    span_x = max(1e-9, xmax - xmin)
    span_y = max(1e-9, ymax - ymin)
    wpx = max(1, int(width_px))
    hpx = max(1, int(height_px))

    scale = min(wpx / span_x, hpx / span_y)
    draw_w = span_x * scale
    draw_h = span_y * scale
    offset_x = (wpx - draw_w) * 0.5
    offset_y = (hpx - draw_h) * 0.5

    return {
        "width_px": wpx,
        "height_px": hpx,
        "world_bbox": {
            "xmin": xmin,
            "xmax": xmax,
            "ymin": ymin,
            "ymax": ymax,
        },
        "pixel_fit": {
            "mode": "contain",
            "scale": float(scale),
            "offset_x": float(offset_x),
            "offset_y": float(offset_y),
        },
    }

    for name in os.listdir(pdir):
        m = re.match(r"^sprinkler_pipes_(\d+)\.json$", name)
        if not m:
            continue
        idx = int(m.group(1))
        if idx in valid_block_indices:
            continue
        path = os.path.join(pdir, name)
        try:
            if os.path.isfile(path):
                os.remove(path)
        except OSError:
            logger.warning("cleanup project=%s skipped file=%s", project_id, path)

def _replace_detectors(con, project_id: str, dets: list[dict], floor_plan_id: str = None):
    if floor_plan_id:
        con.execute("DELETE FROM detectors WHERE project_id=? AND floor_plan_id=?", (project_id, floor_plan_id))
    else:
        con.execute("DELETE FROM detectors WHERE project_id=?", (project_id,))
    for d in dets:
        con.execute(
            """INSERT INTO detectors (id,project_id,x,y,z,dtype,locked,floor_plan_id,created_at,updated_at)
                 VALUES (?,?,?,?,?,?,?,?,?,?)""",
            (d["id"], project_id, float(d["x"]), float(d["y"]), float(d.get("z",0.0)), d.get("dtype","smoke"),
             int(d.get("locked",0)), d.get("floor_plan_id", floor_plan_id), now(), now())
        )

def _replace_detectors_of_types(
    con,
    project_id: str,
    dets: list[dict],
    dtypes: list[str],
    floor_plan_id: str | None = None,
):
    if not dtypes:
        return
    placeholders = ",".join(["?"] * len(dtypes))
    args = [project_id]
    where = "project_id=?"
    if floor_plan_id:
        where += " AND floor_plan_id=?"
        args.append(floor_plan_id)
    where += f" AND dtype IN ({placeholders})"
    args.extend(dtypes)
    con.execute(f"DELETE FROM detectors WHERE {where}", args)

    for d in dets:
        con.execute(
            """INSERT INTO detectors (id,project_id,x,y,z,dtype,locked,floor_plan_id,created_at,updated_at)
                 VALUES (?,?,?,?,?,?,?,?,?,?)""",
            (
                d["id"], project_id, float(d["x"]), float(d["y"]), float(d.get("z", 0.0)),
                d.get("dtype", "smoke"), int(d.get("locked", 0)), d.get("floor_plan_id", floor_plan_id),
                now(), now(),
            ),
        )


def _to_mcp_hooter_detectors(
    station_points: list[tuple[float, float]],
    world_to_m: float,
    floor_plan_id: str | None = None,
) -> list[dict]:
    out: list[dict] = []
    # Keep MCP/Hooter as a compact left/right pair around each station.
    offset = 0.45 / max(float(world_to_m), 1e-9)
    for x, y in station_points:
        half = offset * 0.5
        out.append({
            "id": str(uuid.uuid4())[:8],
            "x": float(x - half),
            "y": float(y),
            "z": 0.0,
            "dtype": "mcb",
            "locked": 0,
            "floor_plan_id": floor_plan_id,
        })
        out.append({
            "id": str(uuid.uuid4())[:8],
            "x": float(x + half),
            "y": float(y),
            "z": 0.0,
            "dtype": "hooter",
            "locked": 0,
            "floor_plan_id": floor_plan_id,
        })
    return out

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
    """Process walls + rooms for a SINGLE floor plan image (legacy path or
    single-block fallback).  Also used internally per-block."""
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
    rooms = extract_rooms(
        fixed,
        mapping_json,
        rooms_json,
        debug_png_path=debug_rooms,
        dxf_path=dxf_path,
    )
    stage_done("extract_rooms", stage_ts, rooms=len(rooms), rooms_json=rooms_json)
    with db() as con:
        _set_project(con, project_id, rooms_json_path=rooms_json, status="rooms_extracted")

    # 6.5) Place MCP + Hooter stations before room confirmation stage.
    stage_ts = time.perf_counter()
    stage_start("place_mcp_hooter")
    placed_mcp_hooter = 0
    try:
        with open(rooms_json, "r", encoding="utf-8") as f:
            rooms_payload = _json.load(f)
        stations = place_mcp_hooter_from_rooms_payload(
            rooms_payload if isinstance(rooms_payload, dict) else {"rooms": rooms_payload},
            world_to_m=opts.world_to_m,
            gemini_model=opts.gemini_model,
        )
        dets = _to_mcp_hooter_detectors(stations, opts.world_to_m)
        with db() as con:
            _replace_detectors_of_types(con, project_id, dets, ["mcb", "hooter"])
        placed_mcp_hooter = len(stations)
    except (OSError, ValueError, TypeError, KeyError, RuntimeError):
        logger.exception("mcp/hooter placement failed for project=%s", project_id)
    stage_done("place_mcp_hooter", stage_ts, stations=placed_mcp_hooter)

    # ── Pause for user room review ──
    with db() as con:
        _set_project(con, project_id, status="awaiting_room_review", error=None)
    logger.info(
        "pipeline project=%s status=awaiting_room_review rooms=%d",
        project_id,
        len(rooms),
    )
    # Pipeline stops here.  Resumed by continue_pipeline_after_rooms().


def _run_multi_block_post_alignment(
    project_id: str,
    opts: PipelineOptions,
    pdir: str,
    dxf_path: str,
    stage_start,
    stage_done,
):
    """Process walls + rooms for every floor-plan block, then aggregate rooms."""
    with db() as con:
        fps = _get_floor_plans(con, project_id)

    all_rooms: list = []
    all_doors: list = []
    all_staircases: list = []

    for fp in fps:
        fp_id = fp["id"]
        idx = fp["block_index"]
        render_png_path = fp["render_png_path"]
        fp_dir = os.path.dirname(render_png_path) if render_png_path else os.path.join(pdir, "blocks")
        aligned = fp["aligned_mask_path"]
        mapping_json = fp["mapping_json_path"]

        if not aligned or not os.path.exists(aligned):
            logger.warning("block %d has no aligned mask, skipping", idx)
            continue

        # Fix walls per block
        stage_ts = time.perf_counter()
        stage_start(f"fix_walls_block_{idx}")
        fixed = os.path.join(fp_dir, f"block_{idx}_fixed_wall.png")
        fix_walls(aligned, fixed, thickness=2)
        stage_done(f"fix_walls_block_{idx}", stage_ts)
        with db() as con:
            _set_floor_plan(con, fp_id, fixed_wall_path=fixed, status="walls_fixed")

        # Ensure each block has a mapping json. Floor plans created from frontend
        # world bboxes don't have mapping_json_path by default.
        if not mapping_json or not os.path.exists(mapping_json):
            wb = _json.loads(fp["world_bbox_json"]) if fp["world_bbox_json"] else None
            if not wb:
                raise RuntimeError(f"Missing world bbox for block {idx}; cannot build mapping.")

            ref_img_path = fixed if os.path.exists(fixed) else aligned
            img = cv2.imread(ref_img_path)
            if img is None:
                raise RuntimeError(f"Could not read block image for mapping (block {idx}).")
            h, w = img.shape[:2]

            mapping_json = os.path.join(fp_dir, f"block_{idx}_mapping.json")
            mapping_payload = _build_block_mapping_from_world_bbox(
                world_bbox=wb,
                width_px=w,
                height_px=h,
            )
            with open(mapping_json, "w", encoding="utf-8") as mf:
                _json.dump(mapping_payload, mf, indent=2)

            with db() as con:
                _set_floor_plan(con, fp_id, mapping_json_path=mapping_json)

        # Extract rooms per block
        stage_ts = time.perf_counter()
        stage_start(f"extract_rooms_block_{idx}")
        rooms_json = os.path.join(fp_dir, f"block_{idx}_rooms.json")
        debug_rooms = os.path.join(fp_dir, f"block_{idx}_rooms_debug.png")
        rooms = extract_rooms(
            fixed,
            mapping_json,
            rooms_json,
            debug_png_path=debug_rooms,
            dxf_path=dxf_path,
        )
        stage_done(f"extract_rooms_block_{idx}", stage_ts, rooms=len(rooms))
        with db() as con:
            _set_floor_plan(con, fp_id, rooms_json_path=rooms_json, status="rooms_extracted")

        # Read block JSON to aggregate extracted entities.
        block_data = None
        block_rooms: list = []
        block_doors: list = []
        block_staircases: list = []
        try:
            with open(rooms_json, "r", encoding="utf-8") as bf:
                block_data = _json.load(bf)
            if isinstance(block_data, dict):
                block_rooms = block_data.get("rooms", []) or []
                block_doors = block_data.get("doors", []) or []
                block_staircases = block_data.get("staircases", []) or []
        except (OSError, ValueError, TypeError, KeyError):
            block_rooms = rooms

        # Place MCP + Hooter stations per block before room review.
        stage_ts = time.perf_counter()
        stage_start(f"place_mcp_hooter_block_{idx}")
        placed_mcp_hooter = 0
        try:
            payload = block_data if isinstance(block_data, dict) else {"rooms": block_rooms}
            stations = place_mcp_hooter_from_rooms_payload(
                payload,
                world_to_m=opts.world_to_m,
                gemini_model=opts.gemini_model,
            )
            dets = _to_mcp_hooter_detectors(stations, opts.world_to_m, floor_plan_id=fp_id)
            with db() as con:
                _replace_detectors_of_types(con, project_id, dets, ["mcb", "hooter"], floor_plan_id=fp_id)
            placed_mcp_hooter = len(stations)
        except (OSError, ValueError, TypeError, KeyError, RuntimeError):
            logger.exception("mcp/hooter placement failed for project=%s block=%s", project_id, idx)
        stage_done(f"place_mcp_hooter_block_{idx}", stage_ts, stations=placed_mcp_hooter)

        # Tag each extracted entity with its block index for traceability.
        for d in block_doors:
            d["block_index"] = idx
        for s in block_staircases:
            s["block_index"] = idx

        for r in rooms:
            r["block_index"] = idx
        for r in block_rooms:
            r["block_index"] = idx
        all_rooms.extend(block_rooms if block_rooms else rooms)
        all_doors.extend(block_doors)
        all_staircases.extend(block_staircases)

    # Aggregate all rooms into the project-level rooms JSON
    agg_rooms_json = os.path.join(pdir, "rooms_from_image.json")
    with open(agg_rooms_json, "w", encoding="utf-8") as f:
        _json.dump({"rooms": all_rooms, "doors": all_doors, "staircases": all_staircases}, f, indent=2)
    with db() as con:
        _set_project(con, project_id, rooms_json_path=agg_rooms_json, status="rooms_extracted")

    # Pause for room review
    with db() as con:
        _set_project(con, project_id, status="awaiting_room_review", error=None)
    logger.info(
        "pipeline project=%s multi-block status=awaiting_room_review rooms=%d blocks=%d",
        project_id, len(all_rooms), len(fps),
    )


def _run_post_room_review_steps(
    project_id: str,
    opts: PipelineOptions,
    pdir: str,
    dxf_path: str,
    mapping_json: str,
    stage_start,
    stage_done,
):
    """Stages 7-11: filter rooms, place detectors per floor plan, export DXF, render preview."""
    with db() as con:
        fps = _get_floor_plans(con, project_id)

    all_dets: list[dict] = []
    all_sprinkler_dets: list[dict] = []
    all_sprinkler_pipes: list = []
    all_sprinkler_sources: list = []

    if fps:
        # ── Per-floor-plan placement ──
        for fp in fps:
            fp_id = fp["id"]
            idx = fp["block_index"]
            fp_rooms_path = fp["rooms_json_path"]
            fp_mapping = fp["mapping_json_path"]
            fp_render = fp["render_png_path"]

            if not fp_rooms_path or not os.path.exists(fp_rooms_path):
                logger.warning("block %d has no rooms JSON, skipping placement", idx)
                continue

            with open(fp_rooms_path, "r", encoding="utf-8") as f:
                rooms_data = _json.load(f)
            rooms = rooms_data.get("rooms", rooms_data) if isinstance(rooms_data, dict) else rooms_data

            # Filter rooms by DXF text labels
            rooms = filter_rooms_by_dxf_text(rooms, dxf_path, exclude_keywords=opts.room_exclude_keywords)

            if not rooms:
                continue

            # Place smoke detectors for this floor plan
            stage_ts = time.perf_counter()
            stage_start(f"place_detectors_block_{idx}")
            placed, _regions = place_detectors_from_rooms_json(
                rooms,
                opts.detector_spacing_m,
                opts.wall_buffer_m,
                opts.world_to_m,
                mapping_json_path=fp_mapping or mapping_json,
                base_png_path=fp_render or os.path.join(pdir, "render.png"),
            )
            fp_dets = [
                {"id": str(uuid.uuid4())[:8], "x": x, "y": y, "z": 0.0,
                 "dtype": "smoke", "locked": 0, "floor_plan_id": fp_id}
                for (x, y) in placed
            ]
            with db() as con:
                _replace_detectors_of_types(con, project_id, fp_dets, ["smoke"], floor_plan_id=fp_id)
            all_dets.extend(fp_dets)
            stage_done(f"place_detectors_block_{idx}", stage_ts, detectors=len(fp_dets))

            # Sprinkler placement per floor plan (optional)
            if opts.enable_sprinklers and dxf_path and os.path.exists(dxf_path):
                stage_ts = time.perf_counter()
                stage_start(f"place_sprinklers_block_{idx}")
                sp_points, sp_pipes, sp_sources, _sp_regions = place_sprinklers_from_rooms_json(
                    rooms,
                    dxf_path,
                    spacing_m=opts.sprinkler_spacing_m,
                    wall_buffer_m=opts.wall_buffer_m,
                    world_to_m=opts.world_to_m,
                    source_labels=opts.sprinkler_source_labels,
                )
                fp_sp_dets = [
                    {"id": str(uuid.uuid4())[:8], "x": x, "y": y, "z": 0.0,
                     "dtype": "sprinkler", "locked": 0, "floor_plan_id": fp_id}
                    for x, y in sp_points
                ]
                with db() as con:
                    _replace_detectors_of_types(con, project_id, fp_sp_dets, ["sprinkler"], floor_plan_id=fp_id)
                all_sprinkler_dets.extend(fp_sp_dets)
                all_sprinkler_pipes.extend(sp_pipes)
                all_sprinkler_sources.extend(sp_sources)
                stage_done(f"place_sprinklers_block_{idx}", stage_ts, sprinklers=len(fp_sp_dets))
    else:
        # ── Legacy single-block path ──
        rooms_json_path = os.path.join(pdir, "rooms_from_image.json")
        with open(rooms_json_path, "r", encoding="utf-8") as f:
            rooms_data = _json.load(f)
        rooms = rooms_data.get("rooms", rooms_data) if isinstance(rooms_data, dict) else rooms_data

        stage_ts = time.perf_counter()
        stage_start("filter_rooms")
        rooms = filter_rooms_by_dxf_text(rooms, dxf_path, exclude_keywords=opts.room_exclude_keywords)
        stage_done("filter_rooms", stage_ts, rooms_after_filter=len(rooms))

        stage_ts = time.perf_counter()
        stage_start("place_detectors")
        placed, _regions = place_detectors_from_rooms_json(
            rooms,
            opts.detector_spacing_m,
            opts.wall_buffer_m,
            opts.world_to_m,
            mapping_json_path=mapping_json,
            base_png_path=os.path.join(pdir, "render.png"),
        )
        all_dets = [{"id": str(uuid.uuid4())[:8], "x": x, "y": y, "z": 0.0, "dtype": "smoke", "locked": 0} for (x,y) in placed]
        with db() as con:
            _replace_detectors_of_types(con, project_id, all_dets, ["smoke"])
        stage_done("place_detectors", stage_ts, detectors=len(all_dets))

        if opts.enable_sprinklers:
            stage_ts = time.perf_counter()
            stage_start("place_sprinklers")
            sp_points, sp_pipes, sp_sources, _sp_regions = place_sprinklers_from_rooms_json(
                rooms, dxf_path,
                spacing_m=opts.sprinkler_spacing_m, wall_buffer_m=opts.wall_buffer_m,
                world_to_m=opts.world_to_m, source_labels=opts.sprinkler_source_labels,
            )
            all_sprinkler_dets = [
                {"id": str(uuid.uuid4())[:8], "x": x, "y": y, "z": 0.0, "dtype": "sprinkler", "locked": 0}
                for x, y in sp_points
            ]
            all_sprinkler_pipes = sp_pipes
            all_sprinkler_sources = sp_sources
            with db() as con:
                _replace_detectors_of_types(con, project_id, all_sprinkler_dets, ["sprinkler"])
            stage_done("place_sprinklers", stage_ts, sprinklers=len(all_sprinkler_dets))

    # 9) Export DXF with all detectors across all floor plans
    stage_ts = time.perf_counter()
    stage_start("export_dxf")
    out_dxf = os.path.join(pdir, "detectors_overlay.dxf")
    with db() as con:
        existing = con.execute(
            "SELECT id, x, y, z, dtype, locked, floor_plan_id FROM detectors WHERE project_id=? ORDER BY created_at ASC",
            (project_id,),
        ).fetchall()
    combined_dets = [
        {
            "id": r["id"],
            "x": float(r["x"]),
            "y": float(r["y"]),
            "z": float(r["z"]),
            "dtype": r["dtype"],
            "locked": int(r["locked"]),
            "floor_plan_id": r["floor_plan_id"],
        }
        for r in existing
    ]

    # Build a combined world bbox from floor-plan blocks (or mapping.json)
    # so symbol sizing is proportional to actual content, not whitespace.
    combined_bbox = None
    if fps:
        all_xmin, all_ymin, all_xmax, all_ymax = [], [], [], []
        for fp in fps:
            wb_json = fp["world_bbox_json"]
            wb = _json.loads(wb_json) if wb_json else None
            if wb:
                all_xmin.append(float(wb["xmin"])); all_ymin.append(float(wb["ymin"]))
                all_xmax.append(float(wb["xmax"])); all_ymax.append(float(wb["ymax"]))
        if all_xmin:
            combined_bbox = {"xmin": min(all_xmin), "ymin": min(all_ymin),
                             "xmax": max(all_xmax), "ymax": max(all_ymax)}
    if combined_bbox is None and os.path.exists(mapping_json):
        with open(mapping_json, "r", encoding="utf-8") as mf:
            combined_bbox = _json.load(mf).get("world_bbox")

    write_detectors_to_dxf(dxf_path, out_dxf, combined_dets,
                           world_to_m=opts.world_to_m, world_bbox=combined_bbox)

    # If sprinklers were placed, also write pipes + sources into the same DXF
    if all_sprinkler_pipes:
        write_sprinklers_to_dxf(
            out_dxf, out_dxf,
            [(d["x"], d["y"]) for d in all_sprinkler_dets],
            all_sprinkler_pipes,
            all_sprinkler_sources,
            world_to_m=opts.world_to_m,
            world_bbox=combined_bbox,
        )

    # Combined multi-sheet DXF (separate tabs for fire alarm vs sprinkler)
    out_combined = os.path.join(pdir, "detectors_combined_sheets.dxf")
    write_combined_sheets_dxf(
        base_dxf=dxf_path,
        out_combined_dxf=out_combined,
        detectors=combined_dets,
        sprinkler_pipes=all_sprinkler_pipes,
        sprinkler_sources=[(s[0], s[1]) for s in all_sprinkler_sources] if all_sprinkler_sources else [],
        world_to_m=opts.world_to_m,
        world_bbox=combined_bbox,
    )
    stage_done("export_dxf", stage_ts, out_dxf=out_dxf, out_combined=out_combined)

    # Set final status - no rendering needed, frontend handles DXF visualization
    with db() as con:
        _set_project(con, project_id,
                     status="ready",
                     output_dxf_path=out_combined,
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

        # 2) Generate a frontend-safe placeholder mapping without DXF parsing.
        #    Frontend handles DXF rendering/extraction and provides floor-plan images.
        stage_ts = time.perf_counter()
        stage_start("generate_mapping")
        mapping_json = os.path.join(pdir, "mapping.json")

        mapping_data = {
            "width_px": 2048,
            "height_px": 2048,
            "world_bbox": {
                "xmin": 0.0,
                "xmax": 1.0,
                "ymin": 0.0,
                "ymax": 1.0,
            },
            "pixel_fit": {
                "mode": "contain",
                "scale": 1.0,
                "offset_x": 0.0,
                "offset_y": 0.0,
            },
        }
        import json as _json_lib
        with open(mapping_json, "w", encoding="utf-8") as f:
            _json_lib.dump(mapping_data, f, indent=2)

        stage_done("generate_mapping", stage_ts, mapping=mapping_json)

        # 3) Set status to awaiting_floor_review - frontend will handle floor plan detection
        with db() as con:
            _set_project(con, project_id,
                         status="awaiting_floor_review",
                         dxf_path=dxf_path,
                         mapping_json_path=mapping_json,
                         error=None)

        logger.info(
            "pipeline project=%s status=awaiting_floor_review (frontend will detect floor plans) total_elapsed=%.2fs",
            project_id, time.perf_counter() - start_ts,
        )

    except Exception as e:
        err = f"{e}\n\n{traceback.format_exc()}"
        logger.exception("pipeline project=%s status=failed", project_id)
        with db() as con:
            _set_project(con, project_id, status="failed", error=err)

def continue_pipeline_after_floor_review(project_id: str, opts: PipelineOptions):
    """Resume pipeline after user has reviewed / confirmed floor plan splits.

    Runs Gemini mask generation + alignment for each floor plan block,
    then pauses for alignment review.
    """
    start_ts = time.perf_counter()

    def stage_start(name: str):
        logger.info("pipeline-floor-review project=%s stage=%s status=start", project_id, name)
        ws_manager.broadcast_sync(project_id, {"type": "stage", "stage": name, "event": "start"})

    def stage_done(name: str, stage_ts: float, **extra):
        suffix = " ".join(f"{k}={v}" for k, v in extra.items())
        if suffix:
            suffix = f" {suffix}"
        logger.info(
            "pipeline-floor-review project=%s stage=%s status=done elapsed=%.2fs%s",
            project_id, name, time.perf_counter() - stage_ts, suffix,
        )
        ws_manager.broadcast_sync(project_id, {
            "type": "stage", "stage": name, "event": "done",
            "elapsed": round(time.perf_counter() - stage_ts, 2),
        })

    logger.info("pipeline-floor-review project=%s status=start", project_id)
    try:
        with db() as con:
            p = _get_project(con, project_id)
            if not p:
                logger.warning("pipeline-floor-review project=%s status=aborted reason=project_not_found", project_id)
                return

        pdir = project_dir(project_id)
        blocks_dir = os.path.join(pdir, "blocks")
        os.makedirs(blocks_dir, exist_ok=True)

        dxf_path = p["dxf_path"]
        if not dxf_path or not os.path.exists(dxf_path):
            with db() as con:
                _set_project(con, project_id, status="failed", error="DXF not found for floor review continue flow.")
            return

        # Use frontend-uploaded floor plan images; the backend no longer renders blocks.
        with db() as con:
            fps = _get_floor_plans(con, project_id)

        # Remove stale block artifacts from previous floor-plan selections.
        _cleanup_orphan_block_artifacts(
            project_id,
            valid_block_indices={int(fp["block_index"]) for fp in fps},
        )

        for fp in fps:
            idx = fp["block_index"]
            fp_id = fp["id"]
            wb = _json.loads(fp["world_bbox_json"]) if fp["world_bbox_json"] else None
            if not wb:
                logger.warning("block %d has no world bbox, skipping", idx)
                continue

            render_path = fp["render_png_path"]
            if not render_path or not os.path.exists(render_path):
                logger.warning("block %d has no frontend render image, skipping", idx)
                continue

            with db() as con:
                _set_floor_plan(con, fp_id,
                                status="rendered")

        # Gemini mask generation
        if not opts.use_gemini:
            with db() as con:
                _set_project(con, project_id, status="ready_no_mask",
                             error="GEMINI_API_KEY not set; skipping auto-mask/rooms. You can still edit detectors manually.")
            logger.warning("pipeline-floor-review project=%s status=ready_no_mask reason=gemini_key_missing", project_id)
            return

        ok = _run_mask_and_align_for_blocks(
            project_id=project_id,
            opts=opts,
            blocks_dir=blocks_dir,
            stage_start=stage_start,
            stage_done=stage_done,
            log_prefix="pipeline-floor-review",
            start_ts=start_ts,
            resume=False,
        )
        if not ok:
            # Mask failed — status set to "mask_failed" by helper. Stop here so
            # the user can retry just the mask step instead of the full pipeline.
            return

    except Exception as e:
        err = f"{e}\n\n{traceback.format_exc()}"
        logger.exception("pipeline-floor-review project=%s status=failed", project_id)
        with db() as con:
            _set_project(con, project_id, status="failed", error=err)


def _run_mask_and_align_for_blocks(
    *,
    project_id: str,
    opts: PipelineOptions,
    blocks_dir: str,
    stage_start,
    stage_done,
    log_prefix: str,
    start_ts: float,
    resume: bool,
) -> bool:
    """Run Gemini mask generation + auto-alignment for each floor-plan block.

    When ``resume`` is True, blocks that already have a valid mask file on disk
    are skipped — this allows retrying after a Gemini failure without
    re-doing successful blocks.

    On Gemini failure for any block, the project status is set to
    ``mask_failed`` (not ``failed``) so the UI can offer a targeted retry of
    just the mask step. Returns True on success, False on mask failure.
    """
    with db() as con:
        fps = _get_floor_plans(con, project_id)

    # ── Mask generation ────────────────────────────────────────
    for fp in fps:
        idx = fp["block_index"]
        fp_id = fp["id"]
        block_render = fp["render_png_path"]
        mask_png = os.path.join(blocks_dir, f"block_{idx}_mask.png")

        if not block_render or not os.path.exists(block_render):
            err = f"Missing frontend floor-plan image for block {idx}."
            logger.error(
                "%s project=%s stage=gemini_mask_block_%d status=failed reason=missing_frontend_render",
                log_prefix, project_id, idx,
            )
            with db() as con:
                _set_floor_plan(con, fp_id, status="mask_failed")
                _set_project(con, project_id, status="mask_failed", error=err)
            return False

        existing_mask = fp["mask_png_path"]
        if resume and existing_mask and os.path.exists(existing_mask):
            logger.info(
                "%s project=%s stage=gemini_mask_block_%d status=skipped reason=already_masked",
                log_prefix, project_id, idx,
            )
            continue

        stage_ts = time.perf_counter()
        stage_start(f"gemini_mask_block_{idx}")
        try:
            generate_mask_image(
                input_png=block_render,
                out_mask_png=mask_png,
                model=opts.gemini_model,
            )
        except Exception as e:
            err = (
                f"Gemini mask generation failed for block {idx}: {e}\n\n"
                f"{traceback.format_exc()}"
            )
            logger.exception(
                "%s project=%s stage=gemini_mask_block_%d status=mask_failed",
                log_prefix, project_id, idx,
            )
            with db() as con:
                _set_floor_plan(con, fp_id, status="mask_failed")
                _set_project(con, project_id, status="mask_failed", error=err)
            return False
        stage_done(f"gemini_mask_block_{idx}", stage_ts)
        with db() as con:
            _set_floor_plan(con, fp_id, mask_png_path=mask_png, status="masked")

    with db() as con:
        _set_project(con, project_id, status="masked")

    # ── Auto-alignment ─────────────────────────────────────────
    with db() as con:
        fps = _get_floor_plans(con, project_id)

    for fp in fps:
        idx = fp["block_index"]
        fp_id = fp["id"]
        block_render = fp["render_png_path"]
        block_mask = fp["mask_png_path"]
        if not block_render or not os.path.exists(block_render):
            continue
        if not block_mask or not os.path.exists(block_mask):
            continue

        existing_aligned = fp["aligned_mask_path"]
        if resume and existing_aligned and os.path.exists(existing_aligned):
            logger.info(
                "%s project=%s stage=align_mask_block_%d status=skipped reason=already_aligned",
                log_prefix, project_id, idx,
            )
            continue

        stage_ts = time.perf_counter()
        stage_start(f"align_mask_block_{idx}")
        aligned = os.path.join(blocks_dir, f"block_{idx}_aligned.png")
        overlay_dbg = os.path.join(blocks_dir, f"block_{idx}_align_overlay.jpg")
        boxes_dbg = os.path.join(blocks_dir, f"block_{idx}_align_boxes.jpg")
        align_perfect_tight_box(block_render, block_mask, aligned,
                                overlay_debug=overlay_dbg, boxes_debug=boxes_dbg)
        stage_done(f"align_mask_block_{idx}", stage_ts)
        with db() as con:
            _set_floor_plan(con, fp_id, aligned_mask_path=aligned, status="aligned")

    with db() as con:
        _set_project(con, project_id, status="aligned")

    # Pause for user alignment review (all blocks)
    with db() as con:
        _set_project(con, project_id, status="awaiting_alignment_review", error=None)
    logger.info(
        "%s project=%s status=awaiting_alignment_review blocks=%d total_elapsed=%.2fs",
        log_prefix, project_id, len(fps), time.perf_counter() - start_ts,
    )
    return True


def retry_mask_generation(project_id: str, opts: PipelineOptions):
    """Background task: re-run only the Gemini mask + align step.

    Intended to be triggered by the `/retry_mask_generation` endpoint after
    a previous mask-step failure (status == ``mask_failed``). Skips blocks
    that already have a mask, so multi-block runs only retry what failed.
    """
    start_ts = time.perf_counter()

    def stage_start(name: str):
        logger.info("pipeline-retry-mask project=%s stage=%s status=start", project_id, name)
        ws_manager.broadcast_sync(project_id, {"type": "stage", "stage": name, "event": "start"})

    def stage_done(name: str, stage_ts: float, **extra):
        suffix = " ".join(f"{k}={v}" for k, v in extra.items())
        if suffix:
            suffix = f" {suffix}"
        logger.info(
            "pipeline-retry-mask project=%s stage=%s status=done elapsed=%.2fs%s",
            project_id, name, time.perf_counter() - stage_ts, suffix,
        )
        ws_manager.broadcast_sync(project_id, {
            "type": "stage", "stage": name, "event": "done",
            "elapsed": round(time.perf_counter() - stage_ts, 2),
        })

    logger.info("pipeline-retry-mask project=%s status=start", project_id)
    try:
        with db() as con:
            p = _get_project(con, project_id)
            if not p:
                logger.warning("pipeline-retry-mask project=%s status=aborted reason=project_not_found", project_id)
                return

        if not opts.use_gemini:
            with db() as con:
                _set_project(
                    con, project_id, status="mask_failed",
                    error="GEMINI_API_KEY not set; cannot retry mask generation.",
                )
            return

        pdir = project_dir(project_id)
        blocks_dir = os.path.join(pdir, "blocks")
        os.makedirs(blocks_dir, exist_ok=True)

        _run_mask_and_align_for_blocks(
            project_id=project_id,
            opts=opts,
            blocks_dir=blocks_dir,
            stage_start=stage_start,
            stage_done=stage_done,
            log_prefix="pipeline-retry-mask",
            start_ts=start_ts,
            resume=True,
        )
    except Exception as e:
        err = f"{e}\n\n{traceback.format_exc()}"
        logger.exception("pipeline-retry-mask project=%s status=failed", project_id)
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
            fps = _get_floor_plans(con, project_id)

        pdir = project_dir(project_id)

        if fps:
            # ── Multi-block path: process each block's alignment → rooms ──
            _run_multi_block_post_alignment(
                project_id=project_id,
                opts=opts,
                pdir=pdir,
                dxf_path=dxf_path,
                stage_start=stage_start,
                stage_done=stage_done,
            )
        else:
            # ── Legacy single-block path ──
            if not dxf_path or not os.path.exists(dxf_path):
                with db() as con:
                    _set_project(con, project_id, status="failed", error="Base DXF not found for continue flow.")
                return
            if not mapping_json or not os.path.exists(mapping_json):
                with db() as con:
                    _set_project(con, project_id, status="failed", error="Mapping JSON not found for continue flow.")
                return
            if not aligned or not os.path.exists(aligned):
                with db() as con:
                    _set_project(con, project_id, status="failed", error="Aligned mask not found.")
                return
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
