import os
import subprocess
import shutil
import time
import logging

logger = logging.getLogger("firecad.pipeline.convert")


def _tail(text: str, lines: int = 20) -> str:
    if not text:
        return ""
    parts = text.splitlines()
    return "\n".join(parts[-lines:])

def has_oda() -> bool:
    return bool(os.getenv("ODA_PATH", "").strip())

def dwg_to_dxf(dwg_path: str, out_dir: str) -> str:
    start_ts = time.perf_counter()
    logger.info("convert stage=start input=%s out_dir=%s", dwg_path, out_dir)

    oda = os.getenv("ODA_PATH", "").strip()
    if not oda:
        logger.error("convert stage=validate status=failed reason=oda_path_not_set")
        raise RuntimeError(
            "DWG uploaded but ODA_PATH is not set. "
            "Install ODAFileConverter and set ODA_PATH, or upload DXF."
        )
    if not os.path.exists(oda):
        logger.error("convert stage=validate status=failed reason=oda_path_missing path=%s", oda)
        raise RuntimeError(f"ODA_PATH does not exist: {oda}")

    logger.info("convert stage=validate status=done oda=%s", oda)

    os.makedirs(out_dir, exist_ok=True)
    # ODAFileConverter CLI format:
    # ODAFileConverter <inFolder> <outFolder> <outVersion> <outType> <recurse> <audit> <inputFilter>
    # We'll convert a single file by putting it in a temp folder.
    tmp_in = os.path.join(out_dir, "_in")
    tmp_out = os.path.join(out_dir, "_out")
    os.makedirs(tmp_in, exist_ok=True)
    os.makedirs(tmp_out, exist_ok=True)
    logger.info("convert stage=prepare_dirs status=done tmp_in=%s tmp_out=%s", tmp_in, tmp_out)

    stage_ts = time.perf_counter()
    base = os.path.basename(dwg_path)
    tmp_input_path = os.path.join(tmp_in, base)
    shutil.copy2(dwg_path, tmp_input_path)
    logger.info(
        "convert stage=copy_input status=done file=%s elapsed=%.2fs",
        tmp_input_path,
        time.perf_counter() - stage_ts,
    )

    base_cmd = [oda, tmp_in, tmp_out, "ACAD2018", "DXF", "0", "1", "*.dwg"]
    cmd = base_cmd
    if not os.getenv("DISPLAY") and shutil.which("xvfb-run"):
        cmd = ["xvfb-run", "-a", *base_cmd]
    logger.info("convert stage=launch status=start cmd=%s", cmd)

    oda_env = os.environ.copy()
    qt_env_removed = [
        "QT_PLUGIN_PATH",
        "QT_QPA_PLATFORM_PLUGIN_PATH",
        "QT_QPA_PLATFORM",
        "QT_STYLE_OVERRIDE",
        "LD_PRELOAD",
    ]
    for key in qt_env_removed:
        oda_env.pop(key, None)

    stage_ts = time.perf_counter()
    try:
        proc = subprocess.run(cmd, check=True, capture_output=True, text=True, env=oda_env)
        logger.info(
            "convert stage=launch status=done code=%s elapsed=%.2fs stdout_tail=%s stderr_tail=%s",
            proc.returncode,
            time.perf_counter() - stage_ts,
            _tail(proc.stdout),
            _tail(proc.stderr),
        )
    except subprocess.CalledProcessError as e:
        logger.error(
            "convert stage=launch status=failed code=%s elapsed=%.2fs stdout_tail=%s stderr_tail=%s",
            e.returncode,
            time.perf_counter() - stage_ts,
            _tail(e.stdout),
            _tail(e.stderr),
        )
        raise RuntimeError(
            "ODA conversion failed. "
            f"cmd={cmd}\n"
            f"qt_env_removed={qt_env_removed}\n"
            f"stdout={e.stdout}\nstderr={e.stderr}"
        ) from e

    # Find produced DXF
    stage_ts = time.perf_counter()
    logger.info("convert stage=discover_output status=start dir=%s", tmp_out)
    for fn in os.listdir(tmp_out):
        if fn.lower().endswith(".dxf"):
            output = os.path.join(tmp_out, fn)
            logger.info(
                "convert stage=discover_output status=done dxf=%s elapsed=%.2fs total_elapsed=%.2fs",
                output,
                time.perf_counter() - stage_ts,
                time.perf_counter() - start_ts,
            )
            return output

    logger.error(
        "convert stage=discover_output status=failed reason=no_dxf_found files=%s total_elapsed=%.2fs",
        os.listdir(tmp_out),
        time.perf_counter() - start_ts,
    )

    raise RuntimeError("ODA conversion produced no DXF output.")
