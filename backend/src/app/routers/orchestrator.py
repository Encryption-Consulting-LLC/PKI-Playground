"""Orchestrator phone-home routes.

The Rust ``pki-orchestrator`` agent connects outbound to
``ws /api/orchestrator/connect`` once running, authenticating with a
vm_id/token pair. Two ways that pair exists:

* **Persisted (Phase F):** the clone worker mints it and stores the hash on the
  VM's ``vm_registry`` document; the agent binary + its ``orchestrator.toml``
  are baked onto the firstboot ISO, so a real deployed agent phones home with
  no human in the loop. Per-template provisioning config is **not** on the ISO
  — it lives on the same registry doc and is dispatched here the moment the
  agent connects (see ``_start_provisioning``).
* **Pending (manual/dev):** ``POST /orchestrator/register`` mints an in-process
  pair a human pastes into a local config.

Auth is validated before ``accept()`` (4401 on failure); the agent sends
vm_id/token as request headers (kept out of access logs), with the browser-style
``?vm_id=&token=`` query still accepted for the manual path.

Dispatching a command (``POST /orchestrator/{vm_id}/command``) is capability-gated
*and* ownership-gated: a guest can only command an agent bound to a VM in its own
namespace. The authenticated caller's role is forwarded in the frame; the agent
re-checks it locally as a second, structural gate (see ``phonehome.rs``).
"""

import uuid

from fastapi import APIRouter, Depends, HTTPException, WebSocket, WebSocketDisconnect
from pydantic import BaseModel
from pymongo import ReturnDocument

from app.core import agents
from app.core.authz import (
    AuthedUser,
    Capability,
    Role,
    ROLE_CAPABILITIES,
    enforce_guest_vm_ownership,
    get_current_user,
    require_capability,
)
from app.core.db import now_ms, vm_registry_col
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
    "ca.configure_cdp_aia": Capability.VM_PROVISION,
    "ca.verify": Capability.VM_READ,
    "dc.verify": Capability.VM_READ,
    "domain.verify": Capability.VM_READ,
    "dns.set_client": Capability.VM_PROVISION,
    "dns.create_record": Capability.VM_PROVISION,
    "cert.addstore": Capability.VM_PROVISION,
    "cert.dspublish": Capability.VM_PROVISION,
    "template.grant_access": Capability.VM_PROVISION,
    "powershell.exec_arbitrary": Capability.VM_EXEC_ARBITRARY,
}

#: The single command a template auto-provisions on first connect (Phase F).
#: Templates absent here have nothing to self-provision this phase.
_PROVISION_COMMAND: dict[str, str] = {
    "certificateAuthority": "ca.install",
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


async def _start_provisioning(vm_id: str, agent: agents.AgentConnection) -> str | None:
    """If this VM has pending template provisioning, dispatch it now.

    Atomically flips ``agent.provisionState`` pending→applying (so a reconnect
    race dispatches once), then sends the template's provisioning command with
    the VM's stored config as params under a deterministic ``apply-<vmId>`` job.
    Returns that job id so the connect loop can finalize it; ``None`` if there
    is nothing to provision (or another connection already claimed it).
    """
    doc = await vm_registry_col().find_one_and_update(
        {
            "agent.vmId": vm_id,
            "agent.provisionState": "pending",
            "status": {"$ne": "deleted"},
        },
        {"$set": {"agent.provisionState": "applying", "agent.connectedAt": now_ms()}},
        return_document=ReturnDocument.AFTER,
    )
    if doc is None:
        return None

    agent_doc = doc.get("agent", {})
    command = _PROVISION_COMMAND.get(agent_doc.get("templateId"))
    if command is None:
        # Nothing to run for this template — provisioning is trivially complete.
        await _finalize_provisioning(vm_id, "done")
        return None

    job_id = f"apply-{vm_id}"
    transport.publish(job_id, QueuedMsg(), status=JobStatus.queued)
    await agent.send(
        {
            "job_id": job_id,
            "command": command,
            "params": agent_doc.get("templateConfig") or {},
            # Forward the VM owner's role (both roles hold VM_PROVISION); the
            # agent re-checks it as its structural second gate.
            "role": agent_doc.get("role") or Role.GUEST.value,
        }
    )
    return job_id


async def _finalize_provisioning(vm_id: str, status: str) -> None:
    """Record the terminal outcome of the provisioning job on the registry doc."""
    state = "applied" if status == "done" else "failed"
    await vm_registry_col().update_one(
        {"agent.vmId": vm_id},
        {"$set": {"agent.provisionState": state, "updatedAt": now_ms()}},
    )


@router.websocket("/connect")
async def connect(websocket: WebSocket) -> None:
    """Accept an orchestrator agent's phone-home connection and relay its progress.

    vm_id/token come from the ``X-Orchestrator-Vm-Id``/``X-Orchestrator-Token``
    headers (the agent's path) or ``?vm_id=&token=`` (manual/dev). Auth is
    validated before ``accept()`` (4401 on failure).
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

    provision_job = await _start_provisioning(vm_id, conn)
    try:
        while True:
            frame = await websocket.receive_json()
            job_id = frame.get("job_id")
            state = frame.get("state")
            if job_id and state:
                _relay_progress(job_id, state)
                if provision_job and job_id == provision_job and state.get("status") in (
                    "done",
                    "error",
                ):
                    await _finalize_provisioning(vm_id, state["status"])
                    provision_job = None
    except WebSocketDisconnect:
        pass
    finally:
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
