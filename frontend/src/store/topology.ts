/**
 * Ephemeral topology store — nodes + edges live in memory for the session.
 *
 * Wraps React Flow's applyNodeChanges / applyEdgeChanges helpers so the rest
 * of the app talks through this store rather than calling React Flow directly.
 *
 * Seam: to add persistence, wrap the create() call with the zustand `persist`
 * middleware and point it at localStorage or a backend endpoint.
 */

import {
  addEdge,
  applyEdgeChanges,
  applyNodeChanges,
  type Connection,
  type Edge,
  type EdgeChange,
  type Node,
  type NodeChange,
  type Viewport,
} from "@xyflow/react"
import { create } from "zustand"

import { AUTO_NAME_PREFIX } from "@/constants/templates"
import { EDGE_TYPE, LIFECYCLE } from "@/constants/topology"
import type { Lifecycle } from "@/constants/topology"
import { openJobSocket } from "@/lib/ws"
import {
  canConnect,
  domainJoinEdge,
  domainLabel,
  edgeStyle,
  findDomainForNode,
  inferEdgeType,
  isDomainEligible,
} from "@/lib/topology"
import { OP_KIND, findStagedOp } from "@/lib/staging"
import { useAuthStore } from "@/store/auth"
import { opsReferencingNode, useStagingStore } from "@/store/staging"

// ---------------------------------------------------------------------------
// Node data type
// ---------------------------------------------------------------------------

export interface MachineData extends Record<string, unknown> {
  typeId: string
  name: string
  lifecycle: Lifecycle
  poweredOn: boolean
  /** Config as of the last successful deploy; compared against `config` to derive drift. */
  lastDeployedConfig?: Record<string, string>
  config?: Record<string, string>
  /** 0–100 while `lifecycle === deploying`; drives the node's progress bar. */
  progress?: number
  /** Human label of the current configuration step (from the progress stream). */
  phase?: string
  /**
   * Deploy-confirmed identity of the real VM behind this node, from the
   * createVm op's result (`applyPlanState`): the pool-allocated guest IP and
   * the real (namespaced) ESXi inventory name. Distinct from `name`, the
   * renameable display label. `vmName` doubles as the "a real VM exists"
   * signal — teardown is offered iff it is set. Both persist (durable facts,
   * not run transients).
   */
  ip?: string
  vmName?: string
  /**
   * Backend clone job id while `lifecycle === deploying` on the `standalone`
   * template. Persisted (rides `MachineData` into localStorage) so a reload
   * can resubscribe to the job's WebSocket instead of losing it — see
   * `attachJobSocket`/`resumeJobs`.
   */
  jobId?: string
  /**
   * vm_id of an orchestrator agent this node is manually associated with,
   * from `POST /orchestrator/register` (see `Inspector.tsx`'s Orchestrator
   * section). There is no automatic VM<->agent correlation yet — vmkit has
   * no guest-correlation mechanism and isokit/configgen can't bake this in
   * at boot time (see `pki-orchestrator/README.md`) — so a human pastes it
   * in, standing in for what a real deployment will do automatically later.
   */
  orchestratorVmId?: string
}

/**
 * One node's pending domain membership transition, produced by
 * `computeDomainChanges` and applied (after confirmation) by
 * `applyDomainChanges`. A null `dcId`/`domainName` means the node leaves its
 * current domain; the *Name fields are carried alongside the ids purely so the
 * confirmation prompt can describe the change without re-deriving names.
 */
export interface DomainSyncChange {
  nodeId: string
  nodeName: string
  dcId: string | null
  domainName: string | null
}

// ---------------------------------------------------------------------------
// Live job sockets
// ---------------------------------------------------------------------------

// Transient, per-node teardown for an open job-progress socket. Deliberately
// module-level (not store state): it holds closures, not serializable data,
// and mirrors `overlapNodeId`'s reasoning — it must never flow into
// persistence or trip the autosave subscription.
const activeSockets = new Map<string, () => void>()

/**
 * Opens (or, after a reload, resumes) the progress socket for one node's clone
 * job and wires it to `patch`. Shared by `configureNode` (fresh clone) and
 * `resumeJobs` (rehydration) so both paths handle queued/running/progress/
 * done/error identically. Skips if a socket for `nodeId` is already tracked.
 */
