"""Role and capability model, and the request-level identity dependency.

Phase B: the Role/Capability *shape* is unchanged — ``ROLE_CAPABILITIES`` is
still the single allowlist, and ``require_capability`` still the authoritative
server-side gate — but a role is now a property of the authenticated **user**
(``get_current_user``), not of the deployment. ``AUTH_MODE`` only decides how
sessions begin: ``login`` deploys take account/SSO sign-in, ``guest`` deploys
mint anonymous guest tokens.

The ``X-Session-Token`` header (and ``?token=`` on WebSockets) now carries a
backend-signed JWT (``core/identity.py``). For account-backed tokens the user
document is re-read on every request, so ``disabled: true`` or a role edit
revokes/changes access immediately despite the stateless token.

The frontend reads capabilities from ``GET /auth/me`` and uses them to
conditionally render UI, but backend enforcement is the authoritative gate —
a guest with a valid token calling an operator-only route gets 403 regardless
of what the UI shows.

To expand or restrict a role's surface, edit ROLE_CAPABILITIES only. No other
code needs to change for allowlist adjustments.
"""

import re
from enum import Enum

from fastapi import Depends, Header, HTTPException
from pydantic import BaseModel

from app.core.identity import AuthProvenance, decode_token


class Role(str, Enum):
    OPERATOR = "operator"
    GUEST = "guest"


class Capability(str, Enum):
    VM_LIST = "vm:list"
    VM_READ = "vm:read"
    VM_CLONE = "vm:clone"
    VM_UPDATE = "vm:update"
    VM_POWER = "vm:power"
    CONFIG_GENERATE = "config:generate"
    VM_EXEC_ARBITRARY = "vm:exec-arbitrary"  # reserved — wired in by the orchestrator phase
    DEPLOY = "deploy"
    PROJECT_READ = "project:read"
    PROJECT_WRITE = "project:write"
    SETTINGS_READ = "settings:read"
    SETTINGS_WRITE = "settings:write"
    REGISTRY_READ = "registry:read"
    REGISTRY_WRITE = "registry:write"
    USER_ADMIN = "user:admin"


# Tune the allowlist here.
# Operator → everything.
# Guest    → read/guided VM subset only.
#   CONFIG_GENERATE is operator-only: config is produced server-side on the
#     guest's behalf (not via a guest-invoked endpoint).
#   VM_EXEC_ARBITRARY is reserved for the firstboot orchestrator (future phase).
#   DEPLOY is guest-eligible: the plan runner only does what a guest can already
#     trigger directly (clones) plus simulated stub ops.
#   PROJECT_* / SETTINGS_* / REGISTRY_* (Mongo persistence) are operator-only:
#     guests keep client-side (localStorage) persistence, so the shared guest
#     deploy never exposes a cross-visitor project list.
#   USER_ADMIN (account provisioning) is operator-only by construction.
ROLE_CAPABILITIES: dict[Role, set[Capability]] = {
    Role.OPERATOR: set(Capability),
    Role.GUEST: {
        Capability.VM_LIST,
        Capability.VM_READ,
        Capability.VM_CLONE,
        Capability.DEPLOY,
    },
}


class AuthedUser(BaseModel):
    """The resolved identity behind a request — what ``get_current_user`` yields."""

    username: str
    role: Role
    auth: AuthProvenance


def capabilities_for(role: Role) -> list[str]:
    """Sorted list of capability strings for the given role — used in API responses."""
    return sorted(c.value for c in ROLE_CAPABILITIES[role])


async def resolve_user_token(token: str | None) -> AuthedUser | None:
    """Token string → AuthedUser, or None if invalid/expired/disabled.

    Shared by the header dependency below and the WebSocket routes (browsers
    can't set custom headers on the upgrade request, so those authenticate via
    a query param).

    Anonymous guest tokens (``auth: guest``) have no user document — their
    role comes from the claim. Account-backed tokens re-read the user doc so
    ``disabled`` and role edits apply immediately; the token's own role claim
    is deliberately ignored in that path.
    """
    if not token:
        return None
    payload = decode_token(token)
    if payload is None:
        return None

    if payload["auth"] == "guest":
        return AuthedUser(username=payload["sub"], role=Role.GUEST, auth="guest")

    from app.core.db import users_col  # deferred: keep authz importable without Mongo init

    doc = await users_col().find_one({"username": payload["sub"]})
    if doc is None or doc.get("disabled"):
        return None
    return AuthedUser(username=doc["username"], role=Role(doc["role"]), auth=payload["auth"])


async def get_current_user(x_session_token: str = Header(...)) -> AuthedUser:
    """FastAPI dependency: resolve X-Session-Token → AuthedUser (401 if invalid)."""
    user = await resolve_user_token(x_session_token)
    if user is None:
        raise HTTPException(status_code=401, detail="Invalid or expired session token.")
    return user


def require_capability(cap: Capability):
    """FastAPI dependency factory.

    Usage::
        @router.get("/thing", dependencies=[Depends(require_capability(Capability.VM_LIST))])
        def list_things(...): ...

    Authenticates the request (via ``get_current_user`` — FastAPI caches it
    per-request, so pairing this with other identity-consuming dependencies
    costs one resolution) and raises HTTP 403 if the user's role lacks ``cap``.
    """

    def _dep(user: AuthedUser = Depends(get_current_user)) -> None:
        if cap not in ROLE_CAPABILITIES[user.role]:
            raise HTTPException(
                status_code=403,
                detail=(
                    f"Role '{user.role.value}' does not have"
                    f" capability '{cap.value}'."
                ),
            )

    return _dep


_GUEST_VM_SUFFIX = re.compile(r"^[A-Za-z0-9-]{1,32}$")
_UNSAFE_NAME_CHARS = re.compile(r"[^A-Za-z0-9-]")


def _guest_namespace(user: AuthedUser) -> str:
    """Stable per-identity VM-name prefix, derived server-side from the
    authenticated username (never trusted from the client)."""
    slug = _UNSAFE_NAME_CHARS.sub("-", user.username)[:12].strip("-") or "anon"
    return f"guest-{slug}-"


def enforce_guest_vm_name(name: str, user: AuthedUser) -> str:
    """Force a guest-role VM name into the caller's own namespace before it
    reaches a real clone.

    The prefix is derived from the caller's *own* authenticated identity —
    otherwise a guest could spoof another user's namespace or pick an
    arbitrary, non-guest-looking name that collides with / shadows unrelated
    inventory. If the client already sent a correctly-prefixed name it's
    passed through unchanged (mod stripping and re-adding the prefix);
    anything else is treated as the whole requested suffix and validated
    against a safe charset. Operators are trusted and pass through unchanged.
    Raises 422 on an invalid suffix.
    """
    if user.role != Role.GUEST:
        return name
    prefix = _guest_namespace(user)
    suffix = name[len(prefix):] if name.startswith(prefix) else name
    if not _GUEST_VM_SUFFIX.match(suffix):
        raise HTTPException(422, detail="Invalid VM name.")
    return f"{prefix}{suffix}"
