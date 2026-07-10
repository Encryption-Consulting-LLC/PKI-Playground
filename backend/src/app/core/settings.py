"""Application settings — read from environment variables and an optional .env file.

The single most important field is ``auth_mode``:
  ``login``  — internal deploy; users sign in with an admin-provisioned account
               (username/password) or employee SSO (OIDC).
  ``guest``  — public playground; an anonymous guest session is minted
               automatically for each visitor.

Identity and the ESXi target are decoupled (Phase B): who you are comes from
the users collection / the IdP, while *which* ESXi host gets used is the one
shared org-wide target stored in the Mongo settings document (seeded from the
``esxi_*`` env vars on first boot, admin-editable afterwards without a
restart — see ``core/esxi.py``).

Two secrets are required in every process (API and Celery worker) and are
fail-fast validated below; generate each with ``openssl rand -base64 32``:
  ``SESSION_SECRET``    — HMAC key for the backend-minted session JWTs.
  ``SETTINGS_ENC_KEY``  — base64 32-byte AES-256-GCM key encrypting the stored
                          ESXi password (``core/secrets.py``).
"""

from typing import Literal

from pydantic import model_validator
from pydantic_settings import BaseSettings, SettingsConfigDict


class Settings(BaseSettings):
    model_config = SettingsConfigDict(env_file=".env", extra="ignore")

    auth_mode: Literal["login", "guest"] = "login"

    # Identity layer (Phase B).
    session_secret: str | None = None
    session_ttl_hours: int = 12
    settings_enc_key: str | None = None

    # Employee SSO — generic OIDC (Keycloak and Azure AD both fit). Enabled iff
    # issuer, client id/secret, and redirect URI are all set. Group values are
    # compared as exact strings against the ``oidc_group_claim`` claim, so
    # Keycloak group names and Azure AD group object-ids both work.
    oidc_issuer: str | None = None
    oidc_client_id: str | None = None
    oidc_client_secret: str | None = None
    oidc_redirect_uri: str | None = None
    oidc_group_claim: str = "groups"
    oidc_operator_groups: str = ""  # comma-separated
    oidc_guest_groups: str = ""  # comma-separated

    # First-boot seed for the shared ESXi target (written into the Mongo
    # settings document if absent there; NOT read at request time).
    esxi_host: str | None = None
    esxi_user: str | None = None
    esxi_password: str | None = None
    esxi_port: int = 443

    # First-boot seed for the guest subnet (Phase G) — same seed-only
    # semantics as the ESXi target above. The start/end range is inclusive
    # and must exclude the network, broadcast, and gateway addresses; the
    # backend pre-seeds one IP-pool document per address in the range.
    guest_ip_start: str | None = None
    guest_ip_end: str | None = None
    guest_prefix: int = 24
    guest_gateway: str | None = None
    guest_dns1: str | None = None
    guest_dns2: str | None = None
    guest_dns_suffix: str | None = None

    # Clone job queue: Valkey is the Celery broker, a per-job pub/sub bus, and the
    # snapshot store the job WebSocket reads from. The clone worker process opens
    # its own ESXi connection against the shared target from the settings document
    # (it can't share the API process's connection object).
    valkey_url: str = "redis://localhost:6379/0"
    celery_broker_url: str = "redis://localhost:6379/1"
    celery_result_backend: str | None = "redis://localhost:6379/2"
    # Intended `celery worker --concurrency=N`; not enforced here, just documents
    # the global cap the deploy should run with.
    clone_concurrency: int = 2

    # MongoDB — system of record for projects, the VM registry, the settings
    # document, and users. Reachability is checked at startup in the app
    # lifespan (fail-fast ping), not here — a URL default always parses.
    mongo_url: str = "mongodb://localhost:27017"
    mongo_db: str = "pki_playground"

    # Phase F — orchestrator agent bundling. Both must be set to enable it (a
    # deploy-environment toggle, so env vars like the broker/Mongo config, not
    # the org-wide settings document):
    #   ``ORCHESTRATOR_AGENT_PATH`` — filesystem path on the *worker host* to the
    #     pki-orchestrator agent binary embedded into each firstboot ISO.
    #   ``BACKEND_PUBLIC_URL`` — the base URL a booted guest VM dials home to
    #     (``http(s)://host:port``), baked into the agent's orchestrator.toml.
    # Unset → the default firstboot ISO stays byte-identical to Phase G (no
    # agent), so it is safe on golden images whose runner predates the v2
    # manifest. Per-template provisioning config is NOT baked here — it lives on
    # the VM registry and is dispatched after the agent phones home.
    orchestrator_agent_path: str | None = None
    backend_public_url: str | None = None

    @property
    def orchestrator_bundling_enabled(self) -> bool:
        return bool(self.orchestrator_agent_path and self.backend_public_url)

    @property
    def oidc_enabled(self) -> bool:
        return bool(
            self.oidc_issuer
            and self.oidc_client_id
            and self.oidc_client_secret
            and self.oidc_redirect_uri
        )

    @model_validator(mode="after")
    def _require_secrets(self) -> "Settings":
        missing = [
            name.upper()
            for name in ("session_secret", "settings_enc_key")
            if not getattr(self, name)
        ]
        if missing:
            raise ValueError(
                f"Missing required env vars: {', '.join(missing)}. "
                "Generate each with: openssl rand -base64 32"
            )
        return self


settings = Settings()
