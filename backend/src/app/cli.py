import argparse
import getpass
import sys

import uvicorn

from app.celery_app import celery_app


def main() -> None:
    uvicorn.run("app.main:app", reload=True)


def worker() -> None:
    celery_app.worker_main(
        argv=["worker", "-E", "--concurrency=2", "--prefetch-multiplier=1"]
    )


def create_admin() -> None:
    """Bootstrap CLI: provision the first operator account (``uv run create-admin``).

    Exists because account creation is otherwise gated behind an operator
    session — a fresh deploy has no operator to mint one. Sync PyMongo on
    purpose: this runs outside the API process/event loop.
    """
    from pymongo import MongoClient
    from pymongo.errors import DuplicateKeyError

    from app.core.db.models import UserDoc, now_ms, to_mongo
    from app.core.identity import hash_password
    from app.core.settings import settings

    parser = argparse.ArgumentParser(description="Provision an operator account.")
    parser.add_argument("username")
    parser.add_argument("--email", default=None)
    parser.add_argument("--role", choices=("operator", "guest"), default="operator")
    args = parser.parse_args()

    password = getpass.getpass("Password: ")
    if len(password) < 8:
        sys.exit("Password must be at least 8 characters.")
    if getpass.getpass("Repeat password: ") != password:
        sys.exit("Passwords do not match.")

    doc = UserDoc(
        id=args.username,
        username=args.username,
        email=args.email,
        password_hash=hash_password(password),
        role=args.role,
        auth="local",
        created_at=now_ms(),
        updated_at=now_ms(),
    )
    client: MongoClient = MongoClient(settings.mongo_url, serverSelectionTimeoutMS=5000)
    try:
        client[settings.mongo_db]["users"].insert_one(to_mongo(doc))
    except DuplicateKeyError:
        sys.exit(f"User '{args.username}' already exists.")
    finally:
        client.close()
    print(f"Created {args.role} account '{args.username}'.")
