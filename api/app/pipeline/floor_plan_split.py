"""
XY-cut algorithm: split a master DXF rendering into individual floor-plan
blocks.

Flow (from Colab notebook):
 1. Load the master rendering PNG (already rendered upstream).
 2. Threshold + dilate to get a binary content mask.
 3. Recursively split along X / Y projection gaps (best-single-split).
 4. Tighten leaf boxes to actual ink pixels via findNonZero.
 5. Filter tiny boxes (< min_area_frac of image).
 6. Convert pixel boxes → DXF world coordinates using the master mapping.
 7. Re-render each block individually with per-block mapping JSON.
"""

import json
import logging
import os
import subprocess
from typing import List, Tuple

import cv2
import ezdxf
from ezdxf import bbox
import numpy as np
from PIL import Image

from app.pipeline.render import (
    _build_mapping as _build_mapping_render,
    _padded_bbox_from_dxf,
    render_dwg_to_png_with_qcad,
)

logger = logging.getLogger("firecad.pipeline.split")


# ---------------------------------------------------------------------------
# DXF sanitisation – strip hidden / frozen / Defpoints layers
# ---------------------------------------------------------------------------

def sanitize_dxf_for_qcad(input_filepath, clean_filepath="temp_clean.dxf"):
    """
    Strips hidden, frozen, and non-printing layers (like Defpoints)
    so QCAD doesn't render invisible ghost lines.
    """
    print("Sanitizing DXF: Removing hidden layers and Defpoints...")
    doc = ezdxf.readfile(input_filepath)
    msp = doc.modelspace()

    # 1. Identify layers that should NOT be visible
    invalid_layers = set()
    for layer in doc.layers:
        name = layer.dxf.name.lower()
        # 'defpoints' is AutoCAD's default non-printing layer for dimension nodes
        if not layer.is_on() or layer.is_frozen() or name == "defpoints":
            invalid_layers.add(layer.dxf.name)

    # 2. Hard-delete entities on these layers so QCAD has zero chance of seeing them
    deleted_count = 0
    for entity in list(msp):  # Cast to list so we can modify the modelspace while iterating
        if hasattr(entity.dxf, 'layer') and entity.dxf.layer in invalid_layers:
            msp.delete_entity(entity)
            deleted_count += 1

    print(f"Removed {deleted_count} invisible/ghost entities.")
    doc.saveas(clean_filepath)

    return clean_filepath


# ---------------------------------------------------------------------------
# DXF Extents Extraction (Outlier & Hidden Layer Proof via IQR)
# ---------------------------------------------------------------------------

def get_dxf_extents(filepath):
    print("Extracting accurate geometric boundaries (Filtering Outliers)...")
    doc = ezdxf.readfile(filepath)
    msp = doc.modelspace()

    # 1. Filter out layers that are turned off or frozen
    visible_layers = {layer.dxf.name for layer in doc.layers if layer.is_on() and not layer.is_frozen()}

    # Extract bounding boxes only for entities on visible layers
    valid_boxes = []
    for entity in msp:
        if entity.dxf.layer in visible_layers:
            # We wrap the entity in a list because bbox.extents expects an iterable
            ext = bbox.extents([entity])
            if ext.has_data:
                # Store: xmin, ymin, xmax, ymax
                valid_boxes.append([ext.extmin.x, ext.extmin.y, ext.extmax.x, ext.extmax.y])

    if not valid_boxes:
        print("Warning: No visible data found. Falling back to Header extents.")
        extmin = doc.header.get('$EXTMIN', (0,0,0))
        extmax = doc.header.get('$EXTMAX', (0,0,0))
        return extmin[0], extmin[1], extmax[0], extmax[1]

    # Convert to NumPy array for statistical analysis
    boxes_np = np.array(valid_boxes)

    # 2. Mathematical Outlier Removal (Interquartile Range)
    # Calculate the center X coordinate of every single object
    centers_x = (boxes_np[:, 0] + boxes_np[:, 2]) / 2.0

    # Find the core cluster of the drawing using percentiles
    Q1 = np.percentile(centers_x, 25)
    Q3 = np.percentile(centers_x, 75)
    IQR = Q3 - Q1

    # Define acceptable boundaries (1.5x IQR is standard, using 3x to be safe for spread-out floorplans)
    lower_bound_x = Q1 - (3 * IQR)
    upper_bound_x = Q3 + (3 * IQR)

    # Filter out the "Ghosts" (Entities whose centers are outside the bounds)
    core_boxes = boxes_np[(centers_x >= lower_bound_x) & (centers_x <= upper_bound_x)]

    # If the filter accidentally removes everything (rare), fallback to all visible boxes
    if len(core_boxes) == 0:
        core_boxes = boxes_np

    # 3. Calculate final tight boundaries based ONLY on the core cluster
    x_min = np.min(core_boxes[:, 0])
    y_min = np.min(core_boxes[:, 1])
    x_max = np.max(core_boxes[:, 2])
    y_max = np.max(core_boxes[:, 3])

    margin_x = (x_max - x_min) * 0.02
    margin_y = (y_max - y_min) * 0.02

    return x_min - margin_x, y_min - margin_y, x_max + margin_x, y_max + margin_y


