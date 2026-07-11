"""Orchestrator phone-home routes.

The Rust ``pki-orchestrator`` agent connects outbound to
``ws /api/orchestrator/connect`` once running, authenticating with a
vm_id/token pair. Two ways that pair exists:

* **Persisted (Phase F):** the clone worker mints it and stores the hash on the
  VM's ``vm_registry`` document; the agent binary + its ``orchestrator.toml``
  are baked onto the firstboot ISO, so a real deployed agent phones home with
  no human in the loop.
* **Pending (manual/dev):** ``POST /orchestrator/register`` mints an in-process
  pair a human pastes into a local config.

Provisioning is **plan-driven** (Phase L): the connect handler no longer
dispatches a per-template command on connect. It only marks the agent live
(``agentbus.mark_agent_live`` — the liveness key + ``lastConnectedAt`` the
worker's sequence engine waits on) and relays the agent's progress frames onto
the job transport. All command dispatch now flows from the Celery plan runner
through the ``agent-dispatch`` bridge (:mod:`app.core.agentbus`), which this
process forwards to whichever socket it holds (a lifespan subscriber in
``main.py``).

Auth is validated before ``accept()`` (4401 on failure); the agent sends
vm_id/token as request headers (kept out of access logs), with the browser-style
``?vm_id=&token=`` query still accepted for the manual path.

Dispatching a command (``POST /orchestrator/{vm_id}/command``) is capability-gated
*and* ownership-gated: a guest can only command an agent bound to a VM in its own
namespace. The authenticated caller's role is forwarded in the frame; the agent
re-checks it locally as a second, structural gate (see ``phonehome.rs``).
"""

import asyncio
import contextlib
import uuid

from fastapi import APIRouter, Depends, HTTPException, WebSocket, WebSocketDisconnect
from pydantic import BaseModel

from app.core import agentbus, agents
from app.core.authz import (
    AuthedUser,
    Capability,
    Role,
    ROLE_CAPABILITIES,
    enforce_guest_vm_ownership,
    get_current_user,
    require_capability,
)
from app.core.db import vm_registry_col
from app.core.jobs import transport
from app.core.jobs.models import DoneMsg, ErrorMsg, JobStatus, ProgressMsg, QueuedMsg

router = APIRouter(prefix="/orchestrator", tags=["orchestrator"])

# Mirrors pki-orchestrator's `authz::Role::capabilities()` / command handlers
# (`commands/*.rs`) — there is no automated sync between the two languages,
# but both sides assert against byte-identical catalog fixtures
# (``tests/fixtures/command_catalog.json`` here and in pki-orchestrator), so
# adding a command on one side without the other fails a test instead of
# surfacing as a 422 on dispatch.
_COMMAND_CAPABILITIES: dict[str, Capability] = {
    "hostname.rename": Capability.VM_UPDATE,
    "hostname.read": Capability.VM_READ,
    "ip.read": Capability.VM_READ,
    "ip.write": Capability.VM_UPDATE,
    "cert.verify": Capability.VM_READ,
    "ca.install": Capability.VM_PROVISION,
    "ca.configure_settings": Capability.VM_PROVISION,
    "ca.configure_cdp_aia": Capability.VM_PROVISION,
    "ca.publish_crl": Capability.VM_PROVISION,
    "ca.sign_request": Capability.VM_PROVISION,
    "ca.install_cert": Capability.VM_PROVISION,
    "ca.publish_template": Capability.VM_PROVISION,
    "ca.verify": Capability.VM_READ,
    "file.read": Capability.VM_PROVISION,
    "file.write": Capability.VM_PROVISION,
    "iis.setup_certenroll": Capability.VM_PROVISION,
    "ocsp.install": Capability.VM_PROVISION,
    "ocsp.configure_revocation": Capability.VM_PROVISION,
    "ocsp.verify": Capability.VM_READ,
    "cert.enroll": Capability.VM_PROVISION,
    "dc.install_forest": Capability.VM_PROVISION,
    "dc.verify": Capability.VM_READ,
    "domain.join": Capability.VM_PROVISION,
    "domain.verify": Capability.VM_READ,
    "system.reboot": Capability.VM_PROVISION,
    "dns.set_client": Capability.VM_PROVISION,
    "dns.create_record": Capability.VM_PROVISION,
    "cert.addstore": Capability.VM_PROVISION,
    "cert.dspublish": Capability.VM_PROVISION,
    "template.grant_access": Capability.VM_PROVISION,
    "powershell.exec_arbitrary": Capability.VM_EXEC_ARBITRARY,
}


