"""Control-plane readiness checks that must pass before ESXi cloning."""

import hashlib
from pathlib import Path
from urllib.parse import urlparse

from pydantic import BaseModel, ConfigDict, Field

from app.celery_app import celery_app
from app.core.db.models import now_ms
from app.core.infrastructure import InfrastructureProfile, PkiRole
from app.core.jobs import transport
from app.core.settings import settings


class EnvironmentCheck(BaseModel):
    key: str
    ok: bool
    detail: str


class EnvironmentPreflight(BaseModel):
    model_config = ConfigDict(populate_by_name=True)

    ready: bool
    checked_at: int = Field(alias="checkedAt")
    checks: list[EnvironmentCheck]


def _agent_digest(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as handle:
        for chunk in iter(lambda: handle.read(1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()


def preflight_control_plane(
    profiles: dict[PkiRole, InfrastructureProfile],
    *,
    mongo_ready: bool,
    check_worker: bool = True,
) -> EnvironmentPreflight:
    """Check persistence, broker, worker, callback, and bundled agent identity."""

    checks = [
        EnvironmentCheck(
            key="mongo", ok=mongo_ready,
            detail="MongoDB responded to ping." if mongo_ready else "MongoDB ping failed.",
        )
    ]
    try:
        valkey_ready = bool(transport._client.ping())  # noqa: SLF001 - shared client
    except Exception as exc:  # noqa: BLE001
        checks.append(EnvironmentCheck(key="valkey", ok=False, detail=f"Valkey ping failed: {exc}"))
    else:
        checks.append(EnvironmentCheck(key="valkey", ok=valkey_ready, detail="Valkey responded to ping."))

    callback = settings.backend_public_url or ""
    parsed = urlparse(callback)
    callback_ok = parsed.scheme in ("http", "https") and bool(parsed.netloc)
    checks.append(
        EnvironmentCheck(
            key="backendCallback", ok=callback_ok,
            detail=(
                f"Guest callback URL is '{callback}'."
                if callback_ok else "BACKEND_PUBLIC_URL must be an absolute HTTP(S) URL."
            ),
        )
    )

    path = Path(settings.orchestrator_agent_path or "")
    agent_ok = False
    try:
        digest = _agent_digest(path) if path.is_file() else None
    except OSError as exc:
        digest = None
        agent_detail = f"Could not hash orchestrator agent: {exc}"
    else:
        expected = {
            profile.qualification.agent_sha256.lower()
            for profile in profiles.values()
            if profile.qualification is not None
        }
        agent_ok = bool(digest and expected and expected == {digest.lower()})
        agent_detail = (
            f"Bundled agent SHA-256 is {digest}."
            if agent_ok else "Bundled agent does not match every qualified image profile."
        )
    checks.append(
        EnvironmentCheck(
            key="agentBinary", ok=agent_ok,
            detail=agent_detail,
        )
    )

    if check_worker:
        try:
            replies = celery_app.control.inspect(timeout=2.0).ping() or {}
        except Exception as exc:  # noqa: BLE001
            checks.append(EnvironmentCheck(key="worker", ok=False, detail=f"Worker ping failed: {exc}"))
        else:
            checks.append(
                EnvironmentCheck(
                    key="worker", ok=bool(replies),
                    detail=(
                        f"{len(replies)} Celery worker(s) responded."
                        if replies else "No Celery worker responded to ping."
                    ),
                )
            )
    return EnvironmentPreflight(
        ready=all(check.ok for check in checks), checkedAt=now_ms(), checks=checks
    )
