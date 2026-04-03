import uuid
from fastapi import APIRouter, HTTPException, Depends
from pydantic import BaseModel, Field
from typing import Optional

from app.db import db, now, log_activity
from app.routers.auth import get_current_user, require_tenant_role, ROLE_ADMIN, ROLE_EDITOR, ROLE_VIEWER, VALID_ROLES

router = APIRouter(prefix="/teams", tags=["teams"])


# ── Pydantic models ──────────────────────────────────────────

class TenantCreate(BaseModel):
    name: str = Field(min_length=1, max_length=200)

class TenantUpdate(BaseModel):
    name: str = Field(min_length=1, max_length=200)

class InviteMember(BaseModel):
    email: str
    role: str = ROLE_VIEWER

class UpdateMemberRole(BaseModel):
    role: str

class SwitchTenant(BaseModel):
    tenant_id: str


# ── Tenant CRUD ──────────────────────────────────────────────

@router.get("")
def list_my_tenants(user=Depends(get_current_user)):
    """List all tenants the current user belongs to."""
    with db() as con:
        rows = con.execute(
            """
            SELECT t.id, t.name, t.created_at, tm.role
            FROM tenants t
            JOIN tenant_members tm ON tm.tenant_id = t.id
            WHERE tm.user_id = ?
            ORDER BY t.created_at ASC
            """,
            (user["id"],),
        ).fetchall()
    return [
        {
            "id": r["id"],
            "name": r["name"],
            "role": r["role"],
            "is_active": r["id"] == user.get("active_tenant_id"),
            "created_at": r["created_at"],
        }
        for r in rows
    ]


@router.post("")
def create_tenant(payload: TenantCreate, user=Depends(get_current_user)):
    """Create a new tenant. The creator becomes admin."""
    tenant_id = str(uuid.uuid4())
    member_id = str(uuid.uuid4())
    with db() as con:
        con.execute(
            "INSERT INTO tenants(id, name, created_by, created_at, updated_at) VALUES(?,?,?,?,?)",
            (tenant_id, payload.name, user["id"], now(), now()),
        )
        con.execute(
            "INSERT INTO tenant_members(id, tenant_id, user_id, role, created_at, updated_at) VALUES(?,?,?,?,?,?)",
            (member_id, tenant_id, user["id"], ROLE_ADMIN, now(), now()),
        )
    return {"id": tenant_id, "name": payload.name, "role": ROLE_ADMIN}


@router.get("/{tenant_id}")
def get_tenant(tenant_id: str, user=Depends(get_current_user)):
    """Get tenant details (must be a member)."""
    with db() as con:
        tm = con.execute(
            "SELECT role FROM tenant_members WHERE tenant_id=? AND user_id=?",
            (tenant_id, user["id"]),
        ).fetchone()
        if not tm:
            raise HTTPException(403, "Not a member of this team")
        t = con.execute("SELECT * FROM tenants WHERE id=?", (tenant_id,)).fetchone()
        if not t:
            raise HTTPException(404, "Team not found")
        member_count = con.execute(
            "SELECT COUNT(*) FROM tenant_members WHERE tenant_id=?", (tenant_id,)
        ).fetchone()[0]
    return {
        "id": t["id"],
        "name": t["name"],
        "role": tm["role"],
        "member_count": member_count,
        "created_at": t["created_at"],
    }


@router.patch("/{tenant_id}")
def update_tenant(tenant_id: str, payload: TenantUpdate, user=Depends(get_current_user)):
    """Rename a tenant (admin only)."""
    with db() as con:
        tm = con.execute(
            "SELECT role FROM tenant_members WHERE tenant_id=? AND user_id=?",
            (tenant_id, user["id"]),
        ).fetchone()
        if not tm or tm["role"] != ROLE_ADMIN:
            raise HTTPException(403, "Admin access required")
        con.execute(
            "UPDATE tenants SET name=?, updated_at=? WHERE id=?",
            (payload.name, now(), tenant_id),
        )
    return {"ok": True, "name": payload.name}


@router.post("/switch")
def switch_tenant(payload: SwitchTenant, user=Depends(get_current_user)):
    """Switch user's active tenant."""
    with db() as con:
        tm = con.execute(
            "SELECT role FROM tenant_members WHERE tenant_id=? AND user_id=?",
            (payload.tenant_id, user["id"]),
        ).fetchone()
        if not tm:
            raise HTTPException(403, "Not a member of this team")
        con.execute(
            "UPDATE users SET active_tenant_id=? WHERE id=?",
            (payload.tenant_id, user["id"]),
        )
    return {"ok": True, "active_tenant_id": payload.tenant_id}


# ── Member management ────────────────────────────────────────

@router.get("/{tenant_id}/members")
def list_members(tenant_id: str, user=Depends(get_current_user)):
    """List all members of a tenant."""
    with db() as con:
        # Verify caller is a member
        tm = con.execute(
            "SELECT role FROM tenant_members WHERE tenant_id=? AND user_id=?",
            (tenant_id, user["id"]),
        ).fetchone()
        if not tm:
            raise HTTPException(403, "Not a member of this team")

        rows = con.execute(
            """
            SELECT tm.id AS member_id, tm.role, tm.created_at,
                   u.id AS user_id, u.name, u.email
            FROM tenant_members tm
            JOIN users u ON u.id = tm.user_id
            WHERE tm.tenant_id = ?
            ORDER BY tm.created_at ASC
            """,
            (tenant_id,),
        ).fetchall()
    return [
        {
            "member_id": r["member_id"],
            "user_id": r["user_id"],
            "name": r["name"],
            "email": r["email"],
            "role": r["role"],
            "created_at": r["created_at"],
        }
        for r in rows
    ]


