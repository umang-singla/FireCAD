import ezdxf
import math
import logging
from ezdxf import recover
from ezdxf.enums import TextEntityAlignment

logger = logging.getLogger("mepit.pipeline.dxf_export")

# Symbol radius as a fraction of the shorter side of the content bounding box.
# ~0.5 % of the bbox short side gives a visually proportional symbol.
_SYMBOL_FRAC = 0.005

DXF_LAYER_SMOKE = "AI_SMOKE_DETECTORS"
DXF_LAYER_PANEL = "AI_PANEL"
DXF_LAYER_HOOTER = "AI_HOOTER"
DXF_LAYER_MCB = "AI_MCB"
DXF_LAYER_EXTERNAL_HYDRANT = "AI_EXTERNAL_HYDRANT"
DXF_LAYER_INTERNAL_HYDRANT = "AI_INTERNAL_HYDRANT"
DXF_LAYER_LEGEND = "AI_LEGEND"
DXF_LAYER_SPRINKLER = "AI_FIRE_SPRINKLERS"
DXF_LAYER_PIPES = "AI_FIRE_PIPES"
DXF_LAYER_SOURCE = "AI_FIRE_SOURCE"
DXF_LAYER_ANNOTATIONS = "AI_ANNOTATIONS"

LAYER_BY_DTYPE = {
    "smoke": DXF_LAYER_SMOKE,
    "panel": DXF_LAYER_PANEL,
    "hooter": DXF_LAYER_HOOTER,
    "mcb": DXF_LAYER_MCB,
    "sprinkler": DXF_LAYER_SPRINKLER,
    "fire_hose": DXF_LAYER_EXTERNAL_HYDRANT,
    "internal_hydrant": DXF_LAYER_INTERNAL_HYDRANT,
}

LABEL_BY_DTYPE = {
    "smoke": "Smoke",
    "panel": "FACP",
    "facp": "FACP",
    "hooter": "Hooter",
    "mcb": "MCP",
    "mcp": "MCP",
    "sprinkler": "Sprinkler",
    "fire_hose": "External Hydrant",
    "yard_hydrant": "External Hydrant",
    "internal_hydrant": "Internal Hydrant",
    "sprinkler_pipe": "Sprinkler Pipeline",
}


def _normalize_dtype(dtype: str) -> str:
    key = str(dtype or "smoke").strip().lower()
    aliases = {
        "facp": "panel",
        "fire_alarm_control_panel": "panel",
        "mcp": "mcb",
        "yard_hydrant": "fire_hose",
        "external_hydrant": "fire_hose",
        "hydrant_external": "fire_hose",
        "hydrant_internal": "internal_hydrant",
    }
    return aliases.get(key, key)


def compute_symbol_sizes(
    world_to_m: float,
    detectors: list[dict] | None = None,
    world_bbox: dict | None = None,
) -> tuple[float, float]:
    """Return (symbol_radius_world, text_height_world) in drawing units.

    The symbol radius is derived from the bounding box of the content so
    that symbols stay visually proportional regardless of drawing scale or
    whitespace.  The bbox can come from:
      1. *world_bbox* dict  (``{xmin, ymin, xmax, ymax}``) — e.g. a floor-plan block bbox
      2. The bounding box of *detectors* themselves (fallback)

    If neither is available a fixed real-world size (150 mm) is converted
    via *world_to_m*.
    """
    short_side = None

    if world_bbox:
        w = abs(float(world_bbox.get("xmax", 0)) - float(world_bbox.get("xmin", 0)))
        h = abs(float(world_bbox.get("ymax", 0)) - float(world_bbox.get("ymin", 0)))
        if w > 0 and h > 0:
            short_side = min(w, h)

    if short_side is None and detectors:
        xs = [float(d["x"]) for d in detectors if "x" in d]
        ys = [float(d["y"]) for d in detectors if "y" in d]
        if len(xs) >= 2 and len(ys) >= 2:
            w = max(xs) - min(xs)
            h = max(ys) - min(ys)
            if w > 0 and h > 0:
                short_side = min(w, h)

    if short_side is not None and short_side > 0:
        radius = short_side * _SYMBOL_FRAC
    else:
        # absolute fallback: 150 mm physical → drawing units
        radius = 0.15 / world_to_m

    text_h = radius * 0.67
    logger.info(
        "compute_symbol_sizes: short_side=%s  radius=%g  text_h=%g  world_to_m=%g",
        short_side, radius, text_h, world_to_m,
    )
    return radius, text_h


def _circle_polygon_vertices(x: float, y: float, radius: float, segments: int = 32):
    segments = max(12, int(segments))
    pts = []
    for i in range(segments):
        t = (2.0 * math.pi * i) / float(segments)
        pts.append((x + radius * math.cos(t), y + radius * math.sin(t)))
    return pts


def _add_centered_text(msp, text: str, x: float, y: float, height: float, layer: str, color: int = 1):
    """Add TEXT centered at (x, y) using the DXF standard text style."""
    txt = msp.add_text(
        text,
        dxfattribs={
            "height": height,
            "layer": layer,
        },
    )
    # Small visual compensation for CAD fonts so glyph appears centered in symbols.
    txt.set_placement((x - 0.5*height, y - 0.5*height))
    return txt


