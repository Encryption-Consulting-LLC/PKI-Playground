"""Aggregates all routers under the /api prefix.

Import ``api_router`` and call ``app.include_router(api_router)`` in the app
factory. Adding a new feature area means: create ``routers/foo.py`` with a
``router = APIRouter(...)`` and include it here.
"""

from fastapi import APIRouter

from app.routers import auth, config, meta, vm, ws

api_router = APIRouter(prefix="/api")

for _router in (meta.router, config.router, auth.router, vm.router, ws.router):
    api_router.include_router(_router)
