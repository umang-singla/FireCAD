import os
import json
import logging
from typing import List, Tuple

import numpy as np
import cv2
from shapely.geometry import Point, Polygon

logger = logging.getLogger("mepit.pipeline.dxf_text_filter")

try:
    import ezdxf
    _EZDXF_OK = True
except ImportError:
    _EZDXF_OK = False


def extract_dxf_labels(dxf_path: str) -> List[Tuple[str, Point]]:
    """Read TEXT and MTEXT from a DXF file and return (text_string, shapely Point) pairs."""
    labels: List[Tuple[str, Point]] = []
    if not _EZDXF_OK or not os.path.exists(dxf_path):
        return labels

    try:
        doc = ezdxf.readfile(dxf_path)
        msp = doc.modelspace()

        for entity in msp.query("TEXT MTEXT"):
            if entity.dxftype() == "TEXT":
                text_val = entity.dxf.text
                pt = entity.dxf.insert
            elif entity.dxftype() == "MTEXT":
                text_val = entity.text
                pt = entity.dxf.insert
            else:
                continue

            labels.append((text_val, Point(pt.x, pt.y)))
    except Exception as e:
        logger.warning("Failed to extract text from DXF %s: %s", dxf_path, e)

    return labels


def filter_rooms_by_dxf_text(
    rooms: list,
    dxf_path: str,
    exclude_keywords: List[str] | None = None,
) -> list:
    """Remove rooms whose polygon contains DXF text matching any exclude keyword.

    Args:
        rooms: List of room dicts with ``polygon_world`` key.
        dxf_path: Path to the source DXF file.
        exclude_keywords: Case-insensitive substrings to match against DXF text.
            Defaults to common non-detectable spaces like toilets.

    Returns:
        Filtered list of rooms (rooms matching excluded text are removed).
    """
    kept, _excluded = split_rooms_by_dxf_text(rooms, dxf_path, exclude_keywords)
    return kept


