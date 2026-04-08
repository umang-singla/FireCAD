import cv2
import numpy as np
import logging
from PIL import Image

from .gemini_mask import (
    detect_marker_centers,
    get_marker_target_points,
    remove_markers_from_mask,
    MARKER_SIZE,
)

logger = logging.getLogger("firecad.pipeline.mask_align")

def get_tight_components(image, is_mask=False):
    """Detect floor-plan components and return tight boxes sorted in stable reading order."""
    if len(image.shape) == 3:
        gray = cv2.cvtColor(image, cv2.COLOR_BGR2GRAY)
    else:
        gray = image

    if is_mask:
        if np.mean(gray) > 127:
            gray = cv2.bitwise_not(gray)
        _, thresh = cv2.threshold(gray, 40, 255, cv2.THRESH_BINARY)
    else:
        vals, counts = np.unique(gray, return_counts=True)
        bg_color = vals[np.argmax(counts)]
        diff = cv2.absdiff(gray, int(bg_color))
        _, thresh = cv2.threshold(diff, 25, 255, cv2.THRESH_BINARY)

    if is_mask:
        kernel_sever = np.ones((3, 3), np.uint8)
        base = cv2.morphologyEx(thresh, cv2.MORPH_ERODE, kernel_sever, iterations=1)
    else:
        base = thresh

    kernel_fill = np.ones((15, 15), np.uint8)
    dense_blob = cv2.dilate(base, kernel_fill, iterations=3)
    cnts, _ = cv2.findContours(dense_blob, cv2.RETR_EXTERNAL, cv2.CHAIN_APPROX_SIMPLE)

    img_area = image.shape[0] * image.shape[1]
    refined_boxes = []

    for c in cnts:
        if cv2.contourArea(c) < (img_area * 0.01):
            continue
        bx, by, bw, bh = cv2.boundingRect(c)
        roi = thresh[by:by+bh, bx:bx+bw]
        non_zero_pts = cv2.findNonZero(roi)
        if non_zero_pts is not None:
            tx, ty, tw, th = cv2.boundingRect(non_zero_pts)
            if tw > 0 and th > 0:
                refined_boxes.append((bx + tx, by + ty, tw, th))

    refined_boxes.sort(key=lambda b: (b[1] // 50, b[0]))
    return refined_boxes


def _box_center(box):
    x, y, w, h = box
    return (x + w / 2.0, y + h / 2.0)


def _pair_boxes_by_layout(in_boxes, mk_boxes):
    """Pair boxes by dominant layout axis to avoid cross-plan swaps."""
    pair_count = min(len(in_boxes), len(mk_boxes))
    if pair_count == 0:
        return []

    in_centers = [_box_center(b) for b in in_boxes]
    in_xs = [c[0] for c in in_centers]
    in_ys = [c[1] for c in in_centers]
    spread_x = max(in_xs) - min(in_xs) if len(in_xs) > 1 else 0.0
    spread_y = max(in_ys) - min(in_ys) if len(in_ys) > 1 else 0.0

    if spread_x >= spread_y:
        in_sorted = sorted(in_boxes, key=lambda b: _box_center(b)[0])
        mk_sorted = sorted(mk_boxes, key=lambda b: _box_center(b)[0])
        axis = "x"
    else:
        in_sorted = sorted(in_boxes, key=lambda b: _box_center(b)[1])
        mk_sorted = sorted(mk_boxes, key=lambda b: _box_center(b)[1])
        axis = "y"

    logger.info("mask_align pairing axis=%s input=%s mask=%s", axis, len(in_boxes), len(mk_boxes))
    return list(zip(in_sorted[:pair_count], mk_sorted[:pair_count]))


def get_pixel_perfect_components(image, is_mask=False):
    """Compatibility wrapper returning [{'box': (...)}] format."""
    return [{"box": box} for box in get_tight_components(image, is_mask=is_mask)]


def _try_marker_alignment(mask_img, target_shape, marker_size=MARKER_SIZE):
    """Attempt perspective-transform alignment using corner markers.

    Returns the aligned mask (BGR ndarray matching target_shape) or None
    if fewer than 4 markers were detected in the mask.
    """
    mask_pil = Image.fromarray(cv2.cvtColor(mask_img, cv2.COLOR_BGR2RGB))
    src_pts = detect_marker_centers(mask_pil)
    if src_pts is None:
        return None

    h, w = target_shape[:2]
    dst_pts = get_marker_target_points(w, h, marker_size)

    M = cv2.getPerspectiveTransform(src_pts, dst_pts)
    aligned = cv2.warpPerspective(
        mask_img, M, (w, h),
        flags=cv2.INTER_NEAREST,
        borderMode=cv2.BORDER_CONSTANT,
        borderValue=(0, 0, 0),
    )

    # Remove marker remnants from the aligned mask
    aligned = remove_markers_from_mask(aligned, marker_size)
    logger.info("mask_align marker-based alignment succeeded target=%sx%s", w, h)
    return aligned


def align_perfect_tight_box(input_png: str, mask_png: str, out_aligned_png: str,
                            overlay_debug: str | None = None, boxes_debug: str | None = None):
    input_img = cv2.imread(input_png)
    mask_img = cv2.imread(mask_png)

    if input_img is None or mask_img is None:
        raise RuntimeError("Could not load input/mask images.")

    # ── Try marker-based perspective alignment first ───────────
    aligned_via_markers = _try_marker_alignment(mask_img, input_img.shape)
    if aligned_via_markers is not None:
        cv2.imwrite(out_aligned_png, aligned_via_markers)
        if overlay_debug:
            overlay = cv2.addWeighted(input_img, 0.6, aligned_via_markers, 0.4, 0)
            cv2.imwrite(overlay_debug, overlay)
        logger.info("mask_align done (marker path) output=%s", out_aligned_png)
        return

    # ── Fallback: tight-box component matching ─────────────────
    logger.info("mask_align markers not detected, falling back to tight-box alignment")

    if mask_img.shape[:2] != input_img.shape[:2]:
        logger.info(
            "mask_align resize mask from=%sx%s to=%sx%s",
            mask_img.shape[1],
            mask_img.shape[0],
            input_img.shape[1],
            input_img.shape[0],
        )
        mask_img = cv2.resize(mask_img, (input_img.shape[1], input_img.shape[0]), interpolation=cv2.INTER_NEAREST)

    in_boxes = get_tight_components(input_img, is_mask=False)
    mk_boxes = get_tight_components(mask_img, is_mask=True)
    logger.info(
        "mask_align detected input_components=%s mask_components=%s",
        len(in_boxes),
        len(mk_boxes),
    )

    if len(in_boxes) != len(mk_boxes):
        logger.warning(
            "mask_align count mismatch input=%s mask=%s (zip pairing will align min count)",
            len(in_boxes),
            len(mk_boxes),
        )

    final_mask = np.zeros_like(input_img)
    debug_img = input_img.copy()

    paired_boxes = _pair_boxes_by_layout(in_boxes, mk_boxes)

    matched_count = 0
    for i, (in_box, mk_box) in enumerate(paired_boxes):
        ix, iy, iw, ih = in_box
        mx, my, mw, mh = mk_box
        if iw <= 0 or ih <= 0 or mw <= 0 or mh <= 0:
            continue
        mask_crop = mask_img[my:my+mh, mx:mx+mw]
        if mask_crop.size == 0:
            continue
        resized = cv2.resize(mask_crop, (iw, ih), interpolation=cv2.INTER_NEAREST)
        final_mask[iy:iy+ih, ix:ix+iw] = resized
        matched_count += 1

        cv2.rectangle(debug_img, (ix, iy), (ix+iw, iy+ih), (0, 255, 0), 2)
        cv2.putText(debug_img, f"Plan {i+1}", (ix, max(0, iy-10)),
                    cv2.FONT_HERSHEY_SIMPLEX, 0.7, (0, 255, 0), 2)

    cv2.imwrite(out_aligned_png, final_mask)
    if overlay_debug:
        overlay = cv2.addWeighted(input_img, 0.6, final_mask, 0.4, 0)
        cv2.imwrite(overlay_debug, overlay)
    if boxes_debug:
        cv2.imwrite(boxes_debug, debug_img)

    logger.info("mask_align done output=%s matched_pairs=%s", out_aligned_png, matched_count)
