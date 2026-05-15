import os
import threading
import time
from contextlib import contextmanager

import psycopg2
from psycopg2.extras import DictCursor
from psycopg2.pool import ThreadedConnectionPool


_INIT_LOCK = threading.Lock()
_INIT_DONE = False
_SCHEMA_LOCK_KEY = 894332771

_POOL_LOCK = threading.Lock()
_POOL: ThreadedConnectionPool | None = None
_POOL_MIN = int(os.getenv("DB_POOL_MIN", "5"))
_POOL_MAX = int(os.getenv("DB_POOL_MAX", "50"))


def _translate_sql(sql: str) -> str:
    return sql.replace("?", "%s")


class _PgConnection:
    def __init__(self, connection):
        self._connection = connection

    def execute(self, sql, params=None):
        cursor = self._connection.cursor(cursor_factory=DictCursor)
        cursor.execute(_translate_sql(sql), params or ())
        return cursor

    def commit(self):
        self._connection.commit()

    def rollback(self):
        self._connection.rollback()

    def close(self):
        self._connection.close()

    @property
    def is_closed(self) -> bool:
        # psycopg2 sets .closed to 0 when open, non-zero when closed/broken.
        try:
            return bool(self._connection.closed)
        except Exception:
            return True


def _pg_connect_kwargs() -> dict:
    """Build the kwargs used for every psycopg2 connection."""
    dsn = os.getenv("DATABASE_URL")
    if dsn:
        return {"dsn": dsn, "cursor_factory": DictCursor}

    host = os.getenv("DB_HOST")
    cloud_sql_connection_name = os.getenv("CLOUD_SQL_CONNECTION_NAME")
    if cloud_sql_connection_name and not host:
        host = f"/cloudsql/{cloud_sql_connection_name}"

    if not host:
        raise RuntimeError("Set DATABASE_URL or DB_HOST/CLOUD_SQL_CONNECTION_NAME for PostgreSQL access")

    connect_kwargs = {
        "host": host,
        "port": os.getenv("DB_PORT", "5432"),
        "dbname": os.getenv("DB_NAME", "firecad"),
        "user": os.getenv("DB_USER", "postgres"),
        "password": os.getenv("DB_PASSWORD", ""),
        "cursor_factory": DictCursor,
    }
    sslmode = os.getenv("DB_SSLMODE")
    if sslmode:
        connect_kwargs["sslmode"] = sslmode
    # Keepalives help with Cloud SQL public-IP idle connections.
    connect_kwargs.setdefault("keepalives", 1)
    connect_kwargs.setdefault("keepalives_idle", 30)
    connect_kwargs.setdefault("keepalives_interval", 10)
    connect_kwargs.setdefault("keepalives_count", 5)
    return connect_kwargs


def _connect_postgres():
    kwargs = _pg_connect_kwargs()
    if "dsn" in kwargs:
        dsn = kwargs.pop("dsn")
        return psycopg2.connect(dsn, **kwargs)
    return psycopg2.connect(**kwargs)


def _get_pool() -> ThreadedConnectionPool:
    global _POOL
    if _POOL is not None:
        return _POOL
    with _POOL_LOCK:
        if _POOL is None:
            kwargs = _pg_connect_kwargs()
            if "dsn" in kwargs:
                dsn = kwargs.pop("dsn")
                _POOL = ThreadedConnectionPool(_POOL_MIN, _POOL_MAX, dsn, **kwargs)
            else:
                _POOL = ThreadedConnectionPool(_POOL_MIN, _POOL_MAX, **kwargs)
    return _POOL


