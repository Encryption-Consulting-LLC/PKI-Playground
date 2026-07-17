"""Employee SSO — generic OIDC authorization-code flow, backend-mediated.

Works unmodified with Keycloak and Azure AD (anything with standard OIDC
discovery): configure by issuer URL, and map IdP groups to the internal
``Role`` by exact string compare (Keycloak group names and Azure AD group
object-ids both fit). A user matching no configured group is rejected — never
silently defaulted to guest.

Flow (the client secret never leaves this process):
  1. ``GET /auth/oidc/login`` → we mint a short-lived signed *state* JWT
     (CSRF + nonce carrier — nothing stored server-side) and return the IdP
     authorization URL.
  2. The SPA redirects; the IdP calls back to the frontend with
     ``?code&state``; the SPA posts both to ``POST /auth/oidc/callback``.
  3. We verify the state JWT, exchange the code at the token endpoint,
     validate the ID token against the issuer's JWKS (signature, audience,
     issuer, nonce), map groups → Role, upsert the ``users`` doc, and mint
     the same backend session JWT local login produces.

Discovery metadata and the JWKS client are cached for the process lifetime —
key rotation at the IdP is handled by PyJWKClient's own JWKS refresh.
"""

import time
import uuid
from typing import Any
from urllib.parse import urlencode

import httpx
import jwt
from fastapi import HTTPException
from starlette.concurrency import run_in_threadpool

from app.core.settings import settings

_STATE_TTL_SECONDS = 600
_STATE_ALGORITHM = "HS256"

_discovery_cache: dict[str, Any] | None = None
_jwks_client: jwt.PyJWKClient | None = None


def require_oidc() -> None:
    if not settings.oidc_enabled:
        raise HTTPException(
            status_code=403,
            detail="SSO is not configured on this deploy (OIDC_* env vars).",
        )


async def _discovery() -> dict[str, Any]:
    global _discovery_cache
    if _discovery_cache is None:
        url = settings.oidc_issuer.rstrip("/") + "/.well-known/openid-configuration"  # type: ignore[union-attr]
        async with httpx.AsyncClient(timeout=10) as client:
            resp = await client.get(url)
            resp.raise_for_status()
        _discovery_cache = resp.json()
    return _discovery_cache


def _split_groups(csv: str) -> set[str]:
    return {g.strip() for g in csv.split(",") if g.strip()}


def map_groups_to_role(groups: list[str]) -> str:
    """IdP group values → internal role string; 403 if nothing matches.

    Operator wins on overlap. Returns the plain string (``authz.Role`` value)
    to keep this module import-light.
    """
    memberships = set(groups)
    if memberships & _split_groups(settings.oidc_operator_groups):
        return "operator"
    if memberships & _split_groups(settings.oidc_guest_groups):
        return "guest"
    raise HTTPException(
        status_code=403,
        detail="Your SSO account belongs to no group mapped to a role on this deploy.",
    )


def mint_state() -> tuple[str, str]:
    """Signed, self-contained state parameter: CSRF token + ID-token nonce.
    Returns ``(state_jwt, nonce)``."""
    now = int(time.time())
    nonce = uuid.uuid4().hex
    state = jwt.encode(
        {
            "purpose": "oidc-state",
            "nonce": nonce,
            "iat": now,
            "exp": now + _STATE_TTL_SECONDS,
        },
        settings.session_secret,
        algorithm=_STATE_ALGORITHM,
    )
    return state, nonce


def verify_state(state: str) -> str:
    """Validate the round-tripped state JWT; returns the embedded nonce."""
    try:
        payload = jwt.decode(
            state,
            settings.session_secret,
            algorithms=[_STATE_ALGORITHM],
            options={"require": ["exp", "nonce", "purpose"]},
        )
    except jwt.InvalidTokenError:
        payload = {}
    if payload.get("purpose") != "oidc-state":
        raise HTTPException(status_code=401, detail="Invalid or expired SSO state.")
    return payload["nonce"]


async def build_authorization_url() -> str:
    """The IdP authorization URL the SPA should redirect to."""
    meta = await _discovery()
    state, nonce = mint_state()
    query = urlencode(
        {
            "response_type": "code",
            "client_id": settings.oidc_client_id,
            "redirect_uri": settings.oidc_redirect_uri,
            "scope": "openid profile email",
            "state": state,
            "nonce": nonce,
        }
    )
    return f"{meta['authorization_endpoint']}?{query}"


async def exchange_code(code: str) -> dict[str, Any]:
    """Authorization code → token response (client_secret_post)."""
    meta = await _discovery()
    async with httpx.AsyncClient(timeout=15) as client:
        resp = await client.post(
            meta["token_endpoint"],
            data={
                "grant_type": "authorization_code",
                "code": code,
                "redirect_uri": settings.oidc_redirect_uri,
                "client_id": settings.oidc_client_id,
                "client_secret": settings.oidc_client_secret,
            },
        )
    if resp.status_code != 200:
        raise HTTPException(
            status_code=401, detail="SSO code exchange was rejected by the IdP."
        )
    return resp.json()


async def validate_id_token(id_token: str, nonce: str) -> dict[str, Any]:
    """Verify the ID token's signature (issuer JWKS), audience, issuer, and
    nonce; returns its claims. JWKS fetching is blocking → threadpool."""
    global _jwks_client
    meta = await _discovery()
    if _jwks_client is None:
        _jwks_client = jwt.PyJWKClient(meta["jwks_uri"])
    try:
        signing_key = await run_in_threadpool(
            _jwks_client.get_signing_key_from_jwt, id_token
        )
        claims = jwt.decode(
            id_token,
            signing_key.key,
            algorithms=["RS256", "ES256"],
            audience=settings.oidc_client_id,
            issuer=meta["issuer"],
        )
    except jwt.PyJWTError:
        raise HTTPException(status_code=401, detail="SSO ID token failed validation.")
    if claims.get("nonce") != nonce:
        raise HTTPException(status_code=401, detail="SSO ID token failed validation.")
    return claims


def username_from_claims(claims: dict[str, Any]) -> str:
    """Stable account key: preferred_username, else email, else subject."""
    return claims.get("preferred_username") or claims.get("email") or claims["sub"]
