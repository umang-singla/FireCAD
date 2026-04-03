import os
import cv2
import numpy as np
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


def _build_mapping(width_px: int, height_px: int, xmin_p: float, ymin_p: float, xmax_p: float, ymax_p: float):
    span_x = max(1e-9, float(xmax_p - xmin_p))
    span_y = max(1e-9, float(ymax_p - ymin_p))
    scale = min(float(width_px) / span_x, float(height_px) / span_y)
    draw_w = span_x * scale
    draw_h = span_y * scale
    offset_x = (float(width_px) - draw_w) * 0.5
    offset_y = (float(height_px) - draw_h) * 0.5

    return {
        "width_px": int(width_px),
        "height_px": int(height_px),
        "world_bbox": {"xmin": xmin_p, "xmax": xmax_p, "ymin": ymin_p, "ymax": ymax_p},
        "pixel_fit": {
            "mode": "contain",
            "scale": float(scale),
            "offset_x": float(offset_x),
            "offset_y": float(offset_y),
            "draw_width": float(draw_w),
            "draw_height": float(draw_h),
        },
        "conversion": "px=offset_x+(x-xmin)*scale; py=offset_y+(ymax-y)*scale; inverse with same scale/offset",
    }

def process_and_bolden_floor_plan(input_path, output_path, thickness=2, kernel_size=3):
    """
    Reads a faint line drawing image, makes all lines dark and bold,
    and saves the result.

    Args:
        input_path (str): The path to the original faint line drawing image.
        output_path (str): The path where the processed bold image will be saved.
        thickness (int): The number of dilation iterations. More iterations
                         result in thicker lines. A value of 2-3 is usually good.
        kernel_size (int): The size of the dilation kernel. (Must be an odd number).
    """
    # 1. Load the image as a single-channel grayscale image.
    img_gray = cv2.imread(input_path, cv2.IMREAD_GRAYSCALE)

    # 2. Check if the image loaded correctly.
    if img_gray is None:
        print(f"Error: Could not load image at {input_path}")
        return

    # 3. The lines are very faint and light on a dark background.
    #    For the morphological operation (dilation), we need the
    #    lines to be light on a *dark* background.
    #    So, we invert the image. The faint lines become light, and
    #    the white background becomes black.
    img_inverted = cv2.bitwise_not(img_gray)

    # 4. Define a simple rectangular kernel for the dilation.
    kernel = np.ones((kernel_size, kernel_size), np.uint8)

    # 5. Apply the dilation operation to make the lines bolder.
    #    Dilation makes light (foreground) areas thicker.
    img_dilated = cv2.dilate(img_inverted, kernel, iterations=thickness)

    # 6. Invert the image back so that we have dark lines on a
    #    clean white background.
    img_final = cv2.bitwise_not(img_dilated)

    # 7. (Optional) Enhance final contrast.
    #    We can use a simple threshold to make sure the background
    #    is perfectly white and lines are perfectly black.
    _, img_final_thresholded = cv2.threshold(img_final, 220, 255, cv2.THRESH_BINARY)

    # 8. Save the final image.
    #    If the directory doesn't exist, create it.
    output_dir = os.path.dirname(output_path)
    if output_dir and not os.path.exists(output_dir):
        os.makedirs(output_dir)

    cv2.imwrite(output_path, img_final_thresholded)
    print(f"Processed image successfully saved to: {output_path}")

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