# ---------------------------------------------------------------------------
# ANTI-MINCING RECURSIVE XY-CUT (best-single-split strategy)
# ---------------------------------------------------------------------------
def _build_mapping(width_px, height_px, xmin, ymin, xmax, ymax):
    """Simulates QCAD's silent aspect-ratio window expansion to guarantee 1:1 mapping."""
    dxf_w = float(xmax - xmin)
    dxf_h = float(ymax - ymin)

    img_ratio = width_px / float(height_px)
    dxf_ratio = dxf_w / dxf_h

    # Replicate QCAD's camera expansion to match exact pixel ratios
    if img_ratio > dxf_ratio:
        new_dxf_w = dxf_h * img_ratio
        diff = new_dxf_w - dxf_w
        xmin -= diff / 2.0
        xmax += diff / 2.0
    else:
        new_dxf_h = dxf_w / img_ratio
        diff = new_dxf_h - dxf_h
        ymin -= diff / 2.0
        ymax += diff / 2.0

    return {
        "width_px": float(width_px), "height_px": float(height_px),
        "xmin": xmin, "ymin": ymin, "xmax": xmax, "ymax": ymax
    }

def pixel_to_dxf(px, py, m):
    """Linear interpolation using the exact QCAD expanded window."""
    x_ratio = px / m["width_px"]
    y_ratio = py / m["height_px"]

    dxf_x = m["xmin"] + x_ratio * (m["xmax"] - m["xmin"])
    # Y is inverted in images (py=0 is top -> corresponds to ymax)
    dxf_y = m["ymax"] - y_ratio * (m["ymax"] - m["ymin"])
    return dxf_x, dxf_y

def recursive_xy_cut(img_thresh, x, y, w, h, min_gap_px, debug_img, depth=0):
    if depth > 25 or w < min_gap_px * 2 or h < min_gap_px * 2:
        return [(x, y, w, h)]

    roi = img_thresh[y:y+h, x:x+w]

    # Ignore outer 2% to bypass drawn frames
    margin_x = max(1, int(w * 0.02))
    margin_y = max(1, int(h * 0.02))
    core_rows = roi[:, margin_x : w - margin_x] if w > margin_x * 2 else roi
    core_cols = roi[margin_y : h - margin_y, :] if h > margin_y * 2 else roi

    row_sums = np.sum(core_rows, axis=1) / 255.0
    col_sums = np.sum(core_cols, axis=0) / 255.0

    def get_best_split(proj_array):
        noise_tolerance = 15
        valid_indices = np.where(proj_array <= noise_tolerance)[0]
        if len(valid_indices) == 0: return None, 0

        splits = np.split(valid_indices, np.where(np.diff(valid_indices) != 1)[0] + 1)
        valid_splits = [s for s in splits if len(s) >= min_gap_px]

        if not valid_splits: return None, 0
        best_split = max(valid_splits, key=len)
        return int(np.mean(best_split)), len(best_split)

    split_y, gap_y = get_best_split(row_sums)
    split_x, gap_x = get_best_split(col_sums)

    if gap_x == 0 and gap_y == 0:
        return [(x, y, w, h)]

    results = []
    line_thickness = max(1, 4 - depth)

    if gap_x >= gap_y:
        if debug_img is not None:
            cv2.line(debug_img, (x + split_x, y), (x + split_x, y + h), (0, 0, 255), line_thickness)
        results.extend(recursive_xy_cut(img_thresh, x, y, split_x, h, min_gap_px, debug_img, depth + 1))
        results.extend(recursive_xy_cut(img_thresh, x + split_x, y, w - split_x, h, min_gap_px, debug_img, depth + 1))
    else:
        if debug_img is not None:
            cv2.line(debug_img, (x, y + split_y), (x + w, y + split_y), (255, 0, 0), line_thickness)
        results.extend(recursive_xy_cut(img_thresh, x, y, w, split_y, min_gap_px, debug_img, depth + 1))
        results.extend(recursive_xy_cut(img_thresh, x, y + split_y, w, h - split_y, min_gap_px, debug_img, depth + 1))

    return results



