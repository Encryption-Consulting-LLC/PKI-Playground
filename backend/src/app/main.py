"""FastAPI application factory.

Creates the app, registers error handlers, and mounts the /api router.
The module-level ``app`` binding is what uvicorn targets via "app.main:app"
(see ``cli.py``).

The lifespan owns the Mongo client: created here (not at import) so it binds
to uvicorn's event loop, and fail-fast — an unreachable Mongo aborts boot
rather than 503ing every persistence call later.

Guest-mode deploys additionally fail fast if no shared ESXi target is
resolvable after the settings-document seed: a public playground with no
target can serve nothing but errors, and there is no operator UI in that
mode to fix it at runtime. (Login-mode deploys boot without one — an
operator sets it via PUT /api/settings.)
"""

import asyncio
import contextlib
import logging
from contextlib import asynccontextmanager
from typing import AsyncIterator

from fastapi import FastAPI

from app.core.agentbus import run_dispatch_subscriber
from app.core.db import close_db, init_db
from app.core.errors import register_exception_handlers
from app.core.esxi import load_target
from app.core.secrets import SecretDecryptionError
from app.core.settings import settings
from app.routers import api_router

logger = logging.getLogger(__name__)


@asynccontextmanager
async def lifespan(app: FastAPI) -> AsyncIterator[None]:
    await init_db()
    try:
        target = await load_target()
    except SecretDecryptionError:
        # Login mode can boot degraded: an operator re-sets the password via
        # PUT /api/settings. (Guest mode falls through to the hard error below.)
        target = None
        logger.error(
            "Stored ESXi password cannot be decrypted — SETTINGS_ENC_KEY changed? "
            "Re-set the password via PUT /api/settings."
        )
    if target is None:
        if settings.auth_mode == "guest":
            raise ValueError(
                "AUTH_MODE=guest requires a shared ESXi target: set ESXI_HOST/ESXI_USER/"
                "ESXI_PASSWORD env vars for the first-boot seed (or fill the settings document)."
            )
        logger.warning(
            "No shared ESXi target configured yet — VM routes will 503 until an "
            "operator sets one via PUT /api/settings."
        )
    # Phase L: forward worker→agent dispatch requests to whichever socket this
    # process holds (the plan runner's command bridge). Runs for the app's life.
    dispatch_task = asyncio.create_task(run_dispatch_subscriber())
    try:
        yield
    finally:
        dispatch_task.cancel()
        with contextlib.suppress(asyncio.CancelledError):
            await dispatch_task
        await close_db()


def create_app() -> FastAPI:
    app = FastAPI(
        title="pki-deploy-api",
        version="0.1.0",
        description="HTTP API for VM/PKI deployment.",
        lifespan=lifespan,
    )
    register_exception_handlers(app)
    app.include_router(api_router)
    return app


app = create_app()
