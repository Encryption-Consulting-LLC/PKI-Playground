"""Role and capability model — deployment-level, not per-token.

A given deploy has exactly one role, implied by AUTH_MODE:
  ``login`` → operator  (full surface)
  ``guest`` → guest     (allowlisted subset only)

The ``require_capability`` FastAPI dependency enforces the allowlist server-side.
The frontend reads capabilities from ``GET /auth/mode`` and uses them to
conditionally render UI, but backend enforcement is the authoritative gate —
a guest with a valid token calling an operator-only route gets 403 regardless of
what the UI shows.

To expand or restrict a role's surface, edit ROLE_CAPABILITIES only. No other
code needs to change for allowlist adjustments.
"""

import re
from enum import Enum

from fastapi import HTTPException

from app.core.settings import settings


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


# Tune the allowlist here.
# Operator → everything.
# Guest    → read/guided VM subset only.
#   CONFIG_GENERATE is operator-only: config is produced server-side on the
#     guest's behalf (not via a guest-invoked endpoint).
#   VM_EXEC_ARBITRARY is reserved for the firstboot orchestrator (future phase).
#   DEPLOY is guest-eligible: the plan runner only does what a guest can already
#     trigger directly (clones) plus simulated stub ops.
ROLE_CAPABILITIES: dict[Role, set[Capability]] = {
    Role.OPERATOR: set(Capability),
    Role.GUEST: {
        Capability.VM_LIST,
        Capability.VM_READ,
        Capability.VM_CLONE,
        Capability.DEPLOY,
    },
}


def current_role() -> Role:
    return Role.OPERATOR if settings.auth_mode == "login" else Role.GUEST


def capabilities_for(role: Role) -> list[str]:
    """Sorted list of capability strings for the given role — used in API responses."""
    return sorted(c.value for c in ROLE_CAPABILITIES[role])


def require_capability(cap: Capability):
    """FastAPI dependency factory.

    Usage::
        @router.get("/thing", dependencies=[Depends(require_capability(Capability.VM_LIST))])
        def list_things(...): ...

    Raises HTTP 403 if the current deploy's role lacks ``cap``.
    """

    def _dep() -> None:
        if cap not in ROLE_CAPABILITIES[current_role()]:
            raise HTTPException(
                status_code=403,
                detail=(
                    f"Role '{current_role().value}' does not have"
                    f" capability '{cap.value}'."
                ),
            )

    return _dep


_GUEST_VM_SUFFIX = re.compile(r"^[A-Za-z0-9-]{1,32}$")


def enforce_guest_vm_name(name: str, token: str) -> str:
    """Force a guest-role VM name into the caller's own ``guest-<token-prefix>-``
    namespace before it reaches a real clone.

    The prefix is always re-derived from the caller's *own* session token,
    never trusted from the client — otherwise a guest could spoof another
    session's namespace or pick an arbitrary, non-guest-looking name that
    collides with / shadows unrelated inventory. If the client already sent
    a correctly-prefixed name it's passed through unchanged (mod stripping
    and re-adding the prefix); anything else is treated as the whole
    requested suffix and validated against a safe charset. Operator deploys
    are already trusted and pass through unchanged. Raises 422 on an invalid
    suffix.
    """
    if current_role() != Role.GUEST:
        return name
    prefix = f"guest-{token[:8]}-"
    suffix = name[len(prefix):] if name.startswith(prefix) else name
    if not _GUEST_VM_SUFFIX.match(suffix):
        raise HTTPException(422, detail="Invalid VM name.")
    return f"{prefix}{suffix}"
