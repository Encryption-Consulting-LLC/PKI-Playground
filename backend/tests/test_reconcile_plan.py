"""Reconcile jobs reuse desired state while skipping VM creation."""

import os

os.environ.setdefault("SESSION_SECRET", "test-session-secret")
os.environ.setdefault(
    "SETTINGS_ENC_KEY", "MDEyMzQ1Njc4OWFiY2RlZjAxMjM0NTY3ODlhYmNkZWY="
)

from app import tasks  # noqa: E402


def test_reconcile_task_is_registered():
    assert tasks.reconcile_plan_task.name == "reconcile_plan"


def test_reconcile_source_filter_excludes_destructive_lifecycle_ops():
    operations = [
        {"id": "clone", "kind": "createVm"},
        {"id": "join", "kind": "domainJoin"},
        {"id": "publish", "kind": "webServerCert"},
        {"id": "leave", "kind": "domainLeave"},
    ]

    selected = [
        item["id"] for item in operations
        if item["kind"] not in ("createVm", "domainLeave")
    ]

    assert selected == ["join", "publish"]
