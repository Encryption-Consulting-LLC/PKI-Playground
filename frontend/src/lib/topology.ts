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
// Domain regions (spatial domain join)
// ---------------------------------------------------------------------------
//
// A domain controller projects a circular "domain" region around itself. Any
// eligible node whose centre falls inside that circle is domain-joined. The
// radius is expressed in flow units (== node-pixel units at zoom 1), so the
// rendered circle and the geometry test below stay in lock-step at any zoom.

export const DOMAIN_RADIUS = 260

/** Centre of a node in flow coordinates (position is the top-left corner). */
export function nodeCenter(node: Node<MachineData>): { x: number; y: number } {
  const w = node.measured?.width ?? 160
  const h = node.measured?.height ?? 80
  return { x: node.position.x + w / 2, y: node.position.y + h / 2 }
}

/** Human label for a domain — the DC's configured domain name, else its node name. */
export function domainLabel(dc: Node<MachineData>): string {
  return dc.data.config?.domainName ?? dc.data.name
}

/**
 * Whether `node` can be auto-joined to a domain by being dragged into a region.
 * Domain controllers define domains (they don't join others), root CAs must
 * stay out of any domain, and a VM must be configured before it can join.
 */
export function isDomainEligible(node: Node<MachineData>, edges: Edge[]): boolean {
  if (node.data.typeId === "domainController") return false
  if (node.data.status !== NODE_STATUS.configured) return false
  if (
    node.data.typeId === "certificateAuthority" &&
    caTier(node.id, edges) === "root"
  )
    return false
  return true
}

/**
 * The configured domain controller whose region contains `node`. When regions
 * overlap, the nearest DC wins so membership is unambiguous.
 */
export function findDomainForNode(
  node: Node<MachineData>,
  nodes: Node<MachineData>[],
): Node<MachineData> | null {
  const c = nodeCenter(node)
  let best: Node<MachineData> | null = null
  let bestDist = Infinity
  for (const dc of nodes) {
    if (dc.id === node.id) continue
    if (dc.data.typeId !== "domainController") continue
    if (dc.data.status !== NODE_STATUS.configured) continue
    const dcc = nodeCenter(dc)
    const dist = Math.hypot(c.x - dcc.x, c.y - dcc.y)
    if (dist <= DOMAIN_RADIUS && dist < bestDist) {
      best = dc
      bestDist = dist
    }
  }
  return best
}

/**
 * A domain-join edge created by dropping a node into a region. Kept hidden —
 * the circle itself communicates membership — but still carries the
 * `domainJoin` edgeType so existing derived logic (badges, member counts)
 * continues to work unchanged.
 */
export function domainJoinEdge(source: string, target: string): Edge {
  return {
    id: `e-domain-${source}-${target}`,
    source,
    target,
    type: "smoothstep",
    hidden: true,
    data: { edgeType: EDGE_TYPE.domainJoin },
  }
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
