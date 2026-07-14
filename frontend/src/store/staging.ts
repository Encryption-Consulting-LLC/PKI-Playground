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
import { toast } from "sonner"

import { CONNECTION_HEALTH, LIFECYCLE } from "@/constants/topology"
import { deployPlan, type PlanOpPayload } from "@/lib/api"
import {
  OP_KIND,
  OP_STATUS,
  inferDependsOn,
  sanitizeOps,
  transitiveDependents,
  type OpKind,
  type StagedOp,
} from "@/lib/staging"
import { connectionHealthForOperation, domainJoinEdge } from "@/lib/topology"
import { buildDeployTopology } from "@/lib/deployTopology"
import { openJobSocket, type OpRunState } from "@/lib/ws"
import { useAgentsStore } from "@/store/agents"
import { useAuthStore } from "@/store/auth"
import { useProjectsStore } from "@/store/projects"
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
      if (op.edgeId) topology.removeEdge(op.edgeId)
      // Retargeting away from a *deployed* membership carries the old DC id
      // so undoing the join restores exactly the edge it replaced.
      if (op.params.prevDcId) {
        topology.restoreEdge(domainJoinEdge(op.targetNodeId, op.params.prevDcId))
      }
      return
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
  /** Pops the last op and reverts it. No-op while deploying or when empty — the last op never has dependents, so this is always safe. */
  undo: () => void
  /** Reverts and removes `opId` plus everything that transitively depends on it. */
  removeOpCascade: (opId: string) => void
  setOpState: (opId: string, patch: Partial<StagedOp>) => void
  /** Swaps in another project's op list — called alongside `loadSnapshot` on project switch. Resumes an in-flight plan job, if any. */
  loadOps: (ops: StagedOp[], deployJobId: string | null) => void
  /** Sends the current ops to the backend plan runner and attaches the plan-progress socket. */
  deploy: () => void
  /** Re-attaches to an in-flight plan job's WebSocket after a reload/project switch. */
  resumePlanJob: () => void
}

/**
 * Builds one op's wire params (and, for authored createVm ops, the inline
 * file list). `createVm` params are never persisted on the op itself —
 * `node.data.config` / `node.data.isoAuthoring` (the drift baselines) are the
 * single source of truth, so this reads them fresh at deploy time alongside
 * the deploy-time VM name and the template id. `vmName` is sent as the plain
 * canvas node name — the backend namespaces guest names server-side from the
 * authenticated identity (`enforce_guest_vm_name`), so the client must never
 * prefix it itself (a client-side prefix just gets prefixed again). Every
 * createVm is a real clone — the backend allowlists `template`
 * and decides for itself; there is no client `simulate` flag anymore. An
 * enabled ISO panel rides as either name-sorted inline `files` (PACK —
 * matching the 10-/20-/30- manifest order convention) or an `isoId` param
 * (UPLOAD-ISO); the backend then injects nothing and allocates no pool IP.
 */
function buildOpPayload(op: StagedOp): Pick<PlanOpPayload, "params" | "files"> {
  if (op.kind !== OP_KIND.createVm) return { params: op.params }
  const node = useTopologyStore.getState().nodes.find((n) => n.id === op.targetNodeId)
  const params: Record<string, string> = {
    ...(node?.data.config ?? {}),
    vmName: node?.data.name ?? op.targetNodeId,
    template: node?.data.typeId ?? "",
  }

  const iso = node?.data.isoAuthoring
  if (!iso?.enabled) return { params }
  if (iso.mode === "uploadIso" && iso.isoId) {
    params.isoId = iso.isoId
    return { params }
  }
  if (iso.mode === "pack" && iso.files.length > 0) {
    const files = [...iso.files]
      .sort((a, b) => a.name.localeCompare(b.name))
      .map(({ name, content }) => ({ name, content }))
    return { params, files }
  }
  return { params }
}

/**
 * Nodes whose ISO panel is enabled but empty — deploying them would silently
 * fall back to the default server-rendered disc, the one thing the toggle
 * says won't happen. Deploy refuses until the panel has content or is off.
 */
