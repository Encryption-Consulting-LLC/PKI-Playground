import { AlertTriangle, Clock, Loader2, RefreshCw } from "lucide-react"
import { Handle, Position, useEdges, useNodes } from "@xyflow/react"
import type { NodeProps, Node } from "@xyflow/react"
import { cn } from "@/lib/utils"
import { TEMPLATE_BY_ID } from "@/constants/templates"
import type { TemplateDef } from "@/constants/templates"
import { EDGE_TYPE, LIFECYCLE } from "@/constants/topology"
import type { Lifecycle } from "@/constants/topology"
import {
  caTier,
  caDepth,
  domainMembership,
  driftedFields,
  isConnectable,
  isDeployed,
  truncateLabel,
} from "@/lib/topology"
import { useAgentConnected } from "@/hooks/useAgentConnected"
import { useTopologyStore } from "@/store/topology"
import type { MachineData } from "@/store/topology"
import { Badge } from "@/components/ui/badge"
import { ProgressBar } from "./ProgressBar"

function LifecycleBadge({ lifecycle }: { lifecycle: Lifecycle }) {
  if (lifecycle === LIFECYCLE.draft)
    return (
      <Badge
        variant="secondary"
        className="flex items-center gap-1 text-[10px] text-amber-500 border-amber-500/30"
      >
        <AlertTriangle className="h-2.5 w-2.5" />
        draft
      </Badge>
    )
  if (lifecycle === LIFECYCLE.staged)
    return (
      <Badge
        variant="secondary"
        className="flex items-center gap-1 text-[10px] text-sky-500 border-sky-500/30"
      >
        <Clock className="h-2.5 w-2.5" />
        staged
      </Badge>
    )
  if (lifecycle === LIFECYCLE.deploying)
    return (
      <Badge
        variant="secondary"
        className="flex items-center gap-1 text-[10px] text-muted-foreground"
      >
        <Loader2 className="h-2.5 w-2.5 animate-spin" />
        deploying…
      </Badge>
    )
  if (lifecycle === LIFECYCLE.provisioning)
    return (
      <Badge
        variant="secondary"
        className="flex items-center gap-1 text-[10px] text-emerald-500 border-emerald-500/30"
      >
        <Loader2 className="h-2.5 w-2.5 animate-spin" />
        awaiting orchestrator…
      </Badge>
    )
  if (lifecycle === LIFECYCLE.failed)
    return (
      <Badge
        variant="secondary"
        className="flex items-center gap-1 text-[10px] text-red-500 border-red-500/30"
      >
        <AlertTriangle className="h-2.5 w-2.5" />
        failed
      </Badge>
    )
  if (lifecycle === LIFECYCLE.destroying)
    return (
      <Badge
        variant="secondary"
        className="flex items-center gap-1 text-[10px] text-red-500 border-red-500/30"
      >
        <Loader2 className="h-2.5 w-2.5 animate-spin" />
        removing…
      </Badge>
    )
  return null
}

/**
 * Live orchestrator link status for a node with a minted agent identity —
 * green while the agent's phone-home socket is up, red the instant it drops
 * (pushed over the presence WebSocket, so no polling lag). Only rendered once
 * a real VM exists — `orchestratorVmId` rides on the createVm op's running
 * pushes (partial result), so the dot appears while provisioning is underway.
 */
function AgentStatusDot({ vmId }: { vmId: string }) {
  const connected = useAgentConnected(vmId)
  return (
    <span
      title={connected ? "Orchestrator connected" : "Orchestrator offline"}
      className={cn(
        "h-2 w-2 shrink-0 rounded-full",
        connected
          ? "bg-emerald-500 shadow-[0_0_6px_1px_rgba(16,185,129,0.7)]"
          : "bg-red-500 shadow-[0_0_6px_1px_rgba(239,68,68,0.6)]",
      )}
    />
  )
}

/** Amber badge shown on a deployed node whose config has since been edited — deploy skips these in v1, so this is purely informational. */
function DriftBadge({ data, def }: { data: MachineData; def?: TemplateDef }) {
  const fields = driftedFields(data)
  if (fields.length === 0) return null
  const labels = fields.map((key) => def?.configFields?.find((f) => f.key === key)?.label ?? key)
  return (
    <Badge
      variant="secondary"
      className="flex items-center gap-1 text-[10px] text-orange-500 border-orange-500/30 max-w-full"
      title={`Config changed since last deploy: ${labels.join(", ")}`}
    >
      <RefreshCw className="h-2.5 w-2.5 shrink-0" />
      <span className="truncate">drifted</span>
    </Badge>
  )
}

