"""Immutable ESXi preflight for a complete guided PKI deployment."""

import hashlib
import json
from collections import defaultdict
from typing import Literal

from pydantic import BaseModel, ConfigDict, Field
from pyVmomi import vim
from vmkit import Connection
from vmkit.datastore import get_base_vmdk_size
from vmkit.esxi import get_datastore, get_vm_by_name, list_vm_names

from app.core.db.models import now_ms
from app.core.infrastructure import (
    ASSUMED_TESTED_BASE_CHANGE_VERSION,
    LINUX_PRODUCT_TEMPLATES,
    REQUIRED_AGENT_COMMANDS,
    InfrastructureProfile,
    PkiRole,
)
from app.core.vmware_guest_os import guest_os_ids_match


class PlannedMachine(BaseModel):
    role: PkiRole
    name: str


InfrastructureCheckKey = Literal[
    "vmNames", "image", "guestOs", "network", "datastore", "capacity",
    "qualification",
]


class InfrastructureCheck(BaseModel):
    key: InfrastructureCheckKey
    ok: bool
    detail: str
    role: PkiRole | None = None
    datastore: str | None = None


class MachineReservation(BaseModel):
    model_config = ConfigDict(populate_by_name=True)

    role: PkiRole
    name: str
    base: str
    base_moid: str | None = Field(default=None, alias="baseMoid")
    base_change_version: str | None = Field(default=None, alias="baseChangeVersion")
    datastore: str
    network: str
    expected_guest_os: str = Field(alias="expectedGuestOs")
    actual_guest_os: str | None = Field(default=None, alias="actualGuestOs")
    cpus: int
    memory_mb: int = Field(alias="memoryMb")
    system_disk_gb: int = Field(alias="systemDiskGb")
    reserved_bytes: int | None = Field(default=None, alias="reservedBytes")


class DatastoreReservation(BaseModel):
    model_config = ConfigDict(populate_by_name=True)

    datastore: str
    capacity_bytes: int | None = Field(default=None, alias="capacityBytes")
    free_bytes: int | None = Field(default=None, alias="freeBytes")
    reserved_bytes: int | None = Field(default=None, alias="reservedBytes")
    projected_usage_pct: float | None = Field(default=None, alias="projectedUsagePct")
    max_usage_pct: float = Field(alias="maxUsagePct")


class InfrastructurePreflight(BaseModel):
    model_config = ConfigDict(populate_by_name=True)

    ready: bool
    checked_at: int = Field(alias="checkedAt")
    snapshot_id: str = Field(alias="snapshotId")
    esxi_instance_uuid: str | None = Field(default=None, alias="esxiInstanceUuid")
    machines: list[MachineReservation]
    datastores: list[DatastoreReservation]
    checks: list[InfrastructureCheck]


def _network_names(content) -> set[str]:
    view = content.viewManager.CreateContainerView(
        content.rootFolder, [vim.Network], True
    )
    try:
        return {item.name for item in view.view}
    finally:
        view.Destroy()


def _vm_network_names(vm) -> set[str]:
    """Return port-group names backing the base VM NICs."""

    devices = getattr(
        getattr(getattr(vm, "config", None), "hardware", None), "device", []
    ) or []
    names: set[str] = set()
    for device in devices:
        backing = getattr(device, "backing", None)
        name = getattr(backing, "deviceName", None)
        if not name:
            name = getattr(getattr(backing, "network", None), "name", None)
        if name:
            names.add(name)
    return names


def _snapshot_id(facts: dict) -> str:
    encoded = json.dumps(facts, sort_keys=True, separators=(",", ":")).encode()
    return hashlib.sha256(encoded).hexdigest()