function emptyIsoNodes(ops: StagedOp[]): string[] {
  const nodes = useTopologyStore.getState().nodes
  const names: string[] = []
  for (const op of ops) {
    if (op.kind !== OP_KIND.createVm) continue
    const node = nodes.find((n) => n.id === op.targetNodeId)
    const iso = node?.data.isoAuthoring
    if (!iso?.enabled) continue
    const empty = iso.mode === "pack" ? iso.files.length === 0 : !iso.isoId
    if (empty) names.push(node?.data.name ?? op.targetNodeId)
  }
  return names
}

/** Folds one `plan-state` snapshot into the staging list and mirrors createVm/edge transitions onto the canvas. Idempotent — safe to apply the same snapshot more than once (reconnects/replays). */
function applyPlanState(opsState: Record<string, OpRunState>) {
  const { ops, setOpState } = useStagingStore.getState()
  const topology = useTopologyStore.getState()

  for (const [opId, runState] of Object.entries(opsState)) {
    const op = ops.find((o) => o.id === opId)
    if (!op) continue

    setOpState(opId, {
      status: runState.status,
      progress: runState.percent,
      phase: runState.status === "running" ? runState.phase : undefined,
      detail: runState.detail,
    })

    if (op.kind === OP_KIND.createVm) {
      if (runState.status === "running") {
        topology.patchNodeData(op.targetNodeId, {
          lifecycle: LIFECYCLE.deploying,
          progress: runState.percent,
          phase: runState.phase,
          // The agent identity rides on running pushes (partial result) so the
          // presence dot can appear while provisioning is still underway.
          ...(typeof runState.result?.agentVmId === "string"
            ? { orchestratorVmId: runState.result.agentVmId }
            : {}),
        })
      } else if (runState.status === "done") {
        const node = topology.nodes.find((n) => n.id === op.targetNodeId)
        const result = runState.result
        const agentVmId =
          typeof result?.agentVmId === "string" ? result.agentVmId : undefined
        // The clone is done, but a VM with a baked orchestrator agent isn't
        // *confirmed* deployed until that agent phones home — until then hold
        // the node in `provisioning` (dashed circle, IP hidden). Nodes with no
        // agent (authored-ISO clones) have nothing to wait for, so they go
        // straight to `deployed`. If the agent already phoned home before this
        // frame arrived, its vm_id is already in the presence snapshot — skip
        // the wait. `useAgentPromotion` handles the reverse race (agent comes
        // online after this transition).
        const awaitingAgent =
          agentVmId !== undefined &&
          !useAgentsStore.getState().onlineVmIds.includes(agentVmId)
        topology.patchNodeData(op.targetNodeId, {
          lifecycle: awaitingAgent ? LIFECYCLE.provisioning : LIFECYCLE.deployed,
          poweredOn: true,
          lastDeployedConfig: node?.data.config,
          // ISO drift baseline, mirroring lastDeployedConfig. Safe to hold by
          // reference — setIsoAuthoring always builds a fresh object.
          lastDeployedIso: node?.data.isoAuthoring,
          progress: 100,
          phase: undefined,
          // Conditional spreads so a result-less replay of an older snapshot
          // can never clobber an already-recorded identity with undefined.
          ...(typeof result?.ip === "string" ? { ip: result.ip } : {}),
          ...(typeof result?.vmName === "string" ? { vmName: result.vmName } : {}),
          // Auto-provisioned orchestrator identity: the agent baked
          // into the ISO phones home under this vm_id; surfaces in the Inspector.
          ...(agentVmId !== undefined ? { orchestratorVmId: agentVmId } : {}),
        })
      } else if (runState.status === "error") {
        topology.patchNodeData(op.targetNodeId, {
          lifecycle: LIFECYCLE.failed,
          progress: undefined,
          phase: undefined,
        })
      }
      continue
    }

    // Edge ops (domainJoin/caConnect/webServerCert) — clear ghost styling once
    // deployed. domainLeave has no edgeId; there's nothing left to commit.
    if (op.edgeId) {
      topology.setEdgeHealth(
        op.edgeId,
        connectionHealthForOperation(runState.status),
      )
      if (runState.status === "done") topology.commitEdge(op.edgeId)
    }
  }
}

