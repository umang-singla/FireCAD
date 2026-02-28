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
        dtype TEXT NOT NULL DEFAULT 'smoke',
        locked INTEGER NOT NULL DEFAULT 0,
        created_at REAL,
        updated_at REAL,
        FOREIGN KEY(project_id) REFERENCES projects(id)
    )
    """)

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
