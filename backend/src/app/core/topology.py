"""Versioned semantic topology models and validation for deploy plans.

The canvas graph is a presentation document.  This module is the backend's
small, stable contract for the infrastructure it represents: role-bearing
nodes and capability relationships.  Executable operations are compiled from
this final document elsewhere; validation therefore does not depend on the
order in which the user happened to stage those operations.
"""

from collections import defaultdict
from dataclasses import dataclass
from enum import Enum
from typing import Any, Literal, Protocol, Sequence

from pydantic import BaseModel, ConfigDict, Field


class TopologyRole(str, Enum):
    domain_controller = "domainController"
    root_ca = "rootCa"
    issuing_ca = "issuingCa"
    web_server = "webServer"
    client = "client"
    standalone = "standalone"


class TopologyEdgeKind(str, Enum):
    domain_membership = "domainMembership"
    ca_parent = "caParent"
    ca_publication = "caPublication"


class TopologyNode(BaseModel):
    id: str = Field(min_length=1, max_length=200)
    name: str = Field(min_length=1, max_length=120)
    role: TopologyRole
    config: dict[str, str] = Field(default_factory=dict)


class TopologyEdge(BaseModel):
    id: str = Field(min_length=1, max_length=500)
    kind: TopologyEdgeKind
    source: str = Field(min_length=1, max_length=200)
    target: str = Field(min_length=1, max_length=200)


class TopologyDocument(BaseModel):
    """Backend-owned topology contract; version changes are explicit."""

    model_config = ConfigDict(populate_by_name=True)

    version: Literal[1] = 1
    nodes: list[TopologyNode] = Field(min_length=1, max_length=200)
    edges: list[TopologyEdge] = Field(default_factory=list, max_length=500)


class TopologyDiagnostic(BaseModel):
    model_config = ConfigDict(populate_by_name=True)

    code: str
    message: str
    node_ids: list[str] = Field(default_factory=list, alias="nodeIds")
    edge_ids: list[str] = Field(default_factory=list, alias="edgeIds")


class TopologyValidationError(ValueError):
    """Raised with every semantic error so a preview can render them at once."""

    def __init__(self, diagnostics: list[TopologyDiagnostic]):
        self.diagnostics = diagnostics
        super().__init__("; ".join(item.message for item in diagnostics))


class CompilableOp(Protocol):
    """The small PlanOp surface used here, avoiding a core -> router import."""

    id: str
    kind: Any
    target: str
    secondary: str | None
    params: dict[str, str]
    depends_on: list[str]

    def model_copy(self, *, deep: bool = False) -> Any: ...


@dataclass(frozen=True)
class CompiledPlan:
    operations: list[Any]
    critical_path: list[str]
    estimated_duration_seconds: int
    critical_path_duration_seconds: int


class PlanCompilationError(ValueError):
    def __init__(self, diagnostics: list[TopologyDiagnostic]):
        self.diagnostics = diagnostics
        super().__init__("; ".join(item.message for item in diagnostics))


_DURATION_SECONDS = {
    "createVm": 900,
    "domainLeave": 600,
    "domainJoin": 1200,
    "caConnect": 2700,
    "webServerCert": 1800,
}

_CREATE_DURATION_SECONDS = {
    TopologyRole.domain_controller: 2400,
    TopologyRole.root_ca: 1800,
    TopologyRole.issuing_ca: 900,
    TopologyRole.web_server: 900,
    TopologyRole.client: 900,
    TopologyRole.standalone: 900,
}

_KIND_RANK = {
    "createVm": 0,
    "domainLeave": 1,
    "domainJoin": 2,
    "caConnect": 3,
    "webServerCert": 4,
}

_ROLE_RANK = {
    TopologyRole.domain_controller: 0,
    TopologyRole.root_ca: 1,
    TopologyRole.issuing_ca: 2,
    TopologyRole.web_server: 3,
    TopologyRole.client: 4,
    TopologyRole.standalone: 5,
}


