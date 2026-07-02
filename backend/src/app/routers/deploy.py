"""Deploy-plan routes — accept a DAG of staged canvas operations and run them as
one Celery plan job.

Mirrors ``vm.py``'s clone route: ``POST /deploy`` enqueues and returns immediately
with a ``job_id``; the actual walk of the dependency graph happens in the Celery
worker (``app.tasks.run_plan_task``), streaming per-op state over the existing
``/api/ws/jobs/{job_id}`` transport as one ``PlanStateMsg`` per transition.

Vocabulary is exactly the five op kinds the frontend staging store can produce
(see ``frontend/src/lib/staging.ts``). Only ``createVm`` ever touches a real VM;
everything else is a simulated stub for now (see ``app.tasks._simulate_op``).
"""

import uuid
from enum import Enum

from fastapi import APIRouter, Depends, Header, HTTPException
from pydantic import BaseModel, ConfigDict, Field
from vmkit import Connection

from app.core.authz import Capability, enforce_guest_vm_name, require_capability
from app.core.jobs import transport
from app.core.jobs.models import JobStatus, QueuedMsg
from app.core.sessions import get_session
from app.core.settings import settings

router = APIRouter(prefix="/deploy", tags=["deploy"])


class PlanOpKind(str, Enum):
    create_vm = "createVm"
    domain_join = "domainJoin"
    domain_leave = "domainLeave"
    ca_connect = "caConnect"
    web_server_cert = "webServerCert"


class PlanOp(BaseModel):
    model_config = ConfigDict(populate_by_name=True)

    id: str
    kind: PlanOpKind
    target: str
    params: dict[str, str] = Field(default_factory=dict)
    depends_on: list[str] = Field(default_factory=list, alias="dependsOn")


class DeployRequest(BaseModel):
    ops: list[PlanOp] = Field(min_length=1, max_length=50)


def validate_plan(ops: list[PlanOp], token: str) -> None:
    """Raise 422 on a malformed plan: duplicate ids, unknown/self deps, cycles,
    or a non-simulated ``createVm`` missing the ``vmName`` param.

    Also rewrites each non-simulated ``createVm``'s ``vmName`` in place via
    ``enforce_guest_vm_name`` — a guest must not be able to name a real VM
    outside its own session's namespace.

    Called explicitly from the route (not a pydantic validator) so the checks
    stay easy to read and the errors are unambiguous 422s.
    """
    ids = [op.id for op in ops]
    if len(ids) != len(set(ids)):
        raise HTTPException(422, detail="Plan contains duplicate op ids.")

    id_set = set(ids)
    for op in ops:
        if op.id in op.depends_on:
            raise HTTPException(422, detail=f"Op '{op.id}' depends on itself.")
        unknown = [dep for dep in op.depends_on if dep not in id_set]
        if unknown:
            raise HTTPException(
                422, detail=f"Op '{op.id}' depends on unknown op(s): {unknown}."
            )
        if op.kind is PlanOpKind.create_vm and op.params.get("simulate") != "true":
            if not op.params.get("vmName"):
                raise HTTPException(
                    422, detail=f"Op '{op.id}' (createVm) is missing the 'vmName' param."
                )
            # The worker opens its own ESXi connection from these same
            # settings (see app.tasks.run_plan_task) — without them a real
            # clone can't run at all, so reject it here rather than letting
            # the worker crash on `open_connection(None, ...)` (notably every
            # login-mode deploy, where these are never set).
            if not (settings.esxi_host and settings.esxi_user and settings.esxi_password):
                raise HTTPException(
                    422,
                    detail=(
                        f"Op '{op.id}' (createVm) requests a real clone, but no ESXi "
                        "connection is configured for this deploy — simulate it instead."
                    ),
                )
            op.params["vmName"] = enforce_guest_vm_name(op.params["vmName"], token)

    # Kahn's algorithm: a plan with a dependency cycle can never fully drain.
    indegree = {op.id: 0 for op in ops}
    dependents: dict[str, list[str]] = {op.id: [] for op in ops}
    for op in ops:
        for dep in op.depends_on:
            dependents[dep].append(op.id)
            indegree[op.id] += 1

    ready = [op_id for op_id, deg in indegree.items() if deg == 0]
    visited = 0
    while ready:
        op_id = ready.pop()
        visited += 1
        for nxt in dependents[op_id]:
            indegree[nxt] -= 1
            if indegree[nxt] == 0:
                ready.append(nxt)

    if visited != len(ops):
        raise HTTPException(422, detail="Plan contains a dependency cycle.")


@router.post(
    "",
    status_code=202,
    dependencies=[Depends(require_capability(Capability.DEPLOY))],
)
async def deploy(
    req: DeployRequest,
    x_session_token: str = Header(...),
    _conn: Connection = Depends(get_session),
) -> dict:
    """Enqueue a deploy plan as a Celery job; stream progress over ws /api/ws/jobs/{job_id}.

    ``get_session`` gates on a valid token exactly like the clone route — the
    resolved ``Connection`` goes unused here since the actual work runs in a
    separate worker process which opens its own ESXi connection (see
    ``app.tasks.run_plan_task``, which therefore only does real clones when the
    worker process also has guest-mode ``ESXI_*`` env vars set).
    """
    from app.tasks import run_plan_task  # local import: avoids loading Celery for every route

    validate_plan(req.ops, x_session_token)

    job_id = uuid.uuid4().hex
    transport.publish(job_id, QueuedMsg(), status=JobStatus.queued)
    run_plan_task.delay(job_id, req.model_dump(by_alias=True))
    return {"job_id": job_id}
