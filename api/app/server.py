import os
import logging
from pathlib import Path

import uvicorn

def main():
    # Load .env file if present (works both locally and in container)
    try:
        from dotenv import load_dotenv
        env_file = Path(__file__).resolve().parent.parent / ".env"
        if env_file.is_file():
            load_dotenv(env_file, override=False)
            print(f"[dotenv] Loaded env from {env_file}")
        else:
            print(f"[dotenv] No .env file at {env_file}")
    except ImportError:
        print("[dotenv] python-dotenv not installed, skipping .env load")
    host = os.getenv("API_HOST", "0.0.0.0")
    port = int(os.getenv("API_PORT", "8000"))
    log_level = os.getenv("LOG_LEVEL", "info").lower()
    logging.basicConfig(
        level=getattr(logging, log_level.upper(), logging.INFO),
        format="%(asctime)s | %(levelname)s | %(name)s | %(message)s",
    )
    # Suppress noisy ezdxf warnings about AutoCAD-proprietary context objects
    # (ACDB_MTEXTATTRIBUTEOBJECTCONTEXTDATA_CLASS). These appear whenever a DXF
    # created by AutoCAD is read and re-saved via ezdxf; the missing objects
    # don't affect the output and the warnings are purely informational noise.
    logging.getLogger("ezdxf").setLevel(logging.ERROR)
    uvicorn.run("app.main:app", host=host, port=port, reload=False, log_level=log_level)

if __name__ == "__main__":
    main()
