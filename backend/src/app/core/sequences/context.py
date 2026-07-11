"""Cross-node context resolution for plan-op sequences (Phase L).

A non-createVm op (domainJoin / caConnect / webServerCert) touches more than
its own node: a member joins a *DC*, an issuing CA cross-signs with a *root*
and publishes through the *DC* and *web* host. This builds the
:class:`~app.core.sequences.model.RunContext` those sequences resolve their
params against — reading each node's live ``vm_registry`` doc (by ``appName``,
which is the canvas node id) for its real vmName, agent vm_id, IP and stored
(encrypted) template config, then deriving the shared domain facts
(``domainName`` / ``netbios`` / ``pki_host = pki.<domain>``).

Resolving from the registry, not the plan's own ``createVm`` ops, keeps it
correct on a **retry** plan — where the already-``done`` createVm ops have been
dropped from the op list but the VMs (and their registry docs) still exist.

Every hostname a step emits into a URL / CNAME / UNC / ACL is the *other*
node's real guest-namespaced ``firstboot.hostname_for(vmName)`` — never a
display name — so the URLs baked into issued certs actually resolve.

Runs in the Celery worker over a sync Mongo client.
"""

import logging

from app.core.firstboot import hostname_for
from app.core.sequences.model import NodeContext, RunContext
from app.core.template_config import decrypt_config_secrets

logger = logging.getLogger(__name__)

#: Context alias keys the sequence definitions reference.
PRIMARY = "primary"
SECONDARY = "secondary"
DC = "dc"


class ContextError(Exception):
    """A node the op depends on isn't resolvable (missing/deleted registry doc,
    or no live agent) — a dangling reference that can't degrade gracefully."""


def _resolve_node(db, node_id: str) -> NodeContext:
    """Build a :class:`NodeContext` for ``node_id`` from its live registry doc
    (keyed on ``appName``). Raises :class:`ContextError` if it's absent."""
    doc = db["vm_registry"].find_one(
        {"appName": node_id, "status": {"$ne": "deleted"}}
    )
    if doc is None:
        raise ContextError(f"no live VM registered for node '{node_id}'")

    agent = doc.get("agent") or {}
    template = agent.get("templateId")
    # Decrypt the stored (encrypted) template config back to plaintext for
    # dispatch — this is where the DC's domainAdminPassword becomes usable.
    stored_config = agent.get("templateConfig") or {}
    config = decrypt_config_secrets(template, stored_config) if template else {}

    return NodeContext(
        node_id=node_id,
        vm_name=doc["vmName"],
        hostname=hostname_for(doc["vmName"]),
        agent_vm_id=agent.get("vmId"),
        ip=doc.get("ip"),
        template_id=template,
        template_config=config,
    )


def _find_domain_controller(db, sibling_vm_name: str) -> NodeContext | None:
    """The domain controller sharing ``sibling_vm_name``'s guest namespace, if
    one is registered — the source of the domain facts + admin credential for
    ops whose ``secondary`` isn't itself the DC (caConnect, webServerCert)."""
    # guest names are `guest-<slug>-<name>`; the DC shares the `guest-<slug>-`
    # prefix. A non-namespaced (operator) name has no prefix — fall back to any.
    prefix = None
    parts = sibling_vm_name.split("-")
    if len(parts) >= 3 and parts[0] == "guest":
        prefix = f"guest-{parts[1]}-"

    query = {"agent.templateId": "domainController", "status": {"$ne": "deleted"}}
    if prefix is not None:
        query["vmName"] = {"$regex": f"^{prefix}"}
    doc = db["vm_registry"].find_one(query)
    return _resolve_node(db, doc["appName"]) if doc else None


def build_run_context(db, op, all_ops) -> RunContext:
    """Resolve the :class:`RunContext` for a non-createVm ``op``.

    Populates the alias keys the definitions use: ``primary`` (the op's target),
    ``secondary`` (its ``secondary`` node, when set), and ``dc`` (the domain
    controller — the ``secondary`` itself for a join, otherwise the DC found in
    the same guest namespace). Domain facts come from the DC's own config.
    """
    nodes: dict[str, NodeContext] = {PRIMARY: _resolve_node(db, op.target)}

    secondary_ctx = None
    if op.secondary:
        secondary_ctx = _resolve_node(db, op.secondary)
        nodes[SECONDARY] = secondary_ctx

    # The DC is the secondary when the op joins to it directly; otherwise the
    # forest's DC found by namespace.
    if secondary_ctx is not None and secondary_ctx.template_id == "domainController":
        dc_ctx = secondary_ctx
    else:
        dc_ctx = _find_domain_controller(db, nodes[PRIMARY].vm_name)
    if dc_ctx is not None:
        nodes[DC] = dc_ctx

    domain_name = dc_ctx.template_config.get("domainName") if dc_ctx else None
    netbios = dc_ctx.template_config.get("netbiosName") if dc_ctx else None
    pki_host = f"pki.{domain_name}" if domain_name else None
    return RunContext(
        nodes=nodes,
        domain_name=domain_name,
        netbios=netbios,
        pki_host=pki_host,
    )