def _content_bbox_from_msp(msp, pad_frac: float):
    """Compute a tight bounding box around the main content cluster in the DXF.

    Iterates all entities across all layers, collects per-entity bounding boxes,
    then uses a density-based approach: divide the full extent into a grid and
    find the bounding box of cells that contain significant entity mass.
    This filters out small isolated annotations far from the main floor plans.
    """
    cache = bbox.Cache()

    # Collect individual entity bboxes
    entity_boxes = []
    for entity in msp:
        try:
            eb = bbox.extents([entity], cache=cache)
            if eb.has_data:
                entity_boxes.append((
                    float(eb.extmin.x), float(eb.extmin.y),
                    float(eb.extmax.x), float(eb.extmax.y),
                ))
        except Exception:
            continue

    if not entity_boxes:
        # Fallback to standard extents
        return _padded_bbox_from_msp(msp, pad_frac)

    # Full extents
    all_xmin = min(b[0] for b in entity_boxes)
    all_ymin = min(b[1] for b in entity_boxes)
    all_xmax = max(b[2] for b in entity_boxes)
    all_ymax = max(b[3] for b in entity_boxes)

    full_span_x = max(1e-9, all_xmax - all_xmin)
    full_span_y = max(1e-9, all_ymax - all_ymin)

    # Build a coarse grid (e.g. 50x50) and count entity area per cell
    GRID = 50
    cell_w = full_span_x / GRID
    cell_h = full_span_y / GRID
    grid = [[0.0] * GRID for _ in range(GRID)]

    for (ex0, ey0, ex1, ey1) in entity_boxes:
        # Entity area (use diagonal length as weight for lines/points)
        e_area = max((ex1 - ex0) * (ey1 - ey0), ((ex1 - ex0) + (ey1 - ey0)) * 0.5)
        # Which grid cells does this entity touch
        ci0 = max(0, min(GRID - 1, int((ex0 - all_xmin) / cell_w)))
        ci1 = max(0, min(GRID - 1, int((ex1 - all_xmin) / cell_w)))
        cj0 = max(0, min(GRID - 1, int((ey0 - all_ymin) / cell_h)))
        cj1 = max(0, min(GRID - 1, int((ey1 - all_ymin) / cell_h)))
        for ci in range(ci0, ci1 + 1):
            for cj in range(cj0, cj1 + 1):
                grid[cj][ci] += e_area

    # Find total weight and threshold: keep cells with weight > 0.1% of max cell
    max_weight = max(grid[j][i] for j in range(GRID) for i in range(GRID))
    if max_weight <= 0:
        return _padded_bbox_from_msp(msp, pad_frac)

    threshold = max_weight * 0.001

    # Find bounding box of active cells
    active_ci_min, active_ci_max = GRID, 0
    active_cj_min, active_cj_max = GRID, 0
    for j in range(GRID):
        for i in range(GRID):
            if grid[j][i] > threshold:
                active_ci_min = min(active_ci_min, i)
                active_ci_max = max(active_ci_max, i)
                active_cj_min = min(active_cj_min, j)
                active_cj_max = max(active_cj_max, j)

    if active_ci_min > active_ci_max:
        return _padded_bbox_from_msp(msp, pad_frac)

    # Convert grid cells back to world coords
    content_xmin = all_xmin + active_ci_min * cell_w
    content_xmax = all_xmin + (active_ci_max + 1) * cell_w
    content_ymin = all_ymin + active_cj_min * cell_h
    content_ymax = all_ymin + (active_cj_max + 1) * cell_h

    # Apply padding
    span_x = max(1e-9, content_xmax - content_xmin)
    span_y = max(1e-9, content_ymax - content_ymin)
    xmin_p = content_xmin - pad_frac * span_x
    xmax_p = content_xmax + pad_frac * span_x
    ymin_p = content_ymin - pad_frac * span_y
    ymax_p = content_ymax + pad_frac * span_y

    logger.info(
        "content_bbox full=[%.1f,%.1f,%.1f,%.1f] content=[%.1f,%.1f,%.1f,%.1f] entities=%d",
        all_xmin, all_ymin, all_xmax, all_ymax,
        content_xmin, content_ymin, content_xmax, content_ymax,
        len(entity_boxes),
    )

    return xmin_p, ymin_p, xmax_p, ymax_p


def _content_bbox_from_dxf(dxf_path: str, pad_frac: float):
    """Compute a tight content-aware bounding box from a DXF file."""
    doc = ezdxf.readfile(dxf_path)
    msp = doc.modelspace()
    return _content_bbox_from_msp(msp, pad_frac)


def _padded_bbox_from_dxf(dxf_path: str, pad_frac: float):
    doc = ezdxf.readfile(dxf_path)
    msp = doc.modelspace()
    return _padded_bbox_from_msp(msp, pad_frac)


