"""Classify room labels (from DXF TEXT/MTEXT) for fire-detector selection.

Returned values per label:
  - "smoke"  : a smoke detector is preferred
  - "heat"   : a heat detector is required (kitchens, plant rooms, garages, etc.)
  - "skip"   : no point detector should be placed (toilets, bathrooms, WCs)
  - "unknown": label empty / non-letter; caller should treat as smoke default

Pipeline:
  1. Deterministic regex match against curated SMOKE / HEAT / SKIP / AMBIGUOUS
     keyword lists.
  2. If the label is ambiguous (e.g. generic "storage", "rack", "filing") or
     unmatched, call Gemini Flash (with in-process cache).
  3. If Gemini is unavailable / fails, return "unknown" so the caller can
     default to smoke.

Adapted from a self-contained reference pipeline; geometry/placement logic
elsewhere in the codebase is unchanged.
"""
from __future__ import annotations

import json
import logging
import os
import re
import threading
from typing import Iterable

logger = logging.getLogger("mepit.pipeline.room_label_classifier")

_DEFAULT_MODEL = os.getenv("ROOM_CLASSIFIER_MODEL", "gemini-2.5-flash")
_USE_GEMINI = os.getenv("ROOM_CLASSIFIER_USE_GEMINI", "1").strip().lower() not in (
    "0", "false", "no", "",
)

# Process-wide cache: normalized label -> "smoke" | "heat" | "skip" | "unknown".
_cache: dict[str, str] = {}
_cache_lock = threading.Lock()

# ---------------------------------------------------------------------------
# Label cleaning helpers
# ---------------------------------------------------------------------------

def _clean_mtext(raw: str) -> str:
    s = str(raw or "")
    s = s.replace("\\P", " ").replace("\\p", " ")
    s = re.sub(r"\\[A-Za-z]+[^;]*;", " ", s)
    s = re.sub(r"[{}]", " ", s)
    s = re.sub(r"\s+", " ", s).strip()
    return s


def _normalize(raw: str) -> str:
    s = _clean_mtext(raw).lower()
    s = s.replace("&", " and ")
    s = re.sub(r"[^a-z0-9/+.\- ]+", " ", s)
    s = re.sub(r"\s+", " ", s).strip()
    return s


def _has_letters(s: str) -> bool:
    return bool(re.search(r"[a-zA-Z]", s or ""))


# ---------------------------------------------------------------------------
# Deterministic keyword lists
# ---------------------------------------------------------------------------

# Currently empty: toilets/bathrooms now get HEAT detectors (see below).
_SKIP_PATTERNS: list[str] = []

_HEAT_PATTERNS = [
    r"\b(toilet|toliet|tilet|toilets|wc|w\.c|w/c|bath|bathroom|lavatory|lav|"
    r"wash\s*room|washroom|restroom|powder\s*room|ladies|gents|gent|female|male)\b",
    r"\b(kitchen|kitch|kit\.?|pantry|cooking|cook\s*area|commercial\s*kitchen|"
    r"fume\s*hood|exhaust\s*duct)\b",
    r"\b(boiler|boiler\s*room|dg\s*room|d\.g\.?\s*room|diesel\s*generator|"
    r"generator\s*room|genset|gen\s*set)\b",
    r"\b(garage|repair\s*shop|workshop|service\s*bay|car\s*park|car\s*parking|"
    r"parking|mlcp)\b",
    r"\b(battery\s*room|battery|ups\s*battery)\b",
    r"\b(oven|furnace|turbine|high\s*temperature|hot\s*room|incinerator)\b",
    r"\b(cooling\s*tower|fan\s*deck|fan\s*opening)\b",
    r"\b(refrigerated|refrigeration|cold\s*room|freezer|deep\s*freezer|"
    r"chiller\s*room)\b",
    r"\b(laundry|steam|steam\s*room|dusty|dirty|dust|dust\s*room)\b",
    r"\b(flammable\s*store|flammable\s*storage|chemical\s*store|"
    r"chemical\s*storage|paint\s*store|paint\s*storage|oil\s*store|"
    r"oil\s*storage|diesel\s*store|diesel\s*storage|fuel\s*store|"
    r"fuel\s*storage|gas\s*cylinder\s*store|gas\s*cylinder\s*storage|"
    r"hazardous\s*store|hazardous\s*storage)\b",
]

