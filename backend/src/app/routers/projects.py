"""Project CRUD — the persistence surface behind the frontend's project tabs.

A project document is the frontend's ``Project`` snapshot (see
``frontend/src/store/projects.ts``): the canvas graph, counters, viewport, and
staged ops. The graph payloads are stored as opaque validated blobs — React
Flow internals are not modeled server-side.

Operator-only (``PROJECT_*`` capabilities): guests keep localStorage
persistence client-side, so the shared guest deploy never exposes a
cross-visitor project list.

Concurrency is last-write-wins — single-operator deployment, one browser tab
writes. A rev/If-Match check can slot into PUT when multi-user lands.
"""

import uuid
from typing import Any

from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel, ConfigDict, Field

from app.core.authz import Capability, require_capability
from app.core.db import ProjectDoc, Viewport, from_mongo, now_ms, projects_col, to_mongo

router = APIRouter(prefix="/projects", tags=["projects"])


class ProjectIn(BaseModel):
    """Client project snapshot.

    ``dirty`` and client ``updatedAt`` are intentionally absent — pydantic
    drops unknown keys, so the frontend can send its ``Project`` object
    verbatim and the server stamps its own timestamps.
    """

    model_config = ConfigDict(populate_by_name=True)

    # POST only; ignored on PUT (the path param wins). The frontend generates
    # crypto.randomUUID() ids, so tabs render synchronously before the create
    # round-trips.
    id: str | None = Field(default=None, pattern=r"^[A-Za-z0-9-]{8,64}$")
    name: str = Field(min_length=1, max_length=120)
    nodes: list[dict[str, Any]] = Field(default_factory=list, max_length=200)
    edges: list[dict[str, Any]] = Field(default_factory=list, max_length=500)
    counters: dict[str, int] = Field(default_factory=dict)
    viewport: Viewport = Field(default_factory=Viewport)
    staged_ops: list[dict[str, Any]] = Field(
        default_factory=list, max_length=50, alias="stagedOps"
    )
    deploy_job_id: str | None = Field(default=None, alias="deployJobId")


@router.get("", dependencies=[Depends(require_capability(Capability.PROJECT_READ))])
async def list_projects() -> dict:
    """Summaries only, newest first — the full graphs stay out of the tab bar."""
    cursor = (
        projects_col()
        .find(
            {},
            projection={"name": 1, "createdAt": 1, "updatedAt": 1, "schemaVersion": 1},
        )
        .sort("updatedAt", -1)
    )
    docs = await cursor.to_list(length=200)
    return {"projects": [from_mongo(d) for d in docs], "count": len(docs)}


@router.post(
    "",
    status_code=201,
    dependencies=[Depends(require_capability(Capability.PROJECT_WRITE))],
)
async def create_project(body: ProjectIn) -> dict:
    """Create a project. A duplicate id raises DuplicateKeyError → 409."""
    now = now_ms()
    doc = ProjectDoc(
        id=body.id or uuid.uuid4().hex,
        name=body.name,
        nodes=body.nodes,
        edges=body.edges,
        counters=body.counters,
        viewport=body.viewport,
        staged_ops=body.staged_ops,
        deploy_job_id=body.deploy_job_id,
        created_at=now,
        updated_at=now,
    )
    stored = to_mongo(doc)
    await projects_col().insert_one(stored)
    return from_mongo(stored)


@router.get(
    "/{project_id}",
    dependencies=[Depends(require_capability(Capability.PROJECT_READ))],
)
async def get_project(project_id: str) -> dict:
    doc = await projects_col().find_one({"_id": project_id})
    if doc is None:
        raise HTTPException(404, detail=f"Project '{project_id}' not found.")
    return from_mongo(doc)


@router.put(
    "/{project_id}",
    dependencies=[Depends(require_capability(Capability.PROJECT_WRITE))],
)
async def update_project(project_id: str, body: ProjectIn) -> dict:
    """Full-snapshot replace (matches the frontend's checkpoint semantics).

    No upsert — creation stays explicit via POST; 404 if the project is gone.
    ``createdAt``/``owner``/``schemaVersion`` are preserved from the stored doc.
    """
    existing = await projects_col().find_one(
        {"_id": project_id},
        projection={"createdAt": 1, "owner": 1, "schemaVersion": 1},
    )
    if existing is None:
        raise HTTPException(404, detail=f"Project '{project_id}' not found.")

    doc = ProjectDoc(
        id=project_id,
        name=body.name,
        nodes=body.nodes,
        edges=body.edges,
        counters=body.counters,
        viewport=body.viewport,
        staged_ops=body.staged_ops,
        deploy_job_id=body.deploy_job_id,
        owner=existing.get("owner"),
        schema_version=existing.get("schemaVersion", 1),
        created_at=existing["createdAt"],
        updated_at=now_ms(),
    )
    stored = to_mongo(doc)
    await projects_col().replace_one({"_id": project_id}, stored)
    return from_mongo(stored)


@router.delete(
    "/{project_id}",
    status_code=204,
    dependencies=[Depends(require_capability(Capability.PROJECT_WRITE))],
)
async def delete_project(project_id: str) -> None:
    result = await projects_col().delete_one({"_id": project_id})
    if result.deleted_count == 0:
        raise HTTPException(404, detail=f"Project '{project_id}' not found.")