def _add_filled_dot(msp, x: float, y: float, radius: float, layer: str):
    hatch = msp.add_hatch(color=1, dxfattribs={"layer": layer})
    hatch.paths.add_polyline_path(_circle_polygon_vertices(x, y, radius), is_closed=True)
    hatch.set_solid_fill(color=1, rgb=(255, 0, 0))


def _octagon_vertices(x: float, y: float, radius: float):
    """Return 8 vertices of a regular octagon centred at (x, y)."""
    return [
        (x + radius * math.cos(math.pi / 8 + 2.0 * math.pi * i / 8.0),
         y + radius * math.sin(math.pi / 8 + 2.0 * math.pi * i / 8.0))
        for i in range(8)
    ]


def _add_smoke_symbol(msp, x: float, y: float, radius: float, layer: str):
    """UI-style smoke symbol: circle with centered 'S'."""
    msp.add_circle((x, y), radius=radius, dxfattribs={"layer": layer, "color": 1})
    # Keep text inside circle using the same rule from your reference snippet.
    symbol_height = radius * 1.2
    _add_centered_text(msp, "S", x, y, symbol_height, layer, color=1)


def _add_sprinkler_symbol(msp, x: float, y: float, radius: float, layer: str):
    """Sprinkler symbol: circle with a + (plus) sign inside."""
    msp.add_circle((x, y), radius=radius, dxfattribs={"layer": layer, "color": 1})
    arm = radius * 0.7
    msp.add_line((x - arm, y), (x + arm, y), dxfattribs={"layer": layer, "color": 1})
    msp.add_line((x, y - arm), (x, y + arm), dxfattribs={"layer": layer, "color": 1})


def _add_panel_symbol(msp, x: float, y: float, radius: float, layer: str):
    """UI-style FACP symbol: rectangular box with FACP text."""
    # Wider/taller box and reduced text size to guarantee text stays inside.
    w = radius * 4.8
    h = radius * 2.4
    x0, y0 = x - w * 0.5, y - h * 0.5
    x1, y1 = x + w * 0.5, y + h * 0.5
    msp.add_lwpolyline(
        [(x0, y0), (x1, y0), (x1, y1), (x0, y1)],
        close=True,
        dxfattribs={"layer": layer, "color": 3},
    )
    _add_centered_text(msp, "FACP", x, y, radius * 0.52, layer, color=3)


def _add_mcp_symbol(msp, x: float, y: float, radius: float, layer: str):
    """UI-style MCP symbol: square with center dot."""
    half = radius
    msp.add_lwpolyline(
        [(x - half, y - half), (x + half, y - half), (x + half, y + half), (x - half, y + half)],
        close=True,
        dxfattribs={"layer": layer, "color": 3},
    )
    msp.add_circle((x, y), radius=radius * 0.39, dxfattribs={"layer": layer, "color": 5})


def _add_hooter_symbol(msp, x: float, y: float, radius: float, layer: str):
    """UI-style hooter symbol: base + dome + rays."""
    # Base tiers
    b1_w, b1_h = radius * 2.2, radius * 0.45
    b2_w, b2_h = radius * 1.8, radius * 0.45
    b1_y = y + radius * 0.55
    b2_y = y + radius * 0.2
    for w, h, cy in ((b1_w, b1_h, b1_y), (b2_w, b2_h, b2_y)):
        x0, y0 = x - w * 0.5, cy - h * 0.5
        x1, y1 = x + w * 0.5, cy + h * 0.5
        msp.add_lwpolyline(
            [(x0, y0), (x1, y0), (x1, y1), (x0, y1)],
            close=True,
            dxfattribs={"layer": layer, "color": 1},
        )

    # Dome (polyline approximation of two quadratic arcs)
    dome_left = (x - radius * 0.65, y + radius * 0.2)
    dome_top = (x, y - radius * 0.9)
    dome_right = (x + radius * 0.65, y + radius * 0.2)
    dome_pts = [
        dome_left,
        (x - radius * 0.65, y - radius * 0.6),
        (x - radius * 0.35, y - radius * 0.82),
        dome_top,
        (x + radius * 0.35, y - radius * 0.82),
        (x + radius * 0.65, y - radius * 0.6),
        dome_right,
    ]
    msp.add_lwpolyline(dome_pts, close=True, dxfattribs={"layer": layer, "color": 1})

    # Rays
    rays = [
        (0.0, -1.15, 0.0, -1.55),
        (-0.55, -1.0, -0.8, -1.35),
        (0.55, -1.0, 0.8, -1.35),
        (-0.9, -0.55, -1.2, -0.8),
        (0.9, -0.55, 1.2, -0.8),
    ]
    for x1f, y1f, x2f, y2f in rays:
        msp.add_line(
            (x + x1f * radius, y + y1f * radius),
            (x + x2f * radius, y + y2f * radius),
            dxfattribs={"layer": layer, "color": 7},
        )


