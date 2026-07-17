"""Dependency-aware teardown compiler for topology-owned lab resources."""

from typing import Literal

from pydantic import BaseModel, ConfigDict, Field

from app.core.topology import TopologyDocument, TopologyEdgeKind, TopologyRole


TeardownKind = Literal[
    "web.cleanup",
    "ca.cleanup",
    "domain.leave",
    "dns.cleanup",
    "forest.cleanup",
    "vm.destroy",
]


class TeardownAction(BaseModel):
    model_config = ConfigDict(populate_by_name=True)

    id: str
    kind: TeardownKind
    node_id: str = Field(alias="nodeId")
    role: TopologyRole
    depends_on: list[str] = Field(default_factory=list, alias="dependsOn")


def compile_teardown(topology: TopologyDocument) -> list[TeardownAction]:
    """Compile service cleanup through VM destruction in safe dependency order."""

    nodes = {node.id: node for node in topology.nodes}
    memberships = {
        edge.source: edge.target
        for edge in topology.edges
        if edge.kind is TopologyEdgeKind.domain_membership
    }
    actions: dict[str, TeardownAction] = {}

    def add(kind: TeardownKind, node_id: str, depends: list[str] | None = None) -> str:
        action_id = f"{kind}:{node_id}"
        actions[action_id] = TeardownAction(
            id=action_id,
            kind=kind,
            nodeId=node_id,
            role=nodes[node_id].role,
            dependsOn=depends or [],
        )
        return action_id

    web_cleanups = [
        add("web.cleanup", node.id)
        for node in topology.nodes
        if node.role is TopologyRole.web_server
    ]
    issuing_cleanups = [
        add("ca.cleanup", node.id, web_cleanups)
        for node in topology.nodes
        if node.role is TopologyRole.issuing_ca
    ]
    for node in topology.nodes:
        if node.role is TopologyRole.root_ca:
            add("ca.cleanup", node.id, issuing_cleanups)

    leaves: list[str] = []
    for member_id in memberships:
        prerequisites = []
        role = nodes[member_id].role
        if role is TopologyRole.web_server:
            prerequisites.append(f"web.cleanup:{member_id}")
        if role is TopologyRole.issuing_ca:
            prerequisites.append(f"ca.cleanup:{member_id}")
        leaves.append(add("domain.leave", member_id, prerequisites))

    dc_ids = [
        node.id
        for node in topology.nodes
        if node.role is TopologyRole.domain_controller
    ]
    forest_actions: list[str] = []
    for dc_id in dc_ids:
        dns_cleanup = add("dns.cleanup", dc_id, leaves)
        forest_actions.append(add("forest.cleanup", dc_id, [dns_cleanup]))

    destroy_actions: list[str] = []
    # Workloads first, then issuing CAs, then roots. The DC is always last.
    role_order = (
        TopologyRole.client,
        TopologyRole.standalone,
        TopologyRole.web_server,
        TopologyRole.issuing_ca,
        TopologyRole.root_ca,
    )
    previous_tier: list[str] = []
    for role in role_order:
        tier: list[str] = []
        for node in topology.nodes:
            if node.role is not role:
                continue
            prerequisites = list(previous_tier)
            leave_id = f"domain.leave:{node.id}"
            cleanup_id = (
                f"web.cleanup:{node.id}"
                if role is TopologyRole.web_server
                else f"ca.cleanup:{node.id}"
            )
            if leave_id in actions:
                prerequisites.append(leave_id)
            elif cleanup_id in actions:
                prerequisites.append(cleanup_id)
            tier.append(add("vm.destroy", node.id, prerequisites))
        if tier:
            previous_tier = tier
            destroy_actions.extend(tier)

    for dc_id, forest_id in zip(dc_ids, forest_actions):
        add("vm.destroy", dc_id, [forest_id, *destroy_actions])

    # Stable Kahn walk over the explicit action dependencies.
    ordered: list[TeardownAction] = []
    remaining = dict(actions)
    completed: set[str] = set()
    while remaining:
        ready = sorted(
            action_id
            for action_id, action in remaining.items()
            if set(action.depends_on) <= completed
        )
        if not ready:
            raise ValueError("teardown action graph contains a dependency cycle")
        for action_id in ready:
            ordered.append(remaining.pop(action_id))
            completed.add(action_id)
    return ordered
