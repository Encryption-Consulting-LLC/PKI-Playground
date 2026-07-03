"""Identity primitives — password hashing and session-JWT mint/verify.

Pure helpers with no FastAPI or Mongo coupling; the request-facing
``get_current_user`` dependency lives in ``core/authz.py`` (which imports
this module, never the reverse — that one-way import is what keeps the
Role/Capability model and these primitives from forming a cycle).

Tokens are backend-minted HS256 JWTs (``SESSION_SECRET``), carrying:
  ``sub``   — username (or a synthetic ``guest-…`` id for anonymous guests)
  ``role``  — Role value at mint time; re-resolved from the user doc on every
              request for account-backed tokens, so a role edit or ``disabled``
              flag takes effect immediately (the claim is a fallback only for
              anonymous guests, who have no user doc).
  ``auth``  — provenance: ``local`` | ``oidc`` | ``guest``
  ``exp``   — ``SESSION_TTL_HOURS`` from mint; there is no refresh flow —
              an expired token means logging in again.
"""

import time
from typing import Any, Literal

import jwt
from pwdlib import PasswordHash

from app.core.settings import settings

AuthProvenance = Literal["local", "oidc", "guest"]

_JWT_ALGORITHM = "HS256"

# Argon2id with pwdlib's recommended parameters.
_password_hash = PasswordHash.recommended()

#: Hash verified against when the username doesn't exist, so a login attempt
#: costs the same wall-clock either way (no username-oracle timing).
_DUMMY_HASH = _password_hash.hash("invalid-password-placeholder")


def hash_password(password: str) -> str:
    return _password_hash.hash(password)


def verify_password(password: str, password_hash: str | None) -> bool:
    """Constant-shape verify: absent hash (unknown user / OIDC account) still
    burns one Argon2 verification before returning False."""
    if password_hash is None:
        _password_hash.verify(password, _DUMMY_HASH)
        return False
    return _password_hash.verify(password, password_hash)


def mint_token(sub: str, role: str, auth: AuthProvenance) -> str:
    now = int(time.time())
    payload = {
        "sub": sub,
        "role": role,
        "auth": auth,
        "iat": now,
        "exp": now + settings.session_ttl_hours * 3600,
    }
    return jwt.encode(payload, settings.session_secret, algorithm=_JWT_ALGORITHM)


def decode_token(token: str) -> dict[str, Any] | None:
    """Verify signature + expiry; None on any failure (callers 401)."""
    try:
        return jwt.decode(
            token,
            settings.session_secret,
            algorithms=[_JWT_ALGORITHM],
            options={"require": ["sub", "role", "auth", "exp"]},
        )
    except jwt.InvalidTokenError:
        return None
