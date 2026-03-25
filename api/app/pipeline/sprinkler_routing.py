"""Sprinkler placement and orthogonal pipe routing.

Ported from the notebook pipeline (Cells 19-20).  Produces sprinkler
coordinates, sized pipe segments, and optionally exports them into a DXF.
"""

import os
import math
import logging
from typing import Dict, List, Tuple

import numpy as np
import cv2
from shapely.geometry import Polygon, LineString, Point, LinearRing
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

logger = logging.getLogger("firecad.pipeline.sprinkler_routing")

# ── runtime defaults (overridden by callers) ──────────────────────
WORLD_TO_M = 0.001
SPRINKLER_SPACING_M = 3.0
MIN_REGION_AREA_M2 = 2.5
NOISE_TOLERANCE_M = 0.15
MIN_WALL_LENGTH_M = 0.05
WALL_BUFFER_M = 0.5
ALIGNMENT_TOLERANCE_M = 2.0

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
def _get_grid_points(poly):
    angle_rad, (cx, cy) = _get_longest_wall_angle(poly)
    angle_deg = math.degrees(angle_rad)
    rot_poly = rotate(poly, -angle_deg, origin=(cx, cy))
    minx, miny, maxx, maxy = rot_poly.bounds
    width, height = maxx - minx, maxy - miny
    spacing_world = SPRINKLER_SPACING_M / WORLD_TO_M

    nx_pts = max(1, math.ceil(width / spacing_world))
    ny_pts = max(1, math.ceil(height / spacing_world))
    step_x, step_y = width / nx_pts, height / ny_pts

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


def _process_room(room_poly):
    points: List[Tuple[float, float]] = []
    regions: List[Polygon] = []
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
        grid = _get_grid_points(poly)
        if not grid:
            rep = poly.representative_point()
            grid = [(rep.x, rep.y)]
        points.extend(grid)
    return points, regions


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


# ──────────────────────────────────────────────────────────────────
# Orthogonal pipe routing
# ──────────────────────────────────────────────────────────────────
def _cluster_values(values: List[float], tolerance: float) -> List[List[int]]:
    """Group indices of *values* into clusters where members are within
    *tolerance* of each other.  Returns list of index-groups."""
    indexed = sorted(enumerate(values), key=lambda iv: iv[1])
    clusters: List[List[int]] = []
    cur_cluster: List[int] = []
    cur_val = None
    for idx, val in indexed:
        if cur_val is None or abs(val - cur_val) <= tolerance:
            cur_cluster.append(idx)
        else:
            clusters.append(cur_cluster)
            cur_cluster = [idx]
        cur_val = val
    if cur_cluster:
        clusters.append(cur_cluster)
    return clusters


