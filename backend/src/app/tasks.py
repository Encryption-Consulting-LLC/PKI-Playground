"""Celery tasks. Runs in the worker process — never inside the FastAPI app.

The clone task owns the blocking vmkit call and publishes progress over the Valkey
transport (``app.core.jobs.transport``). It reuses ``CloneProgressReducer`` and
``_clone_total_ops`` from the clone route unchanged, and ``map_vmkit_error`` for the
same error → status mapping the synchronous routes use.

The plan runner (``run_plan_task``) walks a validated deploy-plan DAG the same way:
one real vmkit call for a non-simulated ``createVm`` op, a timed stub for
everything else. Like the clone task, it opens its own ESXi connection from
guest-mode env vars — a real ``createVm`` therefore only works when the worker
process has ``ESXI_*`` set (guest mode, or login mode with those also set).
"""

import time
from dataclasses import asdict
from typing import TYPE_CHECKING

from pyVim.connect import Disconnect
from vmkit import clone_workflow, open_connection
from vmkit.errors import VmkitError

from app.celery_app import celery_app
from app.core.errors import map_vmkit_error
from app.core.jobs import transport
from app.core.jobs.models import (
    DoneMsg,
    ErrorMsg,
    JobStatus,
    OpRunState,
    PlanStateMsg,
    ProgressMsg,
    RunningMsg,
)
from app.core.settings import settings

if TYPE_CHECKING:
    from vmkit import Connection

    from app.routers.deploy import PlanOp

#: Server-side mirror of the frontend's STANDALONE_CLONE (constants/templates.ts /
#: the pre-staging topology.ts) — the backend does not accept arbitrary hardware
#: params from the client, only the per-VM name.
PLAN_CLONE_DEFAULTS = {
    "base": "ws-2025-base",
    "datastore": "datastore1",
    "cpus": 2,
    "mem_mb": 4096,
}

#: Three named phases per simulated op kind, ticked at a fixed cadence.
_SIMULATED_PHASES: dict[str, tuple[str, str, str]] = {
    "createVm": ("Provisioning VM", "Powering on", "Waiting for guest OS"),
    "domainJoin": ("Joining domain", "Rebooting", "Verifying membership"),
    "domainLeave": ("Leaving domain", "Rebooting", "Verifying removal"),
    "caConnect": ("Generating CSR", "Signing certificate", "Installing CA certificate"),
    "webServerCert": ("Requesting certificate", "Binding to IIS", "Publishing CDP/AIA"),
}
_SIMULATED_PERCENTS = (33.0, 66.0, 100.0)
_SIMULATED_STEP_SECONDS = 0.6


@celery_app.task(name="clone_vm")
def clone_vm_task(job_id: str, params: dict) -> None:
    # Imported lazily to avoid a hard import-time dependency between the worker
    # entrypoint and the FastAPI router module.
    from app.routers.vm import CloneProgressReducer, CloneRequest, _clone_total_ops

    transport.publish(job_id, RunningMsg(), status=JobStatus.running)

    try:
        req = CloneRequest(**params)
        conn = open_connection(
            settings.esxi_host,  # type: ignore[arg-type]
            settings.esxi_user,  # type: ignore[arg-type]
            settings.esxi_password,  # type: ignore[arg-type]
            settings.esxi_port,
        )
        reducer = CloneProgressReducer(transport.make_publisher(job_id), _clone_total_ops(req))
        result = clone_workflow(conn, progress=reducer, **params)
        transport.publish(
            job_id, DoneMsg(result=asdict(result)), status=JobStatus.done, terminal=True
        )
    except VmkitError as exc:
        status, detail = map_vmkit_error(exc)
        transport.publish(
            job_id, ErrorMsg(status=status, detail=detail), status=JobStatus.error, terminal=True
        )
    except Exception as exc:  # noqa: BLE001 — surface anything as a terminal error
        transport.publish(
            job_id, ErrorMsg(status=500, detail=str(exc)), status=JobStatus.error, terminal=True
        )


def _op_progress_publisher(state: dict[str, OpRunState], op_id: str, push):
    """``Publish``-shaped callable that folds ``ProgressMsg`` samples from
    ``CloneProgressReducer`` into this op's slot in the plan state, then pushes
    the whole snapshot."""

    def _publish(msg) -> None:
        if isinstance(msg, ProgressMsg):
            state[op_id] = OpRunState(status="running", percent=msg.percent, phase=msg.phase)
            push()

    return _publish


