import os
import base64
from io import BytesIO
from PIL import Image
from google import genai
import cv2
import numpy as np
import logging

logger = logging.getLogger("firecad.pipeline.gemini_mask")

# Corner marker size in pixels (on the thumbnail sent to Gemini)
MARKER_SIZE = 40


def _iter_response_parts(resp):
    direct_parts = getattr(resp, "parts", None)
    if direct_parts:
        for part in direct_parts:
            yield part

    candidates = getattr(resp, "candidates", None) or []
    for candidate in candidates:
        content = getattr(candidate, "content", None)
        parts = getattr(content, "parts", None) or []
        for part in parts:
            yield part


def _part_to_image(part):
    inline = getattr(part, "inline_data", None)
    if inline is None:
        return None

    raw = getattr(inline, "data", None)
    if not raw:
        return None

    if isinstance(raw, str):
        try:
            data = base64.b64decode(raw)
        except Exception:
            data = raw.encode("utf-8")
    elif isinstance(raw, (bytes, bytearray)):
        data = bytes(raw)
    else:
        return None

    return Image.open(BytesIO(data))

DEFAULT_PROMPT = "Give an masked image of this uploaded floor plan such that walls and unknown lines are represented with red color , doors with blue and room/floor area with green color. Door curves should be filled completely. There should be no line of any element inside the room. Mask background should be white. keep the relative distance between each object intact as in the input image. dont fucking dare to miss any internal line like beam and all every fucking partion is imp for my task dont dare to miss any wall give the fucking image now. Dont fucking add doors from your assumption, add them only whem there is a symbol in the input image. And Make walls, beams and unknown lines to be fucking solid filled red. Dont fucking make walls and beams hollow, make them solid red. Dont fucking miss any wall or beam or partition or door or any line in the input image. And dont fucking add any line which is not in the input image. Just give me the masked image with walls and beams and unknown lines in solid red color, doors in blue color and floor/room area in green color. And keep the relative distance between each object intact as in the input image. Dont fucking miss any internal line like beam and all every fucking partion is imp for my task dont dare to miss any wall give the fucking image now. Dont fucking add doors from your assumption, add them only whem there is a symbol in the input image. And Make walls, beams and unknown lines to be fucking solid filled red. Dont fucking make walls and beams hollow, make them solid red. Dont fucking miss any wall or beam or partition or door or any line in the input image. And dont fucking add any line which is not in the input image. Just give me the masked image with walls and beams and unknown lines in solid red color, doors in blue color and floor/room area in green color. And keep the relative distance between each object intact as in the input image."


# ── Corner marker helpers ──────────────────────────────────────

