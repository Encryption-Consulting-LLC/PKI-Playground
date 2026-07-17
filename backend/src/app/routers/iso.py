"""Config-ISO authoring routes — all operator-only via ``ISO_AUTHOR``.

Two transports feed an authored ``createVm``:

- PACK mode sends text scripts inline in the deploy payload (``PlanOp.files``,
  validated in ``routers/deploy.py``) — no storage, nothing here.
- UPLOAD-ISO mode uploads a pre-built ``.iso`` through ``POST /iso`` into a
  GridFS bucket the Celery worker can reach with its sync client; the op then
  references it as ``params["isoId"]`` and the worker attaches it verbatim.

Lifecycle of an uploaded ISO: the worker deletes it after the clone that
consumed it succeeds; the frontend best-effort ``DELETE``s it when its node is
removed or its upload is replaced; and ``gc_orphan_isos`` (called by the worker
at the start of each plan) sweeps anything older than the orphan TTL, so an
abandoned upload can never accumulate forever.

``GET /iso/templates/{id}/scripts`` seeds the PACK panel with the template's
fixed role scripts from ``assets/firstboot/<id>/`` — the same single source of
truth the default (non-authored) clone path packs.
"""

from datetime import UTC, datetime, timedelta
from pathlib import Path

from bson import ObjectId
from bson.errors import InvalidId
from fastapi import APIRouter, Depends, HTTPException, UploadFile
from gridfs import GridFSBucket
from gridfs.asynchronous import AsyncGridFSBucket
from gridfs.errors import NoFile

from app.core.authz import AuthedUser, Capability, get_current_user, require_capability
from app.core.db import get_db, now_ms
from app.core.firstboot import TEMPLATE_IDS, role_scripts_for

router = APIRouter(prefix="/iso", tags=["iso"])

#: GridFS bucket name (collections ``isos.files`` / ``isos.chunks``).
ISO_BUCKET = "isos"
ISO_UPLOAD_MAX_BYTES = 128 * 1024 * 1024
#: Uploads not consumed by a deploy within this window are swept.
ISO_ORPHAN_TTL = timedelta(hours=24)

# ISO 9660: the primary volume descriptor sits at byte 32768 and reads
# "\x01CD001" — checking "CD001" at offset 32769 is the standard sniff.
_ISO_MAGIC = b"CD001"
_ISO_MAGIC_OFFSET = 32769
_HEAD_BYTES = _ISO_MAGIC_OFFSET + len(_ISO_MAGIC)
_UPLOAD_CHUNK = 1024 * 1024


@router.post(
    "",
    status_code=201,
    dependencies=[Depends(require_capability(Capability.ISO_AUTHOR))],
)
async def upload_iso(
    file: UploadFile,
    user: AuthedUser = Depends(get_current_user),
) -> dict:
    """Stream a pre-built config ISO into GridFS; returns its ``isoId``.

    Enforced here rather than trusted from the client: ``.iso`` extension,
    ISO 9660 magic at the standard offset, and the size cap (the stream is
    aborted mid-flight past it, so an oversized body never lands whole).
    """
    name = file.filename or "upload.iso"
    if not name.lower().endswith(".iso"):
        raise HTTPException(422, detail="Only .iso files can be uploaded.")

    bucket = AsyncGridFSBucket(get_db(), bucket_name=ISO_BUCKET)
    stream = bucket.open_upload_stream(
        name, metadata={"uploadedBy": user.username, "uploadedAt": now_ms()}
    )
    head = b""
    size = 0
    try:
        while chunk := await file.read(_UPLOAD_CHUNK):
            size += len(chunk)
            if size > ISO_UPLOAD_MAX_BYTES:
                raise HTTPException(
                    413,
                    detail=f"ISO exceeds {ISO_UPLOAD_MAX_BYTES // (1024 * 1024)} MiB.",
                )
            if len(head) < _HEAD_BYTES:
                head += chunk[: _HEAD_BYTES - len(head)]
            await stream.write(chunk)
        if size < _HEAD_BYTES or head[_ISO_MAGIC_OFFSET:_HEAD_BYTES] != _ISO_MAGIC:
            raise HTTPException(
                422, detail="File is not an ISO 9660 image (missing CD001 signature)."
            )
    except BaseException:
        await stream.abort()
        raise
    await stream.close()
    return {"isoId": str(stream._id), "name": name, "size": size}


@router.delete(
    "/{iso_id}",
    status_code=204,
    dependencies=[Depends(require_capability(Capability.ISO_AUTHOR))],
)
async def delete_iso(iso_id: str) -> None:
    """Drop an uploaded ISO (204). Unknown/expired ids are a 404 the client
    is expected to tolerate — the worker and the orphan sweep also delete."""
    try:
        oid = ObjectId(iso_id)
    except InvalidId:
        raise HTTPException(404, detail="Unknown ISO.")
    try:
        await AsyncGridFSBucket(get_db(), bucket_name=ISO_BUCKET).delete(oid)
    except NoFile:
        raise HTTPException(404, detail="Unknown ISO.")


@router.get(
    "/templates/{template_id}/scripts",
    dependencies=[Depends(require_capability(Capability.ISO_AUTHOR))],
)
def template_scripts(template_id: str) -> dict:
    """The template's fixed role scripts as editable seed content for the PACK
    panel. Empty list for templates without role scripts (e.g. standalone)."""
    if template_id not in TEMPLATE_IDS:
        raise HTTPException(404, detail=f"Unknown template '{template_id}'.")
    return {
        "scripts": [
            {"name": path.name, "content": path.read_text(encoding="utf-8")}
            for path in role_scripts_for(template_id)
        ]
    }


# ---------------------------------------------------------------------------
# Sync helpers for the Celery worker (its Mongo access is a short-lived sync
# client — see core/db/sync.worker_db).
# ---------------------------------------------------------------------------


def fetch_uploaded_iso_sync(db, iso_id: str, dest: Path) -> Path:
    """Download an uploaded ISO to ``dest``. A file already consumed or swept
    surfaces as a clean, actionable op error rather than gridfs's ``NoFile``."""
    try:
        with dest.open("wb") as fh:
            GridFSBucket(db, bucket_name=ISO_BUCKET).download_to_stream(
                ObjectId(iso_id), fh
            )
    except NoFile:
        raise RuntimeError(
            "Uploaded ISO not found — it may have been consumed or expired; "
            "re-upload and retry."
        ) from None
    return dest


def delete_uploaded_iso_sync(db, iso_id: str) -> None:
    """Best-effort delete after a consuming clone succeeds — a failure here
    just leaves the file to the orphan sweep."""
    try:
        GridFSBucket(db, bucket_name=ISO_BUCKET).delete(ObjectId(iso_id))
    except Exception:  # noqa: BLE001 — never fail the op over cleanup
        pass


def gc_orphan_isos(db) -> int:
    """Sweep uploads older than the orphan TTL; returns how many were removed."""
    cutoff = datetime.now(UTC) - ISO_ORPHAN_TTL
    bucket = GridFSBucket(db, bucket_name=ISO_BUCKET)
    removed = 0
    for doc in db[f"{ISO_BUCKET}.files"].find(
        {"uploadDate": {"$lt": cutoff}}, {"_id": 1}
    ):
        try:
            bucket.delete(doc["_id"])
            removed += 1
        except Exception:  # noqa: BLE001 — sweep must never break a plan run
            continue
    return removed
