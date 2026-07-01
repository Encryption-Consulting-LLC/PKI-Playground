"""Job/progress layer: Valkey-backed transport for long-running operations.

Domain-agnostic on purpose — any operation that runs in the Celery worker can
publish normalized progress to a job id, and the WebSocket route streams it to
whoever's watching. The clone route is the consumer:

    job_id = uuid.uuid4().hex
    transport.publish(job_id, QueuedMsg(), status=JobStatus.queued)
    clone_vm_task.delay(job_id, params)
    return {"job_id": job_id}

and clients watch ``GET (ws) /api/ws/jobs/{job_id}``.

Job state lives in Valkey (not an in-process dict), so it is visible across the
FastAPI process and the separate Celery worker process that does the actual work —
see ``transport`` for why that split exists.
"""

from app.core.jobs import transport
from app.core.jobs.models import (
    DoneMsg,
    ErrorMsg,
    JobStatus,
    Message,
    ProgressMsg,
    QueuedMsg,
    RunningMsg,
    is_terminal,
)

__all__ = [
    "transport",
    "JobStatus",
    "Message",
    "QueuedMsg",
    "RunningMsg",
    "ProgressMsg",
    "DoneMsg",
    "ErrorMsg",
    "is_terminal",
]
