import { AlertDialog } from "@base-ui/react/alert-dialog"
import {
  AlertTriangle,
  CheckCircle2,
  Clock3,
  GitBranch,
  KeyRound,
  Server,
} from "lucide-react"

import { Button } from "@/components/ui/button"
import type { CompiledDeployPlan } from "@/lib/api"
import type { PreparedDeployPlan } from "@/store/staging"
import { lintTopologyRelationships } from "@/lib/topology"
import { useTopologyStore } from "@/store/topology"
import { cn } from "@/lib/utils"

/** Friendly display names for compiled op kinds the user never staged themselves. */
const KIND_LABEL: Record<string, string> = {
  provision: "provision (agent & role setup)",
}

function kindLabel(kind: string): string {
  return KIND_LABEL[kind] ?? kind
}

function duration(seconds: number): string {
  if (seconds < 60) return `${seconds}s`
  const hours = Math.floor(seconds / 3600)
  const minutes = Math.ceil((seconds % 3600) / 60)
  return hours ? `${hours}h ${minutes}m` : `${minutes}m`
}

export function DeployCompilerDialog({
  review,
  prepared,
  onConfirm,
  onCancel,
}: {
  review: CompiledDeployPlan | null
  prepared: PreparedDeployPlan | null
  onConfirm: () => void
  onCancel: () => void
}) {
  const nodes = useTopologyStore((state) => state.nodes)
  const edges = useTopologyStore((state) => state.edges)
  const applyNodeChanges = useTopologyStore((state) => state.applyNodeChanges)
  const applyEdgeChanges = useTopologyStore((state) => state.applyEdgeChanges)
  const diagnostics = lintTopologyRelationships(nodes, edges)
  const operationById = new Map(review?.operations.map((op) => [op.id, op]))
  const critical = new Set(review?.criticalPath ?? [])
  const creates = review?.operations.filter((op) => op.kind === "createVm") ?? []
  const secretFields = Array.from(new Set(
    (prepared?.topology.nodes ?? []).flatMap((node) =>
      Object.keys(node.config)
        .filter((key) => /password|secret|token/i.test(key))
        .map((key) => `${node.name} · ${key}`),
    ),
  ))

  function highlight(opId: string) {
    const op = operationById.get(opId)
    if (!op) return
    const nodeIds = new Set([op.target, ...(op.secondary ? [op.secondary] : [])])
    applyNodeChanges(nodes.map((node) => ({
      id: node.id,
      type: "select" as const,
      selected: nodeIds.has(node.id),
    })))
    applyEdgeChanges(edges.map((edge) => ({
      id: edge.id,
      type: "select" as const,
      selected: nodeIds.has(edge.source) && nodeIds.has(edge.target),
    })))
  }

  const open = review !== null && prepared !== null
  return (
    <AlertDialog.Root open={open} onOpenChange={(next) => !next && onCancel()}>
      <AlertDialog.Portal>
        <AlertDialog.Backdrop className="fixed inset-0 z-50 bg-black/50 backdrop-blur-[2px]" />
        <AlertDialog.Popup className="fixed left-1/2 top-1/2 z-50 flex h-[min(760px,calc(100vh-2rem))] w-[min(1180px,calc(100vw-2rem))] -translate-x-1/2 -translate-y-1/2 flex-col overflow-hidden rounded-2xl border bg-popover text-popover-foreground shadow-2xl ring-1 ring-foreground/10">
          <header className="flex items-start justify-between gap-4 border-b px-6 py-4">
            <div>
              <AlertDialog.Title className="text-base font-semibold">
                Review compiled deployment
              </AlertDialog.Title>
              <AlertDialog.Description className="mt-1 text-xs text-muted-foreground">
                The backend rebuilt the dependency graph from the final topology. Select a step to highlight its canvas resources.
              </AlertDialog.Description>
            </div>
            <div className="flex shrink-0 items-center gap-4 text-[11px] text-muted-foreground">
              <span className="flex items-center gap-1.5"><Clock3 className="h-3.5 w-3.5" />{duration(review?.estimatedDurationSeconds ?? 0)} total</span>
              <span className="flex items-center gap-1.5"><GitBranch className="h-3.5 w-3.5" />{duration(review?.criticalPathDurationSeconds ?? 0)} critical</span>
            </div>
          </header>

          <div className="grid min-h-0 flex-1 grid-cols-[minmax(220px,0.8fr)_minmax(360px,1.5fr)_minmax(250px,1fr)] divide-x">
            <section className="overflow-y-auto p-4">
              <h3 className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">Requirements</h3>
              {diagnostics.length === 0 ? (
                <div className="mt-3 flex gap-2 rounded-lg border border-emerald-500/30 bg-emerald-500/5 p-3 text-xs text-emerald-600 dark:text-emerald-400">
                  <CheckCircle2 className="h-4 w-4 shrink-0" />
                  All required PKI relationships are complete.
                </div>
              ) : (
                <ul className="mt-3 space-y-2">
                  {diagnostics.map((item) => (
                    <li key={`${item.code}:${item.nodeIds.join(":")}`} className="flex gap-2 rounded-lg border p-2.5 text-[11px] leading-snug">
                      <AlertTriangle className={cn("mt-0.5 h-3.5 w-3.5 shrink-0", item.severity === "error" ? "text-red-500" : "text-amber-500")} />
                      {item.message}
                    </li>
                  ))}
                </ul>
              )}
              <h3 className="mt-5 text-xs font-semibold uppercase tracking-wider text-muted-foreground">Compiled resources</h3>
              <dl className="mt-2 grid grid-cols-2 gap-2 text-xs">
                <div className="rounded-lg border p-2"><dt className="text-muted-foreground">Nodes</dt><dd className="mt-1 text-lg font-semibold">{review?.resources.nodes}</dd></div>
                <div className="rounded-lg border p-2"><dt className="text-muted-foreground">Links</dt><dd className="mt-1 text-lg font-semibold">{review?.resources.relationships}</dd></div>
                <div className="col-span-2 rounded-lg border p-2"><dt className="text-muted-foreground">DNS records</dt><dd className="mt-1 text-lg font-semibold">{review?.resources.dnsRecords.length}</dd></div>
              </dl>
            </section>

            <section className="overflow-y-auto p-4">
              <div className="flex items-center justify-between">
                <h3 className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">Dependency timeline</h3>
                <span className="text-[10px] text-amber-500">◆ critical path</span>
              </div>
              <ol className="mt-3 space-y-2">
                {review?.operations.map((op, index) => {
                  const node = nodes.find((item) => item.id === op.target)
                  return (
                    <li key={op.id}>
                      <button type="button" onClick={() => highlight(op.id)} className={cn("group flex w-full gap-3 rounded-xl border p-3 text-left transition-colors hover:bg-accent focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring", critical.has(op.id) && "border-amber-500/40 bg-amber-500/5")}>
                        <span className={cn("flex h-7 w-7 shrink-0 items-center justify-center rounded-full border text-[10px] font-semibold", critical.has(op.id) && "border-amber-500 text-amber-500")}>{index + 1}</span>
                        <span className="min-w-0 flex-1">
                          <span className="flex items-center gap-2 text-xs font-semibold"><span className="truncate">{kindLabel(op.kind)}</span>{critical.has(op.id) && <span className="text-amber-500">◆</span>}</span>
                          <span className="mt-0.5 block truncate text-[11px] text-muted-foreground">{node?.data.name ?? op.target}{op.secondary ? ` ← ${nodes.find((item) => item.id === op.secondary)?.data.name ?? op.secondary}` : ""}</span>
                          <span className="mt-1 block text-[10px] text-muted-foreground">{op.dependsOn.length === 0 ? "Starts immediately" : `After ${op.dependsOn.map((id) => kindLabel(operationById.get(id)?.kind ?? id)).join(", ")}`}</span>
                        </span>
                      </button>
                    </li>
                  )
                })}
              </ol>
            </section>

            <section className="overflow-y-auto p-4">
              <h3 className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">Resource changes</h3>
              <ul className="mt-3 space-y-2">
                {creates.map((op) => (
                  <li key={op.id} className="rounded-lg border p-3 text-[11px]">
                    <span className="flex items-center gap-2 font-semibold"><Server className="h-3.5 w-3.5" />{op.params.vmName}</span>
                    <dl className="mt-2 grid grid-cols-[56px_1fr] gap-x-2 gap-y-1 text-muted-foreground">
                      <dt>Image</dt><dd className="truncate">Role-mapped {op.params.template}</dd>
                      <dt>IP</dt><dd>Next free guest-pool address</dd>
                      <dt>Action</dt><dd>Clone and verify</dd>
                    </dl>
                  </li>
                ))}
              </ul>
              <h3 className="mt-5 flex items-center gap-2 text-xs font-semibold uppercase tracking-wider text-muted-foreground"><KeyRound className="h-3.5 w-3.5" />Secrets used</h3>
              {secretFields.length === 0 ? <p className="mt-2 text-[11px] text-muted-foreground">No secret-bearing fields are referenced.</p> : (
                <ul className="mt-2 space-y-1 text-[11px] text-muted-foreground">
                  {secretFields.map((field) => <li key={field} className="rounded-md border px-2 py-1.5">{field} · masked</li>)}
                </ul>
              )}
            </section>
          </div>

          <footer className="flex items-center justify-between gap-4 border-t px-6 py-4">
            <p className="text-[11px] text-muted-foreground">Critical path: {review?.criticalPath.length ?? 0} operations · topology v{review?.topologyVersion}</p>
            <div className="flex gap-2">
              <Button variant="outline" size="sm" onClick={onCancel}>Back to canvas</Button>
              <Button size="sm" onClick={onConfirm}>Deploy {creates.length} VMs / {review?.operations.length ?? 0} verified steps</Button>
            </div>
          </footer>
        </AlertDialog.Popup>
      </AlertDialog.Portal>
    </AlertDialog.Root>
  )
}
