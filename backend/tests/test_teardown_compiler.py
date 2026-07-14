"""Dependency-aware teardown compilation and action sequences."""

import os

os.environ.setdefault("SESSION_SECRET", "test-session-secret")
os.environ.setdefault(
    "SETTINGS_ENC_KEY", "MDEyMzQ1Njc4OWFiY2RlZjAxMjM0NTY3ODlhYmNkZWY="
)

from app.core.sequences.definitions import teardown_action_sequence  # noqa: E402
from app.core.sequences.model import NodeContext, RunContext  # noqa: E402
from app.core.teardown import compile_teardown  # noqa: E402
from app.core.topology import TopologyDocument  # noqa: E402
from app.tasks import teardown_plan_task  # noqa: E402


def _topology():
    return TopologyDocument(
        version=1,
        nodes=[
            {"id": "dc", "name": "DC01", "role": "domainController"},
            {"id": "root", "name": "CA01", "role": "rootCa"},
            {"id": "issuing", "name": "CA02", "role": "issuingCa"},
            {"id": "web", "name": "SRV1", "role": "webServer"},
        ],
        edges=[
            {"id": "join-ca", "kind": "domainMembership", "source": "issuing", "target": "dc"},
            {"id": "join-web", "kind": "domainMembership", "source": "web", "target": "dc"},
            {"id": "parent", "kind": "caParent", "source": "root", "target": "issuing"},
            {"id": "publish", "kind": "caPublication", "source": "issuing", "target": "web"},
        ],
        dnsRecords=[],
    )


def test_teardown_orders_services_membership_dns_and_vm_destruction():
    actions = compile_teardown(_topology())
    index = {action.id: position for position, action in enumerate(actions)}

    assert index["web.cleanup:web"] < index["domain.leave:web"]
    assert index["domain.leave:web"] < index["dns.cleanup:dc"]
    assert index["ca.cleanup:issuing"] < index["domain.leave:issuing"]
    assert index["vm.destroy:web"] < index["vm.destroy:issuing"]
    assert index["vm.destroy:issuing"] < index["vm.destroy:root"]
    assert index["forest.cleanup:dc"] < index["vm.destroy:dc"]
    assert index["vm.destroy:root"] < index["vm.destroy:dc"]


def test_teardown_sequences_remove_role_services():
    node = NodeContext(
        node_id="web", vm_name="SRV1", hostname="srv1", agent_vm_id="agent",
        template_id="webServer",
    )
    ctx = RunContext(nodes={"primary": node})

    assert [step.command for step in teardown_action_sequence("web.cleanup", ctx)] == [
        "ocsp.remove", "iis.remove_certenroll"
    ]
    assert teardown_action_sequence("ca.cleanup", ctx)[0].command == "ca.uninstall"


def test_teardown_task_is_registered():
    assert teardown_plan_task.name == "teardown_plan"
