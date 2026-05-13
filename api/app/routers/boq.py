import io
import json
import math
import os
import uuid
from datetime import date, timedelta
from typing import Any, Dict, List

from fastapi import APIRouter, Depends, HTTPException
from fastapi.responses import StreamingResponse

from app.db import db, now
from app.routers.auth import get_current_user
from app.routers.projects import _authorize_project, _authorize_project_write
from app.schemas import BOQBulkSave, BOQItemCreate, BOQItemOut, BOQItemUpdate, BOQMetaOut
from app.storage import project_dir

router = APIRouter(tags=["boq"])

# ── Default equipment catalogue (dtype → line item template) ──────────────
DTYPE_DEFAULTS: Dict[str, Dict[str, Any]] = {
    "sprinkler": {
        "section": "21 — Fire Suppression",
        "item_type": "Sprinkler",
        "description": 'Sprinkler Head — Standard Pendant, 1/2" orifice, RTI ≤ 50 (m·s)^0.5, K-factor 80, temperature rating 68°C',
        "unit": "unit",
        "unit_price": 0.0,
    },
    "smoke": {
        "section": "28 — Electronic Safety",
        "item_type": "Smoke Detector",
        "description": "Smoke Detector — Photoelectric, loop-powered, with base, LED indicator",
        "unit": "unit",
        "unit_price": 0.0,
    },
    "fire_hose": {
        "section": "21 — Fire Suppression",
        "item_type": "Fire Hose Reel",
        "description": "Fire Hose Reel — 36m x 19mm hose, recessed cabinet, with shut-off nozzle",
        "unit": "unit",
        "unit_price": 0.0,
    },
    "internal_hydrant": {
        "section": "21 — Fire Suppression",
        "item_type": "Internal Hydrant",
        "description": "Internal Hydrant Cabinet — 65mm landing valve, 30m x 63mm hose, branch pipe & nozzle",
        "unit": "unit",
        "unit_price": 0.0,
    },
    "mcp_hooter": {
        "section": "28 — Electronic Safety",
        "item_type": "MCP",
        "description": "Manual Call Point + Sounder — addressable MCP with integral sounder base",
        "unit": "unit",
        "unit_price": 0.0,
    },
    "mcb": {
        "section": "28 — Electronic Safety",
        "item_type": "MCP",
        "description": "Manual Call Point (MCP) — addressable, flush-mount, red, with key test",
        "unit": "unit",
        "unit_price": 0.0,
    },
    "hooter": {
        "section": "28 — Electronic Safety",
        "item_type": "Hooter",
        "description": "Alarm Sounder / Hooter — weatherproof, 90 dB @ 1m, red, 24 V DC",
        "unit": "unit",
        "unit_price": 0.0,
    },
    "panel": {
        "section": "28 — Electronic Safety",
        "item_type": "Control Panel",
        "description": "Fire Alarm Control Panel — addressable, 2-loop, with battery backup 24 h",
        "unit": "unit",
        "unit_price": 0.0,
    },
    "beam_detector": {
        "section": "28 — Electronic Safety",
        "item_type": "Beam Detector",
        "description": "Projected Beam Smoke Detector — range up to 100 m, automatic alignment, IP 65",
        "unit": "unit",
        "unit_price": 0.0,
    },
    "reflector": {
        "section": "28 — Electronic Safety",
        "item_type": "Beam Detector",
        "description": "Beam Detector Reflector Prism — triple-prism, for use with beam detector",
        "unit": "unit",
        "unit_price": 0.0,
    },
}

# Friendly label ordering for pipe diameters in BOQ
PIPE_DIAMETER_ORDER = ['25mm', '32mm', '40mm', '50mm', '65mm', '80mm', '90mm',
                       '100mm', '125mm', '150mm', '200mm', '250mm', '300mm']


