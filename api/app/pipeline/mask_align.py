import cv2
import numpy as np
import math

def get_pixel_perfect_components(image, is_mask=False):
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

    kernel_fill = np.ones((15, 15), np.uint8)
    dense_blob = cv2.dilate(thresh, kernel_fill, iterations=3)
    cnts, _ = cv2.findContours(dense_blob, cv2.RETR_EXTERNAL, cv2.CHAIN_APPROX_SIMPLE)

    img_area = image.shape[0] * image.shape[1]
    components = []
    for c in cnts:
        if cv2.contourArea(c) < (img_area * 0.01):
            continue
        bx, by, bw, bh = cv2.boundingRect(c)
        roi_strict = thresh[by:by+bh, bx:bx+bw]
        points = cv2.findNonZero(roi_strict)
        if points is not None:
            tx, ty, tw, th = cv2.boundingRect(points)
            exact_x = bx + tx
            exact_y = by + ty
            if tw > 0 and th > 0:
                components.append({'box': (exact_x, exact_y, tw, th)})
    return components

def _center(box):
    x,y,w,h = box
    return (x + w/2, y + h/2)

def align_perfect_tight_box(input_png: str, mask_png: str, out_aligned_png: str,
                            overlay_debug: str | None = None, boxes_debug: str | None = None):
    input_img = cv2.imread(input_png)
    mask_img = cv2.imread(mask_png)

    if input_img is None or mask_img is None:
        raise RuntimeError("Could not load input/mask images.")

    in_comps = get_pixel_perfect_components(input_img, is_mask=False)
    mk_comps = get_pixel_perfect_components(mask_img, is_mask=True)

    final_mask = np.zeros_like(input_img)
    debug_img = input_img.copy()

    matched_pairs = []
    for ic in in_comps:
        icc = _center(ic['box'])
        best = None
        best_dist = float("inf")
        for mc in mk_comps:
            mcc = _center(mc['box'])
            d = math.hypot(icc[0]-mcc[0], icc[1]-mcc[1])
            if d < best_dist:
                best_dist = d
                best = mc
        if best is not None:
            matched_pairs.append((ic, best))

    for i,(ic,mc) in enumerate(matched_pairs):
        ix,iy,iw,ih = ic['box']
        mx,my,mw,mh = mc['box']
        mask_crop = mask_img[my:my+mh, mx:mx+mw]
        resized = cv2.resize(mask_crop, (iw, ih), interpolation=cv2.INTER_NEAREST)
        final_mask[iy:iy+ih, ix:ix+iw] = resized

        cv2.rectangle(debug_img, (ix,iy), (ix+iw,iy+ih), (0,255,0), 2)
        cv2.putText(debug_img, f"Plan {i+1} Locked", (ix, max(0,iy-10)),
                    cv2.FONT_HERSHEY_SIMPLEX, 0.7, (0,255,0), 2)

    cv2.imwrite(out_aligned_png, final_mask)
    if overlay_debug:
        overlay = cv2.addWeighted(input_img, 0.6, final_mask, 0.4, 0)
        cv2.imwrite(overlay_debug, overlay)
    if boxes_debug:
        cv2.imwrite(boxes_debug, debug_img)