# ---------------------------------------------------------------------------
# Pixel → DXF world coordinate conversion (handles both mapping formats)
# ---------------------------------------------------------------------------

def _pixel_to_dxf(px: float, py: float, mapping: dict) -> Tuple[float, float]:
    """Convert pixel coords to DXF world coords.

    Handles both mapping formats:
    - Colab style: uses width_px/height_px/xmin/xmax/ymin/ymax (linear interpolation)
    - render.py style: uses world_bbox + pixel_fit (scale/offset)
    """
    pf = mapping.get("pixel_fit")
    if pf and float(pf.get("scale", 0.0)) > 0.0:
        wb = mapping["world_bbox"]
        dxf_x = wb["xmin"] + (px - pf["offset_x"]) / pf["scale"]
        dxf_y = wb["ymax"] - (py - pf["offset_y"]) / pf["scale"]
        return dxf_x, dxf_y
    # Normalise: if mapping uses nested world_bbox instead of flat keys, flatten for pixel_to_dxf
    if "xmin" not in mapping and "world_bbox" in mapping:
        wb = mapping["world_bbox"]
        flat = {
            "width_px": mapping["width_px"],
            "height_px": mapping["height_px"],
            "xmin": wb["xmin"],
            "xmax": wb["xmax"],
            "ymin": wb["ymin"],
            "ymax": wb["ymax"],
        }
        return pixel_to_dxf(px, py, flat)
    return pixel_to_dxf(px, py, mapping)


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
    dilate_kernel: int = 0,
    min_gap_px: int = 0,
    pad_frac: float = 0.01,
) -> List[dict]:
    """Split the master rendering into individual floor-plan blocks.

    Uses the exact algorithm from the Colab notebook:
    - Threshold + dilate the master render
    - Recursive XY-cut with best-single-split strategy
    - Tighten leaf boxes via findNonZero
    - Convert to DXF world coords via pixel_to_dxf

    Returns a list of dicts, one per block:
        {
            "index": int,
            "pixel_bbox": [x0, y0, x1, y1],
            "world_bbox": {"xmin": ..., "ymin": ..., "xmax": ..., "ymax": ...},
            "render_png": None,
            "mapping_json": None,
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

    actual_h, actual_w = img.shape[:2]

    # Map EXACTLY to the true dimensions QCAD outputted
    master_mapping = _build_mapping(actual_w, actual_h,
                                    master_map["world_bbox"]["xmin"] if "world_bbox" in master_map else master_map.get("xmin", 0),
                                    master_map["world_bbox"]["ymin"] if "world_bbox" in master_map else master_map.get("ymin", 0),
                                    master_map["world_bbox"]["xmax"] if "world_bbox" in master_map else master_map.get("xmax", 0),
                                    master_map["world_bbox"]["ymax"] if "world_bbox" in master_map else master_map.get("ymax", 0))

    gray = cv2.cvtColor(img, cv2.COLOR_BGR2GRAY)
    _, thresh = cv2.threshold(gray, 240, 255, cv2.THRESH_BINARY_INV)

    k_size = max(3, actual_w // 600) if dilate_kernel <= 0 else dilate_kernel
    kernel = cv2.getStructuringElement(cv2.MORPH_RECT, (k_size, k_size))
    fused = cv2.dilate(thresh, kernel, iterations=1)

    min_gap = max(20, actual_w // 120) if min_gap_px <= 0 else min_gap_px

    logger.info("split xy-cut start w=%d h=%d min_gap=%d k_size=%d", actual_w, actual_h, min_gap, k_size)
    leaf_boxes = recursive_xy_cut(fused, 0, 0, actual_w, actual_h, min_gap, None)

    global_dxf_rects: list[tuple[float, float, float, float]] = []
    pixel_bboxes: list[tuple[int, int, int, int]] = []

    for (bx, by, bw, bh) in leaf_boxes:
        roi = fused[by:by+bh, bx:bx+bw]
        coords = cv2.findNonZero(roi)

        if coords is not None:
            cx, cy, cw, ch = cv2.boundingRect(coords)

            if (cw * ch) > (actual_w * actual_h * min_area_frac):
                final_px = bx + cx
                final_py = by + cy

                dxf_x1, dxf_y1 = pixel_to_dxf(final_px, final_py, master_mapping)
                dxf_x2, dxf_y2 = pixel_to_dxf(final_px + cw, final_py + ch, master_mapping)

                global_dxf_rects.append((
                    min(dxf_x1, dxf_x2), min(dxf_y1, dxf_y2),
                    max(dxf_x1, dxf_x2), max(dxf_y1, dxf_y2)
                ))
                pixel_bboxes.append((final_px, final_py, final_px + cw, final_py + ch))

    if not global_dxf_rects:
        # Fallback: entire image is one block
        dxf_x1, dxf_y1 = pixel_to_dxf(0, 0, master_mapping)
        dxf_x2, dxf_y2 = pixel_to_dxf(actual_w, actual_h, master_mapping)
        global_dxf_rects.append((
            min(dxf_x1, dxf_x2), min(dxf_y1, dxf_y2),
            max(dxf_x1, dxf_x2), max(dxf_y1, dxf_y2)
        ))
        pixel_bboxes.append((0, 0, actual_w, actual_h))

    logger.info(
        "split raw_boxes=%d after_filter=%d min_area_frac=%.4f",
        len(leaf_boxes),
        len(global_dxf_rects),
        min_area_frac,
    )

    blocks: list[dict] = []
    for idx, ((wxmin, wymin, wxmax, wymax), (bx0, by0, bx1, by1)) in enumerate(zip(global_dxf_rects, pixel_bboxes)):
        blocks.append({
            "index": idx,
            "pixel_bbox": [bx0, by0, bx1, by1],
            "world_bbox": {
                "xmin": wxmin,
                "ymin": wymin,
                "xmax": wxmax,
                "ymax": wymax,
            },
            "render_png": None,
            "mapping_json": None,
        })

    logger.info("split done blocks=%d", len(blocks))
    return blocks


# ---------------------------------------------------------------------------
# Per-block rendering (uses QCAD -window, exact Colab Section 5)
# ---------------------------------------------------------------------------

def _render_block(
    dxf_path: str,
    out_png: str,
    out_json: str,
    world_bbox: Tuple[float, float, float, float],
    target_long_side_px: int = 3000,
    pad_frac: float = 0.06,
    out_color_png: str | None = None,
):
    """Render a DXF region via QCAD -window and write a mapping JSON.

    Produces a grayscale image (out_png, with -k) for processing and optionally
    a colored image (out_color_png, without -k) for UI display.

    Uses the exact approach from the Colab notebook Section 5:
    - Applies padding to world bbox
    - Calls QCAD dwg2bmp with -window=xmin,ymin,width,height
    - Generates a mapping JSON using the QCAD aspect-ratio-aware _build_mapping
    """
    from app.pipeline.render import _qcad_env_and_launcher

    X_raw_min, Y_raw_min, X_raw_max, Y_raw_max = world_bbox

    PADDING = pad_frac
    margin_x = (X_raw_max - X_raw_min) * PADDING
    margin_y = (Y_raw_max - Y_raw_min) * PADDING

    final_x_min = X_raw_min - margin_x
    final_y_min = Y_raw_min - margin_y
    final_x_max = X_raw_max + margin_x
    final_y_max = Y_raw_max + margin_y

    crop_w = final_x_max - final_x_min
    crop_h = final_y_max - final_y_min

    # Back to standard X_min, Y_min, Width, Height
    crop_str = f"{final_x_min:.4f},{final_y_min:.4f},{crop_w:.4f},{crop_h:.4f}"

    crop_w_px = target_long_side_px
    crop_h_px = int(crop_w_px * (crop_h / crop_w))

    os.makedirs(os.path.dirname(out_png), exist_ok=True)

    exe = os.getenv("QCAD_DWG2BMP", "/opt/qcad/dwg2bmp")

    run_env, qcad_dir, build_exec_cmd = _qcad_env_and_launcher(exe)

    # Common args (without color flag and output path)
    base_args = [
        exe,
        "-platform", "offscreen",
        "-f", f"-window={crop_str}",
        "-b", "white",
        "-min-lineweight", "0.5",
        "-x", str(crop_w_px), "-y", str(crop_h_px),
        "-margin", "0",
    ]

    # 1) Render grayscale (with -k) for processing
    gray_cmd = [*base_args, "-k", "-o", out_png, dxf_path]
    logger.info("render_block GRAY QCAD -window=%s out=%s %dx%d", crop_str, out_png, crop_w_px, crop_h_px)
    subprocess.run(build_exec_cmd(gray_cmd), stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL,
                   cwd=qcad_dir, env=run_env)

    if not os.path.exists(out_png):
        logger.warning("render_block QCAD produced no output, falling back to full render + crop")
        _render_block_fallback(dxf_path, out_png, out_json, world_bbox, target_long_side_px, pad_frac)
        return

    # 2) Render colored (without -k) for UI display
    if out_color_png:
        os.makedirs(os.path.dirname(out_color_png), exist_ok=True)
        color_cmd = [*base_args, "-color-correction", "-o", out_color_png, dxf_path]
        logger.info("render_block COLOR QCAD -window=%s out=%s %dx%d", crop_str, out_color_png, crop_w_px, crop_h_px)
        subprocess.run(build_exec_cmd(color_cmd), stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL,
                       cwd=qcad_dir, env=run_env)
        if not os.path.exists(out_color_png):
            logger.warning("render_block colored render failed, UI will use grayscale")

    # Read actual dimensions QCAD outputted
    rendered = cv2.imread(out_png)
    if rendered is None:
        logger.warning("render_block cannot read output, falling back")
        _render_block_fallback(dxf_path, out_png, out_json, world_bbox, target_long_side_px, pad_frac)
        return

    actual_h_px, actual_w_px = rendered.shape[:2]

    # Generate exact mapping JSON using QCAD aspect-ratio-aware mapping
    local_mapping = _build_mapping(
        actual_w_px, actual_h_px,
        final_x_min, final_y_min, final_x_max, final_y_max
    )

    mapping_data = {
        "image_file": os.path.basename(out_png),
        "width_px": int(local_mapping["width_px"]),
        "height_px": int(local_mapping["height_px"]),
        "world_bbox": {
            "xmin": local_mapping["xmin"],
            "xmax": local_mapping["xmax"],
            "ymin": local_mapping["ymin"],
            "ymax": local_mapping["ymax"]
        }
    }

    with open(out_json, "w", encoding="utf-8") as f:
        json.dump(mapping_data, f, indent=4)

    logger.info(
        "render_block done png=%s color=%s size=%dx%d world=[%.1f,%.1f,%.1f,%.1f]",
        out_png, out_color_png or "none", actual_w_px, actual_h_px,
        X_raw_min, Y_raw_min, X_raw_max, Y_raw_max,
    )


def _render_block_fallback(
    dxf_path: str,
    out_png: str,
    out_json: str,
    world_bbox: Tuple[float, float, float, float],
    target_long_side_px: int = 3000,
    pad_frac: float = 0.06,
):
    """Fallback: render full DXF and crop to block region."""
    wxmin, wymin, wxmax, wymax = world_bbox

    span_x = max(1e-9, wxmax - wxmin)
    span_y = max(1e-9, wymax - wymin)
    wxmin_p = wxmin - pad_frac * span_x
    wxmax_p = wxmax + pad_frac * span_x
    wymin_p = wymin - pad_frac * span_y
    wymax_p = wymax + pad_frac * span_y

    render_dwg_to_png_with_qcad(
        dwg_path=dxf_path,
        out_png=out_png,
        target_long_side_px=target_long_side_px,
        background="white",
    )

    Image.MAX_IMAGE_PIXELS = None
    full_img = Image.open(out_png)
    fw, fh = full_img.size

    full_xmin_p, full_ymin_p, full_xmax_p, full_ymax_p = _padded_bbox_from_dxf(dxf_path, pad_frac)
    full_map = _build_mapping_render(fw, fh, full_xmin_p, full_ymin_p, full_xmax_p, full_ymax_p)

    pf = full_map["pixel_fit"]
    scale = pf["scale"]
    ox, oy = pf["offset_x"], pf["offset_y"]

    px0 = int(ox + (wxmin_p - full_xmin_p) * scale)
    py0 = int(oy + (full_ymax_p - wymax_p) * scale)
    px1 = int(ox + (wxmax_p - full_xmin_p) * scale)
    py1 = int(oy + (full_ymax_p - wymin_p) * scale)

    px0 = max(0, px0)
    py0 = max(0, py0)
    px1 = min(fw, px1)
    py1 = min(fh, py1)

    cropped = full_img.crop((px0, py0, px1, py1))
    cropped.save(out_png, format="PNG", optimize=True, compress_level=6)

    crop_w, crop_h = cropped.size
    full_img.close()

    block_mapping = _build_mapping_render(
        width_px=crop_w,
        height_px=crop_h,
        xmin_p=wxmin_p,
        ymin_p=wymin_p,
        xmax_p=wxmax_p,
        ymax_p=wymax_p,
    )
    with open(out_json, "w", encoding="utf-8") as f:
        json.dump(block_mapping, f, indent=2)

    logger.info("render_block_fallback done png=%s size=%dx%d", out_png, crop_w, crop_h)