def _cycle_path(adjacency: dict[str, list[str]]) -> list[str] | None:
    """Return one closed DFS cycle path, including the repeated first node."""

    visiting: set[str] = set()
    visited: set[str] = set()
    stack: list[str] = []

    def visit(node_id: str) -> list[str] | None:
        visiting.add(node_id)
        stack.append(node_id)
        for child in adjacency.get(node_id, []):
            if child in visiting:
                start = stack.index(child)
                return [*stack[start:], child]
            if child not in visited:
                found = visit(child)
                if found:
                    return found
        stack.pop()
        visiting.remove(node_id)
        visited.add(node_id)
        return None

    for node_id in adjacency:
        if node_id not in visited:
            found = visit(node_id)
            if found:
                return found
    return None


def validate_topology(topology: TopologyDocument) -> None:
    """Validate graph integrity and the two-tier PKI service relationships.

    The result is deliberately aggregate: a compiler preview should show all
    missing relationships in one pass instead of forcing a fix/retry loop.
    """

    diagnostics: list[TopologyDiagnostic] = []
    nodes: dict[str, TopologyNode] = {}
    for node in topology.nodes:
        if node.id in nodes:
            diagnostics.append(
                TopologyDiagnostic(
                    code="duplicate-node",
                    message=f"Topology contains duplicate node id '{node.id}'.",
                    node_ids=[node.id],
                )
            )
        else:
            nodes[node.id] = node

    edge_ids: set[str] = set()
    edge_keys: set[tuple[TopologyEdgeKind, str, str]] = set()
    valid_edges: list[TopologyEdge] = []
    for edge in topology.edges:
        if edge.id in edge_ids:
            diagnostics.append(
                TopologyDiagnostic(
                    code="duplicate-edge",
                    message=f"Topology contains duplicate edge id '{edge.id}'.",
                    edge_ids=[edge.id],
                )
            )
        edge_ids.add(edge.id)
        key = (edge.kind, edge.source, edge.target)
        if key in edge_keys:
            diagnostics.append(
                TopologyDiagnostic(
                    code="duplicate-relationship",
                    message=(
                        f"Relationship '{edge.kind.value}' from '{edge.source}' to "
                        f"'{edge.target}' is duplicated."
                    ),
                    node_ids=[edge.source, edge.target],
                    edge_ids=[edge.id],
                )
            )
        edge_keys.add(key)
        missing = [node_id for node_id in (edge.source, edge.target) if node_id not in nodes]
        if missing:
            diagnostics.append(
                TopologyDiagnostic(
                    code="unknown-node",
                    message=f"Relationship '{edge.id}' references unknown node(s): {missing}.",
                    node_ids=missing,
                    edge_ids=[edge.id],
                )
            )
            continue
        if edge.source == edge.target:
            diagnostics.append(
                TopologyDiagnostic(
                    code="self-relationship",
                    message=f"Node '{nodes[edge.source].name}' cannot relate to itself.",
                    node_ids=[edge.source],
                    edge_ids=[edge.id],
                )
            )
            continue
        valid_edges.append(edge)

    memberships: dict[str, list[TopologyEdge]] = defaultdict(list)
    parents: dict[str, list[TopologyEdge]] = defaultdict(list)
    publications: dict[str, list[TopologyEdge]] = defaultdict(list)
    ca_adjacency: dict[str, list[str]] = defaultdict(list)

    for edge in valid_edges:
        source = nodes[edge.source]
        target = nodes[edge.target]
        if edge.kind is TopologyEdgeKind.domain_membership:
            memberships[edge.source].append(edge)
            if target.role is not TopologyRole.domain_controller:
                diagnostics.append(
                    TopologyDiagnostic(
                        code="invalid-domain-target",
                        message=(
                            f"{source.name} joins {target.name}, but a domain membership "
                            "must target a domain controller."
                        ),
                        node_ids=[source.id, target.id],
                        edge_ids=[edge.id],
                    )
                )
            if source.role in (TopologyRole.domain_controller, TopologyRole.root_ca):
                diagnostics.append(
                    TopologyDiagnostic(
                        code="invalid-domain-member",
                        message=f"{source.name} ({source.role.value}) must not be domain joined.",
                        node_ids=[source.id],
                        edge_ids=[edge.id],
                    )
                )
        elif edge.kind is TopologyEdgeKind.ca_parent:
            parents[edge.target].append(edge)
            ca_adjacency[edge.source].append(edge.target)
            if target.role is not TopologyRole.issuing_ca:
                diagnostics.append(
                    TopologyDiagnostic(
                        code="invalid-ca-child",
                        message=f"{target.name} is not an issuing CA and cannot have a CA parent.",
                        node_ids=[target.id],
                        edge_ids=[edge.id],
                    )
                )
            if source.role not in (TopologyRole.root_ca, TopologyRole.issuing_ca):
                diagnostics.append(
                    TopologyDiagnostic(
                        code="invalid-ca-parent",
                        message=f"{source.name} is not a CA and cannot issue a CA certificate.",
                        node_ids=[source.id],
                        edge_ids=[edge.id],
                    )
                )
        elif edge.kind is TopologyEdgeKind.ca_publication:
            publications[edge.source].append(edge)
            if source.role is not TopologyRole.issuing_ca or target.role is not TopologyRole.web_server:
                diagnostics.append(
                    TopologyDiagnostic(
                        code="invalid-ca-publication",
                        message=(
                            "CA publication must connect an issuing CA to a web server; "
                            f"got {source.name} -> {target.name}."
                        ),
                        node_ids=[source.id, target.id],
                        edge_ids=[edge.id],
                    )
                )

    for node_id, edges in memberships.items():
        if len(edges) > 1:
            diagnostics.append(
                TopologyDiagnostic(
                    code="multiple-domains",
                    message=f"{nodes[node_id].name} belongs to more than one AD domain.",
                    node_ids=[node_id, *[edge.target for edge in edges]],
                    edge_ids=[edge.id for edge in edges],
                )
            )
    for node_id, edges in parents.items():
        if len(edges) > 1:
            diagnostics.append(
                TopologyDiagnostic(
                    code="multiple-ca-parents",
                    message=f"{nodes[node_id].name} has more than one CA parent.",
                    node_ids=[node_id, *[edge.source for edge in edges]],
                    edge_ids=[edge.id for edge in edges],
                )
            )

    cycle = _cycle_path(ca_adjacency)
    if cycle:
        diagnostics.append(
            TopologyDiagnostic(
                code="ca-cycle",
                message="CA hierarchy cycle: " + " -> ".join(nodes[node_id].name for node_id in cycle),
                node_ids=cycle,
            )
        )

    for issuing in (node for node in nodes.values() if node.role is TopologyRole.issuing_ca):
        issuing_parents = parents.get(issuing.id, [])
        if not issuing_parents:
            diagnostics.append(
                TopologyDiagnostic(
                    code="missing-ca-parent",
                    message=f"{issuing.name} has no root CA parent.",
                    node_ids=[issuing.id],
                )
            )
        elif nodes[issuing_parents[0].source].role is not TopologyRole.root_ca:
            parent = nodes[issuing_parents[0].source]
            diagnostics.append(
                TopologyDiagnostic(
                    code="non-root-ca-parent",
                    message=f"{issuing.name}'s parent {parent.name} is not an offline root CA.",
                    node_ids=[issuing.id, parent.id],
                    edge_ids=[issuing_parents[0].id],
                )
            )

        issuing_memberships = memberships.get(issuing.id, [])
        if not issuing_memberships:
            diagnostics.append(
                TopologyDiagnostic(
                    code="issuing-ca-outside-domain",
                    message=f"{issuing.name} has a parent but is not inside an AD domain.",
                    node_ids=[issuing.id],
                )
            )

        issuing_publications = publications.get(issuing.id, [])
        if not issuing_publications:
            diagnostics.append(
                TopologyDiagnostic(
                    code="missing-publication-host",
                    message=f"{issuing.name} publishes HTTP CDP/AIA, but no web host is connected.",
                    node_ids=[issuing.id],
                )
            )

        for publication in issuing_publications:
            web = nodes[publication.target]
            web_memberships = memberships.get(web.id, [])
            if not web_memberships:
                diagnostics.append(
                    TopologyDiagnostic(
                        code="publication-host-outside-domain",
                        message=(
                            f"{web.name} hosts CDP/AIA and OCSP for {issuing.name}, but is not "
                            "inside an AD domain."
                        ),
                        node_ids=[issuing.id, web.id],
                        edge_ids=[publication.id],
                    )
                )
            elif issuing_memberships and web_memberships[0].target != issuing_memberships[0].target:
                diagnostics.append(
                    TopologyDiagnostic(
                        code="publication-domain-mismatch",
                        message=f"{issuing.name} and publication host {web.name} are in different domains.",
                        node_ids=[issuing.id, web.id],
                        edge_ids=[publication.id, issuing_memberships[0].id, web_memberships[0].id],
                    )
                )
            if web.config.get("enableOcsp") == "Disabled":
                diagnostics.append(
                    TopologyDiagnostic(
                        code="ocsp-disabled",
                        message=f"{web.name} is the publication host, but Online Responder is disabled.",
                        node_ids=[web.id],
                        edge_ids=[publication.id],
                    )
                )

    for client in (node for node in nodes.values() if node.role is TopologyRole.client):
        if not memberships.get(client.id):
            diagnostics.append(
                TopologyDiagnostic(
                    code="client-outside-domain",
                    message=f"{client.name} cannot enroll because it is not inside an AD domain.",
                    node_ids=[client.id],
                )
            )

    if diagnostics:
        raise TopologyValidationError(diagnostics)


