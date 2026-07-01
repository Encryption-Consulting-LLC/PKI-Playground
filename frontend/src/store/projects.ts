/**
 * Persisted project store.
 *
 * A "project" is a named, saved snapshot of a topology graph (nodes/edges/
 * counters). Backed by localStorage (via zustand `persist`), same pattern as
 * `auth.ts`/`theme.ts`. This is the seam called out in `topology.ts`: the
 * working graph there stays ephemeral/in-memory, and this store is what
 * actually persists it, one snapshot per project. Swapping localStorage for a
 * backend endpoint later only touches this file.
 *
 * Snapshot writes are checkpointed (see `lib/projectAutosave.ts`) rather than
 * happening on every topology mutation, so dragging/dropping nodes around
 * doesn't spam localStorage. `markActiveDirty` is intentionally idempotent
 * (no-ops once already dirty) for the same reason.
 */

import { create } from "zustand"
import { persist } from "zustand/middleware"
import type { Edge, Node } from "@xyflow/react"

import type { Viewport } from "@xyflow/react"

import { STORAGE_KEYS } from "@/constants"
import { LIFECYCLE } from "@/constants/topology"
import type { StagedOp } from "@/lib/staging"
import type { MachineData } from "@/store/topology"
import { DEFAULT_VIEWPORT, useTopologyStore } from "@/store/topology"
import { useStagingStore } from "@/store/staging"
import { withSuppressedAutosave } from "@/lib/projectAutosave"

export interface Project {
  id: string
  name: string
  nodes: Node<MachineData>[]
  edges: Edge[]
  counters: Record<string, number>
  /** Camera pan/zoom, restored when this project's tab is reopened. */
  viewport: Viewport
  /** Staged ops queued ahead of a deploy — see `store/staging.ts`. Optional so pre-M2 saves keep loading (missing → treated as `[]`). */
  stagedOps?: StagedOp[]
  deployJobId?: string | null
  dirty: boolean
  updatedAt: number
}

/** A v0 node's `data` shape — pre-lifecycle, keyed by the old `status` field. */
interface LegacyMachineData {
  typeId: string
  name: string
  status?: string
  config?: Record<string, string>
  progress?: number
  phase?: string
  jobId?: string
}

/**
 * v0 → v1: `status` → `lifecycle` + `poweredOn` (+ `lastDeployedConfig` for
 * already-configured nodes, so domains/CA chains hanging off them don't read
 * as drifted the moment they load). Idempotent — already-migrated data (has
 * `lifecycle`) passes through unchanged.
 */
function migrateNodeData(data: LegacyMachineData | MachineData): MachineData {
  if ("lifecycle" in data) return data
  const { status, ...rest } = data
  switch (status) {
    case "configuring":
      return {
        ...rest,
        lifecycle: rest.jobId ? LIFECYCLE.deploying : LIFECYCLE.draft,
        poweredOn: false,
      }
    case "configured":
      return {
        ...rest,
        lifecycle: LIFECYCLE.deployed,
        poweredOn: true,
        lastDeployedConfig: rest.config,
      }
    case "error":
      return { ...rest, lifecycle: LIFECYCLE.failed, poweredOn: false }
    default:
      return { ...rest, lifecycle: LIFECYCLE.draft, poweredOn: false }
  }
}

function emptyProject(name: string): Project {
  return {
    id: crypto.randomUUID(),
    name,
    nodes: [],
    edges: [],
    counters: {},
    viewport: DEFAULT_VIEWPORT,
    stagedOps: [],
    deployJobId: null,
    dirty: false,
    updatedAt: Date.now(),
  }
}

interface ProjectsState {
  projects: Project[]
  activeProjectId: string | null
  nextProjectNumber: number

  ensureDefaultProject: () => void
  addProject: () => void
  renameProject: (id: string, name: string) => void
  switchProject: (id: string) => void
  markActiveDirty: () => void
  saveActiveSnapshot: () => void
  persistActiveDraft: () => void
  persistActiveViewport: () => void
}

