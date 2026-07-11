"""Sequence engine — walks a list of :class:`Step`\\ s, dispatching each to
the agent and handling reboots and verify-with-backoff (Phase L).

Every side effect is injected, so the walk logic is unit-testable without
redis, Mongo, or a real agent:

* ``dispatch(job_key, vm_id, command, params, *, role, secret_keys, timeout_s)
  -> dict`` sends one command and blocks for its terminal result (raising
  :class:`SequenceError` on agent error / timeout) — in production this is the
  worker↔agent bridge (:func:`app.core.agentbus.dispatch_and_wait`). ``job_key``
  is the step's stable id, used to derive the deterministic per-step job id
  (idempotency key on redelivery).
* ``wait_for_reconnect(vm_id, since_ms, timeout_s)`` blocks until the agent's
  ``lastConnectedAt`` advances past ``since_ms`` (Mongo poll), or raises.
* ``sleep(seconds)`` / ``now_ms()`` are injected for deterministic tests.

Resume: a ``completed`` set (from the ``plan_runs`` cursor) skips already-run
steps on Celery redelivery; ``on_step_done(step_id, result)`` persists the
cursor + any produced artifacts after each step so a mid-sequence redelivery
picks up where it left off. Reboot waits use a *timestamp compare* (reconnect
time > dispatch time), immune to a fast reboot that reconnects before the
engine even starts polling.
"""

import logging
from collections.abc import Callable, Iterable
from typing import Any

from app.core.sequences.model import RunContext, Step

logger = logging.getLogger(__name__)


class SequenceError(Exception):
    """A step failed terminally (agent error, dispatch timeout, or a verify
    probe that never reached its target state within the window)."""


#: Verify-probe backoff (seconds) — geometric-ish, capped; the tail repeats the
#: cap until ``verify_window_s`` elapses. ADWS / template propagation is slow,
#: so the window (not this schedule) is the real bound.
_VERIFY_BACKOFF = (5, 10, 15, 30, 45, 60)


class SequenceEngine:
    def __init__(
        self,
        *,
        dispatch: Callable[..., dict],
        wait_for_reconnect: Callable[[str, int, int], None],
        sleep: Callable[[float], None],
        now_ms: Callable[[], int],
        role: str = "guest",
        completed: set[str] | None = None,
        on_step_done: Callable[[str, dict], None] | None = None,
    ) -> None:
        self._dispatch = dispatch
        self._wait_for_reconnect = wait_for_reconnect
        self._sleep = sleep
        self._now_ms = now_ms
        # The plan owner's role, forwarded on every dispatched command (the
        # agent re-checks it as its structural second gate). Both roles hold
        # VM_PROVISION, so a guest's own lab provisions under 'guest'.
        self._role = role
        self._completed = completed if completed is not None else set()
        self._on_step_done = on_step_done or (lambda _s, _r: None)

    def run(self, steps: Iterable[Step], ctx: RunContext) -> dict[str, dict]:
        """Run every step in order; return {step_id: result}. Raises
        :class:`SequenceError` on the first terminal failure (the plan runner
        turns that into a failed op)."""
        results: dict[str, dict] = {}
        for step in steps:
            results[step.id] = self._run_one(step, ctx)
        return results

    def _run_one(self, step: Step, ctx: RunContext) -> dict:
        node = ctx.node(step.target)
        if node.agent_vm_id is None:
            raise SequenceError(
                f"step '{step.id}' targets node '{step.target}' which has no agent"
            )

        if step.id in self._completed:
            logger.info("sequence step %s already complete — skipping", step.id)
            # Its artifacts were restored into ctx by the caller from plan_runs.
            return {}

        params = step.resolve_params(ctx)
        # Capture *before* dispatch so a fast reboot that reconnects immediately
        # still registers as "after" the dispatch (timestamp compare).
        dispatched_at = self._now_ms()
        result = self._dispatch(
            step.id,
            node.agent_vm_id,
            step.command,
            params,
            role=self._role,
            secret_keys=step.secret_keys,
            timeout_s=step.timeout_s,
        )

        for key in step.produces:
            content = result.get("contentB64")
            if isinstance(content, str):
                ctx.artifacts[key] = content

        if step.expects_disconnect:
            self._wait_for_reconnect(
                node.agent_vm_id, dispatched_at, step.timeout_s
            )

        if step.verify is not None:
            self._run_verify(step, node.agent_vm_id, ctx)

        self._completed.add(step.id)
        self._on_step_done(step.id, result)
        return result

    def _run_verify(self, step: Step, vm_id: str, ctx: RunContext) -> None:
        probe = step.verify
        assert probe is not None
        predicate = step.verify_predicate or (lambda _r: True)
        deadline = self._now_ms() + step.verify_window_s * 1000
        attempt = 0
        last_detail = "no probe ran"
        while True:
            try:
                params = probe.resolve_params(ctx)
                # Verify probes are read-only, so a fresh job key per attempt is
                # fine (no idempotency concern) and avoids a stale terminal
                # snapshot short-circuiting a retry.
                result = self._dispatch(
                    f"{step.id}.verify.{attempt}",
                    vm_id,
                    probe.command,
                    params,
                    role=self._role,
                    secret_keys=probe.secret_keys,
                    timeout_s=probe.timeout_s,
                )
                if predicate(result):
                    return
                last_detail = f"{probe.command} not ready yet"
            except SequenceError as exc:
                # A probe raising (e.g. ADWS still down) is the normal
                # not-ready-yet signal — keep retrying until the window closes.
                last_detail = str(exc)

            if self._now_ms() >= deadline:
                raise SequenceError(
                    f"verify '{probe.command}' for step '{step.id}' did not "
                    f"succeed within {step.verify_window_s}s: {last_detail}"
                )
            backoff = _VERIFY_BACKOFF[min(attempt, len(_VERIFY_BACKOFF) - 1)]
            attempt += 1
            self._sleep(backoff)


def deterministic_step_job_id(plan_job_id: str, op_id: str, step_id: str) -> str:
    """The per-step job id — both the dispatch idempotency key and a future
    Inspector drill-down handle. Deterministic so a redelivered task reuses the
    same id and the bridge finds the already-terminal snapshot."""
    return f"{plan_job_id}-{op_id}-{step_id}"


def redact_params(
    params: dict[str, Any], secret_keys: Iterable[str]
) -> dict[str, Any]:
    """A copy of *params* with every secret key masked — for logging."""
    secret = set(secret_keys)
    return {k: ("***" if k in secret else v) for k, v in params.items()}
