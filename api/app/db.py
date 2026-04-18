import os
import sqlite3
import time
from contextlib import contextmanager

DATA_DIR = os.getenv("DATA_DIR", "/data")
DB_PATH = os.path.join(DATA_DIR, "firecad.sqlite")

def init_db():
    os.makedirs(DATA_DIR, exist_ok=True)
    con = sqlite3.connect(DB_PATH)
    cur = con.cursor()

    cur.execute("""
    CREATE TABLE IF NOT EXISTS projects (
        id TEXT PRIMARY KEY,
        owner_id TEXT,
        name TEXT NOT NULL,
        status TEXT NOT NULL,
        error TEXT,
        input_filename TEXT,
        input_path TEXT,
        dxf_path TEXT,
        render_png_path TEXT,
        mapping_json_path TEXT,
        mask_png_path TEXT,
        aligned_mask_path TEXT,
        fixed_wall_path TEXT,
        rooms_json_path TEXT,
        output_dxf_path TEXT,
        output_preview_png_path TEXT,
        settings_json TEXT,
        created_at REAL,
        updated_at REAL
    )
    """)

    project_cols = {row[1] for row in cur.execute("PRAGMA table_info(projects)").fetchall()}
    if "owner_id" not in project_cols:
        cur.execute("ALTER TABLE projects ADD COLUMN owner_id TEXT")

    cur.execute("CREATE INDEX IF NOT EXISTS idx_projects_owner_id ON projects(owner_id)")

    cur.execute("""
    CREATE TABLE IF NOT EXISTS detectors (
        id TEXT PRIMARY KEY,
        project_id TEXT NOT NULL,
        x REAL NOT NULL,
        y REAL NOT NULL,
        z REAL NOT NULL DEFAULT 0.0,
        rotation_deg REAL NOT NULL DEFAULT 0.0,
        dtype TEXT NOT NULL DEFAULT 'smoke',
        locked INTEGER NOT NULL DEFAULT 0,
        floor_plan_id TEXT,
        created_at REAL,
        updated_at REAL,
        FOREIGN KEY(project_id) REFERENCES projects(id),
        FOREIGN KEY(floor_plan_id) REFERENCES floor_plans(id)
    )
    """)

    det_cols = {row[1] for row in cur.execute("PRAGMA table_info(detectors)").fetchall()}
    if "floor_plan_id" not in det_cols:
        cur.execute("ALTER TABLE detectors ADD COLUMN floor_plan_id TEXT")
    if "rotation_deg" not in det_cols:
        cur.execute("ALTER TABLE detectors ADD COLUMN rotation_deg REAL NOT NULL DEFAULT 0.0")

    # ✅ auth tables
    cur.execute("""
    CREATE TABLE IF NOT EXISTS users (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        email TEXT NOT NULL UNIQUE,
        pw_salt TEXT NOT NULL,
        pw_hash TEXT NOT NULL,
        created_at REAL
    )
    """)

    cur.execute("""
    CREATE TABLE IF NOT EXISTS sessions (
        token TEXT PRIMARY KEY,
        user_id TEXT NOT NULL,
        expires_at REAL NOT NULL,
        created_at REAL,
        FOREIGN KEY(user_id) REFERENCES users(id)
    )
    """)

    cur.execute("""
    CREATE TABLE IF NOT EXISTS floor_plans (
        id TEXT PRIMARY KEY,
        project_id TEXT NOT NULL,
        block_index INTEGER NOT NULL,
        world_bbox_json TEXT,
        pixel_bbox_json TEXT,
        render_png_path TEXT,
        mapping_json_path TEXT,
        mask_png_path TEXT,
        aligned_mask_path TEXT,
        fixed_wall_path TEXT,
        rooms_json_path TEXT,
        status TEXT NOT NULL DEFAULT 'created',
        created_at REAL,
        updated_at REAL,
        FOREIGN KEY(project_id) REFERENCES projects(id)
    )
    """)

    cur.execute("CREATE INDEX IF NOT EXISTS idx_floor_plans_project_id ON floor_plans(project_id)")

    floor_plan_cols = {row[1] for row in cur.execute("PRAGMA table_info(floor_plans)").fetchall()}
    if "height_m" not in floor_plan_cols:
        cur.execute("ALTER TABLE floor_plans ADD COLUMN height_m REAL")

    # ── Tenants (companies / teams) ──
    cur.execute("""
    CREATE TABLE IF NOT EXISTS tenants (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        created_by TEXT NOT NULL,
        created_at REAL,
        updated_at REAL,
        FOREIGN KEY(created_by) REFERENCES users(id)
    )
    """)

    cur.execute("""
    CREATE TABLE IF NOT EXISTS tenant_members (
        id TEXT PRIMARY KEY,
        tenant_id TEXT NOT NULL,
        user_id TEXT NOT NULL,
        role TEXT NOT NULL DEFAULT 'viewer',
        created_at REAL,
        updated_at REAL,
        FOREIGN KEY(tenant_id) REFERENCES tenants(id),
        FOREIGN KEY(user_id) REFERENCES users(id),
        UNIQUE(tenant_id, user_id)
    )
    """)

    cur.execute("CREATE INDEX IF NOT EXISTS idx_tenant_members_tenant ON tenant_members(tenant_id)")
    cur.execute("CREATE INDEX IF NOT EXISTS idx_tenant_members_user ON tenant_members(user_id)")

    # Add tenant_id to projects if missing
    project_cols2 = {row[1] for row in cur.execute("PRAGMA table_info(projects)").fetchall()}
    if "tenant_id" not in project_cols2:
        cur.execute("ALTER TABLE projects ADD COLUMN tenant_id TEXT")
    cur.execute("CREATE INDEX IF NOT EXISTS idx_projects_tenant_id ON projects(tenant_id)")

    # Add active_tenant_id to users if missing
    user_cols = {row[1] for row in cur.execute("PRAGMA table_info(users)").fetchall()}
    if "active_tenant_id" not in user_cols:
        cur.execute("ALTER TABLE users ADD COLUMN active_tenant_id TEXT")

    # ── Migrate orphan projects: assign tenant_id from owner's active tenant ──
    orphan_projects = cur.execute(
        "SELECT p.id, p.owner_id FROM projects p WHERE p.tenant_id IS NULL AND p.owner_id IS NOT NULL"
    ).fetchall()
    for op in orphan_projects:
        # Find the owner's first tenant
        tm = cur.execute(
            "SELECT tenant_id FROM tenant_members WHERE user_id=? LIMIT 1",
            (op[1],),
        ).fetchone()
        if tm:
            cur.execute("UPDATE projects SET tenant_id=? WHERE id=?", (tm[0], op[0]))

    # ── Migrate users without a tenant: create a personal team ──
    users_without_tenant = cur.execute(
        "SELECT u.id, u.name FROM users u WHERE u.id NOT IN (SELECT user_id FROM tenant_members)"
    ).fetchall()
    for u in users_without_tenant:
        import uuid as _uuid
        tid = str(_uuid.uuid4())
        mid = str(_uuid.uuid4())
        t = time.time()
        cur.execute(
            "INSERT INTO tenants(id, name, created_by, created_at, updated_at) VALUES(?,?,?,?,?)",
            (tid, f"{u[1]}'s Team", u[0], t, t),
        )
        cur.execute(
            "INSERT INTO tenant_members(id, tenant_id, user_id, role, created_at, updated_at) VALUES(?,?,?,?,?,?)",
            (mid, tid, u[0], "admin", t, t),
        )
        cur.execute("UPDATE users SET active_tenant_id=? WHERE id=? AND active_tenant_id IS NULL", (tid, u[0]))
        # Also assign this user's orphan projects
        cur.execute("UPDATE projects SET tenant_id=? WHERE owner_id=? AND tenant_id IS NULL", (tid, u[0]))

    # ── Activity log ──
    cur.execute("""
    CREATE TABLE IF NOT EXISTS activity_log (
        id TEXT PRIMARY KEY,
        tenant_id TEXT,
        user_id TEXT,
        user_name TEXT,
        action TEXT NOT NULL,
        target_type TEXT,
        target_id TEXT,
        target_name TEXT,
        created_at REAL,
        FOREIGN KEY(tenant_id) REFERENCES tenants(id),
        FOREIGN KEY(user_id) REFERENCES users(id)
    )
    """)
    cur.execute("CREATE INDEX IF NOT EXISTS idx_activity_log_tenant ON activity_log(tenant_id)")
    cur.execute("CREATE INDEX IF NOT EXISTS idx_activity_log_created ON activity_log(created_at DESC)")

    con.commit()
    con.close()

@contextmanager
def db():
    init_db()
    con = sqlite3.connect(DB_PATH)
    con.row_factory = sqlite3.Row
    try:
        yield con
    finally:
        con.commit()
        con.close()

def now():
    return time.time()


def log_activity(con, user: dict, action: str, target_type: str = None, target_id: str = None, target_name: str = None):
    """Insert an activity log entry for the current user's active tenant."""
    import uuid as _uuid
    con.execute(
        """INSERT INTO activity_log (id, tenant_id, user_id, user_name, action, target_type, target_id, target_name, created_at)
           VALUES (?,?,?,?,?,?,?,?,?)""",
        (str(_uuid.uuid4()), user.get("active_tenant_id"), user["id"], user.get("name", "Unknown"),
         action, target_type, target_id, target_name, now()),
    )
