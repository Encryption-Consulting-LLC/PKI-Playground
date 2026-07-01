/**
 * Pure staging helpers — no React, no store imports. Mirrors `lib/topology.ts`.
 *
 * A `StagedOp` is one pending action (create a VM, join a domain, wire up a
 * CA hierarchy edge, ...) queued ahead of a deploy. `stageOp` (in
 * `store/staging.ts`) is the sole insertion point and always appends, so the
 * list is already a valid topological order: an op only depends on ops
 * earlier in the list. That invariant is what makes plain pop-undo safe
 * (the last op never has dependents) and lets `transitiveDependents` do a
 * simple forward scan instead of a general graph walk.
 */

export const OP_KIND = {
  createVm: "createVm",
  domainJoin: "domainJoin",
  domainLeave: "domainLeave",
  caConnect: "caConnect",
  webServerCert: "webServerCert",
} as const

export type OpKind = (typeof OP_KIND)[keyof typeof OP_KIND]

export const OP_STATUS = {
  staged: "staged",
  pending: "pending",
  running: "running",
  done: "done",
  error: "error",
  cancelled: "cancelled",
} as const

export type OpStatus = (typeof OP_STATUS)[keyof typeof OP_STATUS]

export interface StagedOp extends Record<string, unknown> {
  id: string
  kind: OpKind
  /** Drives label + lifecycle updates — the node this op ultimately mutates. */
  targetNodeId: string
  /** DC / parent CA / web server, when the op involves a second node. */
  secondaryNodeId?: string
  params: Record<string, string>
  /** Op ids this depends on — always earlier in the list. */
  dependsOn: string[]
  label: string
  status: OpStatus
  /** The optimistic edge this op created, if any — lets undo revert it exactly. */
  edgeId?: string
  progress?: number
  /** Error detail after a failed deploy. */
  detail?: string
}

/** Ops (anywhere in the list) that transitively depend on `opId`, in list order. */
export function transitiveDependents(opId: string, ops: StagedOp[]): StagedOp[] {
  const seen = new Set<string>([opId])
  const result: StagedOp[] = []
  // Single forward pass suffices because dependsOn always points earlier in
  // the list — by the time we reach a dependent, its dependency is already
  // in `seen`.
  for (const op of ops) {
    if (seen.has(op.id)) continue
    if (op.dependsOn.some((dep) => seen.has(dep))) {
      seen.add(op.id)
      result.push(op)
    }
  }
  return result
}

/** The staged op of `kind` targeting `nodeId`, if one is still in the list. */
export function findStagedOp(
  ops: StagedOp[],
  kind: OpKind,
  nodeId: string,
): StagedOp | undefined {
  return ops.find((op) => op.kind === kind && op.targetNodeId === nodeId)
}

/**
 * Dependencies for a new op of `kind`, restricted to prerequisites that are
 * still staged (anything already deployed doesn't need a dependency edge —
 * it already exists).
 */
export function inferDependsOn(
  kind: OpKind,
  targetNodeId: string,
  secondaryNodeId: string | undefined,
  ops: StagedOp[],
): string[] {
  const createVmIds = (...nodeIds: (string | undefined)[]) =>
    nodeIds
      .filter((id): id is string => !!id)
      .map((id) => findStagedOp(ops, OP_KIND.createVm, id))
      .filter((op): op is StagedOp => !!op)
      .map((op) => op.id)

  switch (kind) {
    case OP_KIND.createVm:
      return []
    case OP_KIND.domainJoin:
    case OP_KIND.caConnect:
      return createVmIds(targetNodeId, secondaryNodeId)
    case OP_KIND.domainLeave:
      // Membership being left is deployed by definition — nothing staged to wait on.
      return []
    case OP_KIND.webServerCert: {
      const caConnectIds = ops
        .filter((op) => op.kind === OP_KIND.caConnect && op.targetNodeId === targetNodeId)
        .map((op) => op.id)
      return [...createVmIds(targetNodeId, secondaryNodeId), ...caConnectIds]
    }
  }
}

/** `guest-<token-prefix>-<name>` — the naming scheme the real clone API expects. */
export function guestVmName(name: string, token: string | null | undefined): string {
  const uniqueId = token ? token.slice(0, 8) : "local"
  return `guest-${uniqueId}-${name}`
}
