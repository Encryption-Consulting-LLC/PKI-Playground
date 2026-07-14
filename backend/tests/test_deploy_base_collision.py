"""Golden-image guard in ``deploy.validate_plan``.

A createVm whose resolved name equals the clone base (``settings.clone_base``)
would server-side copy ``<base>/<base>.vmdk`` onto itself — ESXi rejects it as
"file already exists", but only after clobbering the base image's directory.
The plan validator must reject it up front with a 422.
"""

import os

os.environ.setdefault("SESSION_SECRET", "test-session-secret")
os.environ.setdefault("SETTINGS_ENC_KEY", "MDEyMzQ1Njc4OWFiY2RlZjAxMjM0NTY3ODlhYmNkZWY=")

import pytest
from fastapi import HTTPException

from app.core.authz import AuthedUser, Role
from app.core.settings import settings
from app.routers.deploy import PlanOp, PlanOpKind, validate_plan


def _operator() -> AuthedUser:
    return AuthedUser(username="op", role=Role.OPERATOR, auth="local")


def _create_op(vm_name: str) -> PlanOp:
    return PlanOp(
        id="op1",
        kind=PlanOpKind.create_vm,
        target="node1",
        params={"vmName": vm_name, "template": "standalone"},
    )


def test_operator_naming_vm_as_base_is_rejected():
    ops = [_create_op(settings.clone_base)]
    with pytest.raises(HTTPException) as exc:
        validate_plan(
            ops, _operator(), target_configured=True, guest_network_configured=True
        )
    assert exc.value.status_code == 422
    assert settings.clone_base in str(exc.value.detail)


def test_distinct_name_passes_the_base_guard():
    ops = [_create_op(f"{settings.clone_base}-clone")]
    # Should not raise on the base-name guard (a name merely prefixed by the
    # base is fine — only an exact match collides).
    validate_plan(
        ops, _operator(), target_configured=True, guest_network_configured=True
    )


def test_persisted_golden_image_name_drives_the_base_guard():
    with pytest.raises(HTTPException) as exc:
        validate_plan(
            [_create_op("site-windows-base")],
            _operator(),
            target_configured=True,
            guest_network_configured=True,
            clone_base="site-windows-base",
        )

    assert exc.value.status_code == 422
    assert "site-windows-base" in str(exc.value.detail)


def test_worker_refuses_base_named_clone_before_any_datastore_write():
    """The clone worker's own guard rejects a base-named clone before it
    touches the network or datastore (conn/db stay untouched)."""
    from app import tasks

    op = _create_op(settings.clone_base)
    state = {op.id: None}
    ok = tasks._run_clone_op(
        conn=object(),  # would blow up if the guard let execution continue
        db=object(),
        op=op,
        ops=[op],
        job_id="job1",
        state=state,
        push=lambda: None,
    )
    assert ok is False
    assert state[op.id].status == "error"
    assert settings.clone_base in state[op.id].detail
