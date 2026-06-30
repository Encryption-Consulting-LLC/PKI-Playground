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
  return dcNode ? domainLabel(dcNode) : null
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

/** Extra clearance kept between a domain's farthest member and its circle edge. */
const DOMAIN_MEMBER_PADDING = 90

/**
 * How close another node must be to a drifting member for that member to
 * still count as "huddled with the pack" rather than being carried out on
 * its own — keeps the circle from snapping back mid-shuffle when a cluster
 * of members moves together.
 */
const DOMAIN_EXIT_NEIGHBOR_CLEARANCE = 100

/**
 * Extra distance, past the radius the domain would have without a given
 * member, that member must clear before it's treated as leaving — gives the
 * boundary some hysteresis so the circle doesn't flicker right at the edge.
 */
const DOMAIN_EXIT_MARGIN = 40

/** Centre of a node in flow coordinates (position is the top-left corner). */
export function nodeCenter(node: Node<MachineData>): { x: number; y: number } {
  const w = node.measured?.width ?? 160
  const h = node.measured?.height ?? 80
  return { x: node.position.x + w / 2, y: node.position.y + h / 2 }
}

/** Extra clearance kept between a domain's farthest member's rect and its circle edge. */
const DOMAIN_CIRCLE_MARGIN = 40

/** Distance from `point` to the farthest corner of `node`'s rect — used so the
 * circle clears a member's whole footprint, not just its center point. */
function farthestCornerDistance(
  node: Node<MachineData>,
  point: { x: number; y: number },
): number {
  const { x, y, w, h } = nodeRect(node)
  const corners = [
    { x, y },
    { x: x + w, y },
    { x, y: y + h },
    { x: x + w, y: y + h },
  ]
  return Math.max(...corners.map((c) => Math.hypot(c.x - point.x, c.y - point.y)))
}

/**
 * A domain controller's circle grows to keep its committed members inside
 * with padding, rather than staying a fixed size. Never shrinks below
 * `DOMAIN_RADIUS` so an empty/sparse domain still reads as a region.
 *
 * A member that has drifted well past where the circle would sit without it,
 * and isn't huddled near any other node, is being carried out (e.g. dragged
 * toward the boundary) — its distance is excluded from the growth
 * calculation so the circle snaps back instead of inflating to chase it
 * forever.
 */
export function domainRadius(
  dc: Node<MachineData>,
  nodes: Node<MachineData>[],
  edges: Edge[],
): number {
  const dcCenter = nodeCenter(dc)
  const members = edges
    .filter((e) => e.target === dc.id && e.data?.edgeType === EDGE_TYPE.domainJoin)
    .map((e) => nodes.find((n) => n.id === e.source))
    .filter((n): n is Node<MachineData> => !!n)

  const distances = members.map((m) => {
    const c = nodeCenter(m)
    return Math.hypot(c.x - dcCenter.x, c.y - dcCenter.y)
  })
  // Drives the actual radius growth — the farthest corner of each member's
  // rect, so the circle always clears its footprint, not just its center.
  const edgeDistances = members.map((m) => farthestCornerDistance(m, dcCenter))

  let maxDist = 0
  members.forEach((member, i) => {
    const dist = distances[i]

    const othersMaxDist = distances.reduce(
      (m, d, j) => (j === i ? m : Math.max(m, d)),
      0,
    )
    const radiusWithoutMember = Math.max(DOMAIN_RADIUS, othersMaxDist + DOMAIN_MEMBER_PADDING)

    const c = nodeCenter(member)
    const hasNearbyNeighbor = nodes.some((other) => {
      if (other.id === member.id || other.id === dc.id) return false
      const oc = nodeCenter(other)
      return Math.hypot(oc.x - c.x, oc.y - c.y) < DOMAIN_EXIT_NEIGHBOR_CLEARANCE
    })

    const isLeaving = dist > radiusWithoutMember + DOMAIN_EXIT_MARGIN && !hasNearbyNeighbor
    if (isLeaving) return

    if (edgeDistances[i] > maxDist) maxDist = edgeDistances[i]
  })

  return Math.max(DOMAIN_RADIUS, maxDist + DOMAIN_CIRCLE_MARGIN)
}

