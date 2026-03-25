"""
XY-cut algorithm: split a master DXF rendering into individual floor-plan
blocks.

Flow (mirrors the Colab notebook cell 10):
 1. Render the full DXF at high resolution via QCAD.
 2. Threshold + dilate to get a binary content mask.
 3. Recursively split along X / Y projection gaps.
 4. Filter tiny boxes (< min_area_frac of image).
 5. Convert pixel boxes → DXF world coordinates using the master mapping.
 6. Re-render each block individually with per-block mapping JSON.
"""

import json
import logging
import os
from typing import List, Tuple

import cv2
import numpy as np
from PIL import Image

from app.pipeline.render import (
    _build_mapping,
    _padded_bbox_from_dxf,
    render_dwg_to_png_with_qcad,
)

logger = logging.getLogger("firecad.pipeline.split")

# ---------------------------------------------------------------------------
# XY-cut helpers
# ---------------------------------------------------------------------------

def _project_x(mask: np.ndarray) -> np.ndarray:
    """Vertical projection – sum along rows → 1-D array of length = width."""
    return mask.sum(axis=0)


def _project_y(mask: np.ndarray) -> np.ndarray:
    """Horizontal projection – sum along columns → 1-D array of length = height."""
    return mask.sum(axis=1)


def _find_gaps(profile: np.ndarray, min_gap: int = 20) -> List[Tuple[int, int]]:
    """Return list of (start, end) gap intervals where profile is zero."""
    is_gap = profile == 0
    gaps: list[tuple[int, int]] = []
    in_gap = False
    start = 0
    for i, g in enumerate(is_gap):
        if g and not in_gap:
            start = i
            in_gap = True
        elif not g and in_gap:
            if i - start >= min_gap:
                gaps.append((start, i))
            in_gap = False
    if in_gap and len(is_gap) - start >= min_gap:
        gaps.append((start, len(is_gap)))
    return gaps


def recursive_xy_cut(
    mask: np.ndarray,
    x0: int,
    y0: int,
    x1: int,
    y1: int,
    min_gap: int = 20,
    depth: int = 0,
    max_depth: int = 10,
) -> List[Tuple[int, int, int, int]]:
    """Recursively split a binary mask region into leaf bounding boxes.

    Returns list of (x0, y0, x1, y1) in pixel coordinates.
    """
    if depth > max_depth:
        return [(x0, y0, x1, y1)]

    region = mask[y0:y1, x0:x1]
    if region.sum() == 0:
        return []

    # Try vertical split first (gaps in x-projection)
    proj_x = _project_x(region)
    x_gaps = _find_gaps(proj_x, min_gap)
    if x_gaps:
        boxes: list[tuple[int, int, int, int]] = []
        edges = [0]
        for gs, ge in x_gaps:
            mid = (gs + ge) // 2
            edges.append(mid)
        edges.append(x1 - x0)

        for i in range(len(edges) - 1):
            lx = x0 + edges[i]
            rx = x0 + edges[i + 1]
            if rx - lx < min_gap:
                continue
            boxes.extend(
                recursive_xy_cut(mask, lx, y0, rx, y1, min_gap, depth + 1, max_depth)
            )
        if boxes:
            return boxes

    # Try horizontal split (gaps in y-projection)
    proj_y = _project_y(region)
    y_gaps = _find_gaps(proj_y, min_gap)
    if y_gaps:
        boxes = []
        edges = [0]
        for gs, ge in y_gaps:
            mid = (gs + ge) // 2
            edges.append(mid)
        edges.append(y1 - y0)

        for i in range(len(edges) - 1):
            ty = y0 + edges[i]
            by = y0 + edges[i + 1]
            if by - ty < min_gap:
                continue
            boxes.extend(
                recursive_xy_cut(mask, x0, ty, x1, by, min_gap, depth + 1, max_depth)
            )
        if boxes:
            return boxes

    # Leaf – no further splitting possible
    return [(x0, y0, x1, y1)]


