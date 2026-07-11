"""Slice-9 wiring: createVm provision sequences + the agentbus frame classifier
(pure pieces, no redis/Mongo)."""

import pytest

from app.core.agentbus import DispatchError, _frame_outcome, _terminal_result
from app.core.sequences.definitions import provision_steps
from app.core.sequences.model import NodeContext, RunContext, StepRuntime


def test_certificate_authority_root_provisions_install_and_verify():
    steps = provision_steps("certificateAuthority", ca_type="Root")
    assert [s.command for s in steps] == ["ca.install"]
    assert steps[0].verify is not None
    assert steps[0].verify.command == "ca.verify"


def test_issuing_ca_has_no_first_boot_sequence():
    # An issuing CA can't stand up until the caConnect handshake.
    assert provision_steps("certificateAuthority", ca_type="Issuing") == []


def test_templates_without_a_tail_provision_nothing():
    for template in ("domainController", "webServer", "client", "standalone"):
        assert provision_steps(template) == []


def test_ca_install_params_come_from_template_config():
    steps = provision_steps("certificateAuthority", ca_type="Root")
    node = NodeContext(
        node_id="ca",
        vm_name="guest-abc12-ca01",
        hostname="guest-abc12-ca01",
        agent_vm_id="vm-9",
        template_id="certificateAuthority",
        template_config={"caType": "Root", "commonName": "EC-Root-CA", "keyAlgorithm": "RSA"},
    )
    ctx = RunContext(nodes={"primary": node})
    params = steps[0].resolve_params(ctx)
    assert params["commonName"] == "EC-Root-CA"
    assert params["caType"] == "Root"


def test_frame_outcome_classifies_frames():
    assert _frame_outcome({"type": "done", "result": {"ok": 1}}) == (True, {"ok": 1})
    ok, payload = _frame_outcome({"type": "error", "detail": "boom"})
    assert ok is False and payload["detail"] == "boom"
    assert _frame_outcome({"type": "progress", "percent": 50}) is None


def test_terminal_result_returns_done_payload():
    snap = {"status": "done", "last": {"type": "done", "result": {"ip": "10.0.0.5"}}}
    assert _terminal_result(snap) == {"ip": "10.0.0.5"}


def test_terminal_result_reraises_error_snapshot():
    snap = {"status": "error", "last": {"type": "error", "detail": "prior failure"}}
    with pytest.raises(DispatchError):
        _terminal_result(snap)


def test_terminal_result_none_for_nonterminal_snapshot():
    snap = {"status": "running", "last": {"type": "progress", "percent": 10}}
    assert _terminal_result(snap) is None
