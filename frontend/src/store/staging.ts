/**
 * Staging store — the linear, undo-able list of operations queued ahead of a
 * deploy. Each op mirrors an optimistic canvas effect that `store/topology.ts`
 * already applied (a node flipped to `staged`, a ghost edge was drawn);
 * undoing/cascading an op here reverts exactly that effect via `revertOp`.
 *
 * Persisted through the active Project snapshot (`store/projects.ts` /
 * `lib/projectAutosave.ts`), not zustand's own `persist` middleware — staged
 * ops reference node/edge ids and must swap in lockstep with the topology
 * graph on project switch, so `loadOps` is called alongside `loadSnapshot`
 * rather than rehydrating independently from localStorage.
 *
 * `stageOp` is the sole insertion point and always appends, so the list is
 * already a valid topological order (see `lib/staging.ts`) — that's what
 * makes `undo`'s plain pop safe.
 */

import { create } from "zustand"

import { LIFECYCLE } from "@/constants/topology"
import {
  OP_KIND,
  OP_STATUS,
  inferDependsOn,
  transitiveDependents,
  type OpKind,
  type StagedOp,
} from "@/lib/staging"
import { domainJoinEdge } from "@/lib/topology"
import { useTopologyStore } from "@/store/topology"

/** Reverts one op's optimistic canvas effect — the inverse of whatever `store/topology.ts` applied when it was staged. */
function revertOp(op: StagedOp) {
  const topology = useTopologyStore.getState()
  switch (op.kind) {
    case OP_KIND.createVm:
      // Config is kept so the config form re-opens pre-filled.
      topology.patchNodeData(op.targetNodeId, { lifecycle: LIFECYCLE.draft })
      return
    case OP_KIND.domainJoin:
    case OP_KIND.caConnect:
    case OP_KIND.webServerCert:
      if (op.edgeId) topology.removeEdge(op.edgeId)
      return
    case OP_KIND.domainLeave:
      if (op.params.prevDcId) {
        topology.restoreEdge(domainJoinEdge(op.targetNodeId, op.params.prevDcId))
      }
      return
  }
}

interface StageOpInput {
  kind: OpKind
  targetNodeId: string
  secondaryNodeId?: string
  params: Record<string, string>
  label: string
  edgeId?: string
}

interface StagingState {
  ops: StagedOp[]
  deployJobId: string | null
  deploying: boolean

  stageOp: (input: StageOpInput) => StagedOp
  updateOpParams: (opId: string, params: Record<string, string>) => void
  /** Pops the last op and reverts it. No-op while deploying or when empty — the last op never has dependents, so this is always safe. */
  undo: () => void
  /** Reverts and removes `opId` plus everything that transitively depends on it. */
  removeOpCascade: (opId: string) => void
  setOpState: (opId: string, patch: Partial<StagedOp>) => void
  /** Swaps in another project's op list — called alongside `loadSnapshot` on project switch. */
  loadOps: (ops: StagedOp[], deployJobId: string | null) => void
  /** Sends the current ops to the backend plan runner. Wired up in M3/M4 — no-op for now. */
  deploy: () => void
  /** Re-attaches to an in-flight plan job's WebSocket after a reload. Wired up in M4 — no-op for now. */
  resumePlanJob: () => void
}

export const useStagingStore = create<StagingState>()((set, get) => ({
  ops: [],
  deployJobId: null,
  deploying: false,

  stageOp(input) {
    const { ops } = get()
    const dependsOn = inferDependsOn(input.kind, input.targetNodeId, input.secondaryNodeId, ops)
    const op: StagedOp = {
      ...input,
      id: crypto.randomUUID(),
      status: OP_STATUS.staged,
      dependsOn,
    }
    set({ ops: [...ops, op] })
    return op
  },

  updateOpParams(opId, params) {
    set((s) => ({
      ops: s.ops.map((op) =>
        op.id === opId ? { ...op, params: { ...op.params, ...params } } : op,
      ),
    }))
  },

  undo() {
    const { ops, deploying } = get()
    if (deploying || ops.length === 0) return
    const last = ops[ops.length - 1]
    revertOp(last)
    set({ ops: ops.slice(0, -1) })
  },

  removeOpCascade(opId) {
    const { ops } = get()
    const op = ops.find((o) => o.id === opId)
    if (!op) return
    const toRemove = [...transitiveDependents(opId, ops), op]
    // Revert in reverse so the deepest dependents unwind before what they depend on.
    for (let i = toRemove.length - 1; i >= 0; i--) revertOp(toRemove[i])
    const removedIds = new Set(toRemove.map((o) => o.id))
    set((s) => ({ ops: s.ops.filter((o) => !removedIds.has(o.id)) }))
  },

  setOpState(opId, patch) {
    set((s) => ({
      ops: s.ops.map((op) => (op.id === opId ? { ...op, ...patch } : op)),
    }))
  },

  loadOps(ops, deployJobId) {
    set({ ops, deployJobId, deploying: false })
  },

  deploy() {
    // TODO(M3/M4): POST /api/deploy with the current ops, then attachPlanSocket.
  },

  resumePlanJob() {
    // TODO(M4): if deployJobId is set, re-attach its plan socket.
  },
}))

/** Ops that reference `nodeId` (as target or secondary) plus everything transitively dependent on them — the full set a node deletion would need to cascade-remove. */
export function opsReferencingNode(ops: StagedOp[], nodeId: string): StagedOp[] {
  const referencing = ops.filter(
    (op) => op.targetNodeId === nodeId || op.secondaryNodeId === nodeId,
  )
  const ids = new Set<string>()
  for (const op of referencing) {
    ids.add(op.id)
    for (const dep of transitiveDependents(op.id, ops)) ids.add(dep.id)
  }
  return ops.filter((op) => ids.has(op.id))
}