def split_rooms_by_dxf_text(
    rooms: list,
    dxf_path: str,
    exclude_keywords: List[str] | None = None,
    classifier_model: str | None = None,
    debug_png_path: str | None = None,
    base_png_path: str | None = None,
    mapping_json_path: str | None = None,
) -> tuple[list, list]:
    """Partition rooms into (kept, excluded) based on DXF text labels.

    For each room, the DXF TEXT/MTEXT entities whose insertion point lies
    inside the room polygon are collected and sent to a Gemini-based
    classifier (see ``room_label_classifier``) which decides per-label
    whether SMOKE detectors are appropriate or HEAT detectors must be used
    (kitchens, toilets, garages, plant rooms, etc.).

    Rooms classified as heat-only end up in the ``excluded`` list (annotated
    with ``_excluded_label``).

    The legacy ``exclude_keywords`` argument is accepted for backward
    compatibility but is now IGNORED — the Gemini/regex classifier in
    ``room_label_classifier`` is always used.
    """
    if exclude_keywords:
        logger.info(
            "dxf_text_filter: ignoring legacy exclude_keywords=%s (using classifier)",
            exclude_keywords,
        )
    dxf_labels = extract_dxf_labels(dxf_path)
    if not dxf_labels:
        logger.info("dxf_text_filter: no DXF TEXT/MTEXT entities found in %s", dxf_path)
        if debug_png_path and base_png_path and mapping_json_path:
            _render_label_debug(
                rooms, {i: [] for i in range(len(rooms))}, {},
                debug_png_path, base_png_path, mapping_json_path,
            )
        return list(rooms), []

    # Per-room labels come ONLY from DXF TEXT/MTEXT entities whose insertion
    # point lies inside the room polygon. Upstream `label`/`label_text`
    # fields are intentionally ignored.
    room_label_map: dict[int, list[str]] = {}
    for i, room in enumerate(rooms):
        collected: list[str] = []
        seen_local: set[str] = set()

        poly_coords = room.get("polygon_world")
        if poly_coords and len(poly_coords) >= 3:
            poly = Polygon(poly_coords)
            if not poly.is_valid:
                from shapely.validation import make_valid
                poly = make_valid(poly)
            for text_val, text_pt in dxf_labels:
                if not text_val:
                    continue
                s = str(text_val).strip()
                if not s or s in seen_local:
                    continue
                if poly.contains(text_pt):
                    seen_local.add(s)
                    collected.append(s)

        room_label_map[i] = collected

    # Always use the Gemini/regex classifier (legacy keyword path removed).
    from app.pipeline.room_label_classifier import classify_labels
    unique_labels: list[str] = []
    seen: set[str] = set()
    for labels in room_label_map.values():
        for lbl in labels:
            if lbl not in seen:
                seen.add(lbl)
                unique_labels.append(lbl)
    label_class = classify_labels(unique_labels, model=classifier_model)
    logger.info(
        "dxf_text_filter classified %d unique labels: %s",
        len(unique_labels),
        {lbl: label_class.get(lbl, "?") for lbl in unique_labels},
    )

    kept: list = []
    excluded: list = []
    skipped = 0
    for i, room in enumerate(rooms):
        labels = room_label_map.get(i, [])
        # Priority: HEAT > SKIP > SMOKE.
        # HEAT wins because plant/kitchen rooms must always get heat detection.
        # SKIP (toilet/bathroom) drops the room entirely — no detector placed.
        # Everything else (smoke / unknown / no labels) gets a smoke detector.
        heat_label = next(
            (lbl for lbl in labels if label_class.get(lbl) == "heat"),
            None,
        )
        skip_label = next(
            (lbl for lbl in labels if label_class.get(lbl) == "skip"),
            None,
        )
        if heat_label is not None:
            logger.info(
                "dxf_text_filter HEAT room_id=%s matched='%s'",
                room.get("room_id", "?"),
                heat_label,
            )
            room_copy = dict(room)
            room_copy["_excluded_label"] = heat_label
            excluded.append(room_copy)
        elif skip_label is not None:
            logger.info(
                "dxf_text_filter SKIP room_id=%s matched='%s' (no detector)",
                room.get("room_id", "?"),
                skip_label,
            )
            skipped += 1
        else:
            kept.append(room)

    logger.info(
        "dxf_text_filter kept=%d heat=%d skipped=%d total=%d",
        len(kept), len(excluded), skipped, len(rooms),
    )

    if debug_png_path and base_png_path and mapping_json_path:
        try:
            _render_label_debug(
                rooms, room_label_map, label_class,
                debug_png_path, base_png_path, mapping_json_path,
            )
        except Exception as exc:
            logger.warning("dxf_text_filter: debug image failed: %s", exc)

    return kept, excluded


# ---------------------------------------------------------------------------
# Debug rendering
# ---------------------------------------------------------------------------

_CLASS_COLOR_BGR = {
    "smoke":   (60, 60, 220),    # red
    "heat":    (40, 200, 240),   # yellow / amber
    "skip":    (140, 140, 140),  # gray
    "unknown": (180, 80, 200),   # magenta
}


def _world_to_px(x: float, y: float, mapping: dict) -> tuple[float, float]:
    bbox = mapping["world_bbox"]
    xmin, xmax = float(bbox["xmin"]), float(bbox["xmax"])
    ymin, ymax = float(bbox["ymin"]), float(bbox["ymax"])
    pf = mapping.get("pixel_fit")
    if pf and float(pf.get("scale", 0.0)) > 0.0:
        s = float(pf["scale"])
        ox = float(pf.get("offset_x", 0.0))
        oy = float(pf.get("offset_y", 0.0))
        return ox + (x - xmin) * s, oy + (ymax - y) * s
    w = float(mapping["width_px"])
    h = float(mapping["height_px"])
    u = (x - xmin) / max(1e-9, xmax - xmin)
    v = (ymax - y) / max(1e-9, ymax - ymin)
    return u * w, v * h


def _room_classification(labels: list[str], label_class: dict[str, str]) -> str:
    classes = [label_class.get(lbl, "smoke") for lbl in labels]
    if "heat" in classes:
        return "heat"
    if "skip" in classes and "smoke" not in classes:
        return "skip"
    if not labels:
        return "unknown"
    return "smoke"


