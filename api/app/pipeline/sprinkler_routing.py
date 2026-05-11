"""Sprinkler placement and orthogonal pipe routing.

Ported from the notebook pipeline (Cells 19-20).  Produces sprinkler
coordinates, sized pipe segments, and optionally exports them into a DXF.
"""

import os
import math
import logging
import re
from typing import Dict, List, Tuple

import numpy as np
import cv2
from shapely.geometry import Polygon, LineString, Point, LinearRing, box
from shapely.validation import make_valid
from shapely.affinity import rotate
from shapely.ops import split, unary_union

try:
    from pydantic import BaseModel as _BaseModel
    _PYDANTIC_OK = True
except ImportError:
    _PYDANTIC_OK = False

try:
    import networkx as nx
    _NX_OK = True
except ImportError:
    _NX_OK = False

try:
    import ezdxf
    from ezdxf import bbox as _ezbbox
    from ezdxf import recover as _ezdxf_recover
    from ezdxf.addons import MTextExplode as _MTextExplode
    _EZDXF_OK = True
except ImportError:
    _EZDXF_OK = False

try:
    from google import genai
    from google.genai import types as _genai_types
    _GENAI_OK = True
except ImportError:
    _GENAI_OK = False

logger = logging.getLogger("mepit.pipeline.sprinkler_routing")

# ── runtime defaults (overridden by callers) ──────────────────────
WORLD_TO_M = 0.001
SPRINKLER_SPACING_M = 3.0
MIN_REGION_AREA_M2 = 2.5
NOISE_TOLERANCE_M = 0.15
MIN_WALL_LENGTH_M = 0.05
WALL_BUFFER_M = 0.20       # STRICT 200mm minimum distance from all walls
ALIGN_TOLERANCE_M = 0.5    # Maximum distance to snap points to the global grid

PIPE_SIZES = ['25mm', '32mm', '40mm', '50mm', '65mm', '80mm', '90mm']

# Hazard categories used by sprinkler placement logic.
HAZARD_LH = "LH"
HAZARD_OH = "OH"
HAZARD_HH = "HH"
HAZARD_WASHROOM = "WASHROOM"
HAZARD_NONE = "NONE"

# Room taxonomy catalog used for Gemini rule-ID mapping.
ROOM_RULES = {
    "GENERIC_NORMAL_ROOM": {"interpreted_room": "Generic Room", "phrases": ["OFFICE", "CABIN", "MEETING ROOM", "CONFERENCE ROOM", "RECEPTION", "HALL", "BEDROOM", "STORE", "ROOM"], "keywords": ["OFFICE", "CABIN", "MEETING", "CONFERENCE", "ROOM"], "priority": 5},
    "PLANT_AREA": {"interpreted_room": "Plant Area", "phrases": ["PLANT ROOM", "MECHANICAL PLANT", "MACHINE ROOM"], "keywords": ["PLANT", "MECHANICAL", "MACHINE"], "priority": 25},
    "GARAGE_REPAIR": {"interpreted_room": "Garage/Repair", "phrases": ["GARAGE", "REPAIR SHOP", "WORKSHOP"], "keywords": ["GARAGE", "WORKSHOP"], "priority": 40},
    "STORE_FLAMMABLE_CONFINED": {"interpreted_room": "Flammable Store", "phrases": ["CHEMICAL STORE", "PAINT STORE", "FLAMMABLE STORE"], "keywords": ["CHEMICAL", "PAINT", "FLAMMABLE"], "priority": 42},
    "COMPUTER_EDP_ROOM": {"interpreted_room": "IT Room", "phrases": ["COMPUTER ROOM", "EDP ROOM", "IT ROOM", "DATA ROOM"], "keywords": ["COMPUTER", "EDP", "IT", "DATA"], "priority": 48},
    "ESCAPE_ROUTE": {"interpreted_room": "Escape Route", "phrases": ["ESCAPE ROUTE", "CORRIDOR", "PASSAGE", "LOBBY"], "keywords": ["ESCAPE", "CORRIDOR", "PASSAGE", "LOBBY"], "priority": 50},
    "WASHROOM_TOILET_WC": {"interpreted_room": "Washroom", "phrases": ["WASHROOM", "TOILET", "WC", "RESTROOM", "BATHROOM"], "keywords": ["WASHROOM", "TOILET", "WC", "RESTROOM", "BATHROOM"], "priority": 53},
    "BOILER_GENERATOR_TURBINE_FURNACE": {"interpreted_room": "Heavy Mech/Generator", "phrases": ["BOILER ROOM", "DG ROOM", "GENERATOR", "OVEN"], "keywords": ["BOILER", "DG", "GENERATOR", "OVEN", "TURBINE", "FURNACE", "KILN"], "priority": 54},
    "KITCHEN_PANTRY": {"interpreted_room": "Kitchen/Pantry", "phrases": ["KITCHEN", "PANTRY", "FOOD PREP"], "keywords": ["KITCHEN", "PANTRY"], "priority": 55},
    "DEDICATED_ELECTRICAL_ROOM": {"interpreted_room": "Electrical Room", "phrases": ["ELECTRICAL ROOM", "PANEL ROOM", "SWITCH ROOM", "TRANSFORMER ROOM"], "keywords": ["ELECTRICAL", "PANEL", "SWITCHGEAR", "TRANSFORMER", "ELEC", "ELECT", "UPS", "BATTERY"], "priority": 999},
}

# Mapping from rule-ID to hazard type.
_RULE_ID_TO_HAZARD = {
    "DEDICATED_ELECTRICAL_ROOM": HAZARD_NONE,
    "BOILER_GENERATOR_TURBINE_FURNACE": HAZARD_HH,
    "STORE_FLAMMABLE_CONFINED": HAZARD_HH,
    "KITCHEN_PANTRY": HAZARD_OH,
    "GARAGE_REPAIR": HAZARD_OH,
    "PLANT_AREA": HAZARD_OH,
    "WASHROOM_TOILET_WC": HAZARD_WASHROOM,
    "GENERIC_NORMAL_ROOM": HAZARD_LH,
    "COMPUTER_EDP_ROOM": HAZARD_LH,
    "ESCAPE_ROUTE": HAZARD_LH,
    "MANUAL_REVIEW": HAZARD_LH,
}

# Rule-based sprinkler geometry constraints by hazard type.
_HAZARD_PARAMS = {
    HAZARD_HH: {"max_area": 9.0, "max_spacing": 3.75, "min_spacing": 1.8, "max_wall": 1.875},
    HAZARD_OH: {"max_area": 12.0, "max_spacing": 4.5, "min_spacing": 1.8, "max_wall": 2.25},
    HAZARD_LH: {"max_area": 21.0, "max_spacing": 4.5, "min_spacing": 1.8, "max_wall": 2.25},
}

_VALID_RULE_IDS = list(ROOM_RULES.keys()) + ["MANUAL_REVIEW"]
_RULE_CATALOG_FOR_LLM = [
    {"rule_id": k, "interpreted_room": v["interpreted_room"], "sample_labels": v["phrases"][:3]}
    for k, v in ROOM_RULES.items()
]
_GEMINI_LABEL_CACHE: Dict[str, str] = {}

_FIRE_SAFETY_RULES = """
Here is the comprehensive list of exact text labels for rooms, occupancies, and areas categorized by the placement rules for sprinklers and piping.

1. Heat Detectors CANNOT be placed / Smoke Detectors CAN be placed
Escape Routes, Circulation Areas, Computer / EDP Centres, Electronic Equipment Rooms, Slow-burning / Air-conditioned premises, Archives, High-value Libraries.

2. Heat Detectors CAN be placed / Smoke Detectors CANNOT or are UNSUITABLE
Kitchens, Pantries, Boiler Rooms, DG (Diesel Generator) Sets, Generator Enclosures, Turbine Enclosures, Oven and Furnace Areas, Garages, Repair Shops, Battery Rooms, Store Areas.

3. Sprinklers SHOULD NOT be placed (Obligatory Exceptions - Strictly Prohibited)
Dedicated Electrical Equipment Rooms (Only if dry-type equipment, 120-min fire-rated enclosure, cable coated, and zero storage).

4. Sprinklers Optional (Optional Exceptions - Can be omitted)
Stairs (if fire separated), Spaces below stair headings, Lift Wells (if fire separated), Washrooms, Toilets, and WCs (Area less than 5 m²).
"""

_GEMINI_SYSTEM_PROMPT = f"""
You are an expert MEP and Fire Safety Engineer AI.
Your task is NOT to invent new fire-safety categories. Map EACH CAD label to EXACTLY ONE fixed rule_id.

Important rules:
1. Expand abbreviations where reasonable.
2. If the label is dimension text, coordinates, sheet references, or you are unsure of the abbreviation, return "MANUAL_REVIEW".
3. If the label is an ordinary room and does not clearly fall into an exception, return "GENERIC_NORMAL_ROOM".
4. Return exactly one item for every input label in the same order.

Rulebook:
{_FIRE_SAFETY_RULES}
"""

# DXF layers
DXF_LAYER_SPRINKLER = "AI_FIRE_SPRINKLERS"
DXF_LAYER_PIPES = "AI_FIRE_PIPES"
DXF_LAYER_SOURCE = "AI_FIRE_SOURCE"