/**
 * Reverts every non-`done` op back to `staged` (and any `createVm`-target
 * node still `deploying` back to `staged`) — the shared unwind for a plan
 * that ended before every op resolved (socket drop, plan-level crash).
 * `done` ops are dropped from the list entirely, same as `finishDeploy` —
 * their canvas effect was already committed by `applyPlanState` when the
 * `done` transition arrived, and keeping them around would re-send them
 * (double-executing a real clone) on the next `deploy()`.
 */
function revertNonTerminalToStaged(): void {
  const { ops } = useStagingStore.getState()
  const topology = useTopologyStore.getState()

  const remaining: StagedOp[] = []
  for (const op of ops) {
    if (op.status === OP_STATUS.done) continue
    if (op.kind === OP_KIND.createVm) {
      topology.patchNodeData(op.targetNodeId, {
        lifecycle: LIFECYCLE.staged,
        progress: undefined,
        phase: undefined,
      })
    }
    if (op.edgeId) topology.setEdgeHealth(op.edgeId, CONNECTION_HEALTH.planned)
    remaining.push({ ...op, status: OP_STATUS.staged, progress: undefined, detail: undefined })
  }

  useStagingStore.setState({ ops: remaining, deployJobId: null, deploying: false })
}

/** Final reconcile once the plan job reaches `done`: apply the last snapshot, drop fully-`done` ops off the list, and reopen `cancelled` ops (skipped only because a dependency failed) as `staged` so "Retry deploy" resends them alongside the op that actually failed. */
function finishDeploy(result: Record<string, unknown>): void {
  const opsResult = (result?.ops ?? {}) as Record<string, OpRunState>
  applyPlanState(opsResult)

  const { ops } = useStagingStore.getState()
  let errorCount = 0
  const remaining: StagedOp[] = []
  for (const op of ops) {
    const finalState = opsResult[op.id]
    if (finalState?.status === "done") continue
    if (finalState?.status === "error") errorCount++
    remaining.push(
      finalState?.status === "cancelled"
        ? { ...op, status: OP_STATUS.staged, progress: undefined, detail: undefined }
        : op,
    )
  }

  useStagingStore.setState({ ops: remaining, deployJobId: null, deploying: false })

  if (errorCount > 0) {
    toast.error(`Deploy finished with ${errorCount} failed operation${errorCount === 1 ? "" : "s"}.`)
  } else {
    toast.success("Deploy complete.")
  }
}

// Single in-flight plan socket — a project only ever has one active deploy.
let planSocketClose: (() => void) | null = null
let planRetryTimer: ReturnType<typeof setTimeout> | null = null

// A dropped socket (status 0) doesn't mean the plan died — the worker may
// still be running. Retry with backoff before treating it as gone; only
// unwind (reverting completed-looking state to staged) once retries are
// exhausted, so a blip doesn't race a still-running job into a duplicate
// plan on the next Deploy click.
const PLAN_SOCKET_RETRY_DELAYS_MS = [500, 1500, 3000]

function attachPlanSocket(jobId: string, token: string | null | undefined, attempt = 0) {
  planSocketClose?.()
  if (planRetryTimer) {
    clearTimeout(planRetryTimer)
    planRetryTimer = null
  }
  planSocketClose = openJobSocket(jobId, token, {
    onPlanState: (e) => applyPlanState(e.ops),
    onDone: (e) => {
      planSocketClose = null
      finishDeploy(e.result)
    },
    onError: (e) => {
      planSocketClose = null
      if (e.status === 0 && attempt < PLAN_SOCKET_RETRY_DELAYS_MS.length) {
        planRetryTimer = setTimeout(
          () => attachPlanSocket(jobId, token, attempt + 1),
          PLAN_SOCKET_RETRY_DELAYS_MS[attempt],
        )
        return
      }
      revertNonTerminalToStaged()
      if (e.status === 0) {
        toast.warning("Lost connection to the deploy job — operations reverted to staged, you can retry.")
      } else {
        toast.error(e.detail || "Deploy failed.")
      }
    },
  })
}