# Labels in this list are sent to Gemini rather than mapped by keyword alone
# (generic "storage", "rack", "filing" can be smoke or heat depending on what
# the room actually stores).
_AMBIGUOUS_PATTERNS = [
    r"\b(filing|file\s*room|files|record|records|document|documents|"
    r"paper\s*storage|paper\s*store)\b",
    r"\b(storage|store|stores|store\s*room|storeroom|stock\s*room|"
    r"material\s*store|material\s*storage)\b",
    r"\b(rack|racks|cupboard|cupboards|closet|closets|cabinet|cabinets)\b",
    r"\b(janitor|housekeeping|hk\s*room|utility\s*store|service\s*store)\b",
]

_SMOKE_PATTERNS = [
    r"\b(corridor|passage|lobby|foyer|vestibule|circulation|escape\s*route|"
    r"staircase|stair\s*case|stair|lift\s*lobby)\b",
    r"\b(computer|edp|server|server\s*room|it\s*room|data\s*center|"
    r"data\s*centre|electronic|equipment\s*room)\b",
    r"\b(archive|archives|library|libraries|museum|museums)\b",
    r"\b(atrium|return\s*air|ahu|air\s*handling|air\s*handling\s*unit|hvac|"
    r"ac\s*return|ventilation\s*duct|duct)\b",
    r"\b(shaft|utility\s*shaft|lift\s*shaft|elevator\s*shaft|tunnel|"
    r"cable\s*tunnel|false\s*ceiling|false\s*floor)\b",
    r"\b(lift\s*machine|lift\s*room|elevator\s*machine|elevator\s*room|"
    r"machinery\s*space|control\s*room|hoistway)\b",
    r"\b(electrical|electric|elec\.?|distribution\s*board|db\s*room|"
    r"panel\s*room|mccb|switchgear|substation|electrical\s*shaft)\b",
    r"\b(office|cabin|meeting|conference|classroom|ward|bedroom|living|"
    r"dining|hall|reception|lounge|admin|staff|room)\b",
]


def _match_any(label: str, patterns: list[str]) -> bool:
    return any(re.search(p, label, flags=re.IGNORECASE) for p in patterns)


def _deterministic(label_raw: str) -> str:
    """Return 'smoke' | 'heat' | 'skip' | 'ask_gemini' | 'unknown'."""
    label = _normalize(label_raw)
    if not label or not _has_letters(label):
        return "unknown"
    if _match_any(label, _SKIP_PATTERNS):
        return "skip"
    if _match_any(label, _HEAT_PATTERNS):
        return "heat"
    if _match_any(label, _AMBIGUOUS_PATTERNS):
        return "ask_gemini"
    if _match_any(label, _SMOKE_PATTERNS):
        return "smoke"
    return "unknown"


# ---------------------------------------------------------------------------
# Gemini fallback
# ---------------------------------------------------------------------------

_GEMINI_PROMPT = """\
You are classifying a CAD room/area text label for fire-alarm detector placement.

Return ONLY valid JSON:
{{
  "detector_type": "SMOKE" | "HEAT" | "SKIP" | "UNKNOWN",
  "confidence": "HIGH" | "MEDIUM" | "LOW",
  "reason": "short reason"
}}

Rules:
1. Use HEAT when the label indicates a heat/steam/humidity/dust/false-alarm-prone or heat-producing area:
   toilet, WC, bathroom, lavatory, washroom, restroom, ladies/gents room (high humidity / steam from showers),
   kitchen, pantry, cooking, fume hood, boiler, DG/diesel generator, garage, repair shop,
   battery room, oven, furnace, turbine, cooling tower, cold room/freezer/chiller,
   laundry/steam/dusty/dirty areas,
   or explicit flammable/chemical/paint/oil/diesel/fuel/gas/hazardous storage.
2. Use SMOKE for life-safety and normal occupied/equipment spaces:
   corridor, passage, lobby, staircase, escape route, office, cabin, meeting room, normal room,
   computer/EDP/server/IT/electronic equipment rooms,
   AHU/HVAC/duct/shaft/tunnel/false ceiling/false floor/lift/electrical rooms,
   archive/library/museum open room areas.
4. Do NOT automatically choose HEAT just because a label says store/storage.
   Filing/records/document/paper storage usually lean SMOKE unless the label says rack/cupboard
   only, flammable, chemical, paint, oil, fuel, diesel, gas, hazardous, dusty, dirty or hot.
5. If a normal occupied room is not clearly heat or skip, choose SMOKE.

CAD label: {label!r}
"""


