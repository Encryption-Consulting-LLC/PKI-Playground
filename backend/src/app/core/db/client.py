"""Mongo client lifecycle and collection accessors.

The async client is created inside the FastAPI lifespan (``app.main``) so it
binds to uvicorn's event loop — module-level construction would race the loop.
Startup is fail-fast: if Mongo is unreachable the ping below raises and the
process refuses to boot, consistent with the guest-mode env validation in
``core/settings.py``. The 5s server-selection timeout also bounds *runtime*
outages to a fast 503 (via the PyMongoError handler in ``core/errors.py``)
instead of pymongo's 30s default.

Routers import the collection accessors, which raise if startup never ran.
"""

from pymongo import ASCENDING, DESCENDING, AsyncMongoClient, IndexModel
from pymongo.asynchronous.collection import AsyncCollection
from pymongo.asynchronous.database import AsyncDatabase

from app.core.db.models import SettingsDoc, now_ms, to_mongo
from app.core.settings import settings

_client: AsyncMongoClient | None = None
_db: AsyncDatabase | None = None

#: Fixed primary key of the settings singleton document.
SETTINGS_DOC_ID = "global"


async def init_db() -> None:
    """Connect, fail-fast ping, ensure indexes, seed the settings singleton."""
    global _client, _db
    _client = AsyncMongoClient(settings.mongo_url, serverSelectionTimeoutMS=5000)
    _db = _client[settings.mongo_db]
    await _client.admin.command("ping")
    await _ensure_indexes()
    await _seed_settings_doc()


async def close_db() -> None:
    global _client, _db
    if _client is not None:
        await _client.close()
    _client = _db = None


def get_db() -> AsyncDatabase:
    if _db is None:
        raise RuntimeError("Mongo not initialized — init_db() runs in the app lifespan.")
    return _db


def projects_col() -> AsyncCollection:
    return get_db()["projects"]


def vm_registry_col() -> AsyncCollection:
    return get_db()["vm_registry"]


def settings_col() -> AsyncCollection:
    return get_db()["settings"]


def users_col() -> AsyncCollection:
    return get_db()["users"]


async def _ensure_indexes() -> None:
    """Idempotent — create_indexes no-ops on identical existing indexes."""
    await projects_col().create_indexes(
        [
            # List endpoint sorts by recency.
            IndexModel([("updatedAt", DESCENDING)]),
            # Phase B per-owner listing; cheap to create now on all-null owner.
            IndexModel([("owner", ASCENDING), ("updatedAt", DESCENDING)]),
        ]
    )
    await vm_registry_col().create_indexes(
        [
            # One entry per real ESXi VM; the upsert key.
            IndexModel([("vmName", ASCENDING)], unique=True),
            # Canvas → registry lookups.
            IndexModel([("projectId", ASCENDING), ("nodeId", ASCENDING)]),
            # moid is unique when known, absent allowed.
            IndexModel([("moid", ASCENDING)], unique=True, sparse=True),
        ]
    )
    await users_col().create_indexes(
        [
            IndexModel([("username", ASCENDING)], unique=True),
            IndexModel([("email", ASCENDING)], unique=True, sparse=True),
        ]
    )
    # settings: singleton via fixed _id — no extra indexes.


async def _seed_settings_doc() -> None:
    """Insert the settings singleton from env if absent; operator edits made
    through the settings routes survive restarts ($setOnInsert only)."""
    seed = SettingsDoc(
        esxi_host=settings.esxi_host,
        esxi_user=settings.esxi_user,
        esxi_port=settings.esxi_port,
        updated_at=now_ms(),
    )
    await settings_col().update_one(
        {"_id": SETTINGS_DOC_ID},
        {"$setOnInsert": to_mongo(seed)},
        upsert=True,
    )
