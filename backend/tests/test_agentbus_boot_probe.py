"""Active boot-settle probe (`wait_for_settled_boot`).

The gate must decide "final boot reached" from `system.boot_info` facts —
legacy finalize task state + uptime, confirmed across both current and legacy
pre-reboot windows — never from connection-stability heuristics that reconnect
churn can reset forever. Driven with an injected clock and a scripted
dispatcher; no real Valkey/Mongo/agent.
"""

import os

import pytest

os.environ.setdefault("SESSION_SECRET", "test-session-secret")
os.environ.setdefault(
    "SETTINGS_ENC_KEY", "MDEyMzQ1Njc4OWFiY2RlZjAxMjM0NTY3ODlhYmNkZWY="
)

from app.core import agentbus
from app.core.agentbus import (
    AgentUnreachableError,
    DispatchError,
    wait_for_settled_boot,
)
from app.core.settings import settings


class FakeClock:
    def __init__(self):
        self.t = 0.0

    def monotonic(self):
        return self.t

    def sleep(self, seconds):
        self.t += seconds


class ScriptedDispatch:
    """Pops one scripted outcome per boot_info probe (a result dict or an
    exception to raise); records every call, including system.reboot kicks."""

    def __init__(self, outcomes, clock=None, probe_cost_s=0.0):
        self.outcomes = list(outcomes)
        self.calls = []
        self.clock = clock
        self.probe_cost_s = probe_cost_s

    def __call__(self, vm_id, command, params, **kwargs):
        self.calls.append((command, params, kwargs))
        if self.clock is not None and self.probe_cost_s:
            self.clock.sleep(self.probe_cost_s)
        if command == "system.reboot":
            return {"rebooting": True}
        outcome = self.outcomes.pop(0)
        if isinstance(outcome, Exception):
            raise outcome
        return outcome


class FakeLiveness:
    """Just the liveness-key ``.get`` the offline reconnect poll reads.
    ``answers`` scripts the first polls (True = key present); once drained the
    key is always present, so a poll never spins to the deadline by accident."""

    def __init__(self, answers=()):
        self.answers = list(answers)
        self.gets = 0

    def get(self, _key):
        self.gets += 1
        live = self.answers.pop(0) if self.answers else True
        return b"1" if live else None


def _wait(dispatch, clock, *, timeout_s=10_000, on_phase=None, client=None):
    return wait_for_settled_boot(
        "vm-1",
        db=object(),
        timeout_s=timeout_s,
        role="guest",
        job_key_prefix="job-op-bootprobe",
        on_phase=on_phase,
        client=client if client is not None else FakeLiveness(),
        sleep=clock.sleep,
        monotonic=clock.monotonic,
        dispatch=dispatch,
    )


def _info(uptime, pending=False, running=False):
    return {"uptimeS": uptime, "finalizePending": pending, "finalizeRunning": running}


def test_settles_after_two_consistent_probes():
    clock = FakeClock()
    dispatch = ScriptedDispatch([_info(120), _info(165)])
    _wait(dispatch, clock)
    # One confirm gap, no extra dwell — far faster than the legacy 180s.
    assert clock.t == pytest.approx(45.0)
    assert len(dispatch.calls) == 2
    # Probe job ids are nonce'd and per-attempt (no stale-snapshot reuse).
    ids = [kw["job_id"] for _, _, kw in dispatch.calls]
    assert len(set(ids)) == 2
    assert all(id_.startswith("job-op-bootprobe:bootinfo:") for id_ in ids)


def test_pre_reboot_race_is_defeated_by_the_confirm_probe():
    clock = FakeClock()
    dispatch = ScriptedDispatch(
        [
            _info(70),  # boot 2, caught in the unregister→reboot window
            AgentUnreachableError("mid-reboot"),  # the finalize reboot landed
            _info(12),  # boot 3, below the uptime floor
            _info(75),  # boot 3, candidate
            _info(120),  # boot 3, confirmed
        ]
    )
    _wait(dispatch, clock)
    assert len(dispatch.calls) == 5
    assert all(cmd == "system.boot_info" for cmd, _, _ in dispatch.calls)


