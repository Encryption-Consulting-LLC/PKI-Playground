"""Deploy-plan routes — accept a DAG of staged canvas operations and run them as
one Celery plan job.

Mirrors ``vm.py``'s clone route: ``POST /deploy`` enqueues and returns immediately
with a ``job_id``; the actual walk of the dependency graph happens in the Celery
worker (``app.tasks.run_plan_task``), streaming per-op state over the existing
``/api/ws/jobs/{job_id}`` transport as one ``PlanStateMsg`` per transition.

Vocabulary is exactly the five op kinds the frontend staging store can produce
(see ``frontend/src/lib/staging.ts``). Every ``createVm`` is a
real clone — the server decides, never a client flag — booted from a per-VM
firstboot ISO carrying a pool-allocated guest IP; the other four kinds remain
simulated stubs (see ``app.tasks._simulate_op``).
"""

import re
import uuid
from enum import Enum

from bson import ObjectId
from bson.errors import InvalidId
from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel, ConfigDict, Field

from app.core.authz import (
    ROLE_CAPABILITIES,
    AuthedUser,
    Capability,
    Role,
    enforce_guest_vm_name,
    get_current_user,
    require_capability,
)
from app.core.db import SETTINGS_DOC_ID, get_db, settings_col, vm_registry_col
from app.core.esxi import _target_from_doc
from app.core.firstboot import TEMPLATE_IDS
from app.core.ippool import guest_network_from_doc
from app.core.template_config import validate_template_config
from app.core.jobs import transport
from app.core.jobs.models import JobStatus, QueuedMsg

router = APIRouter(prefix="/deploy", tags=["deploy"])

# Authored-ISO caps. Files ride inline in the deploy payload (and
# through the Celery broker), so they are text-only and tightly bounded.
ISO_MAX_FILES = 20
ISO_FILE_MAX_BYTES = 256 * 1024
ISO_OP_MAX_BYTES = 512 * 1024
ISO_PLAN_MAX_BYTES = 2 * 1024 * 1024
#: .ps1/.sh only for now: the deployed golden image's runner dispatches every
#: manifest entry it can execute; .cmd/.bat wait on the v2 runner rollout
#: (VM-Setup-Scripts) being promoted to the default base image.
_ISO_FILE_NAME = re.compile(r"^[A-Za-z0-9][A-Za-z0-9._-]{0,63}\.(ps1|sh)$")


class PlanOpKind(str, Enum):
    create_vm = "createVm"
    domain_join = "domainJoin"
    domain_leave = "domainLeave"
    ca_connect = "caConnect"
    web_server_cert = "webServerCert"


class IsoFile(BaseModel):
    """One operator-authored firstboot script riding inline in a createVm op."""

    name: str
    # max_length counts characters; validate_plan re-checks encoded bytes for
    # the per-op and per-plan sums.
    content: str = Field(max_length=ISO_FILE_MAX_BYTES)


class PlanOp(BaseModel):
    model_config = ConfigDict(populate_by_name=True)

    id: str
    kind: PlanOpKind
    target: str
    #: The second node an op involves: the DC a member joins, the
    #: parent CA an issuing CA connects to, the CA issuing a web/client cert.
    #: The backend resolves both nodes' real guest-namespaced identities from
    #: the registry when expanding the op into agent commands.
    secondary: str | None = None
    params: dict[str, str] = Field(default_factory=dict)
    files: list[IsoFile] = Field(default_factory=list, max_length=ISO_MAX_FILES)
    depends_on: list[str] = Field(default_factory=list, alias="dependsOn")


class DeployRequest(BaseModel):
    model_config = ConfigDict(populate_by_name=True)

    ops: list[PlanOp] = Field(min_length=1, max_length=50)
    #: The project the canvas belongs to. For guests it supplies the ``<project>``
    #: segment of every derived VM name (``guest-<user>-<project>-<machine>``) and
    #: is required when the plan clones. Operators keep free-form names and ignore
    #: it. It's a naming/organisation segment only — the name stays inside the
    #: caller's ``guest-<user>-`` namespace regardless, so it needs no membership
    #: check (guests have no server-side project records today).
    project_id: str | None = Field(default=None, alias="projectId")