def _init_postgres_db():
    con = _PgConnection(_connect_postgres())

    # Serialize schema changes across concurrent app instances/connections.
    con.execute("SELECT pg_advisory_lock(%s)", (_SCHEMA_LOCK_KEY,))
    try:
        con.execute(
            """
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
            """
        )
        con.execute("CREATE INDEX IF NOT EXISTS idx_projects_owner_id ON projects(owner_id)")
        con.execute("ALTER TABLE projects ADD COLUMN IF NOT EXISTS tenant_id TEXT")
        con.execute("CREATE INDEX IF NOT EXISTS idx_projects_tenant_id ON projects(tenant_id)")

        con.execute(
            """
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
                FOREIGN KEY(project_id) REFERENCES projects(id)
            )
            """
        )
        con.execute("ALTER TABLE detectors ADD COLUMN IF NOT EXISTS floor_plan_id TEXT")
        con.execute("ALTER TABLE detectors ADD COLUMN IF NOT EXISTS rotation_deg REAL NOT NULL DEFAULT 0.0")

        con.execute(
            """
            CREATE TABLE IF NOT EXISTS users (
                id TEXT PRIMARY KEY,
                name TEXT NOT NULL,
                email TEXT NOT NULL UNIQUE,
                pw_salt TEXT NOT NULL,
                pw_hash TEXT NOT NULL,
                created_at REAL
            )
            """
        )
        con.execute("ALTER TABLE users ADD COLUMN IF NOT EXISTS active_tenant_id TEXT")

        con.execute(
            """
            CREATE TABLE IF NOT EXISTS sessions (
                token TEXT PRIMARY KEY,
                user_id TEXT NOT NULL,
                expires_at REAL NOT NULL,
                created_at REAL,
                FOREIGN KEY(user_id) REFERENCES users(id)
            )
            """
        )

        con.execute(
            """
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
            """
        )
        con.execute("CREATE INDEX IF NOT EXISTS idx_floor_plans_project_id ON floor_plans(project_id)")
        con.execute("ALTER TABLE floor_plans ADD COLUMN IF NOT EXISTS height_m REAL")

        con.execute(
            """
            CREATE TABLE IF NOT EXISTS tenants (
                id TEXT PRIMARY KEY,
                name TEXT NOT NULL,
                created_by TEXT NOT NULL,
                created_at REAL,
                updated_at REAL,
                FOREIGN KEY(created_by) REFERENCES users(id)
            )
            """
        )

        con.execute(
            """
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
            """
        )
        con.execute("CREATE INDEX IF NOT EXISTS idx_tenant_members_tenant ON tenant_members(tenant_id)")
        con.execute("CREATE INDEX IF NOT EXISTS idx_tenant_members_user ON tenant_members(user_id)")

        con.execute(
            """
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
            """
        )
        con.execute("CREATE INDEX IF NOT EXISTS idx_activity_log_tenant ON activity_log(tenant_id)")
        con.execute("CREATE INDEX IF NOT EXISTS idx_activity_log_created ON activity_log(created_at DESC)")

        con.execute(
            """
            CREATE TABLE IF NOT EXISTS boq_items (
                id TEXT PRIMARY KEY,
                project_id TEXT NOT NULL,
                section TEXT NOT NULL DEFAULT '21 - Fire Suppression',
                item_type TEXT NOT NULL DEFAULT 'Material',
                description TEXT NOT NULL,
                qty REAL NOT NULL DEFAULT 1.0,
                unit TEXT NOT NULL DEFAULT 'unit',
                unit_price REAL NOT NULL DEFAULT 0.0,
                notes TEXT,
                sort_order INTEGER NOT NULL DEFAULT 0,
                created_at REAL,
                updated_at REAL,
                FOREIGN KEY(project_id) REFERENCES projects(id)
            )
            """
        )
        con.execute("CREATE INDEX IF NOT EXISTS idx_boq_items_project ON boq_items(project_id)")

        con.execute(
            """
            CREATE TABLE IF NOT EXISTS boq_meta (
                project_id TEXT PRIMARY KEY,
                client_name TEXT,
                quote_title TEXT,
                quote_number TEXT,
                valid_from TEXT,
                valid_until TEXT,
                version INTEGER DEFAULT 1,
                scope_notes TEXT,
                updated_at REAL,
                FOREIGN KEY(project_id) REFERENCES projects(id)
            )
            """
        )

        orphan_projects = con.execute(
            "SELECT p.id, p.owner_id FROM projects p WHERE p.tenant_id IS NULL AND p.owner_id IS NOT NULL"
        ).fetchall()
        for op in orphan_projects:
            tm = con.execute(
                "SELECT tenant_id FROM tenant_members WHERE user_id=? LIMIT 1",
                (op[1],),
            ).fetchone()
            if tm:
                con.execute("UPDATE projects SET tenant_id=? WHERE id=?", (tm[0], op[0]))

        users_without_tenant = con.execute(
            "SELECT u.id, u.name FROM users u WHERE u.id NOT IN (SELECT user_id FROM tenant_members)"
        ).fetchall()
        for u in users_without_tenant:
            import uuid as _uuid

            tid = str(_uuid.uuid4())
            mid = str(_uuid.uuid4())
            t = time.time()
            con.execute(
                "INSERT INTO tenants(id, name, created_by, created_at, updated_at) VALUES(?,?,?,?,?)",
                (tid, f"{u[1]}'s Team", u[0], t, t),
            )
            con.execute(
                "INSERT INTO tenant_members(id, tenant_id, user_id, role, created_at, updated_at) VALUES(?,?,?,?,?,?)",
                (mid, tid, u[0], "admin", t, t),
            )
            con.execute("UPDATE users SET active_tenant_id=? WHERE id=? AND active_tenant_id IS NULL", (tid, u[0]))
            con.execute("UPDATE projects SET tenant_id=? WHERE owner_id=? AND tenant_id IS NULL", (tid, u[0]))

        con.commit()
    finally:
        try:
            con.execute("SELECT pg_advisory_unlock(%s)", (_SCHEMA_LOCK_KEY,))
        finally:
            con.close()