def render_dwg_to_png_with_qcad(
    dwg_path: str,
    out_png: str,
    target_long_side_px: int | None = None,
    background: str = "white",
    window: str | None = None,
):
    exe = os.getenv("QCAD_DWG2BMP", "/opt/qcad/dwg2bmp")
    if not os.path.exists(exe):
        raise RuntimeError(f"QCAD dwg2bmp not found: {exe}")
    qcad_dir = os.path.dirname(os.path.abspath(exe))

    os.makedirs(os.path.dirname(out_png), exist_ok=True)
    width_px = os.getenv("QCAD_WIDTH_PX", "").strip()
    height_px = os.getenv("QCAD_HEIGHT_PX", "").strip()
    fallback_width = os.getenv("QCAD_DEFAULT_WIDTH_PX", "6000").strip()
    fallback_height = os.getenv("QCAD_DEFAULT_HEIGHT_PX", "4000").strip()
    high_quality = os.getenv("QCAD_HIGH_QUALITY", "1").strip().lower() not in ("0", "false", "no")
    margin_px = os.getenv("QCAD_MARGIN_PX", "4").strip()
    input_unit = os.getenv("QCAD_INPUT_UNIT", "").strip().lower()
    ltscale = os.getenv("QCAD_LTSCALE", "").strip()
    resolution = os.getenv("QCAD_RESOLUTION", "").strip()
    jpeg_quality = os.getenv("QCAD_JPEG_QUALITY", "100").strip()
    flatten_white = os.getenv("QCAD_FLATTEN_WHITE", "1").strip().lower() not in ("0", "false", "no")
    min_lineweight = os.getenv("QCAD_MIN_LINEWEIGHT", "0.5").strip()
    force_black = os.getenv("QCAD_FORCE_BLACK", "1").strip().lower() not in ("0", "false", "no")

    cmd = [
        exe,
        "-platform", "offscreen",
    ]

    # When a window region is specified, use -window instead of -zoom-all
    if window:
        cmd.extend(["-b", background, "-f", f"-window={window}"])
        cmd.extend(["-margin", "0"])
    else:
        cmd.extend(["-zoom-all", "-m", margin_px, "-b", background, "-f"])

    # -k converts all entity colors to black on white bg (grayscale output)
    if force_black:
        cmd.append("-k")
    else:
        cmd.append("-color-correction")

    # Thicken thin lines so they remain visible at high resolution
    if min_lineweight:
        cmd.extend(["-min-lineweight", min_lineweight])

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
    ld_parts = [qcad_dir, "/usr/lib", "/usr/lib/x86_64-linux-gnu"]
    ld_prev = run_env.get("LD_LIBRARY_PATH", "").strip()
    if ld_prev:
        ld_parts.extend([p for p in ld_prev.split(":") if p])
    dedup_ld_parts = []
    for part in ld_parts:
        if part and part not in dedup_ld_parts:
            dedup_ld_parts.append(part)
    run_env["LD_LIBRARY_PATH"] = ":".join(dedup_ld_parts)

    qcad_lib_candidates = [
        os.path.join(qcad_dir, "libqcadecmaapi.so"),
        "/usr/lib/libqcadecmaapi.so",
        "/usr/lib/x86_64-linux-gnu/libqcadecmaapi.so",
    ]
    qcad_lib = next((p for p in qcad_lib_candidates if os.path.exists(p)), None)
    if not qcad_lib:
        logger.warning(
            "render_qcad shared library not found candidates=%s qcad_dir=%s",
            qcad_lib_candidates,
            qcad_dir,
        )
    force_preload = os.getenv("QCAD_FORCE_PRELOAD", "0").strip().lower() in ("1", "true", "yes")
    if qcad_lib and force_preload:
        preload_prev = run_env.get("LD_PRELOAD", "").strip()
        run_env["LD_PRELOAD"] = f"{qcad_lib}:{preload_prev}" if preload_prev else qcad_lib
    run_env.setdefault("QT_PLUGIN_PATH", qcad_dir)
    run_env.setdefault("QT_QPA_PLATFORM_PLUGIN_PATH", os.path.join(qcad_dir, "platforms"))
    run_env.setdefault("QT_QPA_PLATFORM", "offscreen")
    run_env.setdefault("QT_STYLE_OVERRIDE", "plastique")

    inline_env = []
    if run_env.get("LD_LIBRARY_PATH"):
        inline_env.append(f"LD_LIBRARY_PATH={run_env['LD_LIBRARY_PATH']}")
    if run_env.get("LD_PRELOAD"):
        inline_env.append(f"LD_PRELOAD={run_env['LD_PRELOAD']}")
    qcad_bin = os.path.join(qcad_dir, "qcad-bin")
    dwg2bmp_js = os.path.join(qcad_dir, "scripts", "Pro", "Tools", "Dwg2Bmp", "Dwg2Bmp.js")

    using_direct_qcad = os.path.exists(qcad_bin) and os.path.exists(dwg2bmp_js)
    if using_direct_qcad:
        primary_cmd = [
            qcad_bin,
            "-no-dock-icon",
            "-no-gui",
            "-allow-multiple-instances",
            "-autostart",
            dwg2bmp_js,
            exe,
            *cmd[1:],
        ]
    else:
        primary_cmd = cmd

    exec_cmd = ["/usr/bin/env", *inline_env, *primary_cmd]

    proc = subprocess.run(
        exec_cmd,
        check=False,
        capture_output=True,
        text=True,
        cwd=qcad_dir,
        env=run_env,
    )

    if proc.returncode != 0 or not os.path.exists(out_png):
        # Fallback: switch launch strategy between direct qcad-bin and wrapper.
        if using_direct_qcad:
            fallback_cmd = cmd
        elif os.path.exists(qcad_bin) and os.path.exists(dwg2bmp_js):
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
        else:
            fallback_cmd = None

        if fallback_cmd is not None:
            logger.warning(
                "render_qcad launcher_failed retrying_direct_qcad cmd=%s rc=%s stderr_tail=%s",
                exec_cmd,
                proc.returncode,
                (proc.stderr or "")[-500:],
            )
            fallback_exec_cmd = ["/usr/bin/env", *inline_env, *fallback_cmd]
            proc2 = subprocess.run(
                fallback_exec_cmd,
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
                    f"cmd={exec_cmd}\nstdout={proc.stdout}\nstderr={proc.stderr}\n"
                    f"fallback_cmd={fallback_exec_cmd}\n"
                    f"fallback_stdout={proc2.stdout}\n"
                    f"fallback_stderr={proc2.stderr}"
                )

    if proc.returncode != 0 or not os.path.exists(out_png):
        raise RuntimeError(
            "QCAD dwg2bmp failed. "
            f"cmd={exec_cmd}\n"
            f"qcad_lib_candidates={qcad_lib_candidates}\n"
            f"qcad_lib_selected={qcad_lib}\n"
            f"stdout={proc.stdout}\nstderr={proc.stderr}"
        )
    
    process_and_bolden_floor_plan(out_png, out_png, thickness=2, kernel_size=3)

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

    mapping = _build_mapping(
        width_px=int(width_px),
        height_px=int(height_px),
        xmin_p=xmin_p,
        ymin_p=ymin_p,
        xmax_p=xmax_p,
        ymax_p=ymax_p,
    )
    with open(out_json, "w", encoding="utf-8") as f:
        json.dump(mapping, f, indent=2)
    return mapping