def test_uptime_going_backwards_resets_the_candidate():
    clock = FakeClock()
    # Confirm probe sees a smaller uptime (above the floor, so only the
    # same-boot check can catch it): the reboot happened between probes.
    dispatch = ScriptedDispatch([_info(300), _info(80), _info(140), _info(185)])
    _wait(dispatch, clock)
    assert len(dispatch.calls) == 4


def test_finalize_pending_reports_phase_and_keeps_probing():
    clock = FakeClock()
    phases = []
    dispatch = ScriptedDispatch(
        [_info(40, pending=True, running=True), _info(90), _info(135)]
    )
    _wait(dispatch, clock, on_phase=phases.append)
    assert any("finalize pending (up 40s)" in p for p in phases)
    assert any("confirming" in p for p in phases)


def test_missed_trigger_forces_a_reboot(monkeypatch):
    clock = FakeClock()
    reconnect_waits = []
    phases = []
    monkeypatch.setattr(settings, "agent_boot_force_reboot_uptime_s", 600)
    monkeypatch.setattr(
        agentbus,
        "wait_for_reconnect",
        lambda vm_id, since, timeout_s, *, db, sleep: reconnect_waits.append(since),
    )
    dispatch = ScriptedDispatch(
        [
            _info(700, pending=True, running=False),  # missed -AtStartup
            _info(90),  # post-kick boot, candidate
            _info(135),  # confirmed
        ]
    )
    _wait(dispatch, clock, on_phase=phases.append)
    kicks = [c for c in dispatch.calls if c[0] == "system.reboot"]
    assert len(kicks) == 1
    _, params, kwargs = kicks[0]
    assert params == {"delaySeconds": "5"}
    assert kwargs["expect_disconnect"] is True
    assert kwargs["job_id"].startswith("job-op-bootprobe:bootkick:")
    assert len(reconnect_waits) == 1
    assert "Finalize still pending after 600s — forcing a recovery reboot" in phases


def test_a_running_finalize_task_is_not_kicked():
    clock = FakeClock()
    dispatch = ScriptedDispatch(
        [_info(700, pending=True, running=True), _info(90), _info(135)]
    )
    _wait(dispatch, clock)
    assert all(cmd != "system.reboot" for cmd, _, _ in dispatch.calls)


def test_forced_reboot_cap_fails_the_op(monkeypatch):
    clock = FakeClock()
    monkeypatch.setattr(agentbus, "wait_for_reconnect", lambda *a, **k: None)
    dispatch = ScriptedDispatch(
        [_info(700 + i * 100, pending=True, running=False) for i in range(4)]
    )
    with pytest.raises(DispatchError, match="still pending after 2 forced reboots"):
        _wait(dispatch, clock)
    kicks = [c for c in dispatch.calls if c[0] == "system.reboot"]
    assert len(kicks) == 2


def test_unknown_command_falls_back_to_the_legacy_dwell(monkeypatch):
    clock = FakeClock()
    fallback_calls = []
    monkeypatch.setattr(
        agentbus,
        "wait_for_stable_agent",
        lambda vm_id, **kw: fallback_calls.append((vm_id, kw)),
    )
    dispatch = ScriptedDispatch(
        [
            DispatchError(
                "agent command 'system.boot_info' failed: "
                "unknown command 'system.boot_info'"
            )
        ]
    )
    _wait(dispatch, clock, timeout_s=2700)
    assert len(fallback_calls) == 1
    vm_id, kw = fallback_calls[0]
    assert vm_id == "vm-1"
    assert kw["settle_s"] == settings.agent_boot_settle_s
    assert kw["timeout_s"] == 2700  # the full remaining budget


