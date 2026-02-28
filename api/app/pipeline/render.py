import os
import json
import math
import logging
import subprocess
from contextlib import contextmanager
import ezdxf
from ezdxf import bbox
from ezdxf.addons.drawing import RenderContext, Frontend, config as draw_config
from ezdxf.addons.drawing import layout as draw_layout_mod
from ezdxf.addons.drawing.pymupdf import PyMuPdfBackend
from ezdxf.math import BoundingBox2d
from PIL import Image

logger = logging.getLogger("firecad.pipeline.render")


def _padded_bbox_from_msp(msp, pad_frac: float):
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
    return xmin_p, ymin_p, xmax_p, ymax_p


def _padded_bbox_from_dxf(dxf_path: str, pad_frac: float):
    doc = ezdxf.readfile(dxf_path)
    msp = doc.modelspace()
    return _padded_bbox_from_msp(msp, pad_frac)


def render_dwg_to_png_with_qcad(
    dwg_path: str,
    out_png: str,
    target_long_side_px: int | None = None,
    background: str = "white",
):
    exe = os.getenv("QCAD_DWG2BMP", "/opt/qcad/dwg2bmp")
    if not os.path.exists(exe):
        raise RuntimeError(f"QCAD dwg2bmp not found: {exe}")
    qcad_dir = os.path.dirname(os.path.abspath(exe))

    os.makedirs(os.path.dirname(out_png), exist_ok=True)
    width_px = os.getenv("QCAD_WIDTH_PX", "").strip()
    height_px = os.getenv("QCAD_HEIGHT_PX", "").strip()
    fallback_width = os.getenv("QCAD_DEFAULT_WIDTH_PX", "24000").strip()
    fallback_height = os.getenv("QCAD_DEFAULT_HEIGHT_PX", "16000").strip()
    high_quality = os.getenv("QCAD_HIGH_QUALITY", "1").strip().lower() not in ("0", "false", "no")
    margin_px = os.getenv("QCAD_MARGIN_PX", "4").strip()
    input_unit = os.getenv("QCAD_INPUT_UNIT", "").strip().lower()
    ltscale = os.getenv("QCAD_LTSCALE", "").strip()
    resolution = os.getenv("QCAD_RESOLUTION", "").strip()
    jpeg_quality = os.getenv("QCAD_JPEG_QUALITY", "100").strip()
    flatten_white = os.getenv("QCAD_FLATTEN_WHITE", "1").strip().lower() not in ("0", "false", "no")

    cmd = [
        exe,
        "-platform", "offscreen",
        "-zoom-all",
        "-m", margin_px,
        "-b", background,
        "-color-correction",
        "-f",
    ]

    if high_quality:
        cmd.extend(["-a", "-d", "-no-weight-margin"])

    if input_unit in ("in", "mm", "m"):
        cmd.extend(["-u", input_unit])

    if ltscale:
        cmd.extend(["-ltscale", ltscale])

    if resolution:
        cmd.extend(["-r", resolution])
    else:
        if not width_px and target_long_side_px is not None and int(target_long_side_px) > 0:
            width_px = str(int(target_long_side_px))
        if width_px:
            cmd.extend(["-x", width_px])
        else:
            cmd.extend(["-x", fallback_width])
        if height_px:
            cmd.extend(["-y", height_px])
        else:
            cmd.extend(["-y", fallback_height])

    if jpeg_quality:
        cmd.extend(["-q", jpeg_quality])

    cmd.extend(["-o", out_png, dwg_path])

    logger.info(
        "render_qcad start input=%s out=%s width=%s height=%s high_quality=%s margin=%s resolution=%s",
        dwg_path,
        out_png,
        width_px or fallback_width,
        height_px or fallback_height,
        high_quality,
        margin_px,
        resolution or "auto",
    )
    run_env = os.environ.copy()
    ld_prev = run_env.get("LD_LIBRARY_PATH", "").strip()
    run_env["LD_LIBRARY_PATH"] = f"{qcad_dir}:{ld_prev}" if ld_prev else qcad_dir
    run_env.setdefault("QT_PLUGIN_PATH", os.path.join(qcad_dir, "plugins"))
    run_env.setdefault("QT_QPA_PLATFORM", "offscreen")
    run_env.setdefault("QT_STYLE_OVERRIDE", "plastique")

    proc = subprocess.run(
        cmd,
        check=False,
        capture_output=True,
        text=True,
        cwd=qcad_dir,
        env=run_env,
    )

    if proc.returncode != 0 or not os.path.exists(out_png):
        # Fallback: bypass shell launchers and invoke qcad-bin directly.
        qcad_bin = os.path.join(qcad_dir, "qcad-bin")
        dwg2bmp_js = os.path.join(qcad_dir, "scripts", "Pro", "Tools", "Dwg2Bmp", "Dwg2Bmp.js")
        if os.path.exists(qcad_bin) and os.path.exists(dwg2bmp_js):
            fallback_cmd = [
                qcad_bin,
                "-no-dock-icon",
                "-no-gui",
                "-allow-multiple-instances",
                "-autostart",
                dwg2bmp_js,
                exe,
                *cmd[1:],
            ]
            logger.warning(
                "render_qcad launcher_failed retrying_direct_qcad cmd=%s rc=%s stderr_tail=%s",
                cmd,
                proc.returncode,
                (proc.stderr or "")[-500:],
            )
            proc2 = subprocess.run(
                fallback_cmd,
                check=False,
                capture_output=True,
                text=True,
                cwd=qcad_dir,
                env=run_env,
            )
            if proc2.returncode == 0 and os.path.exists(out_png):
                proc = proc2
            else:
                raise RuntimeError(
                    "QCAD dwg2bmp failed (launcher + direct). "
                    f"cmd={cmd}\nstdout={proc.stdout}\nstderr={proc.stderr}\n"
                    f"fallback_cmd={fallback_cmd}\n"
                    f"fallback_stdout={proc2.stdout}\n"
                    f"fallback_stderr={proc2.stderr}"
                )

    if proc.returncode != 0 or not os.path.exists(out_png):
        raise RuntimeError(
            "QCAD dwg2bmp failed. "
            f"cmd={cmd}\nstdout={proc.stdout}\nstderr={proc.stderr}"
        )

    Image.MAX_IMAGE_PIXELS = None
    with Image.open(out_png) as im:
        if flatten_white:
            white = Image.new("RGBA", im.size, "#ffffff")
            flat = Image.alpha_composite(white, im.convert("RGBA")).convert("RGB")
            flat.save(out_png, format="PNG", optimize=True, compress_level=6)
            w, h = flat.size
        else:
            w, h = im.size
    logger.info("render_qcad done png=%s size=%sx%s", out_png, w, h)
    return int(w), int(h)


