"""Sprinkler placement and orthogonal pipe routing.

Ported from the notebook pipeline (Cells 19-20).  Produces sprinkler
coordinates, sized pipe segments, and optionally exports them into a DXF.
"""

import os
import math
import logging
import re
from typing import Dict, List, Tuple

import numpy as np
import cv2
from shapely.geometry import Polygon, LineString, Point, LinearRing, box
from shapely.validation import make_valid
from shapely.affinity import rotate
from shapely.ops import split, unary_union

try:
    import networkx as nx
    _NX_OK = True
except ImportError:
    _NX_OK = False

try:
    import ezdxf
    _EZDXF_OK = True
except ImportError:
    _EZDXF_OK = False

try:
    from google import genai
    _GENAI_OK = True
except ImportError:
    _GENAI_OK = False

logger = logging.getLogger("firecad.pipeline.sprinkler_routing")

# ── runtime defaults (overridden by callers) ──────────────────────
WORLD_TO_M = 0.001
SPRINKLER_SPACING_M = 3.0
MIN_REGION_AREA_M2 = 2.5
NOISE_TOLERANCE_M = 0.15
MIN_WALL_LENGTH_M = 0.05
WALL_BUFFER_M = 0.20       # STRICT 200mm minimum distance from all walls
ALIGN_TOLERANCE_M = 0.5    # Maximum distance to snap points to the global grid

PIPE_SIZES = ['25mm', '32mm', '40mm', '50mm', '65mm', '80mm', '90mm']

# Hazard categories used by sprinkler placement logic.
HAZARD_LH = "LH"
HAZARD_OH = "OH"
HAZARD_HH = "HH"
HAZARD_WASHROOM = "WASHROOM"

# Deterministic room classification patterns (kept local/offline).
_HH_KEYWORDS = {
    "BOILER", "DG", "GENERATOR", "TURBINE", "FURNACE", "OVEN", "KILN",
    "CHEMICAL", "PAINT", "FLAMMABLE", "BATTERY",
}
_OH_KEYWORDS = {
    "KITCHEN", "PANTRY", "GARAGE", "WORKSHOP", "REPAIR", "PLANT", "MECHANICAL",
    "MACHINE", "SERVICE",
}
_WASHROOM_KEYWORDS = {
    "WASHROOM", "TOILET", "WC", "RESTROOM", "BATHROOM",
}
_SKIP_KEYWORDS = {
    "ELECTRICAL", "PANEL", "SWITCHGEAR", "TRANSFORMER", "ELEC", "ELECT",
}

# Rule-based sprinkler geometry constraints by hazard type.
_HAZARD_PARAMS = {
    HAZARD_HH: {"max_area": 9.0, "max_spacing": 3.75, "min_spacing": 1.8, "max_wall": 1.875},
    HAZARD_OH: {"max_area": 12.0, "max_spacing": 4.5, "min_spacing": 1.8, "max_wall": 2.25},
    HAZARD_LH: {"max_area": 21.0, "max_spacing": 4.5, "min_spacing": 1.8, "max_wall": 2.25},
}

_VALID_GEMINI_HAZARDS = {HAZARD_LH, HAZARD_OH, HAZARD_HH, HAZARD_WASHROOM, "IGNORE", "MANUAL_REVIEW"}
_GEMINI_LABEL_CACHE: Dict[str, str] = {}

# DXF layers
DXF_LAYER_SPRINKLER = "AI_FIRE_SPRINKLERS"
DXF_LAYER_PIPES = "AI_FIRE_PIPES"
DXF_LAYER_SOURCE = "AI_FIRE_SOURCE"

# Labels used to detect pipe source locations inside the DXF
SOURCE_LABELS = ["FHC", "PL-Service Water", "PL_Waste Pipe", "Sprinkler"]


def _set_runtime_config(
    spacing_m: float,
    wall_buffer_m: float,
    world_to_m: float,
):
    global SPRINKLER_SPACING_M, WALL_BUFFER_M, WORLD_TO_M
    SPRINKLER_SPACING_M = float(spacing_m)
    WALL_BUFFER_M = float(wall_buffer_m)
    WORLD_TO_M = float(world_to_m)


def _normalize_label_for_match(text: str) -> str:
    s = str(text or "").upper()
    s = s.replace("\\P", " ")
    s = re.sub(r"[^A-Z0-9\s]", " ", s)
    s = re.sub(r"\s+", " ", s).strip()
    return s


def _merge_room_label_text(room: Dict) -> str:
    candidates = [
        room.get("label"),
        room.get("label_text"),
        room.get("name"),
    ]
    label_texts = room.get("label_texts")
    if isinstance(label_texts, list):
        candidates.extend(label_texts)

    return " ".join(_normalize_label_for_match(c) for c in candidates if c).strip()


def _deterministic_hazard_from_label(merged_label: str) -> str | None:
    if not merged_label:
        return None

    words = set(merged_label.split())

    # Dedicated electrical rooms: skip sprinkler placement entirely.
    if words & _SKIP_KEYWORDS:
        return "IGNORE"
    if words & _WASHROOM_KEYWORDS:
        return HAZARD_WASHROOM
    if words & _HH_KEYWORDS:
        return HAZARD_HH
    if words & _OH_KEYWORDS:
        return HAZARD_OH
    # Ordinary office/meeting/etc. usually contains ROOM and should be LH.
    if "ROOM" in words:
        return HAZARD_LH
    return None


def _gemini_enabled_for_hazards() -> bool:
    if not _GENAI_OK:
        return False
    api_key = os.getenv("GEMINI_API_KEY", "").strip()
    return bool(api_key)


def _classify_unknown_labels_with_gemini(labels: List[str]) -> Dict[str, str]:
    """Classify unknown labels only; returns map normalized_label -> hazard."""
    if not labels or not _gemini_enabled_for_hazards():
        return {}

    try:
        client = genai.Client(api_key=os.getenv("GEMINI_API_KEY", "").strip())
        model = os.getenv("GEMINI_MODEL", "gemini-2.5-flash-lite").strip() or "gemini-2.5-flash-lite"

        payload = {
            "valid_hazards": ["LH", "OH", "HH", "WASHROOM", "IGNORE", "MANUAL_REVIEW"],
            "labels": labels,
            "notes": [
                "Map each label to exactly one valid_hazard.",
                "Use IGNORE for non-room text.",
                "Use MANUAL_REVIEW only if truly ambiguous.",
            ],
        }

        prompt = (
            "You are a fire-safety room classifier. Return strict JSON as: "
            '{"items":[{"label":"...","hazard":"LH|OH|HH|WASHROOM|IGNORE|MANUAL_REVIEW"}]} '
            "for all labels in input order."
        )

        response = client.models.generate_content(
            model=model,
            contents=[prompt, str(payload)],
        )
        raw = (response.text or "").strip()
        data = None
        try:
            data = __import__("json").loads(raw)
        except Exception:
            match = re.search(r"\{[\s\S]*\}", raw)
            if match:
                data = __import__("json").loads(match.group(0))

        out: Dict[str, str] = {}
        items = (data or {}).get("items", []) if isinstance(data, dict) else []
        for item in items:
            label = _normalize_label_for_match(item.get("label", ""))
            hazard = str(item.get("hazard", "")).upper().strip()
            if not label:
                continue
            if hazard not in _VALID_GEMINI_HAZARDS:
                continue
            if hazard in {"IGNORE", "MANUAL_REVIEW"}:
                out[label] = HAZARD_LH
            else:
                out[label] = hazard
        return out
    except Exception as e:
        logger.warning("Gemini hazard classification failed: %s", e)
        return {}


