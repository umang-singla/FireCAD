import cv2
import numpy as np

def solidify_ultimate_aggressive(img_bgr, thickness=2):
    lab = cv2.cvtColor(img_bgr, cv2.COLOR_BGR2Lab)
    l, a, b = cv2.split(lab)

    blue_mask = (b < 110).astype(np.uint8) * 255
    blue_original = cv2.bitwise_and(img_bgr, img_bgr, mask=blue_mask)

    r_chan = img_bgr[:,:,2].astype(np.int16)
    g_chan = img_bgr[:,:,1].astype(np.int16)
    red_score = r_chan - g_chan

    aggressive_mask = ((red_score > 5) & (blue_mask == 0)).astype(np.uint8) * 255

    kernel_small = cv2.getStructuringElement(cv2.MORPH_ELLIPSE, (3, 3))
    cleaned_mask = cv2.morphologyEx(aggressive_mask, cv2.MORPH_OPEN, kernel_small)

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