def add_corner_markers(pil_img: Image.Image, marker_size: int = MARKER_SIZE) -> Image.Image:
    """Add magenta squares to the four corners of a PIL image.

    These markers survive Gemini's processing and allow precise
    perspective-transform alignment of the returned mask.
    """
    img = pil_img.copy().convert("RGB")
    arr = np.array(img)
    h, w = arr.shape[:2]
    s = min(marker_size, min(h, w) // 4)
    magenta = (255, 0, 255)  # RGB

    arr[0:s, 0:s] = magenta           # top-left
    arr[0:s, w - s:w] = magenta       # top-right
    arr[h - s:h, w - s:w] = magenta   # bottom-right
    arr[h - s:h, 0:s] = magenta       # bottom-left

    return Image.fromarray(arr)


def detect_marker_centers(pil_img: Image.Image, min_area: int = 20):
    """Detect the four magenta corner markers and return ordered corner points.

    Returns np.array of shape (4, 2) as [TL, TR, BR, BL] or None if < 4 found.
    """
    arr = np.array(pil_img.convert("RGB"))
    r, g, b = arr[:, :, 0], arr[:, :, 1], arr[:, :, 2]

    mask = ((r > 180) & (b > 180) & (g < 100)).astype(np.uint8) * 255
    cnts, _ = cv2.findContours(mask, cv2.RETR_EXTERNAL, cv2.CHAIN_APPROX_SIMPLE)

    centers = []
    for c in cnts:
        area = cv2.contourArea(c)
        if area < min_area:
            continue
        M = cv2.moments(c)
        if abs(M["m00"]) < 1e-9:
            continue
        cx = float(M["m10"] / M["m00"])
        cy = float(M["m01"] / M["m00"])
        centers.append((cx, cy, area))

    if len(centers) < 4:
        return None

    # Keep 4 largest
    centers = sorted(centers, key=lambda t: t[2], reverse=True)[:4]
    pts = np.array([[c[0], c[1]] for c in centers], dtype=np.float32)

    # Order: TL, TR, BR, BL
    sums = pts[:, 0] + pts[:, 1]
    diffs = pts[:, 0] - pts[:, 1]
    tl = pts[np.argmin(sums)]
    br = pts[np.argmax(sums)]
    tr = pts[np.argmax(diffs)]
    bl = pts[np.argmin(diffs)]

    return np.array([tl, tr, br, bl], dtype=np.float32)


def get_marker_target_points(w: int, h: int, marker_size: int = MARKER_SIZE):
    """Expected marker centers for the target image dimensions."""
    s = float(marker_size)
    return np.array([
        [s / 2.0, s / 2.0],             # TL
        [w - s / 2.0, s / 2.0],         # TR
        [w - s / 2.0, h - s / 2.0],     # BR
        [s / 2.0, h - s / 2.0],         # BL
    ], dtype=np.float32)


def remove_markers_from_mask(arr: np.ndarray, marker_size: int = MARKER_SIZE) -> np.ndarray:
    """Zero out the corner regions where markers were placed."""
    out = arr.copy()
    h, w = out.shape[:2]
    s = int(marker_size * 1.4)

    out[0:s, 0:s] = 0
    out[0:s, max(0, w - s):w] = 0
    out[max(0, h - s):h, max(0, w - s):w] = 0
    out[max(0, h - s):h, 0:s] = 0
    return out


# Marker preservation instruction appended to every prompt
_MARKER_INSTRUCTION = (
    "\n\nIMPORTANT: The input image has four pure MAGENTA (RGB 255,0,255) "
    "squares in the four corners. You MUST preserve these four magenta "
    "corner squares in the EXACT same corner locations in your output "
    "image. Do NOT change their color, size, or position."
)


def generate_mask_image(
    input_png: str,
    out_mask_png: str,
    prompt: str = DEFAULT_PROMPT,
    model: str = "gemini-3.1-flash-image-preview",
    max_side: int = 2048,
    context_mask_png: str | None = None,
):
    api_key = os.getenv("GEMINI_API_KEY", "").strip()
    if not api_key:
        raise RuntimeError("GEMINI_API_KEY is not set. Cannot generate mask via Gemini.")

    Image.MAX_IMAGE_PIXELS = None
    img = Image.open(input_png)
    img.thumbnail((max_side, max_side), Image.Resampling.LANCZOS)

    # Add corner markers for alignment
    img_marked = add_corner_markers(img, MARKER_SIZE)
    full_prompt = prompt + _MARKER_INSTRUCTION

    contents = [full_prompt, img_marked]
    if context_mask_png and os.path.exists(context_mask_png):
        ctx_img = Image.open(context_mask_png)
        ctx_img.thumbnail((max_side, max_side), Image.Resampling.LANCZOS)
        ctx_marked = add_corner_markers(ctx_img, MARKER_SIZE)
        contents.append(ctx_marked)

    client = genai.Client(api_key=api_key)

    resp = client.models.generate_content(
        model=model,
        contents=contents,
        config={"response_modalities": ["IMAGE"]},
    )

    # Extract first image part
    got = False
    for part in _iter_response_parts(resp):
        if getattr(part, "inline_data", None) is not None:
            im = _part_to_image(part)
            if im is not None:
                im.save(out_mask_png)
                got = True
                break

    if not got:
        raise RuntimeError("Gemini response had no image payload. Check model/prompt/quota.")
