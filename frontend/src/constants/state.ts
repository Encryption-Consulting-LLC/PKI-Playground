/**
 * Client-side state keys.
 *
 * STORAGE_KEYS — zustand persist / localStorage keys.
 * QUERY_KEYS   — TanStack Query cache keys; keep them here so every
 *                invalidation call uses the same reference.
 */

export const STORAGE_KEYS = {
  auth: "ec-pki-auth",
  theme: "ec-pki-theme",
  projects: "ec-pki-projects",
  // Server-persistence mode only: device-local UI prefs ({activeProjectId,
  // nextProjectNumber}) that deliberately stay out of the Mongo project docs.
  projectsMeta: "ec-pki-projects-meta",
} as const

export const QUERY_KEYS = {
  health: ["health"] as const,
  mode: ["auth-mode"] as const,
  orchestratorAgents: ["orchestrator-agents"] as const,
} as const
