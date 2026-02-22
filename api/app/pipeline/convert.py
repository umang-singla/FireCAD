import os
import subprocess
import shutil

def has_oda() -> bool:
    return bool(os.getenv("ODA_PATH", "").strip())

def dwg_to_dxf(dwg_path: str, out_dir: str) -> str:
    oda = os.getenv("ODA_PATH", "").strip()
    if not oda:
        raise RuntimeError(
            "DWG uploaded but ODA_PATH is not set. "
            "Install ODAFileConverter and set ODA_PATH, or upload DXF."
        )
    if not os.path.exists(oda):
        raise RuntimeError(f"ODA_PATH does not exist: {oda}")

    os.makedirs(out_dir, exist_ok=True)
    # ODAFileConverter CLI format:
    # ODAFileConverter <inFolder> <outFolder> <outVersion> <outType> <recurse> <audit> <inputFilter>
    # We'll convert a single file by putting it in a temp folder.
    tmp_in = os.path.join(out_dir, "_in")
    tmp_out = os.path.join(out_dir, "_out")
    os.makedirs(tmp_in, exist_ok=True)
    os.makedirs(tmp_out, exist_ok=True)

    base = os.path.basename(dwg_path)
    shutil.copy2(dwg_path, os.path.join(tmp_in, base))

    cmd = [oda, tmp_in, tmp_out, "ACAD2018", "DXF", "0", "1", "*.dwg"]
    subprocess.run(cmd, check=True)

    # Find produced DXF
    for fn in os.listdir(tmp_out):
        if fn.lower().endswith(".dxf"):
            return os.path.join(tmp_out, fn)

    raise RuntimeError("ODA conversion produced no DXF output.")