class RegisterResponse(BaseModel):
    vm_id: str
    token: str


@router.post(
    "/register",
    dependencies=[Depends(require_capability(Capability.VM_CLONE))],
)
def register() -> RegisterResponse:
    """Mint an in-process vm_id/token pair for the manual/dev flow.

    A human copies both values into that agent's ``orchestrator.toml``. Real
    deployed agents are provisioned automatically by the clone worker instead
    (persisted identity) — see the module docstring.
    """
    vm_id, token = agents.register_agent()
    return RegisterResponse(vm_id=vm_id, token=token)


class CommandRequest(BaseModel):
    command: str
    params: dict[str, str] = {}


@router.post("/{vm_id}/command", status_code=202)
async def dispatch_command(
    vm_id: str, req: CommandRequest, user: AuthedUser = Depends(get_current_user)
) -> dict:
    """Dispatch one command to a connected agent; stream progress over ws /api/ws/jobs/{job_id}."""
    required = _COMMAND_CAPABILITIES.get(req.command)
    if required is None:
        raise HTTPException(422, detail=f"Unknown orchestrator command '{req.command}'.")

    role = user.role
    if required not in ROLE_CAPABILITIES[role]:
        raise HTTPException(
            403,
            detail=f"Role '{role.value}' does not have capability '{required.value}'.",
        )

    # Per-VM ownership: resolve vm_id -> the VM it's bound to, and refuse a guest
    # commanding an agent outside its namespace. A persisted agent always has a
    # registry doc; the manual/dev path has none — allowed for operators only.
    doc = await vm_registry_col().find_one({"agent.vmId": vm_id})
    if doc is not None and doc.get("status") == "deleted":
        raise HTTPException(404, detail=f"No orchestrator agent for vm_id '{vm_id}'.")
    vm_name = doc.get("vmName") if doc else None
    if vm_name is not None:
        enforce_guest_vm_ownership(vm_name, user)
    elif role == Role.GUEST:
        raise HTTPException(404, detail=f"No orchestrator agent for vm_id '{vm_id}'.")

    agent = agents.resolve_agent(vm_id)
    if agent is None:
        raise HTTPException(404, detail=f"No connected orchestrator agent for vm_id '{vm_id}'.")

    job_id = uuid.uuid4().hex
    transport.publish(job_id, QueuedMsg(), status=JobStatus.queued)
    await agent.send(
        {"job_id": job_id, "command": req.command, "params": req.params, "role": role.value}
    )
    return {"job_id": job_id}


async def _authenticate(vm_id: str | None, token: str | None) -> bool:
    if not vm_id or not token:
        return False
    if agents.authenticate_pending(vm_id, token):
        return True
    return await agents.authenticate_persisted(vm_id, token)


#: Liveness-key refresh cadence — comfortably inside ``AGENT_CONN_TTL_SECONDS``
#: so an idle-but-live agent's key never lapses between frames.
_KEEPALIVE_INTERVAL_S = 30


async def _keepalive(vm_id: str) -> None:
    """Re-arm the agent's liveness TTL on a fixed cadence for as long as the
    socket lives (frames are sporadic, so the receive loop can't be relied on
    to refresh it). Cancelled in the connect handler's ``finally``."""
    while True:
        await asyncio.sleep(_KEEPALIVE_INTERVAL_S)
        await agentbus.refresh_agent_live(vm_id)