@router.post("/{tenant_id}/members")
def invite_member(tenant_id: str, payload: InviteMember, user=Depends(get_current_user)):
    """Invite a user to the tenant by email (admin only)."""
    if payload.role not in VALID_ROLES:
        raise HTTPException(400, f"Invalid role. Must be one of: {', '.join(VALID_ROLES)}")

    with db() as con:
        # Verify caller is admin
        tm = con.execute(
            "SELECT role FROM tenant_members WHERE tenant_id=? AND user_id=?",
            (tenant_id, user["id"]),
        ).fetchone()
        if not tm or tm["role"] != ROLE_ADMIN:
            raise HTTPException(403, "Admin access required")

        # Find invitee
        invitee = con.execute("SELECT id, name, email FROM users WHERE email=?", (payload.email,)).fetchone()
        if not invitee:
            raise HTTPException(404, "User not found. They must register first.")

        # Check not already a member
        existing = con.execute(
            "SELECT id FROM tenant_members WHERE tenant_id=? AND user_id=?",
            (tenant_id, invitee["id"]),
        ).fetchone()
        if existing:
            raise HTTPException(409, "User is already a member of this team")

        member_id = str(uuid.uuid4())
        con.execute(
            "INSERT INTO tenant_members(id, tenant_id, user_id, role, created_at, updated_at) VALUES(?,?,?,?,?,?)",
            (member_id, tenant_id, invitee["id"], payload.role, now(), now()),
        )
        log_activity(con, user, "invited_member", "member", invitee["id"], invitee["name"])

    return {
        "member_id": member_id,
        "user_id": invitee["id"],
        "name": invitee["name"],
        "email": invitee["email"],
        "role": payload.role,
    }


@router.patch("/{tenant_id}/members/{member_id}")
def update_member_role(tenant_id: str, member_id: str, payload: UpdateMemberRole, user=Depends(get_current_user)):
    """Change a member's role (admin only). Cannot demote the last admin."""
    if payload.role not in VALID_ROLES:
        raise HTTPException(400, f"Invalid role. Must be one of: {', '.join(VALID_ROLES)}")

    with db() as con:
        # Verify caller is admin
        tm = con.execute(
            "SELECT role FROM tenant_members WHERE tenant_id=? AND user_id=?",
            (tenant_id, user["id"]),
        ).fetchone()
        if not tm or tm["role"] != ROLE_ADMIN:
            raise HTTPException(403, "Admin access required")

        # Find the target member
        target = con.execute(
            "SELECT id, user_id, role FROM tenant_members WHERE id=? AND tenant_id=?",
            (member_id, tenant_id),
        ).fetchone()
        if not target:
            raise HTTPException(404, "Member not found")

        # Prevent removing the last admin
        if target["role"] == ROLE_ADMIN and payload.role != ROLE_ADMIN:
            admin_count = con.execute(
                "SELECT COUNT(*) FROM tenant_members WHERE tenant_id=? AND role=?",
                (tenant_id, ROLE_ADMIN),
            ).fetchone()[0]
            if admin_count <= 1:
                raise HTTPException(400, "Cannot demote the last admin")

        con.execute(
            "UPDATE tenant_members SET role=?, updated_at=? WHERE id=?",
            (payload.role, now(), member_id),
        )
        # Get member name for activity log
        target_user = con.execute("SELECT name FROM users WHERE id=?", (target["user_id"],)).fetchone()
        log_activity(con, user, "changed_role", "member", target["user_id"],
                     f"{target_user['name'] if target_user else 'Unknown'} → {payload.role}")

    return {"ok": True, "member_id": member_id, "role": payload.role}


@router.delete("/{tenant_id}/members/{member_id}")
def remove_member(tenant_id: str, member_id: str, user=Depends(get_current_user)):
    """Remove a member from the tenant (admin only). Cannot remove the last admin."""
    with db() as con:
        # Verify caller is admin
        tm = con.execute(
            "SELECT role FROM tenant_members WHERE tenant_id=? AND user_id=?",
            (tenant_id, user["id"]),
        ).fetchone()
        if not tm or tm["role"] != ROLE_ADMIN:
            raise HTTPException(403, "Admin access required")

        target = con.execute(
            "SELECT id, user_id, role FROM tenant_members WHERE id=? AND tenant_id=?",
            (member_id, tenant_id),
        ).fetchone()
        if not target:
            raise HTTPException(404, "Member not found")

        # Prevent removing the last admin
        if target["role"] == ROLE_ADMIN:
            admin_count = con.execute(
                "SELECT COUNT(*) FROM tenant_members WHERE tenant_id=? AND role=?",
                (tenant_id, ROLE_ADMIN),
            ).fetchone()[0]
            if admin_count <= 1:
                raise HTTPException(400, "Cannot remove the last admin")

        # Get member name for activity log before deleting
        target_user = con.execute("SELECT name FROM users WHERE id=?", (target["user_id"],)).fetchone()
        con.execute("DELETE FROM tenant_members WHERE id=?", (member_id,))
        log_activity(con, user, "removed_member", "member", target["user_id"],
                     target_user["name"] if target_user else "Unknown")

        # If the removed user had this as active tenant, clear it
        con.execute(
            "UPDATE users SET active_tenant_id=NULL WHERE id=? AND active_tenant_id=?",
            (target["user_id"], tenant_id),
        )

    return {"ok": True}
