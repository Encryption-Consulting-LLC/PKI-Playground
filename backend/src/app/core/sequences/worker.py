"""Worker-side glue that runs a :class:`SequenceEngine` with concrete effects
(Phase L slice 9): the agentbus dispatch bridge, Mongo-backed reboot waits, and
``plan_runs`` cursor/artifact persistence for redelivery-safe resume.

Kept separate from :mod:`app.core.sequences.engine` (pure) and
:mod:`app.tasks` (Celery/vmkit) so the wiring has one home. Everything here
runs in the Celery worker over a short-lived sync Mongo client.
"""

import datetime
import logging
import time

from app.core import agentbus
from app.core.db.models import now_ms
from app.core.sequences.engine import (
    SequenceEngine,
    deterministic_step_job_id,
)
from app.core.sequences.model import RunContext, Step

logger = logging.getLogger(__name__)

#: plan_runs TTL horizon — 7 days after the last write (matches the plan).
_PLAN_RUN_TTL_DAYS = 7


def _load_run_state(db, plan_job_id: str) -> tuple[dict[str, list[str]], dict[str, str]]:
    """Return ``(cursor, artifacts)`` for a plan run — the per-op completed-step
    lists and the artifact relay map — or empty structures for a first run."""
    doc = db["plan_runs"].find_one({"jobId": plan_job_id})
    if doc is None:
        return {}, {}
    return doc.get("cursor") or {}, doc.get("artifacts") or {}


def _persist_step(
    db, plan_job_id: str, op_id: str, step_id: str, artifacts: dict[str, str]
) -> None:
    """Record ``step_id`` complete under ``op_id`` and snapshot the artifact map
    — the resume cursor. Re-armed TTL on every write."""
    ttl_at = datetime.datetime.now(datetime.UTC) + datetime.timedelta(
        days=_PLAN_RUN_TTL_DAYS
    )
    db["plan_runs"].update_one(
        {"jobId": plan_job_id},
        {
            "$addToSet": {f"cursor.{op_id}": step_id},
            "$set": {
                "artifacts": artifacts,
                "updatedAt": now_ms(),
                "ttlAt": ttl_at,
            },
            "$setOnInsert": {"jobId": plan_job_id, "createdAt": now_ms()},
        },
        upsert=True,
    )


def run_op_sequence(
    db,
    steps: list[Step],
    ctx: RunContext,
    *,
    plan_job_id: str,
    op_id: str,
    role: str,
) -> dict[str, dict]:
    """Run one op's step sequence to completion (or raise
    :class:`~app.core.sequences.engine.SequenceError`).

    Wires the engine's injected effects to production:

    * ``dispatch`` → :func:`agentbus.dispatch_and_wait` under a deterministic
      per-step job id, so a redelivered task reuses the already-terminal result
      instead of re-running a side-effecting command;
    * ``wait_for_reconnect`` → the Mongo ``lastConnectedAt`` poll;
    * completed steps come from the ``plan_runs`` cursor and each step's
      completion is persisted before the next runs.
    """
    completed_by_op, artifacts = _load_run_state(db, plan_job_id)
    completed = set(completed_by_op.get(op_id, []))
    ctx.artifacts.update(artifacts)

    def dispatch(job_key, vm_id, command, params, *, role, secret_keys, timeout_s):
        step_job_id = deterministic_step_job_id(plan_job_id, op_id, job_key)
        return agentbus.dispatch_and_wait(
            vm_id,
            command,
            params,
            job_id=step_job_id,
            role=role,
            timeout_s=timeout_s,
            secret_keys=secret_keys,
        )

    def wait_for_reconnect(vm_id, since_ms, timeout_s):
        agentbus.wait_for_reconnect(vm_id, since_ms, timeout_s, db=db)

    def on_step_done(step_id, _result):
        _persist_step(db, plan_job_id, op_id, step_id, ctx.artifacts)

    engine = SequenceEngine(
        dispatch=dispatch,
        wait_for_reconnect=wait_for_reconnect,
        sleep=time.sleep,
        now_ms=now_ms,
        role=role,
        completed=completed,
        on_step_done=on_step_done,
    )
    return engine.run(steps, ctx)