@router.websocket("/connect")
async def connect(websocket: WebSocket) -> None:
    """Accept an orchestrator agent's phone-home connection, mark it live, and
    relay its progress frames onto the job transport.

    vm_id/token come from the ``X-Orchestrator-Vm-Id``/``X-Orchestrator-Token``
    headers (the agent's path) or ``?vm_id=&token=`` (manual/dev). Auth is
    validated before ``accept()`` (4401 on failure). Provisioning is no longer
    kicked off here — the Celery plan runner drives every command through the
    ``agent-dispatch`` bridge (Phase L).
    """
    vm_id = websocket.headers.get("x-orchestrator-vm-id") or websocket.query_params.get("vm_id")
    token = websocket.headers.get("x-orchestrator-token") or websocket.query_params.get("token")
    if not await _authenticate(vm_id, token):
        await websocket.close(code=4401)
        return

    await websocket.accept()
    # Single live connection per vm_id: close any prior socket (a copied ISO or a
    # half-dead reconnect) so it can't shadow the fresh one.
    previous = agents.pop_connection(vm_id)
    if previous is not None:
        try:
            await previous.websocket.close(code=4409)
        except Exception:  # noqa: BLE001 — the old socket may already be gone
            pass
    conn = agents.connect_agent(vm_id, websocket)

    # Mark live (liveness key + lastConnectedAt) — the reboot-resume signal the
    # worker's sequence engine polls. A registry-less manual/dev agent still
    # gets its liveness key; the lastConnectedAt update simply matches nothing.
    await agentbus.mark_agent_live(vm_id)
    keepalive = asyncio.create_task(_keepalive(vm_id))
    try:
        while True:
            frame = await websocket.receive_json()
            job_id = frame.get("job_id")
            state = frame.get("state")
            if job_id and state:
                _relay_progress(job_id, state)
    except WebSocketDisconnect:
        pass
    finally:
        keepalive.cancel()
        with contextlib.suppress(asyncio.CancelledError):
            await keepalive
        await agentbus.clear_agent_live(vm_id)
        agents.disconnect_if(vm_id, conn)


def _relay_progress(job_id: str, state: dict) -> None:
    """Translate one orchestrator `OpRunState` frame onto the existing job transport.

    `pending`/`cancelled` are never emitted by the orchestrator's own
    `report.rs` helpers (only `running`/`done`/`error` are) — anything else
    is ignored rather than guessed at.
    """
    status = state.get("status")
    if status == "running":
        transport.publish(
            job_id,
            ProgressMsg(percent=state.get("percent") or 0.0, phase=state.get("phase") or "", key=job_id),
            status=JobStatus.running,
        )
    elif status == "done":
        transport.publish(
            job_id, DoneMsg(result=state.get("result") or {}), status=JobStatus.done, terminal=True
        )
    elif status == "error":
        transport.publish(
            job_id,
            ErrorMsg(status=500, detail=state.get("detail") or "orchestrator command failed"),
            status=JobStatus.error,
            terminal=True,
        )


@router.get(
    "/agents",
    dependencies=[Depends(require_capability(Capability.VM_LIST))],
)
async def list_agents(user: AuthedUser = Depends(get_current_user)) -> dict:
    """List vm_ids with a currently-connected agent (guests see only their own)."""
    vm_ids = agents.connected_vm_ids()
    if user.role != Role.GUEST:
        return {"vm_ids": vm_ids}

    owned: list[str] = []
    for vm_id in vm_ids:
        doc = await vm_registry_col().find_one({"agent.vmId": vm_id}, {"vmName": 1})
        if doc is None:
            continue
        try:
            enforce_guest_vm_ownership(doc["vmName"], user)
        except HTTPException:
            continue
        owned.append(vm_id)
    return {"vm_ids": owned}
