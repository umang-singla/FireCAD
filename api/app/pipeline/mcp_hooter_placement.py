import logging
import math
import os
from typing import Dict, List, Tuple

from shapely.affinity import rotate
from shapely.geometry import LinearRing, LineString, Point, Polygon
from shapely.ops import nearest_points, split, unary_union
from shapely.validation import make_valid

logger = logging.getLogger("firecad.pipeline.mcp_hooter")

# Geometry defaults adapted from notebook logic.
MIN_REGION_AREA_M2 = 2.5
MIN_WALL_LENGTH_M = 0.05
CORRIDOR_RATIO_THRESHOLD = 3.0
LONG_CORRIDOR_LENGTH_M = 15.0
DEDUP_DIST_M = 2.0

_EGRESS_KEYWORDS = {
    "CORRIDOR", "LOBBY", "PASSAGE", "EXIT", "ENTRANCE", "HALL", "STAIR", "FIRE", "ESCAPE", "RECEPTION"
}
_PRIVATE_KEYWORDS = {
    "TOILET", "WASHROOM", "BATH", "PANTRY", "STORE", "STORAGE", "AHU", "ELECTRICAL", "SHAFT", "DUCT"
}

_EGRESS_CACHE: Dict[str, bool] = {}


def _ensure_single_polygon(geom):
    if geom is None or geom.is_empty:
        return None
    if geom.geom_type == "Polygon":
        return geom
    if geom.geom_type in ("MultiPolygon", "GeometryCollection"):
        parts = list(geom.geoms) if geom.geom_type == "MultiPolygon" else [
            g for g in geom.geoms if g.geom_type in ("Polygon", "MultiPolygon")
        ]
        flat: List[Polygon] = []
        for p in parts:
            if p.geom_type == "MultiPolygon":
                flat.extend(list(p.geoms))
            else:
                flat.append(p)
        if not flat:
            return None
        return max(flat, key=lambda p: p.area)
    return None


def _parse_polygon(poly_coords):
    if not poly_coords or len(poly_coords) < 3:
        return None
    poly = Polygon(poly_coords)
    if not poly.is_valid:
        poly = make_valid(poly)
    return _ensure_single_polygon(poly)


def _classify_egress(label_text: str, gemini_model: str | None = None) -> bool:
    label = (label_text or "").strip()
    if not label:
        return False
    key = label.upper()
    if key in _EGRESS_CACHE:
        return _EGRESS_CACHE[key]

    if any(k in key for k in _EGRESS_KEYWORDS):
        _EGRESS_CACHE[key] = True
        return True
    if any(k in key for k in _PRIVATE_KEYWORDS):
        _EGRESS_CACHE[key] = False
        return False

    api_key = os.getenv("GEMINI_API_KEY", "").strip()
    if not api_key:
        _EGRESS_CACHE[key] = False
        return False

    try:
        from google import genai

        prompt = (
            "You are a fire safety engineer. "
            f"Is a room labeled '{label}' typically an egress route/passsage/lobby/entrance/exit? "
            "Reply ONLY with YES or NO."
        )
        client = genai.Client(api_key=api_key)
        model = gemini_model or "gemini-2.5-flash-lite"
        resp = client.models.generate_content(model=model, contents=prompt)
        text = (getattr(resp, "text", "") or "").strip().upper()
        approved = "YES" in text
        _EGRESS_CACHE[key] = approved
        return approved
    except (ImportError, AttributeError, RuntimeError, ValueError) as ex:
        logger.warning("egress classification fallback for '%s': %s", label, ex)
        _EGRESS_CACHE[key] = False
        return False


def _get_longest_wall_angle(poly: Polygon):
    coords = list(poly.exterior.coords)
    max_len = 0.0
    best_angle = 0.0
    for i in range(len(coords) - 1):
        dx = coords[i + 1][0] - coords[i][0]
        dy = coords[i + 1][1] - coords[i][1]
        seg_len = math.hypot(dx, dy)
        if seg_len > max_len:
            max_len = seg_len
            best_angle = math.atan2(dy, dx)
    return best_angle, poly.centroid.coords[0]


