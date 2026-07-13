"""Sequence-engine walk logic — reboot waits, verify backoff,
artifact relay, and resume-skip, all with injected effects (no redis/Mongo)."""

import pytest

from app.core.sequences.engine import (
    SequenceEngine,
    SequenceError,
    deterministic_step_job_id,
    redact_params,
)
from app.core.sequences.model import NodeContext, RunContext, Step, StepRuntime


def _ctx(**node_overrides):
    node = NodeContext(
        node_id="dc",
        vm_name="guest-abc12-dc01",
        hostname="guest-abc12-dc01",
        agent_vm_id="vm-1",
        template_id="domainController",
        template_config={"domainName": "EC.com"},
        **node_overrides,
    )
    return RunContext(nodes={"primary": node})


class FakeClock:
    def __init__(self):
        self.t = 0

    def now_ms(self):
        return self.t

    def sleep(self, seconds):
        self.t += int(seconds * 1000)


def test_runs_steps_in_order_and_returns_results():
    clock = FakeClock()
    calls = []

    def dispatch(job_key, vm_id, command, params, *, role, secret_keys, timeout_s, expect_disconnect=False):
        calls.append(command)
        return {"ok": command}

    engine = SequenceEngine(
        dispatch=dispatch,
        wait_for_reconnect=lambda *a, **k: None,
        sleep=clock.sleep,
        now_ms=clock.now_ms,
    )
    steps = [
        Step(id="a", command="ca.install", target="primary"),
        Step(id="b", command="ca.publish_crl", target="primary"),
    ]
    results = engine.run(steps, _ctx())
    assert calls == ["ca.install", "ca.publish_crl"]
    assert results["a"] == {"ok": "ca.install"}


def test_reboot_step_waits_for_reconnect_after_dispatch():
    clock = FakeClock()
    reconnect_args = {}

    def dispatch(job_key, vm_id, command, params, *, role, secret_keys, timeout_s, expect_disconnect=False):
        clock.t += 1000  # dispatch takes time
        return {}

    def wait_for_reconnect(vm_id, since_ms, timeout_s):
        reconnect_args["vm_id"] = vm_id
        reconnect_args["since_ms"] = since_ms

    engine = SequenceEngine(
        dispatch=dispatch,
        wait_for_reconnect=wait_for_reconnect,
        sleep=clock.sleep,
        now_ms=clock.now_ms,
    )
    engine.run(
        [Step(id="reboot", command="system.reboot", target="primary", expects_disconnect=True)],
        _ctx(),
    )
    # since_ms is captured BEFORE dispatch, so a fast reconnect still counts.
    assert reconnect_args["vm_id"] == "vm-1"
    assert reconnect_args["since_ms"] == 0


def test_verify_retries_until_predicate_passes():
    clock = FakeClock()
    probe_results = iter([{"ready": False}, {"ready": False}, {"ready": True}])

    def dispatch(job_key, vm_id, command, params, *, role, secret_keys, timeout_s, expect_disconnect=False):
        if command == "dc.verify":
            return next(probe_results)
        return {}

    engine = SequenceEngine(
        dispatch=dispatch,
        wait_for_reconnect=lambda *a, **k: None,
        sleep=clock.sleep,
        now_ms=clock.now_ms,
    )
    step = Step(
        id="install",
        command="dc.install_forest",
        target="primary",
        verify=Step(id="v", command="dc.verify", target="primary"),
        verify_predicate=lambda r: r.get("ready") is True,
        verify_window_s=600,
    )
    engine.run([step], _ctx())  # no raise = the third probe passed


def test_verify_raises_when_window_elapses():
    clock = FakeClock()

    def dispatch(job_key, vm_id, command, params, *, role, secret_keys, timeout_s, expect_disconnect=False):
        return {"ready": False}

    engine = SequenceEngine(
        dispatch=dispatch,
        wait_for_reconnect=lambda *a, **k: None,
        sleep=clock.sleep,
        now_ms=clock.now_ms,
    )
    step = Step(
        id="install",
        command="dc.install_forest",
        target="primary",
        verify=Step(id="v", command="dc.verify", target="primary"),
        verify_predicate=lambda r: r.get("ready") is True,
        verify_window_s=30,
    )
    with pytest.raises(SequenceError):
        engine.run([step], _ctx())


