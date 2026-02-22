import os
import uuid

DATA_DIR = os.getenv("DATA_DIR", "/data")

def new_id() -> str:
    return str(uuid.uuid4())

def project_dir(project_id: str) -> str:
    d = os.path.join(DATA_DIR, "projects", project_id)
    os.makedirs(d, exist_ok=True)
    return d

def relpath(abs_path: str) -> str:
    # Convert absolute path under DATA_DIR into /files/... URL path segment
    abs_path = os.path.abspath(abs_path)
    base = os.path.abspath(DATA_DIR)
    if not abs_path.startswith(base):
        raise ValueError("path not under DATA_DIR")
    return abs_path[len(base):].lstrip(os.sep)