def _render_label_debug(
    rooms: list,
    room_label_map: dict[int, list[str]],
    label_class: dict[str, str],
    out_path: str,
    base_png_path: str,
    mapping_json_path: str,
) -> None:
    if not os.path.exists(base_png_path) or not os.path.exists(mapping_json_path):
        return
    base = cv2.imread(base_png_path)
    if base is None:
        return
    with open(mapping_json_path, "r", encoding="utf-8") as f:
        mapping = json.load(f)

    img = base.copy()
    overlay = img.copy()

    for i, room in enumerate(rooms):
        poly_coords = room.get("polygon_world")
        if not poly_coords or len(poly_coords) < 3:
            continue
        labels = room_label_map.get(i, [])
        cls = _room_classification(labels, label_class)
        color = _CLASS_COLOR_BGR.get(cls, _CLASS_COLOR_BGR["unknown"])
        pts = []
        for wx, wy in poly_coords:
            px, py = _world_to_px(float(wx), float(wy), mapping)
            pts.append([int(round(px)), int(round(py))])
        if len(pts) < 3:
            continue
        poly_np = np.array(pts, dtype=np.int32)
        cv2.fillPoly(overlay, [poly_np], color)
        cv2.polylines(overlay, [poly_np], True, (255, 255, 255), 1, cv2.LINE_AA)

    cv2.addWeighted(overlay, 0.35, img, 0.65, 0, img)

    # Per-room text: classification + labels
    for i, room in enumerate(rooms):
        poly_coords = room.get("polygon_world")
        if not poly_coords or len(poly_coords) < 3:
            continue
        labels = room_label_map.get(i, [])
        cls = _room_classification(labels, label_class)
        color = _CLASS_COLOR_BGR.get(cls, _CLASS_COLOR_BGR["unknown"])
        xs, ys = zip(*poly_coords)
        cx_w = sum(xs) / len(xs)
        cy_w = sum(ys) / len(ys)
        cx, cy = _world_to_px(cx_w, cy_w, mapping)
        cx_i, cy_i = int(round(cx)), int(round(cy))
        header = f"#{i} {cls.upper()}"
        cv2.putText(img, header, (cx_i - 50, cy_i - 6),
                    cv2.FONT_HERSHEY_SIMPLEX, 0.55, (0, 0, 0), 3, cv2.LINE_AA)
        cv2.putText(img, header, (cx_i - 50, cy_i - 6),
                    cv2.FONT_HERSHEY_SIMPLEX, 0.55, color, 1, cv2.LINE_AA)
        if labels:
            joined = " | ".join(labels)[:60]
            cv2.putText(img, joined, (cx_i - 60, cy_i + 14),
                        cv2.FONT_HERSHEY_SIMPLEX, 0.42, (0, 0, 0), 3, cv2.LINE_AA)
            cv2.putText(img, joined, (cx_i - 60, cy_i + 14),
                        cv2.FONT_HERSHEY_SIMPLEX, 0.42, (255, 255, 255), 1, cv2.LINE_AA)

    # Legend
    y0 = 30
    cv2.putText(img, "Room label classification", (16, y0),
                cv2.FONT_HERSHEY_SIMPLEX, 0.75, (240, 240, 240), 2, cv2.LINE_AA)
    for j, (name, col) in enumerate([
        ("SMOKE", _CLASS_COLOR_BGR["smoke"]),
        ("HEAT",  _CLASS_COLOR_BGR["heat"]),
        ("SKIP",  _CLASS_COLOR_BGR["skip"]),
        ("UNKNOWN", _CLASS_COLOR_BGR["unknown"]),
    ]):
        y = y0 + 28 + j * 24
        cv2.rectangle(img, (16, y - 14), (40, y + 4), col, -1)
        cv2.putText(img, name, (50, y),
                    cv2.FONT_HERSHEY_SIMPLEX, 0.6, (240, 240, 240), 1, cv2.LINE_AA)

    os.makedirs(os.path.dirname(out_path) or ".", exist_ok=True)
    cv2.imwrite(out_path, img)
    logger.info("dxf_text_filter: wrote debug image -> %s", out_path)
