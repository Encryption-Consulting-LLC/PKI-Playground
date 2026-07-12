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

import { API_BASE, URLS, type Capability } from "@/constants"
import type { ProjectDoc, ProjectPayload } from "@/lib/projectSerialize"
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

export interface LoginRequest {
  username: string
  password: string
}

/** Every token-minting route (login, SSO callback) returns this shape. */
export interface SessionResponse {
  token: string
  username: string
  role: string
  capabilities: Capability[]
  host: string | null
}

export const login = (req: LoginRequest) =>
  request<SessionResponse>(URLS.auth.login, {
    method: "POST",
    body: JSON.stringify(req),
  })

export const logout = () =>
  request<{ status: string }>(URLS.auth.logout, { method: "POST" })

export interface AuthConfig {
  oidcEnabled: boolean
}

/** Unauthenticated deploy config — whether the SSO button should show. */
export const getAuthConfig = () => request<AuthConfig>(URLS.auth.config)

export interface Me {
  username: string
  role: string
  auth: "local" | "oidc" | "guest"
  capabilities: Capability[]
}

/** The signed-in identity + capability allowlist (what `useCan` reads). */
export const getMe = () => request<Me>(URLS.auth.me)

/** Start the SSO code flow: redirect the browser to the returned IdP URL. */
export const oidcLoginUrl = () => request<{ url: string }>(URLS.auth.oidcLogin)

/** Finish the SSO code flow with the `?code&state` the IdP sent back. */
export const oidcCallback = (code: string, state: string) =>
  request<SessionResponse>(URLS.auth.oidcCallback, {
    method: "POST",
    body: JSON.stringify({ code, state }),
  })

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

// --- /generate/password ------------------------------------------------------

export interface PasswordRequest {
  platform: Platform
  username: string
  password: string
}

export const generatePassword = (req: PasswordRequest) =>
  request<string>(
    URLS.generate.password,
    { method: "POST", body: JSON.stringify(req) },
    true,
  )

// --- async jobs --------------------------------------------------------------

/** Every 202-and-stream route (clone, deploy, teardown, orchestrator dispatch)
 * returns this shape; progress streams over the job WS. */
export interface JobAccepted {
  job_id: string
}

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

export const cloneVm = (req: CloneRequest) =>
  request<JobAccepted>(URLS.vm.clone, {
    method: "POST",
    body: JSON.stringify(req),
  })

/** Teardown (destroy + reclaim the guest IP) is async, same 202+job-stream
 * shape as clone/deploy. `name` is the real ESXi inventory name
 * (`MachineData.vmName`), not the display label. */
export const deleteVm = (name: string) =>
  request<JobAccepted>(URLS.vm.one(name), { method: "DELETE" })

// --- /deploy -----------------------------------------------------------------

/** One operator-authored firstboot script riding inline in a createVm op. */
export interface IsoFilePayload {
  name: string
  content: string
}

/** Mirrors the backend's `PlanOp` (app/routers/deploy.py) — one node in the deploy DAG. */
export interface PlanOpPayload {
  id: string
  kind: string
  target: string
  /** The DC / parent CA / issuing CA the op wires to. */
  secondary?: string
  params: Record<string, string>
  /** PACK-mode authored scripts (operator-only; validated server-side). */
  files?: IsoFilePayload[]
  dependsOn: string[]
}

export const deployPlan = (ops: PlanOpPayload[], projectId?: string | null) =>
  request<JobAccepted>(URLS.deploy, {
    method: "POST",
    // The backend derives guest VM names as guest-<user>-<project>-<machine>,
    // so the active project rides along as the <project> segment (required for
    // guest clones; ignored for operators, who keep free-form names).
    body: JSON.stringify({ ops, ...(projectId ? { projectId } : {}) }),
  })

// --- /iso --------------------------------------------------------------------

export interface UploadedIso {
  isoId: string
  name: string
  size: number
}

/**
 * Upload a pre-built config ISO (UPLOAD-ISO mode). Deliberately bypasses
 * `request()`: multipart bodies must NOT carry a manual `content-type` header —
 * the browser sets it (with the boundary) from the FormData. Token injection
 * and the 401 auto-logout mirror `request()`.
 */
export async function uploadIso(file: File): Promise<UploadedIso> {
  const token = useAuthStore.getState().token
  const body = new FormData()
  body.append("file", file)

  const res = await fetch(`${API_BASE}${URLS.iso.upload}`, {
    method: "POST",
    headers: token ? { "x-session-token": token } : {},
    body,
  })

  if (!res.ok) {
    if (res.status === 401 && useAuthStore.getState().token) {
      useAuthStore.getState().clear()
    }
    let message = `${res.status} ${res.statusText}`
    try {
      const errBody = await res.json()
      if (errBody?.detail) {
        message =
          typeof errBody.detail === "string"
            ? errBody.detail
            : JSON.stringify(errBody.detail)
      }
    } catch {
      // non-JSON body — keep the status line.
    }
    throw new ApiError(res.status, message)
  }
  return res.json() as Promise<UploadedIso>
}

/** Best-effort — callers are expected to swallow 404s (already consumed/swept). */
export const deleteIso = (isoId: string) =>
  request<string>(URLS.iso.one(isoId), { method: "DELETE" }, true)

export interface TemplateScripts {
  scripts: IsoFilePayload[]
}

/** The template's fixed role scripts, as editable seed content for the PACK panel. */
export const getTemplateScripts = (templateId: string) =>
  request<TemplateScripts>(URLS.iso.templateScripts(templateId))

// --- /projects ---------------------------------------------------------------

export interface ProjectSummary {
  id: string
  name: string
  createdAt: number
  updatedAt: number
}

export const listProjects = () =>
  request<{ projects: ProjectSummary[]; count: number }>(URLS.projects.list)

export const getProject = (id: string) =>
  request<ProjectDoc>(URLS.projects.one(id))

/** `init` passthrough carries `{ keepalive: true }` on beforeunload flushes. */
export const createProject = (doc: ProjectPayload, init?: RequestInit) =>
  request<ProjectDoc>(URLS.projects.list, {
    method: "POST",
    body: JSON.stringify(doc),
    ...init,
  })

export const updateProject = (doc: ProjectPayload, init?: RequestInit) =>
  request<ProjectDoc>(URLS.projects.one(doc.id), {
    method: "PUT",
    body: JSON.stringify(doc),
    ...init,
  })

// 204 No Content — read as text so the empty body doesn't trip res.json().
export const deleteProject = (id: string) =>
  request<string>(URLS.projects.one(id), { method: "DELETE" }, true)

// --- /orchestrator -----------------------------------------------------------

export interface RegisterAgentResponse {
  vm_id: string
  token: string
}

/** Mints a vm_id/token pair for a not-yet-connected orchestrator agent. */
export const registerAgent = () =>
  request<RegisterAgentResponse>(URLS.orchestrator.register, { method: "POST" })

/** Dispatch is async, same shape as clone/deploy: progress streams over the job WS. */
export const dispatchOrchestratorCommand = (
  vmId: string,
  command: string,
  params: Record<string, string> = {},
) =>
  request<JobAccepted>(URLS.orchestrator.command(vmId), {
    method: "POST",
    body: JSON.stringify({ command, params }),
  })

