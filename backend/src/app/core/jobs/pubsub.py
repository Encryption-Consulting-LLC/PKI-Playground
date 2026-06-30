"""Per-job in-process fan-out.

One ``PubSub`` lives on each ``Job``. Subscribers (WebSocket connections) each
get their own ``asyncio.Queue``; ``publish`` pushes a message to every queue so
multiple clients can watch the same job (and a client can reconnect). ``close``
wakes every subscriber with a ``None`` sentinel so their receive loop can exit.

All methods run on the event-loop thread (the runner marshals worker-thread
callbacks back onto the loop before calling ``publish``), so no locking is needed.
"""

import asyncio

from app.core.jobs.models import Message


class PubSub:
    def __init__(self) -> None:
        self._subscribers: set[asyncio.Queue[Message | None]] = set()
        self._closed = False

    def subscribe(self) -> asyncio.Queue[Message | None]:
        q: asyncio.Queue[Message | None] = asyncio.Queue()
        self._subscribers.add(q)
        # A subscriber that joins after the job already finished still needs to
        # be unblocked; the WS handler relies on the stored snapshot for the
        # terminal state, but push the sentinel so a bare receive loop ends too.
        if self._closed:
            q.put_nowait(None)
        return q

    def unsubscribe(self, q: asyncio.Queue[Message | None]) -> None:
        self._subscribers.discard(q)

    def publish(self, msg: Message) -> None:
        for q in self._subscribers:
            q.put_nowait(msg)

    def close(self) -> None:
        self._closed = True
        for q in self._subscribers:
            q.put_nowait(None)
