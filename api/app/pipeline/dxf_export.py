import ezdxf
import math

DXF_LAYER_SMOKE = "AI_SMOKE_DETECTORS"
DXF_LAYER_PANEL = "AI_PANEL"
DXF_LAYER_HOOTER = "AI_HOOTER"
DXF_LAYER_MCB = "AI_MCB"

LAYER_BY_DTYPE = {
    "smoke": DXF_LAYER_SMOKE,
    "panel": DXF_LAYER_PANEL,
    "hooter": DXF_LAYER_HOOTER,
    "mcb": DXF_LAYER_MCB,
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

def write_detectors_to_dxf(base_dxf: str, out_dxf: str, detectors: list[dict],
                           symbol_radius_world: float = 150.0, text_height_world: float = 150.0):
    doc = ezdxf.readfile(base_dxf)
    msp = doc.modelspace()

    for layer_name in LAYER_BY_DTYPE.values():
        if layer_name not in doc.layers:
            doc.layers.add(layer_name)

    for d in detectors:
        x = float(d["x"]); y = float(d["y"])
        did = str(d.get("id",""))
        dtype = str(d.get("dtype","smoke")).strip().lower()
        layer = LAYER_BY_DTYPE.get(dtype, DXF_LAYER_SMOKE)
        _add_filled_dot(msp, x, y, symbol_radius_world, layer)
        if did:
            msp.add_text(did, dxfattribs={"height": text_height_world, "layer": layer}).set_placement((x + symbol_radius_world*1.5, y + symbol_radius_world*1.5))

    doc.saveas(out_dxf)
