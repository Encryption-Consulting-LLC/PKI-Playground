"""Celery application for the clone job queue.

A separate worker process runs ``clone_vm_task`` (see ``app.tasks``); the FastAPI
process only ever calls ``.delay(...)`` on it. Run the worker with a bounded
``--concurrency`` (see ``Settings.clone_concurrency``) — that is the global cap on
simultaneous clones against the shared ESXi host:

    uv run celery -A app.celery_app:celery_app worker --concurrency=2 \
        --prefetch-multiplier=1 --loglevel=info
"""

from celery import Celery

from app.core.settings import settings

celery_app = Celery(
    "pki_deploy",
    broker=settings.celery_broker_url,
    backend=settings.celery_result_backend,
)

celery_app.conf.update(
    task_serializer="json",
    result_serializer="json",
    accept_content=["json"],
    # Re-deliver a task if the worker dies mid-clone rather than silently dropping
    # it; the retry surfaces as VmExistsError -> a 409 ErrorMsg if it partially
    # completed, which is preferable to losing the job outright.
    task_acks_late=True,
    # With --concurrency=N this makes N the *true* ceiling on in-flight clones —
    # without it, a worker can prefetch and hold extra tasks past the cap.
    worker_prefetch_multiplier=1,
    # We stream all state over the Valkey pub/sub + snapshot transport, not by
    # polling AsyncResult, so just bound how long results linger.
    result_expires=3600,
)

# Import so the task is registered with this app instance.
import app.tasks  # noqa: E402, F401
