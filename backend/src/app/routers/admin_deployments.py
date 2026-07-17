"""Cross-user deployment oversight — admin-only (``Capability.DEPLOY_ADMIN``),
backing the ``/admin`` console's Deployments section.

Admins don't build on the canvas (no ``DEPLOY`` capability), but they own the
platform, so they get a read-only view of every active deployment and a
kill-switch: stop one user's deployments, or every user's at once.

Stopping is the same cooperative cancel operators already trigger per-job
(``deploy.cancel_deployment``) — a Valkey flag the worker honours at step/op
boundaries — but carries an admin *reason* so the affected user is told *why*
their deployment stopped (inline on each cancelled op, plus a terminal error
that toasts on the canvas and releases the deploy lock). It halts remaining
work only: VMs already cloned keep running and remain cleanable via teardown.
"""

from fastapi import APIRouter, Depends
from pydantic import BaseModel
from typing import Literal

from app.core.authz import Capability, require_capability
from app.core.db import plan_runs_col
from app.core.jobs import transport

router = APIRouter(
    prefix="/admin/deployments",
    tags=["admin"],
    dependencies=[Depends(require_capability(Capability.DEPLOY_ADMIN))],
)

#: Op statuses after which no more work happens for that op (mirrors
#: ``tasks._PLAN_TERMINAL``; kept local so this route needn't import the
#: Celery-heavy tasks module).
_TERMINAL = frozenset({"done", "error", "cancelled"})

#: Reason surfaced to the affected user when an admin stops their deployment.
_STOP_REASON = "Stopped by an administrator."


def _op_states(doc: dict) -> dict[str, dict]:
    return (doc.get("scheduler") or {}).get("ops") or {}


def _is_active(doc: dict) -> bool:
    """A run is active while at least one of its ops is not yet terminal."""
    ops = _op_states(doc)
    return bool(ops) and any(
        (op or {}).get("status") not in _TERMINAL for op in ops.values()
    )


def _summarize(doc: dict) -> dict:
    ops = _op_states(doc)
    statuses = [(op or {}).get("status") for op in ops.values()]
    return {
        "jobId": doc.get("jobId"),
        "owner": doc.get("owner"),
        "ownerRole": doc.get("ownerRole"),
        "startedAt": doc.get("createdAt"),
        "updatedAt": doc.get("updatedAt"),
        "opTotal": len(statuses),
        "opActive": sum(1 for s in statuses if s not in _TERMINAL),
        "opDone": sum(1 for s in statuses if s == "done"),
        "opFailed": sum(1 for s in statuses if s == "error"),
    }


async def _active_docs() -> list[dict]:
    # Scope to real deployments — reconcile/teardown runs (``runKind`` set) are
    # operator-triggered maintenance, not a user "deployment", and have their
    # own terminal messaging outside this stop path.
    cursor = (
        plan_runs_col()
        .find({"scheduler.ops": {"$exists": True}, "runKind": {"$exists": False}})
        .sort("createdAt", -1)
    )
    docs = await cursor.to_list(length=500)
    return [d for d in docs if _is_active(d)]


class StopRequest(BaseModel):
    #: Stop only this user's active deployments; ``None`` stops every user's.
    owner: str | None = None
    #: "step" interrupts between steps too (most immediate); "operation" lets
    #: the running op finish first.
    mode: Literal["step", "operation"] = "step"


@router.get("")
async def list_deployments() -> dict:
    """Every currently-active deployment across all users, newest first."""
    docs = await _active_docs()
    return {"deployments": [_summarize(d) for d in docs], "count": len(docs)}


@router.post("/stop", status_code=202)
async def stop_deployments(body: StopRequest) -> dict:
    """Cooperatively stop one user's active deployments, or all of them.

    Idempotent: re-stopping an already-draining job just re-sets the flag.
    """
    docs = await _active_docs()
    if body.owner is not None:
        docs = [d for d in docs if d.get("owner") == body.owner]

    stopped: list[str] = []
    for doc in docs:
        job_id = doc.get("jobId")
        if not job_id:
            continue
        transport.request_cancel(job_id, body.mode, reason=_STOP_REASON)
        stopped.append(job_id)

    return {"stopped": stopped, "count": len(stopped)}