# Labels used to detect pipe source locations inside the DXF
SOURCE_LABELS = ["FHC", "PL-Service Water", "PL_Waste Pipe", "Sprinkler"]

# Per-diameter colours (RGB) — must mirror PIPE_DIAMETER_COLOR_HEX in the frontend.
PIPE_DIAMETER_COLORS_RGB: dict[int, tuple[int, int, int]] = {
    20:  (139, 92, 246),   # violet
    25:  (220, 38, 38),    # red
    32:  (217, 119, 6),    # amber
    40:  (22, 163, 74),    # green
    50:  (37, 99, 235),    # blue
    65:  (147, 51, 234),   # purple
    80:  (234, 88, 12),    # orange
    100: (8, 145, 178),    # cyan
    125: (219, 39, 119),   # pink
    150: (120, 113, 108),  # stone
    200: (100, 116, 139),  # slate
}


def _color_for_pipe_diameter(d_mm: float) -> tuple[int, int, int]:
    """Return the RGB colour tuple for the given pipe diameter (mm)."""
    for threshold in sorted(PIPE_DIAMETER_COLORS_RGB):
        if d_mm <= threshold:
            return PIPE_DIAMETER_COLORS_RGB[threshold]
    return PIPE_DIAMETER_COLORS_RGB[200]


def _set_runtime_config(
    spacing_m: float,
    wall_buffer_m: float,
    world_to_m: float,
):
    global SPRINKLER_SPACING_M, WALL_BUFFER_M, WORLD_TO_M
    SPRINKLER_SPACING_M = float(spacing_m)
    WALL_BUFFER_M = float(wall_buffer_m)
    WORLD_TO_M = float(world_to_m)


def _normalize_label_for_match(text: str) -> str:
    s = str(text or "").upper()
    s = s.replace("\\P", " ")
    s = re.sub(r"[^A-Z0-9\s]", " ", s)
    s = re.sub(r"\s+", " ", s).strip()
    return s


def _merge_room_label_text(room: Dict) -> str:
    candidates = [
        room.get("label"),
        room.get("label_text"),
        room.get("name"),
    ]
    label_texts = room.get("label_texts")
    if isinstance(label_texts, list):
        candidates.extend(label_texts)

    return " ".join(_normalize_label_for_match(c) for c in candidates if c).strip()


def _rule_id_to_hazard(rule_id: str) -> str:
    """Map a rule-ID (or MANUAL_REVIEW) to a hazard type string."""
    return _RULE_ID_TO_HAZARD.get(rule_id, HAZARD_LH)


# ──────────────────────────────────────────────────────────────────
# DXF text extraction & spatial room assignment
# ──────────────────────────────────────────────────────────────────
def _text_cleanup(text: str) -> str:
    text = str(text).replace("\n", " ").replace("\r", " ").replace("\\P", " ").strip()
    return " ".join(text.split())


def _bbox_to_dict(bb) -> dict | None:
    if bb is None or not getattr(bb, "has_data", False):
        return None
    return {
        "xmin": float(bb.extmin.x), "ymin": float(bb.extmin.y),
        "xmax": float(bb.extmax.x), "ymax": float(bb.extmax.y),
    }


def _center_of_bbox(b: dict) -> Tuple[float, float]:
    return (b["xmin"] + b["xmax"]) / 2.0, (b["ymin"] + b["ymax"]) / 2.0


def extract_text_lines_world(dxf_path: str) -> List[Dict]:
    """Extract all text entities from DXF with world coordinates.

    Uses MTextExplode to convert MTEXT → TEXT, collects bbox-based centres,
    and clusters nearby text fragments into label groups.

    Returns list of ``{"label": str, "x": float, "y": float}`` dicts.
    """
    if not _EZDXF_OK or not os.path.exists(dxf_path):
        return []

    try:
        doc, _ = _ezdxf_recover.readfile(dxf_path)
    except Exception as e:
        logger.warning("extract_text_lines_world: could not read %s: %s", dxf_path, e)
        return []

    msp = doc.modelspace()

    # Explode MTEXT into simple TEXT entities for reliable bbox calculation.
    mtexts = list(msp.query("MTEXT"))
    if mtexts:
        try:
            with _MTextExplode(msp) as xpl:
                for mt in mtexts:
                    try:
                        xpl.explode(mt, destroy=True)
                    except Exception:
                        pass
        except Exception:
            pass

    raw_items: list = []

    def _process(entity, source_type: str = "TEXT"):
        txt = _text_cleanup(
            entity.plain_text() if hasattr(entity, "plain_text")
            else getattr(entity.dxf, "text", "")
        )
        if not txt:
            return
        try:
            bb = _ezbbox.extents([entity], fast=False)
            bd = _bbox_to_dict(bb)
            if bd is None:
                return
            cx, cy = _center_of_bbox(bd)
            raw_items.append({"text": txt, "cx": cx, "cy": cy})
        except Exception:
            pass

    for e in msp.query("TEXT"):
        _process(e, "TEXT")
    for e in msp.query("MTEXT"):
        _process(e, "MTEXT_FALLBACK")
    for insert in msp.query("INSERT"):
        try:
            for vent in insert.virtual_entities():
                if vent.dxftype() in ("TEXT", "MTEXT"):
                    _process(vent, "BLOCK_TEXT")
        except Exception:
            pass

    if not raw_items:
        return []

    # Sort top-to-bottom, left-to-right and cluster nearby fragments.
    raw_items.sort(key=lambda e: (-e["cy"], e["cx"]))
    max_dist = 1500  # world units (mm typically) – cluster radius
    clustered: List[Dict] = []
    current: list = [raw_items[0]]

    for item in raw_items[1:]:
        last = current[-1]
        if math.hypot(item["cx"] - last["cx"], item["cy"] - last["cy"]) < max_dist:
            current.append(item)
        else:
            clustered.append({
                "label": " ".join(e["text"] for e in current),
                "x": sum(e["cx"] for e in current) / len(current),
                "y": sum(e["cy"] for e in current) / len(current),
            })
            current = [item]

    clustered.append({
        "label": " ".join(e["text"] for e in current),
        "x": sum(e["cx"] for e in current) / len(current),
        "y": sum(e["cy"] for e in current) / len(current),
    })

    logger.info("extract_text_lines_world: %d text clusters from %s", len(clustered), dxf_path)
    return clustered


def _assign_dxf_text_to_rooms(
    rooms: List[Dict],
    dxf_text_clusters: List[Dict],
    proximity_threshold: float = 1500.0,
) -> List[List[Dict]]:
    """Spatially assign DXF text clusters to room polygons.

    Two-pass: first containment, then nearest-proximity fallback within
    *proximity_threshold* world units.

    Returns a list parallel to *rooms* where each element is a list of
    matched text clusters.
    """
    room_polys: List[Polygon | None] = []
    for room in rooms:
        poly = _parse_polygon(room.get("polygon_world"))
        room_polys.append(poly)

    assigned: List[List[Dict]] = [[] for _ in rooms]

    # Track which clusters got assigned via containment.
    cluster_assigned = [False] * len(dxf_text_clusters)

    # Pass 1: strict containment
    for ci, cluster in enumerate(dxf_text_clusters):
        pt = Point(cluster["x"], cluster["y"])
        for ri, poly in enumerate(room_polys):
            if poly is not None and poly.contains(pt):
                assigned[ri].append(cluster)
                cluster_assigned[ci] = True
                break

    # Pass 2: proximity fallback for unassigned clusters
    for ci, cluster in enumerate(dxf_text_clusters):
        if cluster_assigned[ci]:
            continue
        pt = Point(cluster["x"], cluster["y"])
        best_dist = proximity_threshold
        best_ri = -1
        for ri, poly in enumerate(room_polys):
            if poly is None:
                continue
            dist = poly.distance(pt)
            if dist < best_dist:
                best_dist = dist
                best_ri = ri
        if best_ri >= 0:
            assigned[best_ri].append(cluster)

    return assigned


def _classify_room_hazards_with_dxf_text(
    rooms: List[Dict],
    dxf_path: str | None = None,
) -> List[str]:
    """Classify rooms using DXF text extraction and Gemini rule-ID mapping.

    1. Extract all text from DXF (MTEXT exploded → TEXT → bbox centres).
    2. Spatially assign text clusters to room polygons (containment then proximity).
    3. Build one normalized label string per room from room labels + assigned text.
    4. Classify with Gemini (with cache), then map final rule-ID → hazard type.
    """
    n = len(rooms)
    hazards: List[str] = [HAZARD_LH] * n

    # Step 1: Extract DXF text
    dxf_text_clusters: List[Dict] = []
    if dxf_path and os.path.exists(dxf_path):
        dxf_text_clusters = extract_text_lines_world(dxf_path)

    if dxf_text_clusters:
        # Step 2: Spatial assignment
        room_text = _assign_dxf_text_to_rooms(rooms, dxf_text_clusters)

        unknown_labels: List[str] = []
        unknown_indices: List[int] = []
        combined_labels_by_index: Dict[int, str] = {}

        for i in range(n):
            # Combine room's own labels AND DXF text assigned to it.
            merged_own = _merge_room_label_text(rooms[i])
            all_labels = [merged_own] if merged_own else []
            for cluster in room_text[i]:
                norm = _normalize_label_for_match(cluster["label"])
                if norm:
                    all_labels.append(norm)

            if not all_labels:
                hazards[i] = HAZARD_LH
                continue

            combined = " ".join(all_labels)
            combined_labels_by_index[i] = combined

            # Check cache first; if not present, batch for Gemini.
            cached = _GEMINI_LABEL_CACHE.get(combined)
            if cached:
                hazards[i] = cached
            else:
                unknown_labels.append(combined)
                unknown_indices.append(i)

        # Step 4: Gemini classification
        if unknown_labels:
            gemini_map = _classify_unknown_labels_with_gemini(sorted(set(unknown_labels)))
            for idx in unknown_indices:
                combined = combined_labels_by_index.get(idx, "")
                gem_rule = gemini_map.get(combined)
                if gem_rule:
                    hazard = _rule_id_to_hazard(gem_rule)
                    hazards[idx] = hazard
                    _GEMINI_LABEL_CACHE[combined] = hazard
                else:
                    hazards[idx] = HAZARD_LH
                    _GEMINI_LABEL_CACHE[combined] = HAZARD_LH
    else:
        # No DXF text available — fall back to room dict labels only.
        hazards = _classify_room_hazards(rooms)

    return hazards


