import ezdxf
import math

DXF_LAYER_SMOKE = "AI_SMOKE_DETECTORS"

def write_detectors_to_dxf(base_dxf: str, out_dxf: str, detectors: list[dict],
                           symbol_radius_world: float = 150.0, text_height_world: float = 150.0):
    doc = ezdxf.readfile(base_dxf)
    msp = doc.modelspace()

    if DXF_LAYER_SMOKE not in doc.layers:
        doc.layers.add(DXF_LAYER_SMOKE)

    for d in detectors:
        x = float(d["x"]); y = float(d["y"])
        did = str(d.get("id",""))
        dtype = str(d.get("dtype","smoke"))
        msp.add_circle((x,y), symbol_radius_world, dxfattribs={"layer": DXF_LAYER_SMOKE})
        if did:
            msp.add_text(did, dxfattribs={"height": text_height_world, "layer": DXF_LAYER_SMOKE}).set_placement((x + symbol_radius_world*1.5, y + symbol_radius_world*1.5))

    doc.saveas(out_dxf)
