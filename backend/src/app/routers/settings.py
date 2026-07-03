"""Settings singleton routes — the shared org-wide ESXi target.

Authoritative since Phase B: ``core/esxi.py`` reads this document per request,
so an operator edit here takes effect on the next VM operation with no
restart. The env ``ESXI_*`` vars are only a first-boot seed.

``esxiPassword`` is write-only: accepted in the PUT body, stored as the
AES-GCM blob from ``core/secrets.py``, and never returned — GET exposes just
``hasPassword``. That keeps the plaintext out of Mongo *and* out of every
API response/log.

(Absolute imports mean no clash with ``app.core.settings``.)
"""

from fastapi import APIRouter, Depends
from pydantic import BaseModel, ConfigDict, Field

from app.core.authz import Capability, require_capability
from app.core.db import SETTINGS_DOC_ID, from_mongo, now_ms, settings_col
from app.core.secrets import encrypt_secret

router = APIRouter(prefix="/settings", tags=["settings"])


class SettingsUpdate(BaseModel):
    """Partial update — only fields present in the request are $set."""

    model_config = ConfigDict(populate_by_name=True)

    esxi_host: str | None = Field(default=None, alias="esxiHost")
    esxi_user: str | None = Field(default=None, alias="esxiUser")
    esxi_password: str | None = Field(default=None, alias="esxiPassword")
    esxi_port: int | None = Field(default=None, alias="esxiPort")
    feature_flags: dict[str, bool] | None = Field(default=None, alias="featureFlags")


def _present(doc: dict) -> dict:
    """API shape: replace the ciphertext blob with a ``hasPassword`` flag."""
    out = from_mongo(doc)
    out["hasPassword"] = out.pop("esxiPasswordEnc", None) is not None
    return out


@router.get("", dependencies=[Depends(require_capability(Capability.SETTINGS_READ))])
async def get_settings() -> dict:
    doc = await settings_col().find_one({"_id": SETTINGS_DOC_ID})
    return _present(doc)


@router.put("", dependencies=[Depends(require_capability(Capability.SETTINGS_WRITE))])
async def update_settings(body: SettingsUpdate) -> dict:
    fields = body.model_dump(by_alias=True, exclude_unset=True)
    if "esxiPassword" in fields:
        password = fields.pop("esxiPassword")
        fields["esxiPasswordEnc"] = encrypt_secret(password) if password else None
    fields["updatedAt"] = now_ms()
    await settings_col().update_one({"_id": SETTINGS_DOC_ID}, {"$set": fields})
    doc = await settings_col().find_one({"_id": SETTINGS_DOC_ID})
    return _present(doc)