def _gemini_enabled_for_hazards() -> bool:
    if not _GENAI_OK:
        return False
    api_key = os.getenv("GEMINI_API_KEY", "").strip()
    return bool(api_key)


def _classify_unknown_labels_with_gemini(labels: List[str]) -> Dict[str, str]:
    """Classify unknown labels via Gemini; returns map label -> rule_id."""
    if not labels or not _gemini_enabled_for_hazards():
        return {l: "MANUAL_REVIEW" for l in labels}

    try:
        import json as _json
        client = genai.Client(api_key=os.getenv("GEMINI_API_KEY", "").strip())
        model = os.getenv("GEMINI_MODEL", "gemini-2.5-flash-lite").strip() or "gemini-2.5-flash-lite"

        payload = {
            "valid_rule_ids": _VALID_RULE_IDS,
            "rule_catalog": _RULE_CATALOG_FOR_LLM,
            "labels": [{"original_label": l, "normalized_label": _normalize_label_for_match(l)} for l in labels],
        }

        # Build config – use structured schema when pydantic is available.
        config_kwargs: Dict = {
            "system_instruction": _GEMINI_SYSTEM_PROMPT,
            "temperature": 0,
            "response_mime_type": "application/json",
        }
        if _PYDANTIC_OK:
            class _GeminiLabelDecision(_BaseModel):
                original_label: str
                mapped_rule_id: str
                interpreted_room: str

            class _GeminiBatchDecision(_BaseModel):
                items: list[_GeminiLabelDecision]

            config_kwargs["response_schema"] = _GeminiBatchDecision

        config = _genai_types.GenerateContentConfig(**config_kwargs)

        response = client.models.generate_content(
            model=model,
            contents=_json.dumps(payload),
            config=config,
        )

        raw = (response.text or "").strip()
        data = _json.loads(raw)
        items = data.get("items", []) if isinstance(data, dict) else []

        out: Dict[str, str] = {}
        for item in items:
            label = item.get("original_label", "")
            rule_id = str(item.get("mapped_rule_id", "MANUAL_REVIEW")).upper().strip()
            if not label:
                continue
            if rule_id not in _VALID_RULE_IDS:
                rule_id = "MANUAL_REVIEW"
            out[label] = rule_id
        return out
    except Exception as e:
        logger.warning("Gemini rule-id classification failed: %s", e)
        return {l: "MANUAL_REVIEW" for l in labels}


def _classify_room_hazards(rooms: List[Dict]) -> List[str]:
    """Classify room hazards from labels using cache + Gemini rule-ID mapping."""
    hazards: List[str] = [HAZARD_LH] * len(rooms)
    unknown_labels: List[str] = []
    unknown_indices: List[int] = []

    for i, room in enumerate(rooms):
        merged = _merge_room_label_text(room)
        if not merged:
            hazards[i] = HAZARD_LH
            continue

        cached = _GEMINI_LABEL_CACHE.get(merged)
        if cached:
            hazards[i] = cached
            continue

        unknown_labels.append(merged)
        unknown_indices.append(i)

    gemini_map = _classify_unknown_labels_with_gemini(sorted(set(unknown_labels))) if unknown_labels else {}

    for idx in unknown_indices:
        merged = _merge_room_label_text(rooms[idx])
        gem_rule = gemini_map.get(merged)
        if gem_rule:
            hazard = _rule_id_to_hazard(gem_rule)
            hazards[idx] = hazard
            _GEMINI_LABEL_CACHE[merged] = hazard
        else:
            hazards[idx] = HAZARD_LH
            _GEMINI_LABEL_CACHE[merged] = HAZARD_LH

    return hazards


def _hazard_params(hazard_type: str) -> Dict[str, float]:
    return _HAZARD_PARAMS.get(hazard_type, _HAZARD_PARAMS[HAZARD_LH])


# ──────────────────────────────────────────────────────────────────
# DXF source detection
# ──────────────────────────────────────────────────────────────────
def detect_sources_from_dxf(
    dxf_path: str,
    labels: List[str] | None = None,
) -> List[Tuple[float, float]]:
    """Scan the DXF for text, blocks or layers matching *labels* and return
    world coordinates of each source location."""
    if labels is None:
        labels = SOURCE_LABELS

    if not _EZDXF_OK or not os.path.exists(dxf_path):
        return []

    labels_lower = [l.lower() for l in labels]
    detected: List[Tuple[float, float]] = []

    try:
        doc = ezdxf.readfile(dxf_path)
        msp = doc.modelspace()

        for entity in msp.query("TEXT MTEXT"):
            text_val = ""
            if entity.dxftype() == "TEXT":
                text_val = entity.dxf.text
            elif entity.dxftype() == "MTEXT":
                text_val = entity.text

            text_lower = text_val.lower()
            layer_lower = entity.dxf.layer.lower()
            if any(l in text_lower for l in labels_lower) or any(l in layer_lower for l in labels_lower):
                pt = entity.dxf.insert
                detected.append((float(pt.x), float(pt.y)))

        for entity in msp.query("INSERT"):
            name_lower = entity.dxf.name.lower()
            layer_lower = entity.dxf.layer.lower()
            if any(l in name_lower for l in labels_lower) or any(l in layer_lower for l in labels_lower):
                pt = entity.dxf.insert
                detected.append((float(pt.x), float(pt.y)))

    except Exception as e:
        logger.warning("detect_sources_from_dxf failed: %s", e)

    logger.info("detect_sources_from_dxf found=%d", len(detected))
    return detected


# ──────────────────────────────────────────────────────────────────
# Geometry helpers  (shared with place_detectors)
# ──────────────────────────────────────────────────────────────────
def _parse_polygon(poly_coords):
    if not poly_coords or len(poly_coords) < 3:
        return None
    poly = Polygon(poly_coords)
    if not poly.is_valid:
        poly = make_valid(poly)
    if poly.geom_type == "MultiPolygon":
        poly = max(poly.geoms, key=lambda p: p.area)
    elif poly.geom_type == "GeometryCollection":
        polygons = [g for g in poly.geoms if g.geom_type in ("Polygon", "MultiPolygon")]
        if not polygons:
            return None
        flat = []
        for p in polygons:
            if p.geom_type == "MultiPolygon":
                flat.extend(p.geoms)
            else:
                flat.append(p)
        poly = max(flat, key=lambda p: p.area)
    return poly


def _get_longest_wall_angle(poly):
    coords = list(poly.exterior.coords)
    max_len, best_angle = 0.0, 0.0
    for i in range(len(coords) - 1):
        p1, p2 = coords[i], coords[i + 1]
        dx, dy = p2[0] - p1[0], p2[1] - p1[1]
        length = math.hypot(dx, dy)
        if length > max_len:
            max_len, best_angle = length, math.atan2(dy, dx)
    return best_angle, poly.centroid.coords[0]


def _get_reflex_vertices(poly):
    coords = list(poly.exterior.coords)
    if LinearRing(coords).is_ccw:
        coords = coords[::-1]
    reflex_data = []
    n = len(coords) - 1
    min_len_world = MIN_WALL_LENGTH_M / WORLD_TO_M
    for i in range(n):
        p_prev, p_curr, p_next = coords[i - 1], coords[i], coords[(i + 1) % n]
        v1x, v1y = p_curr[0] - p_prev[0], p_curr[1] - p_prev[1]
        v2x, v2y = p_next[0] - p_curr[0], p_next[1] - p_curr[1]
        if math.hypot(v1x, v1y) < min_len_world or math.hypot(v2x, v2y) < min_len_world:
            continue
        if (v1x * v2y) - (v1y * v2x) > 1e-4:
            reflex_data.append((p_curr, p_prev, p_next))
    return reflex_data