def _kind_value(op: CompilableOp) -> str:
    return str(getattr(op.kind, "value", op.kind))


def _operation_cycle(
    dependencies: dict[str, set[str]], labels: dict[str, str]
) -> TopologyDiagnostic | None:
    """Return a concrete dependency-cycle diagnostic, if the DAG cannot drain."""

    adjacency: dict[str, list[str]] = defaultdict(list)
    for op_id, required in dependencies.items():
        for dependency in required:
            adjacency[dependency].append(op_id)
        adjacency.setdefault(op_id, [])
    cycle = _cycle_path(adjacency)
    if not cycle:
        return None
    return TopologyDiagnostic(
        code="operation-cycle",
        message="Operation dependency cycle: " + " -> ".join(labels[item] for item in cycle),
        node_ids=cycle,
    )


def _semantic_key(op: CompilableOp, nodes: dict[str, TopologyNode]) -> tuple:
    kind = _kind_value(op)
    node = nodes[op.target]
    role_rank = _ROLE_RANK[node.role]
    # Joins are most useful in role order too: issuing CA, publication host,
    # then optional enrollment clients.
    return (_KIND_RANK[kind], role_rank, node.name.casefold(), op.target, op.id)


def _canonical_order(
    operations: Sequence[CompilableOp],
    dependencies: dict[str, set[str]],
    nodes: dict[str, TopologyNode],
) -> list[str]:
    """Stable Kahn order with an explicit semantic tie-breaker."""

    by_id = {op.id: op for op in operations}
    dependents: dict[str, list[str]] = defaultdict(list)
    indegree = {op.id: len(dependencies[op.id]) for op in operations}
    for op_id, required in dependencies.items():
        for dependency in required:
            dependents[dependency].append(op_id)

    ready = sorted(
        (op_id for op_id, degree in indegree.items() if degree == 0),
        key=lambda op_id: _semantic_key(by_id[op_id], nodes),
    )
    ordered: list[str] = []
    while ready:
        op_id = ready.pop(0)
        ordered.append(op_id)
        for dependent in dependents[op_id]:
            indegree[dependent] -= 1
            if indegree[dependent] == 0:
                ready.append(dependent)
                ready.sort(key=lambda item: _semantic_key(by_id[item], nodes))

    if len(ordered) != len(operations):
        labels = {
            op.id: f"{_kind_value(op)}({nodes[op.target].name})" for op in operations
        }
        diagnostic = _operation_cycle(dependencies, labels)
        raise PlanCompilationError(
            [
                diagnostic
                or TopologyDiagnostic(
                    code="operation-cycle",
                    message="Operation dependency graph contains a cycle.",
                )
            ]
        )
    return ordered


