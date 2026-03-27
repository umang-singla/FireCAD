from fastapi import APIRouter, Depends, Query
from app.db import db
from app.routers.auth import get_current_user

router = APIRouter(tags=["activity"])


@router.get("/activity")
def get_activity(
    limit: int = Query(30, ge=1, le=100),
    user=Depends(get_current_user),
):
    """Return recent activity for the user's active tenant."""
    tid = user.get("active_tenant_id")
    if not tid:
        return []
    with db() as con:
        rows = con.execute(
            """SELECT id, tenant_id, user_id, user_name, action, target_type, target_id, target_name, created_at
               FROM activity_log
               WHERE tenant_id = ?
               ORDER BY created_at DESC
               LIMIT ?""",
            (tid, limit),
        ).fetchall()
    return [
        {
            "id": r["id"],
            "user_name": r["user_name"],
            "action": r["action"],
            "target_type": r["target_type"],
            "target_id": r["target_id"],
            "target_name": r["target_name"],
            "created_at": r["created_at"],
        }
        for r in rows
    ]
