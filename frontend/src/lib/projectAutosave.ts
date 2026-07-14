/**
 * Bridges the ephemeral topology store to the persisted projects store.
 *
 * The only module that imports both `store/topology.ts` and `store/projects.ts`
 * — keeps the two stores decoupled from each other. Subscribes to topology
 * changes and decides, per change, whether it's just an in-progress edit
 * (mark the active project dirty, cheap, in-memory) or a checkpoint worth
 * writing to localStorage (a node finished deploying, or domain membership
 * changed). Plain drags/drops of `draft` nodes only mark dirty.
 */

import { EDGE_TYPE } from "@/constants/topology"
import { useTopologyStore } from "@/store/topology"
import { useProjectsStore } from "@/store/projects"
import { useStagingStore } from "@/store/staging"

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

function edgeHealthChanged(
  edges: ReturnType<typeof useTopologyStore.getState>["edges"],
  previous: ReturnType<typeof useTopologyStore.getState>["edges"],
) {
  const previousById = new Map(previous.map((edge) => [edge.id, edge.data]))
  return edges.some((edge) => {
    const old = previousById.get(edge.id)
    return old?.health !== edge.data?.health ||
      JSON.stringify(old?.serviceHealth ?? {}) !==
        JSON.stringify(edge.data?.serviceHealth ?? {})
  })
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

    // A node set change (add/remove) or a lifecycle-relevant field transition
    // is worth a real checkpoint — it's what lets `draft` nodes and an
    // in-flight `deploying` + `jobId` survive a reload (see resumeJobs in
    // store/topology.ts). Bare drags/progress ticks stay on the cheap
    // dirty-mark path below so they don't spam localStorage.
    const nodeSetChanged = state.nodes.length !== prev.nodes.length
    const prevById = new Map(prev.nodes.map((n) => [n.id, n.data]))
    const nodeStateChanged = state.nodes.some((n) => {
      const prevData = prevById.get(n.id)
      return (
        !prevData ||
        prevData.lifecycle !== n.data.lifecycle ||
        prevData.jobId !== n.data.jobId ||
        prevData.poweredOn !== n.data.poweredOn ||
        prevData.config !== n.data.config ||
        prevData.lastDeployedConfig !== n.data.lastDeployedConfig ||
        prevData.certificateJourney !== n.data.certificateJourney ||
        prevData.labEvidence !== n.data.labEvidence
      )
    })

    const domainChanged =
      state.edges !== prev.edges &&
      !setsEqual(domainJoinEdgeIds(state.edges), domainJoinEdgeIds(prev.edges))
    const healthChanged =
      state.edges !== prev.edges && edgeHealthChanged(state.edges, prev.edges)

    if (nodeSetChanged || nodeStateChanged || domainChanged || healthChanged) {
      useProjectsStore.getState().saveActiveSnapshot()
    } else {
      useProjectsStore.getState().markActiveDirty()
    }
  })

  // Staged ops change at human frequency (one stage/undo/deploy at a time),
  // so every change is worth a real checkpoint rather than a dirty-mark.
  useStagingStore.subscribe((state, prev) => {
    if (suppressed) return
    if (state.ops !== prev.ops || state.deployJobId !== prev.deployJobId) {
      useProjectsStore.getState().saveActiveSnapshot()
    }
  })
}

function setsEqual(a: Set<string>, b: Set<string>) {
  if (a.size !== b.size) return false
  for (const id of a) if (!b.has(id)) return false
  return true
}