def write_mapping_from_dxf_and_png(
    dxf_path: str,
    png_path: str,
    out_json: str,
    pad_frac: float = 0.01,
):
    xmin_p, ymin_p, xmax_p, ymax_p = _padded_bbox_from_dxf(dxf_path, pad_frac)
    Image.MAX_IMAGE_PIXELS = None
    with Image.open(png_path) as im:
        width_px, height_px = im.size

    mapping = {
        "width_px": int(width_px),
        "height_px": int(height_px),
        "world_bbox": {"xmin": xmin_p, "xmax": xmax_p, "ymin": ymin_p, "ymax": ymax_p},
        "conversion": "u=(x-xmin)/(xmax-xmin); v=(ymax-y)/(ymax-ymin); px=u*W; py=v*H"
    }
    with open(out_json, "w", encoding="utf-8") as f:
        json.dump(mapping, f, indent=2)
    return mapping

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

    xmin_p, ymin_p, xmax_p, ymax_p = _padded_bbox_from_dxf(dxf_path, pad_frac)

    padded_span_x = xmax_p - xmin_p
    padded_span_y = ymax_p - ymin_p

    # Determine pixel dimensions (no letterbox)
    if padded_span_x >= padded_span_y:
        W_px = int(target_long_side_px)
        H_px = max(1, int(round(target_long_side_px * (padded_span_y / padded_span_x))))
    else:
        H_px = int(target_long_side_px)
        W_px = max(1, int(round(target_long_side_px * (padded_span_x / padded_span_y))))

    max_mp = float(os.getenv("RENDER_MAX_MEGAPIXELS", "25"))
    if max_mp > 0:
        current_mp = (W_px * H_px) / 1_000_000.0
        if current_mp > max_mp:
            scale = math.sqrt(max_mp / current_mp)
            old_w, old_h = W_px, H_px
            W_px = max(1, int(round(W_px * scale)))
            H_px = max(1, int(round(H_px * scale)))
            logger.warning(
                "render clamped for speed dxf=%s requested=%sx%s requested_mp=%.2f limit_mp=%.2f effective=%sx%s",
                dxf_path,
                old_w,
                old_h,
                current_mp,
                max_mp,
                W_px,
                H_px,
            )

    logger.info(
        "render start dxf=%s size=%sx%s dpi=%s",
        dxf_path,
        W_px,
        H_px,
        dpi,
    )

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

    logger.info("render done png=%s size=%sx%s", out_png, W_px, H_px)

    mapping = {
        "width_px": int(W_px),
        "height_px": int(H_px),
        "world_bbox": {"xmin": xmin_p, "xmax": xmax_p, "ymin": ymin_p, "ymax": ymax_p},
        "conversion": "u=(x-xmin)/(xmax-xmin); v=(ymax-y)/(ymax-ymin); px=u*W; py=v*H"
    }
    with open(out_json, "w", encoding="utf-8") as f:
        json.dump(mapping, f, indent=2)

    return mapping