def test_other_dispatch_errors_keep_probing():
    clock = FakeClock()
    dispatch = ScriptedDispatch(
        [
            DispatchError("agent command 'system.boot_info' timed out after 60s"),
            _info(90),
            _info(135),
        ]
    )
    _wait(dispatch, clock)
    assert len(dispatch.calls) == 3


def test_probe_timeout_preserves_the_candidate():
    """A hung probe (guest-side PowerShell wedge, 60s dispatch timeout) says
    nothing about a reboot — the settle candidate must survive it, and the
    phase text must move so the UI never freezes on 'confirming'."""
    clock = FakeClock()
    phases = []
    dispatch = ScriptedDispatch(
        [
            _info(120),  # candidate
            DispatchError("agent command 'system.boot_info' timed out after 60s"),
            _info(205),  # same boot, uptime advanced through the hang — confirmed
        ]
    )
    _wait(dispatch, clock, on_phase=phases.append)
    # 3 probes, not 4: the timed-out probe did not reset the candidate, so the
    # next successful probe confirmed directly.
    assert len(dispatch.calls) == 3
    assert any("probe timed out" in p for p in phases)


def test_offline_agent_reprobes_promptly_on_reconnect():
    """While the agent is offline the gate polls the liveness key (~2s) and
    re-probes the moment it reappears — not up to a full probe interval later."""
    clock = FakeClock()
    phases = []
    client = FakeLiveness(answers=[False, False, False, True])
    dispatch = ScriptedDispatch(
        [AgentUnreachableError("mid-reboot"), _info(90), _info(135)]
    )
    _wait(dispatch, clock, on_phase=phases.append, client=client)
    assert any("agent offline" in p for p in phases)
    assert any("Agent back online" in p for p in phases)
    # Three 2s reconnect polls, then the re-probe and one 45s confirm gap —
    # no 20s probe-interval sleep anywhere in the offline path.
    assert clock.t == pytest.approx(6.0 + 45.0)
    assert len(dispatch.calls) == 3


def test_unparseable_result_keeps_probing():
    clock = FakeClock()
    dispatch = ScriptedDispatch(
        [
            {"uptimeS": "soon", "finalizePending": False},
            {"raw": "not json"},
            _info(90),
            _info(135),
        ]
    )
    _wait(dispatch, clock)
    assert len(dispatch.calls) == 4


def test_overall_timeout_raises_agent_unreachable():
    clock = FakeClock()
    dispatch = ScriptedDispatch([_info(30 + i, pending=True) for i in range(100)])
    with pytest.raises(AgentUnreachableError, match="did not settle within 100s"):
        _wait(dispatch, clock, timeout_s=100)


class _WirePubSub:
    def __init__(self, frames):
        self._frames = list(frames)

    def subscribe(self, _channel):
        pass

    def get_message(self, timeout=1.0):
        if not self._frames:
            return None
        import json

        return {"type": "message", "data": json.dumps(self._frames.pop(0))}

    def close(self):
        pass


class _WireRedis:
    """Snapshot absent, liveness present — delivers scripted job frames."""

    def __init__(self, frames):
        self._frames = frames

    def get(self, key):
        return b"1" if key.startswith("agent-conn:") else None

    def publish(self, channel, payload):
        pass

    def pubsub(self, **_kwargs):
        return _WirePubSub(self._frames)


def test_wire_level_unknown_command_surfaces_the_matched_string():
    """The real dispatch_and_wait must raise EXACTLY the substring the
    fallback matches — pins the agent↔backend compatibility contract."""
    with pytest.raises(DispatchError) as exc_info:
        agentbus.dispatch_and_wait(
            "vm-1",
            "system.boot_info",
            {},
            job_id="job-x",
            role="guest",
            timeout_s=30,
            client=_WireRedis(
                [{"type": "error", "detail": "unknown command 'system.boot_info'"}]
            ),
        )
    assert "unknown command 'system.boot_info'" in str(exc_info.value)
