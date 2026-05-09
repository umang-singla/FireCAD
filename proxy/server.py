"""
Standalone reverse-proxy – forwards HTTP and WebSocket traffic to upstream
targets.  Runs as its own Docker service, separate from the main API.

Configuration (env vars):
    PROXY_TARGETS        – JSON map  {prefix: upstream_base_url}
                           e.g. {"api":"http://api:8000","ml":"http://ml:5000"}
                           /api/projects → http://api:8000/api/projects
                           /ml/predict   → http://ml:5000/predict

    PROXY_DEFAULT_TARGET – Fallback URL when no prefix matches.
                           e.g. "http://api:8000"
                           /anything     → http://api:8000/anything

    PROXY_TIMEOUT        – Upstream timeout in seconds (default 120).
    PROXY_HOST           – Bind address  (default 0.0.0.0).
    PROXY_PORT           – Bind port     (default 8080).
"""

from __future__ import annotations

import asyncio
import json
import logging
import os

import httpx
import uvicorn
from fastapi import FastAPI, Request, WebSocket, WebSocketDisconnect
from fastapi.middleware.cors import CORSMiddleware
from starlette.responses import StreamingResponse

# ---------------------------------------------------------------------------
# Logging
# ---------------------------------------------------------------------------
logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s | %(levelname)s | %(name)s | %(message)s",
)
logger = logging.getLogger("proxy")

# ---------------------------------------------------------------------------
# App
# ---------------------------------------------------------------------------
app = FastAPI(title="Mepit.AI Proxy", version="0.1.0")

app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

# ---------------------------------------------------------------------------
# Config helpers
# ---------------------------------------------------------------------------
_TIMEOUT = float(os.getenv("PROXY_TIMEOUT", "120"))


def _load_targets() -> dict[str, str]:
    raw = os.getenv("PROXY_TARGETS", "")
    if not raw:
        return {}
    try:
        targets = json.loads(raw)
        if not isinstance(targets, dict):
            raise ValueError("PROXY_TARGETS must be a JSON object")
        # Normalise: strip leading/trailing slashes from prefix, trailing slash from URL
        return {k.strip("/"): v.rstrip("/") for k, v in targets.items()}
    except Exception as exc:  # noqa: BLE001
        logger.warning("Failed to parse PROXY_TARGETS: %s", exc)
        return {}


def _default_target() -> str | None:
    val = os.getenv("PROXY_DEFAULT_TARGET", "").rstrip("/")
    return val or None


def _resolve_upstream(path: str) -> tuple[str, str]:
    """
    Return (upstream_base_url, path_to_forward) for a given request path.

    Resolution:
    1. Match longest prefix from PROXY_TARGETS first.
    2. Fall back to PROXY_DEFAULT_TARGET (entire path forwarded).
    """
    targets = _load_targets()
    clean = path.strip("/")

    # Try longest-prefix match
    best_prefix = ""
    for prefix in targets:
        if (clean == prefix or clean.startswith(prefix + "/")) and len(prefix) > len(best_prefix):
            best_prefix = prefix

    if best_prefix:
        rest = clean[len(best_prefix):]           # may start with "/" or be ""
        if not rest.startswith("/"):
            rest = "/" + rest
        return targets[best_prefix], rest

    default = _default_target()
    if default:
        return default, "/" + clean if clean else "/"

    raise ValueError(
        f"No upstream target for path '/{clean}'. "
        "Set PROXY_TARGETS or PROXY_DEFAULT_TARGET."
    )


# ---------------------------------------------------------------------------
# Connection-pooled httpx client
# ---------------------------------------------------------------------------
_client: httpx.AsyncClient | None = None


def _get_client() -> httpx.AsyncClient:
    global _client  # noqa: PLW0603
    if _client is None or _client.is_closed:
        _client = httpx.AsyncClient(
            timeout=httpx.Timeout(_TIMEOUT),
            follow_redirects=True,
            limits=httpx.Limits(max_connections=200, max_keepalive_connections=40),
        )
    return _client


@app.on_event("shutdown")
async def _close_client() -> None:
    if _client and not _client.is_closed:
        await _client.aclose()


# ---------------------------------------------------------------------------
# Header helpers
# ---------------------------------------------------------------------------
_HOP_BY_HOP = frozenset({
    "connection", "keep-alive", "proxy-authenticate", "proxy-authorization",
    "te", "trailer", "transfer-encoding", "upgrade",
})


def _request_headers(request: Request) -> dict[str, str]:
    headers: dict[str, str] = {}
    for k, v in request.headers.items():
        if k.lower() not in _HOP_BY_HOP and k.lower() != "host":
            headers[k] = v
    client_host = request.client.host if request.client else "127.0.0.1"
    xff = request.headers.get("x-forwarded-for", "")
    headers["x-forwarded-for"] = f"{xff}, {client_host}" if xff else client_host
    headers["x-forwarded-proto"] = request.url.scheme
    return headers