export function MachineNode({ id, data, selected }: NodeProps<Node<MachineData>>) {
  const def = TEMPLATE_BY_ID[data.typeId]
  const nodes = useNodes<Node<MachineData>>()
  const edges = useEdges()
  const isOverlapping = useTopologyStore((s) => s.overlapNodeId === id)

  // Derived chips — only meaningful once a node can carry real edges.
  const showDerived = isConnectable(data)
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
        data.lifecycle === LIFECYCLE.draft && "border-amber-500/40",
        data.lifecycle === LIFECYCLE.staged && "border-sky-500/40 border-dashed opacity-80",
        data.lifecycle === LIFECYCLE.deploying && "border-muted",
        data.lifecycle === LIFECYCLE.provisioning && "border-emerald-500/30 border-dashed",
        data.lifecycle === LIFECYCLE.deployed && "border-border",
        data.lifecycle === LIFECYCLE.drifted && "border-orange-500/40",
        data.lifecycle === LIFECYCLE.failed && "border-red-500/50",
        data.lifecycle === LIFECYCLE.destroying && "border-red-500/40 opacity-70",
        !isOverlapping && memberCount !== null && memberCount > 0 &&
          "border-sky-500/60 shadow-[0_0_18px_4px_rgba(14,165,233,0.35)] " +
          "dark:shadow-[0_0_20px_5px_rgba(56,189,248,0.55)]",
        !isOverlapping && data.typeId === "certificateAuthority" && domain !== null &&
          "border-amber-500/60 shadow-[0_0_18px_4px_rgba(245,158,11,0.35)] " +
          "dark:shadow-[0_0_20px_5px_rgba(251,191,36,0.55)]",
        // Overlap warning takes precedence over selection/lifecycle styling.
        isOverlapping && "border-red-500 bg-red-500/40 opacity-70 ring-2 ring-red-500/40",
      )}
    >
      {data.typeId === "certificateAuthority" &&
        isConnectable(data) && (
        <>
          {data.config?.caType !== "Root" && (
            <Handle
              id="hierarchy-in"
              type="target"
              position={Position.Left}
              className="!h-3 !w-3 !bg-muted-foreground/50 !border-border"
            />
          )}
          <Handle
            id="hierarchy"
            type="source"
            position={Position.Bottom}
            className="!h-3 !w-3 !bg-muted-foreground/50 !border-border"
          />
          <Handle
            id="server"
            type="source"
            position={Position.Right}
            className="!h-3 !w-3 !bg-emerald-500/60 !border-border"
          />
        </>
      )}

      {data.typeId === "webServer" &&
        isConnectable(data) && (
        <Handle
          type="target"
          position={Position.Left}
          className="!h-3 !w-3 !bg-emerald-500/60 !border-border"
        />
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
        {data.orchestratorVmId && <AgentStatusDot vmId={data.orchestratorVmId} />}
      </div>

      {/* Body */}
      <div className="px-3 py-2 flex flex-col gap-1.5">
        <LifecycleBadge lifecycle={data.lifecycle} />
        {data.lifecycle === LIFECYCLE.drifted && <DriftBadge data={data} def={def} />}

        {/* Live progress while a job (deploy or teardown) runs on this node */}
        {(data.lifecycle === LIFECYCLE.deploying ||
          data.lifecycle === LIFECYCLE.destroying) && (
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

        {/* Deploy-confirmed IP — the address you'd RDP to. Held back until the
            node is a confirmed deployment (agent online): a `provisioning`
            node already knows its pool IP, but showing it would imply the box
            is reachable before the orchestrator has actually phoned home. An
            offline root is presented air-gapped: its real management IP is
            hidden on the node. */}
        {tier === "root" ? (
          <span className="text-[10px] text-amber-500">air-gapped</span>
        ) : (
          isDeployed(data) &&
          data.ip && (
            <span className="font-mono text-[10px] text-muted-foreground">
              {data.ip}
            </span>
          )
        )}

        {/* Role label */}
        <span className="text-[10px] text-muted-foreground">
          {def?.label ?? data.typeId}
        </span>
      </div>
    </div>
  )
}
