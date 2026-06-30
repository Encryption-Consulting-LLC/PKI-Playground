"""In-process registry of background jobs.

Mirrors ``app.core.sessions``: a module-level dict guarded by a lock, lost on
process restart by design. A ``Job`` bundles its current status, the last
message published (snapshot, so a late/reconnecting subscriber sees current
state immediately), and its ``PubSub`` channel.
"""

import threading
import uuid
from dataclasses import dataclass, field

from app.core.jobs.models import JobStatus, Message
from app.core.jobs.pubsub import PubSub


@dataclass
class Job:
    id: str
    status: JobStatus = JobStatus.running
    last: Message | None = None
    pubsub: PubSub = field(default_factory=PubSub)


class JobRegistry:
    def __init__(self) -> None:
        self._jobs: dict[str, Job] = {}
        self._lock = threading.Lock()

    def create(self) -> Job:
        job = Job(id=uuid.uuid4().hex)
        with self._lock:
            self._jobs[job.id] = job
        return job

    def get(self, job_id: str) -> Job | None:
        return self._jobs.get(job_id)


#: Process-wide singleton.
registry = JobRegistry()
