"""Guest IP pool inspection (Phase G).

Read-only view of the per-address allocation documents ``core/ippool.py``
maintains. Gated on ``REGISTRY_READ`` — like the VM registry, this is runtime
allocation state (which VM holds which address), not target configuration;
the pool's *range* is configured via the settings routes.
"""

from fastapi import APIRouter, Depends

from app.core.authz import Capability, require_capability
from app.core.ippool import list_pool_async

router = APIRouter(prefix="/ip-pool", tags=["ip-pool"])


@router.get("", dependencies=[Depends(require_capability(Capability.REGISTRY_READ))])
async def list_pool() -> dict:
    return await list_pool_async()
