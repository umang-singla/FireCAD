import os
import base64
from io import BytesIO
from PIL import Image
from google import genai


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

DEFAULT_PROMPT = "Give an masked image of this uploaded floor plan such that walls and unknown lines are represented with red color, doors with blue, dimension lines (if present in input image) with black color and room area with green color. Door curves should be filled completely. There should be no line of any element inside the room. Mask background should be white. keep the relative detance between each object intact as in the input image. Don't add any line which is not in the input image and no line from input image should be missed."


def generate_mask_image(
    input_png: str,
    out_mask_png: str,
    prompt: str = DEFAULT_PROMPT,
    model: str = "gemini-3.1-flash-image-preview",
    max_side: int = 2048,
):
    api_key = os.getenv("GEMINI_API_KEY", "").strip()
    if not api_key:
        raise RuntimeError("GEMINI_API_KEY is not set. Cannot generate mask via Gemini.")

    Image.MAX_IMAGE_PIXELS = None
    img = Image.open(input_png)
    img.thumbnail((max_side, max_side), Image.Resampling.LANCZOS)

    client = genai.Client(api_key=api_key)

    resp = client.models.generate_content(
        model=model,
        contents=[prompt, img],
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
