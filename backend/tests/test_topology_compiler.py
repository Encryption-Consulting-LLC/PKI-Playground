"""Authoritative deploy compilation from the final semantic topology."""

import pytest

from app.core.topology import (
    PlanCompilationError,
    TopologyDocument,
    TopologyEdge,
    TopologyNode,
    TopologyResourceState,
    _canonical_order,
    compile_plan,
)
from app.routers.deploy import PlanOp
from app.tasks import _plan_domain_facts


def _topology() -> TopologyDocument:
    return TopologyDocument(
        nodes=[
            TopologyNode(id="dc", name="DC01", role="domainController"),
            TopologyNode(id="root", name="CA01", role="rootCa"),
            TopologyNode(id="issuing", name="CA02", role="issuingCa"),
            TopologyNode(id="web", name="SRV1", role="webServer"),
        ],
        edges=[
            TopologyEdge(id="parent", kind="caParent", source="root", target="issuing"),
            TopologyEdge(id="issuing-domain", kind="domainMembership", source="issuing", target="dc"),
            TopologyEdge(id="web-domain", kind="domainMembership", source="web", target="dc"),
            TopologyEdge(id="publication", kind="caPublication", source="issuing", target="web"),
        ],
    )


def _ops() -> list[PlanOp]:
    return [
        PlanOp(id="create-dc", kind="createVm", target="dc", params={"vmName": "DC01", "template": "domainController"}),
        PlanOp(id="create-root", kind="createVm", target="root", params={"vmName": "CA01", "template": "certificateAuthority", "caType": "Root"}),
        PlanOp(id="create-issuing", kind="createVm", target="issuing", params={"vmName": "CA02", "template": "certificateAuthority", "caType": "Issuing"}),
        PlanOp(id="create-web", kind="createVm", target="web", params={"vmName": "SRV1", "template": "webServer"}),
        PlanOp(id="join-issuing", kind="domainJoin", target="issuing", secondary="dc"),
        PlanOp(id="join-web", kind="domainJoin", target="web", secondary="dc"),
        PlanOp(id="connect-ca", kind="caConnect", target="issuing", secondary="root"),
        PlanOp(id="publish", kind="webServerCert", target="issuing", secondary="web"),
    ]


def _shape(compiled) -> list[tuple[str, list[str]]]:
    return [(op.id, op.depends_on) for op in compiled.operations]


def test_arbitrary_staging_order_compiles_to_the_same_plan():
    operations = _ops()
    for op in operations:
        op.depends_on = ["client-claimed-dependency"]

    forward = compile_plan(_topology(), operations)
    reverse = compile_plan(_topology(), list(reversed(operations)))

    assert _shape(forward) == _shape(reverse)
    assert [op.id for op in forward.operations] == [
        "create-dc",
        "create-root",
        "create-issuing",
        "create-web",
        "join-issuing",
        "join-web",
        "connect-ca",
        "publish",
    ]
    assert next(op for op in forward.operations if op.id == "connect-ca").depends_on == [
        "create-dc",
        "create-root",
        "create-issuing",
        "create-web",
        "join-issuing",
        "join-web",
    ]
    assert next(op for op in forward.operations if op.id == "publish").depends_on == [
        "create-dc",
        "create-root",
        "create-issuing",
        "create-web",
        "join-issuing",
        "join-web",
        "connect-ca",
    ]


def test_supplied_template_compiles_joins_before_pki_services():
    by_id = {op.id: op for op in _ops()}
    by_id["join-issuing"].depends_on = ["create-issuing", "create-dc"]
    by_id["join-web"].depends_on = ["create-web", "create-dc"]
    by_id["connect-ca"].depends_on = ["create-issuing", "create-root"]
    by_id["publish"].depends_on = ["create-issuing", "create-web", "connect-ca"]
    supplied_order = [
        by_id[op_id]
        for op_id in (
            "create-root",
            "create-issuing",
            "create-dc",
            "create-web",
            "join-issuing",
            "join-web",
            "connect-ca",
            "publish",
        )
    ]

    compiled = compile_plan(_topology(), supplied_order)

    assert _shape(compiled) == [
        ("create-dc", []),
        ("create-root", []),
        ("create-issuing", []),
        ("create-web", []),
        ("join-issuing", ["create-dc", "create-issuing"]),
        ("join-web", ["create-dc", "create-web"]),
        (
            "connect-ca",
            [
                "create-dc",
                "create-root",
                "create-issuing",
                "create-web",
                "join-issuing",
                "join-web",
            ],
        ),
        (
            "publish",
            [
                "create-dc",
                "create-root",
                "create-issuing",
                "create-web",
                "join-issuing",
                "join-web",
                "connect-ca",
            ],
        ),
    ]


