from fastapi import APIRouter, HTTPException, Depends
from app.db import db, now
from app.storage import new_id
from app.schemas import DetectorOut, DetectorCreate, DetectorUpdate
from app.routers.auth import get_current_user

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
    )

@router.get("/projects/{project_id}/detectors", response_model=list[DetectorOut])
def list_detectors(project_id: str, user=Depends(get_current_user)):
    with db() as con:
        rows = con.execute(
            """
            SELECT d.*
            FROM detectors d
            JOIN projects p ON p.id = d.project_id
            WHERE d.project_id=? AND p.owner_id=?
            ORDER BY d.created_at ASC
            """,
            (project_id, user["id"]),
        ).fetchall()
    return [_row_to_out(r) for r in rows]

@router.post("/projects/{project_id}/detectors", response_model=DetectorOut)
def create_detector(project_id: str, payload: DetectorCreate, user=Depends(get_current_user)):
    did = new_id()
    with db() as con:
        # Ensure project exists
        p = con.execute("SELECT id FROM projects WHERE id=? AND owner_id=?", (project_id, user["id"])).fetchone()
        if not p:
            raise HTTPException(404, "project not found")
        con.execute(
            """INSERT INTO detectors (id,project_id,x,y,z,dtype,locked,created_at,updated_at)
                 VALUES (?,?,?,?,?,?,?,?,?)""",
            (did, project_id, float(payload.x), float(payload.y), float(payload.z),
             payload.dtype, 0, now(), now())
        )
        r = con.execute("SELECT * FROM detectors WHERE id=?", (did,)).fetchone()
    return _row_to_out(r)

@router.patch("/detectors/{detector_id}", response_model=DetectorOut)
def update_detector(detector_id: str, payload: DetectorUpdate, user=Depends(get_current_user)):
    with db() as con:
        r = con.execute(
            """
            SELECT d.*
            FROM detectors d
            JOIN projects p ON p.id = d.project_id
            WHERE d.id=? AND p.owner_id=?
            """,
            (detector_id, user["id"]),
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
    with db() as con:
        row = con.execute(
            """
            SELECT d.id
            FROM detectors d
            JOIN projects p ON p.id = d.project_id
            WHERE d.id=? AND p.owner_id=?
            """,
            (detector_id, user["id"]),
        ).fetchone()
        if not row:
            raise HTTPException(404, "detector not found")
        con.execute("DELETE FROM detectors WHERE id=?", (detector_id,))
    return {"ok": True}
