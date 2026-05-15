import os
import json
import math
from typing import Dict, List, Tuple
import numpy as np
import cv2
from shapely.geometry import Polygon, LineString, Point, LinearRing
from shapely.validation import make_valid
from shapely.affinity import rotate
from shapely.ops import split, unary_union

# ============================================================
# CONFIGURATION
# ============================================================
ROOMS_JSON = "data\\projects\\1d4d4a6e-983f-47b4-805c-8ab106455ce2\\rooms_from_image.json"       # Input JSON
MAPPING_JSON = "data\\projects\\1d4d4a6e-983f-47b4-805c-8ab106455ce2\\mapping.json"
EXISTING_DXF = "data\\projects\\1d4d4a6e-983f-47b4-805c-8ab106455ce2\\out_fix\\input.dxf"
OUTPUT_DXF = "data\\projects\\1d4d4a6e-983f-47b4-805c-8ab106455ce2\\detectors_overlay.dxf"
OUTPUT_IMAGE = "data\\projects\\1d4d4a6e-983f-47b4-805c-8ab106455ce2\\detectors_symmetric.png"

# Scaling (assumes DXF units are mm, so 0.001 m/mm)
WORLD_TO_M = 0.001
DETECTOR_SPACING_M = 7

# Wall Splitting & Geometry Sensitivity
MIN_REGION_AREA_M2 = 2.5
NOISE_TOLERANCE_M = 0.15  # Filters out spikes/wobbles smaller than 15cm

# Ignore corners if the walls forming them are shorter than this (e.g., 0.5 meters)
MIN_WALL_LENGTH_M = 0.05

# Wall Buffer (Minimum distance a detector must be from any wall)
WALL_BUFFER_M = 0.5

# Post-Placement Global Line Alignment Setting
ALIGNMENT_TOLERANCE_M = 2  # Max distance (meters) to snap a point to a global horizontal/vertical line

# DXF Settings
DXF_LAYER_SMOKE = "AI_SMOKE_DETECTORS"
DXF_SYMBOL_RADIUS = 15.0*0.001/WORLD_TO_M
DXF_TEXT_HEIGHT = 15.0
DXF_TEXT_OFFSET = 200.0

# DXF Export check
try:
    import ezdxf
    EZDXF_OK = True
except ImportError:
    EZDXF_OK = False
    print("Warning: 'ezdxf' not found. DXF export will be skipped.")


# ============================================================
# COORDINATE MAPPING
# ============================================================

class CoordinateMapper:
    def __init__(self, mapping_path):
        with open(mapping_path, 'r') as f:
            data = json.load(f)

        self.W = float(data['width_px'])
        self.H = float(data['height_px'])
        self.bbox = data['world_bbox']

        self.xmin = float(self.bbox['xmin'])
        self.xmax = float(self.bbox['xmax'])
        self.ymin = float(self.bbox['ymin'])
        self.ymax = float(self.bbox['ymax'])

        self.x_range = self.xmax - self.xmin
        self.y_range = self.ymax - self.ymin

    def pixel_to_world(self, u, v):
        """Pixel (u,v) -> World (x,y)"""
        x = self.xmin + (float(u) * self.x_range / self.W)
        y = self.ymax - (float(v) * self.y_range / self.H)
        return x, y

    def world_to_pixel(self, x, y):
        """World (x,y) -> Pixel (u,v)"""
        u = (float(x) - self.xmin) * self.W / self.x_range
        v = (self.ymax - float(y)) * self.H / self.y_range
        return u, v


# ============================================================
# GEOMETRY HELPERS
# ============================================================

def parse_polygon(poly_coords):
    if not poly_coords or len(poly_coords) < 3:
        return None

    poly = Polygon(poly_coords)

    if not poly.is_valid:
        poly = make_valid(poly)

    if poly.geom_type == 'MultiPolygon':
        poly = max(poly.geoms, key=lambda p: p.area)
    elif poly.geom_type == 'GeometryCollection':
        polygons = [g for g in poly.geoms if g.geom_type in ['Polygon', 'MultiPolygon']]
        if not polygons:
            return None
        flat_polys = []
        for p in polygons:
            if p.geom_type == 'MultiPolygon':
                flat_polys.extend(p.geoms)
            else:
                flat_polys.append(p)
        poly = max(flat_polys, key=lambda p: p.area)

    return poly