def _add_external_hydrant_symbol(msp, x: float, y: float, radius: float, layer: str):
    """External hydrant symbol (editor-style linework, no fallback dot)."""
    s = max(radius / 6.2, 1e-6)
    attr = {"layer": layer, "color": 1}

    # Left valve block
    x0, y0 = x - 16.0 * s, y - 3.4 * s
    x1, y1 = x - 7.0 * s, y + 3.4 * s
    msp.add_lwpolyline([(x0, y0), (x1, y0), (x1, y1), (x0, y1)], close=True, dxfattribs=attr)

    # Vertical stem
    sx0, sy0 = x - 9.5 * s, y - 8.4 * s
    sx1, sy1 = x - 4.7 * s, y + 8.4 * s
    msp.add_lwpolyline([(sx0, sy0), (sx1, sy0), (sx1, sy1), (sx0, sy1)], close=True, dxfattribs=attr)

    # Main circular body
    msp.add_circle((x - 1.8 * s, y), radius=6.2 * s, dxfattribs=attr)

    # Hose curve (polyline approximation)
    msp.add_lwpolyline(
        [
            (x - 8.0 * s, y),
            (x - 4.6 * s, y - 2.8 * s),
            (x + 1.6 * s, y + 2.8 * s),
            (x + 6.8 * s, y),
        ],
        dxfattribs=attr,
    )

    # Right horn curve + tail
    msp.add_lwpolyline(
        [
            (x + 7.6 * s, y - 4.8 * s),
            (x + 9.4 * s, y),
            (x + 7.6 * s, y + 4.8 * s),
        ],
        dxfattribs=attr,
    )
    msp.add_line((x + 9.6 * s, y - 4.2 * s), (x + 9.6 * s, y + 4.2 * s), dxfattribs=attr)


def _add_internal_hydrant_symbol(msp, x: float, y: float, radius: float, layer: str):
    """Internal hydrant symbol (editor-style box + diagonal fill + hatch line)."""
    s = max(radius / 6.2, 1e-6)
    attr = {"layer": layer, "color": 6}

    # Outer box
    msp.add_lwpolyline(
        [
            (x - 14.0 * s, y - 9.0 * s),
            (x + 14.0 * s, y - 9.0 * s),
            (x + 14.0 * s, y + 9.0 * s),
            (x - 14.0 * s, y + 9.0 * s),
        ],
        close=True,
        dxfattribs=attr,
    )

    # Filled triangular body
    hatch = msp.add_hatch(color=6, dxfattribs={"layer": layer})
    hatch.paths.add_polyline_path(
        [
            (x - 13.2 * s, y + 8.2 * s),
            (x - 13.2 * s, y - 7.8 * s),
            (x + 9.8 * s, y + 8.2 * s),
        ],
        is_closed=True,
    )
    hatch.set_solid_fill(color=6)

    # Internal polyline detail
    msp.add_lwpolyline(
        [
            (x - 7.8 * s, y - 4.2 * s),
            (x - 3.9 * s, y - 1.8 * s),
            (x + 0.1 * s, y + 0.6 * s),
            (x + 4.1 * s, y + 3.0 * s),
            (x + 8.1 * s, y + 5.4 * s),
        ],
        dxfattribs={"layer": layer, "color": 5},
    )


def _add_symbol_for_dtype(msp, dtype: str, x: float, y: float, radius: float):
    key = _normalize_dtype(dtype)
    layer = LAYER_BY_DTYPE.get(key, DXF_LAYER_SMOKE)
    if key == "smoke":
        _add_smoke_symbol(msp, x, y, radius, layer)
    elif key == "sprinkler":
        _add_sprinkler_symbol(msp, x, y, radius, layer)
    elif key == "panel":
        _add_panel_symbol(msp, x, y, radius, layer)
    elif key == "mcb":
        _add_mcp_symbol(msp, x, y, radius, layer)
    elif key == "hooter":
        _add_hooter_symbol(msp, x, y, radius, layer)
    elif key == "fire_hose":
        _add_external_hydrant_symbol(msp, x, y, radius, layer)
    elif key == "internal_hydrant":
        _add_internal_hydrant_symbol(msp, x, y, radius, layer)
    else:
        _add_filled_dot(msp, x, y, radius, layer)