def init_db():
    global _INIT_DONE
    if _INIT_DONE:
        return

    with _INIT_LOCK:
        if _INIT_DONE:
            return
        _init_postgres_db()
        _INIT_DONE = True


def _is_connection_alive(raw) -> bool:
    """Cheap liveness probe — runs `SELECT 1` and returns False if the
    connection has been killed server-side (e.g. Cloud SQL idle timeout,
    `SSL SYSCALL error: EOF detected`). The probe is wrapped in its own
    try/rollback so a dead conn doesn't poison subsequent reuse. On failure
    the underlying exception is stashed on the connection as
    ``_probe_error`` so the caller can surface it instead of a generic
    "no live connection" message."""
    try:
        if getattr(raw, "closed", 0):
            return False
        cur = raw.cursor()
        try:
            cur.execute("SELECT 1")
            cur.fetchone()
        finally:
            cur.close()
        # The probe leaves an open transaction; close it cleanly.
        raw.rollback()
        return True
    except Exception as exc:
        try:
            raw._probe_error = exc  # type: ignore[attr-defined]
        except Exception:
            pass
        try:
            raw.close()
        except Exception:
            pass
        return False


def _reset_pool() -> None:
    """Drop the cached pool so the next `_get_pool()` creates fresh
    connections. Safe to call when every connection in the current pool
    has been confirmed dead (e.g. after a DB outage)."""
    global _POOL
    with _POOL_LOCK:
        old = _POOL
        _POOL = None
    if old is not None:
        try:
            old.closeall()
        except Exception:
            pass


def _checkout_live_connection(pool: ThreadedConnectionPool, max_attempts: int | None = None):
    """Borrow a connection from the pool, discarding any dead ones so a
    poisoned conn from an earlier outage doesn't fail the request. If the
    entire pool is dead, we reset the pool once so the next call rebuilds
    it cleanly. The last underlying error is re-raised so the caller sees
    the actual reason (e.g. ``connection refused``)."""
    # Try at least enough times to drain every idle conn in the pool, plus
    # a few extra to allow for connections that go bad between probes.
    if max_attempts is None:
        max_attempts = max(_POOL_MAX, _POOL_MIN) + 3

    last_exc: BaseException | None = None
    for _ in range(max_attempts):
        try:
            raw = pool.getconn()
        except Exception as e:
            # Pool itself failed (e.g. exhausted, or initial conn failed).
            last_exc = e
            break

        try:
            if _is_connection_alive(raw):
                return raw
            # _is_connection_alive already tried to close `raw`; record the
            # reason it died if it left one on the connection.
            close_reason = getattr(raw, "_probe_error", None)
            if close_reason is not None:
                last_exc = close_reason
        except Exception as e:  # pragma: no cover — defensive
            last_exc = e

        # Discard the bad conn so the pool can open a fresh one.
        try:
            pool.putconn(raw, close=True)
        except Exception:
            try:
                raw.close()
            except Exception:
                pass

    # All attempts produced dead connections — nuke the pool so the next
    # request starts clean.
    _reset_pool()

    if last_exc is not None:
        raise last_exc
    raise psycopg2.OperationalError("Could not obtain a live database connection")


@contextmanager
def db():
    init_db()
    pool = _get_pool()
    raw = _checkout_live_connection(pool)
    con = _PgConnection(raw)
    dead = False
    try:
        yield con
    except Exception:
        # Try a best-effort rollback, but treat a closed/broken connection
        # as dead so we don't return it to the pool to poison the next
        # request. psycopg2's `.closed` is non-zero for closed/broken conns.
        try:
            con.rollback()
        except Exception:
            dead = True
        if not dead and con.is_closed:
            dead = True
        raise
    else:
        try:
            con.commit()
        except Exception:
            dead = True
            raise
    finally:
        try:
            pool.putconn(raw, close=dead)
        except Exception:
            # If the pool itself rejects the connection, drop it on the floor.
            try:
                raw.close()
            except Exception:
                pass


def now():
    return time.time()


def log_activity(con, user: dict, action: str, target_type: str = None, target_id: str = None, target_name: str = None):
    import uuid as _uuid

    con.execute(
        """INSERT INTO activity_log (id, tenant_id, user_id, user_name, action, target_type, target_id, target_name, created_at)
           VALUES (?,?,?,?,?,?,?,?,?)""",
        (
            str(_uuid.uuid4()),
            user.get("active_tenant_id"),
            user["id"],
            user.get("name", "Unknown"),
            action,
            target_type,
            target_id,
            target_name,
            now(),
        ),
    )
