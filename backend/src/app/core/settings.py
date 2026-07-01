"""Application settings — read from environment variables and an optional .env file.

The single most important field is ``auth_mode``:
  ``login``  — internal deploy; operators provide ESXi credentials at login time.
  ``guest``  — public playground; credentials are hardcoded in the environment and
               a session is opened automatically for each visitor.

In guest mode the four ``esxi_*`` values are required; the startup guard below
raises a ``ValueError`` immediately if any are absent so misconfigured deploys
fail fast rather than at the first incoming request.
"""

from typing import Literal

from pydantic import model_validator
from pydantic_settings import BaseSettings, SettingsConfigDict


class Settings(BaseSettings):
    model_config = SettingsConfigDict(env_file=".env", extra="ignore")

    auth_mode: Literal["login", "guest"] = "login"

    # Guest-mode ESXi connection — required only when auth_mode == "guest".
    esxi_host: str | None = None
    esxi_user: str | None = None
    esxi_password: str | None = None
    esxi_port: int = 443

    # Clone job queue: Valkey is the Celery broker, a per-job pub/sub bus, and the
    # snapshot store the job WebSocket reads from. The clone worker process opens
    # its own ESXi connection from the esxi_* settings above (it can't share the
    # API process's in-process session dict), so the queue only protects clones in
    # guest mode today — see backend CLAUDE.md / the clone route docstring.
    valkey_url: str = "redis://localhost:6379/0"
    celery_broker_url: str = "redis://localhost:6379/1"
    celery_result_backend: str | None = "redis://localhost:6379/2"
    # Intended `celery worker --concurrency=N`; not enforced here, just documents
    # the global cap the deploy should run with.
    clone_concurrency: int = 2

    @model_validator(mode="after")
    def _require_esxi_for_guest(self) -> "Settings":
        if self.auth_mode == "guest":
            missing = [
                name.upper()
                for name in ("esxi_host", "esxi_user", "esxi_password")
                if not getattr(self, name)
            ]
            if missing:
                raise ValueError(
                    f"AUTH_MODE=guest requires the following env vars: {', '.join(missing)}"
                )
        return self


settings = Settings()
