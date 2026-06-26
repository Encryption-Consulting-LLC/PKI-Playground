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
import { NODE_STATUS } from "@/constants/topology"
import type { NodeStatus } from "@/constants/topology"
import {
  canConnect,
  edgeStyle,
  inferEdgeType,
} from "@/lib/topology"

// ---------------------------------------------------------------------------
// Node data type
// ---------------------------------------------------------------------------

export interface MachineData extends Record<string, unknown> {
  typeId: string
  name: string
  status: NodeStatus
  config?: Record<string, string>
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

  configureNode(id, config) {
    set((s) => ({
      nodes: s.nodes.map((n) =>
        n.id === id
          ? { ...n, data: { ...n.data, status: NODE_STATUS.configuring, ...(config ? { config } : {}) } }
          : n,
      ),
    }))
    // Simulate the clone workflow delay
    setTimeout(() => {
      set((s) => ({
        nodes: s.nodes.map((n) =>
          n.id === id ? { ...n, data: { ...n.data, status: NODE_STATUS.configured } } : n,
        ),
      }))
    }, 1800)
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
