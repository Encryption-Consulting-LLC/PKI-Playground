/**
 * Pure topology helpers — no React, no store imports.
 * All inputs are plain arrays of Node/Edge data so these are trivially testable.
 */

import type { Edge, Node } from "@xyflow/react"
import { EDGE_TYPE, NODE_STATUS } from "@/constants/topology"
import type { EdgeType } from "@/constants/topology"
import type { MachineData } from "@/store/topology"

// ---------------------------------------------------------------------------
// Edge type inference
// ---------------------------------------------------------------------------

export function inferEdgeType(
  sourceTypeId: string,
  targetTypeId: string,
): EdgeType {
  if (targetTypeId === "domainController") return EDGE_TYPE.domainJoin
  if (
    sourceTypeId === "certificateAuthority" &&
    targetTypeId === "certificateAuthority"
  )
    return EDGE_TYPE.caHierarchy
  return EDGE_TYPE.network
}

// ---------------------------------------------------------------------------
// CA tier and hierarchy helpers
// ---------------------------------------------------------------------------

export type CaTier = "root" | "intermediate" | "issuing" | "standalone"

export function caTier(nodeId: string, edges: Edge[]): CaTier {
  const hasOutgoing = edges.some(
    (e) => e.source === nodeId && e.data?.edgeType === EDGE_TYPE.caHierarchy,
  )
  const hasIncoming = edges.some(
    (e) => e.target === nodeId && e.data?.edgeType === EDGE_TYPE.caHierarchy,
  )
  if (hasOutgoing && !hasIncoming) return "root"
  if (hasIncoming && hasOutgoing) return "intermediate"
  if (hasIncoming) return "issuing"
  return "standalone"
}

/** Returns the node ID of the single issuing parent CA, if any. */
export function caParent(nodeId: string, edges: Edge[]): string | null {
  const inEdge = edges.find(
    (e) => e.target === nodeId && e.data?.edgeType === EDGE_TYPE.caHierarchy,
  )
  return inEdge?.source ?? null
}

/**
 * Returns true if `maybeAncestorId` is an ancestor of `nodeId` in the CA
 * hierarchy. Uses a visited set so any accidental pre-existing loop can't
 * cause an infinite walk.
 */
export function isAncestor(
  maybeAncestorId: string,
  nodeId: string,
  edges: Edge[],
): boolean {
  const visited = new Set<string>()
  let current: string | null = nodeId
  while (current !== null) {
    if (visited.has(current)) break // defensive — shouldn't happen in a valid tree
    visited.add(current)
    const parent = caParent(current, edges)
    if (parent === maybeAncestorId) return true
    current = parent
  }
  return false
}

/**
 * Returns the depth of `nodeId` in the CA hierarchy tree.
 * Root / standalone → 0. Direct child of root → 1. And so on.
 */
export function caDepth(nodeId: string, edges: Edge[]): number {
  const visited = new Set<string>()
  let depth = 0
  let current: string | null = nodeId
  while (true) {
    const parent = caParent(current, edges)
    if (parent === null) break
    if (visited.has(parent)) break // defensive
    visited.add(parent)
    depth++
    current = parent
  }
  return depth
}

// ---------------------------------------------------------------------------
// Domain membership
// ---------------------------------------------------------------------------

export function domainMembership(
  nodeId: string,
  edges: Edge[],
  nodes: Node<MachineData>[],
): string | null {
  const joinEdge = edges.find(
    (e) =>
      e.source === nodeId && e.data?.edgeType === EDGE_TYPE.domainJoin,
  )
  if (!joinEdge) return null
  const dcNode = nodes.find((n) => n.id === joinEdge.target)
  return dcNode?.data.name ?? null
}

// ---------------------------------------------------------------------------
// Connection validation
// ---------------------------------------------------------------------------

export interface CanConnectResult {
  ok: boolean
  reason?: string
}

export function canConnect(
  sourceId: string,
  targetId: string,
  nodes: Node<MachineData>[],
  edges: Edge[],
): CanConnectResult {
  if (sourceId === targetId) {
    return { ok: false, reason: "Cannot connect a node to itself." }
  }

  const duplicate = edges.some(
    (e) =>
      (e.source === sourceId && e.target === targetId) ||
      (e.source === targetId && e.target === sourceId),
  )
  if (duplicate) {
    return { ok: false, reason: "A connection between these nodes already exists." }
  }

  const source = nodes.find((n) => n.id === sourceId)
  const target = nodes.find((n) => n.id === targetId)

  if (!source || !target) {
    return { ok: false, reason: "Node not found." }
  }

  if (source.data.status !== NODE_STATUS.configured) {
    return { ok: false, reason: `"${source.data.name}" must be configured first.` }
  }
  if (target.data.status !== NODE_STATUS.configured) {
    return { ok: false, reason: `"${target.data.name}" must be configured first.` }
  }

  const edgeType = inferEdgeType(source.data.typeId, target.data.typeId)

  // Root CAs must not be domain-joined
  if (edgeType === EDGE_TYPE.domainJoin) {
    const sourceTier = caTier(sourceId, edges)
    if (source.data.typeId === "certificateAuthority" && sourceTier === "root") {
      return {
        ok: false,
        reason: "Root CAs must not be domain-joined.",
      }
    }
  }

  // CA hierarchy must remain a tree: one parent per CA, no cycles
  if (edgeType === EDGE_TYPE.caHierarchy) {
    // Each CA can have at most one issuing parent
    const targetAlreadyHasParent = edges.some(
      (e) => e.target === targetId && e.data?.edgeType === EDGE_TYPE.caHierarchy,
    )
    if (targetAlreadyHasParent) {
      return {
        ok: false,
        reason: "This CA already has an issuer — a CA can have only one parent.",
      }
    }

    // Prevent loops: the target must not already be an ancestor of the source
    if (isAncestor(targetId, sourceId, edges)) {
      return {
        ok: false,
        reason: "That would create a loop in the CA hierarchy.",
      }
    }
  }

  return { ok: true }
}

// ---------------------------------------------------------------------------
// Edge visual style
// ---------------------------------------------------------------------------

export interface EdgeStyleProps {
  style: React.CSSProperties
  animated: boolean
  label: string
  labelStyle: React.CSSProperties
}

export function edgeStyle(type: EdgeType): EdgeStyleProps {
  switch (type) {
    case EDGE_TYPE.domainJoin:
      return {
        style: { stroke: "#3b82f6", strokeWidth: 2 },
        animated: false,
        label: "domain join",
        labelStyle: { fill: "#3b82f6", fontSize: 11 },
      }
    case EDGE_TYPE.caHierarchy:
      return {
        style: { stroke: "#f59e0b", strokeWidth: 2 },
        animated: false,
        label: "issues",
        labelStyle: { fill: "#f59e0b", fontSize: 11 },
      }
    case EDGE_TYPE.network:
      return {
        style: { stroke: "#94a3b8", strokeWidth: 1.5, strokeDasharray: "5 4" },
        animated: false,
        label: "",
        labelStyle: { fill: "#94a3b8", fontSize: 11 },
      }
  }
}
