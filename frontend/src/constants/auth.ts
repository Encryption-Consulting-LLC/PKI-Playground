/**
 * Auth mode and capability registries.
 *
 * These are the frontend mirrors of the backend's AuthMode / Capability enums
 * (core/authz.py). String values must stay in sync with the backend.
 *
 * Types are derived from the const objects — there are no hand-written unions.
 * Add or rename a value here and the type updates automatically.
 */

export const AUTH_MODES = {
  login: "login",
  guest: "guest",
} as const

export type AuthMode = (typeof AUTH_MODES)[keyof typeof AUTH_MODES]

export const CAPABILITIES = {
  vmList: "vm:list",
  vmRead: "vm:read",
  vmClone: "vm:clone",
  vmUpdate: "vm:update",
  vmPower: "vm:power",
  configGenerate: "config:generate",
  vmExecArbitrary: "vm:exec-arbitrary", // reserved — future orchestrator phase
  deploy: "deploy",
} as const

export type Capability = (typeof CAPABILITIES)[keyof typeof CAPABILITIES]
