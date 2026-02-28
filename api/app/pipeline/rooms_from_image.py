import cv2
import numpy as np
import json
import os

# Based on your notebook cell (rooms_from_image)

LOWER_GREEN = np.array([40, 50, 50])
UPPER_GREEN = np.array([80, 255, 255])

LOWER_BLUE = np.array([100, 150, 50])
UPPER_BLUE = np.array([140, 255, 255])

MIN_AREA_PX = 500
EPSILON_TIGHT = 1.5
EPSILON_FINAL = 4.0

def load_mapping(mapping_path: str):
    with open(mapping_path, "r", encoding="utf-8") as f:
        data = json.load(f)
    return data

def pixel_to_world(px, py, img_w, img_h, bbox, pixel_fit=None):
    xmin, xmax = bbox["xmin"], bbox["xmax"]
    ymin, ymax = bbox["ymin"], bbox["ymax"]

    if pixel_fit and float(pixel_fit.get("scale", 0.0)) > 0.0:
        scale = float(pixel_fit["scale"])
        offset_x = float(pixel_fit.get("offset_x", 0.0))
        offset_y = float(pixel_fit.get("offset_y", 0.0))
        wx = xmin + (float(px) - offset_x) / scale
        wy = ymax - (float(py) - offset_y) / scale
        return [wx, wy]

    u = px / img_w
    v = py / img_h
    wx = xmin + u * (xmax - xmin)
    wy = ymax - v * (ymax - ymin)
    return [wx, wy]

def extract_rooms(mask_bgr_path: str, mapping_json_path: str, out_json_path: str, debug_png_path: str | None = None):
    img = cv2.imread(mask_bgr_path)
    if img is None:
        raise RuntimeError("Could not load mask image for room extraction.")
    hsv = cv2.cvtColor(img, cv2.COLOR_BGR2HSV)

    green = cv2.inRange(hsv, LOWER_GREEN, UPPER_GREEN)
    blue = cv2.inRange(hsv, LOWER_BLUE, UPPER_BLUE)

    # Remove doors from green
    green_no_doors = cv2.bitwise_and(green, cv2.bitwise_not(blue))

    # Close small gaps
    kernel = np.ones((5,5), np.uint8)
    green_clean = cv2.morphologyEx(green_no_doors, cv2.MORPH_CLOSE, kernel, iterations=2)

    cnts, _ = cv2.findContours(green_clean, cv2.RETR_EXTERNAL, cv2.CHAIN_APPROX_SIMPLE)

    mapping = load_mapping(mapping_json_path)
    bbox = mapping["world_bbox"]
    W = int(mapping["width_px"])
    H = int(mapping["height_px"])
    pixel_fit = mapping.get("pixel_fit")

    rooms = []
    dbg = img.copy()
    for i,c in enumerate(cnts):
        area = cv2.contourArea(c)
        if area < MIN_AREA_PX:
            continue

        # Tight polygon
        eps = EPSILON_FINAL
        approx = cv2.approxPolyDP(c, eps, True)

        # Convert to world coords
        pts_px = approx.reshape(-1,2).tolist()
        pts_w = [pixel_to_world(p[0], p[1], W, H, bbox, pixel_fit=pixel_fit) for p in pts_px]

        rooms.append({
            "id": f"room_{i}",
            "area_px": float(area),
            "polygon_px": pts_px,
            "polygon_world": pts_w,
        })

        cv2.drawContours(dbg, [approx], -1, (0,0,255), 2)

    with open(out_json_path, "w", encoding="utf-8") as f:
        json.dump({"rooms": rooms}, f, indent=2)

    if debug_png_path:
        cv2.imwrite(debug_png_path, dbg)

    return rooms