def test_verify_treats_probe_error_as_not_ready():
    clock = FakeClock()
    attempts = {"n": 0}

    def dispatch(job_key, vm_id, command, params, *, role, secret_keys, timeout_s, expect_disconnect=False):
        if command == "dc.verify":
            attempts["n"] += 1
            if attempts["n"] < 2:
                raise SequenceError("ADWS still down")
            return {"ready": True}
        return {}

    engine = SequenceEngine(
        dispatch=dispatch,
        wait_for_reconnect=lambda *a, **k: None,
        sleep=clock.sleep,
        now_ms=clock.now_ms,
    )
    step = Step(
        id="install",
        command="dc.install_forest",
        target="primary",
        verify=Step(id="v", command="dc.verify", target="primary"),
        verify_predicate=lambda r: r.get("ready") is True,
    )
    engine.run([step], _ctx())
    assert attempts["n"] == 2


def test_failed_step_raises_and_stops_the_sequence():
    clock = FakeClock()
    ran = []

    def dispatch(job_key, vm_id, command, params, *, role, secret_keys, timeout_s, expect_disconnect=False):
        ran.append(command)
        if command == "domain.join":
            raise SequenceError("bad credentials")
        return {}

    engine = SequenceEngine(
        dispatch=dispatch,
        wait_for_reconnect=lambda *a, **k: None,
        sleep=clock.sleep,
        now_ms=clock.now_ms,
    )
    steps = [
        Step(id="dns", command="dns.set_client", target="primary"),
        Step(id="join", command="domain.join", target="primary"),
        Step(id="after", command="domain.verify", target="primary"),
    ]
    with pytest.raises(SequenceError):
        engine.run(steps, _ctx())
    assert ran == ["dns.set_client", "domain.join"]  # 'after' never ran


def test_completed_steps_skip_on_resume():
    clock = FakeClock()
    ran = []

    def dispatch(job_key, vm_id, command, params, *, role, secret_keys, timeout_s, expect_disconnect=False):
        ran.append(command)
        return {}

    engine = SequenceEngine(
        dispatch=dispatch,
        wait_for_reconnect=lambda *a, **k: None,
        sleep=clock.sleep,
        now_ms=clock.now_ms,
        completed={"a"},
    )
    steps = [
        Step(id="a", command="ca.install", target="primary"),
        Step(id="b", command="ca.publish_crl", target="primary"),
    ]
    engine.run(steps, _ctx())
    assert ran == ["ca.publish_crl"]  # 'a' was already done


def test_produces_and_consumes_relay_artifacts():
    clock = FakeClock()
    seen_params = {}

    def dispatch(job_key, vm_id, command, params, *, role, secret_keys, timeout_s, expect_disconnect=False):
        if command == "file.read":
            return {"contentB64": "Q1NSLWJ5dGVz"}
        if command == "ca.sign_request":
            seen_params.update(params)
            return {}
        return {}

    engine = SequenceEngine(
        dispatch=dispatch,
        wait_for_reconnect=lambda *a, **k: None,
        sleep=clock.sleep,
        now_ms=clock.now_ms,
    )
    steps = [
        Step(id="read", command="file.read", target="primary", produces=("csr",)),
        Step(id="sign", command="ca.sign_request", target="primary", consumes=("csr",)),
    ]
    ctx = _ctx()
    engine.run(steps, ctx)
    assert ctx.artifacts["csr"] == "Q1NSLWJ5dGVz"
    assert seen_params["contentB64"] == "Q1NSLWJ5dGVz"


def test_param_resolver_sees_context():
    clock = FakeClock()
    seen = {}

    def resolver(rt: StepRuntime):
        return {"domainName": rt.node.template_config["domainName"], "host": rt.node.hostname}

    def dispatch(job_key, vm_id, command, params, *, role, secret_keys, timeout_s, expect_disconnect=False):
        seen.update(params)
        return {}

    engine = SequenceEngine(
        dispatch=dispatch,
        wait_for_reconnect=lambda *a, **k: None,
        sleep=clock.sleep,
        now_ms=clock.now_ms,
    )
    engine.run([Step(id="s", command="dc.install_forest", target="primary", params=resolver)], _ctx())
    assert seen == {"domainName": "EC.com", "host": "guest-abc12-dc01"}


def test_deterministic_step_job_id_is_stable():
    assert deterministic_step_job_id("job1", "op2", "step3") == "job1-op2-step3"


def test_redact_params_masks_secrets():
    out = redact_params({"username": "admin", "password": "hunter2"}, ["password"])
    assert out == {"username": "admin", "password": "***"}