def _split_at_reflex_vertex(poly, reflex_data):
    B, A, C = reflex_data
    x, y = B
    directions = []
    for vx, vy in [(B[0] - A[0], B[1] - A[1]), (B[0] - C[0], B[1] - C[1])]:
        if abs(vx) > abs(vy):
            directions.append((math.copysign(1.0, vx), 0.0))
        else:
            directions.append((0.0, math.copysign(1.0, vy)))

    minx, miny, maxx, maxy = poly.bounds
    max_dist = max(maxx - minx, maxy - miny) + 1.0
    best_cut, min_dist, boundary = None, float("inf"), poly.boundary

    for dx, dy in directions:
        ray = LineString([(x, y), (x + dx * max_dist, y + dy * max_dist)])
        intersection = boundary.intersection(ray)
        if intersection.is_empty:
            continue
        points = []
        if intersection.geom_type == "Point":
            points.append(intersection)
        elif intersection.geom_type == "MultiPoint":
            points.extend(intersection.geoms)
        elif intersection.geom_type == "GeometryCollection":
            for geom in intersection.geoms:
                if geom.geom_type == "Point":
                    points.append(geom)

        for pt in points:
            dist = Point(B).distance(pt)
            if 1e-3 < dist < min_dist:
                cut_line = LineString([B, (pt.x, pt.y)])
                if poly.contains(cut_line.centroid):
                    min_dist = dist
                    best_cut = LineString([
                        (x - dx * 0.1, y - dy * 0.1),
                        (pt.x + dx * 0.1, pt.y + dy * 0.1),
                    ])

    if best_cut is not None:
        try:
            res = split(poly, best_cut)
            polys = [g for g in res.geoms if g.geom_type in ("Polygon", "MultiPolygon")]
            if len(polys) > 1:
                return polys
        except Exception:
            pass
    return [poly]


def _decompose_recursive(poly):
    if poly.area < (MIN_REGION_AREA_M2 / (WORLD_TO_M ** 2)):
        return [poly]
    reflex_data_list = _get_reflex_vertices(poly)
    if not reflex_data_list:
        return [poly]
    for r_data in reflex_data_list:
        parts = _split_at_reflex_vertex(poly, r_data)
        if len(parts) > 1:
            out = []
            for p in parts:
                out.extend(_decompose_recursive(p))
            return out
    return [poly]


# ──────────────────────────────────────────────────────────────────
# Sprinkler grid placement
# ──────────────────────────────────────────────────────────────────
def _get_grid_points(poly: Polygon, hazard_type: str = HAZARD_LH):
    params = _hazard_params(hazard_type)
    angle_rad, (cx, cy) = _get_longest_wall_angle(poly)
    angle_deg = math.degrees(angle_rad)
    rot_poly = rotate(poly, -angle_deg, origin=(cx, cy))
    minx, miny, maxx, maxy = rot_poly.bounds
    width, height = maxx - minx, maxy - miny

    # Dimension filter: skip if either dimension is less than 1 metre.
    if width < (1.0 / WORLD_TO_M) or height < (1.0 / WORLD_TO_M):
        return []

    # Enforce user-configured spacing (default 3m) as the grid step.
    # We intentionally do not tighten by max-area here, because that can
    # force spacing below 3m. For this mode, 3m spacing takes precedence.
    target_spacing_world = SPRINKLER_SPACING_M / WORLD_TO_M
    max_wall_world = params["max_wall"] / WORLD_TO_M

    def _grid_1d(dim: float, spacing: float, wall: float) -> tuple[int, float, float]:
        """Return (n, step, start_offset) for a 1-D sprinkler grid.

        Places sprinklers at exactly *spacing* apart.  The start offset is
        chosen so that the distance from each wall to the nearest sprinkler
        is <= *wall*.  Minimum n formula:
            n = 1 + ceil(max(0, dim - 2*wall) / spacing)
        which guarantees the centred offset fits within *wall*.
        """
        if dim <= 0:
            return 1, 0.0, 0.0
        n = max(1, math.ceil(max(0.0, dim - 2.0 * wall) / spacing) + 1)
        offset = (dim - (n - 1) * spacing) / 2.0
        if offset < 0:
            # spacing > dim: single centred sprinkler
            return 1, 0.0, dim / 2.0
        step = spacing if n > 1 else 0.0
        return n, step, offset

    nx_pts, step_x, start_x = _grid_1d(width, target_spacing_world, max_wall_world)
    ny_pts, step_y, start_y = _grid_1d(height, target_spacing_world, max_wall_world)

    points = []
    for i in range(nx_pts):
        for j in range(ny_pts):
            lx = minx + start_x + i * step_x
            ly = miny + start_y + j * step_y
            p = Point(lx, ly)
            if rot_poly.contains(p):
                world_p = rotate(p, angle_deg, origin=(cx, cy))
                points.append((world_p.x, world_p.y))
    return points


def _process_room(room_poly: Polygon, hazard_type: str = HAZARD_LH):
    """Returns ``(points, regions, bboxes)``."""
    points: List[Tuple[float, float]] = []
    regions: List[Polygon] = []
    bboxes: List[Polygon] = []
    tolerance_world = NOISE_TOLERANCE_M / WORLD_TO_M
    clean_poly = room_poly.simplify(tolerance_world, preserve_topology=True)

    if not clean_poly.is_valid:
        clean_poly = make_valid(clean_poly)
        if clean_poly.geom_type == "GeometryCollection":
            polys = [g for g in clean_poly.geoms if g.geom_type in ("Polygon", "MultiPolygon")]
            if polys:
                clean_poly = max(polys, key=lambda p: p.area)

    sub_polys = _decompose_recursive(clean_poly)
    min_area_world = MIN_REGION_AREA_M2 / (WORLD_TO_M ** 2)

    for poly in sub_polys:
        if poly.area < min_area_world:
            continue
        regions.append(poly)

        # Compute rotated bounding box for visualization.
        angle_rad, (cx, cy) = _get_longest_wall_angle(poly)
        angle_deg = math.degrees(angle_rad)
        rot_poly = rotate(poly, -angle_deg, origin=(cx, cy))
        local_bbox = box(*rot_poly.bounds)
        world_bbox = rotate(local_bbox, angle_deg, origin=(cx, cy))
        bboxes.append(world_bbox)

        # NONE hazard → record region/bbox but place zero sprinklers.
        if hazard_type == HAZARD_NONE:
            continue

        grid = _get_grid_points(poly, hazard_type=hazard_type)
        if not grid:
            rep = poly.representative_point()
            grid = [(rep.x, rep.y)]
        points.extend(grid)
    return points, regions, bboxes


# ──────────────────────────────────────────────────────────────────
# Pipe sizing
# ──────────────────────────────────────────────────────────────────
def get_pipe_diameter_label(num_sprinklers: int) -> str:
    if num_sprinklers <= 2:
        return "25mm"
    elif num_sprinklers <= 3:
        return "32mm"
    elif num_sprinklers <= 5:
        return "40mm"
    elif num_sprinklers <= 10:
        return "50mm"
    elif num_sprinklers <= 30:
        return "65mm"
    elif num_sprinklers <= 60:
        return "80mm"
    return "90mm"


def _get_base_size_idx(num_sprinklers: int) -> int:
    """Return a PIPE_SIZES index for the downstream sprinkler count."""
    if num_sprinklers <= 2:
        return 0
    elif num_sprinklers <= 3:
        return 1
    elif num_sprinklers <= 5:
        return 2
    elif num_sprinklers <= 10:
        return 3
    elif num_sprinklers <= 30:
        return 4
    elif num_sprinklers <= 60:
        return 5
    return 6


def _diameter_label_to_mm(label: str) -> int:
    m = re.search(r"(\d+)", str(label))
    return int(m.group(1)) if m else 25


def _ensure_min_diameter(label: str, min_mm: int) -> str:
    curr = _diameter_label_to_mm(label)
    mm = max(curr, int(min_mm))
    return f"{mm}mm"


# ──────────────────────────────────────────────────────────────────
# Orthogonal pipe routing – Manhattan header + branches
# ──────────────────────────────────────────────────────────────────
def _get_merged_lines(coords: List[float], merge_dist_m: float = 0.5) -> List[float]:
    """Gap-based 1-D clustering for coordinate grouping.

    Consecutive *sorted* values within *merge_dist_m* of their predecessor
    belong to the same cluster.  Returns the mean of each cluster.  The
    default tolerance (0.5 m) merges sprinklers in the same row/column
    without chaining separate rows together.
    """
    if not coords:
        return []
    gap = merge_dist_m / WORLD_TO_M
    sc = sorted(coords)
    groups: list = [[sc[0]]]
    for v in sc[1:]:
        if v - groups[-1][-1] <= gap:
            groups[-1].append(v)
        else:
            groups.append([v])
    return [sum(g) / len(g) for g in groups]


