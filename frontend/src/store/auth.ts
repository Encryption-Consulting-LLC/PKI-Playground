/**
 * Persisted session store.
 *
 * Backed by localStorage (via zustand `persist` middleware). The session JWT
 * plus display facts (username, role, connected host) survive a page reload;
 * credentials are never stored. Tokens expire server-side (SESSION_TTL_HOURS)
 * and account edits (disable/role) apply per-request — `api.ts` auto-clears
 * this store on any 401 so the UI gates back to login.
 *
 * No React provider is needed; import `useAuthStore` directly in any component.
 * Keep this module free of `api.ts` imports to avoid circular dependencies.
 */

import { create } from "zustand"
import { persist } from "zustand/middleware"

import { STORAGE_KEYS } from "@/constants"

interface Session {
  token: string
  username: string
  role: string
  host?: string | null
}

interface AuthState {
  token?: string
  username?: string
  role?: string
  host?: string | null
  setSession: (s: Session) => void
  clear: () => void
}

export const useAuthStore = create<AuthState>()(
  persist(
    (set) => ({
      setSession: ({ token, username, role, host }) =>
        set({ token, username, role, host }),
      clear: () =>
        set({ token: undefined, username: undefined, role: undefined, host: undefined }),
    }),
    { name: STORAGE_KEYS.auth },
  ),
)
