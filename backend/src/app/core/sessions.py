"""In-process ESXi session store.

``create_session`` is called by the auth router when a connection is opened.
``get_session`` is a FastAPI dependency consumed by every protected VM route.
Sessions are kept in a module-level dict and are lost on process restart;
access is serialised with a threading.Lock so uvicorn's sync threadpool is safe.
"""

import threading
import uuid

from fastapi import Header, HTTPException
from vmkit import Connection

_sessions: dict[str, Connection] = {}
_lock = threading.Lock()


def create_session(conn: Connection) -> str:
    """Store a live Connection and return an opaque token."""
    token = uuid.uuid4().hex
    with _lock:
        _sessions[token] = conn
    return token


def drop_session(token: str) -> bool:
    """Remove a session by token; return True if it existed."""
    with _lock:
        return _sessions.pop(token, None) is not None


def resolve_token(token: str | None) -> Connection | None:
    """Look up a token → Connection, or None if absent/unknown.

    Used where a FastAPI ``Header`` dependency can't apply — notably WebSocket
    routes, which authenticate via a query param since browsers can't set custom
    headers on the upgrade request.
    """
    if not token:
        return None
    return _sessions.get(token)


def get_session(x_session_token: str = Header(...)) -> Connection:
    """FastAPI dependency: resolve X-Session-Token header → Connection (401 if unknown)."""
    conn = resolve_token(x_session_token)
    if conn is None:
        raise HTTPException(status_code=401, detail="Invalid or expired session token.")
    return conn
