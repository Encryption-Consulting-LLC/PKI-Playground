"""Cross-node runtime aliases match each compiled operation's semantics."""

import os
from types import SimpleNamespace

os.environ.setdefault("SESSION_SECRET", "test-session-secret")
os.environ.setdefault(
    "SETTINGS_ENC_KEY",
    "MDEyMzQ1Njc4OWFiY2RlZjAxMjM0NTY3ODlhYmNkZWY=",
)

from app.core.sequences import context as sequence_context  # noqa: E402
from app.core.sequences.model import NodeContext  # noqa: E402


def _node(node_id: str, template_id: str, config=None) -> NodeContext:
    return NodeContext(
        node_id=node_id,
        vm_name=f"guest-abc12-{node_id}",
        hostname=f"guest-abc12-{node_id}",
        agent_vm_id=f"v-{node_id}",
        ip="192.168.1.1",
        template_id=template_id,
        template_config=config or {},
    )


def test_web_publication_context_targets_the_web_host(monkeypatch):
    ca = _node("ca02", "certificateAuthority", {"caType": "Issuing"})
    web = _node("srv1", "webServer")
    dc = _node(
        "dc01",
        "domainController",
        {"domainName": "encon.pki", "netbiosName": "ENCON"},
    )
    by_id = {"ca02": ca, "srv1": web}
    monkeypatch.setattr(
        sequence_context, "_resolve_node", lambda db, node_id: by_id[node_id]
    )
    monkeypatch.setattr(
        sequence_context, "_find_domain_controller", lambda db, name: dc
    )
    monkeypatch.setattr(
        sequence_context, "_find_by_template", lambda db, name, template: web
    )
    monkeypatch.setattr(
        sequence_context, "_find_issuing_ca", lambda db, name: ca
    )
    op = SimpleNamespace(
        kind=SimpleNamespace(value="webServerCert"),
        target="ca02",
        secondary="srv1",
    )

    resolved = sequence_context.build_run_context({}, op, [])

    assert resolved.node("primary").node_id == "srv1"
    assert resolved.node("secondary").node_id == "ca02"
