"""Step duration metrics + elapsed-progress feedback (issue 4 of the boot-gate
fix): the sequence worker must time every dispatched step into ``step_metrics``
and thread the dispatch poll's tick heartbeat outward, and the plan runner's
progress callbacks must turn that heartbeat into elapsed text (plus a
duration-estimated percent once a command has history)."""

import os

import pytest

os.environ.setdefault("SESSION_SECRET", "test-session-secret")
os.environ.setdefault("SETTINGS_ENC_KEY", "MDEyMzQ1Njc4OWFiY2RlZjAxMjM0NTY3ODlhYmNkZWY=")

from app.core import agentbus
from app.core.sequences.model import NodeContext, RunContext, Step
from app.core.sequences.worker import load_step_medians, run_op_sequence
from app.tasks import _fmt_duration, _sequence_progress, _step_median_seconds


# --------------------------------------------------------------------------- #
# Fakes                                                                       #
# --------------------------------------------------------------------------- #
class FakeCursor:
    def __init__(self, docs):
        self.docs = list(docs)

    def sort(self, key, direction):
        self.docs.sort(key=lambda d: d.get(key, 0), reverse=direction < 0)
        return self

    def limit(self, n):
        self.docs = self.docs[:n]
        return self

    def __iter__(self):
        return iter(self.docs)


class FakeCollection:
    def __init__(self):
        self.docs = []

    def insert_one(self, doc):
        self.docs.append(dict(doc))

    def find_one(self, *_a, **_k):
        return None

    def find(self, flt=None, _proj=None):
        flt = flt or {}
        return FakeCursor(
            d for d in self.docs if all(d.get(k) == v for k, v in flt.items())
        )

    def update_one(self, *_a, **_k):
        pass


class FakeDb(dict):
    def __getitem__(self, name):
        if name not in self:
            super().__setitem__(name, FakeCollection())
        return super().__getitem__(name)


def _ctx():
    return RunContext(
        nodes={
            "primary": NodeContext(
                node_id="dc",
                vm_name="guest-ab123-dc01",
                hostname="guest-ab123-dc01",
                agent_vm_id="vm-1",
            )
        }
    )


# --------------------------------------------------------------------------- #
# run_op_sequence: metrics insert + tick threading                            #
# --------------------------------------------------------------------------- #
def test_run_op_sequence_records_metrics_and_threads_ticks(monkeypatch):
    db = FakeDb()
    ticks = []

    def fake_dispatch(vm_id, command, params, *, job_id, role, timeout_s,
                      secret_keys=(), expect_disconnect=False,
                      on_progress=None, on_tick=None, client=None):
        # Two frameless poll ticks, then the terminal result.
        if on_tick is not None:
            on_tick(1.0)
            on_tick(2.0)
        return {"ok": True}

    monkeypatch.setattr(agentbus, "dispatch_and_wait", fake_dispatch)

    steps = [Step(id="install-forest", command="dc.install_forest", target="primary")]
    run_op_sequence(
        db, steps, _ctx(),
        plan_job_id="job-1", op_id="op-1", role="guest",
        on_step_tick=lambda step_id, elapsed: ticks.append((step_id, elapsed)),
    )

    assert ticks == [("install-forest", 1.0), ("install-forest", 2.0)]
    metrics = db["step_metrics"].docs
    assert len(metrics) == 1
    m = metrics[0]
    assert m["command"] == "dc.install_forest"
    assert m["stepId"] == "install-forest"
    assert m["vmId"] == "vm-1"
    assert isinstance(m["durationMs"], int) and m["durationMs"] >= 0
    assert isinstance(m["at"], int)


def test_metrics_write_failure_never_fails_the_step(monkeypatch):
    db = FakeDb()
    db["step_metrics"].insert_one = lambda _doc: (_ for _ in ()).throw(
        RuntimeError("mongo down")
    )
    monkeypatch.setattr(
        agentbus, "dispatch_and_wait", lambda *a, **k: {"ok": True}
    )
    steps = [Step(id="s1", command="dc.verify", target="primary")]
    results = run_op_sequence(
        db, steps, _ctx(), plan_job_id="job-1", op_id="op-1", role="guest"
    )
    assert results["s1"] == {"ok": True}