# ---------------------------------------------------------------------------
# Pixel → DXF world coordinate conversion
# ---------------------------------------------------------------------------

def _pixel_to_dxf(px: float, py: float, mapping: dict) -> Tuple[float, float]:
    """Convert pixel coords to DXF world coords using a mapping dict."""
    wb = mapping["world_bbox"]
    pf = mapping["pixel_fit"]
    dxf_x = wb["xmin"] + (px - pf["offset_x"]) / pf["scale"]
    dxf_y = wb["ymax"] - (py - pf["offset_y"]) / pf["scale"]
    return dxf_x, dxf_y


# ---------------------------------------------------------------------------
# Main split entry point
# ---------------------------------------------------------------------------

def split_floor_plans(
    dxf_path: str,
    master_png: str,
    master_mapping_json: str,
    out_dir: str,
    *,
    block_render_px: int = 3000,
    min_area_frac: float = 0.0005,
    dilate_kernel: int = 15,
    min_gap_px: int = 30,
    pad_frac: float = 0.01,
) -> List[dict]:
    """Split the master rendering into individual floor-plan blocks.

    Returns a list of dicts, one per block:
        {
            "index": int,
            "pixel_bbox": [x0, y0, x1, y1],
            "world_bbox": {"xmin": ..., "ymin": ..., "xmax": ..., "ymax": ...},
            "render_png": str,       # path to per-block PNG
            "mapping_json": str,     # path to per-block mapping JSON
        }
    """
    os.makedirs(out_dir, exist_ok=True)

    # Load master mapping
    with open(master_mapping_json, "r", encoding="utf-8") as f:
        master_map = json.load(f)

    # Load master image and build binary mask
    Image.MAX_IMAGE_PIXELS = None
    img = cv2.imread(master_png)
    if img is None:
        raise FileNotFoundError(f"Cannot read master PNG: {master_png}")

    gray = cv2.cvtColor(img, cv2.COLOR_BGR2GRAY)
    # Invert: content pixels become white, background becomes black
    _, binary = cv2.threshold(gray, 240, 255, cv2.THRESH_BINARY_INV)
    # Dilate to merge nearby content
    kernel = np.ones((dilate_kernel, dilate_kernel), np.uint8)
    dilated = cv2.dilate(binary, kernel, iterations=2)

    h, w = dilated.shape[:2]
    total_area = h * w

    # Run recursive XY-cut
    raw_boxes = recursive_xy_cut(dilated, 0, 0, w, h, min_gap=min_gap_px)

    # Filter out tiny boxes
    min_area = total_area * min_area_frac
    boxes = [
        b for b in raw_boxes if (b[2] - b[0]) * (b[3] - b[1]) >= min_area
    ]

    if not boxes:
        # Fallback: entire image is one block
        boxes = [(0, 0, w, h)]

    logger.info(
        "split raw_boxes=%d after_filter=%d min_area_frac=%.4f",
        len(raw_boxes),
        len(boxes),
        min_area_frac,
    )

    # Convert pixel bboxes to DXF world coords and render each block
    blocks: list[dict] = []
    for idx, (bx0, by0, bx1, by1) in enumerate(boxes):
        # Pixel bbox → DXF world bbox
        dxf_tl_x, dxf_tl_y = _pixel_to_dxf(bx0, by0, master_map)
        dxf_br_x, dxf_br_y = _pixel_to_dxf(bx1, by1, master_map)
        wxmin = min(dxf_tl_x, dxf_br_x)
        wxmax = max(dxf_tl_x, dxf_br_x)
        wymin = min(dxf_tl_y, dxf_br_y)
        wymax = max(dxf_tl_y, dxf_br_y)

        # Render per-block PNG via QCAD with clipping
        block_png = os.path.join(out_dir, f"block_{idx}.png")
        block_map_json = os.path.join(out_dir, f"block_{idx}_mapping.json")

        _render_block(
            dxf_path=dxf_path,
            out_png=block_png,
            out_json=block_map_json,
            world_bbox=(wxmin, wymin, wxmax, wymax),
            target_long_side_px=block_render_px,
            pad_frac=pad_frac,
        )

        blocks.append({
            "index": idx,
            "pixel_bbox": [bx0, by0, bx1, by1],
            "world_bbox": {
                "xmin": wxmin,
                "ymin": wymin,
                "xmax": wxmax,
                "ymax": wymax,
            },
            "render_png": block_png,
            "mapping_json": block_map_json,
        })

    logger.info("split done blocks=%d", len(blocks))
    return blocks


