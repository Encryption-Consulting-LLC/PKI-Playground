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

Phase E adds ``build_authored_iso``: an operator-authored script set packed
verbatim via isokit's v2 API — the server injects nothing (no hostname/network
render, no role scripts, no pool IP). ``build_firstboot_iso`` (the guest/default
path) deliberately stays on ``build_script_iso`` and its v1 manifest,
byte-identical to Phase G.
"""

import re
import shutil
from dataclasses import dataclass
from pathlib import Path

import configgen
import isokit
from configgen import NetworkConfig

from app.core.ippool import GuestNetwork

#: On-disc name for the embedded agent binary — what the install script and the
#: agent's Windows service expect (see ``assets/firstboot/_agent``).
_AGENT_BINARY_NAME = "pki-orchestrator.exe"
_AGENT_CONFIG_NAME = "orchestrator.toml"
#: Static install step appended (Phase F) when an agent is bundled. Lives under
#: ``_agent`` (leading underscore → not a template dir, never role-globbed).
_AGENT_INSTALL_SCRIPT = Path(__file__).parent.parent / "assets" / "firstboot" / "_agent" / "40-install-orchestrator.ps1"


@dataclass(frozen=True)
class AgentBundle:
    """The pki-orchestrator payload to embed in a firstboot ISO (Phase F).

    ``binary_path`` is the worker-host path to the agent exe;
    ``config_toml`` is the rendered ``orchestrator.toml`` (identity + backend —
    no per-template config; that's dispatched after phone-home).
    """

    binary_path: Path
    config_toml: str

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
    agent: AgentBundle | None = None,
) -> Path:
    """Render + pack the per-VM config ISO into ``dest_dir``; returns its path.

    ``agent=None`` keeps the Phase-G behaviour byte-for-byte (isokit v1
    ``build_script_iso``: hostname + network + role scripts). When an
    ``AgentBundle`` is given (Phase F), the ISO switches to isokit's v2
    ``build_config_iso`` and additionally carries the agent binary + rendered
    ``orchestrator.toml`` as payload files plus a static install step — so the
    booted VM installs and starts the phone-home agent.

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

    scripts = [hostname_script, network_script, *role_scripts_for(template)]
    iso_path = dest_dir / f"{vm_name}-config.iso"

    if agent is None:
        isokit.build_script_iso(scripts, iso_path)
        return iso_path

    # v2 (Phase F): embed the agent binary + config as payload files and append
    # the install step. build_config_iso names disc entries after each path's
    # filename, so the binary is copied to the fixed name the runner expects.
    config_path = dest_dir / _AGENT_CONFIG_NAME
    config_path.write_text(agent.config_toml, encoding="utf-8")
    binary_on_disc = dest_dir / _AGENT_BINARY_NAME
    if agent.binary_path != binary_on_disc:
        shutil.copy(agent.binary_path, binary_on_disc)

    isokit.build_config_iso(
        iso_path,
        scripts=[*scripts, _AGENT_INSTALL_SCRIPT],
        files=[binary_on_disc, config_path],
    )
    return iso_path


def build_authored_iso(
    files: list[tuple[str, str]],
    *,
    vm_name: str,
    dest_dir: Path,
) -> Path:
    """Pack operator-authored ``(name, content)`` scripts — exactly as received,
    in the order received (the frontend sends them name-sorted, matching the
    ``10-/20-/30-`` convention) — into ``dest_dir``; returns the ISO's path.

    The authored set is the complete disc: nothing is rendered or appended
    server-side. Names/sizes were validated in ``routers/deploy.py``; isokit
    ``ValueError``s propagate as op-level failures.
    """
    script_paths: list[Path] = []
    for name, content in files:
        path = dest_dir / name
        path.write_text(content, encoding="utf-8")
        script_paths.append(path)

    iso_path = dest_dir / f"{vm_name}-config.iso"
    isokit.build_config_iso(iso_path, scripts=script_paths)
    return iso_path
