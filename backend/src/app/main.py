"""FastAPI application factory.

Creates the app, registers vmkit error handlers, and mounts the /api router.
The module-level ``app`` binding is what uvicorn targets via "app.main:app"
(see ``cli.py``).
"""

from fastapi import FastAPI

from app.core.errors import register_exception_handlers
from app.routers import api_router


def create_app() -> FastAPI:
    app = FastAPI(
        title="pki-deploy-api",
        version="0.1.0",
        description="HTTP API for VM/PKI deployment.",
    )
    register_exception_handlers(app)
    app.include_router(api_router)
    return app


app = create_app()
