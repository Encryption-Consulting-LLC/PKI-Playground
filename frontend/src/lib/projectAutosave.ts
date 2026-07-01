/**
 * Bridges the ephemeral topology store to the persisted projects store.
 *
 * The only module that imports both `store/topology.ts` and `store/projects.ts`
 * — keeps the two stores decoupled from each other. Subscribes to topology
 * changes and decides, per change, whether it's just an in-progress edit
 * (mark the active project dirty, cheap, in-memory) or a checkpoint worth
 * writing to localStorage (a node finished configuring, or domain membership
 * changed). Plain drags/drops of `unconfigured` nodes only mark dirty.
 */

import { EDGE_TYPE } from "@/constants/topology"
import { useTopologyStore } from "@/store/topology"
import { useProjectsStore } from "@/store/projects"

let suppressed = false

/** Runs `fn` (a topology mutation, e.g. loadSnapshot) without it being read as a dirty edit or checkpoint. */
export function withSuppressedAutosave(fn: () => void) {
  suppressed = true
  try {
    fn()
  } finally {
    suppressed = false
  }
}

function domainJoinEdgeIds(edges: ReturnType<typeof useTopologyStore.getState>["edges"]) {
  return new Set(
    edges.filter((e) => e.data?.edgeType === EDGE_TYPE.domainJoin).map((e) => e.id),
  )
}

let initialized = false

export function initProjectAutosave() {
  if (initialized) return
  initialized = true

  useTopologyStore.subscribe((state, prev) => {
    if (suppressed) return

    // A bare pan/zoom isn't a graph edit — checkpoint the camera position
    // straight to localStorage without touching the dirty flag.
    if (state.viewport !== prev.viewport) {
      useProjectsStore.getState().persistActiveViewport()
    }

    if (state.nodes === prev.nodes && state.edges === prev.edges && state.counters === prev.counters) {
      return
    }

    // A node set change (add/remove) or a status/jobId transition is worth a
    // real checkpoint — it's what lets `unconfigured` nodes and an in-flight
    // `configuring` + `jobId` survive a reload (see resumeJobs in
    // store/topology.ts). Bare drags/progress ticks stay on the cheap
    // dirty-mark path below so they don't spam localStorage.
    const nodeSetChanged = state.nodes.length !== prev.nodes.length
    const prevById = new Map(prev.nodes.map((n) => [n.id, n.data]))
    const nodeStateChanged = state.nodes.some((n) => {
      const prevData = prevById.get(n.id)
      return !prevData || prevData.status !== n.data.status || prevData.jobId !== n.data.jobId
    })

    const domainChanged =
      state.edges !== prev.edges &&
      !setsEqual(domainJoinEdgeIds(state.edges), domainJoinEdgeIds(prev.edges))

    if (nodeSetChanged || nodeStateChanged || domainChanged) {
      useProjectsStore.getState().saveActiveSnapshot()
    } else {
      useProjectsStore.getState().markActiveDirty()
    }
  })
}

function setsEqual(a: Set<string>, b: Set<string>) {
  if (a.size !== b.size) return false
  for (const id of a) if (!b.has(id)) return false
  return true
}
