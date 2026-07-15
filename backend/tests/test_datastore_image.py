"""Datastore VMX facts used when the golden image is not registered."""

import os
from types import SimpleNamespace

os.environ.setdefault("SESSION_SECRET", "test-session-secret")
os.environ.setdefault(
    "SETTINGS_ENC_KEY", "MDEyMzQ1Njc4OWFiY2RlZjAxMjM0NTY3ODlhYmNkZWY="
)

from app.core import datastore_image as subject  # noqa: E402


def test_parse_datastore_vmx_extracts_guest_networks_and_revision():
    facts = subject.parse_datastore_vmx(
        "[datastore1] ws-2025-base/ws-2025-base.vmx",
        '\n'.join(
            [
                'guestOS = "windows2022srvNext-64"',
                'ethernet0.present = "TRUE"',
                'ethernet0.networkName = "VM Network"',
                'ethernet1.present = "FALSE"',
                'ethernet1.networkName = "Unused"',
            ]
        ),
    )

    assert facts.guest_os == "windows2022srvNext-64"
    assert facts.networks == frozenset({"VM Network"})
    assert facts.revision.startswith("vmx-sha256:")
    assert len(facts.revision) == len("vmx-sha256:") + 64


def test_read_datastore_vmx_uses_connection_credentials(monkeypatch):
    calls = []
    monkeypatch.setattr(
        subject,
        "get_datacenter",
        lambda _content: SimpleNamespace(name="ha-datacenter"),
    )
    monkeypatch.setattr(
        subject,
        "read_datastore_file",
        lambda *args: calls.append(args) or 'guestOS = "windows2022srvNext-64"',
    )
    conn = SimpleNamespace(
        content=object(), host="esxi.test", user="root", password="secret", port=443
    )

    facts = subject.read_datastore_vmx(conn, "datastore1", "ws-2025-base")

    assert calls == [
        (
            "esxi.test", "root", "secret", 443, "datastore1", "ha-datacenter",
            "ws-2025-base/ws-2025-base.vmx",
        )
    ]
    assert facts.path == "[datastore1] ws-2025-base/ws-2025-base.vmx"
