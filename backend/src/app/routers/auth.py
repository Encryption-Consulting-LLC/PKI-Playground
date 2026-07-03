"""Auth routes — identity-based session lifecycle and deploy-mode discovery.

Phase B replaced "ESXi credentials are the login" with a real identity layer;
which ESXi host gets used is a separate, shared org-wide setting
(``core/esxi.py``). Session bootstrap by deploy mode (AUTH_MODE env var):

  login (internal)
    POST /auth/login          — admin-provisioned username/password; returns a JWT.
    GET  /auth/oidc/login     — employee SSO: returns the IdP redirect URL (if configured).
    POST /auth/oidc/callback  — completes the SSO code flow; returns a JWT.
    POST /auth/guest          — 403 (not available in login mode)

  guest (public playground)
    POST /auth/guest          — mints an anonymous guest-role JWT; no account involved.
    POST /auth/login          — 403 (no accounts on a public playground deploy)

  both
    GET  /auth/mode           — unauthenticated discovery: {"mode", "oidcEnabled"}.
                                (Capabilities moved to /auth/me — they depend on
                                who logged in, which /mode can't know.)
    GET  /auth/me             — the authenticated user's identity + capability list.
    POST /auth/logout         — client-side token discard acknowledgement. Tokens
                                are stateless JWTs, so there is nothing server-side
                                to drop; disabling the account is the kill switch.
    POST /auth/connect        — 410 Gone (the pre-Phase-B ESXi-credential login).

Passwords travel only in the /auth/login request body; what's stored is an
Argon2id hash in the users collection. Account-backed tokens are re-checked
against the user document on every request (``core/authz.py``), so disabling
an account revokes access immediately despite JWT statelessness.
"""

import uuid

from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel

from app.core import oidc
from app.core.authz import AuthedUser, Role, capabilities_for, get_current_user
from app.core.db import now_ms, to_mongo, users_col
from app.core.db.models import UserDoc
from app.core.esxi import load_target
from app.core.identity import AuthProvenance, mint_token, verify_password
from app.core.settings import settings

router = APIRouter(prefix="/auth", tags=["auth"])


# --------------------------------------------------------------------------- #
# Mode discovery (unauthenticated — called by the frontend on every load)     #
# --------------------------------------------------------------------------- #


@router.get("/mode")
def get_mode() -> dict:
    """Return the deploy's auth mode and whether SSO is available.

    The frontend uses ``mode`` to decide login-form vs guest auto-connect and
    ``oidcEnabled`` to show the SSO button. Role/capabilities are per-user now
    — fetch them from ``GET /auth/me`` after signing in.
    """
    return {"mode": settings.auth_mode, "oidcEnabled": settings.oidc_enabled}


# --------------------------------------------------------------------------- #
# Session lifecycle                                                            #
# --------------------------------------------------------------------------- #


class LoginRequest(BaseModel):
    username: str
    password: str


async def _session_response(username: str, role: Role, auth: AuthProvenance) -> dict:
    """Uniform shape for every token-minting route (local, OIDC, guest)."""
    target = await load_target()
    return {
        "token": mint_token(username, role.value, auth),
        "username": username,
        "role": role.value,
        "capabilities": capabilities_for(role),
        "host": target.host if target else None,
    }


@router.post("/login")
async def login(req: LoginRequest) -> dict:
    """Password login against the admin-provisioned users collection.

    403 in guest mode (a public playground has no accounts). A uniform 401
    for unknown username / wrong password / disabled account / OIDC-only
    account — and ``verify_password`` burns one Argon2 verification even for
    unknown usernames, so responses don't oracle which part failed.
    """
    if settings.auth_mode == "guest":
        raise HTTPException(
            status_code=403,
            detail="Account login is not available in guest mode.",
        )
    doc = await users_col().find_one({"username": req.username})
    valid = verify_password(req.password, (doc or {}).get("passwordHash"))
    if not valid or doc is None or doc.get("disabled"):
        raise HTTPException(status_code=401, detail="Invalid username or password.")
    return await _session_response(doc["username"], Role(doc["role"]), "local")


