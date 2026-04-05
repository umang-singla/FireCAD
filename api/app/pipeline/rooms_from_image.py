import cv2
import numpy as np
import json
import os
import re
import threading

import ezdxf

# Based on your notebook cell (rooms_from_image)

LOWER_GREEN = np.array([40, 50, 50])
UPPER_GREEN = np.array([80, 255, 255])

LOWER_BLUE = np.array([100, 150, 50])
UPPER_BLUE = np.array([140, 255, 255])

LOWER_BLACK = np.array([0, 0, 0])
UPPER_BLACK = np.array([180, 255, 50])

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
TEXT_ENTITY_TYPES = {"TEXT", "MTEXT", "ATTRIB", "ATTDEF"}

_DXF_LABEL_CACHE: dict[str, list[dict]] = {}
_DXF_LABEL_CACHE_LOCK = threading.Lock()


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


def world_to_pixel(wx, wy, img_w, img_h, bbox, pixel_fit=None):
    xmin, xmax = bbox["xmin"], bbox["xmax"]
    ymin, ymax = bbox["ymin"], bbox["ymax"]

    if pixel_fit and float(pixel_fit.get("scale", 0.0)) > 0.0:
        scale = float(pixel_fit["scale"])
        offset_x = float(pixel_fit.get("offset_x", 0.0))
        offset_y = float(pixel_fit.get("offset_y", 0.0))
        px = int(round((float(wx) - xmin) * scale + offset_x))
        py = int(round((ymax - float(wy)) * scale + offset_y))
    else:
        if abs(xmax - xmin) < 1e-12 or abs(ymax - ymin) < 1e-12:
            return [0, 0]
        u = (float(wx) - xmin) / (xmax - xmin)
        v = (ymax - float(wy)) / (ymax - ymin)
        px = int(round(u * img_w))
        py = int(round(v * img_h))

    px = max(0, min(img_w - 1, px))
    py = max(0, min(img_h - 1, py))
    return [px, py]


def point_in_world_bbox(wx, wy, bbox, pad=0.0):
    return (
        bbox["xmin"] - pad <= wx <= bbox["xmax"] + pad
        and bbox["ymin"] - pad <= wy <= bbox["ymax"] + pad
    )


def normalize_text(text):
    if text is None:
        return ""

    text = str(text)
    text = text.replace("\u00A0", " ")
    text = text.replace("%%d", "°").replace("%%c", "Ø").replace("%%p", "±")
    text = text.replace("\\P", " ")
    text = text.replace("\\~", " ")
    text = re.sub(r"\\[A-Za-z][^;]*;?", " ", text)
    text = text.replace("{", " ").replace("}", " ")
    text = re.sub(r"\s+", " ", text).strip()
    return text


def get_entity_text(entity):
    etype = entity.dxftype()
    text = ""
    try:
        if etype == "MTEXT":
            try:
                text = entity.plain_text()
            except Exception:
                text = getattr(entity, "text", "")
        elif etype in {"TEXT", "ATTRIB", "ATTDEF"}:
            text = entity.dxf.text
    except Exception:
        text = ""
    return normalize_text(text)


def get_entity_layer(entity):
    try:
        return str(entity.dxf.layer)
    except Exception:
        return ""


def get_entity_anchor_world(entity):
    try:
        if entity.dxf.hasattr("align_point"):
            ap = entity.dxf.get("align_point")
            if ap is not None:
                ax = float(ap[0])
                ay = float(ap[1])
                if abs(ax) > 1e-12 or abs(ay) > 1e-12:
                    return [ax, ay]
    except Exception:
        pass

    try:
        ins = entity.dxf.get("insert")
        if ins is not None:
            return [float(ins[0]), float(ins[1])]
    except Exception:
        pass

    return None


def is_probable_dimension_text(text, layer_name=""):
    t = normalize_text(text)
    if not t:
        return True

    upper = t.upper()
    layer_upper = (layer_name or "").upper()

    if re.search(r"(?:^|[_\-\s])(DIM|DIMS|DIMENSION|DIMENSIONS)(?:$|[_\-\s])", layer_upper):
        return True

    compact_alnum = re.sub(r"[^A-Z0-9]", "", upper)
    if len(compact_alnum) <= 1:
        return True

    alpha_count = len(re.findall(r"[A-Z]", upper))
    digit_count = len(re.findall(r"\d", upper))

    if alpha_count == 0:
        return True

    dim_patterns = [
        r"^[\d\.,/\-]+$",
        r"^\d+(\.\d+)?\s*(MM|CM|M|MTR|METRE|METRES|FT|FEET|IN|INCH|INCHES)\.?$",
        r"^\d+(\.\d+)?\s*['′]\s*-?\s*\d*([\"″]|IN)?$",
        r"^\d+(\.\d+)?\s*[X×]\s*\d+(\.\d+)?(\s*(MM|CM|M|FT|IN))?$",
        r"^(R|RAD|DIA|Ø|%%C)\s*\d+(\.\d+)?$",
        r"^\d+(\.\d+)?\s*°$",
    ]
    for pat in dim_patterns:
        if re.fullmatch(pat, upper):
            return True

    annotation_tokens = [
        "AFFL", "AFL", "FFL", "LVL", "LEVEL", "C/L", "CL", "CENTERLINE",
        "TYP", "T.O.C", "TOC", "T.O.S", "TOS", "NTS", "SCALE", "SLOPE"
    ]
    if any(tok in upper for tok in annotation_tokens) and digit_count > 0:
        return True

    if alpha_count <= 2 and digit_count >= alpha_count + 2:
        return True

    return False


