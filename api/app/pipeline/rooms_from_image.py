import cv2
import numpy as np
import json
import os

# Based on your notebook cell (rooms_from_image)

LOWER_GREEN = np.array([40, 50, 50])
UPPER_GREEN = np.array([80, 255, 255])

LOWER_BLUE = np.array([100, 150, 50])
UPPER_BLUE = np.array([140, 255, 255])

MIN_AREA_PX = 500
EPSILON_TIGHT = 1.5
EPSILON_FINAL = 4.0
SNAP_GAP_PX = 9
CONVEX_TURN_EPS = 1.8
CONVEX_SNAP_DIST_PX = 10
TURN_CROSS_EPS = 1e-4
TURN_MIN_EDGE_LEN_PX = 0.5
CONVEX_SUPPORT_RADIUS_PX = 3
BLUE_SNAP_RADIUS_PX = 5
BLUE_SNAP_DIST_MULTIPLIER = 1.8


def snap_tiny_wall_gaps(mask: np.ndarray, max_gap_px: int = SNAP_GAP_PX) -> np.ndarray:
    """Snap short breaks between nearby wall endpoints.

    This is intentionally conservative: only tiny gaps are bridged, which helps
    prevent room-boundary leaks caused by anti-aliasing or near-touching corners.
    """
    if max_gap_px < 3:
        return mask

    # Keep kernel size odd for symmetric morphology behavior.
    if (max_gap_px % 2) == 0:
        max_gap_px += 1

    gap_kernel = cv2.getStructuringElement(cv2.MORPH_ELLIPSE, (max_gap_px, max_gap_px))
    snapped = cv2.morphologyEx(mask, cv2.MORPH_CLOSE, gap_kernel, iterations=1)

    # Extra directional snapping helps close near-missed orthogonal wall joints.
    kernel_h = cv2.getStructuringElement(cv2.MORPH_RECT, (max_gap_px, 1))
    kernel_v = cv2.getStructuringElement(cv2.MORPH_RECT, (1, max_gap_px))
    kernel_d1 = np.eye(max_gap_px, dtype=np.uint8)
    kernel_d2 = np.fliplr(kernel_d1)
    snap_h = cv2.morphologyEx(mask, cv2.MORPH_CLOSE, kernel_h, iterations=1)
    snap_v = cv2.morphologyEx(mask, cv2.MORPH_CLOSE, kernel_v, iterations=1)
    snap_d1 = cv2.morphologyEx(mask, cv2.MORPH_CLOSE, kernel_d1, iterations=1)
    snap_d2 = cv2.morphologyEx(mask, cv2.MORPH_CLOSE, kernel_d2, iterations=1)
    snapped = cv2.bitwise_or(snapped, cv2.bitwise_or(snap_h, snap_v))
    snapped = cv2.bitwise_or(snapped, cv2.bitwise_or(snap_d1, snap_d2))

    # Remove tiny isolated specks without breaking freshly snapped bridges.
    n_labels, labels, stats, _ = cv2.connectedComponentsWithStats(snapped, connectivity=8)
    min_keep_area = max(4, max_gap_px // 2)
    cleaned = np.zeros_like(snapped)
    for label in range(1, n_labels):
        area = int(stats[label, cv2.CC_STAT_AREA])
        if area >= min_keep_area:
            cleaned[labels == label] = 255
    snapped = cleaned
    return snapped


def _dedupe_ring_points(pts: list[list[int]]) -> list[list[int]]:
    out: list[list[int]] = []
    for p in pts:
        ip = [int(p[0]), int(p[1])]
        if not out or out[-1] != ip:
            out.append(ip)
    if len(out) > 1 and out[0] == out[-1]:
        out.pop()
    return out


def _signed_area_math(pts: np.ndarray) -> float:
    """Signed area in math coordinates (y-up)."""
    if len(pts) < 3:
        return 0.0
    area = 0.0
    for i in range(len(pts)):
        x1, y1 = float(pts[i][0]), float(-pts[i][1])
        x2, y2 = float(pts[(i + 1) % len(pts)][0]), float(-pts[(i + 1) % len(pts)][1])
        area += x1 * y2 - x2 * y1
    return 0.5 * area


def find_anticlockwise_turns(contour: np.ndarray, eps: float = CONVEX_TURN_EPS) -> list[list[int]]:
    """Traverse contour and collect turn points using place_detectors reflex logic."""
    # We use a smaller eps so we don't miss obvious sharp corners.
    approx = cv2.approxPolyDP(contour, 1.0, True)
    pts = approx.reshape(-1, 2).astype(np.float32)
    if len(pts) < 3:
        return []

    # Match place_detectors_advanced: if ring is CCW, reverse to enforce CW traversal.
    # (computed in math coordinates, y-up)
    if _signed_area_math(pts) > 0:
        pts = pts[::-1]

    turns: list[list[int]] = []
    for i in range(len(pts)):
        prev_pt = pts[(i - 1) % len(pts)]
        curr_pt = pts[i]
        next_pt = pts[(i + 1) % len(pts)]

        # Use math coordinates (y-up) for robust anti-clockwise turn detection.
        prev_m = np.array([prev_pt[0], -prev_pt[1]], dtype=np.float32)
        curr_m = np.array([curr_pt[0], -curr_pt[1]], dtype=np.float32)
        next_m = np.array([next_pt[0], -next_pt[1]], dtype=np.float32)

        v1 = curr_m - prev_m
        v2 = next_m - curr_m

        n1 = float(np.linalg.norm(v1))
        n2 = float(np.linalg.norm(v2))
        if n1 < TURN_MIN_EDGE_LEN_PX or n2 < TURN_MIN_EDGE_LEN_PX:
            continue

        cross = float(v1[0] * v2[1] - v1[1] * v2[0])
        # We capture left turns (reflex) and right turns (convex) 
        # that are reasonably sharp (> ~1e-4 area).
        if abs(cross) <= TURN_CROSS_EPS:
            continue

        turns.append([int(round(curr_pt[0])), int(round(curr_pt[1]))])

    return _dedupe_ring_points(turns)


def _has_snap_support(mask: np.ndarray | None, point: list[int], radius: int = CONVEX_SUPPORT_RADIUS_PX) -> bool:
    if mask is None:
        return True
    if radius < 0:
        radius = 0
    h, w = mask.shape[:2]
    x = int(point[0])
    y = int(point[1])
    x0 = max(0, x - radius)
    y0 = max(0, y - radius)
    x1 = min(w, x + radius + 1)
    y1 = min(h, y + radius + 1)
    if x0 >= x1 or y0 >= y1:
        return False
    roi = mask[y0:y1, x0:x1]
    return bool(np.any(roi > 0))


def _has_blue_near_point(blue_mask: np.ndarray | None, point: list[int], radius: int = BLUE_SNAP_RADIUS_PX) -> bool:
    if blue_mask is None:
        return False
    h, w = blue_mask.shape[:2]
    x = int(point[0])
    y = int(point[1])
    x0 = max(0, x - radius)
    y0 = max(0, y - radius)
    x1 = min(w, x + radius + 1)
    y1 = min(h, y + radius + 1)
    if x0 >= x1 or y0 >= y1:
        return False
    return bool(np.any(blue_mask[y0:y1, x0:x1] > 0))


def _point_to_segment_dist2(p, a, b):
    a = np.array(a, dtype=float)
    b = np.array(b, dtype=float)
    p = np.array(p, dtype=float)
    ab = b - a
    ap = p - a
    ab_norm = np.dot(ab, ab)
    if ab_norm < 1e-8:
        return float(np.dot(ap, ap)), 0.0
    t = float(np.dot(ap, ab) / ab_norm)
    t = max(0.0, min(1.0, t))
    closest = a + t * ab
    return float(np.sum((p - closest)**2)), t


def snap_polygon_points_to_anticlockwise_turns(
    pts_px: list[list[int]],
    anticlockwise_turns: list[list[int]],
    support_mask: np.ndarray | None = None,
    blue_mask: np.ndarray | None = None,
    snap_dist_px: float = CONVEX_SNAP_DIST_PX,
) -> list[list[int]]:
    """Snap polygon points to nearby turns, inserting them if needed."""
    if not pts_px or not anticlockwise_turns:
        return pts_px

    snapped: list[list[int]] = [[int(round(p[0])), int(round(p[1]))] for p in pts_px]
    max_d2 = float(snap_dist_px) * float(snap_dist_px)
    max_d2_blue = float(snap_dist_px * BLUE_SNAP_DIST_MULTIPLIER) * float(snap_dist_px * BLUE_SNAP_DIST_MULTIPLIER)

    for turn in anticlockwise_turns:
        blue_priority = _has_blue_near_point(blue_mask, turn)
        if (not blue_priority) and (not _has_snap_support(support_mask, turn)):
            continue

        allow_d2 = max_d2_blue if blue_priority else max_d2
        
        # Find the closest segment
        min_d2 = float('inf')
        best_idx = 0
        best_t = 0.0
        n = len(snapped)
        
        for i in range(n):
            a = snapped[i]
            b = snapped[(i + 1) % n]
            d2, t = _point_to_segment_dist2(turn, a, b)
            if d2 < min_d2:
                min_d2 = d2
                best_idx = i
                best_t = t
                
        if min_d2 > allow_d2:
            continue
            
        turn_int = [int(round(turn[0])), int(round(turn[1]))]
        
        # If it's very close to an existing vertex, just move the vertex
        if best_t < 0.1:
            snapped[best_idx] = turn_int
        elif best_t > 0.9:
            snapped[(best_idx + 1) % n] = turn_int
        else:
            # Insert the point into the polygon
            snapped.insert(best_idx + 1, turn_int)

    snapped = _dedupe_ring_points(snapped)
    if len(snapped) < 3:
        return pts_px
    return snapped

def load_mapping(mapping_path: str):
    with open(mapping_path, "r", encoding="utf-8") as f:
        data = json.load(f)
    return data

def pixel_to_world(px, py, img_w, img_h, bbox, pixel_fit=None):
    xmin, xmax = bbox["xmin"], bbox["xmax"]
    ymin, ymax = bbox["ymin"], bbox["ymax"]

    if pixel_fit and float(pixel_fit.get("scale", 0.0)) > 0.0:
        scale = float(pixel_fit["scale"])
        offset_x = float(pixel_fit.get("offset_x", 0.0))
        offset_y = float(pixel_fit.get("offset_y", 0.0))
        wx = xmin + (float(px) - offset_x) / scale
        wy = ymax - (float(py) - offset_y) / scale
        return [wx, wy]

    u = px / img_w
    v = py / img_h
    wx = xmin + u * (xmax - xmin)
    wy = ymax - v * (ymax - ymin)
    return [wx, wy]

def extract_rooms(mask_bgr_path: str, mapping_json_path: str, out_json_path: str, debug_png_path: str | None = None):
    img = cv2.imread(mask_bgr_path)
    if img is None:
        raise RuntimeError("Could not load mask image for room extraction.")
    hsv = cv2.cvtColor(img, cv2.COLOR_BGR2HSV)

    green = cv2.inRange(hsv, LOWER_GREEN, UPPER_GREEN)
    blue = cv2.inRange(hsv, LOWER_BLUE, UPPER_BLUE)

    # Dilate blue areas (doors) slightly before subtracting them from the room.
    # This seals tiny gaps between the door arc and the adjacent red wall, 
    # preventing rooms from leaking out around the hinges.
    door_kernel = cv2.getStructuringElement(cv2.MORPH_ELLIPSE, (15, 15))
    blue_dilated = cv2.dilate(blue, door_kernel, iterations=1)

    # Remove doors from green
    green_no_doors = cv2.bitwise_and(green, cv2.bitwise_not(blue_dilated))

    # Close small gaps and snap tiny near-touching endpoints to avoid leaks.
    # We do this by applying logic to the INVERTED mask (the walls)
    walls_mask = cv2.bitwise_not(green_no_doors)
    base_kernel = cv2.getStructuringElement(cv2.MORPH_ELLIPSE, (5, 5))
    walls_closed = cv2.morphologyEx(walls_mask, cv2.MORPH_CLOSE, base_kernel, iterations=2)
    walls_snapped = snap_tiny_wall_gaps(walls_closed)
    
    # Invert back to get the cleaned room mask
    green_clean = cv2.bitwise_not(walls_snapped)

    cnts, _ = cv2.findContours(green_clean, cv2.RETR_EXTERNAL, cv2.CHAIN_APPROX_SIMPLE)

    mapping = load_mapping(mapping_json_path)
    bbox = mapping["world_bbox"]
    W = int(mapping["width_px"])
    H = int(mapping["height_px"])
    pixel_fit = mapping.get("pixel_fit")

    rooms = []
    dbg = img.copy()
    for i,c in enumerate(cnts):
        area = cv2.contourArea(c)
        if area < MIN_AREA_PX:
            continue

        anticlockwise_turns = find_anticlockwise_turns(c)

        # Tight polygon
        eps = EPSILON_FINAL
        approx = cv2.approxPolyDP(c, eps, True)

        # Convert to world coords
        pts_px = approx.reshape(-1,2).tolist()
        pts_px = snap_polygon_points_to_anticlockwise_turns(
            pts_px,
            anticlockwise_turns,
            support_mask=green_clean,
            blue_mask=blue,
        )
        pts_w = [pixel_to_world(p[0], p[1], W, H, bbox, pixel_fit=pixel_fit) for p in pts_px]

        rooms.append({
            "id": f"room_{i}",
            "area_px": float(area),
            "polygon_px": pts_px,
            "polygon_world": pts_w,
        })

        cv2.drawContours(dbg, [approx], -1, (0,0,255), 2)
        for t in anticlockwise_turns:
            cv2.circle(dbg, (int(t[0]), int(t[1])), 2, (255, 0, 255), -1)

    with open(out_json_path, "w", encoding="utf-8") as f:
        json.dump({"rooms": rooms}, f, indent=2)

    if debug_png_path:
        cv2.imwrite(debug_png_path, dbg)

    return rooms
