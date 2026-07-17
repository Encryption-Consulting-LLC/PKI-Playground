"""Shared ESXi connection lifecycle regression tests."""

import os
from types import SimpleNamespace

import pytest
from pyVmomi import vim
from vmkit.errors import ConnectionFailedError

os.environ.setdefault("SESSION_SECRET", "test-session-secret")
os.environ.setdefault(
    "SETTINGS_ENC_KEY", "MDEyMzQ1Njc4OWFiY2RlZjAxMjM0NTY3ODlhYmNkZWY="
)

from app.core import esxi  # noqa: E402


def _target() -> esxi.EsxiTarget:
    return esxi.EsxiTarget("esxi.example.test", "operator", "secret")


def _wrapped_denial(*, privilege="System.View", object_id="ha-folder-root"):
    denied = vim.fault.NoPermission(
        msg="Permission to perform this operation was denied.",
        privilegeId=privilege,
        object=vim.Folder(object_id),
    )
    try:
        raise denied
    except vim.fault.NoPermission as exc:
        try:
            raise ConnectionFailedError(f"Could not connect: {exc}")
        except ConnectionFailedError as wrapped:
            return wrapped


def test_root_system_view_denial_is_retried_once(monkeypatch):
    opened = SimpleNamespace(si=object())
    attempts = iter([_wrapped_denial(), opened])
    calls = []

    def fake_open(*args):
        calls.append(args)
        result = next(attempts)
        if isinstance(result, BaseException):
            raise result
        return result

    monkeypatch.setattr(esxi, "open_connection", fake_open)
    monkeypatch.setattr(esxi.time, "sleep", lambda seconds: None)

    assert esxi.ConnectionManager().get(_target()) is opened
    assert len(calls) == 2


def test_repeated_root_system_view_denial_stops_after_retry(monkeypatch):
    calls = 0

    def fake_open(*_args):
        nonlocal calls
        calls += 1
        raise _wrapped_denial()

    monkeypatch.setattr(esxi, "open_connection", fake_open)
    monkeypatch.setattr(esxi.time, "sleep", lambda seconds: None)

    with pytest.raises(ConnectionFailedError):
        esxi.ConnectionManager().get(_target())

    assert calls == 2


@pytest.mark.parametrize(
    ("privilege", "object_id"),
    [
        ("VirtualMachine.Inventory.Create", "ha-folder-root"),
        ("System.View", "group-v3"),
    ],
)
def test_other_permission_denials_are_not_retried(monkeypatch, privilege, object_id):
    failure = _wrapped_denial(privilege=privilege, object_id=object_id)
    calls = 0

    def fake_open(*_args):
        nonlocal calls
        calls += 1
        raise failure

    monkeypatch.setattr(esxi, "open_connection", fake_open)

    with pytest.raises(ConnectionFailedError):
        esxi.ConnectionManager().get(_target())

    assert calls == 1
