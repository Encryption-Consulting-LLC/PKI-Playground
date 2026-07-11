"""Worker↔agent dispatch bridge (Phase L).

Plan execution runs in the Celery worker (blocking hour-scale vmkit clones
plus IP-pool idempotency belong there, not in the API process), but the
orchestrator agent WebSockets live in the **FastAPI** process
(:mod:`app.core.agents`). The worker therefore can't send an agent a command
directly. This module is the relay across the two processes, over the same
Valkey used for job transport:

* **Worker side** (:func:`dispatch_and_wait`, sync redis): SUBSCRIBE the job's
  channel *before* publishing a dispatch request onto ``agent-dispatch``, then
  block for the agent's terminal frame (which the connect handler already
  relays onto ``jobs:{job_id}`` — no new return path). Redelivery-safe: a job
  whose snapshot is already terminal returns immediately.
* **API side** (:func:`run_dispatch_subscriber`, async lifespan task):
  SUBSCRIBE ``agent-dispatch``; whichever process holds the socket for that
  ``vm_id`` forwards the frame to the agent, the rest stay silent. The
  single-live-connection-per-vm_id takeover guarantees exactly one holder.

**Liveness / reboot-resume:** the connect handler calls :func:`mark_agent_live`
(TTL key ``agent-conn:{vm_id}`` + ``$set agent.lastConnectedAt`` on the
registry). :func:`dispatch_and_wait` refuses to dispatch to an agent whose
liveness key is absent; :func:`wait_for_reconnect` polls the registry timestamp
so a reboot step resumes once the agent phones home again.
"""

import json
import logging
import time

import redis

from app.core.jobs import transport
from app.core.settings import settings

logger = logging.getLogger(__name__)

#: Pub/sub channel the worker publishes dispatch requests onto; the API process
#: holding the target socket forwards them.
DISPATCH_CHANNEL = "agent-dispatch"


def agent_conn_key(vm_id: str) -> str:
    return f"agent-conn:{vm_id}"


#: Liveness TTL — refreshed by the connect handler's keepalive well inside it.
AGENT_CONN_TTL_SECONDS = 90


class AgentUnreachableError(Exception):
    """No live agent connection for the target vm_id (never phoned home, or its
    liveness key expired)."""


class DispatchError(Exception):
    """The dispatched command failed terminally, or the wait timed out."""


class ReconnectTimeoutError(Exception):
    """The agent did not phone home again within the reboot-wait window."""


# --------------------------------------------------------------------------- #
# Worker side (sync)                                                          #
# --------------------------------------------------------------------------- #
def dispatch_and_wait(
    vm_id: str,
    command: str,
    params: dict,
    *,
    job_id: str,
    role: str,
    timeout_s: int,
    secret_keys: tuple[str, ...] = (),
    client: "redis.Redis | None" = None,
) -> dict:
    """Dispatch one command to ``vm_id``'s agent and block for its terminal
    result. Returns the ``done`` frame's ``result`` dict; raises
    :class:`DispatchError` on an ``error`` frame or timeout, and
    :class:`AgentUnreachableError` if no agent is live.

    Redelivery-safe: if ``jobs:{job_id}`` already holds a terminal snapshot
    (the step ran before the worker was redelivered this task), its result is
    returned without re-dispatching — deterministic per-step job ids make this
    exact.
    """
    r = client or transport._client  # one shared sync pool

    existing = r.get(transport.snapshot_key(job_id))
    if existing is not None:
        snap = json.loads(existing)
        terminal = _terminal_result(snap)
        if terminal is not None:
            logger.info("dispatch %s already terminal (redelivery) — reusing", job_id)
            return terminal

    if r.get(agent_conn_key(vm_id)) is None:
        raise AgentUnreachableError(f"no live agent for vm_id '{vm_id}'")

    pubsub = r.pubsub(ignore_subscribe_messages=True)
    # Subscribe BEFORE publishing the dispatch request so we can't miss a fast
    # agent's terminal frame in the gap between publish and subscribe.
    pubsub.subscribe(transport.channel(job_id))
    try:
        request = json.dumps(
            {
                "vm_id": vm_id,
                "job_id": job_id,
                "command": command,
                "params": params,
                "role": role,
            }
        )
        r.publish(DISPATCH_CHANNEL, request)

        deadline = time.monotonic() + timeout_s
        while time.monotonic() < deadline:
            message = pubsub.get_message(timeout=1.0)
            if message is None:
                # Late-subscribe safety net: the terminal frame may have landed
                # in the snapshot before our subscribe took effect.
                snap_raw = r.get(transport.snapshot_key(job_id))
                if snap_raw is not None:
                    terminal = _terminal_result(json.loads(snap_raw))
                    if terminal is not None:
                        return terminal
                continue
            frame = json.loads(message["data"])
            outcome = _frame_outcome(frame)
            if outcome is None:
                continue  # progress frame — keep waiting
            ok, payload = outcome
            if ok:
                return payload
            raise DispatchError(
                f"agent command '{command}' failed: {payload.get('detail', 'unknown error')}"
            )
        raise DispatchError(
            f"agent command '{command}' timed out after {timeout_s}s"
        )
    finally:
        pubsub.close()


