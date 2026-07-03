/**
 * Server persistence engine for projects (operator mode only).
 *
 * `store/projects.ts` stays the in-memory source of truth with unchanged
 * action signatures; this module hydrates it from the Mongo-backed
 * /api/projects CRUD on init, then subscribes and write-through-syncs changed
 * projects with a per-project debounce. Guests never call into here — they
 * keep the store's localStorage persist (see `lib/persistenceMode.ts`).
 *
 * Change detection compares `serializeProject` JSON against the last acked
 * copy (`lastSynced`), so dirty-flag flips, progress ticks, and client
 * `updatedAt` stamps never cause writes. Flushes happen immediately on:
 * explicit save (dirty true→false), project switch, re-login after a 401,
 * the window coming back online, and beforeunload (with `keepalive`).
 * Failed writes stay in `pendingIds` (arming the unload warning) and retry
 * every few seconds — nothing is lost while the tab lives.
 */

import { create } from "zustand"
import { toast } from "sonner"

import { STORAGE_KEYS } from "@/constants"
import {
  ApiError,
  createProject,
  deleteProject,
  getProject,
  listProjects,
  updateProject,
} from "@/lib/api"
import { enableServerPersistence } from "@/lib/persistenceMode"
import { deserializeProject, serializeProject } from "@/lib/projectSerialize"
import { emptyProject, migrateNodeData, useProjectsStore } from "@/store/projects"
import type { Project } from "@/store/projects"
import { useAuthStore } from "@/store/auth"

const SAVE_DEBOUNCE_MS = 1500
const RETRY_MS = 5000

interface ProjectSyncState {
  /** Startup load lifecycle — App gates the workspace on it in server mode. */
  status: "idle" | "loading" | "ready" | "error"
  loadError?: string
  /** Project ids with unflushed or in-flight writes (arms the unload warning). */
  pendingIds: string[]
  /** Last flush attempt errored — drives the retry loop + one-toast-per-outage. */
  saveFailed: boolean
}

export const useProjectSyncStore = create<ProjectSyncState>()(() => ({
  status: "idle",
  pendingIds: [],
  saveFailed: false,
}))

// Module-level (not store state): baselines and timers are never rendered.
const lastSynced = new Map<string, string>()
const serverKnownIds = new Set<string>()
const timers = new Map<string, ReturnType<typeof setTimeout>>()
const inFlight = new Set<string>()
const changedWhileInFlight = new Set<string>()
let retryTimer: ReturnType<typeof setTimeout> | null = null
let subscribed = false

// --- device-local meta (active tab + numbering — deliberately not server state)

interface ProjectsMeta {
  activeProjectId?: string | null
  nextProjectNumber?: number
}

function readMeta(): ProjectsMeta {
  try {
    return JSON.parse(localStorage.getItem(STORAGE_KEYS.projectsMeta) ?? "{}")
  } catch {
    return {}
  }
}

function writeMeta(activeProjectId: string | null, nextProjectNumber: number) {
  localStorage.setItem(
    STORAGE_KEYS.projectsMeta,
    JSON.stringify({ activeProjectId, nextProjectNumber }),
  )
}

// --- init / hydration --------------------------------------------------------

/**
 * One-time migration source: the guest-era localStorage snapshot. Only read
 * when the server list is empty, so a wiped DB re-imports old local data
 * (acceptable for a playground) but a populated server never gets clobbered.
 */
function readLocalProjects(): Project[] {
  try {
    const raw = localStorage.getItem(STORAGE_KEYS.projects)
    if (!raw) return []
    const envelope = JSON.parse(raw) as { state?: { projects?: Project[] } }
    return (envelope.state?.projects ?? []).map((p) => ({
      ...p,
      // Idempotent v0→v1 node migration, same as the persist `migrate` fn.
      nodes: (p.nodes ?? []).map((n) => ({ ...n, data: migrateNodeData(n.data) })),
      stagedOps: p.stagedOps ?? [],
      deployJobId: p.deployJobId ?? null,
      dirty: false,
    }))
  } catch {
    return []
  }
}