function attachJobSocket(
  nodeId: string,
  jobId: string,
  token: string | null | undefined,
  patch: (data: Partial<MachineData>) => void,
) {
  if (activeSockets.has(nodeId)) return

  const close = openJobSocket(jobId, token, {
    // Clones queue behind the backend's worker concurrency cap; surface
    // that wait as a phase label rather than a separate lifecycle state so
    // existing lifecycle-driven UI (badges, counts) doesn't need to change.
    onQueued: () => patch({ phase: "Queued", progress: 0 }),
    onRunning: () => patch({ phase: "Starting", progress: 0 }),
    onProgress: (e) => patch({ progress: e.percent, phase: e.phase }),
    onDone: () => {
      activeSockets.delete(nodeId)
      const node = useTopologyStore.getState().nodes.find((n) => n.id === nodeId)
      patch({
        lifecycle: LIFECYCLE.deployed,
        poweredOn: true,
        lastDeployedConfig: node?.data.config,
        progress: 100,
        jobId: undefined,
      })
      close()
    },
    onError: (e) => {
      activeSockets.delete(nodeId)
      // status 0 is a synthetic frame from `lib/ws.ts` for a socket that
      // closed without a terminal frame — e.g. the backend's snapshot expired
      // (4404) or the WS dropped mid-clone. That's not necessarily a failed
      // clone, so revert to draft (retryable) rather than a hard error; a
      // real backend `error` frame (status > 0) is a genuine failure.
      if (e.status === 0) {
        patch({ lifecycle: LIFECYCLE.draft, progress: undefined, phase: undefined, jobId: undefined })
      } else {
        patch({ lifecycle: LIFECYCLE.failed, jobId: undefined })
      }
      close()
    },
  })
  activeSockets.set(nodeId, close)
}

// ---------------------------------------------------------------------------
// Store
// ---------------------------------------------------------------------------

export const DEFAULT_VIEWPORT: Viewport = { x: 0, y: 0, zoom: 1 }

interface TopologyState {
  nodes: Node<MachineData>[]
  edges: Edge[]
  selectedNodeId: string | null
  counters: Record<string, number>
  /** Camera pan/zoom; not part of the graph data but persisted per project. */
  viewport: Viewport
  /**
   * Id of the node currently overlapping another mid-drag (drives the red
   * translucent warning state). Deliberately not part of `nodes`/`edges`/
   * `counters` so updating it doesn't trip the autosave/dirty subscription.
   */
  overlapNodeId: string | null

  addNode: (typeId: string, position: { x: number; y: number }) => void
  applyNodeChanges: (changes: NodeChange<Node<MachineData>>[]) => void
  applyEdgeChanges: (changes: EdgeChange[]) => void
  connect: (connection: Connection) => string | null
  computeDomainChanges: (movedId: string) => DomainSyncChange[]
  applyDomainChanges: (changes: DomainSyncChange[]) => void
  configureNode: (id: string, config?: Record<string, string>) => void
  /**
   * Reattaches job-progress sockets for any node still `deploying` after a
   * reload (has a persisted `jobId`), and reverts any `deploying` node with
   * no `jobId` (a plan-driven op, or a reload mid-enqueue) back to `staged`
   * (if a matching staged op survived the reload) or `draft`. Called after
   * `loadSnapshot`.
   */
  resumeJobs: () => void
  renameNode: (id: string, name: string) => void
  /** Merges a partial data patch into one node — the seam the staging store's undo/cascade reverts go through. */
  patchNodeData: (id: string, data: Partial<MachineData>) => void
  removeNode: (id: string) => void
  removeEdge: (id: string) => void
  /** Re-adds a previously-removed edge verbatim — used by `domainLeave` undo to restore the exact membership edge it replaced. */
  restoreEdge: (edge: Edge) => void
  /** Clears an edge's ghost styling once its staged op has deployed successfully. */
  commitEdge: (edgeId: string) => void
  selectNode: (id: string | null) => void
  setViewport: (viewport: Viewport) => void
  setOverlapNode: (id: string | null) => void
  /** Replaces the working graph wholesale — used when switching/creating projects. */
  loadSnapshot: (
    nodes: Node<MachineData>[],
    edges: Edge[],
    counters: Record<string, number>,
    viewport: Viewport,
  ) => void
}

