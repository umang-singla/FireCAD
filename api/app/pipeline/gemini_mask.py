import os
from PIL import Image
from google import genai

DEFAULT_PROMPT = (
    "Give an masked image of this uploaded floor plan such that walls and unknown lines are represented with red color, "
    "doors with blue, dimension lines (if present in input image) with black color and room area with green color. "
    "Door should be either closing the opening with thick lines or the curves should be filled completely. "
    "There should be no line of any element inside the room. Mask background should be white. "
    "Keep the relative distance between each object intact as in the input image. "
    "Don't add any line which is not in the input image and no line from input image should be missed."
)

def generate_mask_image(
    input_png: str,
    out_mask_png: str,
    prompt: str = DEFAULT_PROMPT,
    model: str = "gemini-2.5-flash-image",
    max_side: int = 2048,
):
    api_key = os.getenv("GEMINI_API_KEY", "").strip()
    if not api_key:
        raise RuntimeError("GEMINI_API_KEY is not set. Cannot generate mask via Gemini.")

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
    for part in resp.parts:
        if getattr(part, "inline_data", None) is not None:
            im = part.as_image()
            im.save(out_mask_png)
            got = True
            break

    if not got:
        raise RuntimeError("Gemini response had no image payload. Check model/prompt/quota.")
