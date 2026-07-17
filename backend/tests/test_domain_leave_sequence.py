"""Real domain leave and owned DNS cleanup sequence."""

import os

os.environ.setdefault("SESSION_SECRET", "test-session-secret")
os.environ.setdefault(
    "SETTINGS_ENC_KEY", "MDEyMzQ1Njc4OWFiY2RlZjAxMjM0NTY3ODlhYmNkZWY="
)

from app.core.sequences.definitions import op_sequence  # noqa: E402
from app.core.sequences.model import DnsRecordContext, NodeContext, RunContext  # noqa: E402
from app.tasks import _REAL_SEQUENCE_KINDS  # noqa: E402


def _ctx():
    member = NodeContext(
        node_id="srv1",
        vm_name="SRV1",
        hostname="srv1",
        agent_vm_id="member",
        ip="192.168.1.20",
        template_id="webServer",
    )
    dc = NodeContext(
        node_id="dc01",
        vm_name="DC01",
        hostname="dc01",
        agent_vm_id="dc",
        ip="192.168.1.10",
        template_id="domainController",
        template_config={
            "domainName": "encon.pki",
            "netbiosName": "ENCON",
            "domainAdminPassword": "Str0ng-Lab-Pass!",
        },
    )
    return RunContext(
        nodes={"primary": member, "dc": dc},
        domain_name="encon.pki",
        netbios="ENCON",
        dns_records=(
            DnsRecordContext(
                id="dns:a:dc01:srv1",
                kind="A",
                server="dc01",
                subject="srv1",
                zone="encon.pki",
            ),
        ),
    )


def test_domain_leave_runs_as_a_real_sequence():
    assert "domainLeave" in _REAL_SEQUENCE_KINDS
    assert [step.command for step in op_sequence("domainLeave", _ctx())] == [
        "domain.leave",
        "system.reboot",
        "dns.remove_resources",
        "dns.verify_absent",
    ]


def test_domain_leave_uses_redacted_domain_credentials():
    ctx = _ctx()
    leave = op_sequence("domainLeave", ctx)[0]
    params = leave.resolve_params(ctx)

    assert params["workgroup"] == "WORKGROUP"
    assert params["username"] == "ENCON\\Administrator"
    assert params["password"] == "Str0ng-Lab-Pass!"
    assert leave.secret_keys == ("password",)


def test_domain_leave_verifies_membership_and_dns_absence():
    ctx = _ctx()
    steps = op_sequence("domainLeave", ctx)

    assert steps[1].verify_predicate({"part_of_domain": False}) is True
    assert steps[1].verify_predicate({"part_of_domain": True}) is False
    assert "192.168.1.20" in steps[2].resolve_params(ctx)["records"]