def _add_cloud_outline(msp, xmin: float, ymin: float, xmax: float, ymax: float, layer: str, color: int = 4):
    w = max(1e-6, xmax - xmin)
    h = max(1e-6, ymax - ymin)
    short_side = max(1e-6, min(w, h))
    bump = max(short_side * 0.12, short_side * 0.06)

    nx = max(4, int(round(w / max(1e-6, bump * 1.8))))
    ny = max(4, int(round(h / max(1e-6, bump * 1.8))))

    # Use denser point sampling to make cloud curls clearly visible in CAD viewers.
    pts: list[tuple[float, float]] = []

    # Top edge (outward +Y)
    for i in range(nx):
        x0 = xmin + (i / nx) * w
        x1 = xmin + ((i + 1) / nx) * w
        steps = 6
        for j in range(steps):
            t = j / steps
            x = x0 + (x1 - x0) * t
            y = ymax + bump * math.sin(math.pi * t)
            pts.append((x, y))
    pts.append((xmax, ymax))

    # Right edge (outward +X)
    for i in range(ny):
        y0 = ymax - (i / ny) * h
        y1 = ymax - ((i + 1) / ny) * h
        steps = 6
        for j in range(steps):
            t = j / steps
            y = y0 + (y1 - y0) * t
            x = xmax + bump * math.sin(math.pi * t)
            pts.append((x, y))
    pts.append((xmax, ymin))

    # Bottom edge (outward -Y)
    for i in range(nx):
        x0 = xmax - (i / nx) * w
        x1 = xmax - ((i + 1) / nx) * w
        steps = 6
        for j in range(steps):
            t = j / steps
            x = x0 + (x1 - x0) * t
            y = ymin - bump * math.sin(math.pi * t)
            pts.append((x, y))
    pts.append((xmin, ymin))

    # Left edge (outward -X)
    for i in range(ny):
        y0 = ymin + (i / ny) * h
        y1 = ymin + ((i + 1) / ny) * h
        steps = 6
        for j in range(steps):
            t = j / steps
            y = y0 + (y1 - y0) * t
            x = xmin - bump * math.sin(math.pi * t)
            pts.append((x, y))

    if len(pts) >= 3:
        msp.add_lwpolyline(pts, close=True, dxfattribs={"layer": layer, "color": color})


def _add_annotations_to_dxf(msp, annotations: list[dict], layer: str = DXF_LAYER_ANNOTATIONS):
    for a in annotations or []:
        try:
            kind = str(a.get("kind", "rect")).lower()
            xmin = float(a["xmin"])
            ymin = float(a["ymin"])
            xmax = float(a["xmax"])
            ymax = float(a["ymax"])
            if xmax <= xmin or ymax <= ymin:
                continue

            if kind == "circle":
                cx = (xmin + xmax) * 0.5
                cy = (ymin + ymax) * 0.5
                rx = (xmax - xmin) * 0.5
                ry = (ymax - ymin) * 0.5
                msp.add_ellipse((cx, cy), major_axis=(rx, 0.0), ratio=max(1e-6, ry / max(rx, 1e-6)), dxfattribs={"layer": layer, "color": 5})
            elif kind == "cloud":
                _add_cloud_outline(msp, xmin, ymin, xmax, ymax, layer=layer, color=4)
            elif kind == "text":
                text = str(a.get("text") or "Text")
                h = max(0.01, float(a.get("text_height") or ((ymax - ymin) * 0.8)))
                x = float(a.get("text_x", xmin))
                y = float(a.get("text_y", (ymin + ymax) * 0.5))
                txt = msp.add_text(text, dxfattribs={"layer": layer, "color": 7, "height": h})
                txt.set_placement((x, y), align=TextEntityAlignment.LEFT)
            else:
                msp.add_lwpolyline(
                    [(xmin, ymin), (xmax, ymin), (xmax, ymax), (xmin, ymax)],
                    close=True,
                    dxfattribs={"layer": layer, "color": 3},
                )
        except Exception:
            continue


# Per-diameter colours (RGB) — mirrors PIPE_DIAMETER_COLORS_RGB in sprinkler_routing.
_PIPE_DIAMETER_COLORS_RGB: dict[int, tuple[int, int, int]] = {
    20:  (139, 92, 246),
    25:  (220, 38, 38),
    32:  (217, 119, 6),
    40:  (22, 163, 74),
    50:  (37, 99, 235),
    65:  (147, 51, 234),
    80:  (234, 88, 12),
    100: (8, 145, 178),
    125: (219, 39, 119),
    150: (120, 113, 108),
    200: (100, 116, 139),
}


def _color_for_pipe_diam(d_mm: int) -> tuple[int, int, int]:
    for t in sorted(_PIPE_DIAMETER_COLORS_RGB):
        if d_mm <= t:
            return _PIPE_DIAMETER_COLORS_RGB[t]
    return _PIPE_DIAMETER_COLORS_RGB[200]


def _legend_dtypes(detectors: list[dict]):
    # Keep mandatory fire-system rows visible even if no explicit detector of that type exists.
    order = ["smoke", "sprinkler", "sprinkler_pipe", "panel", "mcb", "hooter", "fire_hose", "internal_hydrant"]
    present = set()
    for d in detectors:
        dtype = _normalize_dtype(d.get("dtype", "smoke"))
        if dtype in LAYER_BY_DTYPE:
            present.add(dtype)

    required = {"sprinkler_pipe", "panel", "mcb", "hooter"}
    present |= required

    rows = [dtype for dtype in order if dtype in present]
    return rows or ["smoke", "sprinkler_pipe", "panel", "mcb", "hooter"]