def _duration(op: CompilableOp, nodes: dict[str, TopologyNode]) -> int:
    if _kind_value(op) == "createVm":
        return _CREATE_DURATION_SECONDS[nodes[op.target].role]
    return _DURATION_SECONDS[_kind_value(op)]


def _critical_path(
    ordered: Sequence[str],
    by_id: dict[str, CompilableOp],
    dependencies: dict[str, set[str]],
    nodes: dict[str, TopologyNode],
) -> tuple[list[str], int]:
    totals: dict[str, int] = {}
    previous: dict[str, str | None] = {}
    order_index = {op_id: index for index, op_id in enumerate(ordered)}
    for op_id in ordered:
        required = dependencies[op_id]
        predecessor = (
            max(required, key=lambda item: (totals[item], -order_index[item]))
            if required
            else None
        )
        totals[op_id] = (totals[predecessor] if predecessor else 0) + _duration(
            by_id[op_id], nodes
        )
        previous[op_id] = predecessor
    end = max(ordered, key=lambda item: totals[item])
    path: list[str] = []
    current: str | None = end
    while current is not None:
        path.append(current)
        current = previous[current]
    path.reverse()
    return path, totals[end]


def compile_plan(
    topology: TopologyDocument, operations: Sequence[CompilableOp]
) -> CompiledPlan:
    """Compile final topology plus desired operations into an authoritative DAG.

    Caller-supplied ``dependsOn`` is never consulted.  IDs and operation
    payloads are copied unchanged, then only dependencies and list order are
    replaced.  This keeps resume/metrics identities stable across previews,
    persisted-project reloads, and retries where completed creates are absent.
    """

    validate_topology(topology)
    nodes = {node.id: node for node in topology.nodes}
    diagnostics: list[TopologyDiagnostic] = []
    seen_ids: set[str] = set()
    semantic_ops: dict[tuple[str, str, str | None], CompilableOp] = {}

    def error(code: str, message: str, *node_ids: str) -> None:
        diagnostics.append(
            TopologyDiagnostic(code=code, message=message, node_ids=list(node_ids))
        )

    edge_keys = {(edge.kind, edge.source, edge.target) for edge in topology.edges}
    for op in operations:
        kind = _kind_value(op)
        if op.id in seen_ids:
            error("duplicate-operation-id", f"Plan contains duplicate operation id '{op.id}'.")
        seen_ids.add(op.id)
        if kind not in _KIND_RANK:
            error("unknown-operation-kind", f"Operation '{op.id}' has unknown kind '{kind}'.")
            continue
        if op.target not in nodes:
            error(
                "operation-unknown-target",
                f"Operation '{op.id}' targets unknown node '{op.target}'.",
                op.target,
            )
            continue
        if op.secondary and op.secondary not in nodes:
            error(
                "operation-unknown-secondary",
                f"Operation '{op.id}' references unknown node '{op.secondary}'.",
                op.secondary,
            )
            continue
        key = (kind, op.target, op.secondary)
        if key in semantic_ops:
            error(
                "duplicate-operation",
                f"Operations '{semantic_ops[key].id}' and '{op.id}' describe the same action.",
                op.target,
            )
        else:
            semantic_ops[key] = op

        if kind == "createVm":
            template = op.params.get("template")
            expected = {
                TopologyRole.domain_controller: ("domainController", None),
                TopologyRole.root_ca: ("certificateAuthority", "Root"),
                TopologyRole.issuing_ca: ("certificateAuthority", "Issuing"),
                TopologyRole.web_server: ("webServer", None),
                TopologyRole.client: ("client", None),
                TopologyRole.standalone: ("standalone", None),
            }[nodes[op.target].role]
            if template != expected[0] or (expected[1] and op.params.get("caType") != expected[1]):
                error(
                    "operation-role-mismatch",
                    f"createVm for {nodes[op.target].name} does not match role {nodes[op.target].role.value}.",
                    op.target,
                )
        elif kind == "domainJoin":
            if not op.secondary or (
                TopologyEdgeKind.domain_membership,
                op.target,
                op.secondary,
            ) not in edge_keys:
                error(
                    "operation-relationship-mismatch",
                    f"domainJoin for {nodes[op.target].name} is not present in the final topology.",
                    op.target,
                    *([op.secondary] if op.secondary else []),
                )
        elif kind == "caConnect":
            if not op.secondary or (
                TopologyEdgeKind.ca_parent,
                op.secondary,
                op.target,
            ) not in edge_keys:
                error(
                    "operation-relationship-mismatch",
                    f"caConnect for {nodes[op.target].name} is not present in the final topology.",
                    op.target,
                    *([op.secondary] if op.secondary else []),
                )
        elif kind == "webServerCert":
            if not op.secondary or (
                TopologyEdgeKind.ca_publication,
                op.target,
                op.secondary,
            ) not in edge_keys:
                error(
                    "operation-relationship-mismatch",
                    f"webServerCert for {nodes[op.target].name} is not present in the final topology.",
                    op.target,
                    *([op.secondary] if op.secondary else []),
                )

    if diagnostics:
        raise PlanCompilationError(diagnostics)

    cloned = [op.model_copy(deep=True) for op in operations]
    by_id = {op.id: op for op in cloned}
    creates = {op.target: op.id for op in cloned if _kind_value(op) == "createVm"}
    leaves = {op.target: op.id for op in cloned if _kind_value(op) == "domainLeave"}
    joins = {
        (op.target, op.secondary): op.id
        for op in cloned
        if _kind_value(op) == "domainJoin"
    }
    ca_connects = {
        (op.target, op.secondary): op.id
        for op in cloned
        if _kind_value(op) == "caConnect"
    }
    dependencies: dict[str, set[str]] = {op.id: set() for op in cloned}

    membership_by_member = {
        edge.source: edge.target
        for edge in topology.edges
        if edge.kind is TopologyEdgeKind.domain_membership
    }
    parent_by_ca = {
        edge.target: edge.source
        for edge in topology.edges
        if edge.kind is TopologyEdgeKind.ca_parent
    }
    publications_by_ca: dict[str, list[str]] = defaultdict(list)
    for edge in topology.edges:
        if edge.kind is TopologyEdgeKind.ca_publication:
            publications_by_ca[edge.source].append(edge.target)

    def require(op_id: str, candidate: str | None) -> None:
        if candidate is not None and candidate != op_id:
            dependencies[op_id].add(candidate)

    for op in cloned:
        kind = _kind_value(op)
        if kind == "createVm":
            continue
        require(op.id, creates.get(op.target))
        if op.secondary:
            require(op.id, creates.get(op.secondary))
        if kind == "domainJoin":
            require(op.id, leaves.get(op.target))
            if nodes[op.target].role is TopologyRole.client:
                dc_id = op.secondary
                for issuing_id, issuing_dc in membership_by_member.items():
                    if issuing_dc == dc_id and nodes[issuing_id].role is TopologyRole.issuing_ca:
                        root_id = parent_by_ca.get(issuing_id)
                        require(op.id, ca_connects.get((issuing_id, root_id)))
        elif kind == "caConnect":
            issuing_id = op.target
            dc_id = membership_by_member[issuing_id]
            require(op.id, creates.get(dc_id))
            require(op.id, joins.get((issuing_id, dc_id)))
            for web_id in publications_by_ca[issuing_id]:
                web_dc_id = membership_by_member[web_id]
                require(op.id, creates.get(web_id))
                require(op.id, creates.get(web_dc_id))
                require(op.id, joins.get((web_id, web_dc_id)))
        elif kind == "webServerCert":
            issuing_id = op.target
            web_id = op.secondary
            root_id = parent_by_ca[issuing_id]
            issuing_dc_id = membership_by_member[issuing_id]
            web_dc_id = membership_by_member[web_id]
            require(op.id, creates.get(root_id))
            require(op.id, creates.get(issuing_dc_id))
            require(op.id, creates.get(web_dc_id))
            require(op.id, joins.get((issuing_id, issuing_dc_id)))
            require(op.id, joins.get((web_id, web_dc_id)))
            require(op.id, ca_connects.get((issuing_id, root_id)))

    ordered_ids = _canonical_order(cloned, dependencies, nodes)
    ordered = [by_id[op_id] for op_id in ordered_ids]
    for op in ordered:
        op.depends_on = sorted(
            dependencies[op.id], key=lambda item: ordered_ids.index(item)
        )
    critical_path, critical_duration = _critical_path(
        ordered_ids, by_id, dependencies, nodes
    )
    return CompiledPlan(
        operations=ordered,
        critical_path=critical_path,
        estimated_duration_seconds=sum(_duration(op, nodes) for op in ordered),
        critical_path_duration_seconds=critical_duration,
    )
