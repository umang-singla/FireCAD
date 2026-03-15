"""WebSocket endpoint for real-time project status updates."""

from fastapi import APIRouter, WebSocket, WebSocketDisconnect

from app.ws_manager import manager

router = APIRouter()


@router.websocket("/api/projects/{project_id}/ws")
async def project_ws(websocket: WebSocket, project_id: str):
    """Clients connect here to receive real-time pipeline status events.

    Messages are JSON objects like:
        {"type": "status", "status": "rendered", "stage": "render_input"}
        {"type": "status", "status": "failed", "error": "..."}
    """
    await manager.connect(project_id, websocket)
    try:
        # Keep the connection alive – just wait for client disconnect
        while True:
            # We don't expect messages from the client, but we must
            # await receive to detect disconnections.
            await websocket.receive_text()
    except WebSocketDisconnect:
        pass
    finally:
        manager.disconnect(project_id, websocket)
