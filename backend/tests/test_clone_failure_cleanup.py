"""createVm failure rollback (`tasks._cleanup_failed_clone`).

A clone that fails AFTER the VM was created (e.g. a vSphere fault while
reading back the moid) must NOT release the VM's IP or wipe its agent
identity — the booted VM holds both, and dropping the token hash strands the
agent on a permanent 403. Reclaim only happens when the VM is provably absent.
"""

import os

os.environ.setdefault("SESSION_SECRET", "test-session-secret")
os.environ.setdefault(
    "SETTINGS_ENC_KEY", "MDEyMzQ1Njc4OWFiY2RlZjAxMjM0NTY3ODlhYmNkZWY="
)

from app import tasks


class _Conn:
    content = object()


def _capture(monkeypatch, vm_lookup):
    """Patch the collaborators and record what the cleanup does."""
    calls = {"released": [], "upserts": []}
    monkeypatch.setattr(tasks, "get_vm_by_name", vm_lookup)
    monkeypatch.setattr(
        tasks, "release_ip_sync", lambda db, name: calls["released"].append(name)
    )
    monkeypatch.setattr(
        tasks,
        "_registry_upsert_sync",
        lambda db, name, **fields: calls["upserts"].append((name, fields)),
    )
    return calls


def test_absent_vm_reclaims_ip_and_agent(monkeypatch):
    calls = _capture(monkeypatch, lambda content, name: None)

    tasks._cleanup_failed_clone(_Conn(), object(), "guest-x-dc", "10.0.0.5")

    assert calls["released"] == ["guest-x-dc"]
    assert calls["upserts"] == [
        ("guest-x-dc", {"status": "error", "ip": None, "agent": None})
    ]


def test_live_vm_keeps_ip_and_agent(monkeypatch):
    calls = _capture(monkeypatch, lambda content, name: object())

    tasks._cleanup_failed_clone(_Conn(), object(), "guest-x-dc", "10.0.0.5")

    assert calls["released"] == []
    assert calls["upserts"] == [("guest-x-dc", {"status": "error"})]


def test_unprovable_absence_keeps_ip_and_agent(monkeypatch):
    def _boom(content, name):
        raise RuntimeError("inventory enumeration failed")

    calls = _capture(monkeypatch, _boom)

    tasks._cleanup_failed_clone(_Conn(), object(), "guest-x-dc", "10.0.0.5")

    assert calls["released"] == []
    assert calls["upserts"] == [("guest-x-dc", {"status": "error"})]


def test_absent_vm_without_allocation_skips_release(monkeypatch):
    calls = _capture(monkeypatch, lambda content, name: None)

    tasks._cleanup_failed_clone(_Conn(), object(), "authored-vm", None)

    assert calls["released"] == []
    assert calls["upserts"] == [
        ("authored-vm", {"status": "error", "ip": None, "agent": None})
    ]
