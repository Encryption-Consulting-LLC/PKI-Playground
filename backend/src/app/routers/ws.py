"""WebSocket routes for streaming background-job progress.

Generic: any job published via ``app.core.jobs.transport`` can be watched here, not
just clones. Mounted under ``/api`` → ``ws /api/ws/jobs/{job_id}``.

Auth: browsers can't set custom headers on the WS upgrade, so the session token
(a backend-minted JWT) comes as a ``?token=`` query param and is resolved by the
same ``resolve_user_token`` the HTTP dependency uses. Close codes: 4401
(bad/absent token), 4404 (unknown/expired job — no snapshot in Valkey).

Job state and live messages live in Valkey (see ``transport``), not in this
process, so this works the same whether the job is being run by a local worker or
one on another host, and the API can be scaled to multiple replicas without sticky
routing.
"""

import json

from fastapi import APIRouter, WebSocket, WebSocketDisconnect

from app.core.authz import resolve_user_token
from app.core.jobs import transport
from app.core.jobs.models import TERMINAL_TYPES

router = APIRouter(prefix="/ws", tags=["ws"])


@router.websocket("/jobs/{job_id}")
async def job_progress(websocket: WebSocket, job_id: str, token: str | None = None) -> None:
    if await resolve_user_token(token) is None:
        await websocket.close(code=4401)
        return

    redis_client = transport.make_async_client()
    pubsub = redis_client.pubsub()
    try:
        # Subscribe before reading the snapshot so nothing published in between is
        # missed. The snapshot gives an instantly-current bar; if it's already
        # terminal the job finished before we connected and there's nothing to stream.
        await pubsub.subscribe(transport.channel(job_id))

        snapshot = await transport.read_snapshot(redis_client, job_id)
        if snapshot is None:
            await websocket.close(code=4404)
            return

        await websocket.accept()

        last = snapshot["last"]
        if last is not None:
            await websocket.send_json(last)
            if last["type"] in TERMINAL_TYPES:
                return

        async for raw in pubsub.listen():
            if raw["type"] != "message":
                continue
            msg = json.loads(raw["data"])
            await websocket.send_json(msg)
            if msg["type"] in TERMINAL_TYPES:
                break
    except WebSocketDisconnect:
        pass
    finally:
        await pubsub.unsubscribe(transport.channel(job_id))
        await pubsub.aclose()
        await redis_client.aclose()
