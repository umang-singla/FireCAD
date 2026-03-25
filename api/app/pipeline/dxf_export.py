import ezdxf
import math
from ezdxf.enums import TextEntityAlignment

DXF_LAYER_SMOKE = "AI_SMOKE_DETECTORS"
DXF_LAYER_PANEL = "AI_PANEL"
DXF_LAYER_HOOTER = "AI_HOOTER"
DXF_LAYER_MCB = "AI_MCB"
DXF_LAYER_LEGEND = "AI_LEGEND"
DXF_LAYER_SPRINKLER = "AI_FIRE_SPRINKLERS"
DXF_LAYER_PIPES = "AI_FIRE_PIPES"
DXF_LAYER_SOURCE = "AI_FIRE_SOURCE"

LAYER_BY_DTYPE = {
    "smoke": DXF_LAYER_SMOKE,
    "panel": DXF_LAYER_PANEL,
    "hooter": DXF_LAYER_HOOTER,
    "mcb": DXF_LAYER_MCB,
    "sprinkler": DXF_LAYER_SPRINKLER,
}

LABEL_BY_DTYPE = {
    "smoke": "Smoke Detector",
    "panel": "Panel",
    "hooter": "Hooter",
    "mcb": "MCB",
    "sprinkler": "Fire Sprinkler",
}


def _circle_polygon_vertices(x: float, y: float, radius: float, segments: int = 32):
    segments = max(12, int(segments))
    pts = []
    for i in range(segments):
        t = (2.0 * math.pi * i) / float(segments)
        pts.append((x + radius * math.cos(t), y + radius * math.sin(t)))
    return pts


def _add_filled_dot(msp, x: float, y: float, radius: float, layer: str):
    hatch = msp.add_hatch(color=1, dxfattribs={"layer": layer})
    hatch.paths.add_polyline_path(_circle_polygon_vertices(x, y, radius), is_closed=True)
    hatch.set_solid_fill(color=1, rgb=(255, 0, 0))


def _add_smoke_symbol(msp, x: float, y: float, radius: float, layer: str):
    msp.add_circle((x, y), radius=radius, dxfattribs={"layer": layer, "color": 1})
    symbol_height = radius * 0.95
    txt = msp.add_text("S", dxfattribs={"height": symbol_height, "layer": layer, "color": 1})
    txt.set_placement((x, y), align=TextEntityAlignment.MIDDLE_CENTER)


def _add_sprinkler_symbol(msp, x: float, y: float, radius: float, layer: str):
    """Sprinkler symbol: circle with a + (plus) sign inside."""
    msp.add_circle((x, y), radius=radius, dxfattribs={"layer": layer, "color": 1})
    arm = radius * 0.7
    msp.add_line((x - arm, y), (x + arm, y), dxfattribs={"layer": layer, "color": 1})
    msp.add_line((x, y - arm), (x, y + arm), dxfattribs={"layer": layer, "color": 1})


def _add_symbol_for_dtype(msp, dtype: str, x: float, y: float, radius: float):
    key = str(dtype or "smoke").strip().lower()
    layer = LAYER_BY_DTYPE.get(key, DXF_LAYER_SMOKE)
    if key == "smoke":
        _add_smoke_symbol(msp, x, y, radius, layer)
    elif key == "sprinkler":
        _add_sprinkler_symbol(msp, x, y, radius, layer)
    else:
        _add_filled_dot(msp, x, y, radius, layer)


def _legend_dtypes(detectors: list[dict]):
    order = ["smoke", "panel", "hooter", "mcb"]
    present = set()
    for d in detectors:
        dtype = str(d.get("dtype", "smoke")).strip().lower()
        if dtype in LAYER_BY_DTYPE:
            present.add(dtype)
    rows = [dtype for dtype in order if dtype in present]
    return rows or ["smoke"]


def _add_legend_table(msp, detectors: list[dict], symbol_radius_world: float, text_height_world: float):
    legend_rows = _legend_dtypes(detectors)

    xs = [float(d["x"]) for d in detectors if "x" in d]
    ys = [float(d["y"]) for d in detectors if "y" in d]
    maxx = max(xs) if xs else 0.0
    maxy = max(ys) if ys else 0.0

    title_h = max(text_height_world * 1.8, symbol_radius_world * 2.6)
    row_h = max(text_height_world * 1.6, symbol_radius_world * 2.3)
    col_symbol_w = max(symbol_radius_world * 4.5, text_height_world * 4.5)
    col_desc_w = max(symbol_radius_world * 14.0, text_height_world * 20.0)

    total_rows = 2 + len(legend_rows)
    table_w = col_symbol_w + col_desc_w
    table_h = title_h + row_h * (total_rows - 1)

    margin = symbol_radius_world * 6.0
    left = maxx + margin
    top = maxy + margin
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
    h1 = msp.add_text("Symbol", dxfattribs=text_attr)
    h1.set_placement((left + col_symbol_w * 0.5, header_y), align=TextEntityAlignment.MIDDLE_CENTER)
    h2 = msp.add_text("Description", dxfattribs=text_attr)
    h2.set_placement((split_x + text_height_world * 0.8, header_y), align=TextEntityAlignment.MIDDLE_LEFT)

    # Data rows
    symbol_r = min(symbol_radius_world * 0.85, row_h * 0.35)
    for i, dtype in enumerate(legend_rows):
        cy = top - title_h - row_h * (1.5 + i)
        cx = left + col_symbol_w * 0.5
        _add_symbol_for_dtype(msp, dtype, cx, cy, symbol_r)

        label = LABEL_BY_DTYPE.get(dtype, dtype.upper())
        row_text = msp.add_text(label, dxfattribs=text_attr)
        row_text.set_placement((split_x + text_height_world * 0.8, cy), align=TextEntityAlignment.MIDDLE_LEFT)

def write_detectors_to_dxf(base_dxf: str, out_dxf: str, detectors: list[dict],
                           symbol_radius_world: float = 150.0, text_height_world: float = 150.0):
    doc = ezdxf.readfile(base_dxf)
    msp = doc.modelspace()

    for layer_name in [*LAYER_BY_DTYPE.values(), DXF_LAYER_LEGEND, DXF_LAYER_PIPES, DXF_LAYER_SOURCE]:
        if layer_name not in doc.layers:
            doc.layers.add(layer_name)

    for d in detectors:
        x = float(d["x"]); y = float(d["y"])
        did = str(d.get("id",""))
        dtype = str(d.get("dtype","smoke")).strip().lower()
        layer = LAYER_BY_DTYPE.get(dtype, DXF_LAYER_SMOKE)
        _add_symbol_for_dtype(msp, dtype, x, y, symbol_radius_world)
        if did:
            msp.add_text(did, dxfattribs={"height": text_height_world, "layer": layer}).set_placement((x + symbol_radius_world*1.5, y + symbol_radius_world*1.5))

    _add_legend_table(
        msp,
        detectors=detectors,
        symbol_radius_world=symbol_radius_world,
        text_height_world=text_height_world,
    )

    doc.saveas(out_dxf)
