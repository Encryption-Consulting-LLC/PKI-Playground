"""Role-specific infrastructure and aggregate capacity preflight."""

import os
from types import SimpleNamespace

os.environ.setdefault("SESSION_SECRET", "test-session-secret")
os.environ.setdefault(
    "SETTINGS_ENC_KEY", "MDEyMzQ1Njc4OWFiY2RlZjAxMjM0NTY3ODlhYmNkZWY="
)

from app.core import infrastructure_preflight as subject  # noqa: E402
from app.core.infrastructure import InfrastructureProfile  # noqa: E402


def _profile(role, *, base="ws-2025", datastore="store", network="PKI"):
    return InfrastructureProfile(
        role=role, base=base, datastore=datastore,
        expectedGuestOs="windows2022srvNext-64", network=network,
        cpus=2, memoryMb=4096, systemDiskGb=60, maxUsagePct=90,
        qualification={
            "baseChangeVersion": "7", "windowsBuild": 26100,
            "runnerVersion": "2.0.0", "agentSha256": "a" * 64,
            "validatedAt": 1, "mlDsa87Available": True,
            "systemContextValidated": True,
            "timeSynchronized": True, "windowsUpdatesCurrent": True,
            "backendCallbackReachable": True,
            **(
                {"ocspReferenceSha256": "b" * 64}
                if role == "webServer" else {}
            ),
        },
    )


def _vm(base="ws-2025"):
    return SimpleNamespace(
        _moId=f"vm-{base}",
        config=SimpleNamespace(
            guestId="windows2022srvNext-64", changeVersion="7",
            files=SimpleNamespace(vmPathName=f"[store] {base}/{base}.vmx"),
        ),
    )


def _patch(monkeypatch, *, free=500 * 1024**3, networks=("PKI", "Offline")):
    monkeypatch.setattr(subject, "list_vm_names", lambda _content: {"ws-2025"})
    monkeypatch.setattr(subject, "get_vm_by_name", lambda _content, base: _vm(base))
    datastore = SimpleNamespace(
        summary=SimpleNamespace(capacity=1000 * 1024**3, freeSpace=free)
    )
    monkeypatch.setattr(subject, "get_datastore", lambda _content, _name: datastore)
    monkeypatch.setattr(subject, "get_base_vmdk_size", lambda _ds, _base: 40 * 1024**3)
    monkeypatch.setattr(subject, "_network_names", lambda _content: set(networks))


def _run(monkeypatch, *, free=500 * 1024**3, networks=("PKI", "Offline")):
    _patch(monkeypatch, free=free, networks=networks)
    profiles = {
        role: _profile(role, network="Offline" if role == "rootCa" else "PKI")
        for role in ("domainController", "rootCa", "issuingCa", "webServer")
    }
    machines = [
        subject.PlannedMachine(role=role, name=name)
        for role, name in (
            ("domainController", "DC01"), ("rootCa", "CA01"),
            ("issuingCa", "CA02"), ("webServer", "SRV1"),
        )
    ]
    conn = SimpleNamespace(
        content=SimpleNamespace(about=SimpleNamespace(instanceUuid="esxi-1"))
    )
    return subject.preflight_infrastructure(conn, profiles, machines)


def test_preflight_reserves_all_role_disks_on_shared_datastore(monkeypatch):
    result = _run(monkeypatch)

    assert result.ready is True
    assert len(result.machines) == 4
    assert result.datastores[0].reserved_bytes == 240 * 1024**3
    assert result.machines[1].network == "Offline"
    assert len(result.snapshot_id) == 64


def test_aggregate_reservation_blocks_datastore_overcommit(monkeypatch):
    result = _run(monkeypatch, free=200 * 1024**3)

    assert result.ready is False
    capacity = next(check for check in result.checks if check.key == "capacity")
    assert capacity.ok is False


def test_missing_role_network_is_blocking(monkeypatch):
    result = _run(monkeypatch, networks=("PKI",))

    assert result.ready is False
    root_network = next(
        check for check in result.checks
        if check.key == "network" and check.role == "rootCa"
    )
    assert root_network.ok is False


def test_changed_image_revision_invalidates_canary_qualification(monkeypatch):
    _patch(monkeypatch)
    profile = _profile("rootCa")
    profile.qualification.base_change_version = "stale"
    result = subject.preflight_infrastructure(
        SimpleNamespace(
            content=SimpleNamespace(about=SimpleNamespace(instanceUuid="esxi-1"))
        ),
        {"rootCa": profile},
        [subject.PlannedMachine(role="rootCa", name="CA01")],
    )

    assert result.ready is False
    check = next(item for item in result.checks if item.key == "qualification")
    assert check.ok is False


def test_web_role_requires_frozen_ocsp_reference_dump(monkeypatch):
    _patch(monkeypatch)
    profile = _profile("webServer")
    profile.qualification.ocsp_reference_sha256 = None
    result = subject.preflight_infrastructure(
        SimpleNamespace(
            content=SimpleNamespace(about=SimpleNamespace(instanceUuid="esxi-1"))
        ),
        {"webServer": profile},
        [subject.PlannedMachine(role="webServer", name="SRV1")],
    )

    assert result.ready is False
    assert next(item for item in result.checks if item.key == "qualification").ok is False