def _add_legend_symbol(msp, dtype: str, cx: float, cy: float, symbol_r: float):
    if dtype == "sprinkler_pipe":
        msp.add_line(
            (cx - symbol_r * 1.2, cy),
            (cx + symbol_r * 1.2, cy),
            dxfattribs={"layer": DXF_LAYER_LEGEND, "color": 1},
        )
        return
    _add_symbol_for_dtype(msp, dtype, cx, cy, symbol_r)


def _add_legend_table(
    msp,
    detectors: list[dict],
    symbol_radius_world: float,
    text_height_world: float,
    world_bbox: dict | None = None,
    pipe_diameters: list[int] | None = None,
):
    legend_rows = _legend_dtypes(detectors)
    pipe_diam_rows: list[int] = sorted(set(pipe_diameters)) if pipe_diameters else []

    xs = [float(d["x"]) for d in detectors if "x" in d]
    ys = [float(d["y"]) for d in detectors if "y" in d]
    maxx = max(xs) if xs else 0.0
    maxy = max(ys) if ys else 0.0

    if world_bbox:
        try:
            bbox_xmin = float(world_bbox.get("xmin"))
            bbox_ymin = float(world_bbox.get("ymin"))
            bbox_xmax = float(world_bbox.get("xmax"))
            bbox_ymax = float(world_bbox.get("ymax"))
            maxx = max(maxx, bbox_xmax)
            maxy = max(maxy, bbox_ymax)
        except Exception:
            bbox_xmin = bbox_ymin = bbox_xmax = bbox_ymax = None
    else:
        bbox_xmin = bbox_ymin = bbox_xmax = bbox_ymax = None

    title_h = max(text_height_world * 1.8, symbol_radius_world * 2.6)
    row_h = max(text_height_world * 1.6, symbol_radius_world * 2.3)
    col_symbol_w = max(symbol_radius_world * 5.0, text_height_world * 6.5)
    col_desc_w = max(symbol_radius_world * 14.0, text_height_world * 20.0)

    total_rows = 2 + len(legend_rows) + len(pipe_diam_rows)
    table_w = col_symbol_w + col_desc_w
    table_h = title_h + row_h * (total_rows - 1)

    if bbox_xmin is not None and bbox_xmax is not None and bbox_ymin is not None and bbox_ymax is not None:
        ref_xmin, ref_ymin, ref_xmax, ref_ymax = bbox_xmin, bbox_ymin, bbox_xmax, bbox_ymax
    else:
        xs2 = [float(d["x"]) for d in detectors if "x" in d]
        ys2 = [float(d["y"]) for d in detectors if "y" in d]
        if xs2 and ys2:
            ref_xmin, ref_ymin, ref_xmax, ref_ymax = min(xs2), min(ys2), max(xs2), max(ys2)
        else:
            ref_xmin = ref_ymin = 0.0
            ref_xmax = ref_ymax = maxx

    ref_w = max(1e-9, ref_xmax - ref_xmin)
    ref_h = max(1e-9, ref_ymax - ref_ymin)

    # Keep legend visible by anchoring it near top-right of content, outside the bbox.
    side_gap = max(symbol_radius_world * 4.0, table_w * 0.15, ref_w * 0.04)
    top_gap = max(symbol_radius_world * 3.5, table_h * 0.35, ref_h * 0.06)
    left = ref_xmax + side_gap
    top = ref_ymax + top_gap

    # If right side is too cramped, place on the left side while staying near content.
    if world_bbox and (left + table_w - ref_xmax) > ref_w * 0.9:
        left = ref_xmin - side_gap - table_w
        top = ref_ymax + top_gap
    right = left + table_w
    bottom = top - table_h
    split_x = left + col_symbol_w

    line_attr = {"layer": DXF_LAYER_LEGEND, "color": 7}
    text_attr = {"layer": DXF_LAYER_LEGEND, "color": 7, "height": text_height_world}

    # Outer border
    msp.add_line((left, top), (right, top), dxfattribs=line_attr)
    msp.add_line((right, top), (right, bottom), dxfattribs=line_attr)
    msp.add_line((right, bottom), (left, bottom), dxfattribs=line_attr)
    msp.add_line((left, bottom), (left, top), dxfattribs=line_attr)

    # Horizontal separators
    y = top - title_h
    msp.add_line((left, y), (right, y), dxfattribs=line_attr)
    for _ in range(total_rows - 2):
        y -= row_h
        msp.add_line((left, y), (right, y), dxfattribs=line_attr)

    # Vertical separator (exclude title row)
    msp.add_line((split_x, top - title_h), (split_x, bottom), dxfattribs=line_attr)

    # Title
    title = msp.add_text("LEGEND", dxfattribs={**text_attr, "height": text_height_world * 1.25})
    title.set_placement(((left + right) * 0.5, top - title_h * 0.5), align=TextEntityAlignment.MIDDLE_CENTER)

    # Header row
    header_y = top - title_h - row_h * 0.5
    h1 = msp.add_text("Sym", dxfattribs=text_attr)
    h1.set_placement((left + col_symbol_w * 0.5, header_y), align=TextEntityAlignment.MIDDLE_CENTER)
    h2 = msp.add_text("Description", dxfattribs=text_attr)
    h2.set_placement((split_x + text_height_world * 1.8, header_y), align=TextEntityAlignment.MIDDLE_LEFT)

    # Data rows — device types
    symbol_r = min(symbol_radius_world * 0.85, row_h * 0.35)
    for i, dtype in enumerate(legend_rows):
        cy = top - title_h - row_h * (1.5 + i)
        cx = left + col_symbol_w * 0.5
        _add_legend_symbol(msp, dtype, cx, cy, symbol_r)

        label = LABEL_BY_DTYPE.get(dtype, dtype.upper())
        row_text = msp.add_text(label, dxfattribs=text_attr)
        row_text.set_placement((split_x + text_height_world * 0.8, cy), align=TextEntityAlignment.MIDDLE_LEFT)

    # Data rows — pipe diameters (coloured horizontal line symbol)
    base_i = len(legend_rows)
    for j, d_mm in enumerate(pipe_diam_rows):
        cy = top - title_h - row_h * (1.5 + base_i + j)
        cx = left + col_symbol_w * 0.5
        r, g, b = _color_for_pipe_diam(d_mm)
        tc = (r << 16) | (g << 8) | b
        seg_half = symbol_r * 1.2
        seg = msp.add_line(
            (cx - seg_half, cy),
            (cx + seg_half, cy),
            dxfattribs={"layer": DXF_LAYER_LEGEND, "lineweight": 50},
        )
        seg.dxf.true_color = tc
        diam_label = f"\u00d8{d_mm}mm Pipe"
        row_text = msp.add_text(diam_label, dxfattribs=text_attr)
        row_text.set_placement((split_x + text_height_world * 0.8, cy), align=TextEntityAlignment.MIDDLE_LEFT)