def get_longest_wall_angle(poly):
    coords = list(poly.exterior.coords)
    max_len = 0.0
    best_angle = 0.0

    for i in range(len(coords) - 1):
        p1 = coords[i]
        p2 = coords[i + 1]
        dx = p2[0] - p1[0]
        dy = p2[1] - p1[1]
        length = (dx * dx + dy * dy) ** 0.5
        if length > max_len:
            max_len = length
            best_angle = math.atan2(dy, dx)

    return best_angle, poly.centroid.coords[0]


# ============================================================
# REFLEX VERTEX (VULNERABLE POINT) SPLITTING LOGIC
# ============================================================

def get_reflex_vertices(poly):
    coords = list(poly.exterior.coords)

    if LinearRing(coords).is_ccw:
        coords = coords[::-1]

    reflex_data = []
    n = len(coords) - 1

    min_len_world = MIN_WALL_LENGTH_M / WORLD_TO_M

    for i in range(n):
        p_prev = coords[i - 1]
        p_curr = coords[i]
        p_next = coords[(i + 1) % n]

        v1_x, v1_y = p_curr[0] - p_prev[0], p_curr[1] - p_prev[1]
        v2_x, v2_y = p_next[0] - p_curr[0], p_next[1] - p_curr[1]

        len1 = math.hypot(v1_x, v1_y)
        len2 = math.hypot(v2_x, v2_y)

        if len1 < min_len_world or len2 < min_len_world:
            continue

        cross_product = (v1_x * v2_y) - (v1_y * v2_x)

        if cross_product > 1e-4:
            reflex_data.append((p_curr, p_prev, p_next))

    return reflex_data


def split_at_reflex_vertex(poly, reflex_data):
    B, A, C = reflex_data
    x, y = B

    v1_x, v1_y = B[0] - A[0], B[1] - A[1]
    v2_x, v2_y = B[0] - C[0], B[1] - C[1]

    directions = []

    for vx, vy in [(v1_x, v1_y), (v2_x, v2_y)]:
        if abs(vx) > abs(vy):
            directions.append((math.copysign(1.0, vx), 0.0))
        else:
            directions.append((0.0, math.copysign(1.0, vy)))

    minx, miny, maxx, maxy = poly.bounds
    max_dist = max(maxx - minx, maxy - miny) + 1.0

    best_cut = None
    min_dist = float('inf')
    boundary = poly.boundary

    for dx, dy in directions:
        ray = LineString([(x, y), (x + dx * max_dist, y + dy * max_dist)])
        intersection = boundary.intersection(ray)

        if intersection.is_empty:
            continue

        points = []
        if intersection.geom_type == 'Point':
            points.append(intersection)
        elif intersection.geom_type == 'MultiPoint':
            points.extend(intersection.geoms)
        elif intersection.geom_type == 'GeometryCollection':
            for geom in intersection.geoms:
                if geom.geom_type == 'Point':
                    points.append(geom)
        elif intersection.geom_type in ['LineString', 'MultiLineString']:
            continue

        closest_pt = None
        closest_dist = float('inf')

        for pt in points:
            dist = Point(B).distance(pt)
            if 1e-3 < dist < closest_dist:
                closest_dist = dist
                closest_pt = pt

        if closest_pt is not None:
            cut_line = LineString([B, (closest_pt.x, closest_pt.y)])

            if poly.contains(cut_line.centroid):
                if closest_dist < min_dist:
                    min_dist = closest_dist

                    ext_x = closest_pt.x + dx * 0.1
                    ext_y = closest_pt.y + dy * 0.1
                    ext_start_x = x - dx * 0.1
                    ext_start_y = y - dy * 0.1
                    best_cut = LineString([(ext_start_x, ext_start_y), (ext_x, ext_y)])

    if best_cut is not None:
        try:
            res = split(poly, best_cut)
            polys = [g for g in res.geoms if g.geom_type in ('Polygon', 'MultiPolygon')]
            if len(polys) > 1:
                return polys
        except Exception:
            pass

    return [poly]


