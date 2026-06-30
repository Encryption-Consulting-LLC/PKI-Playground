"""Runs a blocking job on a worker thread and publishes its progress.

``start`` is the one entry point. It hands the job's blocking function a
thread-safe ``publish`` callback; the function (e.g. a vmkit workflow with a
progress reducer wired in) calls it as work proceeds. ``publish`` hops every
message back onto the event loop before touching the (loop-affine) ``PubSub``.

On normal return the function's value becomes a terminal ``DoneMsg``; a vmkit
error is mapped to ``(status, detail)`` via :func:`app.core.errors.map_vmkit_error`
and any other exception becomes a generic 500 — both as a terminal ``ErrorMsg``.
The channel is always closed at the end so subscribers unblock.
"""

import asyncio
from typing import Any, Callable

import anyio
from vmkit.errors import VmkitError

from app.core.errors import map_vmkit_error
from app.core.jobs.models import DoneMsg, ErrorMsg, JobStatus, Message
from app.core.jobs.registry import Job

#: Producer-facing sink: thread-safe, never raises.
Publish = Callable[[Message], None]

#: A unit of work; receives the publish sink and returns the result payload.
BlockingFn = Callable[[Publish], dict[str, Any]]


async def start(job: Job, blocking_fn: BlockingFn) -> None:
    """Execute *blocking_fn* off the event loop, streaming its progress."""
    loop = asyncio.get_running_loop()

    def deliver(msg: Message) -> None:
        # Runs on the loop thread: safe to mutate job state and fan out.
        job.last = msg
        if isinstance(msg, DoneMsg):
            job.status = JobStatus.done
        elif isinstance(msg, ErrorMsg):
            job.status = JobStatus.error
        job.pubsub.publish(msg)

    def publish(msg: Message) -> None:
        # Called from the worker thread by the blocking fn / reducer.
        loop.call_soon_threadsafe(deliver, msg)

    try:
        result = await anyio.to_thread.run_sync(blocking_fn, publish)
        deliver(DoneMsg(result=result))
    except VmkitError as exc:
        status, detail = map_vmkit_error(exc)
        deliver(ErrorMsg(status=status, detail=detail))
    except Exception as exc:  # noqa: BLE001 — surface anything as a terminal error
        deliver(ErrorMsg(status=500, detail=str(exc)))
    finally:
        job.pubsub.close()
