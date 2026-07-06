"""Document schemas for the MongoDB collections.

Shared across routers (and, later, the Celery worker) the same way
``core/jobs/models.py`` centralizes the WebSocket wire types.

Conventions:
  - Python fields are snake_case; the stored/wire form is camelCase via
    explicit ``Field(alias=...)`` (same pattern as ``deploy.py``'s
    ``dependsOn``). Dump with ``by_alias=True`` for both Mongo writes and API
    responses so stored documents match the frontend's ``Project`` shape
    verbatim — ``to_mongo``/``from_mongo`` below handle the one exception,
    the ``_id``/``id`` rename.
  - Timestamps are server-set epoch-milliseconds ints, matching the
    frontend's ``Date.now()`` and sorting correctly in indexes.
  - Every document carries ``schemaVersion`` for future migrations.
"""

import time
from typing import Any, Literal

from pydantic import BaseModel, ConfigDict, Field


def now_ms() -> int:
    """Server timestamp in epoch milliseconds (the frontend's Date.now() unit)."""
    return int(time.time() * 1000)


class MongoModel(BaseModel):
    """Base for documents whose primary key is an opaque string id."""

    model_config = ConfigDict(populate_by_name=True)

    id: str = Field(alias="_id")


def to_mongo(model: BaseModel) -> dict[str, Any]:
    """Dump a document model into its stored form (camelCase, ``_id`` key)."""
    return model.model_dump(by_alias=True)


def from_mongo(doc: dict[str, Any]) -> dict[str, Any]:
    """Rename ``_id`` → ``id`` for API responses; leaves other keys untouched."""
    out = dict(doc)
    out["id"] = out.pop("_id")
    return out


class Viewport(BaseModel):
    x: float = 0
    y: float = 0
    zoom: float = 1


class ProjectDoc(MongoModel):
    """One saved canvas: the frontend's ``Project`` snapshot, minus its
    client-only ``dirty`` flag.

    ``nodes``/``edges``/``stagedOps`` are opaque validated blobs — React Flow
    internals are deliberately not modeled server-side; validation is
    top-level shape plus size caps (``stagedOps`` matches the deploy plan's
    50-op cap). Mongo's 16 MB document limit is the payload backstop.
    """

    name: str = Field(min_length=1, max_length=120)
    nodes: list[dict[str, Any]] = Field(default_factory=list, max_length=200)
    edges: list[dict[str, Any]] = Field(default_factory=list, max_length=500)
    counters: dict[str, int] = Field(default_factory=dict)
    viewport: Viewport = Field(default_factory=Viewport)
    staged_ops: list[dict[str, Any]] = Field(
        default_factory=list, max_length=50, alias="stagedOps"
    )
    deploy_job_id: str | None = Field(default=None, alias="deployJobId")
    # Phase B stub — always None until users/ownership land.
    owner: str | None = None
    schema_version: int = Field(default=1, alias="schemaVersion")
    created_at: int = Field(alias="createdAt")
    updated_at: int = Field(alias="updatedAt")


class VmRegistryEntry(MongoModel):
    """App-side VM identity ↔ real ESXi identity, plus a cached status.

    ``vmName`` (the real ESXi inventory name) is the natural unique key,
    enforced by index rather than by ``_id`` — a re-clone shouldn't change
    document identity. App names ("WS-1") repeat across projects.
    """

    project_id: str | None = Field(default=None, alias="projectId")
    node_id: str | None = Field(default=None, alias="nodeId")
    app_name: str = Field(alias="appName")
    vm_name: str = Field(alias="vmName")
    moid: str | None = None
    status: Literal["cloning", "ready", "error", "deleted"] = "ready"
    power_state: str | None = Field(default=None, alias="powerState")
    job_id: str | None = Field(default=None, alias="jobId")
    schema_version: int = Field(default=1, alias="schemaVersion")
    created_at: int = Field(alias="createdAt")
    updated_at: int = Field(alias="updatedAt")


class SettingsDoc(BaseModel):
    """The settings singleton (fixed ``_id`` — not a ``MongoModel``).

    Authoritative (Phase B) for the one shared org-wide ESXi target — seeded
    from env on first boot, then admin-editable via the settings routes with
    no restart (``core/esxi.py`` reloads it per request). The password is
    stored only as the ``core/secrets.py`` ``{keyId, nonce, ciphertext}``
    shape and is never returned by the API.
    """

    model_config = ConfigDict(populate_by_name=True)

    id: Literal["global"] = Field(default="global", alias="_id")
    esxi_host: str | None = Field(default=None, alias="esxiHost")
    esxi_user: str | None = Field(default=None, alias="esxiUser")
    esxi_password_enc: dict[str, str] | None = Field(
        default=None, alias="esxiPasswordEnc"
    )
    esxi_port: int = Field(default=443, alias="esxiPort")
    # Guest subnet (Phase G) — an inclusive start/end range (not a CIDR, so it
    # can never include the network/broadcast/gateway addresses) that the IP
    # pool (``core/ippool.py``) is seeded from. All four of start/end/gateway/
    # dns1 must be set for guest deploys to run (configgen's static network
    # script requires a primary DNS server).
    guest_ip_start: str | None = Field(default=None, alias="guestIpStart")
    guest_ip_end: str | None = Field(default=None, alias="guestIpEnd")
    guest_prefix: int = Field(default=24, alias="guestPrefix")
    guest_gateway: str | None = Field(default=None, alias="guestGateway")
    guest_dns1: str | None = Field(default=None, alias="guestDns1")
    guest_dns2: str | None = Field(default=None, alias="guestDns2")
    guest_dns_suffix: str | None = Field(default=None, alias="guestDnsSuffix")
    feature_flags: dict[str, bool] = Field(default_factory=dict, alias="featureFlags")
    schema_version: int = Field(default=3, alias="schemaVersion")
    updated_at: int = Field(alias="updatedAt")


class UserDoc(MongoModel):
    """One account — admin-provisioned only (no self-serve signup).

    ``auth`` records provenance: ``local`` accounts hold an Argon2id
    ``passwordHash``; ``oidc`` accounts are upserted at first SSO login and
    hold none (their credential lives at the IdP). Either kind is switched
    off via ``disabled``, which takes effect on the next request because
    ``authz.resolve_user_token`` re-reads this document per request.

    Role strings mirror ``authz.Role`` values without importing them, keeping
    the schema decoupled from auth internals.
    """

    username: str = Field(min_length=1, max_length=64)
    email: str | None = None
    password_hash: str | None = Field(default=None, alias="passwordHash")
    role: Literal["operator", "guest"] = "operator"
    auth: Literal["local", "oidc"] = "local"
    disabled: bool = False
    schema_version: int = Field(default=1, alias="schemaVersion")
    created_at: int = Field(alias="createdAt")
    updated_at: int = Field(alias="updatedAt")
