"""Read-only ESXi preflight for the guided-deploy Windows golden image."""

import hashlib
import json
from typing import Literal

from pydantic import BaseModel, ConfigDict, Field
from vmkit import Connection
from vmkit.datastore import get_base_vmdk_size
from vmkit.esxi import get_datastore, list_vm_names

from app.core.datastore_image import read_datastore_vmx
from app.core.db.models import now_ms
from app.core.settings import settings
from app.core.vmware_guest_os import guest_os_ids_match


class GoldenImageConfig(BaseModel):
    """Authoritative clone inputs read from the shared settings document."""

    model_config = ConfigDict(populate_by_name=True)

    base: str
    datastore: str
    expected_guest_os: str = Field(alias="expectedGuestOs")
    max_usage_pct: float = Field(alias="maxUsagePct", gt=0, le=100)


PreflightKey = Literal["image", "datastore", "guestOs", "capacity", "vmNames"]


class PreflightCheck(BaseModel):
    key: PreflightKey
    ok: bool
    detail: str


class GoldenImagePreflight(BaseModel):
    """Immutable facts observed during one ESXi preflight pass."""

    model_config = ConfigDict(populate_by_name=True)

    ready: bool
    checked_at: int = Field(alias="checkedAt")
    snapshot_id: str = Field(alias="snapshotId")
    base: str
    datastore: str
    esxi_instance_uuid: str | None = Field(default=None, alias="esxiInstanceUuid")
    base_moid: str | None = Field(default=None, alias="baseMoid")
    base_change_version: str | None = Field(default=None, alias="baseChangeVersion")
    expected_guest_os: str = Field(alias="expectedGuestOs")
    actual_guest_os: str | None = Field(default=None, alias="actualGuestOs")
    clone_count: int = Field(alias="cloneCount")
    requested_vm_names: list[str] = Field(alias="requestedVmNames")
    capacity_bytes: int | None = Field(default=None, alias="capacityBytes")
    free_bytes: int | None = Field(default=None, alias="freeBytes")
    base_vmdk_bytes: int | None = Field(default=None, alias="baseVmdkBytes")
    required_bytes: int | None = Field(default=None, alias="requiredBytes")
    projected_usage_pct: float | None = Field(default=None, alias="projectedUsagePct")
    max_usage_pct: float = Field(alias="maxUsagePct")
    checks: list[PreflightCheck]


def golden_image_config_from_doc(doc: dict | None) -> GoldenImageConfig:
    """Resolve persisted settings, retaining env defaults for legacy documents."""

    doc = doc or {}
    return GoldenImageConfig(
        base=doc.get("cloneBase") or settings.clone_base,
        datastore=doc.get("cloneDatastore") or settings.clone_datastore,
        expectedGuestOs=doc.get("cloneGuestOs") or settings.clone_guest_os,
        maxUsagePct=doc.get("cloneMaxUsagePct") or settings.clone_max_usage_pct,
    )


def _check(key: PreflightKey, ok: bool, detail: str) -> PreflightCheck:
    return PreflightCheck(key=key, ok=ok, detail=detail)


def _snapshot_id(facts: dict) -> str:
    payload = json.dumps(facts, sort_keys=True, separators=(",", ":")).encode()
    return hashlib.sha256(payload).hexdigest()