def decompose_recursive(poly):
    if poly.area < (MIN_REGION_AREA_M2 / (WORLD_TO_M ** 2)):
        return [poly]

    reflex_data_list = get_reflex_vertices(poly)

    if not reflex_data_list:
        return [poly]

    for r_data in reflex_data_list:
        parts = split_at_reflex_vertex(poly, r_data)
        if len(parts) > 1:
            out = []
            for p in parts:
                out.extend(decompose_recursive(p))
            return out

    return [poly]


# ============================================================
# SYMMETRIC PLACEMENT LOGIC
# ============================================================

def get_symmetric_grid_detectors(poly):
    # Lay the grid in the polygon's AXIS-ALIGNED bounding box (world frame).
    # Earlier versions rotated by the "longest wall" angle, but for axis-aligned
    # floor plans that rotation can be off by a small ε (whichever of the
    # top/bottom edges is slightly longer wins), tilting the entire grid and
    # making spacing in world X/Y look unequal even though it is correct in
    # the rotated frame. Working directly in the world frame keeps adjacent
    # detectors at exactly DETECTOR_SPACING_M apart along world X and world Y.
    minx, miny, maxx, maxy = poly.bounds

    width = maxx - minx
    height = maxy - miny

    spacing_world = DETECTOR_SPACING_M / WORLD_TO_M

    # Number of detectors along each axis. round() keeps adjacent detectors
    # exactly `spacing_world` apart; any uncovered strip near the walls is
    # filled by the BFS coverage-subtraction loop in `process_room`.
    nx = max(1, int(round(width / spacing_world)))
    ny = max(1, int(round(height / spacing_world)))

    # Center the fixed-pitch grid inside the bounding box.
    span_x = (nx - 1) * spacing_world
    span_y = (ny - 1) * spacing_world
    start_x = minx + (width - span_x) / 2.0
    start_y = miny + (height - span_y) / 2.0

    detectors = []
    for i in range(nx):
        for j in range(ny):
            lx = start_x + i * spacing_world
            ly = start_y + j * spacing_world

            p = Point(lx, ly)
            if poly.contains(p):
                detectors.append((lx, ly))  # WORLD COORDS

    return detectors


def _extract_polygons(geom, min_area_world):
    """Flatten a Shapely geometry into a list of Polygons above min area."""
    out = []
    if geom is None or geom.is_empty:
        return out
    if geom.geom_type == 'Polygon':
        if geom.area >= min_area_world:
            out.append(geom)
    elif geom.geom_type == 'MultiPolygon':
        for g in geom.geoms:
            if g.area >= min_area_world:
                out.append(g)
    elif geom.geom_type == 'GeometryCollection':
        for g in geom.geoms:
            out.extend(_extract_polygons(g, min_area_world))
    return out


