"""Sequence definitions — the ordered :class:`Step` lists each plan op expands
into (Phase L).

Kept declarative and free of I/O so they read like the lab guide's build order
and stay unit-testable. Slice 9 wires the **createVm provision tails** (what
each freshly-cloned VM does once its agent phones home); the richer multi-node
op sequences (domainJoin / caConnect / webServerCert) are layered on in slices
10–12, which extend this module.

Every param that reaches PowerShell is resolved from the run context here, so a
step can reference another node's real guest-namespaced hostname
(``firstboot.hostname_for``) rather than a display name.
"""

from app.core.sequences.model import RunContext, Step, StepRuntime

#: The context key a single-VM provision sequence targets.
PRIMARY = "primary"


def _ca_verify_step() -> Step:
    """`ca.verify` probe — the CA is ready once `certutil -ping` answers."""
    return Step(id="ca-verify", command="ca.verify", target=PRIMARY)


def _ca_install_params(rt: StepRuntime) -> dict[str, str]:
    """Root-CA install params straight from the node's template config
    (caType/commonName/keyAlgorithm/…). The config was validated + defaulted by
    ``extract_template_config`` and decrypted by the dispatch path."""
    cfg = rt.node.template_config
    return {k: v for k, v in cfg.items() if v not in (None, "")}


def _certificate_authority_provision() -> list[Step]:
    """Root CA (createVm tail). Slice 9 ports the pre-Phase-L behaviour —
    ``ca.install`` under the plan — verified with ``ca.verify``. The issuing
    CA's cross-sign tail is driven by the ``caConnect`` op, not here; the richer
    root tail (settings / CDP-AIA / CRL / relay export) lands in slice 11.
    """
    return [
        Step(
            id="ca-install",
            command="ca.install",
            target=PRIMARY,
            params=_ca_install_params,
            verify=_ca_verify_step(),
            verify_predicate=lambda r: r.get("caType") is not None,
            timeout_s=1800,
        )
    ]


#: createVm provision tails by template id. A template absent here provisions
#: nothing on first boot (its role is driven later by plan ops) — e.g. a domain
#: controller is promoted by its forest tail (slice 11), a member server does
#: its work on domain join (slice 10+).
_PROVISION_SEQUENCES = {
    "certificateAuthority": _certificate_authority_provision,
}


def provision_steps(template: str, *, ca_type: str | None = None) -> list[Step]:
    """The createVm provision tail for ``template`` (empty when there's none).

    ``ca_type`` lets the caller skip provisioning an *issuing* CA on first boot
    — an issuing CA can't stand up until the caConnect handshake, so its
    createVm tail is empty and the work happens in that op (slice 11).
    """
    if template == "certificateAuthority" and ca_type == "Issuing":
        return []
    builder = _PROVISION_SEQUENCES.get(template)
    return builder() if builder else []


def op_sequence(op_kind: str, ctx: RunContext) -> list[Step]:
    """The step list for a non-createVm plan op. Slices 10–12 fill this in
    (domainJoin, caConnect, webServerCert); until then these ops keep running
    the timed simulation stub in ``app.tasks``."""
    return []