def route_pipes(
    sprinklers: List[Tuple[float, float]],
    source: Tuple[float, float],
    valid_regions: List[Polygon] | None = None,
) -> Tuple[List[Tuple[Tuple[Tuple[float, float], Tuple[float, float]], str]], List[Tuple[float, float]]]:
    """Route orthogonal pipes from *source* to each sprinkler.

    Clusters sprinklers by their actual column/row positions, creates branch
    lines through each cluster, and connects branches with a perpendicular trunk.

    Returns ``(pipe_segments, snapped_sprinklers)`` where each pipe segment is
    ``((pt1, pt2), diameter_label)``.
    """
    if not _NX_OK:
        raise RuntimeError("networkx is required for pipe routing")

    if not sprinklers:
        return [], []

    source = (round(source[0], 4), round(source[1], 4))
    sprinklers = [(round(s[0], 4), round(s[1], 4)) for s in sprinklers]

    xs = [s[0] for s in sprinklers]
    ys = [s[1] for s in sprinklers]
    is_horizontal_trunk = (max(xs) - min(xs)) > (max(ys) - min(ys))

    # Tolerance: sprinklers whose column/row coords differ by less than this
    # are considered part of the same column/row.
    cluster_tol = (SPRINKLER_SPACING_M * 0.4) / WORLD_TO_M

    G = nx.Graph()
    G.add_node(source)
    sprinkler_set = set(sprinklers)
    for s in sprinklers:
        G.add_node(s)

    if is_horizontal_trunk:
        # Group sprinklers into vertical columns by x-coordinate
        col_clusters = _cluster_values(xs, cluster_tol)
        # Representative x for each column = mean of member x values
        columns: List[Tuple[float, List[Tuple[float, float]]]] = []
        for cluster_indices in col_clusters:
            col_x = round(sum(xs[i] for i in cluster_indices) / len(cluster_indices), 4)
            members = [sprinklers[i] for i in cluster_indices]
            columns.append((col_x, members))

        # Trunk runs horizontally at the median y of all sprinklers
        all_y = sorted(ys)
        trunk_y = round(all_y[len(all_y) // 2], 4)

        trunk_points = set()

        for col_x, members in columns:
            # Trunk junction for this column
            trunk_pt = (col_x, trunk_y)
            trunk_points.add(trunk_pt)

            # Gather all points on this vertical branch: trunk junction + sprinklers
            branch_nodes = [trunk_pt]
            for s in members:
                # If sprinkler has same x as column, it sits on the branch line.
                # Otherwise add a junction at (col_x, s_y) and a short horizontal stub.
                junction = (col_x, s[1])
                branch_nodes.append(junction)
                if junction != s:
                    G.add_edge(junction, s)

            # Connect branch nodes vertically (sorted by y)
            branch_nodes = sorted(set(branch_nodes), key=lambda p: p[1])
            for i in range(len(branch_nodes) - 1):
                G.add_edge(branch_nodes[i], branch_nodes[i + 1])

        # Connect source to trunk
        feed_pt = (source[0], trunk_y)
        G.add_edge(source, feed_pt)
        trunk_points.add(feed_pt)

        # Connect trunk points horizontally
        trunk_nodes = sorted(trunk_points, key=lambda p: p[0])
        for i in range(len(trunk_nodes) - 1):
            G.add_edge(trunk_nodes[i], trunk_nodes[i + 1])

    else:
        # Group sprinklers into horizontal rows by y-coordinate
        row_clusters = _cluster_values(ys, cluster_tol)
        rows: List[Tuple[float, List[Tuple[float, float]]]] = []
        for cluster_indices in row_clusters:
            row_y = round(sum(ys[i] for i in cluster_indices) / len(cluster_indices), 4)
            members = [sprinklers[i] for i in cluster_indices]
            rows.append((row_y, members))

        # Trunk runs vertically at the median x of all sprinklers
        all_x = sorted(xs)
        trunk_x = round(all_x[len(all_x) // 2], 4)

        trunk_points = set()

        for row_y, members in rows:
            trunk_pt = (trunk_x, row_y)
            trunk_points.add(trunk_pt)

            branch_nodes = [trunk_pt]
            for s in members:
                junction = (s[0], row_y)
                branch_nodes.append(junction)
                if junction != s:
                    G.add_edge(junction, s)

            branch_nodes = sorted(set(branch_nodes), key=lambda p: p[0])
            for i in range(len(branch_nodes) - 1):
                G.add_edge(branch_nodes[i], branch_nodes[i + 1])

        # Connect source to trunk
        feed_pt = (trunk_x, source[1])
        G.add_edge(source, feed_pt)
        trunk_points.add(feed_pt)

        # Connect trunk points vertically
        trunk_nodes = sorted(trunk_points, key=lambda p: p[1])
        for i in range(len(trunk_nodes) - 1):
            G.add_edge(trunk_nodes[i], trunk_nodes[i + 1])

    # Directed tree via BFS from source
    try:
        directed_tree = nx.bfs_tree(G, source=source)
    except Exception as e:
        logger.warning("route_pipes bfs_tree failed: %s", e)
        return [], sprinklers

    node_cost = {node: (1 if node in sprinkler_set else 0) for node in directed_tree.nodes()}
    subtree_counts: Dict = {}
    for node in reversed(list(nx.topological_sort(directed_tree))):
        count = node_cost[node]
        for child in directed_tree.successors(node):
            count += subtree_counts[child]
        subtree_counts[node] = count

    raw_segments = []
    for u, v in directed_tree.edges():
        fed = subtree_counts[v]
        if fed > 0:
            raw_segments.append((u, v, get_pipe_diameter_label(fed)))

    # Merge collinear segments
    horiz_lines: Dict[float, list] = {}
    vert_lines: Dict[float, list] = {}
    for u, v, label in raw_segments:
        pt1, pt2 = sorted([u, v])
        if abs(pt1[1] - pt2[1]) < 1e-4:
            y = round(pt1[1], 4)
            horiz_lines.setdefault(y, []).append((round(pt1[0], 4), round(pt2[0], 4), label))
        else:
            x = round(pt1[0], 4)
            vert_lines.setdefault(x, []).append((round(pt1[1], 4), round(pt2[1], 4), label))

    final_segments: List[Tuple[Tuple[Tuple[float, float], Tuple[float, float]], str]] = []
    for y, segs in horiz_lines.items():
        segs.sort()
        merged = []
        for s in segs:
            if merged and abs(merged[-1][1] - s[0]) < 1e-4 and merged[-1][2] == s[2]:
                merged[-1] = (merged[-1][0], s[1], merged[-1][2])
            else:
                merged.append(s)
        for m in merged:
            final_segments.append((((m[0], y), (m[1], y)), m[2]))

    for x, segs in vert_lines.items():
        segs.sort()
        merged = []
        for s in segs:
            if merged and abs(merged[-1][1] - s[0]) < 1e-4 and merged[-1][2] == s[2]:
                merged[-1] = (merged[-1][0], s[1], merged[-1][2])
            else:
                merged.append(s)
        for m in merged:
            final_segments.append((((x, m[0]), (x, m[1])), m[2]))

    return final_segments, sprinklers


# ──────────────────────────────────────────────────────────────────
# Visualization
# ──────────────────────────────────────────────────────────────────
def visualize_sprinkler_routing(
    all_regions: List[Polygon],
    all_points: List[Tuple[float, float]],
    all_pipes: list,
    source: Tuple[float, float],
    output_path: str,
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
# DXF export for sprinklers + pipes
# ──────────────────────────────────────────────────────────────────
def write_sprinklers_to_dxf(
    base_dxf: str,
    out_dxf: str,
    sprinklers: List[Tuple[float, float]],
    pipes: list,
    sources: List[Tuple[float, float]],
    symbol_radius_world: float = 150.0,
    text_height_world: float = 150.0,
):
    """Write sprinkler symbols, sized pipe segments, and source markers into a DXF."""
    if not _EZDXF_OK:
        logger.warning("ezdxf not available, skipping DXF export")
        return

    doc = ezdxf.readfile(base_dxf)
    msp = doc.modelspace()

    for layer_name in [DXF_LAYER_SPRINKLER, DXF_LAYER_PIPES, DXF_LAYER_SOURCE]:
        if layer_name not in doc.layers:
            doc.layers.add(layer_name)

    pipe_text_height = text_height_world * 0.40

    # Pipes
    for (pt1, pt2), label in pipes:
        msp.add_lwpolyline(
            [pt1, pt2],
            dxfattribs={"layer": DXF_LAYER_PIPES, "color": 1, "const_width": 2.5},
        )
        dx = pt2[0] - pt1[0]
        dy = pt2[1] - pt1[1]
        length = math.hypot(dx, dy)
        if length < 0.6 / WORLD_TO_M:
            continue
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
    wall_buffer_m: float = 0.5,
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

    for room in rooms:
        poly = _parse_polygon(room.get("polygon_world"))
        if poly is None:
            continue
        pts, regs = _process_room(poly)
        all_points.extend(pts)
        all_regions.extend(regs)

    if not all_points:
        logger.info("place_sprinklers_from_rooms_json no sprinklers placed (no valid rooms)")
        return [], [], [], []

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
        "place_sprinklers_from_rooms_json sprinklers=%d pipes=%d source=(%.1f, %.1f)",
        len(snapped_sprinklers),
        len(pipe_segments),
        source[0],
        source[1],
    )

    if debug_png_path:
        visualize_sprinkler_routing(all_regions, snapped_sprinklers, pipe_segments, source, debug_png_path)

    return snapped_sprinklers, pipe_segments, [source], all_regions


# ──────────────────────────────────────────────────────────────────
# Sprinkler-only placement (no pipe routing)
# ──────────────────────────────────────────────────────────────────
def place_sprinklers_only(
    rooms: List[Dict],
    spacing_m: float = 3.0,
    wall_buffer_m: float = 0.5,
    world_to_m: float = 0.001,
) -> List[Tuple[float, float]]:
    """Place sprinklers for all rooms WITHOUT routing pipes.

    Returns ``sprinkler_coords``.
    """
    _set_runtime_config(spacing_m=spacing_m, wall_buffer_m=wall_buffer_m, world_to_m=world_to_m)

    all_points: List[Tuple[float, float]] = []

    for room in rooms:
        poly = _parse_polygon(room.get("polygon_world"))
        if poly is None:
            continue
        pts, _regs = _process_room(poly)
        all_points.extend(pts)

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
    wall_buffer_m: float = 0.5,
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
    for room in rooms:
        poly = _parse_polygon(room.get("polygon_world"))
        if poly is None:
            continue
        _pts, regs = _process_room(poly)
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