export const useStagingStore = create<StagingState>()((set, get) => ({
  ops: [],
  deployJobId: null,
  deploying: false,

  stageOp(input) {
    const { ops, deploying } = get()
    const dependsOn = inferDependsOn(input.kind, input.targetNodeId, input.secondaryNodeId, ops)
    const op: StagedOp = {
      ...input,
      id: crypto.randomUUID(),
      status: OP_STATUS.staged,
      dependsOn,
    }
    // Defense in depth: every caller already checks `deploying` itself, but
    // this is the sole insertion point, so guard it here too.
    if (!deploying) set({ ops: [...ops, op] })
    return op
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
    planSocketClose?.()
    planSocketClose = null
    if (planRetryTimer) {
      clearTimeout(planRetryTimer)
      planRetryTimer = null
    }
    set({ ops: sanitizeOps(ops), deployJobId, deploying: false })
    get().resumePlanJob()
  },

  deploy() {
    const { ops, deploying } = get()
    if (deploying || ops.length === 0) return

    // Pre-flight: an enabled-but-empty ISO panel means the operator asked for
    // an authored disc but hasn't provided one — refuse rather than silently
    // deploying the default config.
    const missingIso = emptyIsoNodes(ops)
    if (missingIso.length > 0) {
      toast.error(
        `"${missingIso[0]}"${missingIso.length > 1 ? ` (+${missingIso.length - 1} more)` : ""}: ` +
          "the ISO panel is enabled but empty — add scripts, upload an ISO, or turn it off.",
      )
      return
    }

    // Set synchronously, before the POST even goes out — closes the window
    // between click and the 202 response where a second click could enqueue
    // a duplicate plan (double real clone → VmExists) and undo/stage/canvas
    // edits were still allowed on an in-flight plan.
    set({ deploying: true })

    const token = useAuthStore.getState().token

    // `done` ops already succeeded — drop them entirely so a retry never
    // re-sends (and double-executes) them. Reset previously failed/cancelled
    // ops back to staged so a retry resends them alongside whatever hadn't
    // run yet. `dependsOn` is then pruned to only ids still present, so a
    // dropped `done` op's id never reaches the backend as an unknown dep.
    const resettable = ops
      .filter((op) => op.status !== OP_STATUS.done)
      .map((op) =>
        op.status === OP_STATUS.error || op.status === OP_STATUS.cancelled
          ? { ...op, status: OP_STATUS.staged, progress: undefined, detail: undefined }
          : op,
      )
    const keptIds = new Set(resettable.map((op) => op.id))
    const pruned = resettable.map((op) => ({
      ...op,
      dependsOn: op.dependsOn.filter((dep) => keptIds.has(dep)),
    }))

    const topologyStore = useTopologyStore.getState()
    for (const op of pruned) {
      if (op.edgeId) topologyStore.setEdgeHealth(op.edgeId, CONNECTION_HEALTH.planned)
    }

    const payload: PlanOpPayload[] = pruned.map((op) => {
      const { params, files } = buildOpPayload(op)
      return {
        id: op.id,
        kind: op.kind,
        target: op.targetNodeId,
        // The DC/parent-CA/issuing-CA the op wires to — the backend
        // resolves its real guest-namespaced identity to build join/enroll
        // command params. Dropped previously; now carried through.
        ...(op.secondaryNodeId ? { secondary: op.secondaryNodeId } : {}),
        params,
        ...(files ? { files } : {}),
        dependsOn: op.dependsOn,
      }
    })

    set({ ops: pruned.map((op) => ({ ...op, status: OP_STATUS.pending })) })

    const projectId = useProjectsStore.getState().activeProjectId
    const topologyState = useTopologyStore.getState()
    const topology = buildDeployTopology(topologyState.nodes, topologyState.edges)
    deployPlan(payload, topology, projectId)
      .then(({ job_id }) => {
        set({ deployJobId: job_id })
        attachPlanSocket(job_id, token)
      })
      .catch((err) => {
        set((s) => ({
          ops: s.ops.map((op) => ({ ...op, status: OP_STATUS.staged })),
          deploying: false,
        }))
        toast.error(err instanceof Error ? err.message : "Failed to start deploy.")
      })
  },

  resumePlanJob() {
    const { deployJobId, deploying } = get()
    if (!deployJobId || deploying) return
    const token = useAuthStore.getState().token
    // Without a live token the socket can't authenticate — leave the job id
    // in place so a later resume (once the session is ready) can pick it up.
    if (!token) return
    set({ deploying: true })
    attachPlanSocket(deployJobId, token)
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