def _classify_room_hazards(rooms: List[Dict]) -> List[str]:
    """Deterministic first, optional Gemini fallback for unknown labels only."""
    hazards: List[str] = [HAZARD_LH] * len(rooms)
    unknown_labels: List[str] = []
    unknown_indices: List[int] = []

    for i, room in enumerate(rooms):
        merged = _merge_room_label_text(room)
        if not merged:
            hazards[i] = HAZARD_LH
            continue

        det = _deterministic_hazard_from_label(merged)
        if det is not None:
            hazards[i] = det
            continue

        cached = _GEMINI_LABEL_CACHE.get(merged)
        if cached:
            hazards[i] = cached
            continue

        unknown_labels.append(merged)
        unknown_indices.append(i)

    gemini_map = _classify_unknown_labels_with_gemini(sorted(set(unknown_labels))) if unknown_labels else {}

    for idx in unknown_indices:
        merged = _merge_room_label_text(rooms[idx])
        gem = gemini_map.get(merged)
        if gem:
            hazards[idx] = gem
            _GEMINI_LABEL_CACHE[merged] = gem
        else:
            hazards[idx] = HAZARD_LH
            _GEMINI_LABEL_CACHE[merged] = HAZARD_LH

    return hazards


def _hazard_params(hazard_type: str) -> Dict[str, float]:
    return _HAZARD_PARAMS.get(hazard_type, _HAZARD_PARAMS[HAZARD_LH])


# ──────────────────────────────────────────────────────────────────
# DXF source detection
# ──────────────────────────────────────────────────────────────────
def detect_sources_from_dxf(
    dxf_path: str,
    labels: List[str] | None = None,
) -> List[Tuple[float, float]]:
    """Scan the DXF for text, blocks or layers matching *labels* and return
    world coordinates of each source location."""
    if labels is None:
        labels = SOURCE_LABELS

    if not _EZDXF_OK or not os.path.exists(dxf_path):
        return []

    labels_lower = [l.lower() for l in labels]
    detected: List[Tuple[float, float]] = []

    try:
        doc = ezdxf.readfile(dxf_path)
        msp = doc.modelspace()

        for entity in msp.query("TEXT MTEXT"):
            text_val = ""
            if entity.dxftype() == "TEXT":
                text_val = entity.dxf.text
            elif entity.dxftype() == "MTEXT":
                text_val = entity.text

            text_lower = text_val.lower()
            layer_lower = entity.dxf.layer.lower()
            if any(l in text_lower for l in labels_lower) or any(l in layer_lower for l in labels_lower):
                pt = entity.dxf.insert
                detected.append((float(pt.x), float(pt.y)))

        for entity in msp.query("INSERT"):
            name_lower = entity.dxf.name.lower()
            layer_lower = entity.dxf.layer.lower()
            if any(l in name_lower for l in labels_lower) or any(l in layer_lower for l in labels_lower):
                pt = entity.dxf.insert
                detected.append((float(pt.x), float(pt.y)))

    except Exception as e:
        logger.warning("detect_sources_from_dxf failed: %s", e)

    logger.info("detect_sources_from_dxf found=%d", len(detected))
    return detected


# ──────────────────────────────────────────────────────────────────
# Geometry helpers  (shared with place_detectors)
# ──────────────────────────────────────────────────────────────────
def _parse_polygon(poly_coords):
    if not poly_coords or len(poly_coords) < 3:
        return None
    poly = Polygon(poly_coords)
    if not poly.is_valid:
        poly = make_valid(poly)
    if poly.geom_type == "MultiPolygon":
        poly = max(poly.geoms, key=lambda p: p.area)
    elif poly.geom_type == "GeometryCollection":
        polygons = [g for g in poly.geoms if g.geom_type in ("Polygon", "MultiPolygon")]
        if not polygons:
            return None
        flat = []
        for p in polygons:
            if p.geom_type == "MultiPolygon":
                flat.extend(p.geoms)
            else:
                flat.append(p)
        poly = max(flat, key=lambda p: p.area)
    return poly


def _get_longest_wall_angle(poly):
    coords = list(poly.exterior.coords)
    max_len, best_angle = 0.0, 0.0
    for i in range(len(coords) - 1):
        p1, p2 = coords[i], coords[i + 1]
        dx, dy = p2[0] - p1[0], p2[1] - p1[1]
        length = math.hypot(dx, dy)
        if length > max_len:
            max_len, best_angle = length, math.atan2(dy, dx)
    return best_angle, poly.centroid.coords[0]


def _get_reflex_vertices(poly):
    coords = list(poly.exterior.coords)
    if LinearRing(coords).is_ccw:
        coords = coords[::-1]
    reflex_data = []
    n = len(coords) - 1
    min_len_world = MIN_WALL_LENGTH_M / WORLD_TO_M
    for i in range(n):
        p_prev, p_curr, p_next = coords[i - 1], coords[i], coords[(i + 1) % n]
        v1x, v1y = p_curr[0] - p_prev[0], p_curr[1] - p_prev[1]
        v2x, v2y = p_next[0] - p_curr[0], p_next[1] - p_curr[1]
        if math.hypot(v1x, v1y) < min_len_world or math.hypot(v2x, v2y) < min_len_world:
            continue
        if (v1x * v2y) - (v1y * v2x) > 1e-4:
            reflex_data.append((p_curr, p_prev, p_next))
    return reflex_data


