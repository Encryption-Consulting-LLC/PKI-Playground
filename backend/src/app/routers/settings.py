"""Settings singleton routes — STUB in Phase A.

The document is seeded from env at startup (``core/db/client.py``) and
editable here, but env vars via ``core/settings.py`` remain authoritative at
runtime — nothing reads this document yet. It carries no ESXi password;
secret handling is decided in Phase B alongside the admin portal.

(Absolute imports mean no clash with ``app.core.settings``.)
"""

from fastapi import APIRouter, Depends
from pydantic import BaseModel, ConfigDict, Field
from vmkit import Connection

from app.core.authz import Capability, require_capability
from app.core.db import SETTINGS_DOC_ID, from_mongo, now_ms, settings_col
from app.core.sessions import get_session

router = APIRouter(prefix="/settings", tags=["settings"])


class SettingsUpdate(BaseModel):
    """Partial update — only fields present in the request are $set."""

    model_config = ConfigDict(populate_by_name=True)

    esxi_host: str | None = Field(default=None, alias="esxiHost")
    esxi_user: str | None = Field(default=None, alias="esxiUser")
    esxi_port: int | None = Field(default=None, alias="esxiPort")
    feature_flags: dict[str, bool] | None = Field(default=None, alias="featureFlags")


@router.get("", dependencies=[Depends(require_capability(Capability.SETTINGS_READ))])
async def get_settings(_conn: Connection = Depends(get_session)) -> dict:
    doc = await settings_col().find_one({"_id": SETTINGS_DOC_ID})
    return from_mongo(doc)


@router.put("", dependencies=[Depends(require_capability(Capability.SETTINGS_WRITE))])
async def update_settings(
    body: SettingsUpdate, _conn: Connection = Depends(get_session)
) -> dict:
    fields = body.model_dump(by_alias=True, exclude_unset=True)
    fields["updatedAt"] = now_ms()
    await settings_col().update_one({"_id": SETTINGS_DOC_ID}, {"$set": fields})
    doc = await settings_col().find_one({"_id": SETTINGS_DOC_ID})
    return from_mongo(doc)
