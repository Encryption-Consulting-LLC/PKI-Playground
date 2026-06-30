"""WebSocket routes for streaming background-job progress.

Generic: any job created via ``app.core.jobs.registry`` can be watched here, not
just clones. Mounted under ``/api`` → ``ws /api/ws/jobs/{job_id}``.

Auth: browsers can't set custom headers on the WS upgrade, so the session token
comes as a ``?token=`` query param and is resolved against the same session store
the HTTP routes use. Close codes: 4401 (bad/absent token), 4404 (unknown job).
"""

from fastapi import APIRouter, WebSocket, WebSocketDisconnect

from app.core.jobs import is_terminal, registry
from app.core.sessions import resolve_token

router = APIRouter(prefix="/ws", tags=["ws"])


@router.websocket("/jobs/{job_id}")
async def job_progress(websocket: WebSocket, job_id: str, token: str | None = None) -> None:
    if resolve_token(token) is None:
        await websocket.close(code=4401)
        return

    job = registry.get(job_id)
    if job is None:
        await websocket.close(code=4404)
        return

    await websocket.accept()

    # Subscribe before reading the snapshot so nothing published in between is
    # missed. The snapshot gives an instantly-current bar; if it's already
    # terminal the job finished before we connected and there's nothing to stream.
    queue = job.pubsub.subscribe()
    try:
        snapshot = job.last
        if snapshot is not None:
            await websocket.send_json(snapshot.model_dump())
            if is_terminal(snapshot):
                return

        while True:
            msg = await queue.get()
            if msg is None:  # channel closed without a terminal frame
                break
            await websocket.send_json(msg.model_dump())
            if is_terminal(msg):
                break
    except WebSocketDisconnect:
        pass
    finally:
        job.pubsub.unsubscribe(queue)