def _split_at_reflex_vertex(poly, reflex_data):
    B, A, C = reflex_data
    x, y = B
    directions = []
    for vx, vy in [(B[0] - A[0], B[1] - A[1]), (B[0] - C[0], B[1] - C[1])]:
        if abs(vx) > abs(vy):
            directions.append((math.copysign(1.0, vx), 0.0))
        else:
            directions.append((0.0, math.copysign(1.0, vy)))

    minx, miny, maxx, maxy = poly.bounds
    max_dist = max(maxx - minx, maxy - miny) + 1.0
    best_cut, min_dist, boundary = None, float("inf"), poly.boundary

    for dx, dy in directions:
        ray = LineString([(x, y), (x + dx * max_dist, y + dy * max_dist)])
        intersection = boundary.intersection(ray)
        if intersection.is_empty:
            continue
        points = []
        if intersection.geom_type == "Point":
            points.append(intersection)
        elif intersection.geom_type == "MultiPoint":
            points.extend(intersection.geoms)
        elif intersection.geom_type == "GeometryCollection":
            for geom in intersection.geoms:
                if geom.geom_type == "Point":
                    points.append(geom)

        for pt in points:
            dist = Point(B).distance(pt)
            if 1e-3 < dist < min_dist:
                cut_line = LineString([B, (pt.x, pt.y)])
                if poly.contains(cut_line.centroid):
                    min_dist = dist
                    best_cut = LineString([
                        (x - dx * 0.1, y - dy * 0.1),
                        (pt.x + dx * 0.1, pt.y + dy * 0.1),
                    ])

    if best_cut is not None:
        try:
            res = split(poly, best_cut)
            polys = [g for g in res.geoms if g.geom_type in ("Polygon", "MultiPolygon")]
            if len(polys) > 1:
                return polys
        except Exception:
            pass
    return [poly]


def _decompose_recursive(poly):
    if poly.area < (MIN_REGION_AREA_M2 / (WORLD_TO_M ** 2)):
        return [poly]
    reflex_data_list = _get_reflex_vertices(poly)
    if not reflex_data_list:
        return [poly]
    for r_data in reflex_data_list:
        parts = _split_at_reflex_vertex(poly, r_data)
        if len(parts) > 1:
            out = []
            for p in parts:
                out.extend(_decompose_recursive(p))
            return out
    return [poly]


# ──────────────────────────────────────────────────────────────────
# Sprinkler grid placement
# ──────────────────────────────────────────────────────────────────
def _get_grid_points(poly: Polygon, hazard_type: str = HAZARD_LH):
    params = _hazard_params(hazard_type)
    angle_rad, (cx, cy) = _get_longest_wall_angle(poly)
    angle_deg = math.degrees(angle_rad)
    rot_poly = rotate(poly, -angle_deg, origin=(cx, cy))
    minx, miny, maxx, maxy = rot_poly.bounds
    width, height = maxx - minx, maxy - miny

    # Dimension filter: skip if either dimension is less than 1 metre.
    if width < (1.0 / WORLD_TO_M) or height < (1.0 / WORLD_TO_M):
        return []

    max_spacing_world = min(SPRINKLER_SPACING_M, params["max_spacing"]) / WORLD_TO_M
    min_spacing_world = params["min_spacing"] / WORLD_TO_M
    max_area_world = params["max_area"] / (WORLD_TO_M ** 2)
    max_wall_world = params["max_wall"] / WORLD_TO_M

    nx_pts = max(1, math.ceil(width / max_spacing_world))
    ny_pts = max(1, math.ceil(height / max_spacing_world))

    # Respect max coverage area per sprinkler.
    while (width / nx_pts) * (height / ny_pts) > max_area_world:
        if (width / nx_pts) > (height / ny_pts):
            nx_pts += 1
        else:
            ny_pts += 1

    step_x, step_y = width / nx_pts, height / ny_pts

    # Respect wall distance constraints.
    while (step_x / 2.0) > max_wall_world:
        nx_pts += 1
        step_x = width / nx_pts
    while (step_y / 2.0) > max_wall_world:
        ny_pts += 1
        step_y = height / ny_pts

    # Enforce minimum spacing: reduce grid count so step never < 1.8 m.
    max_nx = max(1, int(width / min_spacing_world))
    max_ny = max(1, int(height / min_spacing_world))
    if nx_pts > max_nx:
        nx_pts = max_nx
        step_x = width / nx_pts
    if ny_pts > max_ny:
        ny_pts = max_ny
        step_y = height / ny_pts

    points = []
    for i in range(nx_pts):
        for j in range(ny_pts):
            lx = minx + i * step_x + step_x / 2
            ly = miny + j * step_y + step_y / 2
            p = Point(lx, ly)
            if rot_poly.contains(p):
                world_p = rotate(p, angle_deg, origin=(cx, cy))
                points.append((world_p.x, world_p.y))
    return points


def _process_room(room_poly: Polygon, hazard_type: str = HAZARD_LH):
    """Returns ``(points, regions, bboxes)``."""
    points: List[Tuple[float, float]] = []
    regions: List[Polygon] = []
    bboxes: List[Polygon] = []
    tolerance_world = NOISE_TOLERANCE_M / WORLD_TO_M
    clean_poly = room_poly.simplify(tolerance_world, preserve_topology=True)

    if not clean_poly.is_valid:
        clean_poly = make_valid(clean_poly)
        if clean_poly.geom_type == "GeometryCollection":
            polys = [g for g in clean_poly.geoms if g.geom_type in ("Polygon", "MultiPolygon")]
            if polys:
                clean_poly = max(polys, key=lambda p: p.area)

    sub_polys = _decompose_recursive(clean_poly)
    min_area_world = MIN_REGION_AREA_M2 / (WORLD_TO_M ** 2)

    for poly in sub_polys:
        if poly.area < min_area_world:
            continue
        regions.append(poly)

        # Compute rotated bounding box for visualization.
        angle_rad, (cx, cy) = _get_longest_wall_angle(poly)
        angle_deg = math.degrees(angle_rad)
        rot_poly = rotate(poly, -angle_deg, origin=(cx, cy))
        local_bbox = box(*rot_poly.bounds)
        world_bbox = rotate(local_bbox, angle_deg, origin=(cx, cy))
        bboxes.append(world_bbox)

        grid = _get_grid_points(poly, hazard_type=hazard_type)
        if not grid:
            rep = poly.representative_point()
            grid = [(rep.x, rep.y)]
        points.extend(grid)
    return points, regions, bboxes


# ──────────────────────────────────────────────────────────────────
# Pipe sizing
# ──────────────────────────────────────────────────────────────────
def get_pipe_diameter_label(num_sprinklers: int) -> str:
    if num_sprinklers <= 2:
        return "25mm"
    elif num_sprinklers <= 3:
        return "32mm"
    elif num_sprinklers <= 5:
        return "40mm"
    elif num_sprinklers <= 10:
        return "50mm"
    elif num_sprinklers <= 30:
        return "65mm"
    elif num_sprinklers <= 60:
        return "80mm"
    return "90mm"