def preflight_infrastructure(
    conn: Connection,
    profiles: dict[PkiRole, InfrastructureProfile],
    machines: list[PlannedMachine],
) -> InfrastructurePreflight:
    """Validate every role mapping and reserve aggregate datastore capacity."""

    checks: list[InfrastructureCheck] = []
    reservations: list[MachineReservation] = []
    datastore_requests: dict[str, list[tuple[InfrastructureProfile, int | None]]] = (
        defaultdict(list)
    )
    instance_uuid = getattr(getattr(conn.content, "about", None), "instanceUuid", None)

    try:
        inventory_names = set(list_vm_names(conn.content))
    except Exception as exc:  # noqa: BLE001 - preserve all preflight failures
        inventory_names = set()
        checks.append(
            InfrastructureCheck(
                key="vmNames", ok=False, detail=f"Could not read VM inventory: {exc}"
            )
        )
    else:
        collisions = sorted({machine.name for machine in machines} & inventory_names)
        checks.append(
            InfrastructureCheck(
                key="vmNames",
                ok=not collisions,
                detail=(
                    f"VM name(s) already exist: {', '.join(collisions)}."
                    if collisions
                    else f"No collisions among {len(machines)} requested VM name(s)."
                ),
            )
        )

    try:
        networks = _network_names(conn.content)
        network_error = None
    except Exception as exc:  # noqa: BLE001
        networks = set()
        network_error = str(exc)

    for machine in machines:
        profile = profiles[machine.role]
        base_vm = None
        try:
            base_vm = get_vm_by_name(conn.content, profile.base)
        except Exception as exc:  # noqa: BLE001
            checks.append(
                InfrastructureCheck(
                    key="image", role=machine.role, ok=False,
                    detail=f"Could not inspect image '{profile.base}': {exc}",
                )
            )
        base_moid = None
        change_version = None
        actual_guest_os = None
        base_networks: set[str] = set()
        base_size = None
        if base_vm is None:
            if not any(c.key == "image" and c.role == machine.role for c in checks):
                checks.append(
                    InfrastructureCheck(
                        key="image", role=machine.role, ok=False,
                        detail=f"Golden image VM '{profile.base}' was not found.",
                    )
                )
            checks.append(
                InfrastructureCheck(
                    key="guestOs", role=machine.role, ok=False,
                    detail="Guest OS cannot be checked until the image exists.",
                )
            )
        else:
            base_moid = getattr(base_vm, "_moId", None)
            vm_config = getattr(base_vm, "config", None)
            change_version = getattr(vm_config, "changeVersion", None)
            base_networks = _vm_network_names(base_vm)
            vm_path = getattr(getattr(vm_config, "files", None), "vmPathName", "") or ""
            expected_prefix = f"[{profile.datastore}] {profile.base}/"
            image_ok = vm_path.startswith(expected_prefix)
            checks.append(
                InfrastructureCheck(
                    key="image", role=machine.role, ok=image_ok,
                    detail=(
                        f"Image '{profile.base}' is registered from {vm_path}."
                        if image_ok
                        else f"Image '{profile.base}' is not stored on '{profile.datastore}'."
                    ),
                )
            )
            actual_guest_os = getattr(vm_config, "guestId", None)
            linux_product = machine.role in LINUX_PRODUCT_TEMPLATES
            platform_label = "Linux" if linux_product else "Windows"
            platform_ok = bool(
                actual_guest_os
                and (
                    not linux_product
                    and actual_guest_os.lower().startswith("windows")
                    or linux_product
                    and not actual_guest_os.lower().startswith("windows")
                )
            )
            os_ok = platform_ok and guest_os_ids_match(
                actual_guest_os, profile.expected_guest_os
            )
            checks.append(
                InfrastructureCheck(
                    key="guestOs", role=machine.role, ok=os_ok,
                    detail=(
                        f"Image reports expected {platform_label} guest OS '{actual_guest_os}'."
                        if os_ok
                        else f"Image reports '{actual_guest_os or 'unknown'}'; expected '{profile.expected_guest_os}'."
                    ),
                )
            )

        qualification = profile.qualification
        linux_product = machine.role in LINUX_PRODUCT_TEMPLATES
        revision_qualified = bool(
            qualification
            and (
                qualification.base_change_version == change_version
                or qualification.base_change_version == ASSUMED_TESTED_BASE_CHANGE_VERSION
            )
        )
        qualification_ok = linux_product or bool(
            qualification
            and revision_qualified
            and qualification.system_context_validated
            and qualification.time_synchronized
            and qualification.windows_updates_current
            and qualification.backend_callback_reachable
            and REQUIRED_AGENT_COMMANDS <= set(qualification.agent_commands)
            and qualification.publication_manifest_version >= 1
            and (
                machine.role not in ("rootCa", "issuingCa")
                or qualification.ml_dsa_87_available
            )
            and (
                machine.role != "webServer"
                or qualification.ocsp_reference_sha256
            )
        )
        checks.append(
            InfrastructureCheck(
                key="qualification", role=machine.role, ok=qualification_ok,
                detail=(
                    "Linux product setup is stubbed; Windows PKI qualification is not required."
                    if linux_product
                    else "Image qualification matches this revision and required canaries."
                    if qualification_ok
                    else (
                        "Image revision is not qualified for the current runner, SYSTEM "
                        "operations, ML-DSA-87, and role-specific OCSP reference."
                    )
                ),
            )
        )

        network_ok = (
            network_error is None
            and profile.network in networks
            and profile.network in base_networks
        )
        checks.append(
            InfrastructureCheck(
                key="network", role=machine.role, ok=network_ok,
                detail=(
                    f"Network mapping '{profile.network}' exists and backs the image NIC."
                    if network_ok
                    else (
                        f"Could not inspect ESXi networks: {network_error}"
                        if network_error
                        else (
                            f"Network mapping '{profile.network}' must exist and back "
                            f"the selected image NIC (observed: {sorted(base_networks)})."
                        )
                    )
                ),
            )
        )

        try:
            datastore = get_datastore(conn.content, profile.datastore)
            base_size = int(get_base_vmdk_size(datastore, profile.base))
            if base_size <= 0:
                raise RuntimeError("base VMDK files are missing or empty")
        except Exception as exc:  # noqa: BLE001
            checks.append(
                InfrastructureCheck(
                    key="datastore", role=machine.role, datastore=profile.datastore,
                    ok=False, detail=f"Could not inspect datastore or base VMDK: {exc}",
                )
            )
        else:
            checks.append(
                InfrastructureCheck(
                    key="datastore", role=machine.role, datastore=profile.datastore,
                    ok=True, detail=f"Datastore '{profile.datastore}' and base VMDK are available.",
                )
            )
        reserved = (
            max(base_size, profile.system_disk_gb * 1024**3)
            if base_size is not None
            else None
        )
        datastore_requests[profile.datastore].append((profile, reserved))
        reservations.append(
            MachineReservation(
                role=machine.role, name=machine.name, base=profile.base,
                baseMoid=base_moid, baseChangeVersion=change_version,
                datastore=profile.datastore, network=profile.network,
                expectedGuestOs=profile.expected_guest_os, actualGuestOs=actual_guest_os,
                cpus=profile.cpus, memoryMb=profile.memory_mb,
                systemDiskGb=profile.system_disk_gb, reservedBytes=reserved,
            )
        )

    datastore_reservations: list[DatastoreReservation] = []
    for datastore_name, requests in sorted(datastore_requests.items()):
        capacity = free = required = projected_pct = None
        limit = min(profile.max_usage_pct for profile, _size in requests)
        try:
            datastore = get_datastore(conn.content, datastore_name)
            capacity = int(datastore.summary.capacity)
            free = int(datastore.summary.freeSpace)
            sizes = [size for _profile, size in requests]
            if any(size is None for size in sizes):
                raise RuntimeError("one or more base VMDK sizes are unavailable")
            required = sum(size for size in sizes if size is not None)
            projected_pct = round((capacity - free + required) / capacity * 100, 2)
            capacity_ok = required <= free and projected_pct <= limit
            detail = (
                f"Reserved {required} bytes; projected usage {projected_pct:.2f}% "
                f"(limit {limit:.2f}%)."
            )
        except Exception as exc:  # noqa: BLE001
            capacity_ok = False
            detail = f"Could not reserve datastore capacity: {exc}"
        checks.append(
            InfrastructureCheck(
                key="capacity", datastore=datastore_name, ok=capacity_ok, detail=detail
            )
        )
        datastore_reservations.append(
            DatastoreReservation(
                datastore=datastore_name, capacityBytes=capacity, freeBytes=free,
                reservedBytes=required, projectedUsagePct=projected_pct,
                maxUsagePct=limit,
            )
        )

    facts = {
        "esxiInstanceUuid": instance_uuid,
        "machines": [item.model_dump(by_alias=True) for item in reservations],
        "datastores": [item.model_dump(by_alias=True) for item in datastore_reservations],
        "checks": [item.model_dump(by_alias=True) for item in checks],
    }
    return InfrastructurePreflight(
        ready=all(check.ok for check in checks), checkedAt=now_ms(),
        snapshotId=_snapshot_id(facts), **facts,
    )