def _populate_doc_with_overlays(
    doc,
    detectors: list[dict],
    annotations: list[dict] | None,
    world_to_m: float,
    world_bbox: dict | None,
    symbol_radius_world: float,
    text_height_world: float,
    pipe_diameters: list[int] | None,
) -> None:
    """Write all detector symbols, annotations and legend into an already-open ezdxf document.
    Does NOT save to disk — caller is responsible for doc.saveas().
    """
    msp = doc.modelspace()

    for layer_name in [*LAYER_BY_DTYPE.values(), DXF_LAYER_LEGEND, DXF_LAYER_PIPES, DXF_LAYER_SOURCE, DXF_LAYER_ANNOTATIONS]:
        if layer_name not in doc.layers:
            doc.layers.add(layer_name)

    for d in detectors:
        x = float(d["x"]); y = float(d["y"])
        dtype = _normalize_dtype(d.get("dtype", "smoke"))
        _add_symbol_for_dtype(msp, dtype, x, y, symbol_radius_world)

    _add_annotations_to_dxf(msp, annotations or [])

    _add_legend_table(
        msp,
        detectors=detectors,
        symbol_radius_world=symbol_radius_world,
        text_height_world=text_height_world,
        world_bbox=world_bbox,
        pipe_diameters=pipe_diameters,
    )


def write_detectors_to_dxf(
    base_dxf: str,
    out_dxf: str,
    detectors: list[dict],
    annotations: list[dict] | None = None,
    world_to_m: float = 0.001,
    world_bbox: dict | None = None,
    symbol_radius_world: float | None = None,
    text_height_world: float | None = None,
    pipe_diameters: list[int] | None = None,
):
    """Load *base_dxf*, add detector overlays in-memory, save to *out_dxf* (single read + write)."""
    doc = ezdxf.readfile(base_dxf)

    if symbol_radius_world is None or text_height_world is None:
        auto_r, auto_t = compute_symbol_sizes(world_to_m, detectors, world_bbox)
        if symbol_radius_world is None:
            symbol_radius_world = auto_r
        if text_height_world is None:
            text_height_world = auto_t

    _populate_doc_with_overlays(
        doc, detectors, annotations, world_to_m, world_bbox,
        symbol_radius_world, text_height_world, pipe_diameters,
    )
    doc.saveas(out_dxf)


# ──────────────────────────────────────────────────────────────────
# Combined multi-sheet DXF export (viewport + layer-freeze approach)
# ──────────────────────────────────────────────────────────────────

# Fire-alarm device types (everything except sprinkler)
_FIRE_ALARM_DTYPES = {"smoke", "panel", "mcb", "hooter"}

# Layout/sheet names
_LAYOUT_ORIGINAL = "01_ORIGINAL_PLAN"
_LAYOUT_FIRE = "02_FIRE_ALARM_PLAN"
_LAYOUT_SPRINKLER = "03_SPRINKLER_PLAN"

# Sheet dimensions (A1 landscape, mm)
_PAGE_W = 841.0
_PAGE_H = 594.0
_OUTER_MARGIN = 12.0
_INNER_MARGIN = 24.0

_LAYER_BORDER = "SHEET_BORDER"
_LAYER_TITLE = "SHEET_TITLE"