def route_pipes(
    sprinklers: List[Tuple[float, float]],
    source: Tuple[float, float],
    branch_spacing: float | None = None,
    valid_regions: List[Polygon] | None = None,
) -> Tuple[List[Tuple[Tuple[Tuple[float, float], Tuple[float, float]], str]], List[Tuple[float, float]]]:
    """Orthogonal pipe routing: straight header → straight branches through sprinklers.

    Algorithm
    ---------
    1. **Header**: one straight horizontal/vertical pipe through the floor
       plan at the median sprinkler row/column.  Source connects to it via
       an L-turn.
    2. **Branches**: perpendicular straight pipes placed at each sprinkler
       column/row, running directly through the sprinklers.
    3. **Merge close branches**: if two branch lines are < 1.8 m apart,
       drop the one with fewer sprinklers and reconnect orphans to the
       nearest surviving branch.
    4. **Clip OOB pipes**: remove edges outside the floor plan and reconnect
       disconnected components via internal L-paths.
    5. BFS tree, subtree sizing, arm injection, labelling.

    Returns ``(pipe_segments, snapped_sprinklers)``.
    """
    if not sprinklers:
        return [], []

    safe_area = unary_union(valid_regions).buffer(1.0 / WORLD_TO_M) if valid_regions else None

    source = (round(source[0], 4), round(source[1], 4))
    original_sprinklers = [(round(s[0], 4), round(s[1], 4)) for s in sprinklers]
    xs = [s[0] for s in original_sprinklers]
    ys = [s[1] for s in original_sprinklers]
    is_horizontal_header = (max(xs) - min(xs)) >= (max(ys) - min(ys))

    CLOSE_BRANCH_M = 1.8
    close_gap = CLOSE_BRANCH_M / WORLD_TO_M

    G = nx.Graph()
    G.add_node(source)
    sprinkler_set = set(original_sprinklers)
    for s in original_sprinklers:
        G.add_node(s)

    # ── 1. GROUP SPRINKLERS INTO LINES (actual positions, not grid) ──
    # Cluster sprinkler coordinates into rows/columns so branches align
    # with where sprinklers really are.

    if is_horizontal_header:
        # Header runs horizontally; branches run vertically at each column.
        col_xs = _get_merged_lines(xs)     # actual sprinkler column positions
        row_ys = _get_merged_lines(ys)     # for choosing header Y

        # Assign every sprinkler to its nearest column
        columns: Dict[float, List[Tuple[float, float]]] = {cx: [] for cx in col_xs}
        for s in original_sprinklers:
            best_cx = min(col_xs, key=lambda c: abs(c - s[0]))
            columns[best_cx].append(s)

        # ── 1a. MERGE CLOSE COLUMNS ──
        col_sorted = sorted(col_xs)
        i = 0
        while i < len(col_sorted) - 1:
            ca, cb = col_sorted[i], col_sorted[i + 1]
            if cb - ca < close_gap:
                # keep the column with more sprinklers
                if len(columns.get(ca, [])) <= len(columns.get(cb, [])):
                    drop, keep = ca, cb
                else:
                    drop, keep = cb, ca
                # move orphaned sprinklers to the survivor
                columns.setdefault(keep, []).extend(columns.pop(drop, []))
                col_sorted.remove(drop)
                # don't advance i — recheck against next neighbour
            else:
                i += 1
        col_xs = col_sorted

        # ── 2. HEADER – straight horizontal pipe at median Y ──
        sorted_rows = sorted(row_ys)
        n = len(sorted_rows)
        header_y = sorted_rows[n // 2] if n % 2 == 1 else (sorted_rows[n // 2 - 1] + sorted_rows[n // 2]) / 2.0

        # Header spans from leftmost to rightmost column
        header_pts = sorted(set([(cx, header_y) for cx in col_xs]), key=lambda p: p[0])
        for i in range(len(header_pts) - 1):
            G.add_edge(header_pts[i], header_pts[i + 1])

        # Source → header: L-turn to nearest header junction
        nearest_hj = min(header_pts, key=lambda h: abs(h[0] - source[0]) + abs(h[1] - source[1]))
        corner = (source[0], header_y)
        if source != corner:
            G.add_edge(source, corner)
        if corner != nearest_hj:
            # make sure the source stub also connects into the header line
            G.add_edge(corner, nearest_hj)

        # ── 3. BRANCHES – straight vertical pipes through sprinklers ──
        for cx in col_xs:
            col_sprs = columns.get(cx, [])
            header_jn = (cx, header_y)

            # All Y values on this branch (header junction + sprinkler junctions)
            branch_y_vals = [header_y]
            for s in col_sprs:
                branch_y_vals.append(s[1])
            branch_y_vals = sorted(set(branch_y_vals))

            # Straight vertical pipe through all junctions
            for i in range(len(branch_y_vals) - 1):
                G.add_edge((cx, branch_y_vals[i]), (cx, branch_y_vals[i + 1]))

            # Short horizontal arms for sprinklers whose X differs from cx
            for s in col_sprs:
                pipe_pt = (cx, s[1])
                if s != pipe_pt:
                    G.add_edge(pipe_pt, s)

    else:
        # Header runs vertically; branches run horizontally at each row.
        row_ys = _get_merged_lines(ys)
        col_xs = _get_merged_lines(xs)

        rows: Dict[float, List[Tuple[float, float]]] = {ry: [] for ry in row_ys}
        for s in original_sprinklers:
            best_ry = min(row_ys, key=lambda r: abs(r - s[1]))
            rows[best_ry].append(s)

        # ── 1a. MERGE CLOSE ROWS ──
        row_sorted = sorted(row_ys)
        i = 0
        while i < len(row_sorted) - 1:
            ra, rb = row_sorted[i], row_sorted[i + 1]
            if rb - ra < close_gap:
                if len(rows.get(ra, [])) <= len(rows.get(rb, [])):
                    drop, keep = ra, rb
                else:
                    drop, keep = rb, ra
                rows.setdefault(keep, []).extend(rows.pop(drop, []))
                row_sorted.remove(drop)
            else:
                i += 1
        row_ys = row_sorted

        # ── 2. HEADER – straight vertical pipe at median X ──
        sorted_cols = sorted(col_xs)
        n = len(sorted_cols)
        header_x = sorted_cols[n // 2] if n % 2 == 1 else (sorted_cols[n // 2 - 1] + sorted_cols[n // 2]) / 2.0

        header_pts = sorted(set([(header_x, ry) for ry in row_ys]), key=lambda p: p[1])
        for i in range(len(header_pts) - 1):
            G.add_edge(header_pts[i], header_pts[i + 1])

        nearest_hj = min(header_pts, key=lambda h: abs(h[0] - source[0]) + abs(h[1] - source[1]))
        corner = (header_x, source[1])
        if source != corner:
            G.add_edge(source, corner)
        if corner != nearest_hj:
            G.add_edge(corner, nearest_hj)

        # ── 3. BRANCHES – straight horizontal pipes through sprinklers ──
        for ry in row_ys:
            row_sprs = rows.get(ry, [])
            header_jn = (header_x, ry)

            branch_x_vals = [header_x]
            for s in row_sprs:
                branch_x_vals.append(s[0])
            branch_x_vals = sorted(set(branch_x_vals))

            for i in range(len(branch_x_vals) - 1):
                G.add_edge((branch_x_vals[i], ry), (branch_x_vals[i + 1], ry))

            for s in row_sprs:
                pipe_pt = (s[0], ry)
                if s != pipe_pt:
                    G.add_edge(pipe_pt, s)

    # ── 4. CLIP OUT-OF-BOUNDS PIPES & RECONNECT ──────────────────
    if safe_area:
        for u, v in list(G.edges()):
            seg = LineString([u, v])
            if not safe_area.contains(seg) and not safe_area.covers(seg):
                G.remove_edge(u, v)

        for node in list(G.nodes()):
            if node != source and node not in sprinkler_set and G.degree(node) == 0:
                G.remove_node(node)

        comps = list(nx.connected_components(G))
        comps.sort(key=lambda c: 0 if source in c else 1)

        while len(comps) > 1:
            main = comps[0]
            best_dist = float("inf")
            best_edges: list = []
            best_ci = -1

            for ci in range(1, len(comps)):
                for uu in main:
                    for vv in comps[ci]:
                        d = abs(uu[0] - vv[0]) + abs(uu[1] - vv[1])
                        if d >= best_dist:
                            continue
                        c1 = (vv[0], uu[1])
                        c2 = (uu[0], vv[1])
                        p1 = LineString([uu, c1, vv])
                        p2 = LineString([uu, c2, vv])
                        if safe_area.contains(p1) or safe_area.covers(p1):
                            best_dist, best_edges, best_ci = d, [(uu, c1), (c1, vv)], ci
                        elif safe_area.contains(p2) or safe_area.covers(p2):
                            best_dist, best_edges, best_ci = d, [(uu, c2), (c2, vv)], ci

            if best_edges:
                for e in best_edges:
                    if e[0] != e[1]:
                        G.add_edge(*e)
                comps[0] = comps[0].union(comps[best_ci])
                comps.pop(best_ci)
            else:
                fb_dist = float("inf")
                fb_edges: list = []
                fb_ci = -1
                for ci in range(1, len(comps)):
                    for uu in main:
                        for vv in comps[ci]:
                            d = Point(uu).distance(Point(vv))
                            if d < fb_dist:
                                fb_dist = d
                                corner = (vv[0], uu[1])
                                fb_edges = [(uu, corner), (corner, vv)]
                                fb_ci = ci
                if fb_edges:
                    for e in fb_edges:
                        if e[0] != e[1]:
                            G.add_edge(*e)
                    comps[0] = comps[0].union(comps[fb_ci])
                    comps.pop(fb_ci)
                else:
                    break

    # ── 2. BFS tree from source ───────────────────────────────────
    try:
        directed_tree = nx.bfs_tree(G, source=source)
    except Exception:
        return [], original_sprinklers

    # ── 3. Map nodes to room regions ──────────────────────────────
    node_to_region: Dict = {}
    if valid_regions:
        eps = 0.15 / WORLD_TO_M
        for node in directed_tree.nodes():
            pt = Point(node[0], node[1])
            found = -1
            for i, reg in enumerate(valid_regions):
                if reg.buffer(eps).contains(pt):
                    found = i
                    break
            node_to_region[node] = found

    # ── 4. Initial flow (subtree sprinkler counts) ────────────────
    final_subtree_counts: Dict = {}
    for node in reversed(list(nx.topological_sort(directed_tree))):
        count = 1 if node in sprinkler_set else 0
        for child in directed_tree.successors(node):
            count += final_subtree_counts.get(child, 0)
        final_subtree_counts[node] = count

    # ── 5. Inject explicit arm pipes for large (>50 mm) mains ────
    # Add a short perpendicular arm as a *leaf* from the sprinkler
    # position.  The main pipe keeps running straight through the
    # sprinkler node — no edges are redirected, so no diagonals.
    LARGE_PIPE_THRESHOLD = 10
    arm_length = 0.4 / WORLD_TO_M
    tees_created: set = set()

    for s in list(sprinkler_set):
        load = final_subtree_counts.get(s, 0)
        if load > LARGE_PIPE_THRESHOLD:
            preds = list(directed_tree.predecessors(s))
            if preds:
                p = preds[0]
                dx, dy = s[0] - p[0], s[1] - p[1]
                is_horiz = abs(dx) > abs(dy)
                tee = (s[0], s[1] + arm_length) if is_horiz else (s[0] + arm_length, s[1])

                # Leaf arm — no rerouting of parent or children
                directed_tree.add_edge(s, tee)
                tees_created.add(tee)

                if s in node_to_region:
                    node_to_region[tee] = node_to_region[s]
                final_subtree_counts[tee] = 1

    # ── 6. Dynamically cascade room entries ───────────────────────
    node_size_idx = {n: _get_base_size_idx(final_subtree_counts.get(n, 0)) for n in directed_tree.nodes()}

    for node in reversed(list(nx.topological_sort(directed_tree))):
        idx = node_size_idx[node]
        for child in directed_tree.successors(node):
            child_idx = node_size_idx[child]
            if valid_regions:
                reg_u = node_to_region.get(node, -1)
                reg_v = node_to_region.get(child, -1)
                if reg_u != reg_v and reg_v != -1:
                    child_idx = max(child_idx, 1)
                    node_size_idx[child] = child_idx
            idx = max(idx, child_idx)
        node_size_idx[node] = idx

    # ── 7. Compile final segments with labels ─────────────────────
    final_segments: List[Tuple[Tuple[Tuple[float, float], Tuple[float, float]], str]] = []

    for u, v in directed_tree.edges():
        if final_subtree_counts.get(v, 0) > 0:
            idx = node_size_idx.get(v, 0)
            label = PIPE_SIZES[idx]

            if valid_regions:
                reg_u = node_to_region.get(u, -1)
                reg_v = node_to_region.get(v, -1)
                if reg_u != reg_v and reg_v != -1:
                    label = f"{label}"

            if v in tees_created:
                label = "25mm"

            final_segments.append(((u, v), label))

    return final_segments, original_sprinklers


# ──────────────────────────────────────────────────────────────────
# Visualization
# ──────────────────────────────────────────────────────────────────
def visualize_sprinkler_routing(
    all_regions: List[Polygon],
    all_points: List[Tuple[float, float]],
    all_pipes: list,
    source: Tuple[float, float],
    output_path: str,
    all_bboxes: List[Polygon] | None = None,
):
    if not all_regions and not all_points:
        return

    bounds_x = [p.bounds[0] for p in all_regions] + [p.bounds[2] for p in all_regions] + [source[0]]
    bounds_y = [p.bounds[1] for p in all_regions] + [p.bounds[3] for p in all_regions] + [source[1]]
    minx, maxx = min(bounds_x), max(bounds_x)
    miny, maxy = min(bounds_y), max(bounds_y)

    target_w = 2200
    world_w = max(1.0, maxx - minx)
    scale = target_w / world_w
    margin_px = 120
    w_px = max(400, min(int((maxx - minx) * scale) + 2 * margin_px, 4000))
    h_px = max(400, min(int((maxy - miny) * scale) + 2 * margin_px, 4000))
    img = np.zeros((h_px, w_px, 3), dtype=np.uint8)

    def to_px(wx, wy):
        return int((wx - minx) * scale) + margin_px, int((maxy - wy) * scale) + margin_px

    for reg in all_regions:
        pts = np.array([to_px(x, y) for x, y in reg.exterior.coords], dtype=np.int32)
        color = np.random.randint(50, 150, 3).tolist()
        overlay = img.copy()
        cv2.fillPoly(overlay, [pts], color)
        cv2.addWeighted(overlay, 0.5, img, 0.5, 0, img)
        cv2.polylines(img, [pts], True, (200, 200, 200), 1)

    # Draw bounding boxes in magenta
    if all_bboxes:
        for bbox_poly in all_bboxes:
            pts = np.array([to_px(x, y) for x, y in bbox_poly.exterior.coords], dtype=np.int32)
            cv2.polylines(img, [pts], True, (255, 0, 255), 1)

    for (pt1, pt2), label in all_pipes:
        px1, py1 = to_px(pt1[0], pt1[1])
        px2, py2 = to_px(pt2[0], pt2[1])
        cv2.line(img, (px1, py1), (px2, py2), (0, 0, 255), 5)
        line_len = math.hypot(px2 - px1, py2 - py1)
        if line_len > 40:
            mid_x, mid_y = (px1 + px2) // 2, (py1 + py2) // 2
            cv2.putText(img, label, (mid_x - 20, mid_y - 6), cv2.FONT_HERSHEY_SIMPLEX, 0.25, (200, 255, 200), 1, cv2.LINE_AA)

    for dx, dy in all_points:
        px, py = to_px(dx, dy)
        if 0 <= px < w_px and 0 <= py < h_px:
            cv2.drawMarker(img, (px, py), (0, 200, 255), markerType=cv2.MARKER_STAR, markerSize=10, thickness=1)

    sx, sy = to_px(source[0], source[1])
    box_sz = 15
    cv2.rectangle(img, (sx - box_sz, sy - box_sz), (sx + box_sz, sy + box_sz), (0, 0, 255), -1)
    cv2.rectangle(img, (sx - box_sz, sy - box_sz), (sx + box_sz, sy + box_sz), (255, 255, 255), 2)
    cv2.putText(img, "SOURCE", (sx + box_sz + 5, sy - box_sz), cv2.FONT_HERSHEY_SIMPLEX, 0.6, (255, 255, 255), 1)

    os.makedirs(os.path.dirname(output_path) or ".", exist_ok=True)
    cv2.imwrite(output_path, img)
    logger.info("visualize_sprinkler_routing saved=%s", output_path)


# ──────────────────────────────────────────────────────────────────
# Global grid alignment
# ──────────────────────────────────────────────────────────────────
def align_to_global_lines(
    detectors: List[Tuple[float, float]],
    regions: List[Polygon],
    tolerance_m: float = ALIGN_TOLERANCE_M,
) -> List[Tuple[float, float]]:
    """Snap sprinkler points to global X/Y grid lines while staying inside
    the wall-buffered safe zone of their parent region."""
    if not detectors:
        return []
    tolerance_world = tolerance_m / WORLD_TO_M
    wall_buffer_world = WALL_BUFFER_M / WORLD_TO_M

    def _extract_global_lines(coords):
        sorted_coords = sorted(coords)
        if not sorted_coords:
            return []
        lines = []
        current_group = [sorted_coords[0]]
        for val in sorted_coords[1:]:
            if val - current_group[0] <= tolerance_world:
                current_group.append(val)
            else:
                lines.append(sum(current_group) / len(current_group))
                current_group = [val]
        lines.append(sum(current_group) / len(current_group))
        return lines

    global_x_lines = _extract_global_lines([d[0] for d in detectors])
    global_y_lines = _extract_global_lines([d[1] for d in detectors])
    aligned: List[Tuple[float, float]] = []

    for x, y in detectors:
        pt = Point(x, y)
        parent_region = next(
            (r for r in regions if r.contains(pt) or r.distance(pt) < 1e-3), None
        )
        if not parent_region:
            aligned.append((x, y))
            continue

        safe_zone = parent_region.buffer(-wall_buffer_world)
        if safe_zone.is_empty or safe_zone.area <= 0:
            safe_zone = parent_region.buffer(-0.1 / WORLD_TO_M)
            if safe_zone.is_empty:
                safe_zone = parent_region

        valid_x = sorted(
            [gx for gx in global_x_lines if abs(gx - x) <= tolerance_world],
            key=lambda gx: abs(gx - x),
        ) or [x]
        valid_y = sorted(
            [gy for gy in global_y_lines if abs(gy - y) <= tolerance_world],
            key=lambda gy: abs(gy - y),
        ) or [y]

        best_pt = None
        # Try snapping both axes
        for gx in valid_x:
            for gy in valid_y:
                if safe_zone.contains(Point(gx, gy)):
                    best_pt = (gx, gy)
                    break
            if best_pt:
                break
        # Fallback: X axis only
        if not best_pt:
            for gx in valid_x:
                if safe_zone.contains(Point(gx, y)):
                    best_pt = (gx, y)
                    break
        # Fallback: Y axis only
        if not best_pt:
            for gy in valid_y:
                if safe_zone.contains(Point(x, gy)):
                    best_pt = (x, gy)
                    break
        aligned.append(best_pt if best_pt else (x, y))

    return aligned


# ──────────────────────────────────────────────────────────────────
# DXF export for sprinklers + pipes
# ──────────────────────────────────────────────────────────────────

def _add_sprinklers_to_doc(
    doc,
    sprinklers: List[Tuple[float, float]],
    pipes: list,
    sources: List[Tuple[float, float]],
    world_to_m: float = 0.001,
    world_bbox: dict | None = None,
    symbol_radius_world: float | None = None,
    text_height_world: float | None = None,
):
    """Add sprinkler symbols, coloured pipe bands, and source markers to an already-open ezdxf document.
    Does NOT save to disk — caller is responsible for doc.saveas().
    """
    if not _EZDXF_OK:
        return

    from app.pipeline.dxf_export import compute_symbol_sizes

    if symbol_radius_world is None or text_height_world is None:
        sp_dets = [{"x": x, "y": y} for x, y in sprinklers] if sprinklers else []
        auto_r, auto_t = compute_symbol_sizes(world_to_m, sp_dets, world_bbox)
        if symbol_radius_world is None:
            symbol_radius_world = auto_r
        if text_height_world is None:
            text_height_world = auto_t

    msp = doc.modelspace()

    for layer_name in [DXF_LAYER_SPRINKLER, DXF_LAYER_PIPES, DXF_LAYER_SOURCE]:
        if layer_name not in doc.layers:
            doc.layers.add(layer_name)

    def _diameter_mm(label: str) -> float:
        s = str(label or "").strip().lower().replace(" ", "")
        if s.endswith("mm"):
            s = s[:-2]
        try:
            return max(0.0, float(s))
        except Exception:
            return 25.0

    def _lineweight_for_diameter_mm(d_mm: float) -> int:
        if d_mm <= 25:  return 25
        if d_mm <= 32:  return 35
        if d_mm <= 40:  return 50
        if d_mm <= 50:  return 70
        if d_mm <= 65:  return 90
        if d_mm <= 80:  return 106
        if d_mm <= 100: return 140
        if d_mm <= 150: return 200
        return 211

    def _pipe_width_world(d_mm: float) -> float:
        w = (max(1.0, d_mm) / 1000.0) / max(1e-9, world_to_m)
        return max(w, 0.008 / max(1e-9, world_to_m))

    def _add_pipe_band(pt1, pt2, width_world: float, rgb: tuple[int, int, int]):
        x1, y1 = float(pt1[0]), float(pt1[1])
        x2, y2 = float(pt2[0]), float(pt2[1])
        seg_len = math.hypot(x2 - x1, y2 - y1)
        if seg_len <= 1e-9:
            return
        half_w = width_world * 0.5
        nx_ = -(y2 - y1) / seg_len * half_w
        ny_ =  (x2 - x1) / seg_len * half_w
        p1_ = (x1 + nx_, y1 + ny_)
        p2_ = (x2 + nx_, y2 + ny_)
        p3_ = (x2 - nx_, y2 - ny_)
        p4_ = (x1 - nx_, y1 - ny_)
        r, g, b = rgb
        tc = (r << 16) | (g << 8) | b
        hatch = msp.add_hatch(dxfattribs={"layer": DXF_LAYER_PIPES})
        hatch.paths.add_polyline_path([p1_, p2_, p3_, p4_], is_closed=True)
        hatch.set_solid_fill(rgb=(r, g, b))
        border = msp.add_lwpolyline([p1_, p2_, p3_, p4_], close=True, dxfattribs={"layer": DXF_LAYER_PIPES})
        border.dxf.true_color = tc

    # Pipes — coloured by diameter, no per-segment text labels
    for (pt1, pt2), label in pipes:
        d_mm = _diameter_mm(label)
        rgb = _color_for_pipe_diameter(d_mm)
        _add_pipe_band(pt1, pt2, _pipe_width_world(d_mm), rgb)
        r, g, b = rgb
        line = msp.add_line(pt1, pt2, dxfattribs={"layer": DXF_LAYER_PIPES,
                                                    "lineweight": _lineweight_for_diameter_mm(d_mm)})
        line.dxf.true_color = (r << 16) | (g << 8) | b

    # Sprinkler symbols
    layer_attrs = {"layer": DXF_LAYER_SPRINKLER, "color": 1}
    for wx, wy in sprinklers:
        msp.add_circle((wx, wy), radius=symbol_radius_world * 0.4, dxfattribs=layer_attrs)
        for angle in [0, 90]:
            rad = math.radians(angle)
            dx_s = symbol_radius_world * math.cos(rad)
            dy_s = symbol_radius_world * math.sin(rad)
            msp.add_line((wx - dx_s, wy - dy_s), (wx + dx_s, wy + dy_s), dxfattribs=layer_attrs)

    # Source markers
    half_side = symbol_radius_world * 3.0
    for i, (sx, sy) in enumerate(sources):
        corners = [
            (sx - half_side, sy - half_side), (sx + half_side, sy - half_side),
            (sx + half_side, sy + half_side), (sx - half_side, sy + half_side),
            (sx - half_side, sy - half_side),
        ]
        msp.add_lwpolyline(corners, dxfattribs={"layer": DXF_LAYER_SOURCE})
        source_label = f"SOURCE-{i + 1}"
        src_text_h = text_height_world * 1.2
        src_text_w = len(source_label) * src_text_h * 0.7
        try:
            txt = msp.add_text(source_label, dxfattribs={"layer": DXF_LAYER_SOURCE, "height": src_text_h})
            txt.set_placement((sx - src_text_w / 2.0, sy - half_side - src_text_h * 1.5))
        except Exception:
            pass


def write_sprinklers_to_dxf(
    base_dxf: str,
    out_dxf: str,
    sprinklers: List[Tuple[float, float]],
    pipes: list,
    sources: List[Tuple[float, float]],
    world_to_m: float = 0.001,
    world_bbox: dict | None = None,
    symbol_radius_world: float | None = None,
    text_height_world: float | None = None,
):
    """Load *base_dxf*, add sprinkler overlays in-memory, save to *out_dxf* (single read + write)."""
    if not _EZDXF_OK:
        logger.warning("ezdxf not available, skipping DXF export")
        return
    doc = ezdxf.readfile(base_dxf)
    _add_sprinklers_to_doc(
        doc, sprinklers, pipes, sources,
        world_to_m=world_to_m, world_bbox=world_bbox,
        symbol_radius_world=symbol_radius_world, text_height_world=text_height_world,
    )
    doc.saveas(out_dxf)
    logger.info("write_sprinklers_to_dxf saved=%s sprinklers=%d pipes=%d sources=%d",
                out_dxf, len(sprinklers), len(pipes), len(sources))


# ──────────────────────────────────────────────────────────────────
# Pipeline entry-point
# ──────────────────────────────────────────────────────────────────
def place_sprinklers_from_rooms_json(
    rooms: List[Dict],
    dxf_path: str,
    spacing_m: float = 3.0,
    wall_buffer_m: float = 0.20,
    world_to_m: float = 0.001,
    source_labels: List[str] | None = None,
    debug_png_path: str | None = None,
) -> Tuple[
    List[Tuple[float, float]],
    List[Tuple[Tuple[Tuple[float, float], Tuple[float, float]], str]],
    List[Tuple[float, float]],
    List[Polygon],
]:
    """Place sprinklers for all rooms and route pipes.

    Returns ``(sprinkler_coords, pipe_segments, sources, regions)``.
    """
    _set_runtime_config(spacing_m=spacing_m, wall_buffer_m=wall_buffer_m, world_to_m=world_to_m)

    global_sources = detect_sources_from_dxf(dxf_path, source_labels)

    all_points: List[Tuple[float, float]] = []
    all_regions: List[Polygon] = []
    all_bboxes: List[Polygon] = []

    hazard_counts: Dict[str, int] = {}
    room_hazards = _classify_room_hazards_with_dxf_text(rooms, dxf_path=dxf_path)

    # Collect per-room polygons with their resolved hazard for HH-zone logic.
    _room_entries: List[Tuple[Polygon, str]] = []

    for room, hazard in zip(rooms, room_hazards):
        poly = _parse_polygon(room.get("polygon_world"))
        if poly is None:
            continue
        area_m2 = float(poly.area) * (world_to_m ** 2)

        # NONE hazard (e.g. electrical rooms): record region but zero sprinklers.
        if hazard == HAZARD_NONE:
            pts, regs, bboxes = _process_room(poly, hazard_type=HAZARD_NONE)
            all_regions.extend(regs)
            all_bboxes.extend(bboxes)
            hazard_counts[HAZARD_NONE] = hazard_counts.get(HAZARD_NONE, 0) + 1
            continue

        # Washroom exception: tiny washrooms get NONE; larger ones become LH.
        if hazard == HAZARD_WASHROOM:
            if area_m2 < 5.0:
                pts, regs, bboxes = _process_room(poly, hazard_type=HAZARD_NONE)
                all_regions.extend(regs)
                all_bboxes.extend(bboxes)
                continue
            hazard = HAZARD_LH

        # Large LH spaces are treated as OH to avoid under-protection.
        if hazard == HAZARD_LH and area_m2 > 126.0:
            hazard = HAZARD_OH

        hazard_counts[hazard] = hazard_counts.get(hazard, 0) + 1
        _room_entries.append((poly, hazard))

    # HH buffer zone: areas near HH rooms get denser coverage.
    hh_polys = [p for p, h in _room_entries if h == HAZARD_HH]
    hh_zone = unary_union(hh_polys).buffer(6.0 / world_to_m) if hh_polys else None

    for poly, hazard in _room_entries:
        if hh_zone and hazard in (HAZARD_LH, HAZARD_OH) and hh_zone.intersects(poly):
            # Portion inside HH buffer → treat as HH.
            inside = poly.intersection(hh_zone)
            if not inside.is_empty:
                pts, regs, bboxes = _process_room(inside, hazard_type=HAZARD_HH)
                all_points.extend(pts)
                all_regions.extend(regs)
                all_bboxes.extend(bboxes)
            # Remainder keeps original hazard.
            outside = poly.difference(hh_zone)
            if not outside.is_empty:
                pts, regs, bboxes = _process_room(outside, hazard_type=hazard)
                all_points.extend(pts)
                all_regions.extend(regs)
                all_bboxes.extend(bboxes)
        else:
            pts, regs, bboxes = _process_room(poly, hazard_type=hazard)
            all_points.extend(pts)
            all_regions.extend(regs)
            all_bboxes.extend(bboxes)

    if not all_points:
        logger.info("place_sprinklers_from_rooms_json no sprinklers placed (no valid rooms)")
        return [], [], [], all_regions

    # Global grid alignment
    all_points = align_to_global_lines(all_points, all_regions, tolerance_m=ALIGN_TOLERANCE_M)

    # ── Cross-region minimum distance enforcement ──────────────────────────────
    # Sub-polygon decomposition and HH-zone splitting can produce points from
    # neighbouring regions that are closer than target spacing (default 3.0 m).
    # Cull any point that is too close to an already-accepted
    # point using a cell-grid for O(n) average performance.
    _min_dist_world = SPRINKLER_SPACING_M / WORLD_TO_M
    if len(all_points) > 1:
        cell = _min_dist_world  # one cell per min-distance unit
        occupied: dict[tuple[int, int], list[tuple[float, float]]] = {}
        kept: List[Tuple[float, float]] = []

        def _cell(px: float, py: float) -> tuple[int, int]:
            return (int(math.floor(px / cell)), int(math.floor(py / cell)))

        def _too_close(px: float, py: float) -> bool:
            ci, cj = _cell(px, py)
            for di in (-1, 0, 1):
                for dj in (-1, 0, 1):
                    for kp in occupied.get((ci + di, cj + dj), []):
                        if math.hypot(px - kp[0], py - kp[1]) < _min_dist_world:
                            return True
            return False

        for pt in all_points:
            if not _too_close(pt[0], pt[1]):
                kept.append(pt)
                occupied.setdefault(_cell(pt[0], pt[1]), []).append(pt)

        all_points = kept
    # ──────────────────────────────────────────────────────────────────────────

    # Determine source
    min_x = min(p[0] for p in all_points)
    max_x = max(p[0] for p in all_points)
    min_y = min(p[1] for p in all_points)
    max_y = max(p[1] for p in all_points)
    center = ((min_x + max_x) / 2.0, (min_y + max_y) / 2.0)

    if global_sources:
        search_radius = 5.0 / world_to_m
        footprint = unary_union(all_regions).buffer(search_radius)
        local_sources = [(sx, sy) for sx, sy in global_sources if footprint.contains(Point(sx, sy))]
        if local_sources:
            source = min(local_sources, key=lambda s: math.hypot(s[0] - center[0], s[1] - center[1]))
        else:
            source = center
    else:
        source = center

    # Route pipes
    pipe_segments, snapped_sprinklers = route_pipes(all_points, source, valid_regions=all_regions)

    logger.info(
        "place_sprinklers_from_rooms_json sprinklers=%d pipes=%d source=(%.1f, %.1f) hazards=%s",
        len(snapped_sprinklers),
        len(pipe_segments),
        source[0],
        source[1],
        hazard_counts,
    )

    if debug_png_path:
        visualize_sprinkler_routing(all_regions, snapped_sprinklers, pipe_segments, source, debug_png_path, all_bboxes=all_bboxes)

    return snapped_sprinklers, pipe_segments, [source], all_regions


# ──────────────────────────────────────────────────────────────────
# Sprinkler-only placement (no pipe routing)
# ──────────────────────────────────────────────────────────────────
def place_sprinklers_only(
    rooms: List[Dict],
    spacing_m: float = 3.0,
    wall_buffer_m: float = 0.20,
    world_to_m: float = 0.001,
    dxf_path: str | None = None,
) -> List[Tuple[float, float]]:
    """Place sprinklers for all rooms WITHOUT routing pipes.

    Returns ``sprinkler_coords``.
    """
    _set_runtime_config(spacing_m=spacing_m, wall_buffer_m=wall_buffer_m, world_to_m=world_to_m)

    all_points: List[Tuple[float, float]] = []
    all_regions: List[Polygon] = []

    room_hazards = _classify_room_hazards_with_dxf_text(rooms, dxf_path=dxf_path)
    for room, hazard in zip(rooms, room_hazards):
        if hazard == HAZARD_NONE:
            continue
        poly = _parse_polygon(room.get("polygon_world"))
        if poly is None:
            continue
        area_m2 = float(poly.area) * (world_to_m ** 2)
        if hazard == HAZARD_WASHROOM and area_m2 < 5.0:
            continue
        if hazard == HAZARD_WASHROOM:
            hazard = HAZARD_LH
        if hazard == HAZARD_LH and area_m2 > 126.0:
            hazard = HAZARD_OH

        pts, regs, _bboxes = _process_room(poly, hazard_type=hazard)
        all_points.extend(pts)
        all_regions.extend(regs)

    # Global grid alignment
    all_points = align_to_global_lines(all_points, all_regions, tolerance_m=ALIGN_TOLERANCE_M)

    logger.info("place_sprinklers_only sprinklers=%d", len(all_points))
    return all_points


# ──────────────────────────────────────────────────────────────────
# Route pipes for existing sprinkler coordinates
# ──────────────────────────────────────────────────────────────────
def route_pipes_for_sprinklers(
    sprinkler_coords: List[Tuple[float, float]],
    rooms: List[Dict],
    dxf_path: str,
    spacing_m: float = 3.0,
    wall_buffer_m: float = 0.20,
    world_to_m: float = 0.001,
    source_labels: List[str] | None = None,
    override_source: Tuple[float, float] | None = None,
) -> Tuple[
    List[Tuple[Tuple[Tuple[float, float], Tuple[float, float]], str]],
    List[Tuple[float, float]],
    List[Tuple[float, float]],
]:
    """Route pipes connecting existing sprinkler points.

    If *override_source* is provided it is used directly, skipping auto-detection.
    Returns ``(pipe_segments, snapped_sprinklers, sources)``.
    """
    _set_runtime_config(spacing_m=spacing_m, wall_buffer_m=wall_buffer_m, world_to_m=world_to_m)

    if not sprinkler_coords:
        return [], [], []

    # Build regions from rooms for safe-path checking
    all_regions: List[Polygon] = []
    room_hazards = _classify_room_hazards_with_dxf_text(rooms, dxf_path=dxf_path)
    for room, hazard in zip(rooms, room_hazards):
        if hazard == HAZARD_NONE:
            continue
        poly = _parse_polygon(room.get("polygon_world"))
        if poly is None:
            continue
        area_m2 = float(poly.area) * (world_to_m ** 2)
        if hazard == HAZARD_WASHROOM and area_m2 < 5.0:
            continue
        if hazard == HAZARD_WASHROOM:
            hazard = HAZARD_LH
        if hazard == HAZARD_LH and area_m2 > 126.0:
            hazard = HAZARD_OH

        _pts, regs, _bboxes = _process_room(poly, hazard_type=hazard)
        all_regions.extend(regs)

    # Determine source
    if override_source is not None:
        source = override_source
    else:
        global_sources = detect_sources_from_dxf(dxf_path, source_labels)

        min_x = min(p[0] for p in sprinkler_coords)
        max_x = max(p[0] for p in sprinkler_coords)
        min_y = min(p[1] for p in sprinkler_coords)
        max_y = max(p[1] for p in sprinkler_coords)
        center = ((min_x + max_x) / 2.0, (min_y + max_y) / 2.0)

        if global_sources:
            search_radius = 5.0 / world_to_m
            footprint = unary_union(all_regions).buffer(search_radius) if all_regions else Point(center).buffer(search_radius)
            local_sources = [(sx, sy) for sx, sy in global_sources if footprint.contains(Point(sx, sy))]
            if local_sources:
                source = min(local_sources, key=lambda s: math.hypot(s[0] - center[0], s[1] - center[1]))
            else:
                source = center
        else:
            source = center

    pipe_segments, snapped_sprinklers = route_pipes(sprinkler_coords, source, valid_regions=all_regions)

    logger.info(
        "route_pipes_for_sprinklers sprinklers=%d pipes=%d source=(%.1f, %.1f)",
        len(snapped_sprinklers), len(pipe_segments), source[0], source[1],
    )

    return pipe_segments, snapped_sprinklers, [source]
