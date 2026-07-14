"""Restart/redelivery acceptance at destructive and rebooting boundaries."""

import os

import pytest

os.environ.setdefault("SESSION_SECRET", "test-session-secret")
os.environ.setdefault(
    "SETTINGS_ENC_KEY", "MDEyMzQ1Njc4OWFiY2RlZjAxMjM0NTY3ODlhYmNkZWY="
)

from app.core.sequences.definitions import op_sequence, teardown_action_sequence  # noqa: E402
from app.core.sequences.engine import SequenceEngine  # noqa: E402
from app.core.sequences.model import DnsRecordContext, NodeContext, RunContext  # noqa: E402


def _context():
    member = NodeContext(
        node_id="web", vm_name="SRV1", hostname="srv1",
        agent_vm_id="web-agent", ip="192.168.1.20", template_id="webServer",
    )
    dc = NodeContext(
        node_id="dc", vm_name="DC01", hostname="dc01",
        agent_vm_id="dc-agent", ip="192.168.1.10", template_id="domainController",
        template_config={
            "domainName": "encon.pki", "netbiosName": "ENCON",
            "domainAdminPassword": "Str0ng-Lab-Pass!",
        },
    )
    return RunContext(
        nodes={"primary": member, "web": member, "dc": dc},
        domain_name="encon.pki", netbios="ENCON",
        dns_records=(
            DnsRecordContext(
                id="dns:a:dc:web", kind="A", server="dc", subject="web",
                zone="encon.pki",
            ),
        ),
    )


@pytest.mark.parametrize("boundary", range(5))
def test_domain_leave_redelivery_skips_every_persisted_boundary(boundary):
    steps = op_sequence("domainLeave", _context())
    completed = {step.id for step in steps[:boundary]}
    dispatched = []

    def dispatch(job_key, _vm, command, *_args, **_kwargs):
        dispatched.append(job_key)
        if command == "domain.verify":
            return {"part_of_domain": False}
        return {"ok": True}

    engine = SequenceEngine(
        dispatch=dispatch,
        wait_for_reconnect=lambda *args: None,
        sleep=lambda _seconds: None,
        now_ms=lambda: 1,
        completed=completed,
        resumed_results={step_id: {"resumed": True} for step_id in completed},
    )
    engine.run(steps, _context())

    main_dispatches = [key for key in dispatched if ".verify." not in key]
    assert main_dispatches == [step.id for step in steps[boundary:]]


@pytest.mark.parametrize("boundary", range(3))
def test_service_cleanup_redelivery_never_repeats_completed_removal(boundary):
    ctx = _context()
    steps = teardown_action_sequence("web.cleanup", ctx)
    completed = {step.id for step in steps[:boundary]}
    dispatched = []
    engine = SequenceEngine(
        dispatch=lambda job_key, *_args, **_kwargs: dispatched.append(job_key) or {},
        wait_for_reconnect=lambda *args: None,
        sleep=lambda _seconds: None,
        now_ms=lambda: 1,
        completed=completed,
    )

    engine.run(steps, ctx)

    assert dispatched == [step.id for step in steps[boundary:]]
