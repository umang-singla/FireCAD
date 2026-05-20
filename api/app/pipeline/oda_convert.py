"""DXF -> DWG conversion via ODA File Converter.

Requires the ODA File Converter binary (installed in the api container at
/opt/oda/ODAFileConverter or /usr/bin/ODAFileConverter) and `xvfb-run`
because the ODA Qt build needs an X display even for headless conversion.
"""
from __future__ import annotations

import logging
import os
import shutil
import subprocess
import tempfile
from pathlib import Path

logger = logging.getLogger("mepit.pipeline.oda_convert")

_DEFAULT_ODA = os.getenv("ODA_PATH", "/opt/oda/ODAFileConverter")


def _resolve_oda(oda_exe: str | None) -> str:
    candidate = oda_exe or _DEFAULT_ODA
    if candidate and Path(candidate).exists():
        return candidate
    found = shutil.which("ODAFileConverter")
    if found:
        return found
    raise FileNotFoundError(
        "ODAFileConverter not found (looked at %r and PATH)" % (candidate,),
    )


def dxf_to_dwg(
    input_dxf: str,
    output_dwg: str | None = None,
    oda_exe: str | None = None,
    version: str = "ACAD2018",
    audit: bool = True,
    timeout: int = 180,
) -> str:
    """Convert a single DXF to DWG. Returns the output path on success."""
    input_path = Path(input_dxf).resolve()
    if not input_path.exists():
        raise FileNotFoundError(f"Input DXF not found: {input_path}")
    if input_path.suffix.lower() != ".dxf":
        raise ValueError(f"Input file must be .dxf, got: {input_path}")

    out_path = (
        Path(output_dwg).resolve()
        if output_dwg
        else input_path.with_suffix(".dwg")
    )
    out_path.parent.mkdir(parents=True, exist_ok=True)

    oda = _resolve_oda(oda_exe)

    with tempfile.TemporaryDirectory(prefix="oda_") as tmp:
        tmp = Path(tmp)
        src_dir = tmp / "src"
        dst_dir = tmp / "out"
        src_dir.mkdir()
        dst_dir.mkdir()

        # Copy under the original stem so the produced DWG is predictable.
        shutil.copy2(input_path, src_dir / input_path.name)

        cmd = [
            "xvfb-run", "-a",
            oda,
            str(src_dir),
            str(dst_dir),
            version,
            "DWG",
            "0",                    # recurse: no
            "1" if audit else "0",  # audit
            "*.dxf",
        ]

        env = os.environ.copy()
        env["QT_QPA_PLATFORM"] = "xcb"

        logger.info("oda_convert: %s", " ".join(cmd))
        result = subprocess.run(
            cmd,
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
            text=True,
            env=env,
            timeout=timeout,
            check=False,
        )

        if result.returncode != 0:
            logger.warning(
                "oda_convert: non-zero return=%s stderr=%s",
                result.returncode, (result.stderr or "")[:500],
            )
            raise RuntimeError(
                f"ODA conversion failed (rc={result.returncode}): "
                f"{(result.stderr or result.stdout or '')[:300]}",
            )

        produced = list(dst_dir.glob("*.dwg"))
        if not produced:
            raise RuntimeError(
                f"ODA produced no DWG in {dst_dir} (stdout={result.stdout[:200]})",
            )

        shutil.copy2(produced[0], out_path)

    logger.info("oda_convert: wrote %s", out_path)
    return str(out_path)
