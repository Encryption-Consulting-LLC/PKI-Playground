"""Dependency decisions for the Celery plan fan-out scheduler."""

from app.routers.deploy import PlanOp
from app.tasks import ready_plan_operations


def _op(op_id: str, *dependencies: str) -> PlanOp:
    return PlanOp(
        id=op_id,
        kind="domainJoin",
        target=op_id,
        dependsOn=list(dependencies),
    )


def test_all_independent_roots_are_ready_together() -> None:
    ops = [_op("clone-dc"), _op("clone-root"), _op("clone-web")]

    ready, blocked = ready_plan_operations(ops, {op.id: "pending" for op in ops})

    assert ready == ["clone-dc", "clone-root", "clone-web"]
    assert blocked == []


def test_child_waits_until_every_dependency_finishes() -> None:
    ops = [_op("clone-dc"), _op("clone-ca"), _op("join-ca", "clone-dc", "clone-ca")]

    ready, blocked = ready_plan_operations(
        ops,
        {"clone-dc": "done", "clone-ca": "running", "join-ca": "pending"},
    )
    assert ready == []
    assert blocked == []

    ready, blocked = ready_plan_operations(
        ops,
        {"clone-dc": "done", "clone-ca": "done", "join-ca": "pending"},
    )
    assert ready == ["join-ca"]
    assert blocked == []


def test_clone_done_releases_only_its_provision_sibling() -> None:
    ops = [
        _op("clone-dc"),
        _op("clone-dc::provision", "clone-dc"),
        _op("join", "clone-dc::provision"),
    ]

    ready, blocked = ready_plan_operations(
        ops,
        {"clone-dc": "done", "clone-dc::provision": "pending", "join": "pending"},
    )

    assert ready == ["clone-dc::provision"]
    assert blocked == []


def test_failed_provision_cancels_dependents_but_not_siblings() -> None:
    ops = [
        _op("clone-dc"),
        _op("clone-dc::provision", "clone-dc"),
        _op("clone-root"),
        _op("clone-root::provision", "clone-root"),
        _op("join", "clone-dc::provision"),
    ]

    ready, blocked = ready_plan_operations(
        ops,
        {
            "clone-dc": "done",
            "clone-dc::provision": "error",
            "clone-root": "done",
            "clone-root::provision": "pending",
            "join": "pending",
        },
    )

    assert ready == ["clone-root::provision"]
    assert blocked == ["join"]


def test_failed_dependency_blocks_only_its_descendants() -> None:
    ops = [
        _op("clone-dc"),
        _op("clone-root"),
        _op("promote-dc", "clone-dc"),
        _op("configure-root", "clone-root"),
    ]

    ready, blocked = ready_plan_operations(
        ops,
        {
            "clone-dc": "error",
            "clone-root": "done",
            "promote-dc": "pending",
            "configure-root": "pending",
        },
    )

    assert ready == ["configure-root"]
    assert blocked == ["promote-dc"]