def _pipe_lengths_from_files(project_id: str, world_to_m: float) -> Dict[str, float]:
    """Read all sprinkler_pipes JSON files for the project and return
    actual pipe lengths (in metres) keyed by diameter label."""
    pdir = project_dir(project_id)
    lengths: Dict[str, float] = {}

    def _ingest(path: str) -> None:
        if not os.path.exists(path):
            return
        try:
            with open(path, "r", encoding="utf-8") as f:
                data = json.load(f)
        except Exception:
            return
        pipes = data.get("pipes", []) if isinstance(data, dict) else data
        for seg in pipes:
            try:
                x1, y1 = seg["from"]
                x2, y2 = seg["to"]
                diam = seg.get("diameter", "unknown")
                seg_len = math.hypot(x2 - x1, y2 - y1) * world_to_m
                lengths[diam] = lengths.get(diam, 0.0) + seg_len
            except (KeyError, TypeError, ValueError):
                continue

    # Project-level file
    _ingest(os.path.join(pdir, "sprinkler_pipes.json"))
    # Per-block files
    for name in os.listdir(pdir):
        import re as _re
        if _re.match(r"^sprinkler_pipes_\d+\.json$", name):
            _ingest(os.path.join(pdir, name))

    return lengths


# An accessory item added per sprinkler (fitting, bracket, etc.)
SPRINKLER_ACCESSORY_RATIO = 0.4  # ~40% of sprinkler count


# ── helpers ──────────────────────────────────────────────────────────────────

def _row_to_item_out(r) -> BOQItemOut:
    return BOQItemOut(
        id=r["id"],
        project_id=r["project_id"],
        section=r["section"],
        item_type=r["item_type"],
        description=r["description"],
        qty=float(r["qty"]),
        unit=r["unit"],
        unit_price=float(r["unit_price"]),
        notes=r["notes"],
        sort_order=int(r["sort_order"]),
    )


def _get_or_build_meta(con, project_id: str, project_name: str) -> Dict[str, Any]:
    row = con.execute("SELECT * FROM boq_meta WHERE project_id=?", (project_id,)).fetchone()
    today = date.today()
    if row:
        return dict(row)
    # Auto-generate quote number and defaults
    count = con.execute("SELECT COUNT(*) FROM boq_meta").fetchone()[0] + 1
    return {
        "project_id": project_id,
        "client_name": None,
        "quote_title": f"AI Quote — {project_name} Takeoff",
        "quote_number": f"Q-{today.year}-{count:04d}",
        "valid_from": today.isoformat(),
        "valid_until": (today + timedelta(days=30)).isoformat(),
        "version": 1,
        "scope_notes": None,
    }


def _auto_populate(con, project_id: str) -> List[Dict[str, Any]]:
    """Build a default BOQ from the detectors already placed on the project."""
    rows = con.execute(
        "SELECT dtype, COUNT(*) as cnt FROM detectors WHERE project_id=? GROUP BY dtype",
        (project_id,),
    ).fetchall()

    # Read world_to_m from project settings (default 0.001 = DXF mm → m)
    proj_row = con.execute("SELECT settings_json FROM projects WHERE id=?", (project_id,)).fetchone()
    world_to_m = 0.001
    if proj_row and proj_row["settings_json"]:
        try:
            world_to_m = json.loads(proj_row["settings_json"]).get("world_to_m", 0.001)
        except Exception:
            pass

    items: List[Dict[str, Any]] = []
    sort_idx = 0
    has_sprinklers = False

    for row in rows:
        dtype = row["dtype"]
        cnt = row["cnt"]
        tmpl = DTYPE_DEFAULTS.get(dtype)
        if not tmpl:
            continue
        items.append({
            "id": str(uuid.uuid4()),
            "project_id": project_id,
            "section": tmpl["section"],
            "item_type": tmpl["item_type"],
            "description": tmpl["description"],
            "qty": float(cnt),
            "unit": tmpl["unit"],
            "unit_price": tmpl["unit_price"],
            "notes": None,
            "sort_order": sort_idx,
        })
        sort_idx += 1

        if dtype == "sprinkler":
            has_sprinklers = True
            acc_qty = max(1, math.ceil(cnt * SPRINKLER_ACCESSORY_RATIO))
            items.append({
                "id": str(uuid.uuid4()),
                "project_id": project_id,
                "section": "21 — Fire Suppression",
                "item_type": "Sprinkler",
                "description": "Sprinkler Fittings & Accessories — elbows, tees, hangers, escutcheon plates",
                "qty": float(acc_qty),
                "unit": "unit",
                "unit_price": 0.0,
                "notes": None,
                "sort_order": sort_idx,
            })
            sort_idx += 1

    # ── Pipe lengths from actual routed geometry ──────────────────────────────
    if has_sprinklers:
        pipe_lengths = _pipe_lengths_from_files(project_id, world_to_m)

        def _diam_sort_key(label: str) -> int:
            try:
                return PIPE_DIAMETER_ORDER.index(label)
            except ValueError:
                try:
                    return int("".join(filter(str.isdigit, label)))
                except ValueError:
                    return 9999

        for diam_label in sorted(pipe_lengths, key=_diam_sort_key):
            length_m = pipe_lengths[diam_label]
            if length_m < 0.1:
                continue
            items.append({
                "id": str(uuid.uuid4()),
                "project_id": project_id,
                "section": "21 — Fire Suppression",
                "item_type": "GI Pipe",
                "description": (
                    f"GI / ERW Pipe {diam_label} Schedule 40, hydraulically tested,\n"
                    f"for sprinkler distribution network"
                ),
                "qty": round(length_m, 1),
                "unit": "m",
                "unit_price": 0.0,
                "notes": None,
                "sort_order": sort_idx,
            })
            sort_idx += 1

    return items


