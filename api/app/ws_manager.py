"""
Lightweight WebSocket connection manager.

Tracks connected clients per project and broadcasts JSON messages
(e.g. pipeline status changes) in real time.
"""
from __future__ import annotations

import asyncio
import json
import logging
from collections import defaultdict
from typing import Any

from fastapi import WebSocket

logger = logging.getLogger("firecad.ws")


class ConnectionManager:
    """Manages per-project WebSocket connections."""

    def __init__(self) -> None:
        # project_id -> set of connected WebSockets
        self._connections: dict[str, set[WebSocket]] = defaultdict(set)
        # Set by the startup event so background threads can schedule coroutines
        self._loop: asyncio.AbstractEventLoop | None = None

    def set_loop(self, loop: asyncio.AbstractEventLoop) -> None:
        """Store the main event loop (called once at startup)."""
        self._loop = loop

    async def connect(self, project_id: str, ws: WebSocket) -> None:
        await ws.accept()
        self._connections[project_id].add(ws)
        logger.info("ws connect project=%s clients=%d", project_id, len(self._connections[project_id]))

    def disconnect(self, project_id: str, ws: WebSocket) -> None:
        self._connections[project_id].discard(ws)
        if not self._connections[project_id]:
            del self._connections[project_id]
        logger.info("ws disconnect project=%s", project_id)

    async def broadcast(self, project_id: str, data: dict[str, Any]) -> None:
        """Send a JSON message to every client watching *project_id*."""
        clients = list(self._connections.get(project_id, []))
        if not clients:
            return
        payload = json.dumps(data)
        dead: list[WebSocket] = []
        for ws in clients:
            try:
                await ws.send_text(payload)
            except Exception:
                dead.append(ws)
        for ws in dead:
            self._connections[project_id].discard(ws)

    def broadcast_sync(self, project_id: str, data: dict[str, Any]) -> None:
        """Fire-and-forget broadcast from synchronous (non-async) code.

        This is safe to call from the background-thread pipeline because it
        schedules the coroutine on the stored main event loop.
        """
        loop = self._loop
        if loop is not None and loop.is_running():
            asyncio.run_coroutine_threadsafe(self.broadcast(project_id, data), loop)
            return

        # Fallback: try to find any running loop
        try:
            loop = asyncio.get_running_loop()
            asyncio.run_coroutine_threadsafe(self.broadcast(project_id, data), loop)
        except RuntimeError:
            logger.debug("ws broadcast_sync: no usable event loop, skipping")


# Singleton – imported by routers and pipeline code
manager = ConnectionManager()
