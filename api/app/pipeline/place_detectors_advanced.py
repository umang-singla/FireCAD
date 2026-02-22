"""Advanced detector placement (ported from your Colab notebook cell 12).

This module focuses on *placement logic* and returns detector points in WORLD coords.

Assumptions:
- Input room polygons are already in world coordinates (DXF modelspace units).
- `world_to_m` converts DXF units -> meters (mm => 0.001, inches => 0.0254, feet => 0.3048, meters => 1.0).
"""

import math
from typing import List, Tuple, Dict

import numpy as np
from shapely.geometry import Polygon, Point, LinearRing
from shapely.validation import make_valid
from shapely.affinity import rotate
from shapely.ops import split


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


def get_longest_wall_angle(poly: Polygon):
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


def densify_ring(coords, step_dist):
    ring = []
    for i in range(len(coords) - 1):
        x1, y1 = coords[i]
        x2, y2 = coords[i + 1]
        dx = x2 - x1
        dy = y2 - y1
        seg_len = (dx * dx + dy * dy) ** 0.5
        if seg_len <= 1e-9:
            continue
        steps = max(1, int(seg_len / step_dist))
        for s in range(steps):
            t = s / steps
            ring.append((x1 + t * dx, y1 + t * dy))
    ring.append(coords[-1])
    return ring


def smooth_ring(coords, noise_tol):
    """Remove tiny spikes by skipping points that create very short segments."""
    if len(coords) <= 4:
        return coords

    out = [coords[0]]
    for i in range(1, len(coords) - 1):
        x0, y0 = out[-1]
        x1, y1 = coords[i]
        x2, y2 = coords[i + 1]
        d1 = ((x1 - x0) ** 2 + (y1 - y0) ** 2) ** 0.5
        d2 = ((x2 - x1) ** 2 + (y2 - y1) ** 2) ** 0.5
        if d1 < noise_tol and d2 < noise_tol:
            continue
        out.append(coords[i])
    out.append(coords[-1])
    return out


def polygon_wall_lengths(poly: Polygon):
    coords = list(poly.exterior.coords)
    lengths = []
    for i in range(len(coords) - 1):
        x1, y1 = coords[i]
        x2, y2 = coords[i + 1]
        lengths.append(((x2 - x1) ** 2 + (y2 - y1) ** 2) ** 0.5)
    return lengths


def buffered_interior(poly: Polygon, wall_buffer_world: float):
    """Shrink polygon inward by wall buffer. If it collapses, return None."""
    try:
        inner = poly.buffer(-wall_buffer_world)
        if inner.is_empty:
            return None
        if inner.geom_type == 'MultiPolygon':
            inner = max(inner.geoms, key=lambda p: p.area)
        return inner
    except Exception:
        return None


def grid_points_in_polygon(poly: Polygon, spacing_world: float):
    minx, miny, maxx, maxy = poly.bounds
    pts = []
    x = minx
    while x <= maxx:
        y = miny
        while y <= maxy:
            p = Point(x, y)
            if poly.contains(p):
                pts.append((x, y))
            y += spacing_world
        x += spacing_world
    return pts


def farthest_point_sampling(points: List[Tuple[float, float]], k: int):
    if not points or k <= 0:
        return []
    pts = np.array(points, dtype=np.float64)
    # start at centroid-ish
    idx = np.random.randint(0, len(points))
    chosen = [idx]
    dist = np.full(len(points), np.inf, dtype=np.float64)

    for _ in range(1, k):
        last = pts[chosen[-1]]
        d = np.sum((pts - last) ** 2, axis=1)
        dist = np.minimum(dist, d)
        idx = int(np.argmax(dist))
        chosen.append(idx)

    return [tuple(pts[i]) for i in chosen]


def snap_to_grid(points: List[Tuple[float, float]], tol_world: float):
    """Snap points that are almost aligned to shared x or y lines."""
    if not points:
        return points
    xs = [p[0] for p in points]
    ys = [p[1] for p in points]

    snapped = []
    for x,y in points:
        # snap x to any common x within tol
        bestx = x
        for gx in xs:
            if abs(gx - x) <= tol_world:
                bestx = gx
                break
        besty = y
        for gy in ys:
            if abs(gy - y) <= tol_world:
                besty = gy
                break
        snapped.append((bestx, besty))
    return snapped


def place_detectors_for_room(poly_world: Polygon, spacing_m: float, wall_buffer_m: float, world_to_m: float):
    spacing_world = spacing_m / world_to_m
    wall_buffer_world = wall_buffer_m / world_to_m

    # Smooth noisy outlines
    coords = list(poly_world.exterior.coords)
    coords = smooth_ring(coords, noise_tol=0.15 / world_to_m)
    poly_world = Polygon(coords)
    if not poly_world.is_valid:
        poly_world = make_valid(poly_world)
        if poly_world.geom_type == "MultiPolygon":
            poly_world = max(poly_world.geoms, key=lambda p: p.area)

    inner = buffered_interior(poly_world, wall_buffer_world)
    if inner is None:
        # fallback: centroid if any
        c = poly_world.centroid
        return [(float(c.x), float(c.y))], [poly_world]

    # Decide how many detectors: area coverage heuristic
    area_m2 = inner.area * (world_to_m ** 2)
    if area_m2 <= 0:
        c = poly_world.centroid
        return [(float(c.x), float(c.y))], [poly_world]

    # Each detector covers roughly spacing^2 area (very rough). Ensure at least 1.
    k = max(1, int(math.ceil(area_m2 / max(1e-6, (spacing_m * spacing_m)))))

    # Candidate points on grid
    candidates = grid_points_in_polygon(inner, spacing_world)
    if len(candidates) == 0:
        c = inner.centroid
        return [(float(c.x), float(c.y))], [inner]

    # If too many candidates, sample
    k = min(k, max(1, len(candidates)))
    chosen = farthest_point_sampling(candidates, k)

    # Snap a little for aesthetics
    chosen = snap_to_grid(chosen, tol_world=(2.0 / world_to_m))

    return chosen, [inner]


def place_detectors_from_rooms_json(rooms: List[Dict], spacing_m: float, wall_buffer_m: float, world_to_m: float):
    all_detectors = []
    all_regions = []
    for r in rooms:
        poly = parse_polygon(r.get("polygon_world"))
        if poly is None:
            continue
        dets, regs = place_detectors_for_room(poly, spacing_m, wall_buffer_m, world_to_m)
        all_detectors.extend(dets)
        all_regions.extend(regs)

    # Global align
    all_detectors = snap_to_grid(all_detectors, tol_world=(2.0 / world_to_m))
    return all_detectors, all_regions