# ── routes ───────────────────────────────────────────────────────────────────

@router.get("/projects/{project_id}/boq/meta", response_model=BOQMetaOut)
def get_boq_meta(project_id: str, user=Depends(get_current_user)):
    with db() as con:
        r = _authorize_project(con, project_id, user)
        meta = _get_or_build_meta(con, project_id, r["name"])
    return BOQMetaOut(**{k: meta[k] for k in BOQMetaOut.model_fields.keys() if k in meta})


@router.put("/projects/{project_id}/boq/meta", response_model=BOQMetaOut)
def upsert_boq_meta(project_id: str, payload: BOQMetaOut, user=Depends(get_current_user)):
    # accept any partial update via BOQMetaOut (all optional fields there)
    with db() as con:
        _authorize_project_write(con, project_id, user)
        existing = con.execute("SELECT * FROM boq_meta WHERE project_id=?", (project_id,)).fetchone()
        if existing:
            con.execute(
                """UPDATE boq_meta SET client_name=?, quote_title=?, quote_number=?,
                   valid_from=?, valid_until=?, version=?, scope_notes=?, updated_at=?
                   WHERE project_id=?""",
                (payload.client_name, payload.quote_title, payload.quote_number,
                 payload.valid_from, payload.valid_until, payload.version,
                 payload.scope_notes, now(), project_id),
            )
        else:
            con.execute(
                """INSERT INTO boq_meta (project_id, client_name, quote_title, quote_number,
                   valid_from, valid_until, version, scope_notes, updated_at)
                   VALUES (?,?,?,?,?,?,?,?,?)""",
                (project_id, payload.client_name, payload.quote_title, payload.quote_number,
                 payload.valid_from, payload.valid_until, payload.version,
                 payload.scope_notes, now()),
            )
        row = con.execute("SELECT * FROM boq_meta WHERE project_id=?", (project_id,)).fetchone()
    return BOQMetaOut(**dict(row))


@router.get("/projects/{project_id}/boq/items", response_model=List[BOQItemOut])
def get_boq_items(project_id: str, user=Depends(get_current_user)):
    with db() as con:
        _authorize_project(con, project_id, user)
        rows = con.execute(
            "SELECT * FROM boq_items WHERE project_id=? ORDER BY sort_order ASC, created_at ASC",
            (project_id,),
        ).fetchall()

        if not rows:
            # Auto-populate from detector placements
            auto_items = _auto_populate(con, project_id)
            t = now()
            for item in auto_items:
                con.execute(
                    """INSERT INTO boq_items (id, project_id, section, item_type, description,
                       qty, unit, unit_price, notes, sort_order, created_at, updated_at)
                       VALUES (?,?,?,?,?,?,?,?,?,?,?,?)""",
                    (item["id"], item["project_id"], item["section"], item["item_type"],
                     item["description"], item["qty"], item["unit"], item["unit_price"],
                     item["notes"], item["sort_order"], t, t),
                )
            rows = con.execute(
                "SELECT * FROM boq_items WHERE project_id=? ORDER BY sort_order ASC, created_at ASC",
                (project_id,),
            ).fetchall()

    return [_row_to_item_out(r) for r in rows]