def _run_clone_op(
    conn: "Connection", op: "PlanOp", state: dict[str, OpRunState], push
) -> bool:
    """Execute a non-simulated ``createVm`` op for real. Returns False on failure."""
    from app.routers.vm import CloneProgressReducer, CloneRequest, _clone_total_ops

    state[op.id] = OpRunState(status="running", percent=0.0, phase="Starting")
    push()
    try:
        req = CloneRequest(name=op.params["vmName"], **PLAN_CLONE_DEFAULTS)
        reducer = CloneProgressReducer(
            _op_progress_publisher(state, op.id, push), _clone_total_ops(req)
        )
        result = clone_workflow(conn, progress=reducer, **req.model_dump())
        state[op.id] = OpRunState(
            status="done", percent=100.0, phase="Done", result=asdict(result)
        )
        push()
        return True
    except VmkitError as exc:
        status, detail = map_vmkit_error(exc)
        state[op.id] = OpRunState(status="error", detail=f"{status}: {detail}")
        push()
        return False
    except Exception as exc:  # noqa: BLE001 — surface as an op-level failure, not a plan crash
        state[op.id] = OpRunState(status="error", detail=str(exc))
        push()
        return False


def _simulate_op(op: "PlanOp", state: dict[str, OpRunState], push) -> bool:
    """Advance a stubbed op through its 3 named phases. Always succeeds in v1."""
    phases = _SIMULATED_PHASES[op.kind.value]
    for phase, percent in zip(phases, _SIMULATED_PERCENTS):
        time.sleep(_SIMULATED_STEP_SECONDS)
        state[op.id] = OpRunState(status="running", percent=percent, phase=phase)
        push()
    state[op.id] = OpRunState(
        status="done", percent=100.0, phase=phases[-1], result={"simulated": True}
    )
    push()
    return True


@celery_app.task(name="run_plan")
def run_plan_task(job_id: str, plan: dict) -> None:
    """Walk a validated deploy-plan DAG, running each op in dependency order.

    Sequential ready-set loop (Kahn-style): repeatedly pick the first remaining
    op whose dependencies have all finished. A dependency that ended in error or
    was itself cancelled poisons its dependents — they're marked ``cancelled``
    and skipped rather than executed, so one failed clone doesn't take down
    independent branches of the plan. The whole body is wrapped in one
    try/except mirroring ``clone_vm_task``: only plan-level infrastructure
    failures (bad payload) become a terminal ``ErrorMsg``; per-op failures —
    including a failed ``open_connection`` attempt, caught around just that
    call — are folded into the op's state and the plan always finishes with a
    ``DoneMsg``. The ESXi connection (opened lazily, at most once) is closed
    in a ``finally`` regardless of outcome.
    """
    from app.routers.deploy import DeployRequest, PlanOpKind

    try:
        ops = DeployRequest(**plan).ops
        state: dict[str, OpRunState] = {op.id: OpRunState(status="pending") for op in ops}

        def push() -> None:
            transport.publish(job_id, PlanStateMsg(ops=dict(state)), status=JobStatus.running)

        transport.publish(job_id, RunningMsg(), status=JobStatus.running)
        push()

        remaining = list(ops)
        finished: set[str] = set()
        blocked: set[str] = set()
        conn: "Connection | None" = None

        try:
            while remaining:
                for idx, op in enumerate(remaining):
                    if all(dep in finished for dep in op.depends_on):
                        del remaining[idx]
                        break
                else:
                    # Unreachable given a validated (acyclic, all-deps-present) plan —
                    # guard against an infinite loop rather than hang the worker.
                    for op in remaining:
                        state[op.id] = OpRunState(
                            status="cancelled", detail="Unresolvable dependency ordering."
                        )
                        finished.add(op.id)
                        blocked.add(op.id)
                        push()
                    break

                if any(dep in blocked for dep in op.depends_on):
                    state[op.id] = OpRunState(
                        status="cancelled", detail="Skipped: a dependency failed or was cancelled."
                    )
                    finished.add(op.id)
                    blocked.add(op.id)
                    push()
                    continue

                if op.kind is PlanOpKind.create_vm and op.params.get("simulate") != "true":
                    if conn is None:
                        try:
                            conn = open_connection(
                                settings.esxi_host,  # type: ignore[arg-type]
                                settings.esxi_user,  # type: ignore[arg-type]
                                settings.esxi_password,  # type: ignore[arg-type]
                                settings.esxi_port,
                            )
                        except Exception as exc:  # noqa: BLE001 — a connection failure blocks this op only, not the whole plan
                            state[op.id] = OpRunState(status="error", detail=str(exc))
                            push()
                            finished.add(op.id)
                            blocked.add(op.id)
                            continue
                    ok = _run_clone_op(conn, op, state, push)
                else:
                    ok = _simulate_op(op, state, push)

                finished.add(op.id)
                if not ok:
                    blocked.add(op.id)
        finally:
            if conn is not None:
                Disconnect(conn.si)

        transport.publish(
            job_id,
            DoneMsg(result={"ops": {op_id: s.model_dump() for op_id, s in state.items()}}),
            status=JobStatus.done,
            terminal=True,
        )
    except VmkitError as exc:
        status, detail = map_vmkit_error(exc)
        transport.publish(
            job_id, ErrorMsg(status=status, detail=detail), status=JobStatus.error, terminal=True
        )
    except Exception as exc:  # noqa: BLE001 — surface anything as a terminal error
        transport.publish(
            job_id, ErrorMsg(status=500, detail=str(exc)), status=JobStatus.error, terminal=True
        )
