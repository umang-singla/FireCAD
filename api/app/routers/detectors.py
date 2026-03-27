from fastapi import APIRouter, HTTPException, Depends, Query
from typing import Optional
from app.db import db, now
from app.storage import new_id
from app.schemas import DetectorOut, DetectorCreate, DetectorUpdate
from app.routers.auth import get_current_user
from app.routers.projects import _authorize_project, _authorize_project_write

router = APIRouter(tags=["detectors"])

def _row_to_out(r) -> DetectorOut:
    return DetectorOut(
        id=r["id"],
        project_id=r["project_id"],
        x=float(r["x"]),
        y=float(r["y"]),
        z=float(r["z"]),
        dtype=r["dtype"],
        locked=bool(r["locked"]),
        floor_plan_id=r["floor_plan_id"] if "floor_plan_id" in r.keys() else None,
    )


def _detector_access_filter(user: dict):
    """Build SQL fragment and params for detector access control via project ownership or tenant."""
    tid = user.get("active_tenant_id")
    if tid:
        return "(p.owner_id = ? OR p.tenant_id = ?)", [user["id"], tid]
    return "p.owner_id = ?", [user["id"]]


@router.get("/projects/{project_id}/detectors", response_model=list[DetectorOut])
def list_detectors(project_id: str, floor_plan_id: Optional[str] = Query(None), user=Depends(get_current_user)):
    filt, filt_params = _detector_access_filter(user)
    with db() as con:
        if floor_plan_id:
            rows = con.execute(
                f"""
                SELECT d.*
                FROM detectors d
                JOIN projects p ON p.id = d.project_id
                WHERE d.project_id=? AND {filt} AND d.floor_plan_id=?
                ORDER BY d.created_at ASC
                """,
                [project_id, *filt_params, floor_plan_id],
            ).fetchall()
        else:
            rows = con.execute(
                f"""
                SELECT d.*
                FROM detectors d
                JOIN projects p ON p.id = d.project_id
                WHERE d.project_id=? AND {filt}
                ORDER BY d.created_at ASC
                """,
                [project_id, *filt_params],
            ).fetchall()
    return [_row_to_out(r) for r in rows]

@router.post("/projects/{project_id}/detectors", response_model=DetectorOut)
def create_detector(project_id: str, payload: DetectorCreate, user=Depends(get_current_user)):
    did = new_id()
    with db() as con:
        _authorize_project_write(con, project_id, user)
        con.execute(
            """INSERT INTO detectors (id,project_id,x,y,z,dtype,locked,floor_plan_id,created_at,updated_at)
                 VALUES (?,?,?,?,?,?,?,?,?,?)""",
            (did, project_id, float(payload.x), float(payload.y), float(payload.z),
             payload.dtype, 0, payload.floor_plan_id, now(), now())
        )
        r = con.execute("SELECT * FROM detectors WHERE id=?", (did,)).fetchone()
    return _row_to_out(r)

@router.patch("/detectors/{detector_id}", response_model=DetectorOut)
def update_detector(detector_id: str, payload: DetectorUpdate, user=Depends(get_current_user)):
    if user.get("tenant_role") == "viewer":
        raise HTTPException(403, "Viewers have read-only access")
    filt, filt_params = _detector_access_filter(user)
    with db() as con:
        r = con.execute(
            f"""
            SELECT d.*
            FROM detectors d
            JOIN projects p ON p.id = d.project_id
            WHERE d.id=? AND {filt}
            """,
            [detector_id, *filt_params],
        ).fetchone()
        if not r:
            raise HTTPException(404, "detector not found")

        dtype = payload.dtype if payload.dtype is not None else r["dtype"]
        locked = int(payload.locked) if payload.locked is not None else int(r["locked"])

        con.execute(
            "UPDATE detectors SET x=?, y=?, z=?, dtype=?, locked=?, updated_at=? WHERE id=?",
            (float(payload.x), float(payload.y), float(payload.z), dtype, locked, now(), detector_id)
        )
        r2 = con.execute("SELECT * FROM detectors WHERE id=?", (detector_id,)).fetchone()
    return _row_to_out(r2)

@router.delete("/detectors/{detector_id}")
def delete_detector(detector_id: str, user=Depends(get_current_user)):
    if user.get("tenant_role") == "viewer":
        raise HTTPException(403, "Viewers have read-only access")
    filt, filt_params = _detector_access_filter(user)
    with db() as con:
        row = con.execute(
            f"""
            SELECT d.id
            FROM detectors d
            JOIN projects p ON p.id = d.project_id
            WHERE d.id=? AND {filt}
            """,
            [detector_id, *filt_params],
        ).fetchone()
        if not row:
            raise HTTPException(404, "detector not found")
        con.execute("DELETE FROM detectors WHERE id=?", (detector_id,))
    return {"ok": True}