@router.post("/projects/{project_id}/boq/items", response_model=BOQItemOut)
def create_boq_item(project_id: str, payload: BOQItemCreate, user=Depends(get_current_user)):
    item_id = str(uuid.uuid4())
    t = now()
    with db() as con:
        _authorize_project_write(con, project_id, user)
        con.execute(
            """INSERT INTO boq_items (id, project_id, section, item_type, description,
               qty, unit, unit_price, notes, sort_order, created_at, updated_at)
               VALUES (?,?,?,?,?,?,?,?,?,?,?,?)""",
            (item_id, project_id, payload.section, payload.item_type, payload.description,
             payload.qty, payload.unit, payload.unit_price, payload.notes, payload.sort_order, t, t),
        )
        r = con.execute("SELECT * FROM boq_items WHERE id=?", (item_id,)).fetchone()
    return _row_to_item_out(r)


@router.put("/projects/{project_id}/boq/items/{item_id}", response_model=BOQItemOut)
def update_boq_item(project_id: str, item_id: str, payload: BOQItemUpdate, user=Depends(get_current_user)):
    with db() as con:
        _authorize_project_write(con, project_id, user)
        r = con.execute("SELECT * FROM boq_items WHERE id=? AND project_id=?", (item_id, project_id)).fetchone()
        if not r:
            raise HTTPException(404, "BOQ item not found")
        section = payload.section if payload.section is not None else r["section"]
        item_type = payload.item_type if payload.item_type is not None else r["item_type"]
        description = payload.description if payload.description is not None else r["description"]
        qty = payload.qty if payload.qty is not None else float(r["qty"])
        unit = payload.unit if payload.unit is not None else r["unit"]
        unit_price = payload.unit_price if payload.unit_price is not None else float(r["unit_price"])
        notes = payload.notes if payload.notes is not None else r["notes"]
        sort_order = payload.sort_order if payload.sort_order is not None else int(r["sort_order"])
        con.execute(
            """UPDATE boq_items SET section=?, item_type=?, description=?, qty=?, unit=?,
               unit_price=?, notes=?, sort_order=?, updated_at=? WHERE id=?""",
            (section, item_type, description, qty, unit, unit_price, notes, sort_order, now(), item_id),
        )
        r = con.execute("SELECT * FROM boq_items WHERE id=?", (item_id,)).fetchone()
    return _row_to_item_out(r)


@router.delete("/projects/{project_id}/boq/items/{item_id}")
def delete_boq_item(project_id: str, item_id: str, user=Depends(get_current_user)):
    with db() as con:
        _authorize_project_write(con, project_id, user)
        r = con.execute("SELECT id FROM boq_items WHERE id=? AND project_id=?", (item_id, project_id)).fetchone()
        if not r:
            raise HTTPException(404, "BOQ item not found")
        con.execute("DELETE FROM boq_items WHERE id=?", (item_id,))
    return {"ok": True}