def preflight_golden_image(
    conn: Connection,
    config: GoldenImageConfig,
    *,
    requested_vm_names: list[str] | None = None,
    clone_count: int | None = None,
) -> GoldenImagePreflight:
    """Validate image identity, datastore files/capacity, OS, and name conflicts.

    The function is read-only. It returns every check it can evaluate so the
    settings UI can explain more than one correction in a single pass.
    """

    names = sorted(set(requested_vm_names or []))
    count = clone_count if clone_count is not None else len(names)
    if count < 0:
        raise ValueError("clone_count cannot be negative")

    checks: list[PreflightCheck] = []
    base_moid = None
    change_version = None
    actual_guest_os = None
    capacity = None
    free = None
    vmdk_size = None
    required = None
    projected_pct = None
    esxi_instance_uuid = getattr(
        getattr(conn.content, "about", None), "instanceUuid", None
    )

    try:
        inventory_names = list_vm_names(conn.content)
    except Exception as exc:  # noqa: BLE001 - preserve the ESXi read failure as a check
        inventory_names = set()
        checks.append(_check("vmNames", False, f"Could not read VM inventory: {exc}"))
    else:
        collisions = sorted(set(names) & inventory_names)
        checks.append(
            _check(
                "vmNames",
                not collisions,
                (
                    f"VM name(s) already exist: {', '.join(collisions)}."
                    if collisions
                    else f"No collisions among {len(names)} requested VM name(s)."
                ),
            )
        )

    try:
        vmx = read_datastore_vmx(conn, config.datastore, config.base)
    except Exception as exc:  # noqa: BLE001 - return a structured failed check
        checks.append(
            _check(
                "image",
                False,
                f"Could not read golden image VMX '[{config.datastore}] "
                f"{config.base}/{config.base}.vmx': {exc}",
            )
        )
        checks.append(
            _check(
                "guestOs", False, "Guest OS cannot be checked until the VMX is readable."
            )
        )
    else:
        change_version = vmx.revision
        checks.append(
            _check(
                "image",
                True,
                f"Golden image VMX '{vmx.path}' is available "
                f"(revision {vmx.revision}).",
            )
        )
        actual_guest_os = vmx.guest_os
        guest_ok = bool(
            actual_guest_os
            and actual_guest_os.lower().startswith("windows")
            and guest_os_ids_match(actual_guest_os, config.expected_guest_os)
        )
        checks.append(
            _check(
                "guestOs",
                guest_ok,
                (
                    f"Golden image reports expected Windows guest OS '{actual_guest_os}'."
                    if guest_ok
                    else (
                        f"Golden image reports guest OS '{actual_guest_os or 'unknown'}'; "
                        f"expected '{config.expected_guest_os}'."
                    )
                ),
            )
        )

    try:
        datastore = get_datastore(conn.content, config.datastore)
        capacity = int(datastore.summary.capacity)
        free = int(datastore.summary.freeSpace)
        checks.append(
            _check("datastore", True, f"Datastore '{config.datastore}' is available.")
        )
        vmdk_size = int(get_base_vmdk_size(datastore, config.base))
        if vmdk_size <= 0:
            raise RuntimeError("base VMDK files are missing or empty")
        required = vmdk_size * count
        projected_used = capacity - free + required
        projected_pct = round(projected_used / capacity * 100, 2) if capacity else 100.0
        capacity_ok = required <= free and projected_pct <= config.max_usage_pct
        checks.append(
            _check(
                "capacity",
                capacity_ok,
                (
                    f"{count} clone(s) project datastore usage to {projected_pct:.2f}% "
                    f"(limit {config.max_usage_pct:.2f}%)."
                ),
            )
        )
    except Exception as exc:  # noqa: BLE001 - return a structured failed check
        if not any(check.key == "datastore" for check in checks):
            checks.append(
                _check("datastore", False, f"Could not inspect datastore: {exc}")
            )
        checks.append(
            _check("capacity", False, f"Could not verify clone capacity: {exc}")
        )

    facts = {
        "base": config.base,
        "datastore": config.datastore,
        "esxiInstanceUuid": esxi_instance_uuid,
        "baseMoid": base_moid,
        "baseChangeVersion": change_version,
        "expectedGuestOs": config.expected_guest_os,
        "actualGuestOs": actual_guest_os,
        "cloneCount": count,
        "requestedVmNames": names,
        "capacityBytes": capacity,
        "freeBytes": free,
        "baseVmdkBytes": vmdk_size,
        "requiredBytes": required,
        "projectedUsagePct": projected_pct,
        "maxUsagePct": config.max_usage_pct,
        "checks": [check.model_dump(mode="json") for check in checks],
    }
    return GoldenImagePreflight(
        ready=all(check.ok for check in checks),
        checkedAt=now_ms(),
        snapshotId=_snapshot_id(facts),
        **facts,
    )
