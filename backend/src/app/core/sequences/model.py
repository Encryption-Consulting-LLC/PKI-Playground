"""Declarative step model for reboot-spanning provisioning sequences.

A plan op (``createVm``, ``domainJoin``, ``caConnect``, …) expands backend-side
into an ordered list of :class:`Step`\\ s. Each step is one agent command
dispatched at a resolved *target* node, optionally followed by a reboot wait
and a verify probe. Steps are pure data — no I/O — so the sequence library is
unit-testable and the engine (:mod:`app.core.sequences.engine`) owns every
side effect.

Cross-node resolution: a step names its target by a **context key** (usually a
canvas node id, but role aliases like ``"root"`` / ``"dc"`` are just keys the
op expansion populates in :class:`RunContext.nodes`). Params are either a
static mapping or a callable resolved against the live context at run time, so
a step on CA02 can reference DC01's real guest-namespaced hostname.
"""

from collections.abc import Callable, Mapping
from dataclasses import dataclass, field
from typing import Any


@dataclass(frozen=True)
class NodeContext:
    """Everything a step needs to know about one node in the plan."""

    node_id: str
    vm_name: str
    hostname: str
    agent_vm_id: str | None = None
    ip: str | None = None
    template_id: str | None = None
    template_config: Mapping[str, str] = field(default_factory=dict)


@dataclass(frozen=True)
class DnsRecordContext:
    """One symbolic topology DNS resource available to sequence resolvers."""

    id: str
    kind: str
    server: str
    subject: str
    zone: str
    name: str | None = None


@dataclass
class RunContext:
    """Cross-VM state threaded through a sequence: the resolved nodes, the
    shared domain facts, and the artifact relay map (key → base64 payload).

    ``artifacts`` doubles as the persisted relay store — a step's ``produces``
    lifts ``result.contentB64`` into it, and a later step's ``consumes`` reads
    it back as a param, which is the cross-sign sneakernet path.
    """

    nodes: dict[str, NodeContext]
    domain_name: str | None = None
    netbios: str | None = None
    pki_host: str | None = None
    dns_records: tuple[DnsRecordContext, ...] = ()
    artifacts: dict[str, str] = field(default_factory=dict)

    def node(self, key: str) -> NodeContext:
        try:
            return self.nodes[key]
        except KeyError as exc:
            raise KeyError(f"sequence references unknown node '{key}'") from exc


# A param resolver runs at dispatch time with the full context + the resolved
# target node, returning the flat str→str param map for the command.
ParamResolver = Callable[["StepRuntime"], dict[str, str]]


@dataclass(frozen=True)
class StepRuntime:
    """What a :class:`Step`'s param resolver (and verify predicate) sees."""

    ctx: RunContext
    node: NodeContext


# A verify predicate inspects a probe command's result dict and decides whether
# the target has reached the desired state yet (True = ready, stop retrying).
VerifyPredicate = Callable[[dict[str, Any]], bool]

# A local aggregate consumes the results of earlier steps without dispatching
# another agent command.  This is how a final health gate can combine facts
# gathered from several VMs while keeping each remote probe single-purpose.
ResultAggregator = Callable[
    ["StepRuntime", Mapping[str, dict[str, Any]]], dict[str, Any]
]


@dataclass(frozen=True)
class Step:
    """One agent command in a sequence.

    ``target`` is a context key (see module docstring). ``expects_disconnect``
    marks a reboot step whose success looks like a dropped socket — the engine
    then waits for the agent to phone home again before continuing. ``verify``
    is a read-only probe re-dispatched with backoff (inside ``verify_window_s``)
    until ``verify_predicate`` accepts its result.
    """

    id: str
    command: str
    target: str
    params: ParamResolver | Mapping[str, str] = field(default_factory=dict)
    #: Reboot step — the engine waits for reconnect after dispatching it.
    expects_disconnect: bool = False
    #: Read-only readiness probe run after this step (with retry backoff).
    verify: "Step | None" = None
    verify_predicate: VerifyPredicate | None = None
    verify_window_s: int = 600
    #: Backend-local result aggregator. When present, ``command`` is the
    #: display/metric label only and no agent dispatch occurs.
    aggregate: ResultAggregator | None = None
    #: Artifact keys: ``produces`` lifts ``result.contentB64`` into the relay
    #: map; ``consumes`` injects one relay payload as the ``contentB64`` param.
    produces: tuple[str, ...] = ()
    consumes: tuple[str, ...] = ()
    #: Param keys to redact from every progress/error frame (passwords, blobs).
    secret_keys: tuple[str, ...] = ()
    timeout_s: int = 300

    def resolve_params(self, ctx: RunContext) -> dict[str, str]:
        node = ctx.node(self.target)
        if callable(self.params):
            params = dict(self.params(StepRuntime(ctx=ctx, node=node)))
        else:
            params = dict(self.params)
        # A consuming step pulls its payload from the relay map.
        for key in self.consumes:
            if key in ctx.artifacts:
                params["contentB64"] = ctx.artifacts[key]
        return params
