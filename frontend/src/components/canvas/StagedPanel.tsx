import { useEffect, useRef, useState } from "react"
import { Popover } from "@base-ui/react/popover"
import { toast } from "sonner"
import {
  AlertTriangle,
  Building2,
  CheckCircle2,
  ChevronRight,
  Circle,
  Cog,
  Globe,
  Loader2,
  LogOut,
  MinusCircle,
  Server,
  ShieldCheck,
  Undo2,
  X,
} from "lucide-react"
import type { LucideIcon } from "lucide-react"

import { OP_KIND, OP_STATUS, transitiveDependents } from "@/lib/staging"
import type { StagedOp } from "@/lib/staging"
import {
  compileDeployPlan,
  type CompiledDeployPlan,
  type CompiledExecutionGroup,
} from "@/lib/api"
import {
  isPreExecutionPhase,
  prepareDeployPlan,
  useStagingStore,
  type PlanPhase,
  type PreparedDeployPlan,
} from "@/store/staging"
import { useTopologyStore } from "@/store/topology"
import { Button } from "@/components/ui/button"
import { StagedRemoveDialog } from "./StagedRemoveDialog"
import { DeployCompilerDialog } from "./DeployCompilerDialog"

const KIND_ICON: Record<string, LucideIcon> = {
  [OP_KIND.createVm]: Server,
  [OP_KIND.provision]: Cog,
  [OP_KIND.domainJoin]: Building2,
  [OP_KIND.domainLeave]: LogOut,
  [OP_KIND.caConnect]: ShieldCheck,
  [OP_KIND.webServerCert]: Globe,
}

function StatusGlyph({ op }: { op: StagedOp }) {
  switch (op.status) {
    case OP_STATUS.staged:
    case OP_STATUS.pending:
      return <Circle className="h-3 w-3 shrink-0 text-muted-foreground/40" />
    case OP_STATUS.running:
      return (
        <span className="flex shrink-0 items-center gap-1">
          <Loader2 className="h-3 w-3 animate-spin text-sky-500" />
          {op.progress != null && (
            <span className="text-[10px] text-muted-foreground">{Math.round(op.progress)}%</span>
          )}
        </span>
      )
    case OP_STATUS.done:
      return <CheckCircle2 className="h-3 w-3 shrink-0 text-emerald-500" />
    case OP_STATUS.error:
      return (
        <Popover.Root>
          <Popover.Trigger
            className="flex shrink-0 items-center"
            aria-label={op.detail ?? "Deploy failed"}
          >
            <AlertTriangle className="h-3 w-3 shrink-0 text-red-500" />
          </Popover.Trigger>
          <Popover.Portal>
            <Popover.Positioner side="left" sideOffset={6} className="z-50">
              <Popover.Popup className="w-[min(280px,calc(100vw-2rem))] rounded-lg border bg-popover p-3 text-xs text-popover-foreground shadow-lg ring-1 ring-foreground/10 data-open:animate-in data-open:fade-in-0 data-open:zoom-in-95 data-closed:animate-out data-closed:fade-out-0 data-closed:zoom-out-95">
                <p className="font-medium text-red-500">Deploy failed</p>
                <p className="mt-1 text-muted-foreground">
                  {op.detail ?? "No further detail available."}
                </p>
              </Popover.Popup>
            </Popover.Positioner>
          </Popover.Portal>
        </Popover.Root>
      )
    case OP_STATUS.cancelled:
      return <MinusCircle className="h-3 w-3 shrink-0 text-muted-foreground/30" />
  }
}

//: Seconds of pre-execution wait before the button label escalates from the
//: short form to the explain-the-wait form and starts counting elapsed time.
const PRE_EXECUTION_ESCALATE_SEC = 3

/**
 * What the deploy button says before any per-op progress exists — the label
 * *changes* even though the op counter can't, so a slow preflight or a busy
 * worker queue reads as motion instead of a hang.
 */
function preExecutionLabel(
  phase: PlanPhase,
  detail: string | null,
  elapsedSec: number,
): string {
  const base =
    phase === "posting"
      ? elapsedSec < PRE_EXECUTION_ESCALATE_SEC
        ? "Validating & preflighting…"
        : "Checking ESXi host — images, capacity, names…"
      : phase === "queued"
        ? "Queued — waiting for a deployment worker…"
        : (detail ?? "Preparing plan…")
  return elapsedSec >= PRE_EXECUTION_ESCALATE_SEC ? `${base} ${elapsedSec}s` : base
}

/**
 * The "Staged" tab of the Toolbox — a linear view over the staging store's
 * op list, backed by the dependency DAG in `lib/staging.ts`. Undo pops the
 * last op (always safe); a row's ✕ cascades it plus everything that
 * transitively depends on it, confirming first when that set is non-empty.
 */
