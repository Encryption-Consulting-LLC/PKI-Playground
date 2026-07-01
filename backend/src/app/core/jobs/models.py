"""Wire types for the job/progress layer.

These are the *normalized* messages a client receives over the WebSocket; they
are domain-agnostic (no vmkit types leak in here). A producer — e.g. the clone
reducer in ``app.routers.vm`` — translates whatever its library emits into a
``ProgressMsg``; the runner appends the terminal ``DoneMsg`` / ``ErrorMsg``.
"""

from enum import Enum
from typing import Annotated, Any, Literal, Union

from pydantic import BaseModel, Field


class JobStatus(str, Enum):
    queued = "queued"
    running = "running"
    done = "done"
    error = "error"


class QueuedMsg(BaseModel):
    """Job accepted but not yet picked up by a worker (waiting on the concurrency cap)."""

    type: Literal["queued"] = "queued"


class RunningMsg(BaseModel):
    """Job picked up by a worker; work is about to start (no progress sample yet)."""

    type: Literal["running"] = "running"


class ProgressMsg(BaseModel):
    type: Literal["progress"] = "progress"
    percent: float
    phase: str  # human label for the current sub-operation
    key: str  # stable id of the sub-operation emitting this sample
    unit: str = "%"


class DoneMsg(BaseModel):
    type: Literal["done"] = "done"
    result: dict[str, Any]


class ErrorMsg(BaseModel):
    type: Literal["error"] = "error"
    status: int
    detail: str


#: Anything the runner/producer can publish onto a job's channel.
Message = Annotated[
    Union[QueuedMsg, RunningMsg, ProgressMsg, DoneMsg, ErrorMsg],
    Field(discriminator="type"),
]

#: Message ``type``s after which the stream ends and the socket closes.
TERMINAL_TYPES = frozenset({"done", "error"})


def is_terminal(msg: Message) -> bool:
    """True if *msg* ends the job (no further messages will follow)."""
    return msg.type in TERMINAL_TYPES
