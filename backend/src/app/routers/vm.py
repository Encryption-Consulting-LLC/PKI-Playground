"""VM management routes — thin HTTP layer over vmkit.

Every endpoint requires an authenticated ESXi session; the ``X-Session-Token``
header is resolved to a live ``Connection`` by the ``get_session`` dependency
(defined in ``app.core.sessions``).

Every endpoint also requires a role capability checked by ``require_capability``
(defined in ``app.core.authz``). The allowlist is deployment-level (set by
AUTH_MODE) so operator deploys are unaffected; guest deploys are restricted to
the read/guided subset.

Note on ``iso_path``: clone/update accept a server-local ``.iso`` filesystem
path. The file must already exist on the host running this API. Building or
uploading ISOs from a client is an isokit concern and is not in scope here.
"""

import uuid
from dataclasses import asdict
from typing import Callable

from fastapi import APIRouter, Depends, Header
from pydantic import BaseModel
from vmkit import Connection, Phase, ProgressEvent, update_workflow
from vmkit.errors import VmNotFoundError
from vmkit.esxi import get_vm_by_name, list_vm_names, power_off_vm, power_on_vm
from vmkit.workflows import get_vm_config, validate_disk_usage

from app.core.authz import Capability, enforce_guest_vm_name, require_capability
from app.core.jobs import transport
from app.core.jobs.models import JobStatus, Message, ProgressMsg, QueuedMsg
from app.core.sessions import get_session

router = APIRouter(prefix="/vm", tags=["vm"])

#: Producer-facing sink: thread-safe, never raises. The clone task (running in the
#: Celery worker process) passes a Valkey-backed implementation of this shape.
Publish = Callable[[Message], None]


class CloneProgressReducer:
    """Collapse vmkit's multi-operation event stream into one overall percent.

    A clone fans out across several keyed sub-operations (VMDK copy, nvram copy,
    optional ISO upload, VMX upload, register, optional power-on), each reporting
    0–100% independently. We give the client a single monotonic bar by counting
    completed sub-ops (``Phase.END`` events) and adding the in-flight op's
    fraction: ``percent = (done_ops + current_fraction) / total_ops``.

    ``total_ops`` is derived from the request flags so the bar reaches 100%.
    """

    def __init__(self, publish: Publish, total_ops: int) -> None:
        self._publish = publish
        self._total = max(total_ops, 1)
        self._done_ops = 0

    def __call__(self, event: ProgressEvent) -> None:
        # Errors propagate as exceptions and become the job's terminal message;
        # don't emit a progress sample for them.
        if event.phase is Phase.ERROR:
            return
        if event.phase is Phase.END:
            self._done_ops += 1
            fraction = 0.0  # the just-finished op is now fully counted above
        else:
            fraction = event.fraction
        percent = min(100.0, (self._done_ops + fraction) / self._total * 100.0)
        self._publish(
            ProgressMsg(
                percent=round(percent, 1),
                phase=event.label,
                key=event.key,
                unit=event.unit,
            )
        )


def _clone_total_ops(req: "CloneRequest") -> int:
    # VMDK copy + nvram copy + VMX upload + register, plus ISO upload / power-on.
    return 4 + (1 if req.iso_path else 0) + (1 if req.power_on else 0)


# --------------------------------------------------------------------------- #
# Request models                                                              #
# --------------------------------------------------------------------------- #
class CloneRequest(BaseModel):
    name: str
    base: str
    datastore: str
    cpus: int
    mem_mb: int
    mac: str | None = None
    iso_path: str | None = None
    guest_os: str | None = None
    max_usage_pct: float = 80.0
    skip_disk_check: bool = False
    power_on: bool = False


class UpdateRequest(BaseModel):
    datastore: str
    cpus: int | None = None
    mem_mb: int | None = None
    mac: str | None = None
    iso_path: str | None = None
    remove_iso: bool = False
    power_on: bool = False