def _qcad_env_and_launcher(exe: str):
    """Build the QCAD runtime environment and determine the launch command prefix.

    Returns (run_env, inline_env, qcad_prefix_builder) where qcad_prefix_builder
    is a callable that takes a base cmd list and returns the full exec_cmd list.
    """
    qcad_dir = os.path.dirname(os.path.abspath(exe))
    run_env = os.environ.copy()
    ld_parts = [qcad_dir, "/usr/lib", "/usr/lib/x86_64-linux-gnu"]
    ld_prev = run_env.get("LD_LIBRARY_PATH", "").strip()
    if ld_prev:
        ld_parts.extend([p for p in ld_prev.split(":") if p])
    run_env["LD_LIBRARY_PATH"] = ":".join(dict.fromkeys(ld_parts))
    run_env.setdefault("QT_PLUGIN_PATH", qcad_dir)
    run_env.setdefault("QT_QPA_PLATFORM_PLUGIN_PATH", os.path.join(qcad_dir, "platforms"))
    run_env.setdefault("QT_QPA_PLATFORM", "offscreen")
    run_env.setdefault("QT_STYLE_OVERRIDE", "plastique")

    inline_env = []
    if run_env.get("LD_LIBRARY_PATH"):
        inline_env.append(f"LD_LIBRARY_PATH={run_env['LD_LIBRARY_PATH']}")

    qcad_bin = os.path.join(qcad_dir, "qcad-bin")
    dwg2bmp_js = os.path.join(qcad_dir, "scripts", "Pro", "Tools", "Dwg2Bmp", "Dwg2Bmp.js")
    use_direct = os.path.exists(qcad_bin) and os.path.exists(dwg2bmp_js)

    def build_exec_cmd(cmd):
        if use_direct:
            return ["/usr/bin/env", *inline_env,
                    qcad_bin, "-no-dock-icon", "-no-gui",
                    "-allow-multiple-instances", "-autostart", dwg2bmp_js,
                    cmd[0], *cmd[1:]]
        return ["/usr/bin/env", *inline_env, *cmd]

    return run_env, qcad_dir, build_exec_cmd


