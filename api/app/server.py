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
            logging.info("Loaded env from %s", env_file)
    except ImportError:
        pass
    host = os.getenv("API_HOST", "0.0.0.0")
    port = int(os.getenv("API_PORT", "8000"))
    log_level = os.getenv("LOG_LEVEL", "info").lower()
    logging.basicConfig(
        level=getattr(logging, log_level.upper(), logging.INFO),
        format="%(asctime)s | %(levelname)s | %(name)s | %(message)s",
    )
    uvicorn.run("app.main:app", host=host, port=port, reload=False, log_level=log_level)

if __name__ == "__main__":
    main()
