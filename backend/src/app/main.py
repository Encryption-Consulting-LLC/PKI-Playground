"""FastAPI application factory.

Creates the app, registers error handlers, and mounts the /api router.
The module-level ``app`` binding is what uvicorn targets via "app.main:app"
(see ``cli.py``).

The lifespan owns the Mongo client: created here (not at import) so it binds
to uvicorn's event loop, and fail-fast — an unreachable Mongo aborts boot
rather than 503ing every persistence call later.
"""

from contextlib import asynccontextmanager
from typing import AsyncIterator

from fastapi import FastAPI

from app.core.db import close_db, init_db
from app.core.errors import register_exception_handlers
from app.routers import api_router


@asynccontextmanager
async def lifespan(app: FastAPI) -> AsyncIterator[None]:
    await init_db()
    yield
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