def _get_base_size_idx(num_sprinklers: int) -> int:
    """Return a PIPE_SIZES index for the downstream sprinkler count."""
    if num_sprinklers <= 2:
        return 0
    elif num_sprinklers <= 3:
        return 1
    elif num_sprinklers <= 5:
        return 2
    elif num_sprinklers <= 10:
        return 3
    elif num_sprinklers <= 30:
        return 4
    elif num_sprinklers <= 60:
        return 5
    return 6


def _diameter_label_to_mm(label: str) -> int:
    m = re.search(r"(\d+)", str(label))
    return int(m.group(1)) if m else 25


def _ensure_min_diameter(label: str, min_mm: int) -> str:
    curr = _diameter_label_to_mm(label)
    mm = max(curr, int(min_mm))
    return f"{mm}mm"


# ──────────────────────────────────────────────────────────────────
# Orthogonal pipe routing – data-driven
# ──────────────────────────────────────────────────────────────────
def _get_data_driven_lines(coords: List[float], min_spacing_m: float = 2.0) -> List[float]:
    """Cluster nearby coordinate values and merge those closer than *min_spacing_m*."""
    if not coords:
        return []
    min_spacing = min_spacing_m / WORLD_TO_M
    tolerance = 0.1 / WORLD_TO_M
    sorted_coords = sorted(coords)

    clusters: list = []
    current_cluster = [sorted_coords[0]]
    for val in sorted_coords[1:]:
        if val - current_cluster[0] <= tolerance:
            current_cluster.append(val)
        else:
            avg_val = sum(current_cluster) / len(current_cluster)
            clusters.append({"val": avg_val, "weight": len(current_cluster)})
            current_cluster = [val]
    clusters.append({"val": sum(current_cluster) / len(current_cluster), "weight": len(current_cluster)})

    # Iteratively merge clusters that are too close together.
    while True:
        min_dist = float("inf")
        merge_idx = -1
        for i in range(len(clusters) - 1):
            dist = clusters[i + 1]["val"] - clusters[i]["val"]
            if dist < min_dist:
                min_dist, merge_idx = dist, i
        if min_dist >= min_spacing or merge_idx == -1:
            break
        c1, c2 = clusters[merge_idx], clusters[merge_idx + 1]
        if c1["weight"] > c2["weight"]:
            new_val = c1["val"]
        elif c2["weight"] > c1["weight"]:
            new_val = c2["val"]
        else:
            new_val = (c1["val"] + c2["val"]) / 2.0
        clusters[merge_idx] = {"val": new_val, "weight": c1["weight"] + c2["weight"]}
        clusters.pop(merge_idx + 1)

    return [c["val"] for c in clusters]