def score_label_text(text):
    t = normalize_text(text)
    words = re.findall(r"[A-Za-z]+", t)
    alpha_chars = sum(len(w) for w in words)
    digit_count = len(re.findall(r"\d", t))

    score = 0
    score += alpha_chars * 10
    score += len(words) * 15
    score += 10 if len(words) >= 2 else 0
    score += 3 if t.upper() == t and alpha_chars > 0 else 0
    score -= digit_count * 2
    return score


def iter_text_entities_from_modelspace(doc):
    msp = doc.modelspace()
    for entity in msp:
        etype = entity.dxftype()
        if etype in TEXT_ENTITY_TYPES:
            yield entity
        elif etype == "INSERT":
            for attrib in getattr(entity, "attribs", []):
                if attrib.dxftype() in TEXT_ENTITY_TYPES:
                    yield attrib
            try:
                for ve in entity.virtual_entities():
                    if ve.dxftype() in TEXT_ENTITY_TYPES:
                        yield ve
            except Exception:
                pass


def extract_candidate_labels_from_dxf(dxf_path: str):
    if not dxf_path or not os.path.exists(dxf_path):
        return []

    with _DXF_LABEL_CACHE_LOCK:
        cached = _DXF_LABEL_CACHE.get(dxf_path)
        if cached is not None:
            return cached

    labels = []
    seen = set()
    doc = ezdxf.readfile(dxf_path)
    for entity in iter_text_entities_from_modelspace(doc):
        try:
            text = get_entity_text(entity)
            if not text:
                continue

            layer_name = get_entity_layer(entity)
            if is_probable_dimension_text(text, layer_name):
                continue

            anchor = get_entity_anchor_world(entity)
            if anchor is None:
                continue

            key = (text.upper(), round(anchor[0], 3), round(anchor[1], 3))
            if key in seen:
                continue
            seen.add(key)

            labels.append({
                "text": text,
                "layer": layer_name,
                "point_world": [float(anchor[0]), float(anchor[1])],
                "score": score_label_text(text),
            })
        except Exception:
            continue

    with _DXF_LABEL_CACHE_LOCK:
        _DXF_LABEL_CACHE[dxf_path] = labels
    return labels


def build_room_label(matched_labels):
    if not matched_labels:
        return "", []

    ordered = sorted(
        matched_labels,
        key=lambda d: (d["point_px"][1], d["point_px"][0], -d["score"]),
    )

    unique_texts = []
    seen = set()
    for item in ordered:
        norm = normalize_text(item["text"]).upper()
        if norm and norm not in seen:
            unique_texts.append(item["text"])
            seen.add(norm)

    if not unique_texts:
        return "", []

    if len(unique_texts) == 1:
        return unique_texts[0], unique_texts

    total_words = sum(len(t.split()) for t in unique_texts)
    if len(unique_texts) <= 4 and total_words <= 8:
        return " ".join(unique_texts), unique_texts

    best = max(matched_labels, key=lambda d: (d["score"], len(d["text"])))
    return best["text"], unique_texts


def assign_labels_to_rooms(rooms_data, all_dxf_labels, img_w, img_h, world_bbox, pixel_fit=None):
    if not rooms_data or not all_dxf_labels:
        return 0, 0

    block_labels = []
    for label in all_dxf_labels:
        wx, wy = label["point_world"]
        if point_in_world_bbox(wx, wy, world_bbox, pad=0.0):
            label_copy = dict(label)
            label_copy["point_px"] = world_to_pixel(wx, wy, img_w, img_h, world_bbox, pixel_fit=pixel_fit)
            block_labels.append(label_copy)

    assigned_count = 0
    for room in rooms_data:
        poly_np = np.array(room["polygon_px"], dtype=np.int32)
        matched = []
        for label in block_labels:
            lx, ly = label["point_px"]
            inside = cv2.pointPolygonTest(poly_np, (float(lx), float(ly)), False)
            if inside >= 0:
                matched.append(label)

        label_text, label_texts = build_room_label(matched)
        room["label_texts"] = label_texts
        room["label_text"] = label_text
        if label_text and not room.get("label"):
            room["label"] = label_text
            assigned_count += 1

    return len(block_labels), assigned_count

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