class DiskCheckRequest(BaseModel):
    datastore: str
    base: str
    max_usage_pct: float = 80.0


# --------------------------------------------------------------------------- #
# Endpoints (static routes before /{name} to avoid path collisions)           #
# --------------------------------------------------------------------------- #
@router.post(
    "/clone",
    status_code=202,
    dependencies=[Depends(require_capability(Capability.VM_CLONE))],
)
async def clone(
    req: CloneRequest,
    x_session_token: str = Header(...),
    _conn: Connection = Depends(get_session),
) -> dict:
    """Enqueue a clone as a Celery job; stream progress over ws /api/ws/jobs/{job_id}.

    Returns ``202 {"job_id": ...}`` immediately. The actual clone runs in a separate
    Celery worker process (bounded by ``celery worker --concurrency``, the global
    cap protecting the shared ESXi host) rather than on this request's connection —
    the worker opens its own ``Connection`` from the guest-mode ESXi settings, since
    a worker process can't reach this process's in-process session store. ``get_session``
    is still required here purely as the auth/session gate (a valid token to clone at
    all); the resolved ``Connection`` itself goes unused.

    The job starts life as ``queued`` (this message is published before the task is
    even handed to Celery) so a client watching the WebSocket sees it wait if the
    worker pool is busy, then transition to ``running`` once picked up.
    """
    from app.tasks import clone_vm_task  # local import: avoids loading Celery for every route

    req.name = enforce_guest_vm_name(req.name, x_session_token)

    job_id = uuid.uuid4().hex
    transport.publish(job_id, QueuedMsg(), status=JobStatus.queued)
    clone_vm_task.delay(job_id, req.model_dump())
    return {"job_id": job_id}


@router.post(
    "/disk-check",
    dependencies=[Depends(require_capability(Capability.VM_READ))],
)
def disk_check(req: DiskCheckRequest, conn: Connection = Depends(get_session)) -> dict:
    """Report datastore space usage; 409 if cloning the base would exceed the limit."""
    usage = validate_disk_usage(conn.content, req.datastore, req.base, req.max_usage_pct)
    return asdict(usage)


@router.get(
    "",
    dependencies=[Depends(require_capability(Capability.VM_LIST))],
)
def list_vms(conn: Connection = Depends(get_session)) -> dict:
    """List all VM names in inventory."""
    names = sorted(list_vm_names(conn.content))
    return {"vms": names, "count": len(names)}


@router.get(
    "/{name}",
    dependencies=[Depends(require_capability(Capability.VM_READ))],
)
def get_vm(name: str, conn: Connection = Depends(get_session)) -> dict:
    """Return the current CPU/RAM/MAC and power state of a registered VM."""
    vm = get_vm_by_name(conn.content, name)
    if vm is None:
        raise VmNotFoundError(f"VM '{name}' not found.")
    config = get_vm_config(vm)
    return {"name": name, "power_state": str(vm.runtime.powerState), **config}


@router.patch(
    "/{name}",
    dependencies=[Depends(require_capability(Capability.VM_UPDATE))],
)
def update_vm(
    name: str, req: UpdateRequest, conn: Connection = Depends(get_session)
) -> dict:
    """Reconfigure an existing VM's CPU/RAM/MAC/ISO; unspecified values are preserved."""
    result = update_workflow(conn, name=name, **req.model_dump())
    return asdict(result)


@router.post(
    "/{name}/power-on",
    dependencies=[Depends(require_capability(Capability.VM_POWER))],
)
def power_on(name: str, conn: Connection = Depends(get_session)) -> dict:
    """Power on the named VM."""
    power_on_vm(conn.content, name)
    return {"status": "powered_on", "name": name}


@router.post(
    "/{name}/power-off",
    dependencies=[Depends(require_capability(Capability.VM_POWER))],
)
def power_off(name: str, conn: Connection = Depends(get_session)) -> dict:
    """Power off (hard) the named VM."""
    power_off_vm(conn.content, name)
    return {"status": "powered_off", "name": name}