def route_pipes(
    sprinklers: List[Tuple[float, float]],
    source: Tuple[float, float],
    valid_regions: List[Polygon] | None = None,
) -> Tuple[List[Tuple[Tuple[Tuple[float, float], Tuple[float, float]], str]], List[Tuple[float, float]]]:
    """Route orthogonal pipes from *source* to each sprinkler.

    Uses data-driven branch clustering, trunk offset, out-of-bounds pipe
    clipping with reconnection, arm-pipe tee junctions, and region-aware
    pipe sizing.

    Returns ``(pipe_segments, snapped_sprinklers)`` where each pipe segment is
    ``((pt1, pt2), diameter_label)``.
    """
    if not _NX_OK:
        raise RuntimeError("networkx is required for pipe routing")

    if not sprinklers:
        return [], []

    source = (round(source[0], 4), round(source[1], 4))
    original_sprinklers = [(round(s[0], 4), round(s[1], 4)) for s in sprinklers]
    xs = [s[0] for s in original_sprinklers]
    ys = [s[1] for s in original_sprinklers]
    is_horizontal_trunk = (max(xs) - min(xs)) > (max(ys) - min(ys))

    trunk_offset_world = 1.5 / WORLD_TO_M

    # ── 1. Build ideal strictly orthogonal layout ─────────────────
    G = nx.Graph()
    G.add_node(source)
    sprinkler_set = set(original_sprinklers)
    for s in original_sprinklers:
        G.add_node(s)

    if is_horizontal_trunk:
        trunk_y = source[1] + trunk_offset_world
        branch_xs = _get_data_driven_lines(xs, min_spacing_m=2.0)
        branch_nodes: Dict = {bx: [(bx, trunk_y)] for bx in branch_xs}

        for s in original_sprinklers:
            best_bx = min(branch_xs, key=lambda x: abs(x - s[0]))
            j_pt = (best_bx, s[1])
            branch_nodes[best_bx].append(j_pt)
            if j_pt != s:
                G.add_edge(j_pt, s)

        trunk_nodes_list = [(source[0], trunk_y)]
        for bx, nodes in branch_nodes.items():
            nodes = list(set(nodes))
            trunk_nodes_list.append((bx, trunk_y))
            nodes_up = sorted([n for n in nodes if n[1] >= trunk_y], key=lambda n: n[1])
            nodes_down = sorted([n for n in nodes if n[1] <= trunk_y], key=lambda n: n[1], reverse=True)
            for i in range(len(nodes_up) - 1):
                G.add_edge(nodes_up[i], nodes_up[i + 1])
            for i in range(len(nodes_down) - 1):
                G.add_edge(nodes_down[i], nodes_down[i + 1])

        trunk_nodes_list = sorted(set(trunk_nodes_list), key=lambda n: n[0])
        for i in range(len(trunk_nodes_list) - 1):
            G.add_edge(trunk_nodes_list[i], trunk_nodes_list[i + 1])
        G.add_edge(source, (source[0], trunk_y))
    else:
        trunk_x = source[0] + trunk_offset_world
        branch_ys = _get_data_driven_lines(ys, min_spacing_m=2.0)
        branch_nodes = {by: [(trunk_x, by)] for by in branch_ys}

        for s in original_sprinklers:
            best_by = min(branch_ys, key=lambda y: abs(y - s[1]))
            j_pt = (s[0], best_by)
            branch_nodes[best_by].append(j_pt)
            if j_pt != s:
                G.add_edge(j_pt, s)

        trunk_nodes_list = [(trunk_x, source[1])]
        for by, nodes in branch_nodes.items():
            nodes = list(set(nodes))
            trunk_nodes_list.append((trunk_x, by))
            nodes_right = sorted([n for n in nodes if n[0] >= trunk_x], key=lambda n: n[0])
            nodes_left = sorted([n for n in nodes if n[0] <= trunk_x], key=lambda n: n[0], reverse=True)
            for i in range(len(nodes_right) - 1):
                G.add_edge(nodes_right[i], nodes_right[i + 1])
            for i in range(len(nodes_left) - 1):
                G.add_edge(nodes_left[i], nodes_left[i + 1])

        trunk_nodes_list = sorted(set(trunk_nodes_list), key=lambda n: n[1])
        for i in range(len(trunk_nodes_list) - 1):
            G.add_edge(trunk_nodes_list[i], trunk_nodes_list[i + 1])
        G.add_edge(source, (trunk_x, source[1]))

    # ── 2. Delete out-of-bounds pipes and reconnect ───────────────
    if valid_regions:
        footprint = unary_union(valid_regions).buffer(1.2 / WORLD_TO_M)

        edges_to_remove = [(u, v) for u, v in G.edges() if not footprint.contains(LineString([u, v]))]
        G.remove_edges_from(edges_to_remove)

        # Reconnect disconnected islands via L-shaped orthogonal paths.
        components = list(nx.connected_components(G))
        while len(components) > 1:
            comp_a = components[0]
            best_dist = float("inf")
            best_edges: list = []
            best_comp_idx = -1

            for ci in range(1, len(components)):
                comp_b = components[ci]
                for u in comp_a:
                    for v in comp_b:
                        dist = abs(u[0] - v[0]) + abs(u[1] - v[1])
                        if dist >= best_dist:
                            continue
                        for corner in [(v[0], u[1]), (u[0], v[1])]:
                            valid = True
                            if u != corner:
                                valid = valid and footprint.contains(LineString([u, corner]))
                            if corner != v:
                                valid = valid and footprint.contains(LineString([corner, v]))
                            if valid:
                                best_dist = dist
                                best_edges = [(u, corner), (corner, v)]
                                best_comp_idx = ci
                                break

            if not best_edges:
                # Failsafe: force the absolute closest L-shape.
                fallback_dist = float("inf")
                for ci in range(1, len(components)):
                    for u in comp_a:
                        for v in components[ci]:
                            dist = abs(u[0] - v[0]) + abs(u[1] - v[1])
                            if dist < fallback_dist:
                                fallback_dist = dist
                                corner = (v[0], u[1])
                                best_edges = [(u, corner), (corner, v)]
                                best_comp_idx = ci

            for e in best_edges:
                if e[0] != e[1]:
                    G.add_edge(*e)
            components[0] = components[0].union(components[best_comp_idx])
            components.pop(best_comp_idx)

    # ── 3. BFS tree from source ───────────────────────────────────
    try:
        directed_tree = nx.bfs_tree(G, source=source)
    except Exception as e:
        logger.warning("route_pipes bfs_tree failed: %s", e)
        return [], original_sprinklers

    # ── 4. Subtree counts and node-to-region mapping ──────────────
    node_to_region: Dict = {}
    if valid_regions:
        eps = 0.15 / WORLD_TO_M
        for node in directed_tree.nodes():
            pt = Point(node[0], node[1])
            found = -1
            for i, reg in enumerate(valid_regions):
                if reg.buffer(eps).contains(pt):
                    found = i
                    break
            node_to_region[node] = found

    subtree_counts: Dict = {}
    for node in reversed(list(nx.topological_sort(directed_tree))):
        count = 1 if node in sprinkler_set else 0
        for child in directed_tree.successors(node):
            count += subtree_counts.get(child, 0)
        subtree_counts[node] = count

    # ── 5. Arm-pipe tee creation ──────────────────────────────────
    arm_length = 0.4 / WORLD_TO_M
    edges_to_remove = []
    edges_to_add = []
    tees_created = set()

    for s in list(sprinkler_set):
        load = subtree_counts.get(s, 0)
        if load <= 10:
            continue
        preds = list(directed_tree.predecessors(s))
        succs = list(directed_tree.successors(s))
        if not preds:
            continue
        p = preds[0]
        dx, dy = s[0] - p[0], s[1] - p[1]
        if abs(dx) < 1e-3 and abs(dy) < 1e-3:
            continue

        is_horiz = abs(dx) > abs(dy)
        dir_y = -1 if dy > 0 else 1
        dir_x = -1 if dx > 0 else 1
        if is_horiz:
            tee = (s[0], s[1] + arm_length * dir_y)
        else:
            tee = (s[0] + arm_length * dir_x, s[1])

        edges_to_remove.append((p, s))
        edges_to_add.append((p, tee))
        for child in succs:
            edges_to_remove.append((s, child))
            edges_to_add.append((tee, child))
        edges_to_add.append((tee, s))
        tees_created.add(tee)

        if s in node_to_region:
            node_to_region[tee] = node_to_region[s]
        subtree_counts[tee] = load
        subtree_counts[s] = 1

    for u, v in edges_to_remove:
        if directed_tree.has_edge(u, v):
            directed_tree.remove_edge(u, v)
    for u, v in edges_to_add:
        directed_tree.add_edge(u, v)
    try:
        directed_tree = nx.bfs_tree(directed_tree, source=source)
    except Exception:
        pass

    # ── 6. Region-aware pipe sizing ───────────────────────────────
    node_size_idx = {n: _get_base_size_idx(subtree_counts.get(n, 0)) for n in directed_tree.nodes()}
    for node in reversed(list(nx.topological_sort(directed_tree))):
        idx = node_size_idx[node]
        for child in directed_tree.successors(node):
            child_idx = node_size_idx[child]
            if valid_regions:
                reg_u = node_to_region.get(node, -1)
                reg_v = node_to_region.get(child, -1)
                if reg_u != reg_v and reg_v != -1:
                    child_idx = max(child_idx, 1)
                    node_size_idx[child] = child_idx
            idx = max(idx, child_idx)
        node_size_idx[node] = idx

    final_segments: List[Tuple[Tuple[Tuple[float, float], Tuple[float, float]], str]] = []
    for u, v in directed_tree.edges():
        if subtree_counts.get(v, 0) > 0:
            idx = node_size_idx.get(v, 0)
            label = PIPE_SIZES[idx]
            if valid_regions:
                reg_u = node_to_region.get(u, -1)
                reg_v = node_to_region.get(v, -1)
                if reg_u != reg_v and reg_v != -1:
                    label = f"{label} (Entry)"
            if u in tees_created and v in sprinkler_set:
                label = "25mm (Arm)"
            final_segments.append(((u, v), label))

    return final_segments, original_sprinklers


