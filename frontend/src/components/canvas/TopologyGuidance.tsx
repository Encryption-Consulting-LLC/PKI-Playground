import { useMemo } from "react"
import { AlertTriangle, CheckCircle2, CircleAlert } from "lucide-react"

import { lintTopologyRelationships } from "@/lib/topology"
import { cn } from "@/lib/utils"
import { useTopologyStore } from "@/store/topology"

export function TopologyGuidance() {
  const nodes = useTopologyStore((state) => state.nodes)
  const edges = useTopologyStore((state) => state.edges)
  const selectNode = useTopologyStore((state) => state.selectNode)
  const diagnostics = useMemo(
    () => lintTopologyRelationships(nodes, edges),
    [nodes, edges],
  )

  if (diagnostics.length === 0) {
    return (
      <div className="flex items-center gap-2 rounded-lg border bg-background/95 px-3 py-2 text-[10px] text-emerald-500 shadow-sm">
        <CheckCircle2 className="h-3.5 w-3.5" />
        Required PKI relationships are complete
      </div>
    )
  }

  const errors = diagnostics.filter((item) => item.severity === "error").length
  return (
    <details
      open
      className="w-80 rounded-lg border bg-background/95 text-[10px] shadow-sm"
    >
      <summary className="flex cursor-pointer list-none items-center gap-2 px-3 py-2 font-semibold">
        {errors > 0 ? (
          <CircleAlert className="h-3.5 w-3.5 text-red-500" />
        ) : (
          <AlertTriangle className="h-3.5 w-3.5 text-amber-500" />
        )}
        Topology guidance ({diagnostics.length})
      </summary>
      <div className="max-h-64 space-y-1 overflow-y-auto border-t p-2">
        {diagnostics.map((item) => (
          <button
            key={`${item.code}:${item.nodeIds.join(":")}`}
            type="button"
            onClick={() => selectNode(item.nodeIds[0] ?? null)}
            className={cn(
              "block w-full rounded-md border-l-2 px-2 py-1.5 text-left leading-snug transition-colors hover:bg-accent",
              item.severity === "error"
                ? "border-l-red-500 text-red-600 dark:text-red-400"
                : "border-l-amber-500 text-foreground",
            )}
          >
            {item.message}
          </button>
        ))}
      </div>
    </details>
  )
}
