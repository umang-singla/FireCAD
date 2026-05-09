import os
import logging
from typing import List, Tuple

from shapely.geometry import Point, Polygon

logger = logging.getLogger("mepit.pipeline.dxf_text_filter")

try:
    import ezdxf
    _EZDXF_OK = True
except ImportError:
    _EZDXF_OK = False


def extract_dxf_labels(dxf_path: str) -> List[Tuple[str, Point]]:
    """Read TEXT and MTEXT from a DXF file and return (text_string, shapely Point) pairs."""
    labels: List[Tuple[str, Point]] = []
    if not _EZDXF_OK or not os.path.exists(dxf_path):
        return labels

    try:
        doc = ezdxf.readfile(dxf_path)
        msp = doc.modelspace()

        for entity in msp.query("TEXT MTEXT"):
            if entity.dxftype() == "TEXT":
                text_val = entity.dxf.text
                pt = entity.dxf.insert
            elif entity.dxftype() == "MTEXT":
                text_val = entity.text
                pt = entity.dxf.insert
            else:
                continue

            labels.append((text_val, Point(pt.x, pt.y)))
    except Exception as e:
        logger.warning("Failed to extract text from DXF %s: %s", dxf_path, e)

    return labels


def filter_rooms_by_dxf_text(
    rooms: list,
    dxf_path: str,
    exclude_keywords: List[str] | None = None,
) -> list:
    """Remove rooms whose polygon contains DXF text matching any exclude keyword.

    Args:
        rooms: List of room dicts with ``polygon_world`` key.
        dxf_path: Path to the source DXF file.
        exclude_keywords: Case-insensitive substrings to match against DXF text.
            Defaults to common non-detectable spaces like toilets.

    Returns:
        Filtered list of rooms (rooms matching excluded text are removed).
    """
    if exclude_keywords is None:
        exclude_keywords = ["toilet", "toliet", "t/let", "wc", "lavatory"]

    dxf_labels = extract_dxf_labels(dxf_path)
    if not dxf_labels:
        return rooms

    logger.info("dxf_text_filter loaded %d text entities, exclude_keywords=%s", len(dxf_labels), exclude_keywords)

    keywords_lower = [kw.lower() for kw in exclude_keywords]
    filtered = []

    for room in rooms:
        poly_coords = room.get("polygon_world")
        if not poly_coords or len(poly_coords) < 3:
            filtered.append(room)
            continue

        poly = Polygon(poly_coords)
        if not poly.is_valid:
            from shapely.validation import make_valid
            poly = make_valid(poly)

        skip = False
        for text_val, text_pt in dxf_labels:
            if poly.contains(text_pt):
                val_lower = text_val.lower()
                if any(kw in val_lower for kw in keywords_lower):
                    logger.info(
                        "dxf_text_filter skipping room_id=%s matched='%s'",
                        room.get("room_id", "?"),
                        text_val,
                    )
                    skip = True
                    break

        if not skip:
            filtered.append(room)

    logger.info("dxf_text_filter kept %d/%d rooms", len(filtered), len(rooms))
    return filtered
