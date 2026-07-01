"""Celery tasks. Runs in the worker process — never inside the FastAPI app.

The clone task owns the blocking vmkit call and publishes progress over the Valkey
transport (``app.core.jobs.transport``). It reuses ``CloneProgressReducer`` and
``_clone_total_ops`` from the clone route unchanged, and ``map_vmkit_error`` for the
same error → status mapping the synchronous routes use.
"""

from dataclasses import asdict

from vmkit import clone_workflow, open_connection
from vmkit.errors import VmkitError

from app.celery_app import celery_app
from app.core.errors import map_vmkit_error
from app.core.jobs import transport
from app.core.jobs.models import DoneMsg, ErrorMsg, JobStatus, RunningMsg
from app.core.settings import settings


@celery_app.task(name="clone_vm")
def clone_vm_task(job_id: str, params: dict) -> None:
    # Imported lazily to avoid a hard import-time dependency between the worker
    # entrypoint and the FastAPI router module.
    from app.routers.vm import CloneProgressReducer, CloneRequest, _clone_total_ops

    transport.publish(job_id, RunningMsg(), status=JobStatus.running)

    try:
        req = CloneRequest(**params)
        conn = open_connection(
            settings.esxi_host,  # type: ignore[arg-type]
            settings.esxi_user,  # type: ignore[arg-type]
            settings.esxi_password,  # type: ignore[arg-type]
            settings.esxi_port,
        )
        reducer = CloneProgressReducer(transport.make_publisher(job_id), _clone_total_ops(req))
        result = clone_workflow(conn, progress=reducer, **params)
        transport.publish(
            job_id, DoneMsg(result=asdict(result)), status=JobStatus.done, terminal=True
        )
    except VmkitError as exc:
        status, detail = map_vmkit_error(exc)
        transport.publish(
            job_id, ErrorMsg(status=status, detail=detail), status=JobStatus.error, terminal=True
        )
    except Exception as exc:  # noqa: BLE001 — surface anything as a terminal error
        transport.publish(
            job_id, ErrorMsg(status=500, detail=str(exc)), status=JobStatus.error, terminal=True
        )