def process_room(room_poly):
    detectors = []
    regions = []

    tolerance_world = NOISE_TOLERANCE_M / WORLD_TO_M
    clean_poly = room_poly.simplify(tolerance_world, preserve_topology=True)

    if not clean_poly.is_valid:
        clean_poly = make_valid(clean_poly)
        if clean_poly.geom_type == 'GeometryCollection':
            polys = [g for g in clean_poly.geoms if g.geom_type in ['Polygon', 'MultiPolygon']]
            if polys:
                clean_poly = max(polys, key=lambda p: p.area)

    sub_polys = decompose_recursive(clean_poly)
    min_area_world = MIN_REGION_AREA_M2 / (WORLD_TO_M ** 2)

    # Keep decomposed pieces as "regions" for the downstream wall-buffer alignment step.
    regions = [p for p in sub_polys if p.area >= min_area_world]
    if not regions:
        return detectors, regions

    coverage_radius_world = DETECTOR_SPACING_M / WORLD_TO_M

    # --- Step 1: seed initial symmetric grid in the LARGEST sub-polygon only ---
    seed_poly = max(regions, key=lambda p: p.area)
    seed_points = get_symmetric_grid_detectors(seed_poly)
    if not seed_points:
        rp = seed_poly.representative_point()
        seed_points = [(rp.x, rp.y)]
    detectors.extend(seed_points)

    # --- Step 2..N: BFS-style coverage subtraction over the full clean polygon.
    # We process ONE leftover sub-polygon per iteration (largest first), then
    # immediately recompute coverage. This way every new detector is placed
    # against the up-to-date coverage of all previously placed detectors, so
    # the ≥ DETECTOR_SPACING_M separation is enforced by the geometry itself
    # (no explicit pairwise distance filter needed). ---
    MAX_ITERATIONS = 200  # safety cap; one piece per iter, so set generously
    for _ in range(MAX_ITERATIONS):
        # Union of coverage disks (radius = DETECTOR_SPACING_M) around all placed detectors.
        coverage = unary_union(
            [Point(x, y).buffer(coverage_radius_world) for (x, y) in detectors]
        )
        remaining = clean_poly.difference(coverage)
        leftover_pieces = _extract_polygons(remaining, min_area_world)
        if not leftover_pieces:
            break

        # Decompose every leftover piece (concave shapes from disk subtraction).
        decomposed_leftovers = []
        for piece in leftover_pieces:
            piece_clean = piece.simplify(tolerance_world, preserve_topology=True)
            if not piece_clean.is_valid:
                piece_clean = make_valid(piece_clean)
            for sub in _extract_polygons(piece_clean, min_area_world):
                decomposed_leftovers.extend(
                    p for p in decompose_recursive(sub) if p.area >= min_area_world
                )

        if not decomposed_leftovers:
            break

        # Pick the LARGEST uncovered sub-polygon and process only it this iteration.
        # The next iteration will see the new coverage and pick the next largest piece.
        target_piece = max(decomposed_leftovers, key=lambda p: p.area)

        pts = get_symmetric_grid_detectors(target_piece)
        if not pts:
            rp = target_piece.representative_point()
            pts = [(rp.x, rp.y)]

        # Anti-stall guard: if every candidate in this piece is already inside
        # the current coverage (e.g. piece is a thin sliver squeezed between
        # existing disks), skip it so we don't loop forever on it.
        accepted = [(cx, cy) for (cx, cy) in pts if not coverage.contains(Point(cx, cy))]
        if not accepted:
            # Drop this piece from consideration by treating it as covered:
            # extend the coverage manually for the next iter — but simpler is
            # to just stop, since the only remaining work is sub-spacing slivers.
            break

        detectors.extend(accepted)
        regions.append(target_piece)

    return detectors, regions


# ============================================================
# FINAL ALIGNMENT: 2D GLOBAL GRID & WALL BUFFER
# ============================================================

def align_to_global_lines(detectors, regions, tolerance_m):
    """
    Forces detectors to snap to both horizontal and vertical global grid lines,
    while strictly refusing to place them closer than WALL_BUFFER_M to any wall.
    """
    if not detectors:
        return []

    tolerance_world = tolerance_m / WORLD_TO_M
    wall_buffer_world = WALL_BUFFER_M / WORLD_TO_M  # Strict wall buffer

    # 1. Group coordinates into shared global grid lines
    def extract_global_lines(coords):
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

    global_x_lines = extract_global_lines([d[0] for d in detectors])
    global_y_lines = extract_global_lines([d[1] for d in detectors])

    aligned_detectors = []

    # 2. Process and snap each detector
    for x, y in detectors:
        pt = Point(x, y)

        # Find parent region
        parent_region = None
        for r in regions:
            if r.contains(pt) or r.distance(pt) < 1e-3:
                parent_region = r
                break

        if not parent_region:
            aligned_detectors.append((x, y))
            continue

        # Enforce strict WALL_BUFFER_M distance
        safe_zone = parent_region.buffer(-wall_buffer_world)

        # If the room itself is so narrow that the buffer consumes it, we slightly relax
        # it just for this specific tiny room, but keep it as buffered as geometrically possible.
        if safe_zone.is_empty or safe_zone.area <= 0:
            safe_zone = parent_region.buffer(-0.1 / WORLD_TO_M)
            if safe_zone.is_empty:
                safe_zone = parent_region

        # Find ALL nearby grid lines within the tolerance
        valid_x = sorted([gx for gx in global_x_lines if abs(gx - x) <= tolerance_world], key=lambda gx: abs(gx - x))
        valid_y = sorted([gy for gy in global_y_lines if abs(gy - y) <= tolerance_world], key=lambda gy: abs(gy - y))

        if not valid_x: valid_x = [x]
        if not valid_y: valid_y = [y]

        best_pt = None

        # TRY: Ensure BOTH Vertical and Horizontal alignment
        for gx in valid_x:
            for gy in valid_y:
                if safe_zone.contains(Point(gx, gy)):
                    best_pt = (gx, gy)
                    break
            if best_pt: break

        # FALLBACK: If we can't align both axes without hitting a wall, try aligning at least one axis
        if not best_pt:
            for gx in valid_x:
                if safe_zone.contains(Point(gx, y)):
                    best_pt = (gx, y)
                    break

        if not best_pt:
            for gy in valid_y:
                if safe_zone.contains(Point(x, gy)):
                    best_pt = (x, gy)
                    break

        if best_pt:
            aligned_detectors.append(best_pt)
        else:
            # Absolute fallback if it's completely boxed in
            aligned_detectors.append((x, y))

    return aligned_detectors