@router.post("/logout")
def logout() -> dict:
    """Acknowledge a client-side token discard (stateless JWTs — nothing to drop)."""
    return {"status": "logged_out"}


@router.get("/me")
async def me(user: AuthedUser = Depends(get_current_user)) -> dict:
    """The authenticated identity and its capability allowlist (what ``useCan`` reads)."""
    return {
        "username": user.username,
        "role": user.role.value,
        "auth": user.auth,
        "capabilities": capabilities_for(user.role),
    }


@router.post("/connect")
def connect_gone() -> None:
    """The pre-Phase-B ESXi-credential login. Kept as an explicit tombstone so
    stale clients get an actionable error instead of a bare 404."""
    raise HTTPException(
        status_code=410,
        detail="ESXi-credential login was removed — sign in via /auth/login or SSO.",
    )


# --------------------------------------------------------------------------- #
# Guest-mode endpoint                                                          #
# --------------------------------------------------------------------------- #


@router.post("/guest")
async def guest_connect() -> dict:
    """Mint an anonymous guest-role session (guest mode only).

    The frontend calls this automatically on load. No user document is
    involved; the synthetic ``sub`` seeds the per-visitor VM-name namespace
    (``authz.enforce_guest_vm_name``). Raises 403 in login mode.
    """
    if settings.auth_mode == "login":
        raise HTTPException(
            status_code=403,
            detail="Guest auto-connect is not available in login mode.",
        )
    sub = f"guest-{uuid.uuid4().hex[:12]}"
    return await _session_response(sub, Role.GUEST, "guest")


# --------------------------------------------------------------------------- #
# Employee SSO (generic OIDC — Keycloak / Azure AD)                            #
# --------------------------------------------------------------------------- #


class OidcCallbackRequest(BaseModel):
    code: str
    state: str


@router.get("/oidc/login")
async def oidc_login() -> dict:
    """Start the SSO code flow: the SPA redirects to the returned URL."""
    oidc.require_oidc()
    if settings.auth_mode == "guest":
        raise HTTPException(status_code=403, detail="SSO is not available in guest mode.")
    return {"url": await oidc.build_authorization_url()}


@router.post("/oidc/callback")
async def oidc_callback(req: OidcCallbackRequest) -> dict:
    """Complete the SSO code flow: verify state, exchange the code, validate
    the ID token, map IdP groups → Role, upsert the user, mint a session."""
    oidc.require_oidc()
    if settings.auth_mode == "guest":
        raise HTTPException(status_code=403, detail="SSO is not available in guest mode.")

    nonce = oidc.verify_state(req.state)
    tokens = await oidc.exchange_code(req.code)
    claims = await oidc.validate_id_token(tokens.get("id_token", ""), nonce)

    role = Role(oidc.map_groups_to_role(claims.get(settings.oidc_group_claim) or []))
    username = oidc.username_from_claims(claims)

    # Upsert: first SSO login creates the account; later logins refresh
    # email/role from the IdP but preserve a locally-set ``disabled`` flag.
    existing = await users_col().find_one({"username": username})
    if existing is None:
        doc = UserDoc(
            id=username,
            username=username,
            email=claims.get("email"),
            role=role.value,  # type: ignore[arg-type]
            auth="oidc",
            created_at=now_ms(),
            updated_at=now_ms(),
        )
        await users_col().insert_one(to_mongo(doc))
    else:
        if existing.get("disabled"):
            raise HTTPException(status_code=403, detail="This account is disabled.")
        await users_col().update_one(
            {"username": username},
            {"$set": {"email": claims.get("email"), "role": role.value, "updatedAt": now_ms()}},
        )
    return await _session_response(username, role, "oidc")
