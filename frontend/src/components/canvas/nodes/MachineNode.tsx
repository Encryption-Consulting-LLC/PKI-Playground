import { AlertTriangle, Loader2 } from "lucide-react"
import { Handle, Position, useEdges, useNodes } from "@xyflow/react"
import type { NodeProps, Node } from "@xyflow/react"
import { cn } from "@/lib/utils"
import { TEMPLATE_BY_ID } from "@/constants/templates"
import { EDGE_TYPE, NODE_STATUS } from "@/constants/topology"
import { caTier, caDepth, domainMembership, truncateLabel } from "@/lib/topology"
import { useTopologyStore } from "@/store/topology"
import type { MachineData } from "@/store/topology"
import { Badge } from "@/components/ui/badge"
import { ProgressBar } from "./ProgressBar"

function StatusBadge({ status }: { status: string }) {
  if (status === NODE_STATUS.unconfigured)
    return (
      <Badge
        variant="secondary"
        className="flex items-center gap-1 text-[10px] text-amber-500 border-amber-500/30"
      >
        <AlertTriangle className="h-2.5 w-2.5" />
        unconfigured
      </Badge>
    )
  if (status === NODE_STATUS.configuring)
    return (
      <Badge
        variant="secondary"
        className="flex items-center gap-1 text-[10px] text-muted-foreground"
      >
        <Loader2 className="h-2.5 w-2.5 animate-spin" />
        configuring…
      </Badge>
    )
  return null
}

export function MachineNode({ id, data, selected }: NodeProps<Node<MachineData>>) {
  const def = TEMPLATE_BY_ID[data.typeId]
  const nodes = useNodes<Node<MachineData>>()
  const edges = useEdges()
  const isOverlapping = useTopologyStore((s) => s.overlapNodeId === id)

  // Derived chips (only for configured nodes)
  const showDerived = data.status === NODE_STATUS.configured
  const tier = showDerived && data.typeId === "certificateAuthority"
    ? caTier(id, edges)
    : null
  const depth = tier !== null && tier !== "root" && tier !== "standalone"
    ? caDepth(id, edges)
    : null
  const domain = showDerived ? domainMembership(id, edges, nodes) : null
  const memberCount = showDerived && data.typeId === "domainController"
    ? edges.filter((e) => e.target === id && e.data?.edgeType === EDGE_TYPE.domainJoin).length
    : null

  const Icon = def?.icon ?? AlertTriangle

  return (
    <div
      className={cn(
        "min-w-[160px] rounded-xl border bg-card text-card-foreground shadow-sm select-none",
        "transition-shadow",
        selected && "ring-2 ring-primary shadow-md",
        data.status === NODE_STATUS.unconfigured && "border-amber-500/40",
        data.status === NODE_STATUS.configuring && "border-muted",
        data.status === NODE_STATUS.configured && "border-border",
        !isOverlapping && memberCount !== null && memberCount > 0 &&
          "border-sky-500/60 shadow-[0_0_18px_4px_rgba(14,165,233,0.35)] " +
          "dark:shadow-[0_0_20px_5px_rgba(56,189,248,0.55)]",
        // Overlap warning takes precedence over selection/status styling.
        isOverlapping && "border-red-500 bg-red-500/40 opacity-70 ring-2 ring-red-500/40",
      )}
    >
      {data.typeId === "certificateAuthority" &&
        data.status === NODE_STATUS.configured && (
        <>
          {data.config?.caType !== "Root" && (
            <Handle
              type="target"
              position={Position.Left}
              className="!h-3 !w-3 !bg-muted-foreground/50 !border-border"
            />
          )}
          <Handle
            type="source"
            position={Position.Right}
            className="!h-3 !w-3 !bg-muted-foreground/50 !border-border"
          />
        </>
      )}

      {/* Header */}
      <div
        className={cn(
          "flex items-center gap-2 px-3 py-2 rounded-t-xl border-b",
          "bg-muted/40",
        )}
      >
        <Icon className={cn("h-4 w-4 shrink-0", def?.accent ?? "text-muted-foreground")} />
        <span className="text-xs font-semibold truncate flex-1">{data.name}</span>
      </div>

      {/* Body */}
      <div className="px-3 py-2 flex flex-col gap-1.5">
        <StatusBadge status={data.status} />

        {/* Live progress while configuring */}
        {data.status === NODE_STATUS.configuring && (
          <>
            {data.phase && (
              <span className="text-[10px] text-muted-foreground truncate">
                {data.phase}
              </span>
            )}
            <ProgressBar pct={data.progress ?? 0} />
          </>
        )}

        {/* Derived chips */}
        {tier === "root" && (
          <Badge variant="outline" className="text-[10px] border-amber-500/50 text-amber-500">
            CA: Root
          </Badge>
        )}
        {tier === "intermediate" && (
          <Badge variant="outline" className="text-[10px] border-amber-500/40 text-amber-400">
            CA: Intermediate · T{depth}
          </Badge>
        )}
        {tier === "issuing" && (
          <Badge variant="outline" className="text-[10px] border-amber-500/30 text-amber-300">
            CA: Issuing · T{depth}
          </Badge>
        )}
        {domain && (
          <Badge
            variant="outline"
            className="text-[10px] border-blue-500/40 text-blue-400 max-w-full"
            title={`Domain: ${domain}`}
          >
            <span className="truncate">Domain: {truncateLabel(domain)}</span>
          </Badge>
        )}
        {memberCount !== null && (
          <Badge variant="outline" className="text-[10px] border-blue-500/40 text-blue-400">
            {memberCount} {memberCount === 1 ? "member" : "members"}
          </Badge>
        )}

        {/* Role label */}
        <span className="text-[10px] text-muted-foreground">
          {def?.label ?? data.typeId}
        </span>
      </div>
    </div>
  )
}