def _response_headers(upstream: httpx.Headers) -> dict[str, str]:
    return {k: v for k, v in upstream.items() if k.lower() not in _HOP_BY_HOP}


# ---------------------------------------------------------------------------
# HTTP catch-all
# ---------------------------------------------------------------------------
@app.api_route(
    "/{path:path}",
    methods=["GET", "POST", "PUT", "PATCH", "DELETE", "HEAD", "OPTIONS"],
    include_in_schema=False,
)
async def http_proxy(request: Request, path: str = ""):
    try:
        upstream_base, upstream_path = _resolve_upstream(path)
    except ValueError as exc:
        return StreamingResponse(iter([str(exc).encode()]), status_code=502, media_type="text/plain")

    qs = str(request.url.query)
    url = f"{upstream_base}{upstream_path}"
    if qs:
        url = f"{url}?{qs}"

    body = await request.body()
    client = _get_client()

    try:
        resp = await client.request(
            method=request.method,
            url=url,
            headers=_request_headers(request),
            content=body,
        )
    except httpx.RequestError as exc:
        logger.error("Upstream error: %s %s → %s", request.method, url, exc)
        return StreamingResponse(
            iter([f"Upstream connection error: {exc}".encode()]),
            status_code=502,
            media_type="text/plain",
        )

    return StreamingResponse(
        iter([resp.content]),
        status_code=resp.status_code,
        headers=_response_headers(resp.headers),
    )


# ---------------------------------------------------------------------------
# WebSocket catch-all
# ---------------------------------------------------------------------------
@app.websocket("/{path:path}")
async def websocket_proxy(ws: WebSocket, path: str = ""):
    try:
        upstream_base, upstream_path = _resolve_upstream(path)
    except ValueError as exc:
        await ws.close(code=1008, reason=str(exc))
        return

    # http→ws, https→wss
    ws_url = upstream_base.replace("https://", "wss://").replace("http://", "ws://")
    ws_url = f"{ws_url}{upstream_path}"
    qs = str(ws.scope.get("query_string", b""), "utf-8")
    if qs:
        ws_url = f"{ws_url}?{qs}"

    extra_headers: dict[str, str] = {}
    for k, v in ws.headers.items():
        if k.lower() not in (
            "host", "connection", "upgrade",
            "sec-websocket-key", "sec-websocket-version",
            "sec-websocket-extensions", "sec-websocket-protocol",
        ):
            extra_headers[k] = v

    await ws.accept()

    try:
        import websockets.client as wsc  # type: ignore[import-untyped]

        async with wsc.connect(
            ws_url,
            extra_headers=extra_headers,
            open_timeout=_TIMEOUT,
            close_timeout=10,
        ) as upstream:

            async def _client_to_upstream() -> None:
                try:
                    while True:
                        msg = await ws.receive()
                        if msg.get("type") == "websocket.disconnect":
                            break
                        if "text" in msg:
                            await upstream.send(msg["text"])
                        elif "bytes" in msg and msg["bytes"]:
                            await upstream.send(msg["bytes"])
                except WebSocketDisconnect:
                    pass

            async def _upstream_to_client() -> None:
                try:
                    async for message in upstream:
                        if isinstance(message, bytes):
                            await ws.send_bytes(message)
                        else:
                            await ws.send_text(message)
                except Exception:  # noqa: BLE001
                    pass

            done, pending = await asyncio.wait(
                [
                    asyncio.ensure_future(_client_to_upstream()),
                    asyncio.ensure_future(_upstream_to_client()),
                ],
                return_when=asyncio.FIRST_COMPLETED,
            )
            for t in pending:
                t.cancel()

    except Exception as exc:  # noqa: BLE001
        logger.error("WebSocket proxy error for %s: %s", ws_url, exc)

    try:
        await ws.close()
    except Exception:  # noqa: BLE001
        pass


# ---------------------------------------------------------------------------
# Entrypoint
# ---------------------------------------------------------------------------
def main() -> None:
    host = os.getenv("PROXY_HOST", "0.0.0.0")
    port = int(os.getenv("PROXY_PORT", "8080"))
    logger.info("Starting proxy on %s:%s", host, port)
    logger.info("Targets: %s", _load_targets() or "(using PROXY_DEFAULT_TARGET)")
    logger.info("Default target: %s", _default_target() or "(none)")
    uvicorn.run(app, host=host, port=port, log_level="info")


if __name__ == "__main__":
    main()