# ──────────────────────────────────────────────────────────────────
# Visualization
# ──────────────────────────────────────────────────────────────────
def visualize_sprinkler_routing(
    all_regions: List[Polygon],
    all_points: List[Tuple[float, float]],
    all_pipes: list,
    source: Tuple[float, float],
    output_path: str,
    all_bboxes: List[Polygon] | None = None,
):
    if not all_regions and not all_points:
        return

    bounds_x = [p.bounds[0] for p in all_regions] + [p.bounds[2] for p in all_regions] + [source[0]]
    bounds_y = [p.bounds[1] for p in all_regions] + [p.bounds[3] for p in all_regions] + [source[1]]
    minx, maxx = min(bounds_x), max(bounds_x)
    miny, maxy = min(bounds_y), max(bounds_y)

    target_w = 2200
    world_w = max(1.0, maxx - minx)
    scale = target_w / world_w
    margin_px = 120
    w_px = max(400, min(int((maxx - minx) * scale) + 2 * margin_px, 4000))
    h_px = max(400, min(int((maxy - miny) * scale) + 2 * margin_px, 4000))
    img = np.zeros((h_px, w_px, 3), dtype=np.uint8)

    def to_px(wx, wy):
        return int((wx - minx) * scale) + margin_px, int((maxy - wy) * scale) + margin_px

    for reg in all_regions:
        pts = np.array([to_px(x, y) for x, y in reg.exterior.coords], dtype=np.int32)
        color = np.random.randint(50, 150, 3).tolist()
        overlay = img.copy()
        cv2.fillPoly(overlay, [pts], color)
        cv2.addWeighted(overlay, 0.5, img, 0.5, 0, img)
        cv2.polylines(img, [pts], True, (200, 200, 200), 1)

    # Draw bounding boxes in magenta
    if all_bboxes:
        for bbox_poly in all_bboxes:
            pts = np.array([to_px(x, y) for x, y in bbox_poly.exterior.coords], dtype=np.int32)
            cv2.polylines(img, [pts], True, (255, 0, 255), 1)

    for (pt1, pt2), label in all_pipes:
        px1, py1 = to_px(pt1[0], pt1[1])
        px2, py2 = to_px(pt2[0], pt2[1])
        cv2.line(img, (px1, py1), (px2, py2), (0, 0, 255), 5)
        line_len = math.hypot(px2 - px1, py2 - py1)
        if line_len > 40:
            mid_x, mid_y = (px1 + px2) // 2, (py1 + py2) // 2
            cv2.putText(img, label, (mid_x - 20, mid_y - 6), cv2.FONT_HERSHEY_SIMPLEX, 0.25, (200, 255, 200), 1, cv2.LINE_AA)

    for dx, dy in all_points:
        px, py = to_px(dx, dy)
        if 0 <= px < w_px and 0 <= py < h_px:
            cv2.drawMarker(img, (px, py), (0, 200, 255), markerType=cv2.MARKER_STAR, markerSize=10, thickness=1)

    sx, sy = to_px(source[0], source[1])
    box_sz = 15
    cv2.rectangle(img, (sx - box_sz, sy - box_sz), (sx + box_sz, sy + box_sz), (0, 0, 255), -1)
    cv2.rectangle(img, (sx - box_sz, sy - box_sz), (sx + box_sz, sy + box_sz), (255, 255, 255), 2)
    cv2.putText(img, "SOURCE", (sx + box_sz + 5, sy - box_sz), cv2.FONT_HERSHEY_SIMPLEX, 0.6, (255, 255, 255), 1)

    os.makedirs(os.path.dirname(output_path) or ".", exist_ok=True)
    cv2.imwrite(output_path, img)
    logger.info("visualize_sprinkler_routing saved=%s", output_path)


# ──────────────────────────────────────────────────────────────────
# Global grid alignment
# ──────────────────────────────────────────────────────────────────
def align_to_global_lines(
    detectors: List[Tuple[float, float]],
    regions: List[Polygon],
    tolerance_m: float = ALIGN_TOLERANCE_M,
) -> List[Tuple[float, float]]:
    """Snap sprinkler points to global X/Y grid lines while staying inside
    the wall-buffered safe zone of their parent region."""
    if not detectors:
        return []
    tolerance_world = tolerance_m / WORLD_TO_M
    wall_buffer_world = WALL_BUFFER_M / WORLD_TO_M

    def _extract_global_lines(coords):
        sorted_coords = sorted(coords)
        if not sorted_coords:
            return []
        lines = []
        current_group = [sorted_coords[0]]
        for val in sorted_coords[1:]:
            if val - current_group[0] <= tolerance_world:
                current_group.append(val)
            else:
                lines.append(sum(current_group) / len(current_group))
                current_group = [val]
        lines.append(sum(current_group) / len(current_group))
        return lines

    global_x_lines = _extract_global_lines([d[0] for d in detectors])
    global_y_lines = _extract_global_lines([d[1] for d in detectors])
    aligned: List[Tuple[float, float]] = []

    for x, y in detectors:
        pt = Point(x, y)
        parent_region = next(
            (r for r in regions if r.contains(pt) or r.distance(pt) < 1e-3), None
        )
        if not parent_region:
            aligned.append((x, y))
            continue

        safe_zone = parent_region.buffer(-wall_buffer_world)
        if safe_zone.is_empty or safe_zone.area <= 0:
            safe_zone = parent_region.buffer(-0.1 / WORLD_TO_M)
            if safe_zone.is_empty:
                safe_zone = parent_region

        valid_x = sorted(
            [gx for gx in global_x_lines if abs(gx - x) <= tolerance_world],
            key=lambda gx: abs(gx - x),
        ) or [x]
        valid_y = sorted(
            [gy for gy in global_y_lines if abs(gy - y) <= tolerance_world],
            key=lambda gy: abs(gy - y),
        ) or [y]

        best_pt = None
        # Try snapping both axes
        for gx in valid_x:
            for gy in valid_y:
                if safe_zone.contains(Point(gx, gy)):
                    best_pt = (gx, gy)
                    break
            if best_pt:
                break
        # Fallback: X axis only
        if not best_pt:
            for gx in valid_x:
                if safe_zone.contains(Point(gx, y)):
                    best_pt = (gx, y)
                    break
        # Fallback: Y axis only
        if not best_pt:
            for gy in valid_y:
                if safe_zone.contains(Point(x, gy)):
                    best_pt = (x, gy)
                    break
        aligned.append(best_pt if best_pt else (x, y))

    return aligned