def visualize_global_snapping_debug(
    all_regions,
    detectors_before,
    detectors_after,
    output_path,
    tolerance_m,
):
    if not all_regions:
        return

    minx = min(p.bounds[0] for p in all_regions)
    miny = min(p.bounds[1] for p in all_regions)
    maxx = max(p.bounds[2] for p in all_regions)
    maxy = max(p.bounds[3] for p in all_regions)

    target_w = 2200
    world_w = max(1.0, (maxx - minx))
    scale = target_w / world_w

    margin_px = 80
    w_px = int((maxx - minx) * scale) + 2 * margin_px
    h_px = int((maxy - miny) * scale) + 2 * margin_px
    w_px = max(500, min(w_px, 5000))
    h_px = max(500, min(h_px, 5000))

    img = np.full((h_px, w_px, 3), 20, dtype=np.uint8)

    def to_px(wx, wy):
        px = int((wx - minx) * scale) + margin_px
        py = int((maxy - wy) * scale) + margin_px
        return px, py

    for reg in all_regions:
        pts = np.array([to_px(x, y) for (x, y) in reg.exterior.coords], dtype=np.int32)
        overlay = img.copy()
        cv2.fillPoly(overlay, [pts], (42, 46, 62))
        cv2.addWeighted(overlay, 0.35, img, 0.65, 0, img)
        cv2.polylines(img, [pts], True, (90, 110, 130), 1)

    if detectors_before:
        tolerance_world = tolerance_m / WORLD_TO_M

        def extract_global_lines(coords):
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

        global_x_lines = extract_global_lines([d[0] for d in detectors_before])
        global_y_lines = extract_global_lines([d[1] for d in detectors_before])

        for gx in global_x_lines:
            p1 = to_px(gx, miny)
            p2 = to_px(gx, maxy)
            cv2.line(img, p1, p2, (235, 185, 60), 1, cv2.LINE_AA)

        for gy in global_y_lines:
            p1 = to_px(minx, gy)
            p2 = to_px(maxx, gy)
            cv2.line(img, p1, p2, (60, 185, 235), 1, cv2.LINE_AA)

    for (dx, dy) in detectors_before:
        px, py = to_px(dx, dy)
        if 0 <= px < w_px and 0 <= py < h_px:
            cv2.circle(img, (px, py), 7, (0, 165, 255), 2, cv2.LINE_AA)

    for (dx, dy) in detectors_after:
        px, py = to_px(dx, dy)
        if 0 <= px < w_px and 0 <= py < h_px:
            cv2.circle(img, (px, py), 7, (0, 0, 255), 2, cv2.LINE_AA)
            cv2.putText(img, "S", (px - 4, py + 4), cv2.FONT_HERSHEY_SIMPLEX, 0.45, (0, 0, 255), 1, cv2.LINE_AA)

    cv2.putText(img, "Global snapping debug", (20, 32), cv2.FONT_HERSHEY_SIMPLEX, 0.85, (230, 230, 230), 2, cv2.LINE_AA)
    cv2.putText(img, "orange ring = before snap, red S circle = after snap", (20, 58), cv2.FONT_HERSHEY_SIMPLEX, 0.58, (210, 210, 210), 1, cv2.LINE_AA)
    cv2.putText(img, "yellow vertical / blue horizontal = inferred global snap lines", (20, 82), cv2.FONT_HERSHEY_SIMPLEX, 0.58, (210, 210, 210), 1, cv2.LINE_AA)

    os.makedirs(os.path.dirname(output_path), exist_ok=True)
    cv2.imwrite(output_path, img)


