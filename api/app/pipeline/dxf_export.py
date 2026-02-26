import ezdxf

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
        msp.add_circle((x,y), symbol_radius_world, dxfattribs={"layer": layer})
        if did:
            msp.add_text(did, dxfattribs={"height": text_height_world, "layer": layer}).set_placement((x + symbol_radius_world*1.5, y + symbol_radius_world*1.5))

    doc.saveas(out_dxf)