# --------------------------------------------------------------------------- #
# load_step_medians / _step_median_seconds                                    #
# --------------------------------------------------------------------------- #
def test_load_step_medians_takes_the_median_of_recent_runs():
    db = FakeDb()
    for i, ms in enumerate([10_000, 30_000, 20_000]):
        db["step_metrics"].insert_one(
            {"command": "dc.install_forest", "durationMs": ms, "at": i}
        )
    medians = load_step_medians(db, ["dc.install_forest", "never.ran"])
    assert medians == {"dc.install_forest": 20_000.0}


def test_load_step_medians_uses_only_the_newest_sample_window():
    db = FakeDb()
    # 20 old slow runs, then 20 recent fast ones — only the recent window counts.
    for i in range(20):
        db["step_metrics"].insert_one(
            {"command": "cmd", "durationMs": 100_000, "at": i}
        )
    for i in range(20):
        db["step_metrics"].insert_one(
            {"command": "cmd", "durationMs": 5_000, "at": 100 + i}
        )
    assert load_step_medians(db, ["cmd"]) == {"cmd": 5_000.0}


def test_step_median_seconds_maps_step_ids_and_converts_units():
    db = FakeDb()
    db["step_metrics"].insert_one(
        {"command": "dc.install_forest", "durationMs": 480_000, "at": 1}
    )
    steps = [
        Step(id="install-forest", command="dc.install_forest", target="primary"),
        Step(id="reboot", command="system.reboot", target="primary"),
    ]
    assert _step_median_seconds(db, steps) == {"install-forest": 480.0}


# --------------------------------------------------------------------------- #
# _sequence_progress: elapsed heartbeat + estimate math                       #
# --------------------------------------------------------------------------- #
def _progress(medians=None, total=3):
    state = {}
    pushes = []

    def push():
        pushes.append(state["op-1"])

    cbs = _sequence_progress("op-1", total, state, push, medians=medians)
    return cbs, pushes


def test_tick_shows_elapsed_and_is_throttled():
    (_, on_step_progress, on_step_tick), pushes = _progress()
    on_step_progress("install-forest", "installing AD DS forest", 10.0)
    on_step_tick("install-forest", 1.0)  # under the 10s throttle — no push
    on_step_tick("install-forest", 250.0)
    assert len(pushes) == 2
    last = pushes[-1]
    assert "Step 1/3 · install-forest: installing AD DS forest" in last.phase
    assert "4m 10s" in last.phase
    # No median for this command → elapsed text only, no estimate marker, and
    # the percent stays at the agent's last reported value (10% of step 1/3).
    assert "est." not in last.phase
    assert last.percent == pytest.approx(3.3, abs=0.1)


def test_tick_with_a_median_estimates_percent():
    (_, on_step_progress, on_step_tick), pushes = _progress(
        medians={"install-forest": 500.0}
    )
    on_step_progress("install-forest", "installing AD DS forest", 10.0)
    on_step_tick("install-forest", 250.0)  # half the median
    last = pushes[-1]
    assert "~50%" in last.phase and "est. 8m 20s" in last.phase
    # max(agent 10%, est 50%) = 50% of step 1/3 → 16.7% overall.
    assert last.percent == pytest.approx(16.7, abs=0.1)


def test_estimate_is_capped_below_completion():
    (_, _, on_step_tick), pushes = _progress(
        medians={"install-forest": 100.0}, total=1
    )
    on_step_tick("install-forest", 900.0)  # 9x the median
    last = pushes[-1]
    assert "~95%" in last.phase
    assert last.percent == pytest.approx(95.0, abs=0.1)


def test_first_ever_run_of_a_command_gets_elapsed_only():
    (_, _, on_step_tick), pushes = _progress(medians={}, total=1)
    on_step_tick("install-forest", 75.0)
    last = pushes[-1]
    assert "1m 15s" in last.phase
    assert "~" not in last.phase and "est." not in last.phase
    assert last.percent == 0.0


def test_fmt_duration():
    assert _fmt_duration(9) == "9s"
    assert _fmt_duration(60) == "1m"
    assert _fmt_duration(250) == "4m 10s"
    assert _fmt_duration(3725) == "1h 02m"