# ──────────────────────────────────────────────────────────────────
# DXF export for sprinklers + pipes
# ──────────────────────────────────────────────────────────────────
def write_sprinklers_to_dxf(
    base_dxf: str,
    out_dxf: str,
    sprinklers: List[Tuple[float, float]],
    pipes: list,
    sources: List[Tuple[float, float]],
    world_to_m: float = 0.001,
    world_bbox: dict | None = None,
    symbol_radius_world: float | None = None,
    text_height_world: float | None = None,
):
    """Write sprinkler symbols, sized pipe segments, and source markers into a DXF."""
    if not _EZDXF_OK:
        logger.warning("ezdxf not available, skipping DXF export")
        return

    from app.pipeline.dxf_export import compute_symbol_sizes

    if symbol_radius_world is None or text_height_world is None:
        # build lightweight detector list for bbox calculation
        sp_dets = [{"x": x, "y": y} for x, y in sprinklers] if sprinklers else []
        auto_r, auto_t = compute_symbol_sizes(world_to_m, sp_dets, world_bbox)
        if symbol_radius_world is None:
            symbol_radius_world = auto_r
        if text_height_world is None:
            text_height_world = auto_t

    doc = ezdxf.readfile(base_dxf)
    msp = doc.modelspace()

    for layer_name in [DXF_LAYER_SPRINKLER, DXF_LAYER_PIPES, DXF_LAYER_SOURCE]:
        if layer_name not in doc.layers:
            doc.layers.add(layer_name)

    # Increase readability for pipe size labels in output drawings.
    pipe_text_height = text_height_world * 1.10
    # Keep pipe thickness proportional to symbol scale while enforcing a practical minimum.
    pipe_const_width = max(symbol_radius_world * 0.18, 0.03 / world_to_m)

    # Pipes
    for (pt1, pt2), label in pipes:
        msp.add_lwpolyline(
            [pt1, pt2],
            dxfattribs={"layer": DXF_LAYER_PIPES, "color": 1, "const_width": pipe_const_width},
        )
        dx = pt2[0] - pt1[0]
        dy = pt2[1] - pt1[1]
        length = math.hypot(dx, dy)
        mid_x = (pt1[0] + pt2[0]) / 2.0
        mid_y = (pt1[1] + pt2[1]) / 2.0
        is_horizontal = abs(dx) > abs(dy)
        offset_dist = pipe_text_height * 0.9
        text_width_approx = len(label) * pipe_text_height * 0.7
        if is_horizontal:
            angle_deg = 0
            insert_pt = (mid_x - text_width_approx / 2.0, mid_y + offset_dist)
        else:
            angle_deg = 90
            insert_pt = (mid_x - offset_dist * 2.0, mid_y - text_width_approx / 2.0)
        try:
            txt = msp.add_text(
                label,
                dxfattribs={"layer": DXF_LAYER_PIPES, "height": pipe_text_height, "rotation": angle_deg, "color": 1},
            )
            txt.set_placement(insert_pt)
        except Exception:
            pass

    # Sprinkler symbols
    layer_attrs = {"layer": DXF_LAYER_SPRINKLER, "color": 1}
    for wx, wy in sprinklers:
        msp.add_circle((wx, wy), radius=symbol_radius_world * 0.4, dxfattribs=layer_attrs)
        for angle in [0, 90]:
            rad = math.radians(angle)
            dx_s = symbol_radius_world * math.cos(rad)
            dy_s = symbol_radius_world * math.sin(rad)
            msp.add_line((wx - dx_s, wy - dy_s), (wx + dx_s, wy + dy_s), dxfattribs=layer_attrs)

    # Source markers
    source_attrs = {"layer": DXF_LAYER_SOURCE}
    half_side = symbol_radius_world * 3.0
    for i, (sx, sy) in enumerate(sources):
        corners = [
            (sx - half_side, sy - half_side),
            (sx + half_side, sy - half_side),
            (sx + half_side, sy + half_side),
            (sx - half_side, sy + half_side),
            (sx - half_side, sy - half_side),
        ]
        msp.add_lwpolyline(corners, dxfattribs=source_attrs)
        source_label = f"SOURCE-{i + 1}"
        src_text_h = text_height_world * 1.2
        src_text_w = len(source_label) * src_text_h * 0.7
        insert_x = sx - src_text_w / 2.0
        insert_y = sy - half_side - src_text_h * 1.5
        try:
            txt = msp.add_text(source_label, dxfattribs={"layer": DXF_LAYER_SOURCE, "height": src_text_h})
            txt.set_placement((insert_x, insert_y))
        except Exception:
            pass

    doc.saveas(out_dxf)
    logger.info("write_sprinklers_to_dxf saved=%s sprinklers=%d pipes=%d sources=%d", out_dxf, len(sprinklers), len(pipes), len(sources))


# ──────────────────────────────────────────────────────────────────
# Pipeline entry-point
# ──────────────────────────────────────────────────────────────────
def place_sprinklers_from_rooms_json(
    rooms: List[Dict],
    dxf_path: str,
    spacing_m: float = 3.0,
    wall_buffer_m: float = 0.20,
    world_to_m: float = 0.001,
    source_labels: List[str] | None = None,
    debug_png_path: str | None = None,
) -> Tuple[
    List[Tuple[float, float]],
    List[Tuple[Tuple[Tuple[float, float], Tuple[float, float]], str]],
    List[Tuple[float, float]],
    List[Polygon],
]:
    """Place sprinklers for all rooms and route pipes.

    Returns ``(sprinkler_coords, pipe_segments, sources, regions)``.
    """
    _set_runtime_config(spacing_m=spacing_m, wall_buffer_m=wall_buffer_m, world_to_m=world_to_m)

    global_sources = detect_sources_from_dxf(dxf_path, source_labels)

    all_points: List[Tuple[float, float]] = []
    all_regions: List[Polygon] = []
    all_bboxes: List[Polygon] = []

    hazard_counts: Dict[str, int] = {HAZARD_LH: 0, HAZARD_OH: 0, HAZARD_HH: 0, HAZARD_WASHROOM: 0}
    room_hazards = _classify_room_hazards(rooms)

    for room, hazard in zip(rooms, room_hazards):
        # Skip rooms classified as IGNORE (e.g. electrical rooms).
        if hazard == "IGNORE":
            continue

        poly = _parse_polygon(room.get("polygon_world"))
        if poly is None:
            continue
        area_m2 = float(poly.area) * (world_to_m ** 2)
        # Optional washroom exception: skip tiny washrooms.
        if hazard == HAZARD_WASHROOM and area_m2 < 5.0:
            continue
        if hazard == HAZARD_WASHROOM:
            hazard = HAZARD_LH

        # Large LH spaces are treated as OH to avoid under-protection.
        if hazard == HAZARD_LH and area_m2 > 126.0:
            hazard = HAZARD_OH

        hazard_counts[hazard] = hazard_counts.get(hazard, 0) + 1

        pts, regs, bboxes = _process_room(poly, hazard_type=hazard)
        all_points.extend(pts)
        all_regions.extend(regs)
        all_bboxes.extend(bboxes)

    if not all_points:
        logger.info("place_sprinklers_from_rooms_json no sprinklers placed (no valid rooms)")
        return [], [], [], []

    # Global grid alignment
    all_points = align_to_global_lines(all_points, all_regions, tolerance_m=ALIGN_TOLERANCE_M)

    # Determine source
    min_x = min(p[0] for p in all_points)
    max_x = max(p[0] for p in all_points)
    min_y = min(p[1] for p in all_points)
    max_y = max(p[1] for p in all_points)
    center = ((min_x + max_x) / 2.0, (min_y + max_y) / 2.0)

    if global_sources:
        search_radius = 5.0 / world_to_m
        footprint = unary_union(all_regions).buffer(search_radius)
        local_sources = [(sx, sy) for sx, sy in global_sources if footprint.contains(Point(sx, sy))]
        if local_sources:
            source = min(local_sources, key=lambda s: math.hypot(s[0] - center[0], s[1] - center[1]))
        else:
            source = center
    else:
        source = center

    # Route pipes
    pipe_segments, snapped_sprinklers = route_pipes(all_points, source, valid_regions=all_regions)

    logger.info(
        "place_sprinklers_from_rooms_json sprinklers=%d pipes=%d source=(%.1f, %.1f) hazards=%s",
        len(snapped_sprinklers),
        len(pipe_segments),
        source[0],
        source[1],
        hazard_counts,
    )

    if debug_png_path:
        visualize_sprinkler_routing(all_regions, snapped_sprinklers, pipe_segments, source, debug_png_path, all_bboxes=all_bboxes)

    return snapped_sprinklers, pipe_segments, [source], all_regions