def _frame_outcome(frame: dict) -> tuple[bool, dict] | None:
    """Classify one relayed job frame: ``(True, result)`` for done,
    ``(False, {detail})`` for error, ``None`` for a non-terminal frame."""
    kind = frame.get("type")
    if kind == "done":
        return True, frame.get("result") or {}
    if kind == "error":
        return False, {"detail": frame.get("detail") or "orchestrator command failed"}
    return None


def _terminal_result(snapshot: dict) -> dict | None:
    """The result dict if ``snapshot['last']`` is a terminal frame, else None.
    An ``error`` snapshot raises so a redelivery re-fails identically."""
    last = snapshot.get("last") or {}
    outcome = _frame_outcome(last)
    if outcome is None:
        return None
    ok, payload = outcome
    if ok:
        return payload
    raise DispatchError(payload.get("detail", "orchestrator command failed"))


def wait_for_agent(
    vm_id: str,
    timeout_s: int,
    *,
    client: "redis.Redis | None" = None,
    sleep=time.sleep,
    poll_interval_s: float = 3.0,
) -> None:
    """Block until ``vm_id``'s agent has phoned home (its liveness key exists),
    or raise :class:`AgentUnreachableError`. Called after a clone, before the
    createVm provision sequence runs — the freshly-booted VM needs time to
    install and start the agent."""
    r = client or transport._client
    deadline = time.monotonic() + timeout_s
    while time.monotonic() < deadline:
        if r.get(agent_conn_key(vm_id)) is not None:
            return
        sleep(poll_interval_s)
    raise AgentUnreachableError(
        f"agent '{vm_id}' did not phone home within {timeout_s}s of boot"
    )


def wait_for_reconnect(
    vm_id: str,
    since_ms: int,
    timeout_s: int,
    *,
    db,
    sleep=time.sleep,
    now_ms=None,
    poll_interval_s: float = 3.0,
) -> None:
    """Block until the agent's ``lastConnectedAt`` advances past ``since_ms``
    (it reconnected after the reboot dispatched at ``since_ms``), or raise
    :class:`ReconnectTimeoutError`. ``db`` is a worker sync database."""
    import time as _time

    deadline = _time.monotonic() + timeout_s
    while _time.monotonic() < deadline:
        doc = db["vm_registry"].find_one(
            {"agent.vmId": vm_id}, {"agent.lastConnectedAt": 1}
        )
        last = ((doc or {}).get("agent") or {}).get("lastConnectedAt")
        if isinstance(last, int) and last > since_ms:
            return
        sleep(poll_interval_s)
    raise ReconnectTimeoutError(
        f"agent '{vm_id}' did not reconnect within {timeout_s}s of the reboot"
    )


# --------------------------------------------------------------------------- #
# API side (async)                                                            #
# --------------------------------------------------------------------------- #
async def mark_agent_live(vm_id: str) -> None:
    """Record that ``vm_id``'s agent is connected: a short-TTL liveness key
    (refreshed by the connect keepalive) plus ``agent.lastConnectedAt`` on the
    registry doc (the worker's reboot-resume signal)."""
    from app.core.db import now_ms, vm_registry_col

    client = transport.make_async_client()
    try:
        await client.set(agent_conn_key(vm_id), "1", ex=AGENT_CONN_TTL_SECONDS)
    finally:
        await client.aclose()
    await vm_registry_col().update_one(
        {"agent.vmId": vm_id},
        {"$set": {"agent.lastConnectedAt": now_ms()}},
    )


async def refresh_agent_live(vm_id: str) -> None:
    """Re-arm the liveness TTL (called on the connect keepalive tick)."""
    client = transport.make_async_client()
    try:
        await client.set(agent_conn_key(vm_id), "1", ex=AGENT_CONN_TTL_SECONDS)
    finally:
        await client.aclose()


async def clear_agent_live(vm_id: str) -> None:
    """Drop the liveness key on a clean disconnect (best-effort; the TTL is the
    backstop for an unclean one)."""
    client = transport.make_async_client()
    try:
        await client.delete(agent_conn_key(vm_id))
    finally:
        await client.aclose()


async def run_dispatch_subscriber() -> None:
    """Lifespan task: forward ``agent-dispatch`` requests to whichever socket
    this process holds. Runs until cancelled at shutdown."""
    from app.core import agents

    client = transport.make_async_client()
    pubsub = client.pubsub(ignore_subscribe_messages=True)
    await pubsub.subscribe(DISPATCH_CHANNEL)
    logger.info("agent-dispatch subscriber started")
    try:
        async for message in pubsub.listen():
            if message.get("type") != "message":
                continue
            try:
                request = json.loads(message["data"])
            except (ValueError, KeyError):
                logger.warning("malformed agent-dispatch frame")
                continue
            vm_id = request.get("vm_id")
            agent = agents.resolve_agent(vm_id) if vm_id else None
            if agent is None:
                continue  # another process holds this socket (or none does)
            try:
                await agent.send(
                    {
                        "job_id": request["job_id"],
                        "command": request["command"],
                        "params": request.get("params") or {},
                        "role": request.get("role") or "guest",
                    }
                )
            except Exception:  # noqa: BLE001 — a dead socket shouldn't kill the loop
                logger.warning("failed to forward dispatch to agent %s", vm_id)
    finally:
        await pubsub.aclose()
        await client.aclose()
