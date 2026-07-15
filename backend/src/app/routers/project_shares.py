"""Guest-to-guest project sharing.

Guest projects remain device-local and are never exposed through the operator
``/projects`` collection. A share is an explicit, opaque-id snapshot: opening
its URL reveals only metadata until the receiving guest accepts it. Acceptance
adds that account as a collaborator and returns the project snapshot.

This is deliberately guest-only for now. Operators continue to use the normal
Mongo-backed project API and cannot accidentally import a guest snapshot into
that global project list.
"""

from typing import Annotated

from fastapi import APIRouter, Depends, HTTPException, Path

from app.core.authz import AuthedUser, Role, get_current_user
from app.core.db import now_ms, project_shares_col
from app.routers.projects import ProjectIn

router = APIRouter(prefix="/project-shares", tags=["project-shares"])

ProjectId = Annotated[str, Path(pattern=r"^[A-Za-z0-9-]{8,64}$")]


def _require_guest(user: AuthedUser = Depends(get_current_user)) -> AuthedUser:
    if user.role != Role.GUEST:
        raise HTTPException(
            status_code=403,
            detail="Project sharing is currently available to guests only.",
        )
    return user


def _metadata(doc: dict, user: AuthedUser) -> dict:
    owner = doc["owner"]
    return {
        "projectId": doc["_id"],
        "name": doc["project"]["name"],
        "isOwner": owner == user.username,
        "isCollaborator": user.username in doc.get("collaborators", []),
        "updatedAt": doc["updatedAt"],
    }


@router.put("/{project_id}")
async def publish_project(
    project_id: ProjectId,
    body: ProjectIn,
    user: AuthedUser = Depends(_require_guest),
) -> dict:
    """Create a link or refresh its snapshot.

    The project UUID is already an unguessable browser-generated value, so it
    doubles as the share id. Only its owner and guests who explicitly accepted
    that link may replace the shared snapshot.
    """

    if body.id is not None and body.id != project_id:
        raise HTTPException(422, detail="Project id does not match the share link.")

    collection = project_shares_col()
    existing = await collection.find_one(
        {"_id": project_id}, projection={"owner": 1, "collaborators": 1, "createdAt": 1}
    )
    if existing is not None:
        allowed = existing["owner"] == user.username or user.username in existing.get(
            "collaborators", []
        )
        if not allowed:
            raise HTTPException(
                status_code=403,
                detail="Accept this project link before publishing changes.",
            )

    now = now_ms()
    project = body.model_dump(by_alias=True, exclude={"id"})
    project["id"] = project_id
    if existing is None:
        stored = {
            "_id": project_id,
            "owner": user.username,
            "collaborators": [],
            "project": project,
            "createdAt": now,
            "updatedAt": now,
            "schemaVersion": 1,
        }
        await collection.insert_one(stored)
    else:
        await collection.update_one(
            {"_id": project_id},
            {"$set": {"project": project, "updatedAt": now}},
        )
        stored = {
            **existing,
            "_id": project_id,
            "project": project,
            "updatedAt": now,
        }
    return _metadata(stored, user)


@router.get("/{project_id}")
async def inspect_share(
    project_id: ProjectId,
    user: AuthedUser = Depends(_require_guest),
) -> dict:
    """Return prompt metadata without disclosing the project snapshot."""

    doc = await project_shares_col().find_one(
        {"_id": project_id},
        projection={
            "owner": 1,
            "collaborators": 1,
            "project.name": 1,
            "updatedAt": 1,
        },
    )
    if doc is None:
        raise HTTPException(404, detail=f"Shared project '{project_id}' not found.")
    return _metadata(doc, user)


@router.post("/{project_id}/accept")
async def accept_share(
    project_id: ProjectId,
    user: AuthedUser = Depends(_require_guest),
) -> dict:
    """Accept a share and return its current full snapshot."""

    collection = project_shares_col()
    doc = await collection.find_one({"_id": project_id})
    if doc is None:
        raise HTTPException(404, detail=f"Shared project '{project_id}' not found.")

    if doc["owner"] != user.username:
        await collection.update_one(
            {"_id": project_id},
            {"$addToSet": {"collaborators": user.username}},
        )

    # ProjectIn strips client-only dirty/updatedAt fields on publish. Stamp an
    # updatedAt for the frontend's normal ProjectDoc deserializer.
    return {
        **doc["project"],
        "id": project_id,
        "createdAt": doc["createdAt"],
        "updatedAt": doc["updatedAt"],
    }
