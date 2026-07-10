"""Orchestrator agent correlation — identity and the live connection map.

Two identity sources, both feeding the same auth check on ``ws /connect``:

* **In-process pending** (``_pending``): a vm_id/token pair minted by
  ``POST /orchestrator/register`` for the manual/dev flow (a human pastes them
  into a local ``orchestrator.toml``). No persistence, lost on restart.
* **Persisted** (Phase F): the Celery clone worker mints an identity and stores
  ``{vmId, tokenHash, …}`` on the VM's ``vm_registry`` document, so a
  real deployed agent authenticates against Mongo (``authenticate_persisted``).
  Only the sha256 of the token is stored — a Mongo dump can't impersonate an
  agent (same threat model as ``core/secrets``). Unlike the pending path this
  is **non-consuming**, so a dropped socket's reconnect re-authenticates.

The live ``_connected`` map is in-process only (single API process — documented
constraint; multi-worker WS fan-out would need a broker relay). It holds the
live ``WebSocket`` per vm_id plus a send lock, since a dispatched command runs
in a different request's coroutine than the one that accepted the connection.
"""

import asyncio
import hashlib
import hmac
import secrets
import threading
import uuid
from dataclasses import dataclass, field

from fastapi import WebSocket

_pending: dict[str, str] = {}  # vm_id -> token
_connected: dict[str, "AgentConnection"] = {}  # vm_id -> live connection
_lock = threading.Lock()


@dataclass
class AgentConnection:
    websocket: WebSocket
    send_lock: asyncio.Lock = field(default_factory=asyncio.Lock)

    async def send(self, payload: dict) -> None:
        async with self.send_lock:
            await self.websocket.send_json(payload)


# --------------------------------------------------------------------------- #
# Identity minting / hashing (shared by worker + API)                         #
# --------------------------------------------------------------------------- #
def mint_identity() -> tuple[str, str]:
    """A fresh (vm_id, token) pair. The token is a 256-bit URL-safe secret; only
    its hash is ever persisted (see ``hash_token``)."""
    return uuid.uuid4().hex[:12], secrets.token_urlsafe(32)


def hash_token(token: str) -> str:
    """sha256 hex of a token — what gets stored on the registry doc."""
    return hashlib.sha256(token.encode("utf-8")).hexdigest()


def register_agent() -> tuple[str, str]:
    """Mint an in-process pending vm_id/token pair (manual/dev flow)."""
    vm_id, token = mint_identity()
    with _lock:
        _pending[vm_id] = token
    return vm_id, token


def authenticate_pending(vm_id: str, token: str) -> bool:
    """True and consumes the entry if vm_id/token match a pending registration."""
    with _lock:
        expected = _pending.get(vm_id)
        if expected is None or not hmac.compare_digest(expected, token):
            return False
        del _pending[vm_id]
        return True


async def authenticate_persisted(vm_id: str, token: str) -> bool:
    """True if vm_id/token match a live (non-deleted) VM's stored agent identity.

    Non-consuming and constant-time — a reconnect after a dropped socket
    re-authenticates against the same hash.
    """
    from app.core.db import vm_registry_col  # deferred: keep importable without Mongo

    doc = await vm_registry_col().find_one(
        {"agent.vmId": vm_id, "status": {"$ne": "deleted"}}
    )
    stored = (doc or {}).get("agent", {}).get("tokenHash") if doc else None
    if not stored:
        return False
    return hmac.compare_digest(stored, hash_token(token))


# --------------------------------------------------------------------------- #
# Live connection map                                                         #
# --------------------------------------------------------------------------- #
def connect_agent(vm_id: str, websocket: WebSocket) -> AgentConnection:
    """Record the live connection for ``vm_id`` (overwriting any prior entry —
    the caller closes the old socket first for a clean takeover)."""
    conn = AgentConnection(websocket=websocket)
    with _lock:
        _connected[vm_id] = conn
    return conn


def pop_connection(vm_id: str) -> AgentConnection | None:
    """Remove and return the live connection for ``vm_id`` (for takeover /
    forced disconnect on teardown)."""
    with _lock:
        return _connected.pop(vm_id, None)


def disconnect_if(vm_id: str, conn: "AgentConnection") -> None:
    """Drop ``vm_id`` only if its live entry is still ``conn`` — so a socket that
    was already replaced by a takeover doesn't evict its replacement on cleanup."""
    with _lock:
        if _connected.get(vm_id) is conn:
            del _connected[vm_id]


def resolve_agent(vm_id: str) -> AgentConnection | None:
    with _lock:
        return _connected.get(vm_id)


def connected_vm_ids() -> list[str]:
    with _lock:
        return sorted(_connected.keys())
