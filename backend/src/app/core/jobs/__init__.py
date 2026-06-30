"""Generic background-job layer: a registry, per-job pub/sub, and a thread runner.

Domain-agnostic on purpose — any long-running operation can start a job, stream
normalized progress to subscribers, and end with a result or error. The clone
route is the first consumer; new ones reuse the same primitives:

    job = registry.create()
    asyncio.create_task(runner.start(job, blocking_fn))
    return {"job_id": job.id}

and clients watch ``GET (ws) /api/ws/jobs/{job_id}``.
"""

from app.core.jobs import runner
from app.core.jobs.models import (
    DoneMsg,
    ErrorMsg,
    JobStatus,
    Message,
    ProgressMsg,
    is_terminal,
)
from app.core.jobs.registry import Job, JobRegistry, registry

__all__ = [
    "runner",
    "registry",
    "Job",
    "JobRegistry",
    "JobStatus",
    "Message",
    "ProgressMsg",
    "DoneMsg",
    "ErrorMsg",
    "is_terminal",
]