def _render_block(
    dxf_path: str,
    out_png: str,
    out_json: str,
    world_bbox: Tuple[float, float, float, float],
    target_long_side_px: int = 3000,
    pad_frac: float = 0.01,
):
    """Render a DXF file clipped to a specific world bounding box.

    Uses QCAD with the -clip flag to render only the relevant region,
    then writes a mapping JSON for the rendered area.
    """
    wxmin, wymin, wxmax, wymax = world_bbox

    # Add padding
    span_x = max(1e-9, wxmax - wxmin)
    span_y = max(1e-9, wymax - wymin)
    wxmin_p = wxmin - pad_frac * span_x
    wxmax_p = wxmax + pad_frac * span_x
    wymin_p = wymin - pad_frac * span_y
    wymax_p = wymax + pad_frac * span_y

    # Render full DXF but crop to block region from the master image
    # Since QCAD doesn't support clip natively, we render the full DXF
    # and crop the relevant section, then create a block-specific mapping.
    render_dwg_to_png_with_qcad(
        dwg_path=dxf_path,
        out_png=out_png,
        target_long_side_px=target_long_side_px,
        background="white",
    )

    # Now crop the rendered image to the block region
    # Load the rendered full image, compute pixel coords for the block, crop
    Image.MAX_IMAGE_PIXELS = None
    full_img = Image.open(out_png)
    fw, fh = full_img.size

    # Build a temporary mapping for the full render to get pixel coords
    full_xmin_p, full_ymin_p, full_xmax_p, full_ymax_p = _padded_bbox_from_dxf(dxf_path, pad_frac)
    full_map = _build_mapping(fw, fh, full_xmin_p, full_ymin_p, full_xmax_p, full_ymax_p)

    # Convert block world coords to pixel coords in the full render
    pf = full_map["pixel_fit"]
    scale = pf["scale"]
    ox, oy = pf["offset_x"], pf["offset_y"]

    px0 = int(ox + (wxmin_p - full_xmin_p) * scale)
    py0 = int(oy + (full_ymax_p - wymax_p) * scale)
    px1 = int(ox + (wxmax_p - full_xmin_p) * scale)
    py1 = int(oy + (full_ymax_p - wymin_p) * scale)

    # Clamp to image bounds
    px0 = max(0, px0)
    py0 = max(0, py0)
    px1 = min(fw, px1)
    py1 = min(fh, py1)

    cropped = full_img.crop((px0, py0, px1, py1))
    cropped.save(out_png, format="PNG", optimize=True, compress_level=6)

    crop_w, crop_h = cropped.size
    full_img.close()

    # Write mapping JSON for the cropped block
    block_mapping = _build_mapping(
        width_px=crop_w,
        height_px=crop_h,
        xmin_p=wxmin_p,
        ymin_p=wymin_p,
        xmax_p=wxmax_p,
        ymax_p=wymax_p,
    )
    with open(out_json, "w", encoding="utf-8") as f:
        json.dump(block_mapping, f, indent=2)

    logger.info(
        "render_block done png=%s size=%dx%d world=[%.1f,%.1f,%.1f,%.1f]",
        out_png,
        crop_w,
        crop_h,
        wxmin,
        wymin,
        wxmax,
        wymax,
    )
