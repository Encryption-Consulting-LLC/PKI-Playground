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
    password: "/generate/password",
  },
  auth: {
    login: "/auth/login",
    logout: "/auth/logout",
    me: "/auth/me",
    config: "/auth/config",
    oidcLogin: "/auth/oidc/login",
    oidcCallback: "/auth/oidc/callback",
  },
  vm: {
    list: "/vm",
    one: (name: string) => `/vm/${encodeURIComponent(name)}`,
    clone: "/vm/clone",
    diskCheck: "/vm/disk-check",
    powerOn: (name: string) => `/vm/${encodeURIComponent(name)}/power-on`,
    powerOff: (name: string) => `/vm/${encodeURIComponent(name)}/power-off`,
  },
  deploy: "/deploy",
  settings: {
    root: "/settings",
    validateGoldenImage: "/settings/golden-image/validate",
    validateInfrastructure: "/settings/infrastructure/validate",
    validateEnvironment: "/settings/environment/validate",
  },
  iso: {
    upload: "/iso",
    one: (id: string) => `/iso/${encodeURIComponent(id)}`,
    templateScripts: (templateId: string) =>
      `/iso/templates/${encodeURIComponent(templateId)}/scripts`,
  },
  projects: {
    list: "/projects",
    one: (id: string) => `/projects/${encodeURIComponent(id)}`,
  },
  orchestrator: {
    register: "/orchestrator/register",
    command: (vmId: string) => `/orchestrator/${encodeURIComponent(vmId)}/command`,
    agents: "/orchestrator/agents",
  },
  // WebSocket paths (relative to API_BASE, like the entries above). The ws
  // client resolves these against the current origin so the Vite proxy forwards
  // the upgrade in dev.
  ws: {
    jobs: (id: string) => `/ws/jobs/${encodeURIComponent(id)}`,
    agents: "/orchestrator/agents/watch",
  },
} as const