def test_retry_without_completed_create_operations_still_compiles():
    topology = _topology()
    for node in topology.nodes:
        node.state = TopologyResourceState.realized
    remaining = [op for op in _ops() if op.kind.value != "createVm"]

    compiled = compile_plan(topology, remaining)

    assert [op.id for op in compiled.operations] == [
        "join-issuing",
        "join-web",
        "connect-ca",
        "publish",
    ]
    assert next(op for op in compiled.operations if op.id == "connect-ca").depends_on == [
        "join-issuing",
        "join-web",
    ]
    assert compiled.critical_path == ["join-issuing", "connect-ca", "publish"]


def test_retry_reads_completed_dc_facts_from_topology():
    topology = _topology()
    dc = next(node for node in topology.nodes if node.id == "dc")
    dc.config = {
        "domainName": "encon.pki",
        "netbiosName": "ENCON",
    }

    assert _plan_domain_facts([], topology) == (
        "encon.pki",
        "ENCON",
    )


def test_recompilation_preserves_operation_ids_and_inputs():
    operations = _ops()
    original_ids = [id(op) for op in operations]

    compiled = compile_plan(_topology(), operations)

    assert {op.id for op in compiled.operations} == {op.id for op in operations}
    assert [id(op) for op in operations] == original_ids
    assert all(op.depends_on == [] for op in operations)


def test_persisted_documents_recompile_identically():
    topology = _topology()
    operations = _ops()
    expected = compile_plan(topology, operations)

    restored_topology = TopologyDocument(**topology.model_dump(mode="json"))
    restored_ops = [
        PlanOp(**op.model_dump(mode="json", by_alias=True)) for op in operations
    ]

    assert _shape(compile_plan(restored_topology, restored_ops)) == _shape(expected)


def test_operation_must_exist_in_final_topology():
    topology = _topology()
    topology.edges = [edge for edge in topology.edges if edge.id != "publication"]

    try:
        compile_plan(topology, _ops())
    except (PlanCompilationError, ValueError) as exc:
        diagnostics = exc.diagnostics
    else:
        raise AssertionError("invalid topology unexpectedly compiled")

    assert any(item.code == "missing-publication-host" for item in diagnostics)


def test_every_planned_resource_requires_an_operation():
    operations = [op for op in _ops() if op.id != "publish"]

    with pytest.raises(PlanCompilationError) as caught:
        compile_plan(_topology(), operations)

    diagnostic = next(
        item for item in caught.value.diagnostics if item.code == "missing-operation"
    )
    assert diagnostic.message == (
        "Planned relationship publication requires a 'webServerCert' operation."
    )


def test_realized_resources_reject_replayed_operations():
    topology = _topology()
    topology.edges[-1].state = TopologyResourceState.realized

    with pytest.raises(PlanCompilationError) as caught:
        compile_plan(topology, _ops())

    diagnostic = next(
        item
        for item in caught.value.diagnostics
        if item.code == "operation-resource-realized"
    )
    assert diagnostic.message == (
        "Operation 'publish' would repeat already realized relationship publication."
    )


def test_compiler_reports_duration_and_critical_path_estimates():
    compiled = compile_plan(_topology(), _ops())

    assert compiled.estimated_duration_seconds == 12900
    assert compiled.critical_path == [
        "create-dc",
        "join-issuing",
        "connect-ca",
        "publish",
    ]
    assert compiled.critical_path_duration_seconds == 8100


def test_cycle_diagnostic_includes_the_operation_path():
    operations = _ops()[:2]
    dependencies = {
        operations[0].id: {operations[1].id},
        operations[1].id: {operations[0].id},
    }
    nodes = {node.id: node for node in _topology().nodes}

    with pytest.raises(PlanCompilationError) as caught:
        _canonical_order(operations, dependencies, nodes)

    diagnostic = caught.value.diagnostics[0]
    assert diagnostic.code == "operation-cycle"
    assert diagnostic.node_ids[0] == diagnostic.node_ids[-1]
    assert "createVm(DC01)" in diagnostic.message
    assert "createVm(CA01)" in diagnostic.message