function inferNextProjectNumber(projects: Project[]): number {
  let max = 0
  for (const p of projects) {
    const m = /^Project (\d+)$/.exec(p.name)
    if (m) max = Math.max(max, Number(m[1]))
  }
  return max + 1
}

export async function initServerProjects(): Promise<void> {
  enableServerPersistence()
  useProjectSyncStore.setState({ status: "loading", loadError: undefined })
  try {
    const { projects: summaries } = await listProjects()

    let projects: Project[]
    let imported = false
    if (summaries.length > 0) {
      const docs = await Promise.all(summaries.map((s) => getProject(s.id)))
      projects = docs.map(deserializeProject)
    } else {
      const local = readLocalProjects()
      if (local.length > 0) {
        projects = local
        imported = true
      } else {
        projects = [emptyProject("Project 1")]
      }
    }

    const meta = readMeta()
    const activeId =
      meta.activeProjectId && projects.some((p) => p.id === meta.activeProjectId)
        ? meta.activeProjectId
        : projects.reduce((a, b) => (b.updatedAt > a.updatedAt ? b : a)).id
    const nextNumber = meta.nextProjectNumber ?? inferNextProjectNumber(projects)

    // Seed baselines BEFORE hydrating/subscribing: server-fetched docs are in
    // sync; imported/local/default ones are unknown and get pushed below.
    lastSynced.clear()
    serverKnownIds.clear()
    if (summaries.length > 0) {
      for (const p of projects) {
        lastSynced.set(p.id, JSON.stringify(serializeProject(p)))
        serverKnownIds.add(p.id)
      }
    }

    useProjectsStore.getState().hydrateFromServer(projects, activeId, nextNumber)
    writeMeta(activeId, nextNumber)
    startSubscriptions()
    useProjectSyncStore.setState({ status: "ready" })

    for (const p of projects) {
      if (!serverKnownIds.has(p.id)) {
        markPending(p.id)
        void flushProject(p.id)
      }
    }
    if (imported) {
      const n = projects.length
      toast.success(`Imported ${n} locally saved project${n === 1 ? "" : "s"} to the server.`)
    }
  } catch (e) {
    useProjectSyncStore.setState({
      status: "error",
      loadError: e instanceof Error ? e.message : String(e),
    })
  }
}

export function retryInitServerProjects() {
  void initServerProjects()
}

// --- change detection ---------------------------------------------------------

function startSubscriptions() {
  if (subscribed) return
  subscribed = true

  useProjectsStore.subscribe((state, prev) => {
    if (
      state.activeProjectId !== prev.activeProjectId ||
      state.nextProjectNumber !== prev.nextProjectNumber
    ) {
      writeMeta(state.activeProjectId, state.nextProjectNumber)
    }

    if (state.projects !== prev.projects) {
      const prevById = new Map(prev.projects.map((p) => [p.id, p]))
      for (const p of state.projects) {
        const prevP = prevById.get(p.id)
        prevById.delete(p.id)
        if (prevP === p) continue
        const serialized = JSON.stringify(serializeProject(p))
        if (serialized === lastSynced.get(p.id)) continue
        markPending(p.id)
        // dirty true→false is the explicit-save/checkpoint signature (Ctrl+S,
        // Save button, autosave checkpoints) — flush now, not debounced.
        if (prevP && prevP.dirty && !p.dirty) void flushProject(p.id)
        else scheduleFlush(p.id)
      }
      // Removed ids → DELETE. No delete UI exists yet; future-proofing.
      for (const id of prevById.keys()) void removeProject(id)
    }

    // A switch flushes the outgoing draft so switch-then-reload can't lose it.
    if (state.activeProjectId !== prev.activeProjectId) flushAllPending()
  })

  // Re-login after a 401 gate: the stores kept all unsaved state in memory.
  useAuthStore.subscribe((state, prev) => {
    if (state.token && !prev.token) flushAllPending()
  })

  window.addEventListener("online", () => flushAllPending())
}