def render_master_cropped(
    dxf_path: str,
    out_png: str,
    out_json: str,
    target_long_side_px: int = 6000,
    pad_frac: float = 0.01,
    background: str = "white",
    out_gray_png: str | None = None,
):
    """Render master DXF layout using the exact Colab Section 4 approach.

    Produces two renders:
    - out_png: colored image (original DXF colors) for UI display
    - out_gray_png: grayscale image (-k flag, all black) for processing/splitting
    If out_gray_png is None a path is derived from out_png (render_gray.png).

    1. get_dxf_extents → IQR-based tight bounds (outlier removal)
    2. Compute -window=Xmin,Ymin,W,H and proportional pixel dims
    3. Render via QCAD -window (no post-crop needed)
    4. Write Colab-style mapping JSON (QCAD aspect-ratio aware)
    """
    from app.pipeline.floor_plan_split import (
        get_dxf_extents,
        _build_mapping as _build_mapping_colab,
    )

    if out_gray_png is None:
        base, ext = os.path.splitext(out_png)
        out_gray_png = f"{base}_gray{ext}"

    X_min, Y_min, X_max, Y_max = get_dxf_extents(dxf_path)
    DXF_W = X_max - X_min
    DXF_H = Y_max - Y_min

    master_w_px = target_long_side_px
    master_h_px = int(master_w_px * (DXF_H / DXF_W))
    window_str = f"{X_min:.4f},{Y_min:.4f},{DXF_W:.4f},{DXF_H:.4f}"

    os.makedirs(os.path.dirname(out_png), exist_ok=True)

    exe = os.getenv("QCAD_DWG2BMP", "/opt/qcad/dwg2bmp")
    if not os.path.exists(exe):
        raise RuntimeError(f"QCAD dwg2bmp not found: {exe}")

    run_env, qcad_dir, build_exec_cmd = _qcad_env_and_launcher(exe)

    # Common args (without color flag and output path)
    base_args = [
        exe,
        "-platform", "offscreen",
        "-f", f"-window={window_str}",
        "-b", background,
        "-min-lineweight", "0.5",
        "-x", str(master_w_px), "-y", str(master_h_px),
        "-margin", "0",
    ]

    # 1) Render grayscale (with -k) for processing/splitting
    gray_cmd = [*base_args, "-k", "-o", out_gray_png, dxf_path]
    logger.info(
        "render_master_cropped GRAY QCAD -window=%s out=%s %dx%d",
        window_str, out_gray_png, master_w_px, master_h_px,
    )
    subprocess.run(build_exec_cmd(gray_cmd), stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL,
                   cwd=qcad_dir, env=run_env)

    if not os.path.exists(out_gray_png):
        raise RuntimeError(f"QCAD produced no grayscale output: {out_gray_png}")

    # 2) Render colored (without -k) for UI display
    color_cmd = [*base_args, "-color-correction", "-o", out_png, dxf_path]
    logger.info(
        "render_master_cropped COLOR QCAD -window=%s out=%s %dx%d",
        window_str, out_png, master_w_px, master_h_px,
    )
    subprocess.run(build_exec_cmd(color_cmd), stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL,
                   cwd=qcad_dir, env=run_env)

    if not os.path.exists(out_png):
        raise RuntimeError(f"QCAD produced no colored output: {out_png}")

    # Read actual dimensions from the grayscale image (used for mapping/processing)
    Image.MAX_IMAGE_PIXELS = None
    with Image.open(out_gray_png) as im:
        actual_w, actual_h = im.size

    # Map EXACTLY to the true dimensions QCAD outputted (Colab _build_mapping)
    master_mapping = _build_mapping_colab(actual_w, actual_h, X_min, Y_min, X_max, Y_max)

    mapping_data = {
        "image_file": os.path.basename(out_gray_png),
        "width_px": int(master_mapping["width_px"]),
        "height_px": int(master_mapping["height_px"]),
        "world_bbox": {
            "xmin": master_mapping["xmin"],
            "xmax": master_mapping["xmax"],
            "ymin": master_mapping["ymin"],
            "ymax": master_mapping["ymax"],
        },
    }
    with open(out_json, "w", encoding="utf-8") as f:
        json.dump(mapping_data, f, indent=4)

    logger.info(
        "render_master_cropped done color=%s gray=%s size=%dx%d extents=[%.1f,%.1f,%.1f,%.1f]",
        out_png, out_gray_png, actual_w, actual_h, X_min, Y_min, X_max, Y_max,
    )
    return actual_w, actual_h, out_gray_png

def render_dxf_to_png_and_mapping(
    dxf_path: str,
    out_png: str,
    out_json: str,
    target_long_side_px: int = 6000,
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

    mapping = _build_mapping(
        width_px=int(W_px),
        height_px=int(H_px),
        xmin_p=xmin_p,
        ymin_p=ymin_p,
        xmax_p=xmax_p,
        ymax_p=ymax_p,
    )
    with open(out_json, "w", encoding="utf-8") as f:
        json.dump(mapping, f, indent=2)

    return mapping