export const useTopologyStore = create<TopologyState>()((set, get) => ({
  nodes: [],
  edges: [],
  selectedNodeId: null,
  counters: {},
  viewport: DEFAULT_VIEWPORT,
  overlapNodeId: null,

  addNode(typeId, position) {
    const counters = { ...get().counters }
    const n = (counters[typeId] ?? 0) + 1
    counters[typeId] = n
    const prefix = AUTO_NAME_PREFIX[typeId] ?? typeId.slice(0, 4)
    const name = `${prefix}${String(n).padStart(2, "0")}`

    const newNode: Node<MachineData> = {
      id: `${typeId}-${n}-${Date.now()}`,
      type: "machine",
      position,
      selected: false,
      data: {
        typeId,
        name,
        lifecycle: LIFECYCLE.draft,
        poweredOn: false,
      },
    }

    set((s) => ({
      nodes: [...s.nodes, newNode],
      counters,
    }))
  },

  applyNodeChanges(changes) {
    set((s) => ({
      nodes: applyNodeChanges(changes, s.nodes),
    }))
  },

  applyEdgeChanges(changes) {
    set((s) => ({
      edges: applyEdgeChanges(changes, s.edges),
    }))
  },

  connect(connection) {
    if (useStagingStore.getState().deploying) return "Canvas is locked while deploying."
    const { nodes, edges } = get()
    const { source, target, sourceHandle, targetHandle } = connection
    const result = canConnect(source, target, nodes, edges)
    if (!result.ok) return result.reason ?? "Connection blocked."

    const sourceNode = nodes.find((n) => n.id === source)!
    const targetNode = nodes.find((n) => n.id === target)!
    const type = inferEdgeType(sourceNode.data.typeId, targetNode.data.typeId)
    const rootIssuer = sourceNode.data.config?.caType === "Root"
    const style = edgeStyle(type, { rootIssuer })

    const edgeId = `e-${source}-${target}`
    const newEdge: Edge = {
      id: edgeId,
      source,
      target,
      sourceHandle,
      targetHandle,
      // Web-server CDP/AIA publishing reads as a curved line; CA hierarchy
      // and other edges keep the existing orthogonal routing.
      type: type === EDGE_TYPE.webServerCert ? "default" : "smoothstep",
      markerEnd: { type: "arrowclosed" as const },
      data: { edgeType: type, staged: true, rootIssuer },
      ...style,
      // Ghost styling until this op is deployed — commitEdge (M4) clears it.
      style: { ...style.style, strokeDasharray: "6 4", opacity: 0.6 },
    }

    set((s) => ({ edges: addEdge(newEdge, s.edges) }))

    // A CA-hierarchy op belongs to the child being issued to; a web-server
    // publish op belongs to the issuing CA — see lib/staging.ts's
    // inferDependsOn, which keys a webServerCert op's caConnect dependency
    // off this same targetNodeId.
    const isCaHierarchy = type === EDGE_TYPE.caHierarchy
    const opTarget = isCaHierarchy ? targetNode : sourceNode
    const opSecondary = isCaHierarchy ? sourceNode : targetNode

    useStagingStore.getState().stageOp({
      kind: isCaHierarchy ? OP_KIND.caConnect : OP_KIND.webServerCert,
      targetNodeId: opTarget.id,
      secondaryNodeId: opSecondary.id,
      params: {},
      label: isCaHierarchy
        ? `Issue from ${opSecondary.data.name}`
        : `Publish CDP/AIA to ${opSecondary.data.name}`,
      edgeId,
    })

    return null // null = success
  },

  computeDomainChanges(movedId) {
    const { nodes, edges } = get()
    const moved = nodes.find((n) => n.id === movedId)
    if (!moved) return []

    // Moving a DC reshapes its region, so every other node is re-evaluated.
    // Moving anything else only changes that one node's membership.
    const candidates =
      moved.data.typeId === "domainController"
        ? nodes.filter((n) => n.id !== movedId)
        : [moved]

    const changes: DomainSyncChange[] = []

    for (const node of candidates) {
      if (!isDomainEligible(node, edges)) continue

      const dc = findDomainForNode(node, nodes, edges)
      const targetDcId = dc?.id ?? null
      const currentEdge = edges.find(
        (e) =>
          e.source === node.id && e.data?.edgeType === EDGE_TYPE.domainJoin,
      )
      if ((currentEdge?.target ?? null) === targetDcId) continue

      changes.push({
        nodeId: node.id,
        nodeName: node.data.name,
        dcId: targetDcId,
        domainName: dc ? domainLabel(dc) : null,
      })
    }

    return changes
  },

  applyDomainChanges(changes) {
    if (changes.length === 0) return
    if (useStagingStore.getState().deploying) return
    for (const c of changes) {
      // Capture what's being replaced before mutating — `domainLeave`'s
      // undo needs the DC it left to re-add the exact same edge.
      const prevEdge = get().edges.find(
        (e) => e.source === c.nodeId && e.data?.edgeType === EDGE_TYPE.domainJoin,
      )
      const prevDcId = prevEdge?.target ?? null

      set((s) => ({
        edges: s.edges.filter(
          (e) => !(e.source === c.nodeId && e.data?.edgeType === EDGE_TYPE.domainJoin),
        ),
      }))

      // Retargeting (or leaving) a membership that only existed as a staged
      // op is a pure undo of that op — no domainLeave op needed.
      const existingJoinOp = findStagedOp(useStagingStore.getState().ops, OP_KIND.domainJoin, c.nodeId)
      if (existingJoinOp) useStagingStore.getState().removeOpCascade(existingJoinOp.id)

      // A *deployed* prior membership isn't undone by cascading a staged op —
      // the backend needs an explicit leave, staged before the new join (both
      // whether this is a plain leave or a retarget onto a different DC).
      if (prevDcId && !existingJoinOp) {
        useStagingStore.getState().stageOp({
          kind: OP_KIND.domainLeave,
          targetNodeId: c.nodeId,
          params: { prevDcId },
          label: "Leave domain",
        })
      }

      if (c.dcId) {
        const newEdge = domainJoinEdge(c.nodeId, c.dcId)
        set((s) => ({ edges: [...s.edges, newEdge] }))
        useStagingStore.getState().stageOp({
          kind: OP_KIND.domainJoin,
          targetNodeId: c.nodeId,
          secondaryNodeId: c.dcId,
          // Carried so undoing just this join restores the exact edge it
          // replaced, without relying on the paired domainLeave op above
          // also being undone.
          params: prevDcId && !existingJoinOp ? { prevDcId } : {},
          label: `Join ${c.domainName}`,
          edgeId: newEdge.id,
        })
      }
    }
  },

  configureNode(id, config) {
    if (useStagingStore.getState().deploying) return
    // Patch one node's data; merges so callers set just the fields they touch.
    const patch = (data: Partial<MachineData>) =>
      set((s) => ({
        nodes: s.nodes.map((n) =>
          n.id === id ? { ...n, data: { ...n.data, ...data } } : n,
        ),
      }))

    const node = get().nodes.find((n) => n.id === id)
    if (!node) return
    const { lifecycle } = node.data

    // Deployed already — config edits mark it drifted rather than restaging;
    // reapplying a deployed node's config is out of scope for v1 (Deploy
    // skips drifted nodes).
    if (lifecycle === LIFECYCLE.deployed || lifecycle === LIFECYCLE.drifted) {
      patch({ ...(config ? { config } : {}), lifecycle: LIFECYCLE.drifted })
      return
    }

    // Already staged — node.config is the sole source of truth for a
    // pending createVm's params (read fresh at deploy time by
    // `buildOpParams`), so reconfiguring just updates it in place.
    if (lifecycle === LIFECYCLE.staged) {
      if (config) patch({ config })
      return
    }

    // draft or failed — stage a fresh createVm op. The real clone (or
    // simulation) only runs once this op is flushed by Deploy.
    patch({ ...(config ? { config } : {}), lifecycle: LIFECYCLE.staged })
    useStagingStore.getState().stageOp({
      kind: OP_KIND.createVm,
      targetNodeId: id,
      params: {},
      label: "Create VM",
    })
  },

  resumeJobs() {
    const token = useAuthStore.getState().token
    // Without a live token we can neither authenticate a resumed socket nor
    // legitimately conclude a job failed — leave `deploying` nodes as-is
    // rather than reverting them (belt-and-suspenders alongside the
    // `sessionReady` gate in App.tsx that should prevent this from firing
    // with a null token in the first place).
    if (!token) return
    for (const node of get().nodes) {
      if (node.data.lifecycle !== LIFECYCLE.deploying) continue
      if (activeSockets.has(node.id)) continue

      const patch = (data: Partial<MachineData>) =>
        set((s) => ({
          nodes: s.nodes.map((n) =>
            n.id === node.id ? { ...n, data: { ...n.data, ...data } } : n,
          ),
        }))

      if (node.data.jobId) {
        attachJobSocket(node.id, node.data.jobId, token, patch)
      } else {
        // No job to resume — a plan-driven op mid-flight, or a reload before
        // one enqueued. Revert to staged if a matching op survived the
        // reload (retryable via Deploy), else draft.
        const hasStagedOp = !!findStagedOp(useStagingStore.getState().ops, OP_KIND.createVm, node.id)
        patch({
          lifecycle: hasStagedOp ? LIFECYCLE.staged : LIFECYCLE.draft,
          progress: undefined,
          phase: undefined,
        })
      }
    }
  },

  renameNode(id, name) {
    if (useStagingStore.getState().deploying) return
    set((s) => ({
      nodes: s.nodes.map((n) =>
        n.id === id ? { ...n, data: { ...n.data, name } } : n,
      ),
    }))
  },

  patchNodeData(id, data) {
    set((s) => ({
      nodes: s.nodes.map((n) =>
        n.id === id ? { ...n, data: { ...n.data, ...data } } : n,
      ),
    }))
  },

  removeNode(id) {
    if (useStagingStore.getState().deploying) return
    activeSockets.get(id)?.()
    activeSockets.delete(id)
    // Deleting the node makes any staged op referencing it meaningless —
    // cascade-remove them so the Staged panel never lists a dangling op.
    // (The UI's own confirm dialog is expected to have already asked about
    // this before calling removeNode; this is the data-integrity backstop.)
    const staging = useStagingStore.getState()
    for (const op of opsReferencingNode(staging.ops, id)) {
      useStagingStore.getState().removeOpCascade(op.id)
    }
    set((s) => ({
      nodes: s.nodes.filter((n) => n.id !== id),
      edges: s.edges.filter((e) => e.source !== id && e.target !== id),
      selectedNodeId: s.selectedNodeId === id ? null : s.selectedNodeId,
    }))
  },

  removeEdge(id) {
    set((s) => ({ edges: s.edges.filter((e) => e.id !== id) }))
  },

  restoreEdge(edge) {
    // Idempotent: a retarget stages both a domainLeave and a domainJoin that
    // each carry the same `prevDcId`-derived edge, so undoing both in
    // sequence would otherwise restore it twice.
    set((s) => (s.edges.some((e) => e.id === edge.id) ? s : { edges: [...s.edges, edge] }))
  },

  commitEdge(edgeId) {
    set((s) => ({
      edges: s.edges.map((e) => {
        if (e.id !== edgeId) return e
        const edgeType = e.data?.edgeType as ReturnType<typeof inferEdgeType> | undefined
        if (!edgeType) return { ...e, data: { ...e.data, staged: false } }
        const clean = edgeStyle(edgeType, { rootIssuer: e.data?.rootIssuer as boolean | undefined })
        return { ...e, ...clean, data: { ...e.data, staged: false } }
      }),
    }))
  },

  selectNode(id) {
    if (get().selectedNodeId === id) return
    set({ selectedNodeId: id })
  },

  setViewport(viewport) {
    set({ viewport })
  },

  setOverlapNode(id) {
    if (get().overlapNodeId === id) return
    set({ overlapNodeId: id })
  },

  loadSnapshot(nodes, edges, counters, viewport) {
    // Tear down the outgoing graph's live sockets before swapping — a project
    // switch shouldn't leak sockets tied to nodes that are about to unmount.
    for (const close of activeSockets.values()) close()
    activeSockets.clear()
    set({ nodes, edges, counters, viewport, selectedNodeId: null })
    // Reattach/revert any `configuring` node in the graph just loaded — this
    // is what makes an in-flight clone resume after a reload or project switch.
    get().resumeJobs()
  },
}))