// --- flushing -----------------------------------------------------------------

function scheduleFlush(id: string) {
  const existing = timers.get(id)
  if (existing) clearTimeout(existing)
  timers.set(
    id,
    setTimeout(() => {
      timers.delete(id)
      void flushProject(id)
    }, SAVE_DEBOUNCE_MS),
  )
}

async function flushProject(id: string, init?: RequestInit): Promise<void> {
  const timer = timers.get(id)
  if (timer) {
    clearTimeout(timer)
    timers.delete(id)
  }
  if (inFlight.has(id)) {
    changedWhileInFlight.add(id)
    return
  }
  const project = useProjectsStore.getState().projects.find((p) => p.id === id)
  if (!project) return

  const payload = serializeProject(project)
  const serialized = JSON.stringify(payload)
  if (serialized === lastSynced.get(id)) {
    clearPending(id)
    return
  }

  inFlight.add(id)
  try {
    if (serverKnownIds.has(id)) {
      await updateProject(payload, init)
    } else {
      await createProject(payload, init)
    }
    serverKnownIds.add(id)
    lastSynced.set(id, serialized)
    clearPending(id)
    clearSaveFailure()
  } catch (e) {
    if (e instanceof ApiError) {
      // 401: api.ts already cleared auth and the UI gated to login; the
      // auth-store subscription re-flushes after re-login. Stay pending.
      if (e.status === 401) return
      // The doc vanished server-side (e.g. wiped DB): recreate on next flush.
      if (e.status === 404 && serverKnownIds.has(id)) serverKnownIds.delete(id)
      // A duplicate id on POST means the doc exists after all: PUT next time.
      if (e.status === 409 && !serverKnownIds.has(id)) serverKnownIds.add(id)
    }
    reportSaveFailure()
  } finally {
    inFlight.delete(id)
    if (changedWhileInFlight.delete(id)) scheduleFlush(id)
  }
}

async function removeProject(id: string) {
  const timer = timers.get(id)
  if (timer) {
    clearTimeout(timer)
    timers.delete(id)
  }
  clearPending(id)
  lastSynced.delete(id)
  if (!serverKnownIds.has(id)) return
  try {
    await deleteProject(id)
  } catch (e) {
    // 404 = already gone; anything else leaves a stale doc the next full
    // load surfaces — acceptable for a path with no UI yet.
    if (!(e instanceof ApiError && e.status === 404)) return
  }
  serverKnownIds.delete(id)
}

export function flushAllPending(opts?: { keepalive?: boolean }) {
  const init = opts?.keepalive ? { keepalive: true } : undefined
  for (const id of [...useProjectSyncStore.getState().pendingIds]) {
    void flushProject(id, init)
  }
}

// --- pending / failure bookkeeping ---------------------------------------------

function markPending(id: string) {
  const { pendingIds } = useProjectSyncStore.getState()
  if (!pendingIds.includes(id)) {
    useProjectSyncStore.setState({ pendingIds: [...pendingIds, id] })
  }
}

function clearPending(id: string) {
  const { pendingIds } = useProjectSyncStore.getState()
  if (pendingIds.includes(id)) {
    useProjectSyncStore.setState({ pendingIds: pendingIds.filter((x) => x !== id) })
  }
}

function reportSaveFailure() {
  if (!useProjectSyncStore.getState().saveFailed) {
    useProjectSyncStore.setState({ saveFailed: true })
    toast.error("Couldn't save to the server — will keep retrying.")
  }
  if (!retryTimer) {
    retryTimer = setTimeout(() => {
      retryTimer = null
      flushAllPending()
    }, RETRY_MS)
  }
}

function clearSaveFailure() {
  if (useProjectSyncStore.getState().saveFailed) {
    useProjectSyncStore.setState({ saveFailed: false })
  }
}
