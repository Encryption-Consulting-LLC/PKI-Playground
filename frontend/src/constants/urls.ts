/**
 * All backend API paths relative to the API base.
 *
 * One entry per backend route — renaming a route is a single-line change here.
 * The `vm.*` helpers are defined now so `api.ts` stays literal-free as those
 * routes get wired into the frontend later.
 */

export const API_BASE = "/api"

export const URLS = {
  health: "/health",
  generate: {
    hostname: "/generate/hostname",
    network: "/generate/network",
  },
  auth: {
    connect: "/auth/connect",
    disconnect: "/auth/disconnect",
    mode: "/auth/mode",
    guest: "/auth/guest",
  },
  vm: {
    list: "/vm",
    one: (name: string) => `/vm/${encodeURIComponent(name)}`,
    clone: "/vm/clone",
    diskCheck: "/vm/disk-check",
    powerOn: (name: string) => `/vm/${encodeURIComponent(name)}/power-on`,
    powerOff: (name: string) => `/vm/${encodeURIComponent(name)}/power-off`,
  },
  // WebSocket paths (relative to API_BASE, like the entries above). The ws
  // client resolves these against the current origin so the Vite proxy forwards
  // the upgrade in dev.
  ws: {
    jobs: (id: string) => `/ws/jobs/${encodeURIComponent(id)}`,
  },
} as const