def _world_to_pixel_from_mapping(x, y, mapping):
    bbox = mapping["world_bbox"]
    xmin, xmax = float(bbox["xmin"]), float(bbox["xmax"])
    ymin, ymax = float(bbox["ymin"]), float(bbox["ymax"])
    pixel_fit = mapping.get("pixel_fit")
    if pixel_fit and float(pixel_fit.get("scale", 0.0)) > 0.0:
        scale = float(pixel_fit["scale"])
        offset_x = float(pixel_fit.get("offset_x", 0.0))
        offset_y = float(pixel_fit.get("offset_y", 0.0))
        px = offset_x + (float(x) - xmin) * scale
        py = offset_y + (ymax - float(y)) * scale
        return px, py

    width_px = float(mapping["width_px"])
    height_px = float(mapping["height_px"])
    u = (float(x) - xmin) / max(1e-9, (xmax - xmin))
    v = (ymax - float(y)) / max(1e-9, (ymax - ymin))
    return u * width_px, v * height_px


def visualize_global_snapping_overlay(
    base_png_path,
    mapping_json_path,
    all_regions,
    detectors_before,
    detectors_after,
    tolerance_m,
    output_path,
):
    if not os.path.exists(base_png_path) or not os.path.exists(mapping_json_path):
        return

    base = cv2.imread(base_png_path)
    if base is None:
        return

    with open(mapping_json_path, "r", encoding="utf-8") as f:
        mapping = json.load(f)

    img = base.copy()
    room_overlay = img.copy()
    bbox = mapping["world_bbox"]
    xmin, xmax = float(bbox["xmin"]), float(bbox["xmax"])
    ymin, ymax = float(bbox["ymin"]), float(bbox["ymax"])

    palette = [
        (66, 135, 245),
        (52, 211, 153),
        (245, 158, 11),
        (239, 68, 68),
        (168, 85, 247),
        (14, 165, 233),
        (250, 204, 21),
    ]

    for idx, reg in enumerate(all_regions):
        pts = []
        for wx, wy in reg.exterior.coords:
            px, py = _world_to_pixel_from_mapping(wx, wy, mapping)
            pts.append([int(round(px)), int(round(py))])
        if len(pts) >= 3:
            poly = np.array(pts, dtype=np.int32)
            color = palette[idx % len(palette)]
            cv2.fillPoly(room_overlay, [poly], color)
            cv2.polylines(room_overlay, [poly], True, (255, 255, 255), 1, cv2.LINE_AA)

    cv2.addWeighted(room_overlay, 0.32, img, 0.68, 0, img)

    tolerance_world = tolerance_m / WORLD_TO_M

    def extract_global_lines(coords):
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

    global_x_lines = extract_global_lines([d[0] for d in detectors_before])
    global_y_lines = extract_global_lines([d[1] for d in detectors_before])

    for gx in global_x_lines:
        x1, y1 = _world_to_pixel_from_mapping(gx, ymin, mapping)
        x2, y2 = _world_to_pixel_from_mapping(gx, ymax, mapping)
        cv2.line(img, (int(round(x1)), int(round(y1))), (int(round(x2)), int(round(y2))), (235, 185, 60), 1, cv2.LINE_AA)

    for gy in global_y_lines:
        x1, y1 = _world_to_pixel_from_mapping(xmin, gy, mapping)
        x2, y2 = _world_to_pixel_from_mapping(xmax, gy, mapping)
        cv2.line(img, (int(round(x1)), int(round(y1))), (int(round(x2)), int(round(y2))), (60, 185, 235), 1, cv2.LINE_AA)

    for (x, y) in detectors_before:
        px, py = _world_to_pixel_from_mapping(x, y, mapping)
        cv2.circle(img, (int(round(px)), int(round(py))), 7, (0, 165, 255), 2, cv2.LINE_AA)

    for (x, y) in detectors_after:
        px, py = _world_to_pixel_from_mapping(x, y, mapping)
        cx, cy = int(round(px)), int(round(py))
        cv2.circle(img, (cx, cy), 7, (0, 0, 255), 2, cv2.LINE_AA)
        cv2.putText(img, "S", (cx - 4, cy + 4), cv2.FONT_HERSHEY_SIMPLEX, 0.45, (0, 0, 255), 1, cv2.LINE_AA)

    cv2.putText(img, "Global snapping overlay", (20, 32), cv2.FONT_HERSHEY_SIMPLEX, 0.85, (30, 30, 30), 2, cv2.LINE_AA)
    cv2.putText(img, "orange ring=before, red S circle=after, yellow/blue=snap lines", (20, 58), cv2.FONT_HERSHEY_SIMPLEX, 0.58, (30, 30, 30), 1, cv2.LINE_AA)
    os.makedirs(os.path.dirname(output_path), exist_ok=True)
    cv2.imwrite(output_path, img)


