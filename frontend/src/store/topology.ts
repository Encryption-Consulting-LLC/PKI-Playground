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
} from "@xyflow/react"
import { create } from "zustand"

import { AUTO_NAME_PREFIX } from "@/constants/templates"
import { EDGE_TYPE, NODE_STATUS } from "@/constants/topology"
import type { NodeStatus } from "@/constants/topology"
import { cloneVm } from "@/lib/api"
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
import { useAuthStore } from "@/store/auth"

// Standalone clone parameters. The base image and host specs are fixed for the
// playground; only the per-VM name varies. Names are prefixed with
// `guest-<uniqueId>-` (uniqueId = a short slice of the session token) so each
// guest's clones are easy to spot in the ESXi inventory.
const STANDALONE_CLONE = {
  base: "ws-2025-base",
  datastore: "datastore1",
  cpus: 2,
  mem_mb: 4096,
} as const

// ---------------------------------------------------------------------------
// Node data type
// ---------------------------------------------------------------------------

export interface MachineData extends Record<string, unknown> {
  typeId: string
  name: string
  status: NodeStatus
  config?: Record<string, string>
  /** 0–100 while `status === configuring`; drives the node's progress bar. */
  progress?: number
  /** Human label of the current configuration step (from the progress stream). */
  phase?: string
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
// Store
// ---------------------------------------------------------------------------

interface TopologyState {
  nodes: Node<MachineData>[]
  edges: Edge[]
  selectedNodeId: string | null
  counters: Record<string, number>

  addNode: (typeId: string, position: { x: number; y: number }) => void
  applyNodeChanges: (changes: NodeChange<Node<MachineData>>[]) => void
  applyEdgeChanges: (changes: EdgeChange[]) => void
  connect: (connection: Connection) => string | null
  computeDomainChanges: (movedId: string) => DomainSyncChange[]
  applyDomainChanges: (changes: DomainSyncChange[]) => void
  configureNode: (id: string, config?: Record<string, string>) => void
  renameNode: (id: string, name: string) => void
  removeNode: (id: string) => void
  removeEdge: (id: string) => void
  selectNode: (id: string | null) => void
}

export const useTopologyStore = create<TopologyState>()((set, get) => ({
  nodes: [],
  edges: [],
  selectedNodeId: null,
  counters: {},

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
        status: NODE_STATUS.unconfigured,
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
    const { nodes, edges } = get()
    const { source, target } = connection
    const result = canConnect(source, target, nodes, edges)
    if (!result.ok) return result.reason ?? "Connection blocked."

    const sourceNode = nodes.find((n) => n.id === source)!
    const targetNode = nodes.find((n) => n.id === target)!
    const type = inferEdgeType(sourceNode.data.typeId, targetNode.data.typeId)
    const style = edgeStyle(type)

    const newEdge: Edge = {
      id: `e-${source}-${target}`,
      source,
      target,
      type: "smoothstep",
      markerEnd: { type: "arrowclosed" as const },
      data: { edgeType: type },
      ...style,
    }

    set((s) => ({ edges: addEdge(newEdge, s.edges) }))
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

      const dc = findDomainForNode(node, nodes)
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
    set((s) => {
      let edges = s.edges
      for (const c of changes) {
        // Drop any existing membership, then add the new one (if joining).
        edges = edges.filter(
          (e) =>
            !(e.source === c.nodeId && e.data?.edgeType === EDGE_TYPE.domainJoin),
        )
        if (c.dcId) edges = [...edges, domainJoinEdge(c.nodeId, c.dcId)]
      }
      return { edges }
    })
  },

  configureNode(id, config) {
    // Patch one node's data; merges so callers set just the fields they touch.
    const patch = (data: Partial<MachineData>) =>
      set((s) => ({
        nodes: s.nodes.map((n) =>
          n.id === id ? { ...n, data: { ...n.data, ...data } } : n,
        ),
      }))

    const node = get().nodes.find((n) => n.id === id)

    patch({
      status: NODE_STATUS.configuring,
      progress: 0,
      phase: undefined,
      ...(config ? { config } : {}),
    })

    // Standalone is the only template wired to the real clone API. Everything
    // else still simulates the workflow delay.
    if (node?.data.typeId === "standalone") {
      const token = useAuthStore.getState().token
      const uniqueId = token ? token.slice(0, 8) : "local"
      const name = `guest-${uniqueId}-${node.data.name}`

      cloneVm({ name, ...STANDALONE_CLONE })
        .then(({ job_id }) => {
          // Stream live clone progress onto the node; the socket closes itself
          // (and we close it) once a terminal frame arrives.
          const close = openJobSocket(job_id, token, {
            onProgress: (e) => patch({ progress: e.percent, phase: e.phase }),
            onDone: () => {
              patch({ status: NODE_STATUS.configured, progress: 100 })
              close()
            },
            onError: () => {
              patch({ status: NODE_STATUS.error })
              close()
            },
          })
        })
        .catch(() => patch({ status: NODE_STATUS.error }))
      return
    }

    // Simulated templates: animate a fake 0→100 bar over the delay so every node
    // shows consistent progress UI, then mark configured.
    const start = Date.now()
    const DURATION = 1800
    const timer = setInterval(() => {
      const pct = Math.min(100, ((Date.now() - start) / DURATION) * 100)
      if (pct >= 100) {
        clearInterval(timer)
        patch({ status: NODE_STATUS.configured, progress: 100 })
      } else {
        patch({ progress: Math.round(pct) })
      }
    }, 120)
  },

  renameNode(id, name) {
    set((s) => ({
      nodes: s.nodes.map((n) =>
        n.id === id ? { ...n, data: { ...n.data, name } } : n,
      ),
    }))
  },

  removeNode(id) {
    set((s) => ({
      nodes: s.nodes.filter((n) => n.id !== id),
      edges: s.edges.filter((e) => e.source !== id && e.target !== id),
      selectedNodeId: s.selectedNodeId === id ? null : s.selectedNodeId,
    }))
  },

  removeEdge(id) {
    set((s) => ({ edges: s.edges.filter((e) => e.id !== id) }))
  },

  selectNode(id) {
    if (get().selectedNodeId === id) return
    set({ selectedNodeId: id })
  },
}))