@router.post("/projects/{project_id}/boq/save", response_model=List[BOQItemOut])
def bulk_save_boq(project_id: str, payload: BOQBulkSave, user=Depends(get_current_user)):
    """Replace all BOQ items for the project and optionally update meta."""
    with db() as con:
        r = _authorize_project_write(con, project_id, user)

        # Update meta if provided
        if payload.meta:
            m = payload.meta
            existing = con.execute("SELECT project_id FROM boq_meta WHERE project_id=?", (project_id,)).fetchone()
            if existing:
                con.execute(
                    """UPDATE boq_meta SET client_name=COALESCE(?, client_name),
                       quote_title=COALESCE(?, quote_title), quote_number=COALESCE(?, quote_number),
                       valid_from=COALESCE(?, valid_from), valid_until=COALESCE(?, valid_until),
                       version=COALESCE(?, version), scope_notes=COALESCE(?, scope_notes), updated_at=?
                       WHERE project_id=?""",
                    (m.client_name, m.quote_title, m.quote_number, m.valid_from, m.valid_until,
                     m.version, m.scope_notes, now(), project_id),
                )
            else:
                today = date.today()
                count = con.execute("SELECT COUNT(*) FROM boq_meta").fetchone()[0] + 1
                con.execute(
                    """INSERT INTO boq_meta (project_id, client_name, quote_title, quote_number,
                       valid_from, valid_until, version, scope_notes, updated_at)
                       VALUES (?,?,?,?,?,?,?,?,?)""",
                    (project_id,
                     m.client_name,
                     m.quote_title or f"AI Quote — {r['name']} Takeoff",
                     m.quote_number or f"Q-{today.year}-{count:04d}",
                     m.valid_from or today.isoformat(),
                     m.valid_until or (today + timedelta(days=30)).isoformat(),
                     m.version or 1,
                     m.scope_notes,
                     now()),
                )

        # Replace items
        con.execute("DELETE FROM boq_items WHERE project_id=?", (project_id,))
        t = now()
        for idx, item in enumerate(payload.items):
            con.execute(
                """INSERT INTO boq_items (id, project_id, section, item_type, description,
                   qty, unit, unit_price, notes, sort_order, created_at, updated_at)
                   VALUES (?,?,?,?,?,?,?,?,?,?,?,?)""",
                (str(uuid.uuid4()), project_id, item.section, item.item_type, item.description,
                 item.qty, item.unit, item.unit_price, item.notes, idx, t, t),
            )

        rows = con.execute(
            "SELECT * FROM boq_items WHERE project_id=? ORDER BY sort_order ASC",
            (project_id,),
        ).fetchall()

    return [_row_to_item_out(row) for row in rows]


@router.post("/projects/{project_id}/boq/repopulate", response_model=List[BOQItemOut])
def repopulate_boq(project_id: str, user=Depends(get_current_user)):
    """Clear and re-generate BOQ items from current detector placements."""
    with db() as con:
        _authorize_project_write(con, project_id, user)
        con.execute("DELETE FROM boq_items WHERE project_id=?", (project_id,))
        auto_items = _auto_populate(con, project_id)
        t = now()
        for item in auto_items:
            con.execute(
                """INSERT INTO boq_items (id, project_id, section, item_type, description,
                   qty, unit, unit_price, notes, sort_order, created_at, updated_at)
                   VALUES (?,?,?,?,?,?,?,?,?,?,?,?)""",
                (item["id"], item["project_id"], item["section"], item["item_type"],
                 item["description"], item["qty"], item["unit"], item["unit_price"],
                 item["notes"], item["sort_order"], t, t),
            )
        rows = con.execute(
            "SELECT * FROM boq_items WHERE project_id=? ORDER BY sort_order ASC",
            (project_id,),
        ).fetchall()
    return [_row_to_item_out(r) for r in rows]


# ── Excel Export ──────────────────────────────────────────────────────────────