export const useProjectsStore = create<ProjectsState>()(
  persist(
    (set, get) => ({
      projects: [],
      activeProjectId: null,
      nextProjectNumber: 1,

      ensureDefaultProject() {
        const { projects } = get()
        if (projects.length > 0) {
          const active =
            projects.find((p) => p.id === get().activeProjectId) ?? projects[0]
          withSuppressedAutosave(() => {
            // Ops load first so `loadSnapshot`'s resumeJobs can see them —
            // a mid-plan node reverting to `staged` rather than `draft`
            // depends on the matching op already being in the staging store.
            useStagingStore.getState().loadOps(active.stagedOps ?? [], active.deployJobId ?? null)
            useTopologyStore
              .getState()
              .loadSnapshot(
                active.nodes,
                active.edges,
                active.counters,
                active.viewport ?? DEFAULT_VIEWPORT,
              )
          })
          if (!get().activeProjectId) set({ activeProjectId: projects[0].id })
          return
        }
        const project = emptyProject("Project 1")
        set({ projects: [project], activeProjectId: project.id, nextProjectNumber: 2 })
        withSuppressedAutosave(() => {
          useStagingStore.getState().loadOps([], null)
          useTopologyStore.getState().loadSnapshot([], [], {}, DEFAULT_VIEWPORT)
        })
      },

      addProject() {
        get().persistActiveDraft()
        const n = get().nextProjectNumber
        const project = emptyProject(`Project ${n}`)
        set((s) => ({
          projects: [...s.projects, project],
          activeProjectId: project.id,
          nextProjectNumber: n + 1,
        }))
        withSuppressedAutosave(() => {
          useStagingStore.getState().loadOps([], null)
          useTopologyStore.getState().loadSnapshot([], [], {}, DEFAULT_VIEWPORT)
        })
      },

      renameProject(id, name) {
        const trimmed = name.trim()
        if (!trimmed) return
        set((s) => ({
          projects: s.projects.map((p) =>
            p.id === id ? { ...p, name: trimmed } : p,
          ),
        }))
      },

      switchProject(id) {
        if (get().activeProjectId === id) return
        get().persistActiveDraft()
        const target = get().projects.find((p) => p.id === id)
        if (!target) return
        set({ activeProjectId: id })
        withSuppressedAutosave(() => {
          useStagingStore.getState().loadOps(target.stagedOps ?? [], target.deployJobId ?? null)
          useTopologyStore
            .getState()
            .loadSnapshot(
              target.nodes,
              target.edges,
              target.counters,
              target.viewport ?? DEFAULT_VIEWPORT,
            )
        })
      },

      markActiveDirty() {
        const { activeProjectId, projects } = get()
        const active = projects.find((p) => p.id === activeProjectId)
        if (!active || active.dirty) return
        set((s) => ({
          projects: s.projects.map((p) =>
            p.id === activeProjectId ? { ...p, dirty: true } : p,
          ),
        }))
      },

      saveActiveSnapshot() {
        const { activeProjectId } = get()
        if (!activeProjectId) return
        const { nodes, edges, counters, viewport } = useTopologyStore.getState()
        const { ops: stagedOps, deployJobId } = useStagingStore.getState()
        set((s) => ({
          projects: s.projects.map((p) =>
            p.id === activeProjectId
              ? { ...p, nodes, edges, counters, viewport, stagedOps, deployJobId, dirty: false, updatedAt: Date.now() }
              : p,
          ),
        }))
      },

      persistActiveDraft() {
        const { activeProjectId } = get()
        if (!activeProjectId) return
        const { nodes, edges, counters, viewport } = useTopologyStore.getState()
        const { ops: stagedOps, deployJobId } = useStagingStore.getState()
        set((s) => ({
          projects: s.projects.map((p) =>
            p.id === activeProjectId
              ? { ...p, nodes, edges, counters, viewport, stagedOps, deployJobId }
              : p,
          ),
        }))
      },

      // Camera-only checkpoint: a bare pan/zoom shouldn't mark the project
      // dirty (no graph data changed) but should still survive a reload.
      persistActiveViewport() {
        const { activeProjectId } = get()
        if (!activeProjectId) return
        const { viewport } = useTopologyStore.getState()
        set((s) => ({
          projects: s.projects.map((p) =>
            p.id === activeProjectId ? { ...p, viewport } : p,
          ),
        }))
      },
    }),
    {
      name: STORAGE_KEYS.projects,
      version: 1,
      migrate: (persistedState, version) => {
        if (version >= 1) return persistedState as ProjectsState
        const state = persistedState as ProjectsState
        return {
          ...state,
          projects: (state.projects ?? []).map((p) => ({
            ...p,
            nodes: p.nodes.map((n) => ({ ...n, data: migrateNodeData(n.data) })),
          })),
        }
      },
    },
  ),
)
