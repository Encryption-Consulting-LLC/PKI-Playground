/**
 * Returns true if the signed-in user's role has the given capability.
 *
 * The capability list is fetched from GET /auth/me (cached by TanStack Query,
 * see useMe) and is single-sourced from the backend — add/remove capabilities
 * in core/authz.py and both the server enforcement and this hook update
 * together.
 *
 * This hook is COSMETIC: it hides UI that the current role cannot use.
 * The backend enforces the allowlist authoritatively; a guest with a valid token
 * calling an operator-only route still gets 403 regardless of what the UI shows.
 *
 * Usage:
 *   const canUpdate = useCan(CAPABILITIES.vmUpdate)
 *   if (canUpdate) return <UpdateForm />
 */

import { type Capability } from "@/constants"
import { useMe } from "@/hooks/useMe"

export function useCan(cap: Capability): boolean {
  const me = useMe()
  return !!me?.capabilities.includes(cap)
}