@router.get("/projects/{project_id}/boq/export")
def export_boq_excel(project_id: str, user=Depends(get_current_user)):
    try:
        import openpyxl
        from openpyxl.styles import (
            Alignment, Border, Font, PatternFill, Side
        )
    except ImportError:
        raise HTTPException(500, "openpyxl not installed") from None

    with db() as con:
        r = _authorize_project(con, project_id, user)
        project_name = r["name"]

        meta_row = con.execute("SELECT * FROM boq_meta WHERE project_id=?", (project_id,)).fetchone()
        meta = _get_or_build_meta(con, project_id, project_name)
        if meta_row:
            meta = dict(meta_row)

        items = con.execute(
            "SELECT * FROM boq_items WHERE project_id=? ORDER BY sort_order ASC, created_at ASC",
            (project_id,),
        ).fetchall()

    wb = openpyxl.Workbook()
    ws = wb.active
    ws.title = "BOQ"

    # ── Helpers ──────────────────────────────────────────────────────────────
    def fill(hex_color):
        return PatternFill("solid", fgColor=hex_color)

    def cell(row, col, value="", bold=False, size=10, color="000000",
             bg=None, align="left", wrap=False, italic=False):
        c = ws.cell(row=row, column=col, value=value)
        c.font = Font(bold=bold, size=size, color=color, italic=italic,
                      name="Calibri")
        c.alignment = Alignment(horizontal=align, vertical="center",
                                wrap_text=wrap)
        if bg:
            c.fill = fill(bg)
        return c

    # ── Column widths ─────────────────────────────────────────────────────────
    ws.column_dimensions["A"].width = 5   # #
    ws.column_dimensions["B"].width = 20  # TYPE
    ws.column_dimensions["C"].width = 46  # DESCRIPTION
    ws.column_dimensions["D"].width = 8   # QTY
    ws.column_dimensions["E"].width = 10  # UNIT
    ws.column_dimensions["F"].width = 14  # UNIT PRICE
    ws.column_dimensions["G"].width = 14  # TOTAL

    # ── HEADER BLOCK ─────────────────────────────────────────────────────────
    ws.row_dimensions[1].height = 36
    ws.merge_cells("A1:D1")
    c = ws.cell(row=1, column=1, value="MEPIT")
    c.font = Font(bold=True, size=22, color="1A56DB", name="Calibri")
    c.alignment = Alignment(horizontal="left", vertical="center")

    q_num = meta.get("quote_number") or "Q-DRAFT"
    ws.merge_cells("E1:G1")
    cell(1, 5, q_num, bold=True, size=13, color="1E3A5F", align="right")

    ws.row_dimensions[2].height = 14
    ws.merge_cells("E2:G2")
    today_str = date.today().strftime("%b %d, %Y")
    cell(2, 5, f"Quote Date: {today_str}", size=9, color="555555", align="right", italic=True)

    ws.row_dimensions[3].height = 8
    ws.merge_cells("E3:G3")
    cell(3, 5, "DRAFT", bold=True, size=11, color="FFFFFF", bg="555555", align="right")

    # Separator line
    ws.row_dimensions[4].height = 4
    for col in range(1, 8):
        ws.cell(row=4, column=col).border = Border(bottom=Side(style="medium", color="1A56DB"))

    # ── QUOTE TO + QUOTE DETAILS ─────────────────────────────────────────────
    ws.row_dimensions[5].height = 14
    cell(5, 1, "QUOTE TO", bold=False, size=8, color="888888")
    cell(5, 4, "QUOTE DETAILS", bold=False, size=8, color="888888")

    ws.row_dimensions[6].height = 18
    client = meta.get("client_name") or ""
    cell(6, 1, client.upper() if client else "", bold=True, size=11, color="1E3A5F")

    valid_from = meta.get("valid_from") or date.today().isoformat()
    valid_until = meta.get("valid_until") or (date.today() + timedelta(days=30)).isoformat()
    version = meta.get("version") or 1
    items_count = len(items)

    cell(6, 4, f"Valid From: {valid_from}", size=9, color="333333")
    ws.row_dimensions[7].height = 14
    cell(7, 4, f"Valid Until: {valid_until}", size=9, color="333333")
    ws.row_dimensions[8].height = 14
    cell(8, 4, f"Version: {version}", size=9, color="333333")
    ws.row_dimensions[9].height = 14
    cell(9, 4, f"Items: {items_count}", size=9, color="333333")

    ws.row_dimensions[10].height = 8

    # ── TITLE & SCOPE ─────────────────────────────────────────────────────────
    ws.row_dimensions[11].height = 22
    ws.merge_cells("A11:G11")
    quote_title = meta.get("quote_title") or f"AI Quote — {project_name} Takeoff"
    cell(11, 1, quote_title, bold=True, size=13, color="1E3A5F")

    scope_notes = meta.get("scope_notes") or ""
    if scope_notes:
        ws.row_dimensions[12].height = 40
        ws.merge_cells("A12:G12")
        cell(12, 1, scope_notes, size=9, color="444444", wrap=True)
        scope_row_offset = 1
    else:
        scope_row_offset = 0

    ws.row_dimensions[12 + scope_row_offset].height = 8

    # ── LINE ITEMS (Simple Table) ────────────────────────────────────────────
    current_row = 13 + scope_row_offset
    grand_total = 0.0

    ws.row_dimensions[current_row].height = 18
    headers = ["#", "TYPE", "DESCRIPTION", "QTY", "UNIT", "UNIT PRICE", "TOTAL"]
    for ci, h in enumerate(headers, 1):
        c = cell(current_row, ci, h, bold=True, size=9, color="1E3A5F",
                 bg="EEF4FF", align="right" if ci >= 4 else "left")
        c.border = Border(
            bottom=Side(style="thin", color="BBBBBB"),
            top=Side(style="thin", color="BBBBBB"),
        )
    current_row += 1

    for item_idx, item in enumerate(items, 1):
        qty = float(item["qty"])
        unit_price = float(item["unit_price"])
        total = qty * unit_price
        grand_total += total

        bg_col = "FFFFFF" if item_idx % 2 == 1 else "F9FAFB"
        desc_text = (item["description"] or "").strip()
        notes_val = (item["notes"] or "").strip()
        full_desc = desc_text + (f"\n{notes_val}" if notes_val else "")
        num_lines = max(1, full_desc.count("\n") + 1)

        ws.row_dimensions[current_row].height = max(18, num_lines * 14)
        cell(current_row, 1, item_idx, size=9, color="888888", bg=bg_col, align="center")

        c_type = ws.cell(row=current_row, column=2)
        c_type.value = (item["item_type"] or "").upper()
        c_type.font = Font(bold=True, size=10, color="0F3D91", name="Calibri")
        c_type.alignment = Alignment(horizontal="left", vertical="center")
        c_type.fill = fill(bg_col)

        c_desc = ws.cell(row=current_row, column=3)
        c_desc.value = full_desc
        c_desc.font = Font(bold=False, size=9, color="444444", name="Calibri")
        c_desc.alignment = Alignment(horizontal="left", vertical="top", wrap_text=True)
        c_desc.fill = fill(bg_col)

        cell(current_row, 4, qty, size=10, color="111111", bg=bg_col, align="right")
        cell(current_row, 5, item["unit"], size=10, color="555555", bg=bg_col, align="center")
        cell(current_row, 6, f"${unit_price:,.2f}" if unit_price else "—",
             size=10, color="111111", bg=bg_col, align="right")
        cell(current_row, 7, f"${total:,.2f}" if unit_price else "—",
             bold=True, size=10, color="111111", bg=bg_col, align="right")

        for col in range(1, 8):
            ws.cell(row=current_row, column=col).border = Border(
                bottom=Side(style="thin", color="E5E7EB"),
            )

        current_row += 1

    # ── GRAND TOTALS ──────────────────────────────────────────────────────────
    ws.row_dimensions[current_row].height = 16
    ws.merge_cells(f"A{current_row}:F{current_row}")
    cell(current_row, 1, "Subtotal:", size=10, color="555555", bg="F9FAFB", align="right")
    cell(current_row, 7, f"${grand_total:,.2f}", size=10, color="555555", bg="F9FAFB", align="right")
    current_row += 1

    # Separator
    for col in range(1, 8):
        ws.cell(row=current_row, column=col).border = Border(
            top=Side(style="medium", color="1E3A5F")
        )
    ws.row_dimensions[current_row].height = 2
    current_row += 1

    ws.row_dimensions[current_row].height = 20
    ws.merge_cells(f"A{current_row}:F{current_row}")
    cell(current_row, 1, "Total:", bold=True, size=12, color="1E3A5F", align="right")
    cell(current_row, 7, f"${grand_total:,.2f}", bold=True, size=12, color="1E3A5F", align="right")

    # ── Stream response ───────────────────────────────────────────────────────
    buf = io.BytesIO()
    wb.save(buf)
    buf.seek(0)

    safe_name = "".join(c for c in project_name if c.isalnum() or c in " _-").strip()
    filename = f"BOQ_{safe_name}_{q_num}.xlsx".replace(" ", "_")

    return StreamingResponse(
        buf,
        media_type="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
        headers={"Content-Disposition": f'attachment; filename="{filename}"'},
    )