def _get_reflex_vertices(poly: Polygon, world_to_m: float):
    coords = list(poly.exterior.coords)
    if LinearRing(coords).is_ccw:
        coords = coords[::-1]

    reflex = []
    n = len(coords) - 1
    min_len = MIN_WALL_LENGTH_M / world_to_m
    for i in range(n):
        p_prev = coords[i - 1]
        p_curr = coords[i]
        p_next = coords[(i + 1) % n]

        v1_x = p_curr[0] - p_prev[0]
        v1_y = p_curr[1] - p_prev[1]
        v2_x = p_next[0] - p_curr[0]
        v2_y = p_next[1] - p_curr[1]

        if math.hypot(v1_x, v1_y) < min_len or math.hypot(v2_x, v2_y) < min_len:
            continue
        if (v1_x * v2_y) - (v1_y * v2_x) > 1e-4:
            reflex.append((p_curr, p_prev, p_next))
    return reflex


def _split_at_reflex(poly: Polygon, reflex_data):
    b, a, c = reflex_data
    v1_x, v1_y = b[0] - a[0], b[1] - a[1]
    v2_x, v2_y = b[0] - c[0], b[1] - c[1]

    directions = []
    for vx, vy in ((v1_x, v1_y), (v2_x, v2_y)):
        if abs(vx) > abs(vy):
            directions.append((math.copysign(1.0, vx), 0.0))
        else:
            directions.append((0.0, math.copysign(1.0, vy)))

    minx, miny, maxx, maxy = poly.bounds
    max_dist = max(maxx - minx, maxy - miny) + 1.0
    boundary = poly.boundary

    best_cut = None
    min_dist = float("inf")

    for dx, dy in directions:
        ray = LineString([(b[0], b[1]), (b[0] + dx * max_dist, b[1] + dy * max_dist)])
        inter = boundary.intersection(ray)
        if inter.is_empty:
            continue

        if inter.geom_type == "Point":
            points = [inter]
        elif hasattr(inter, "geoms"):
            points = [p for p in inter.geoms if p.geom_type == "Point"]
        else:
            points = []

        for pt in points:
            dist = Point(b).distance(pt)
            if 1e-3 < dist < min_dist:
                cut = LineString([b, (pt.x, pt.y)])
                if poly.contains(cut.centroid):
                    min_dist = dist
                    best_cut = LineString([
                        (b[0] - dx * 0.1, b[1] - dy * 0.1),
                        (pt.x + dx * 0.1, pt.y + dy * 0.1),
                    ])

    if best_cut is None:
        return [poly]

    try:
        res = split(poly, best_cut)
        polys = [g for g in res.geoms if g.geom_type in ("Polygon", "MultiPolygon")]
        return polys if len(polys) > 1 else [poly]
    except (ValueError, RuntimeError):
        return [poly]


def _decompose_recursive(poly: Polygon, world_to_m: float):
    min_area_world = MIN_REGION_AREA_M2 / (world_to_m ** 2)
    if not poly or poly.area < min_area_world:
        return [poly]

    reflex_list = _get_reflex_vertices(poly, world_to_m)
    if not reflex_list:
        return [poly]

    for reflex in reflex_list:
        parts = _split_at_reflex(poly, reflex)
        if len(parts) > 1:
            out = []
            for p in parts:
                p2 = _ensure_single_polygon(p)
                if p2 is None:
                    continue
                out.extend(_decompose_recursive(p2, world_to_m))
            return out
    return [poly]