def _parse_gemini(text: str) -> str:
    raw = (text or "").strip()
    cleaned = re.sub(r"^```(?:json)?\s*|\s*```$", "", raw, flags=re.IGNORECASE)
    try:
        obj = json.loads(cleaned)
        if isinstance(obj, dict):
            dt = str(obj.get("detector_type", "")).strip().lower()
            if dt in ("smoke", "heat", "skip", "unknown"):
                return dt
    except Exception:
        pass
    upper = raw.upper()
    if "HEAT" in upper:
        return "heat"
    if "SMOKE" in upper:
        return "smoke"
    if "SKIP" in upper or "NONE" in upper or "NO DETECTOR" in upper:
        return "skip"
    return "unknown"


def _gemini_classify(labels: list[str], model: str) -> dict[str, str]:
    """Classify each label via Gemini. Returns {label: smoke|heat|skip|unknown}."""
    api_key = os.getenv("GEMINI_API_KEY", "").strip()
    if not api_key or not _USE_GEMINI:
        return {lbl: "unknown" for lbl in labels}

    try:
        from google import genai
        try:
            from google.genai import types as genai_types
        except Exception:
            genai_types = None
    except ImportError:
        logger.warning("room_label_classifier: google-genai not installed")
        return {lbl: "unknown" for lbl in labels}

    try:
        client = genai.Client(api_key=api_key)
    except Exception as exc:
        logger.warning("room_label_classifier: Gemini client init failed: %s", exc)
        return {lbl: "unknown" for lbl in labels}

    out: dict[str, str] = {}
    for lbl in labels:
        prompt = _GEMINI_PROMPT.format(label=_clean_mtext(lbl))
        try:
            if genai_types is not None:
                cfg = genai_types.GenerateContentConfig(
                    temperature=0,
                    max_output_tokens=200,
                    response_mime_type="application/json",
                )
                resp = client.models.generate_content(
                    model=model, contents=prompt, config=cfg,
                )
            else:
                resp = client.models.generate_content(model=model, contents=prompt)
            text = getattr(resp, "text", "") or ""
            out[lbl] = _parse_gemini(text)
        except Exception as exc:
            logger.warning(
                "room_label_classifier: Gemini call failed for %r: %s", lbl, exc,
            )
            out[lbl] = "unknown"

    return out


# ---------------------------------------------------------------------------
# Public API
# ---------------------------------------------------------------------------

def classify_labels(
    labels: Iterable[str],
    model: str | None = None,
) -> dict[str, str]:
    """Classify each label as 'smoke' | 'heat' | 'skip' | 'unknown'.

    Uses deterministic regex lists first, then Gemini for ambiguous labels,
    with a process-wide cache keyed by the normalized label form.

    Returns a dict keyed by the ORIGINAL label string.
    """
    model = model or _DEFAULT_MODEL
    labels = list(labels)
    result: dict[str, str] = {}
    gemini_queue: dict[str, str] = {}  # normalized -> first original seen

    for lbl in labels:
        if lbl in result:
            continue
        if not lbl or not lbl.strip():
            result[lbl] = "unknown"
            continue
        norm = _normalize(lbl)
        with _cache_lock:
            cached = _cache.get(norm)
        if cached is not None:
            result[lbl] = cached
            continue
        det = _deterministic(lbl)
        if det in ("smoke", "heat", "skip"):
            with _cache_lock:
                _cache[norm] = det
            result[lbl] = det
            continue
        # det in ("ask_gemini", "unknown") -> queue for Gemini
        if norm not in gemini_queue:
            gemini_queue[norm] = lbl

    if gemini_queue:
        reps = list(gemini_queue.values())
        classified = _gemini_classify(reps, model)
        with _cache_lock:
            for rep, cls in classified.items():
                _cache[_normalize(rep)] = cls
        for lbl in labels:
            if lbl in result:
                continue
            norm = _normalize(lbl)
            with _cache_lock:
                result[lbl] = _cache.get(norm, "unknown")
        logger.info(
            "room_label_classifier: %d labels via Gemini (%s)",
            len(gemini_queue), model,
        )

    return result