/** Human label for a domain — the DC's configured domain name, else its node name. */
export function domainLabel(dc: Node<MachineData>): string {
  return dc.data.config?.domainName ?? dc.data.name
}

const DOMAIN_LABEL_MAX_CHARS = 24

/** Truncates a label to `max` characters, appending an ellipsis if it was cut. */
export function truncateLabel(label: string, max = DOMAIN_LABEL_MAX_CHARS): string {
  return label.length > max ? `${label.slice(0, max)}…` : label
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
  edges: Edge[],
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
    if (dist <= domainRadius(dc, nodes, edges) && dist < bestDist) {
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
// Node overlap prevention
// ---------------------------------------------------------------------------
//
// Nodes shouldn't be droppable on top of one another. `findOverlappingId` is
// used live during a drag (to flag the offending node), `nearestFreePosition`
// on drop (to relocate it).

const OVERLAP_GAP = 12

export interface Rect {
  x: number
  y: number
  w: number
  h: number
}

/** Bounding rect of a node in flow coordinates (position is the top-left corner). */
export function nodeRect(node: Node<MachineData>): Rect {
  const w = node.measured?.width ?? 160
  const h = node.measured?.height ?? 80
  return { x: node.position.x, y: node.position.y, w, h }
}

/** Axis-aligned bounding-box intersection, with an optional clearance gap. */
export function rectsOverlap(a: Rect, b: Rect, gap = 0): boolean {
  return (
    a.x < b.x + b.w + gap &&
    a.x + a.w + gap > b.x &&
    a.y < b.y + b.h + gap &&
    a.y + a.h + gap > b.y
  )
}

/** The id of the first node in `others` whose rect intersects `node`'s, if any. */
export function findOverlappingId(
  node: Node<MachineData>,
  others: Node<MachineData>[],
  gap = OVERLAP_GAP,
): string | null {
  const rect = nodeRect(node)
  for (const other of others) {
    if (other.id === node.id) continue
    if (rectsOverlap(rect, nodeRect(other), gap)) return other.id
  }
  return null
}

/**
 * Nearest position to `desired` (anchored there) where `node`'s rect clears
 * every rect in `others`. Searches outward in rings of increasing radius,
 * sampling a fixed number of angles per ring, so it's deterministic and
 * always terminates even on a densely packed canvas.
 */
export function nearestFreePosition(
  node: Node<MachineData>,
  others: Node<MachineData>[],
  desired: { x: number; y: number },
  gap = OVERLAP_GAP,
): { x: number; y: number } {
  const w = node.measured?.width ?? 160
  const h = node.measured?.height ?? 80
  const otherRects = others.filter((o) => o.id !== node.id).map(nodeRect)

  const fits = (pos: { x: number; y: number }) => {
    const rect: Rect = { x: pos.x, y: pos.y, w, h }
    return otherRects.every((o) => !rectsOverlap(rect, o, gap))
  }

  if (fits(desired)) return desired

  const STEP = 24
  const ANGLE_STEPS = 16
  const MAX_RADIUS = STEP * 40 // bounded search — always terminates

  for (let radius = STEP; radius <= MAX_RADIUS; radius += STEP) {
    for (let i = 0; i < ANGLE_STEPS; i++) {
      const angle = (i / ANGLE_STEPS) * Math.PI * 2
      const candidate = {
        x: desired.x + Math.cos(angle) * radius,
        y: desired.y + Math.sin(angle) * radius,
      }
      if (fits(candidate)) return candidate
    }
  }

  return desired // shouldn't realistically be reached
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

  if (
    source.data.typeId !== "certificateAuthority" ||
    target.data.typeId !== "certificateAuthority"
  ) {
    return { ok: false, reason: "Only Certificate Authorities can be connected." }
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
