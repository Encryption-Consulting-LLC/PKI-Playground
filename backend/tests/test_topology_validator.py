"""Semantic topology validation is independent of canvas/staging order."""

import pytest

from app.core.topology import (
    DnsRecordKind,
    DnsRecordResource,
    TopologyDocument,
    TopologyEdge,
    TopologyEdgeKind,
    TopologyNode,
    TopologyPortKind,
    TopologyResourceState,
    TopologyRole,
    TopologyValidationError,
    validate_topology,
)


def _full_topology() -> TopologyDocument:
    return TopologyDocument(
        nodes=[
            TopologyNode(id="dc", name="DC01", role=TopologyRole.domain_controller),
            TopologyNode(id="root", name="CA01", role=TopologyRole.root_ca),
            TopologyNode(id="issuing", name="CA02", role=TopologyRole.issuing_ca),
            TopologyNode(
                id="web",
                name="SRV1",
                role=TopologyRole.web_server,
                config={"enableOcsp": "Enabled"},
            ),
        ],
        edges=[
            TopologyEdge(
                id="parent",
                kind=TopologyEdgeKind.ca_parent,
                source="root",
                target="issuing",
            ),
            TopologyEdge(
                id="issuing-domain",
                kind=TopologyEdgeKind.domain_membership,
                source="issuing",
                target="dc",
            ),
            TopologyEdge(
                id="web-domain",
                kind=TopologyEdgeKind.domain_membership,
                source="web",
                target="dc",
            ),
            TopologyEdge(
                id="publication",
                kind=TopologyEdgeKind.ca_publication,
                source="issuing",
                target="web",
            ),
        ],
    )


def _codes(exc: TopologyValidationError) -> set[str]:
    return {item.code for item in exc.diagnostics}


def test_complete_two_tier_topology_is_valid():
    validate_topology(_full_topology())


def test_resources_default_to_planned_for_legacy_clients():
    topology = _full_topology()

    assert all(node.state is TopologyResourceState.planned for node in topology.nodes)
    assert all(edge.state is TopologyResourceState.planned for edge in topology.edges)


def test_legacy_edges_infer_their_capability_ports():
    topology = _full_topology()

    assert topology.edges[0].ports == [TopologyPortKind.ca_parent]
    assert topology.edges[-1].ports == [
        TopologyPortKind.ca_publication,
        TopologyPortKind.web_host,
        TopologyPortKind.probe_certificate,
    ]


def test_connection_rejects_capability_ports_for_another_relationship():
    topology = _full_topology()
    topology.edges[-1].ports = [TopologyPortKind.ca_parent]

    with pytest.raises(TopologyValidationError) as caught:
        validate_topology(topology)

    assert "connection-port-mismatch" in _codes(caught.value)


def test_missing_relationships_are_reported_together():
    topology = _full_topology()
    topology.edges = []

    with pytest.raises(TopologyValidationError) as caught:
        validate_topology(topology)

    assert _codes(caught.value) == {
        "missing-ca-parent",
        "issuing-ca-outside-domain",
        "missing-publication-host",
        "ocsp-template-grant-missing",
    }


def test_ocsp_host_without_an_issuing_ca_grant_is_actionable():
    topology = _full_topology()
    topology.edges = [edge for edge in topology.edges if edge.id != "publication"]

    with pytest.raises(TopologyValidationError) as caught:
        validate_topology(topology)

    diagnostic = next(
        item
        for item in caught.value.diagnostics
        if item.code == "ocsp-template-grant-missing"
    )
    assert diagnostic.message == (
        "SRV1 has OCSP enabled, but no issuing CA grants its enrollment templates."
    )


def test_root_domain_membership_is_rejected():
    topology = _full_topology()
    topology.edges.append(
        TopologyEdge(
            id="root-domain",
            kind=TopologyEdgeKind.domain_membership,
            source="root",
            target="dc",
        )
    )

    with pytest.raises(TopologyValidationError) as caught:
        validate_topology(topology)

    assert "invalid-domain-member" in _codes(caught.value)


def test_ca_cycle_diagnostic_names_the_closed_path():
    topology = _full_topology()
    topology.edges = [edge for edge in topology.edges if edge.id != "parent"]
    topology.nodes.append(
        TopologyNode(id="issuing2", name="CA03", role=TopologyRole.issuing_ca)
    )
    topology.edges.extend(
        [
            TopologyEdge(
                id="cycle-a",
                kind=TopologyEdgeKind.ca_parent,
                source="issuing",
                target="issuing2",
            ),
            TopologyEdge(
                id="cycle-b",
                kind=TopologyEdgeKind.ca_parent,
                source="issuing2",
                target="issuing",
            ),
        ]
    )

    with pytest.raises(TopologyValidationError) as caught:
        validate_topology(topology)

    cycle = next(item for item in caught.value.diagnostics if item.code == "ca-cycle")
    assert cycle.node_ids[0] == cycle.node_ids[-1]
    assert "CA02 -> CA03 -> CA02" in cycle.message


def test_cname_requires_an_authoritative_a_resource_for_its_target():
    topology = _full_topology()
    topology.dns_records = [
        DnsRecordResource(
            id="pki-cname",
            kind=DnsRecordKind.cname,
            server="dc",
            subject="web",
            zone="encon.pki",
            name="pki",
        )
    ]

    with pytest.raises(TopologyValidationError) as caught:
        validate_topology(topology)

    diagnostic = next(
        item
        for item in caught.value.diagnostics
        if item.code == "dns-cname-target-missing-a"
    )
    assert diagnostic.message == (
        "PKI CNAME 'pki.encon.pki' is planned, but its target SRV1 "
        "has no authoritative A record."
    )


def test_invalid_reverse_zone_and_duplicate_record_are_reported():
    topology = _full_topology()
    topology.dns_records = [
        DnsRecordResource(
            id="ptr-one",
            kind=DnsRecordKind.ptr,
            server="dc",
            subject="web",
            zone="encon.pki",
        ),
        DnsRecordResource(
            id="ptr-two",
            kind=DnsRecordKind.ptr,
            server="dc",
            subject="web",
            zone="encon.pki",
        ),
    ]

    with pytest.raises(TopologyValidationError) as caught:
        validate_topology(topology)

    assert _codes(caught.value) >= {"dns-invalid-reverse-zone", "dns-record-conflict"}


def test_non_numeric_reverse_zone_is_rejected():
    topology = _full_topology()
    topology.dns_records = [
        DnsRecordResource(
            id="ptr-web",
            kind=DnsRecordKind.ptr,
            server="dc",
            subject="web",
            zone="foo.in-addr.arpa",
        )
    ]

    with pytest.raises(TopologyValidationError) as caught:
        validate_topology(topology)

    assert "dns-invalid-reverse-zone" in _codes(caught.value)