# ============================================================
# DXF EXPORT
# ============================================================

def _looks_like_pixels(detectors, mapper: CoordinateMapper):
    if not detectors:
        return False
    W, H = mapper.W, mapper.H
    inside = 0
    for x, y in detectors:
        if 0 <= x <= W and 0 <= y <= H:
            inside += 1
    return (inside / max(1, len(detectors))) > 0.8


def export_dxf_overlay(detectors_xy, mapping_json, input_dxf_path, output_dxf_path):
    if not EZDXF_OK:
        return

    if not os.path.exists(mapping_json):
        print(f"Error: Mapping file not found at {mapping_json}")
        return
    mapper = CoordinateMapper(mapping_json)

    print(f"Loading DXF: {input_dxf_path}...")
    if os.path.exists(input_dxf_path):
        try:
            doc = ezdxf.readfile(input_dxf_path)
        except Exception as e:
            print(f"Failed to read DXF, creating new. Error: {e}")
            doc = ezdxf.new()
    else:
        doc = ezdxf.new()

    msp = doc.modelspace()

    if DXF_LAYER_SMOKE not in doc.layers:
        doc.layers.new(name=DXF_LAYER_SMOKE, dxfattribs={'color': 1})

    treat_as_pixels = _looks_like_pixels(detectors_xy, mapper)
    print(f"Export mode: {'PIXEL->WORLD (mapped)' if treat_as_pixels else 'WORLD (direct)'}")
    print(f"Placing {len(detectors_xy)} detectors...")

    for i, (a, b) in enumerate(detectors_xy):
        if treat_as_pixels:
            wx, wy = mapper.pixel_to_world(a, b)
        else:
            wx, wy = float(a), float(b)

        msp.add_circle((wx, wy), radius=DXF_SYMBOL_RADIUS, dxfattribs={'layer': DXF_LAYER_SMOKE})

        label = f"SD-{i+1}"
        try:
            txt = msp.add_text(
                label,
                dxfattribs={
                    'layer': DXF_LAYER_SMOKE,
                    'height': DXF_TEXT_HEIGHT
                }
            )
            txt.set_placement((wx + DXF_TEXT_OFFSET, wy + DXF_TEXT_OFFSET))
        except Exception:
            pass

    doc.saveas(output_dxf_path)
    print(f"DXF saved to: {output_dxf_path}")


# ============================================================
# VISUALIZATION (WORLD SPACE DRAW)
# ============================================================

