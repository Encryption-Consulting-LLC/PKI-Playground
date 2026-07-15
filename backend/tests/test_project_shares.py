"""Guest project-share ownership and acceptance semantics."""

import asyncio
import os

import pytest
from fastapi import HTTPException

os.environ.setdefault("SESSION_SECRET", "test-session-secret")
os.environ.setdefault(
    "SETTINGS_ENC_KEY", "MDEyMzQ1Njc4OWFiY2RlZjAxMjM0NTY3ODlhYmNkZWY="
)

from app.core.authz import AuthedUser, Role  # noqa: E402
from app.routers import project_shares  # noqa: E402
from app.routers.projects import ProjectIn  # noqa: E402


class _FakeCollection:
    def __init__(self) -> None:
        self.docs: dict[str, dict] = {}

    async def find_one(self, query: dict, projection: dict | None = None):
        doc = self.docs.get(query["_id"])
        # Returning a copy is enough for these routes; the production Mongo
        # projection only reduces fields and never changes their shape.
        return dict(doc) if doc is not None else None

    async def insert_one(self, doc: dict):
        self.docs[doc["_id"]] = dict(doc)

    async def update_one(self, query: dict, update: dict):
        doc = self.docs[query["_id"]]
        doc.update(update.get("$set", {}))
        for field, value in update.get("$addToSet", {}).items():
            if value not in doc.setdefault(field, []):
                doc[field].append(value)


def _guest(username: str) -> AuthedUser:
    return AuthedUser(username=username, role=Role.GUEST, auth="local")


def _project(project_id: str, name: str = "Shared PKI") -> ProjectIn:
    return ProjectIn(id=project_id, name=name)


def test_share_hides_snapshot_until_another_guest_accepts(monkeypatch):
    collection = _FakeCollection()
    monkeypatch.setattr(project_shares, "project_shares_col", lambda: collection)
    project_id = "12345678-abcd-4321-abcd-123456789abc"

    published = asyncio.run(
        project_shares.publish_project(project_id, _project(project_id), _guest("alice"))
    )
    inspected = asyncio.run(project_shares.inspect_share(project_id, _guest("bob")))

    assert published["isOwner"] is True
    assert inspected == {
        "projectId": project_id,
        "name": "Shared PKI",
        "isOwner": False,
        "isCollaborator": False,
        "updatedAt": published["updatedAt"],
    }
    assert "nodes" not in inspected

    accepted = asyncio.run(project_shares.accept_share(project_id, _guest("bob")))
    assert accepted["id"] == project_id
    assert accepted["name"] == "Shared PKI"
    assert collection.docs[project_id]["collaborators"] == ["bob"]


def test_only_owner_or_accepted_collaborator_can_refresh_share(monkeypatch):
    collection = _FakeCollection()
    monkeypatch.setattr(project_shares, "project_shares_col", lambda: collection)
    project_id = "87654321-abcd-4321-abcd-123456789abc"
    asyncio.run(
        project_shares.publish_project(project_id, _project(project_id), _guest("alice"))
    )

    with pytest.raises(HTTPException) as exc:
        asyncio.run(
            project_shares.publish_project(
                project_id, _project(project_id, "Unauthorized edit"), _guest("bob")
            )
        )
    assert exc.value.status_code == 403

    asyncio.run(project_shares.accept_share(project_id, _guest("bob")))
    refreshed = asyncio.run(
        project_shares.publish_project(
            project_id, _project(project_id, "Bob's edit"), _guest("bob")
        )
    )
    assert refreshed["isCollaborator"] is True
    assert collection.docs[project_id]["project"]["name"] == "Bob's edit"


def test_operator_is_rejected_from_guest_sharing():
    operator = AuthedUser(username="operator", role=Role.OPERATOR, auth="local")

    with pytest.raises(HTTPException) as exc:
        project_shares._require_guest(operator)

    assert exc.value.status_code == 403
