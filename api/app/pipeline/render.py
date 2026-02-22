import os
import json
import ezdxf
from ezdxf import bbox
from ezdxf.addons.drawing import RenderContext, Frontend, config as draw_config
from ezdxf.addons.drawing import layout as draw_layout_mod
from ezdxf.addons.drawing.pymupdf import PyMuPdfBackend
from ezdxf.math import BoundingBox2d

def render_dxf_to_png_and_mapping(
    dxf_path: str,
    out_png: str,
    out_json: str,
    target_long_side_px: int = 12000,
    dpi: int = 600,
    pad_frac: float = 0.01,
    background_hex: str = "#ffffff",
    alpha: bool = False,
):
    """Render DXF to PNG without letterboxing and write mapping JSON.

    Mapping:
      u = (x - xmin) / (xmax - xmin)
      v = (ymax - y) / (ymax - ymin)
      px = u * W
      py = v * H
    """
    doc = ezdxf.readfile(dxf_path)
    msp = doc.modelspace()

    # Calculate extents and pad
    cache = bbox.Cache()
    bb = bbox.extents(msp, cache=cache)
    xmin, ymin = float(bb.extmin.x), float(bb.extmin.y)
    xmax, ymax = float(bb.extmax.x), float(bb.extmax.y)

    span_x = max(1e-9, xmax - xmin)
    span_y = max(1e-9, ymax - ymin)

    xmin_p = xmin - pad_frac * span_x
    xmax_p = xmax + pad_frac * span_x
    ymin_p = ymin - pad_frac * span_y
    ymax_p = ymax + pad_frac * span_y

    padded_span_x = xmax_p - xmin_p
    padded_span_y = ymax_p - ymin_p

    # Determine pixel dimensions (no letterbox)
    if padded_span_x >= padded_span_y:
        W_px = int(target_long_side_px)
        H_px = max(1, int(round(target_long_side_px * (padded_span_y / padded_span_x))))
    else:
        H_px = int(target_long_side_px)
        W_px = max(1, int(round(target_long_side_px * (padded_span_x / padded_span_y))))

    # Setup backend
    ctx = RenderContext(doc)
    backend = PyMuPdfBackend()
    cfg = draw_config.Configuration(
        color_policy=draw_config.ColorPolicy.COLOR,
        background_policy=draw_config.BackgroundPolicy.CUSTOM,
        custom_bg_color=background_hex,
        line_policy=draw_config.LinePolicy.SOLID
    )
    frontend = Frontend(ctx, backend, config=cfg)
    frontend.draw_layout(msp, finalize=True)

    # Rasterize with explicit page size
    page_w_in = W_px / float(dpi)
    page_h_in = H_px / float(dpi)
    page = draw_layout_mod.Page(page_w_in, page_h_in, units=draw_layout_mod.Units.inch)
    settings = draw_layout_mod.Settings(fit_page=True, scale=1.0, crop_at_margins=False)
    render_box = BoundingBox2d([(xmin_p, ymin_p), (xmax_p, ymax_p)])

    png_bytes = backend.get_pixmap_bytes(
        page,
        fmt="png",
        settings=settings,
        dpi=int(dpi),
        alpha=bool(alpha),
        render_box=render_box,
    )

    os.makedirs(os.path.dirname(out_png), exist_ok=True)
    with open(out_png, "wb") as f:
        f.write(png_bytes)

    mapping = {
        "width_px": int(W_px),
        "height_px": int(H_px),
        "world_bbox": {"xmin": xmin_p, "xmax": xmax_p, "ymin": ymin_p, "ymax": ymax_p},
        "conversion": "u=(x-xmin)/(xmax-xmin); v=(ymax-y)/(ymax-ymin); px=u*W; py=v*H"
    }
    with open(out_json, "w", encoding="utf-8") as f:
        json.dump(mapping, f, indent=2)

    return mapping
