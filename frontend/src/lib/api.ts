/**
 * Typed client for the FastAPI backend (vmkit / configgen / isokit).
 *
 * Requests go to `/api/*`, which the Vite dev server proxies to the backend
 * (see vite.config.ts). In production, serve the built frontend behind the same
 * origin as the API, or set up an equivalent `/api` reverse-proxy.
 *
 * Token injection: if an active session exists in the auth store, the
 * `X-Session-Token` header is added to every request automatically.
 * On a 401 response while a token is present, the store is cleared so the
 * UI returns to the login form (handles backend restart / expired sessions).
 */

import { API_BASE, URLS, type AuthMode, type Capability } from "@/constants"
import { useAuthStore } from "@/store/auth"

export class ApiError extends Error {
  status: number

  constructor(status: number, message: string) {
    super(message)
    this.name = "ApiError"
    this.status = status
  }
}

async function request<T>(
  path: string,
  init?: RequestInit,
  asText = false,
): Promise<T> {
  const token = useAuthStore.getState().token

  const res = await fetch(`${API_BASE}${path}`, {
    headers: {
      "content-type": "application/json",
      ...(token ? { "x-session-token": token } : {}),
      ...init?.headers,
    },
    ...init,
  })

  if (!res.ok) {
    // Auto-logout: if the server rejects our token, clear it so the UI gates
    // back to the login form rather than showing the authenticated shell.
    if (res.status === 401 && useAuthStore.getState().token) {
      useAuthStore.getState().clear()
    }

    // FastAPI/Pydantic errors come back as JSON `{ detail: ... }`.
    let message = `${res.status} ${res.statusText}`
    try {
      const body = await res.json()
      if (body?.detail) {
        message =
          typeof body.detail === "string"
            ? body.detail
            : JSON.stringify(body.detail)
      }
    } catch {
      // non-JSON body — keep the status line.
    }
    throw new ApiError(res.status, message)
  }

  return (asText ? res.text() : res.json()) as Promise<T>
}

// --- /auth -----------------------------------------------------------------

export interface ConnectRequest {
  host: string
  user: string
  password: string
  port?: number
}

export interface ConnectResponse {
  token: string
  host: string
  api_version: string
}

export const connect = (req: ConnectRequest) =>
  request<ConnectResponse>(URLS.auth.connect, {
    method: "POST",
    body: JSON.stringify(req),
  })

export const disconnect = () =>
  request<{ status: string }>(URLS.auth.disconnect, { method: "POST" })

export interface AuthMeta {
  mode: AuthMode
  role: string
  capabilities: Capability[]
}

export const getMode = () => request<AuthMeta>(URLS.auth.mode)

export const guestConnect = () =>
  request<ConnectResponse>(URLS.auth.guest, { method: "POST" })

// --- /health ---------------------------------------------------------------

export interface Health {
  status: string
  libraries: {
    configgen: string[]
    vmkit: string
    isokit: string
  }
}

export const getHealth = () => request<Health>(URLS.health)

// --- /generate/hostname ----------------------------------------------------

export type Platform = "linux" | "windows"

export interface HostnameRequest {
  platform: Platform
  hostname: string
}

export const generateHostname = (req: HostnameRequest) =>
  request<string>(
    URLS.generate.hostname,
    { method: "POST", body: JSON.stringify(req) },
    true,
  )

// --- /generate/network -----------------------------------------------------

export interface NetworkRequest {
  platform: Platform
  dhcp?: boolean
  ip?: string | null
  prefix?: number | null
  gateway?: string | null
  dns1?: string | null
  dns2?: string | null
  dns_suffix?: string | null
}

export const generateNetwork = (req: NetworkRequest) =>
  request<string>(
    URLS.generate.network,
    { method: "POST", body: JSON.stringify(req) },
    true,
  )

// --- /vm/clone -------------------------------------------------------------

export interface CloneRequest {
  name: string
  base: string
  datastore: string
  cpus: number
  mem_mb: number
  mac?: string | null
  iso_path?: string | null
  guest_os?: string | null
  max_usage_pct?: number
  skip_disk_check?: boolean
  power_on?: boolean
}

/** Clone is async: the POST returns a job id; progress streams over the job WS. */
export interface CloneAccepted {
  job_id: string
}

export const cloneVm = (req: CloneRequest) =>
  request<CloneAccepted>(URLS.vm.clone, {
    method: "POST",
    body: JSON.stringify(req),
  })

// --- /deploy -----------------------------------------------------------------

/** Mirrors the backend's `PlanOp` (app/routers/deploy.py) — one node in the deploy DAG. */
export interface PlanOpPayload {
  id: string
  kind: string
  target: string
  params: Record<string, string>
  dependsOn: string[]
}

/** Deploy is async, same shape as clone: the POST returns a job id; progress streams over the job WS. */
export interface DeployAccepted {
  job_id: string
}

export const deployPlan = (ops: PlanOpPayload[]) =>
  request<DeployAccepted>(URLS.deploy, {
    method: "POST",
    body: JSON.stringify({ ops }),
  })

// --- /orchestrator -----------------------------------------------------------

export interface RegisterAgentResponse {
  vm_id: string
  token: string
}

/** Mints a vm_id/token pair for a not-yet-connected orchestrator agent. */
export const registerAgent = () =>
  request<RegisterAgentResponse>(URLS.orchestrator.register, { method: "POST" })

export interface DispatchCommandAccepted {
  job_id: string
}

/** Dispatch is async, same shape as clone/deploy: progress streams over the job WS. */
export const dispatchOrchestratorCommand = (
  vmId: string,
  command: string,
  params: Record<string, string> = {},
) =>
  request<DispatchCommandAccepted>(URLS.orchestrator.command(vmId), {
    method: "POST",
    body: JSON.stringify({ command, params }),
  })

export interface ConnectedAgents {
  vm_ids: string[]
}

export const listConnectedAgents = () =>
  request<ConnectedAgents>(URLS.orchestrator.agents)