# Layers grouped by system
_FIRE_LAYERS = [
    DXF_LAYER_SMOKE,
    DXF_LAYER_PANEL,
    DXF_LAYER_HOOTER,
    DXF_LAYER_MCB,
    DXF_LAYER_EXTERNAL_HYDRANT,
    DXF_LAYER_INTERNAL_HYDRANT,
]
_SPRINKLER_LAYERS = [DXF_LAYER_SPRINKLER, DXF_LAYER_PIPES, DXF_LAYER_SOURCE]
_ALL_AI_LAYERS = _FIRE_LAYERS + _SPRINKLER_LAYERS + [DXF_LAYER_LEGEND, DXF_LAYER_ANNOTATIONS]


def _read_dxf_safe(path: str):
    try:
        return ezdxf.readfile(path)
    except Exception:
        doc, _ = recover.readfile(path)
        return doc


def _modelspace_extents(doc):
    """Return (min_x, min_y, max_x, max_y) from modelspace or header."""
    from ezdxf import bbox as _bbox

    msp = doc.modelspace()
    try:
        ext = _bbox.extents(msp)
        if ext is not None and ext.has_data:
            return (float(ext.extmin.x), float(ext.extmin.y),
                    float(ext.extmax.x), float(ext.extmax.y))
    except Exception:
        pass
    try:
        mn = doc.header.get("$EXTMIN", (0, 0, 0))
        mx = doc.header.get("$EXTMAX", (1, 1, 0))
        if float(mx[0]) > float(mn[0]) and float(mx[1]) > float(mn[1]):
            return (float(mn[0]), float(mn[1]), float(mx[0]), float(mx[1]))
    except Exception:
        pass
    raise RuntimeError("Cannot determine modelspace extents")


def _add_sheet_frame(psp, title: str, subtitle: str):
    """Draw outer/inner borders and title text on a paperspace layout."""
    W, H = _PAGE_W, _PAGE_H
    OM, IM = _OUTER_MARGIN, _INNER_MARGIN
    attr = {"layer": _LAYER_BORDER}

    psp.add_lwpolyline(
        [(OM, OM), (W - OM, OM), (W - OM, H - OM), (OM, H - OM), (OM, OM)],
        dxfattribs=attr,
    )
    psp.add_lwpolyline(
        [(IM, IM), (W - IM, IM), (W - IM, H - IM), (IM, H - IM), (IM, IM)],
        dxfattribs=attr,
    )

    title_x, title_y = IM, H - 20.0
    try:
        psp.add_text(title, dxfattribs={"layer": _LAYER_TITLE, "height": 8.0}).set_placement(
            (title_x, title_y)
        )
    except Exception:
        psp.add_text(title, dxfattribs={"layer": _LAYER_TITLE, "height": 8.0, "insert": (title_x, title_y)})
    try:
        psp.add_text(subtitle, dxfattribs={"layer": _LAYER_TITLE, "height": 4.0}).set_placement(
            (title_x, title_y - 8.0)
        )
    except Exception:
        psp.add_text(subtitle, dxfattribs={"layer": _LAYER_TITLE, "height": 4.0, "insert": (title_x, title_y - 8.0)})


def _add_viewport_with_frozen_layers(psp, doc, extents, freeze_layer_names):
    """Add a viewport centered in the drawable area, freezing specified layers."""
    min_x, min_y, max_x, max_y = extents
    view_cx = (min_x + max_x) / 2.0
    view_cy = (min_y + max_y) / 2.0
    view_w = max(max_x - min_x, 1.0)
    view_h = max(max_y - min_y, 1.0)

    # Drawable area on the paper (inside inner border)
    draw_x0 = _INNER_MARGIN
    draw_y0 = 28.0
    draw_x1 = _PAGE_W - _INNER_MARGIN
    draw_y1 = _PAGE_H - 46.0
    draw_w = draw_x1 - draw_x0
    draw_h = draw_y1 - draw_y0

    # Viewport center on paper
    vp_cx = (draw_x0 + draw_x1) / 2.0
    vp_cy = (draw_y0 + draw_y1) / 2.0

    # Scale view_height so drawing fits the viewport with a small margin.
    # The viewport's aspect ratio determines what view_width is used.
    paper_aspect = draw_w / draw_h
    model_aspect = view_w / view_h
    if model_aspect > paper_aspect:
        # Drawing is wider than viewport → height must be increased
        effective_view_h = view_w / paper_aspect
    else:
        effective_view_h = view_h
    effective_view_h *= 1.04  # small padding

    vp = psp.add_viewport(
        center=(vp_cx, vp_cy),
        size=(draw_w, draw_h),
        view_center_point=(view_cx, view_cy),
        view_height=effective_view_h,
        status=1,  # 1 = on / active
    )

    for layer_name in freeze_layer_names:
        if layer_name in doc.layers:
            vp.freeze(layer_name)

    return vp


