"""Orchestrator phone-home routes.

The Rust orchestrator agent (``pki-orchestrator``, a separate repo) connects
outbound to ``ws /api/orchestrator/connect`` once running, authenticating
with a vm_id/token pair minted by ``POST /orchestrator/register``. This
stands in for what a real deployment will eventually bake into the boot ISO
automatically — see ``pki-orchestrator/README.md``'s "Future integration
points": ``isokit`` can't embed a compiled binary yet, and ``vmkit`` has no
guest-correlation mechanism.

The connect route's own coroutine is both the agent's live connection and
the relay of its progress frames onto the existing job-progress transport
(``app.core.jobs.transport``) — reusing the single-linear-job message family
(``ProgressMsg``/``DoneMsg``/``ErrorMsg``) and the existing
``/ws/jobs/{job_id}`` WebSocket, so no new wire shape is needed on the
frontend side.

Dispatching a command (``POST /orchestrator/{vm_id}/command``) mints a
``job_id`` the same way ``clone``/``deploy`` do, then sends it down the
agent's live connection. The backend is the authoritative capability gate:
the authenticated user's role is checked here (via a small command->capability table,
since the required capability is chosen dynamically per dispatched command
name rather than statically per route) before a command is even sent to the
agent. That role is included in the frame sent to the agent, which
re-checks it locally as a second, structural gate (see pki-orchestrator's
``phonehome.rs``) — not the primary one.
"""

import uuid

from fastapi import APIRouter, Depends, HTTPException, WebSocket, WebSocketDisconnect
from pydantic import BaseModel

from app.core import agents
from app.core.authz import (
    AuthedUser,
    Capability,
    ROLE_CAPABILITIES,
    get_current_user,
    require_capability,
)
from app.core.jobs import transport
from app.core.jobs.models import DoneMsg, ErrorMsg, JobStatus, ProgressMsg, QueuedMsg

router = APIRouter(prefix="/orchestrator", tags=["orchestrator"])

# Mirrors pki-orchestrator's `authz::Role::capabilities()` / command handlers
# (`commands/*.rs`) — there is no automated sync between the two languages;
# adding a command here without a matching Rust handler (or vice versa) is a
# manual-parity risk, same caveat `authz.rs` already carries in reverse.
_COMMAND_CAPABILITIES: dict[str, Capability] = {
    "hostname.rename": Capability.VM_UPDATE,
    "hostname.read": Capability.VM_READ,
    "ip.read": Capability.VM_READ,
    "ip.write": Capability.VM_UPDATE,
    "cert.verify": Capability.VM_READ,
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
    """Mint a vm_id/token pair for a not-yet-connected orchestrator agent.

    A human copies both values into that agent's ``orchestrator.toml`` before
    running it — see the module docstring for why this is manual today.
    Gated on ``VM_CLONE`` for the same reason ``DEPLOY`` is guest-eligible:
    a guest registering an agent for a VM it could already clone doesn't
    grant anything it couldn't already do.
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

    agent = agents.resolve_agent(vm_id)
    if agent is None:
        raise HTTPException(404, detail=f"No connected orchestrator agent for vm_id '{vm_id}'.")

    job_id = uuid.uuid4().hex
    transport.publish(job_id, QueuedMsg(), status=JobStatus.queued)
    await agent.send(
        {"job_id": job_id, "command": req.command, "params": req.params, "role": role.value}
    )
    return {"job_id": job_id}


@router.websocket("/connect")
async def connect(websocket: WebSocket, vm_id: str | None = None, token: str | None = None) -> None:
    """Accept an orchestrator agent's phone-home connection and relay its progress.

    Auth mirrors ``routers.ws``'s convention: validated before ``accept()``,
    closed with 4401 on failure (here: unknown/already-consumed vm_id, or a
    token mismatch) rather than a normal HTTP error, since this is a
    WebSocket upgrade.
    """
    if not vm_id or not token or not agents.authenticate_pending(vm_id, token):
        await websocket.close(code=4401)
        return

    await websocket.accept()
    agents.connect_agent(vm_id, websocket)
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
        agents.disconnect_agent(vm_id)


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
def list_agents() -> dict:
    """List vm_ids with a currently-connected orchestrator agent."""
    return {"vm_ids": agents.connected_vm_ids()}