def visualize_results(all_regions, all_detectors, output_path):
    if not all_regions:
        return

    minx = min(p.bounds[0] for p in all_regions)
    miny = min(p.bounds[1] for p in all_regions)
    maxx = max(p.bounds[2] for p in all_regions)
    maxy = max(p.bounds[3] for p in all_regions)

    target_w = 2200
    world_w = max(1.0, (maxx - minx))
    scale = target_w / world_w

    margin_px = 80
    w_px = int((maxx - minx) * scale) + 2 * margin_px
    h_px = int((maxy - miny) * scale) + 2 * margin_px
    w_px = max(400, min(w_px, 4000))
    h_px = max(400, min(h_px, 4000))

    img = np.zeros((h_px, w_px, 3), dtype=np.uint8)

    def to_px(wx, wy):
        px = int((wx - minx) * scale) + margin_px
        py = int((maxy - wy) * scale) + margin_px
        return (px, py)

    for reg in all_regions:
        pts = np.array([to_px(x, y) for (x, y) in reg.exterior.coords], dtype=np.int32)
        color = np.random.randint(50, 150, 3).tolist()
        overlay = img.copy()
        cv2.fillPoly(overlay, [pts], color)
        cv2.addWeighted(overlay, 0.5, img, 0.5, 0, img)
        cv2.polylines(img, [pts], True, (200, 200, 200), 1)

    for (dx, dy) in all_detectors:
        px, py = to_px(dx, dy)
        if 0 <= px < w_px and 0 <= py < h_px:
            cv2.circle(img, (px, py), 6, (0, 0, 255), 2)
            cv2.putText(img, "S", (px - 4, py + 4), cv2.FONT_HERSHEY_SIMPLEX, 0.45, (0, 0, 255), 1, cv2.LINE_AA)
            cv2.circle(img, (px, py), 8, (255, 255, 255), 2)

    cv2.imwrite(output_path, img)
    print(f"Visualization saved: {output_path}")


# ============================================================
# PIPELINE ADAPTERS
# ============================================================

def _set_runtime_config(spacing_m: float, wall_buffer_m: float, world_to_m: float):
    global DETECTOR_SPACING_M, WALL_BUFFER_M, WORLD_TO_M
    DETECTOR_SPACING_M = float(spacing_m)
    WALL_BUFFER_M = float(wall_buffer_m)
    WORLD_TO_M = float(world_to_m)


def place_detectors_for_room(poly_world: Polygon, spacing_m: float, wall_buffer_m: float, world_to_m: float):
    _set_runtime_config(spacing_m=spacing_m, wall_buffer_m=wall_buffer_m, world_to_m=world_to_m)
    detectors, regions = process_room(poly_world)
    # NOTE: align_to_global_lines is intentionally skipped — it can pull detectors
    # up to ALIGNMENT_TOLERANCE_M onto cross-room snap lines and destroy the
    # exact DETECTOR_SPACING_M lattice produced by process_room.
    return detectors, regions


def place_detectors_from_rooms_json(
    rooms: List[Dict],
    spacing_m: float,
    wall_buffer_m: float,
    world_to_m: float,
    debug_png_path: str | None = None,
    debug_overlay_png_path: str | None = None,
    mapping_json_path: str | None = None,
    base_png_path: str | None = None,
) -> Tuple[List[Tuple[float, float]], List[Polygon]]:
    _set_runtime_config(spacing_m=spacing_m, wall_buffer_m=wall_buffer_m, world_to_m=world_to_m)

    all_detectors_world: List[Tuple[float, float]] = []
    all_regions: List[Polygon] = []

    for room in rooms:
        poly = parse_polygon(room.get("polygon_world"))
        if poly is None:
            continue

        dets, regs = process_room(poly)
        all_detectors_world.extend(dets)
        all_regions.extend(regs)

    detectors_before_snap = list(all_detectors_world)
    # NOTE: align_to_global_lines is intentionally skipped — it can pull detectors
    # up to ALIGNMENT_TOLERANCE_M onto cross-room snap lines and destroy the
    # exact DETECTOR_SPACING_M lattice produced by process_room.
    # all_detectors_world = align_to_global_lines(all_detectors_world, all_regions, ALIGNMENT_TOLERANCE_M)

    if debug_png_path:
        visualize_global_snapping_debug(
            all_regions=all_regions,
            detectors_before=detectors_before_snap,
            detectors_after=all_detectors_world,
            output_path=debug_png_path,
            tolerance_m=ALIGNMENT_TOLERANCE_M,
        )

    if debug_overlay_png_path and mapping_json_path and base_png_path:
        visualize_global_snapping_overlay(
            base_png_path=base_png_path,
            mapping_json_path=mapping_json_path,
            all_regions=all_regions,
            detectors_before=detectors_before_snap,
            detectors_after=all_detectors_world,
            tolerance_m=ALIGNMENT_TOLERANCE_M,
            output_path=debug_overlay_png_path,
        )

    return all_detectors_world, all_regions