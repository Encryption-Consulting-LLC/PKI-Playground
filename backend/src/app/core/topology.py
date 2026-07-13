"""Versioned semantic topology models and validation for deploy plans.

The canvas graph is a presentation document.  This module is the backend's
small, stable contract for the infrastructure it represents: role-bearing
nodes and capability relationships.  Executable operations are compiled from
this final document elsewhere; validation therefore does not depend on the
order in which the user happened to stage those operations.
"""

from collections import defaultdict
from enum import Enum
from typing import Literal

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