def place_mcp_hooter_from_rooms_payload(
    payload: dict,
    world_to_m: float = 0.001,
    gemini_model: str | None = None,
) -> List[Tuple[float, float]]:
    """Return MCP/Hooter station coordinates from rooms/doors/staircases payload."""
    rooms_data = payload.get("rooms", []) if isinstance(payload, dict) else []
    doors_data = payload.get("doors", []) if isinstance(payload, dict) else []
    stairs_data = payload.get("staircases", []) if isinstance(payload, dict) else []

    if not rooms_data:
        return []

    room_objects = []
    all_boundaries = []

    for room in rooms_data:
        coords = room.get("polygon_world")
        if not coords:
            continue
        poly = _parse_polygon(coords)
        if poly is None:
            continue

        poly = _ensure_single_polygon(make_valid(poly.simplify(0.15 / world_to_m, preserve_topology=True)))
        if poly is None:
            continue

        label = str(room.get("label") or room.get("label_text") or "")
        is_egress = _classify_egress(label, gemini_model=gemini_model)

        room_objects.append({"poly": poly, "is_egress": is_egress, "label": label})
        all_boundaries.append(poly.boundary)

    if not room_objects:
        return []

    global_walls = unary_union(all_boundaries)
    targets: List[Point] = []

    door_buffer_world = 0.5 / world_to_m
    for door in doors_data:
        coords = door.get("polygon_world")
        if not coords:
            continue
        door_poly = _parse_polygon(coords)
        if door_poly is None:
            continue

        area = door_poly.buffer(door_buffer_world)
        touches_egress = any(r["is_egress"] and area.intersects(r["poly"]) for r in room_objects)
        if touches_egress:
            targets.append(door_poly.centroid)

    for stair in stairs_data:
        cw = stair.get("centroid_world")
        if cw and len(cw) >= 2:
            targets.append(Point(float(cw[0]), float(cw[1])))
            continue

        coords = stair.get("polygon_world")
        poly = _parse_polygon(coords) if coords else None
        if poly is not None:
            targets.append(poly.centroid)

    stations: List[Tuple[float, float]] = []
    for pt in targets:
        snap_pt, _ = nearest_points(global_walls, pt)
        stations.append((float(snap_pt.x), float(snap_pt.y)))

    min_area_world = MIN_REGION_AREA_M2 / (world_to_m ** 2)

    for room in room_objects:
        poly = room["poly"]
        original_boundary = poly.boundary
        parts = _decompose_recursive(poly, world_to_m)

        for part in parts:
            part_poly = _ensure_single_polygon(part)
            if part_poly is None or part_poly.area < min_area_world:
                continue

            angle_rad, (cx, cy) = _get_longest_wall_angle(part_poly)
            rot_poly = rotate(part_poly, -math.degrees(angle_rad), origin=(cx, cy))
            minx, miny, maxx, maxy = rot_poly.bounds

            width = maxx - minx
            height = maxy - miny
            length_m = max(width, height) * world_to_m
            width_m = min(width, height) * world_to_m

            if width_m <= 0:
                continue
            if (length_m / width_m) < CORRIDOR_RATIO_THRESHOLD:
                continue

            candidates: List[Point] = []
            if length_m < LONG_CORRIDOR_LENGTH_M:
                candidates.append(Point(minx + width * 0.5, miny + height * 0.5))
            else:
                if width > height:
                    candidates.append(Point(minx + width * 0.25, miny + height * 0.5))
                    candidates.append(Point(minx + width * 0.75, miny + height * 0.5))
                else:
                    candidates.append(Point(minx + width * 0.5, miny + height * 0.25))
                    candidates.append(Point(minx + width * 0.5, miny + height * 0.75))

            for c in candidates:
                world_pt = rotate(c, math.degrees(angle_rad), origin=(cx, cy))
                snap_pt, _ = nearest_points(original_boundary, world_pt)
                stations.append((float(snap_pt.x), float(snap_pt.y)))

    # Spatial dedup.
    deduped: List[Tuple[float, float]] = []
    min_dist_world = DEDUP_DIST_M / world_to_m
    for x, y in stations:
        if not any(math.hypot(x - dx, y - dy) < min_dist_world for dx, dy in deduped):
            deduped.append((x, y))

    logger.info("mcp_hooter_placement stations=%d rooms=%d", len(deduped), len(room_objects))
    return deduped