# ──────────────────────────────────────────────────────────────────
# Sprinkler-only placement (no pipe routing)
# ──────────────────────────────────────────────────────────────────
def place_sprinklers_only(
    rooms: List[Dict],
    spacing_m: float = 3.0,
    wall_buffer_m: float = 0.20,
    world_to_m: float = 0.001,
) -> List[Tuple[float, float]]:
    """Place sprinklers for all rooms WITHOUT routing pipes.

    Returns ``sprinkler_coords``.
    """
    _set_runtime_config(spacing_m=spacing_m, wall_buffer_m=wall_buffer_m, world_to_m=world_to_m)

    all_points: List[Tuple[float, float]] = []
    all_regions: List[Polygon] = []

    room_hazards = _classify_room_hazards(rooms)
    for room, hazard in zip(rooms, room_hazards):
        if hazard == "IGNORE":
            continue
        poly = _parse_polygon(room.get("polygon_world"))
        if poly is None:
            continue
        area_m2 = float(poly.area) * (world_to_m ** 2)
        if hazard == HAZARD_WASHROOM and area_m2 < 5.0:
            continue
        if hazard == HAZARD_WASHROOM:
            hazard = HAZARD_LH
        if hazard == HAZARD_LH and area_m2 > 126.0:
            hazard = HAZARD_OH

        pts, regs, _bboxes = _process_room(poly, hazard_type=hazard)
        all_points.extend(pts)
        all_regions.extend(regs)

    # Global grid alignment
    all_points = align_to_global_lines(all_points, all_regions, tolerance_m=ALIGN_TOLERANCE_M)

    logger.info("place_sprinklers_only sprinklers=%d", len(all_points))
    return all_points


# ──────────────────────────────────────────────────────────────────
# Route pipes for existing sprinkler coordinates
# ──────────────────────────────────────────────────────────────────
def route_pipes_for_sprinklers(
    sprinkler_coords: List[Tuple[float, float]],
    rooms: List[Dict],
    dxf_path: str,
    spacing_m: float = 3.0,
    wall_buffer_m: float = 0.20,
    world_to_m: float = 0.001,
    source_labels: List[str] | None = None,
    override_source: Tuple[float, float] | None = None,
) -> Tuple[
    List[Tuple[Tuple[Tuple[float, float], Tuple[float, float]], str]],
    List[Tuple[float, float]],
    List[Tuple[float, float]],
]:
    """Route pipes connecting existing sprinkler points.

    If *override_source* is provided it is used directly, skipping auto-detection.
    Returns ``(pipe_segments, snapped_sprinklers, sources)``.
    """
    _set_runtime_config(spacing_m=spacing_m, wall_buffer_m=wall_buffer_m, world_to_m=world_to_m)

    if not sprinkler_coords:
        return [], [], []

    # Build regions from rooms for safe-path checking
    all_regions: List[Polygon] = []
    room_hazards = _classify_room_hazards(rooms)
    for room, hazard in zip(rooms, room_hazards):
        if hazard == "IGNORE":
            continue
        poly = _parse_polygon(room.get("polygon_world"))
        if poly is None:
            continue
        area_m2 = float(poly.area) * (world_to_m ** 2)
        if hazard == HAZARD_WASHROOM and area_m2 < 5.0:
            continue
        if hazard == HAZARD_WASHROOM:
            hazard = HAZARD_LH
        if hazard == HAZARD_LH and area_m2 > 126.0:
            hazard = HAZARD_OH

        _pts, regs, _bboxes = _process_room(poly, hazard_type=hazard)
        all_regions.extend(regs)

    # Determine source
    if override_source is not None:
        source = override_source
    else:
        global_sources = detect_sources_from_dxf(dxf_path, source_labels)

        min_x = min(p[0] for p in sprinkler_coords)
        max_x = max(p[0] for p in sprinkler_coords)
        min_y = min(p[1] for p in sprinkler_coords)
        max_y = max(p[1] for p in sprinkler_coords)
        center = ((min_x + max_x) / 2.0, (min_y + max_y) / 2.0)

        if global_sources:
            search_radius = 5.0 / world_to_m
            footprint = unary_union(all_regions).buffer(search_radius) if all_regions else Point(center).buffer(search_radius)
            local_sources = [(sx, sy) for sx, sy in global_sources if footprint.contains(Point(sx, sy))]
            if local_sources:
                source = min(local_sources, key=lambda s: math.hypot(s[0] - center[0], s[1] - center[1]))
            else:
                source = center
        else:
            source = center

    pipe_segments, snapped_sprinklers = route_pipes(sprinkler_coords, source, valid_regions=all_regions)

    logger.info(
        "route_pipes_for_sprinklers sprinklers=%d pipes=%d source=(%.1f, %.1f)",
        len(snapped_sprinklers), len(pipe_segments), source[0], source[1],
    )

    return pipe_segments, snapped_sprinklers, [source]
