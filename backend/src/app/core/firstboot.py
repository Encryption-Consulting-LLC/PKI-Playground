"""Per-VM firstboot ISO assembly (Phase G).

Every real ``createVm`` boots from a config ISO built here on the Celery
worker: configgen renders the per-VM hostname and static-network scripts
(baking in the pool-allocated IP), the template's fixed role scripts are
picked up from ``assets/firstboot/<templateId>/``, and isokit packs the lot
(with its ``firstboot.manifest``) into ``<vm>-config.iso``. vmkit then uploads
that file to ``[datastore] <vm>/<vm>-config.iso`` and attaches it during the
clone — so the ISO only needs to outlive the ``clone_workflow`` call.

Numbering fixes manifest (execution) order: ``10-`` hostname, ``20-`` network,
``30-`` role. Scripts never reboot — the firstboot runner in the base image
owns the single reboot (established configgen convention).

Deliberately reuses isokit's current firstboot-only packing unmodified; script
*authoring* generalization is Phase E.
"""

import re
from pathlib import Path

import configgen
import isokit
from configgen import NetworkConfig

from app.core.ippool import GuestNetwork

#: Server-side allowlist for the ``template`` param on createVm plan ops —
#: mirrors ``frontend/src/constants/templates.ts``. A template without role
#: scripts (standalone) still gets hostname + network.
TEMPLATE_IDS: frozenset[str] = frozenset(
    {"domainController", "certificateAuthority", "webServer", "client", "standalone"}
)

_ASSETS = Path(__file__).parent.parent / "assets" / "firstboot"

#: All current templates clone the Windows Server base (ws-2025-base).
_PLATFORM = "windows"

_UNSAFE_HOSTNAME_CHARS = re.compile(r"[^A-Za-z0-9-]")


def hostname_for(vm_name: str) -> str:
    """Derive a valid Windows computer name from the (namespaced) VM name:
    safe charset, 15-char NetBIOS limit — keeping the *tail*, since guest
    names share the ``guest-<slug>-`` prefix and differ at the end."""
    safe = _UNSAFE_HOSTNAME_CHARS.sub("-", vm_name).strip("-") or "vm"
    return safe[-15:].strip("-") or "vm"


def role_scripts_for(template: str) -> list[Path]:
    """The template's fixed role scripts, in manifest order."""
    template_dir = _ASSETS / template
    if not template_dir.is_dir():
        return []
    return sorted(template_dir.glob("*.ps1"))


def build_firstboot_iso(
    *,
    template: str,
    vm_name: str,
    ip: str,
    net: GuestNetwork,
    dest_dir: Path,
) -> Path:
    """Render + pack the per-VM config ISO into ``dest_dir``; returns its path.

    Raises ``KeyError`` on an unknown template (routes validate against
    ``TEMPLATE_IDS`` first, so hitting it here is a programming error) and
    lets configgen/isokit ``ValueError``s propagate as op-level failures.
    """
    if template not in TEMPLATE_IDS:
        raise KeyError(f"Unknown template '{template}'.")

    hostname_script = dest_dir / "10-hostname.ps1"
    hostname_script.write_text(
        configgen.render_hostname(_PLATFORM, hostname_for(vm_name)), encoding="utf-8"
    )

    network_script = dest_dir / "20-network.ps1"
    network_script.write_text(
        configgen.render_network(
            _PLATFORM,
            NetworkConfig(
                mode="static",
                ip=ip,
                prefix=net.prefix,
                gateway=net.gateway,
                dns1=net.dns1,
                dns2=net.dns2,
                dns_suffix=net.dns_suffix,
            ),
        ),
        encoding="utf-8",
    )

    iso_path = dest_dir / f"{vm_name}-config.iso"
    isokit.build_script_iso(
        [hostname_script, network_script, *role_scripts_for(template)], iso_path
    )
    return iso_path
