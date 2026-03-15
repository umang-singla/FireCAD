import cv2
import numpy as np


LOWER_RED_1 = np.array([0, 8, 8], dtype=np.uint8)
UPPER_RED_1 = np.array([25, 255, 255], dtype=np.uint8)
LOWER_RED_2 = np.array([150, 8, 8], dtype=np.uint8)
UPPER_RED_2 = np.array([179, 255, 255], dtype=np.uint8)

LOWER_BLUE_HSV = np.array([85, 25, 15], dtype=np.uint8)
UPPER_BLUE_HSV = np.array([150, 255, 255], dtype=np.uint8)

RED_LAB_A_MIN = 128
BLUE_LAB_B_MAX = 115


def _build_blue_mask(img_bgr: np.ndarray, hsv: np.ndarray, lab: np.ndarray) -> np.ndarray:
    """Detect and preserve blue door/feature pixels robustly."""
    blue_hsv = cv2.inRange(hsv, LOWER_BLUE_HSV, UPPER_BLUE_HSV)

    b_chan = img_bgr[:, :, 0].astype(np.int16)
    g_chan = img_bgr[:, :, 1].astype(np.int16)
    r_chan = img_bgr[:, :, 2].astype(np.int16)
    blue_dom = (b_chan >= 25) & ((b_chan - g_chan) >= 6) & ((b_chan - r_chan) >= 6)
    blue_dom_mask = blue_dom.astype(np.uint8) * 255

    _, _, b_lab = cv2.split(lab)
    blue_lab_mask = (b_lab <= BLUE_LAB_B_MAX).astype(np.uint8) * 255

    blue_mask = cv2.bitwise_or(cv2.bitwise_or(blue_hsv, blue_dom_mask), blue_lab_mask)

    kernel = cv2.getStructuringElement(cv2.MORPH_ELLIPSE, (3, 3))
    blue_mask = cv2.morphologyEx(blue_mask, cv2.MORPH_CLOSE, kernel, iterations=1)
    blue_mask = cv2.morphologyEx(blue_mask, cv2.MORPH_OPEN, kernel, iterations=1)
    return blue_mask


def _build_red_wall_mask(img_bgr: np.ndarray, hsv: np.ndarray, lab: np.ndarray) -> np.ndarray:
    """Detect red walls across a broad range of shades and intensities."""
    red_hsv_1 = cv2.inRange(hsv, LOWER_RED_1, UPPER_RED_1)
    red_hsv_2 = cv2.inRange(hsv, LOWER_RED_2, UPPER_RED_2)
    red_hsv = cv2.bitwise_or(red_hsv_1, red_hsv_2)

    b = img_bgr[:, :, 0].astype(np.int16)
    g = img_bgr[:, :, 1].astype(np.int16)
    r = img_bgr[:, :, 2].astype(np.int16)

    # Captures muted and anti-aliased reds where hue can drift.
    red_dom = (r >= 25) & ((r - g) >= 5) & ((r - b) >= 5)
    red_dom_mask = red_dom.astype(np.uint8) * 255

    # Captures very dark/muted reds that can be weak in HSV.
    _, a_lab, _ = cv2.split(lab)
    red_lab_mask = (a_lab >= RED_LAB_A_MIN).astype(np.uint8) * 255

    red_seed = cv2.bitwise_or(cv2.bitwise_or(red_hsv, red_dom_mask), red_lab_mask)

    # Convert red+green blend (yellow/orange anti-aliased edge pixels) to red,
    # but only near existing red wall seed pixels.
    rg_blend = (
        (r >= 25)
        & (g >= 20)
        & (np.abs(r - g) <= 85)
        & (((r + g) // 2 - b) >= 15)
    )
    rg_blend_mask = rg_blend.astype(np.uint8) * 255
    near_red = cv2.dilate(red_seed, cv2.getStructuringElement(cv2.MORPH_ELLIPSE, (5, 5)), iterations=1)
    rg_blend_near_red = cv2.bitwise_and(rg_blend_mask, near_red)

    return cv2.bitwise_or(red_seed, rg_blend_near_red)

def solidify_ultimate_aggressive(img_bgr, thickness=2):
    hsv = cv2.cvtColor(img_bgr, cv2.COLOR_BGR2HSV)
    lab = cv2.cvtColor(img_bgr, cv2.COLOR_BGR2Lab)
    l, a, b = cv2.split(lab)

    blue_mask = _build_blue_mask(img_bgr, hsv, lab)
    blue_original = cv2.bitwise_and(img_bgr, img_bgr, mask=blue_mask)

    red_mask = _build_red_wall_mask(img_bgr, hsv, lab)
    aggressive_mask = cv2.bitwise_and(red_mask, cv2.bitwise_not(blue_mask))

    kernel_small = cv2.getStructuringElement(cv2.MORPH_ELLIPSE, (3, 3))
    cleaned_mask = cv2.morphologyEx(aggressive_mask, cv2.MORPH_OPEN, kernel_small, iterations=1)
    cleaned_mask = cv2.morphologyEx(cleaned_mask, cv2.MORPH_CLOSE, kernel_small, iterations=1)

    if thickness > 0:
        kernel_thick = cv2.getStructuringElement(cv2.MORPH_ELLIPSE, (3, 3))
        final_wall_mask = cv2.dilate(cleaned_mask, kernel_thick, iterations=thickness)
    else:
        final_wall_mask = cleaned_mask

    _, _, _, max_loc = cv2.minMaxLoc(a)
    canonical_red = img_bgr[max_loc[1], max_loc[0]]

    result = img_bgr.copy()
    result[final_wall_mask > 0] = canonical_red
    result[blue_mask > 0] = blue_original[blue_mask > 0]

    return result, final_wall_mask

def fix_walls(input_png: str, out_png: str, thickness: int = 2):
    img = cv2.imread(input_png)
    if img is None:
        raise RuntimeError("Could not load aligned mask image for wall fix.")
    final, _ = solidify_ultimate_aggressive(img, thickness=thickness)
    cv2.imwrite(out_png, final)