def write_combined_sheets_dxf(
    base_dxf: str,
    out_combined_dxf: str,
    detectors: list[dict],
    annotations: list[dict] | None = None,
    sprinkler_pipes: list | None = None,
    sprinkler_sources: list | None = None,
    world_to_m: float = 0.001,
    world_bbox: dict | None = None,
):
    """Create a combined DXF with 3 layout sheets using viewports.

    Everything lives in Model (floor plan + all overlays).
    Each layout tab is a viewport into Model with per-viewport layer
    freezes so only the relevant system is visible:

      - Model              – floor plan + fire alarm + sprinkler (all visible)
      - 01_ORIGINAL_PLAN   – viewport: all AI layers frozen (clean plan)
      - 02_FIRE_ALARM_PLAN – viewport: sprinkler layers frozen
      - 03_SPRINKLER_PLAN  – viewport: fire alarm layers frozen

    Changes to Model are automatically reflected in all layout viewports.
    """
    import os

    sprinkler_pipes = sprinkler_pipes or []
    sprinkler_sources = sprinkler_sources or []

    def _next_layout_name(doc_obj, base_name: str) -> str:
        existing = set(doc_obj.layout_names())
        if base_name not in existing:
            return base_name
        i = 2
        while True:
            candidate = f"{base_name}_{i}"
            if candidate not in existing:
                return candidate
            i += 1

    # ── Load DXF once and add all overlays in-memory ──
    doc = _read_dxf_safe(base_dxf)

    # Compute symbol sizes up front (shared by detector + sprinkler overlays).
    sym_r, txt_h = compute_symbol_sizes(world_to_m, detectors, world_bbox)

    # Collect unique pipe diameters for the legend.
    def _diam_mm_int(label: str) -> int:
        s = str(label or "").strip().lower().replace(" ", "").replace("mm", "")
        try:
            return max(1, int(float(s)))
        except Exception:
            return 25
    _pipe_diams: list[int] = sorted(set(_diam_mm_int(lbl) for _, lbl in sprinkler_pipes)) if sprinkler_pipes else []

    # Add detector symbols, annotations and legend.
    _populate_doc_with_overlays(
        doc, detectors, annotations, world_to_m, world_bbox,
        sym_r, txt_h, _pipe_diams or None,
    )

    # Add sprinkler pipes + sources (in-memory, no extra file I/O).
    sprinkler_dets = [d for d in detectors
                      if _normalize_dtype(d.get("dtype", "smoke")) == "sprinkler"]
    if sprinkler_dets or sprinkler_pipes:
        from app.pipeline.sprinkler_routing import _add_sprinklers_to_doc
        _add_sprinklers_to_doc(
            doc,
            [(float(d["x"]), float(d["y"])) for d in sprinkler_dets],
            sprinkler_pipes, sprinkler_sources,
            world_to_m=world_to_m, world_bbox=world_bbox,
            symbol_radius_world=sym_r, text_height_world=txt_h,
        )

    extents = _modelspace_extents(doc)

    # Ensure border/title layers
    for lyr in [_LAYER_BORDER, _LAYER_TITLE]:
        if lyr not in doc.layers:
            doc.layers.new(lyr, dxfattribs={"color": 7})

    # Create 3 layout tabs (Layout1 stays as-is). If a name already exists,
    # suffix with _2, _3, ... instead of failing the export.
    layout_original_name = _next_layout_name(doc, _LAYOUT_ORIGINAL)
    psp_original = doc.layouts.new(layout_original_name)
    layout_fire_name = _next_layout_name(doc, _LAYOUT_FIRE)
    psp_fire = doc.layouts.new(layout_fire_name)
    layout_sprinkler_name = _next_layout_name(doc, _LAYOUT_SPRINKLER)
    psp_sprinkler = doc.layouts.new(layout_sprinkler_name)

    # Page setup
    for psp in [psp_original, psp_fire, psp_sprinkler]:
        try:
            psp.page_setup(
                size=(_PAGE_W, _PAGE_H), margins=(0, 0, 0, 0), units="mm",
            )
        except Exception:
            pass

    # ── Populate each sheet ──
    sheets = [
        (psp_original, "ORIGINAL FLOOR PLAN",
         os.path.basename(base_dxf), _ALL_AI_LAYERS),
        (psp_fire, "FIRE ALARM PLAN",
         "Smoke Detectors, MCP, Hooter, FACP", _SPRINKLER_LAYERS),
        (psp_sprinkler, "SPRINKLER PLAN",
         "Sprinklers, Pipes & Sources", _FIRE_LAYERS),
    ]

    for psp, title, subtitle, freeze_layers in sheets:
        _add_sheet_frame(psp, title, subtitle)
        _add_viewport_with_frozen_layers(psp, doc, extents, freeze_layers)

    # Make first layout active on open
    try:
        doc.layouts.set_active_layout(layout_original_name)
    except Exception:
        pass
    try:
        doc.header["$CTAB"] = layout_original_name
        doc.header["$TILEMODE"] = 0
    except Exception:
        pass

    doc.saveas(out_combined_dxf)

    logger.info(
        "write_combined_sheets_dxf saved=%s layouts=%s extents=%s",
        out_combined_dxf, doc.layout_names(), extents,
    )
