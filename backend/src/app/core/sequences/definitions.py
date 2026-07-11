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

#: Context alias keys (mirror app.core.sequences.context).
PRIMARY = "primary"
SECONDARY = "secondary"
DC = "dc"


def _admin_username(netbios: str | None) -> str:
    return f"{netbios}\\Administrator" if netbios else "Administrator"


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


def _domain_join_sequence(ctx: RunContext) -> list[Step]:
    """Join the target node to the forest (slice 10).

    Point DNS at the DC, ``Add-Computer`` under the operator's domain-admin
    credential (no ``-Restart``), reboot, then verify membership. A web-server
    target additionally gets the CertEnroll *share/ACL* half here (it needs the
    domain's Cert Publishers group, and must exist before the root cert is
    published to it) — the IIS/vdir half runs in the webServerCert op.
    """
    dc = ctx.node(DC)

    def join_params(rt: StepRuntime) -> dict[str, str]:
        return {
            "domainName": ctx.domain_name or "",
            "username": _admin_username(ctx.netbios),
            "password": dc.template_config.get("domainAdminPassword", ""),
        }

    steps = [
        Step(
            id="dns-set",
            command="dns.set_client",
            target=PRIMARY,
            params=lambda rt: {"servers": ctx.node(DC).ip or ""},
        ),
        Step(
            id="domain-join",
            command="domain.join",
            target=PRIMARY,
            params=join_params,
            secret_keys=("password",),
        ),
        # The join reboots (Add-Computer without -Restart, then a reboot step);
        # domain.verify — retried post-reboot until PartOfDomain — is its gate.
        Step(
            id="reboot",
            command="system.reboot",
            target=PRIMARY,
            expects_disconnect=True,
            timeout_s=1200,
            verify=Step(id="domain-verify", command="domain.verify", target=PRIMARY),
            verify_predicate=lambda r: r.get("part_of_domain") is True,
            verify_window_s=600,
        ),
    ]

    if ctx.node(PRIMARY).template_id == "webServer":
        steps.append(
            Step(
                id="iis-share",
                command="iis.setup_certenroll",
                target=PRIMARY,
                params=lambda rt: {
                    "scope": "share",
                    "netbiosName": ctx.netbios or "",
                    "path": rt.node.template_config.get(
                        "certEnrollPath", "C:\\CertEnroll"
                    ),
                },
            )
        )
    return steps


def op_sequence(op_kind: str, ctx: RunContext) -> list[Step]:
    """The step list for a non-createVm plan op. domainJoin is real (slice 10);
    caConnect / webServerCert / domainLeave are layered in by slices 11–12 and
    until then keep running the timed simulation stub in ``app.tasks``."""
    if op_kind == "domainJoin":
        return _domain_join_sequence(ctx)
    return []
