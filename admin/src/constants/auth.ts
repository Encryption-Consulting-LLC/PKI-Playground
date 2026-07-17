/**
 * Role registry.
 *
 * Frontend mirror of the backend's Role enum (core/authz.py). The admin app
 * is admin-only: every route it calls is already gated server-side by
 * Capability.USER_ADMIN / SETTINGS_* / REGISTRY_* (all admin-only, disjoint
 * from operator/guest), so `role` here is used only to render an
 * "admins only" screen for anyone else who signs in — a cosmetic gate, same
 * convention as the operator app's useIsOperator (the backend 403s
 * regardless).
 */

export const ROLES = {
  admin: "admin",
  operator: "operator",
  guest: "guest",
} as const

export type Role = (typeof ROLES)[keyof typeof ROLES]