def extract_rooms(
    mask_bgr_path: str,
    mapping_json_path: str,
    out_json_path: str,
    debug_png_path: str | None = None,
    dxf_path: str | None = None,
):
    img = cv2.imread(mask_bgr_path)
    if img is None:
        raise RuntimeError("Could not load mask image for room extraction.")
    hsv = cv2.cvtColor(img, cv2.COLOR_BGR2HSV)

    green = cv2.inRange(hsv, LOWER_GREEN, UPPER_GREEN)
    blue = cv2.inRange(hsv, LOWER_BLUE, UPPER_BLUE)
    black = cv2.inRange(hsv, LOWER_BLACK, UPPER_BLACK)

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

    # Extract door polygons from blue mask.
    door_contours, _ = cv2.findContours(blue, cv2.RETR_EXTERNAL, cv2.CHAIN_APPROX_SIMPLE)
    doors: list[dict] = []
    for i, dc in enumerate(door_contours):
        area = cv2.contourArea(dc)
        if area <= 10:
            continue

        x, y, w, h = cv2.boundingRect(dc)
        m = cv2.moments(dc)
        if m["m00"] != 0:
            cx_mass = m["m10"] / m["m00"]
            cy_mass = m["m01"] / m["m00"]
        else:
            cx_mass = x + w / 2.0
            cy_mass = y + h / 2.0

        cx_box = x + w / 2.0
        cy_box = y + h / 2.0
        px = x if cx_mass < cx_box else x + w
        py = y if cy_mass < cy_box else y + h

        approx = cv2.approxPolyDP(dc, EPSILON_TIGHT, True)
        poly_px = approx.reshape(-1, 2).tolist()
        poly_world = [pixel_to_world(p[0], p[1], W, H, bbox, pixel_fit=pixel_fit) for p in poly_px]

        doors.append(
            {
                "door_id": len(doors) + 1,
                "bbox_px": [int(x), int(y), int(w), int(h)],
                "pivot_px": [int(px), int(py)],
                "polygon_px": [[int(p[0]), int(p[1])] for p in poly_px],
                "polygon_world": [[float(p[0]), float(p[1])] for p in poly_world],
            }
        )

    # Extract staircase polygons from black mask.
    black_kernel = cv2.getStructuringElement(cv2.MORPH_RECT, (2, 2))
    black_clean = cv2.morphologyEx(black, cv2.MORPH_CLOSE, black_kernel)
    stair_contours, _ = cv2.findContours(black_clean, cv2.RETR_EXTERNAL, cv2.CHAIN_APPROX_SIMPLE)
    staircases: list[dict] = []
    for sc in stair_contours:
        area = cv2.contourArea(sc)
        if area < MIN_AREA_PX:
            continue

        approx = cv2.approxPolyDP(sc, EPSILON_TIGHT, True)
        poly_px = approx.reshape(-1, 2).tolist()
        poly_world = [pixel_to_world(p[0], p[1], W, H, bbox, pixel_fit=pixel_fit) for p in poly_px]

        m = cv2.moments(approx)
        if m["m00"] != 0:
            c_x = int(m["m10"] / m["m00"])
            c_y = int(m["m01"] / m["m00"])
        else:
            c_x, c_y = 0, 0

        centroid_world = pixel_to_world(c_x, c_y, W, H, bbox, pixel_fit=pixel_fit)
        staircases.append(
            {
                "staircase_id": len(staircases) + 1,
                "area_px": float(area),
                "centroid_px": [int(c_x), int(c_y)],
                "centroid_world": [float(centroid_world[0]), float(centroid_world[1])],
                "polygon_px": [[int(p[0]), int(p[1])] for p in poly_px],
                "polygon_world": [[float(p[0]), float(p[1])] for p in poly_world],
            }
        )

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
        m = cv2.moments(approx)
        if m["m00"] != 0:
            c_x = int(m["m10"] / m["m00"])
            c_y = int(m["m01"] / m["m00"])
        else:
            c_x, c_y = 0, 0
        centroid_world = pixel_to_world(c_x, c_y, W, H, bbox, pixel_fit=pixel_fit)

        rooms.append({
            "id": f"room_{i}",
            "room_id": len(rooms) + 1,
            "area_px": float(area),
            "centroid_px": [int(c_x), int(c_y)],
            "centroid_world": [float(centroid_world[0]), float(centroid_world[1])],
            "polygon_px": pts_px,
            "polygon_world": pts_w,
            "label_texts": [],
            "label_text": "",
        })

        cv2.drawContours(dbg, [approx], -1, (0,0,255), 2)
        for t in anticlockwise_turns:
            cv2.circle(dbg, (int(t[0]), int(t[1])), 2, (255, 0, 255), -1)

    # Assign room labels from DXF text anchors, if a DXF path is available.
    if dxf_path:
        try:
            all_dxf_labels = extract_candidate_labels_from_dxf(dxf_path)
            assign_labels_to_rooms(
                rooms_data=rooms,
                all_dxf_labels=all_dxf_labels,
                img_w=W,
                img_h=H,
                world_bbox=bbox,
                pixel_fit=pixel_fit,
            )
        except Exception:
            # Keep extraction resilient: rooms should still be returned even if labeling fails.
            pass

    with open(out_json_path, "w", encoding="utf-8") as f:
        json.dump({"rooms": rooms, "doors": doors, "staircases": staircases}, f, indent=2)

    if debug_png_path:
        cv2.imwrite(debug_png_path, dbg)

    return rooms
