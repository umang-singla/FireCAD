import os
import logging
import uvicorn

def main():
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
