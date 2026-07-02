import { useState } from "react"
import { Popover } from "@base-ui/react/popover"
import {
  AlertTriangle,
  Building2,
  CheckCircle2,
  Circle,
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
import { useStagingStore } from "@/store/staging"
import { useTopologyStore } from "@/store/topology"
import { Button } from "@/components/ui/button"
import { StagedRemoveDialog } from "./StagedRemoveDialog"

const KIND_ICON: Record<string, LucideIcon> = {
  [OP_KIND.createVm]: Server,
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

/**
 * The "Staged" tab of the Toolbox — a linear view over the staging store's
 * op list, backed by the dependency DAG in `lib/staging.ts`. Undo pops the
 * last op (always safe); a row's ✕ cascades it plus everything that
 * transitively depends on it, confirming first when that set is non-empty.
 */
export function StagedPanel() {
  const ops = useStagingStore((s) => s.ops)
  const deploying = useStagingStore((s) => s.deploying)
  const undo = useStagingStore((s) => s.undo)
  const removeOpCascade = useStagingStore((s) => s.removeOpCascade)
  const deploy = useStagingStore((s) => s.deploy)
  const nodes = useTopologyStore((s) => s.nodes)

  const [pendingRemoval, setPendingRemoval] = useState<StagedOp[] | null>(null)

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

  function handleDeploy() {
    if (deploying || ops.length === 0) return
    deploy()
  }

  const hasErrors = ops.some((op) => op.status === OP_STATUS.error)
  const doneCount = ops.filter((op) => op.status === OP_STATUS.done).length

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
              return (
                <li
                  key={op.id}
                  className="flex items-center gap-2 border-b px-2 py-2 text-xs last:border-b-0"
                >
                  <span className="w-4 shrink-0 text-right text-[10px] text-muted-foreground">
                    {i + 1}
                  </span>
                  <Icon className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
                  <span className="min-w-0 flex-1">
                    <span className="block truncate font-medium">{op.label}</span>
                    <span className="block truncate text-[10px] text-muted-foreground">
                      {nodeName(op.targetNodeId)}
                    </span>
                  </span>
                  <StatusGlyph op={op} />
                  {!deploying && (
                    <button
                      onClick={() => requestRemove(op)}
                      className="shrink-0 text-muted-foreground transition-colors hover:text-red-500"
                      aria-label={`Remove ${op.label}`}
                    >
                      <X className="h-3 w-3" />
                    </button>
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
          disabled={ops.length === 0 || deploying}
          onClick={handleDeploy}
        >
          {deploying ? (
            <>
              <Loader2 className="mr-2 h-3.5 w-3.5 animate-spin" />
              Deploying {doneCount}/{ops.length}…
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
    </div>
  )
}
