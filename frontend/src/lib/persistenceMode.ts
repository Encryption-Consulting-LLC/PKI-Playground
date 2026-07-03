/**
 * Persistence mode switch — localStorage vs. server (Mongo-backed projects API).
 *
 * Deliberately import-free (aside from a zustand type) so it can sit under
 * `store/projects.ts` without creating cycles. Guests never flip the flag and
 * keep today's localStorage behavior byte-for-byte; `initServerProjects()`
 * (lib/projectSync.ts) flips it before any store write can happen in server
 * mode, which turns the persist middleware's storage into a read-only
 * passthrough — the hydration *read* at import time still works and is then
 * overwritten by server data.
 */

import type { StateStorage } from "zustand/middleware"

let server = false

export function enableServerPersistence() {
  server = true
}

export function isServerPersistence() {
  return server
}

/** localStorage passthrough that goes read-only once server persistence is on. */
export const gatedLocalStorage: StateStorage = {
  getItem: (name) => localStorage.getItem(name),
  setItem: (name, value) => {
    if (!server) localStorage.setItem(name, value)
  },
  removeItem: (name) => {
    if (!server) localStorage.removeItem(name)
  },
}