def validate_plan(
    ops: list[PlanOp],
    user: AuthedUser,
    *,
    target_configured: bool,
    guest_network_configured: bool,
    project_id: str | None = None,
) -> None:
    """Raise 422 on a malformed plan: duplicate ids, unknown/self deps, cycles,
    a ``createVm`` missing its ``vmName``/``template`` params, or invalid
    authored-ISO content — and 403 when a role without ``ISO_AUTHOR`` submits
    authored content at all.

    Every ``createVm`` is a real clone (any client ``simulate`` param is
    ignored — real-vs-stub is never client authority), so each one needs a
    configured shared ESXi target up front. The guest IP range is only needed
    on the default path: an authored op (inline ``files`` or an uploaded-ISO
    ``isoId``) is the complete disc — the server injects nothing and claims no
    pool address. Also rewrites each ``createVm``'s ``vmName`` in place via
    ``enforce_guest_vm_name`` — a guest must not be able to name a real VM
    outside its own identity's namespace; the derived guest name is
    ``guest-<user>-<project>-<machine>``, so a guest clone needs ``project_id``.
    Finally rejects two ``createVm`` ops that resolve to the same derived name.

    Called explicitly from the route (not a pydantic validator) so the checks
    stay easy to read and the errors are unambiguous 422s.
    """
    ids = [op.id for op in ops]
    if len(ids) != len(set(ids)):
        raise HTTPException(422, detail="Plan contains duplicate op ids.")

    # A guest's real clone names are derived as guest-<user>-<project>-<machine>;
    # the project segment comes from this plan's project context, so a clone
    # without one can't be named. Operators keep free-form names and don't need it.
    if (
        user.role is Role.GUEST
        and not (project_id and project_id.strip())
        and any(op.kind is PlanOpKind.create_vm for op in ops)
    ):
        raise HTTPException(
            422,
            detail="A guest deploy that clones a VM needs a project context (projectId).",
        )

    id_set = set(ids)
    plan_files_bytes = 0
    seen_iso_ids: set[str] = set()
    for op in ops:
        if op.id in op.depends_on:
            raise HTTPException(422, detail=f"Op '{op.id}' depends on itself.")
        unknown = [dep for dep in op.depends_on if dep not in id_set]
        if unknown:
            raise HTTPException(
                422, detail=f"Op '{op.id}' depends on unknown op(s): {unknown}."
            )
        if op.kind is not PlanOpKind.create_vm:
            if op.files or op.params.get("isoId"):
                raise HTTPException(
                    422,
                    detail=f"Op '{op.id}': ISO content is only valid on createVm ops.",
                )
            # Cross-node ops name their second node so the backend can resolve
            # its real identity. ``secondary``/``target`` are canvas
            # node ids (not op ids), resolved from the registry at run time — a
            # node created earlier this plan or surviving from a prior deploy —
            # so they aren't validated against the op-id set here. domainLeave
            # targets a membership the node already holds, so it needs none.
            if op.secondary is not None and op.secondary == op.target:
                raise HTTPException(
                    422, detail=f"Op '{op.id}' has itself as its secondary node."
                )
            if (
                op.kind in (PlanOpKind.domain_join, PlanOpKind.ca_connect, PlanOpKind.web_server_cert)
                and not op.secondary
            ):
                raise HTTPException(
                    422,
                    detail=(
                        f"Op '{op.id}' ({op.kind.value}) needs a 'secondary' node "
                        "(the DC / parent CA / issuing CA it wires to)."
                    ),
                )
            continue

        if not op.params.get("vmName"):
            raise HTTPException(
                422, detail=f"Op '{op.id}' (createVm) is missing the 'vmName' param."
            )
        if op.params.get("template") not in TEMPLATE_IDS:
            raise HTTPException(
                422,
                detail=f"Op '{op.id}' (createVm) has a missing or unknown 'template' param.",
            )
        # Per-template config (CA algorithm/key length, …) rides flat in params;
        # this is the authoritative validator + the unknown-key injection gate.
        try:
            validate_template_config(op.params["template"], op.params)
        except ValueError as exc:
            raise HTTPException(422, detail=f"Op '{op.id}' (createVm): {exc}") from exc

        iso_id = op.params.get("isoId")
        authored = bool(op.files) or bool(iso_id)
        if authored:
            # The hard authored-ISO gate: authored discs run arbitrary scripts as
            # SYSTEM and bypass the pool — DEPLOY alone (guest-eligible) must
            # never be enough to submit one.
            if Capability.ISO_AUTHOR not in ROLE_CAPABILITIES[user.role]:
                raise HTTPException(
                    403,
                    detail=(
                        f"Role '{user.role.value}' does not have capability "
                        f"'{Capability.ISO_AUTHOR.value}'."
                    ),
                )
            if op.files and iso_id:
                raise HTTPException(
                    422,
                    detail=(
                        f"Op '{op.id}' (createVm) carries both inline files and an "
                        "uploaded ISO — pick one."
                    ),
                )
            if iso_id and iso_id in seen_iso_ids:
                raise HTTPException(
                    422,
                    detail=(
                        f"Op '{op.id}' (createVm) reuses an uploaded ISO already "
                        "consumed by another op in this plan."
                    ),
                )
            if iso_id:
                seen_iso_ids.add(iso_id)

            op_bytes = 0
            names: set[str] = set()
            for file in op.files:
                if not _ISO_FILE_NAME.match(file.name):
                    raise HTTPException(
                        422,
                        detail=(
                            f"Op '{op.id}': invalid script filename '{file.name}' "
                            "(letters/digits/._- and a .ps1/.sh extension)."
                        ),
                    )
                if file.name in names:
                    raise HTTPException(
                        422, detail=f"Op '{op.id}': duplicate script filename '{file.name}'."
                    )
                names.add(file.name)
                op_bytes += len(file.content.encode("utf-8"))
            if op_bytes > ISO_OP_MAX_BYTES:
                raise HTTPException(
                    422,
                    detail=(
                        f"Op '{op.id}': authored files exceed "
                        f"{ISO_OP_MAX_BYTES // 1024} KiB total."
                    ),
                )
            plan_files_bytes += op_bytes
            if plan_files_bytes > ISO_PLAN_MAX_BYTES:
                raise HTTPException(
                    422,
                    detail=(
                        "Authored files across the plan exceed "
                        f"{ISO_PLAN_MAX_BYTES // 1024} KiB total."
                    ),
                )

        # The worker opens its own ESXi connection against the shared
        # target from the settings document (see app.tasks) — without a
        # configured target a real clone can't run at all, so reject it
        # here rather than letting the worker fail the op later.
        if not target_configured:
            raise HTTPException(
                422,
                detail=(
                    f"Op '{op.id}' (createVm) needs a shared ESXi target, but none is configured"
                ),
            )
        # Same fail-early logic for the IP the clone's firstboot ISO bakes in —
        # unless the op is authored, in which case no pool address is used.
        if not authored and not guest_network_configured:
            raise HTTPException(
                422,
                detail=(
                    f"Op '{op.id}' (createVm) needs a guest IP range, but none is configured"
                ),
            )
        op.params["vmName"] = enforce_guest_vm_name(op.params["vmName"], user, project_id)

    # Reject two createVm ops that resolve to the same real VM name (e.g. two
    # nodes both labelled "dc01" in one project) before enqueuing — the user
    # renames a node rather than the worker failing the second clone on VmExists.
    derived: dict[str, str] = {}
    for op in ops:
        if op.kind is not PlanOpKind.create_vm:
            continue
        vm_name = op.params["vmName"]
        if vm_name in derived:
            raise HTTPException(
                422,
                detail=(
                    f"Ops '{derived[vm_name]}' and '{op.id}' resolve to the same VM "
                    f"name '{vm_name}' — rename a node."
                ),
            )
        derived[vm_name] = op.id

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
    user: AuthedUser = Depends(get_current_user),
) -> dict:
    """Enqueue a deploy plan as a Celery job; stream progress over ws /api/ws/jobs/{job_id}.

    The actual work runs in a separate worker process which opens its own ESXi
    connection against the shared target from the settings document (see
    ``app.tasks.run_plan_task``) — this route validates the plan and, for
    plans containing real clones, that a target is configured at all.
    """
    from app.tasks import run_plan_task  # local import: avoids loading Celery for every route

    doc = await settings_col().find_one({"_id": SETTINGS_DOC_ID})
    validate_plan(
        req.ops,
        user,
        target_configured=_target_from_doc(doc) is not None,
        guest_network_configured=guest_network_from_doc(doc) is not None,
        project_id=req.project_id,
    )

    # Reject a derived name that already belongs to a *different* live VM before
    # enqueuing (a clean 409 rather than a late per-op VmExists). An existing
    # entry whose ``appName`` is one of this plan's own createVm nodes is that
    # node's prior/failed attempt being retried, not a collision — exclude it.
    create_ops = [op for op in req.ops if op.kind is PlanOpKind.create_vm]
    if create_ops:
        plan_node_ids = {op.target for op in create_ops}
        names = [op.params["vmName"] for op in create_ops]
        cursor = vm_registry_col().find(
            {"vmName": {"$in": names}, "status": {"$ne": "deleted"}},
            projection={"vmName": 1, "appName": 1},
        )
        async for entry in cursor:
            if entry.get("appName") not in plan_node_ids:
                raise HTTPException(
                    409,
                    detail=(
                        f"A VM named '{entry['vmName']}' already exists — "
                        "rename the node before deploying."
                    ),
                )

    # Uploaded ISOs must exist before the plan is enqueued — the worker can
    # only turn a missing GridFS file into a late op error, so fail the whole
    # request here while the client can still fix it.
    for op in req.ops:
        iso_id = op.params.get("isoId")
        if not iso_id:
            continue
        try:
            oid = ObjectId(iso_id)
        except InvalidId:
            raise HTTPException(
                422, detail=f"Op '{op.id}': 'isoId' is not a valid ISO reference."
            )
        if await get_db()["isos.files"].find_one({"_id": oid}, {"_id": 1}) is None:
            raise HTTPException(
                422,
                detail=(
                    f"Op '{op.id}': uploaded ISO '{iso_id}' not found — it may have "
                    "been consumed or expired; re-upload and retry."
                ),
            )

    job_id = uuid.uuid4().hex
    transport.publish(job_id, QueuedMsg(), status=JobStatus.queued)
    # Owner role rides along so a minted agent's provisioning command is later
    # dispatched under the deploying user's role (both roles hold VM_PROVISION).
    run_plan_task.delay(job_id, req.model_dump(by_alias=True), user.role.value)
    return {"job_id": job_id}