export function StagedPanel() {
  const ops = useStagingStore((s) => s.ops)
  const deploying = useStagingStore((s) => s.deploying)
  const planPhase = useStagingStore((s) => s.planPhase)
  const planPhaseDetail = useStagingStore((s) => s.planPhaseDetail)
  const deployStartedAt = useStagingStore((s) => s.deployStartedAt)
  const undo = useStagingStore((s) => s.undo)
  const removeOpCascade = useStagingStore((s) => s.removeOpCascade)
  const deploy = useStagingStore((s) => s.deploy)
  const nodes = useTopologyStore((s) => s.nodes)

  const [pendingRemoval, setPendingRemoval] = useState<StagedOp[] | null>(null)
  const [review, setReview] = useState<CompiledDeployPlan | null>(null)
  const [prepared, setPrepared] = useState<PreparedDeployPlan | null>(null)
  const [compiling, setCompiling] = useState(false)
  const [preview, setPreview] = useState<CompiledDeployPlan | null>(null)
  const [previewing, setPreviewing] = useState(false)
  const [expanded, setExpanded] = useState<Record<string, boolean>>({})
  const [nowMs, setNowMs] = useState(() => Date.now())
  const previewGeneration = useRef(0)

  // Elapsed-time ticker for the pre-execution label; idle once per-op
  // progress takes over or no deploy is in flight.
  const ticking = deploying && isPreExecutionPhase(planPhase) && deployStartedAt != null
  useEffect(() => {
    if (!ticking) return
    const timer = setInterval(() => setNowMs(Date.now()), 1000)
    return () => clearInterval(timer)
  }, [ticking])
  const elapsedSec = ticking
    ? Math.max(0, Math.floor((nowMs - (deployStartedAt ?? nowMs)) / 1000))
    : 0

  // The backend owns sequence expansion. Keep its tree warm while the user
  // stages a valid topology, but never surface expected incomplete-topology
  // failures as toasts during construction.
  useEffect(() => {
    if (deploying || ops.length === 0) {
      return
    }
    const generation = ++previewGeneration.current
    const controller = new AbortController()
    const timer = setTimeout(async () => {
      setPreviewing(true)
      const next = prepareDeployPlan(ops)
      try {
        const compiled = await compileDeployPlan(
          next.payload,
          next.topology,
          next.projectId,
          { signal: controller.signal },
        )
        if (generation === previewGeneration.current) setPreview(compiled)
      } catch (error) {
        if (generation === previewGeneration.current && !(error instanceof DOMException && error.name === "AbortError")) {
          setPreview(null)
        }
      } finally {
        if (generation === previewGeneration.current) setPreviewing(false)
      }
    }, 400)
    return () => {
      clearTimeout(timer)
      controller.abort()
    }
  }, [deploying, ops, nodes])

  function nodeName(id: string) {
    return nodes.find((n) => n.id === id)?.data.name ?? "?"
  }

  function requestRemove(op: StagedOp) {
    const dependents = transitiveDependents(op.id, ops)
    if (dependents.length === 0) {
      removeOpCascade(op.id)
      return
    }
    setPendingRemoval([op, ...dependents])
  }

  function confirmRemove() {
    if (!pendingRemoval) return
    removeOpCascade(pendingRemoval[0].id)
    setPendingRemoval(null)
  }

  function handleUndo() {
    if (deploying || ops.length === 0) return
    undo()
  }

  async function handleDeploy() {
    if (deploying || compiling || ops.length === 0) return
    setCompiling(true)
    const next = prepareDeployPlan(ops)
    try {
      const compiled = await compileDeployPlan(
        next.payload,
        next.topology,
        next.projectId,
      )
      setPrepared(next)
      setReview(compiled)
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "Unable to compile deployment.")
    } finally {
      setCompiling(false)
    }
  }

  function confirmDeploy() {
    setReview(null)
    setPrepared(null)
    deploy()
  }

  const hasErrors = ops.some((op) => op.status === OP_STATUS.error)
  const doneCount = ops.filter((op) => op.status === OP_STATUS.done).length
  const groups = new Map((preview?.groups ?? []).map((group) => [group.id, group]))

  function subtitle(op: StagedOp, group?: CompiledExecutionGroup) {
    const destination = nodeName(op.targetNodeId)
    return group?.sourceBase ? `${group.sourceBase} → ${destination}` : destination
  }

  return (
    <div className="flex flex-1 flex-col overflow-hidden">
      <div className="flex-1 overflow-y-auto">
        {ops.length === 0 ? (
          <p className="px-2 py-6 text-center text-[11px] text-muted-foreground">
            Nothing staged yet. Configure a node or wire up a connection to queue an operation.
          </p>
        ) : (
          <ol className="flex flex-col">
            {ops.map((op, i) => {
              const Icon = KIND_ICON[op.kind]
              const group = groups.get(op.id)
              const autoExpanded = op.status === OP_STATUS.running || op.status === OP_STATUS.error
              const isExpanded = expanded[op.id] ?? autoExpanded
              return (
                <li
                  key={op.id}
                  className="border-b text-xs last:border-b-0"
                >
                  <div className="flex items-start gap-2 px-2 py-2">
                    <button
                      type="button"
                      className="mt-0.5 shrink-0 rounded-sm text-muted-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                      aria-expanded={isExpanded}
                      aria-label={`${isExpanded ? "Collapse" : "Expand"} ${group?.label ?? op.label}`}
                      onClick={() => setExpanded((current) => ({ ...current, [op.id]: !isExpanded }))}
                    >
                      <ChevronRight className={`h-3 w-3 transition-transform ${isExpanded ? "rotate-90" : ""}`} />
                    </button>
                    <span className="w-4 shrink-0 text-right text-[10px] text-muted-foreground">
                      {op.synthesized ? "·" : i + 1}
                    </span>
                    <Icon className="mt-0.5 h-3.5 w-3.5 shrink-0 text-muted-foreground" />
                    <span className="min-w-0 flex-1">
                      <span className={`block font-medium leading-snug ${op.synthesized ? "text-muted-foreground" : ""}`}>{group?.label ?? op.label}</span>
                      <span className="block break-words text-[10px] leading-snug text-muted-foreground">
                        {subtitle(op, group)}
                        {op.status === OP_STATUS.running && op.phase ? ` — ${op.phase}` : null}
                      </span>
                    </span>
                    <StatusGlyph op={op} />
                    {/* Synthesized rows are read-only — they live and die with
                        their parent createVm, so no direct remove control. */}
                    {!deploying && !op.synthesized && (
                      <button
                        onClick={() => requestRemove(op)}
                        className="mt-0.5 shrink-0 text-muted-foreground transition-colors hover:text-red-500"
                        aria-label={`Remove ${op.label}`}
                      >
                        <X className="h-3 w-3" />
                      </button>
                    )}
                  </div>
                  {isExpanded && (
                    <ol className="border-t bg-muted/20 py-1 pl-9 pr-2" aria-label={`${group?.label ?? op.label} steps`}>
                      {group?.steps.length ? group.steps.map((step) => {
                        const runtime = op.executionSteps?.[step.id]
                        const status = runtime?.status ?? (op.status === OP_STATUS.done ? OP_STATUS.done : OP_STATUS.pending)
                        return (
                          <li key={step.id} className="flex items-start gap-2 border-l py-1.5 pl-3 text-[10px]">
                            <span className={`mt-1 h-1.5 w-1.5 shrink-0 rounded-full ${status === OP_STATUS.done ? "bg-emerald-500" : status === OP_STATUS.running ? "bg-sky-500" : status === OP_STATUS.error ? "bg-red-500" : "bg-muted-foreground/30"}`} />
                            <span className="min-w-0 flex-1">
                              <span className="block break-words font-medium leading-snug">{step.label}</span>
                              <span className="block break-words leading-snug text-muted-foreground">
                                {nodeName(step.targetNodeId)} · {step.command ?? step.kind}
                                {runtime?.phase ? ` — ${runtime.phase}` : ""}
                              </span>
                            </span>
                            {runtime?.percent != null && status === OP_STATUS.running && (
                              <span className="shrink-0 tabular-nums text-muted-foreground">{Math.round(runtime.percent)}%</span>
                            )}
                          </li>
                        )
                      }) : (
                        <li className="border-l py-2 pl-3 text-[10px] text-muted-foreground">
                          {previewing ? "Expanding backend steps…" : "Complete the required relationships to preview backend steps."}
                        </li>
                      )}
                    </ol>
                  )}
                </li>
              )
            })}
          </ol>
        )}
      </div>

      <div className="mt-auto flex flex-col gap-1.5 border-t p-2">
        <Button
          variant="outline"
          size="sm"
          className="w-full justify-start gap-2"
          disabled={deploying || ops.length === 0}
          title="Ctrl+Z"
          onClick={handleUndo}
        >
          <Undo2 className="h-3.5 w-3.5" />
          Undo
        </Button>
        <Button
          size="sm"
          className="w-full"
          disabled={ops.length === 0 || deploying || compiling}
          onClick={handleDeploy}
        >
          {deploying || compiling ? (
            <>
              <Loader2 className="mr-2 h-3.5 w-3.5 animate-spin" />
              {compiling
                ? "Compiling review…"
                : isPreExecutionPhase(planPhase)
                  ? preExecutionLabel(planPhase!, planPhaseDetail, elapsedSec)
                  : `Deploying ${doneCount}/${ops.length}…`}
            </>
          ) : ops.length === 0 ? (
            "Nothing staged"
          ) : hasErrors ? (
            "Retry deploy"
          ) : (
            `Deploy (${ops.length})`
          )}
        </Button>
      </div>

      <StagedRemoveDialog
        ops={pendingRemoval}
        onConfirm={confirmRemove}
        onCancel={() => setPendingRemoval(null)}
      />
      <DeployCompilerDialog
        review={review}
        prepared={prepared}
        onConfirm={confirmDeploy}
        onCancel={() => {
          setReview(null)
          setPrepared(null)
        }}
      />
    </div>
  )
}
