import { Fragment, useEffect } from "react"
import {
  AlertTriangle,
  BadgeCheck,
  CheckCircle2,
  Clock,
  FileText,
  Loader2,
  Radio,
  ShieldCheck,
  type LucideIcon,
} from "lucide-react"
import {
  Handle,
  Position,
  useEdges,
  useNodes,
  useUpdateNodeInternals,
} from "@xyflow/react"
import type { NodeProps, Node } from "@xyflow/react"
import { cn } from "@/lib/utils"
import { TEMPLATE_BY_ID } from "@/constants/templates"
import { EDGE_TYPE, LIFECYCLE, SERVICE_SOCKET } from "@/constants/topology"
import type { Lifecycle, ServiceSocket } from "@/constants/topology"
import {
  SERVICE_SOCKET_GUIDANCE,
  canConnectServiceSockets,
  caTier,
  caDepth,
  domainMembership,
  driftedFields,
  isConnectable,
  isDeployed,
  serviceSocketHandleId,
  serviceSocketsForNode,
} from "@/lib/topology"
import { findLabEvidence, nodeHealthWarning } from "@/lib/labEvidence"
import { useAgentConnected } from "@/hooks/useAgentConnected"
import { useTopologyStore } from "@/store/topology"
import { useConnectionGestureStore } from "@/store/connectionGesture"
import type { MachineData } from "@/store/topology"
import { Badge } from "@/components/ui/badge"
import { ProgressBar } from "./ProgressBar"

const MACHINE_NODE_WIDTH = 192
const MACHINE_NODE_HEIGHT = 164

const SOCKET_APPEARANCE: Record<
  ServiceSocket,
  { icon: LucideIcon; dotClassName: string; iconClassName: string }
> = {
  [SERVICE_SOCKET.issuance]: {
    icon: ShieldCheck,
    dotClassName: "!bg-amber-500",
    iconClassName: "text-amber-500",
  },
  [SERVICE_SOCKET.publication]: {
    icon: FileText,
    dotClassName: "!bg-emerald-500",
    iconClassName: "text-emerald-500",
  },
  [SERVICE_SOCKET.ocsp]: {
    icon: Radio,
    dotClassName: "!bg-violet-500",
    iconClassName: "text-violet-500",
  },
  [SERVICE_SOCKET.enrollment]: {
    icon: BadgeCheck,
    dotClassName: "!bg-slate-100",
    iconClassName: "text-slate-400",
  },
}

function socketPlacement(socket: ServiceSocket, type: "source" | "target") {
  if (socket === SERVICE_SOCKET.issuance) {
    return type === "source"
      ? {
          position: Position.Bottom,
          handleStyle: { left: "52%" },
          labelStyle: { bottom: 8, left: "52%", transform: "translateX(-50%)" },
          labelClassName: "justify-center",
        }
      : {
          position: Position.Left,
          handleStyle: { top: "42%" },
          labelStyle: { left: 9, top: "42%", transform: "translateY(-50%)" },
          labelClassName: "justify-start",
        }
  }
  const top = socket === SERVICE_SOCKET.publication
    ? "42%"
    : socket === SERVICE_SOCKET.ocsp
      ? "60%"
      : "78%"
  return type === "source"
    ? {
        position: Position.Right,
        handleStyle: { top },
        labelStyle: { right: 9, top, transform: "translateY(-50%)" },
        labelClassName: "flex-row-reverse justify-start text-right",
      }
    : {
        position: Position.Left,
        handleStyle: { top },
        labelStyle: { left: 9, top, transform: "translateY(-50%)" },
        labelClassName: "justify-start",
      }
}

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
        provisioning
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
  if (lifecycle === LIFECYCLE.drifted)
    return (
      <Badge
        variant="secondary"
        className="flex items-center gap-1 text-[10px] text-orange-500 border-orange-500/30"
      >
        <AlertTriangle className="h-2.5 w-2.5" />
        drifted
      </Badge>
    )
  return (
    <Badge
      variant="secondary"
      className="flex items-center gap-1 text-[10px] text-emerald-500 border-emerald-500/30"
    >
      <CheckCircle2 className="h-2.5 w-2.5" />
      deployed
    </Badge>
  )
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

interface NodeFact {
  label: string
  value: string
}

function compactFacts({
  data,
  tier,
  depth,
  domain,
  memberCount,
}: {
  data: MachineData
  tier: ReturnType<typeof caTier> | null
  depth: number | null
  domain: string | null
  memberCount: number | null
}): [NodeFact, NodeFact] {
  if (data.typeId === "domainController") {
    return [
      { label: "Forest", value: data.config?.forestLevel ?? "Pending" },
      { label: "Members", value: String(memberCount ?? 0) },
    ]
  }
  if (data.typeId === "certificateAuthority") {
    if (tier === "root") {
      return [
        { label: "Trust tier", value: "Root" },
        { label: "Isolation", value: "Air-gapped" },
      ]
    }
    return [
      { label: "Trust tier", value: tier === "standalone" ? "Standalone" : `T${depth ?? 1} ${tier ?? "CA"}` },
      { label: "Domain", value: domain ?? "Not joined" },
    ]
  }
  return [
    { label: "Endpoint", value: isDeployed(data) && data.ip ? data.ip : "Pending" },
    { label: "Domain", value: domain ?? "Not joined" },
  ]
}

export function MachineNode({ id, data, selected }: NodeProps<Node<MachineData>>) {
  const def = TEMPLATE_BY_ID[data.typeId]
  const nodes = useNodes<Node<MachineData>>()
  const edges = useEdges()
  const isOverlapping = useTopologyStore((s) => s.overlapNodeId === id)
  const gesture = useConnectionGestureStore((s) => s.gesture)
  const hoverTarget = useConnectionGestureStore((s) => s.hoverTarget)
  const updateNodeInternals = useUpdateNodeInternals()

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
  const evidence = findLabEvidence(nodes)
  const evidenceWarning = nodeHealthWarning(
    { id, data, position: { x: 0, y: 0 } },
    evidence,
  )
  const driftFields = driftedFields(data)
  const warning = evidenceWarning ??
    (data.lifecycle === LIFECYCLE.failed ? data.phase ?? "Deployment failed" : null) ??
    (driftFields.length > 0 ? "Configuration changed since deploy" : null)
  const facts = compactFacts({ data, tier, depth, domain, memberCount })
  const activePhase = data.lifecycle === LIFECYCLE.deploying ||
    data.lifecycle === LIFECYCLE.destroying

  const Icon = def?.icon ?? AlertTriangle
  const socketSpecs = serviceSocketsForNode(
    { id, data, position: { x: 0, y: 0 } },
    edges,
  )
  const socketLayoutKey = socketSpecs
    .map((spec) => serviceSocketHandleId(spec.socket, spec.type))
    .join("|")
  useEffect(() => {
    updateNodeInternals(id)
  }, [id, socketLayoutKey, updateNodeInternals])
  const socketCompatibility = (socket: ServiceSocket) => {
    if (!gesture) return null
    return canConnectServiceSockets({
      source: gesture.sourceNodeId,
      sourceHandle: gesture.sourceHandleId,
      target: id,
      targetHandle: serviceSocketHandleId(socket, "target"),
    }, nodes, edges)
  }
  const compatibleDestination = gesture && gesture.sourceNodeId !== id &&
    socketSpecs.some((spec) => spec.type === "target" && socketCompatibility(spec.socket)?.ok)
  const dimmedByGesture = gesture && gesture.sourceNodeId !== id && !compatibleDestination

  return (
    <div
      style={{
        width: MACHINE_NODE_WIDTH,
        minWidth: MACHINE_NODE_WIDTH,
        maxWidth: MACHINE_NODE_WIDTH,
        height: MACHINE_NODE_HEIGHT,
        minHeight: MACHINE_NODE_HEIGHT,
        maxHeight: MACHINE_NODE_HEIGHT,
      }}
      className={cn(
        "group/node relative overflow-visible rounded-xl border bg-card text-card-foreground shadow-sm select-none",
        "transition-shadow",
        tier === "root" && "trust-body trust-body-root",
        tier === "intermediate" && "trust-body trust-body-intermediate",
        tier === "issuing" && "trust-body trust-body-issuing",
        compatibleDestination && "ring-2 ring-emerald-400 shadow-[0_0_22px_5px_rgba(52,211,153,0.28)]",
        dimmedByGesture && "opacity-35 saturate-50",
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
      {socketSpecs.map((spec) => {
        const handleId = serviceSocketHandleId(spec.socket, spec.type)
        const placement = socketPlacement(spec.socket, spec.type)
        const compatibility = spec.type === "target"
          ? socketCompatibility(spec.socket)
          : null
        const visible = gesture
          ? gesture.sourceNodeId === id
            ? spec.type === "source"
            : spec.type === "target" && compatibility?.ok === true
          : true
        const appearance = SOCKET_APPEARANCE[spec.socket]
        const SocketIcon = appearance.icon
        const guidance = SERVICE_SOCKET_GUIDANCE[spec.socket]
        return (
          <Fragment key={handleId}>
            <Handle
              id={handleId}
              type={spec.type}
              position={placement.position}
              style={placement.handleStyle}
              isConnectableStart={spec.type === "source"}
              isConnectableEnd={spec.type === "target"}
              title={`${guidance.label} · ${guidance.intent}`}
              aria-label={`${guidance.label} socket: ${guidance.intent}`}
              tabIndex={visible ? 0 : -1}
              onMouseEnter={() => {
                if (gesture && spec.type === "target") hoverTarget(id, handleId)
              }}
              onMouseLeave={() => {
                if (gesture && spec.type === "target") hoverTarget()
              }}
              className={cn(
                "service-socket !z-20 !h-3 !w-3 !rounded-full !border-0 !shadow-sm",
                "transition-opacity duration-150 focus-visible:!outline-none focus-visible:!ring-2 focus-visible:!ring-ring",
                appearance.dotClassName,
                visible
                  ? "!opacity-100"
                  : "pointer-events-none !opacity-0",
              )}
            />
            <span
              aria-hidden="true"
              style={placement.labelStyle}
              className={cn(
                "pointer-events-none absolute z-10 flex max-w-[168px] items-center gap-1 rounded bg-card/95 px-1 py-0.5",
                "text-[9px] font-medium leading-none text-muted-foreground opacity-0 transition-opacity duration-150",
                "group-hover/node:opacity-100 group-focus-within/node:opacity-100",
                selected && "opacity-100",
                gesture && visible && "opacity-100",
                placement.labelClassName,
              )}
            >
              <SocketIcon className={cn("h-3 w-3 shrink-0", appearance.iconClassName)} />
              <span className="truncate">{guidance.label}</span>
            </span>
          </Fragment>
        )
      })}

      {/* Header */}
      <div
        className={cn(
          "flex h-11 items-center gap-2 rounded-t-xl border-b px-3 py-2",
          "bg-muted/40",
        )}
      >
        <Icon className={cn("h-4 w-4 shrink-0", def?.accent ?? "text-muted-foreground")} />
        <span className="min-w-0 flex-1">
          <span className="block truncate text-xs font-semibold">{data.name}</span>
          <span className="block truncate text-[9px] text-muted-foreground">
            {def?.label ?? data.typeId}
          </span>
        </span>
        {data.orchestratorVmId && <AgentStatusDot vmId={data.orchestratorVmId} />}
      </div>

      {/* Body */}
      <div className="flex h-[120px] flex-col gap-2 px-3 py-2">
        <LifecycleBadge lifecycle={data.lifecycle} />

        <div className="h-7 min-w-0">
          {activePhase ? (
            <div className="group/phase relative min-w-0">
              <span
                className="block min-w-0 truncate text-[10px] text-muted-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                tabIndex={0}
                aria-describedby={`phase-${id}`}
              >
                {data.phase ?? "Starting"}
              </span>
              <div
                id={`phase-${id}`}
                role="tooltip"
                className="pointer-events-none absolute bottom-full left-0 z-30 mb-2 hidden w-64 rounded-md border bg-popover px-2 py-1.5 text-[10px] leading-snug text-popover-foreground shadow-lg group-hover/phase:block group-focus-within/phase:block"
              >
                {data.phase ?? "Starting"}
              </div>
              <ProgressBar pct={data.progress ?? 0} />
            </div>
          ) : warning ? (
            <span
              className="flex min-w-0 items-center gap-1 text-[10px] text-red-500"
              title={warning}
            >
              <AlertTriangle className="h-3 w-3 shrink-0" />
              <span className="truncate">{warning}</span>
            </span>
          ) : (
            <span className="flex items-center gap-1 text-[10px] text-emerald-500">
              <CheckCircle2 className="h-3 w-3 shrink-0" />
              No active warning
            </span>
          )}
        </div>

        <dl className="grid grid-cols-2 gap-2 border-t pt-2">
          {facts.map((fact) => (
            <div key={fact.label} className="min-w-0">
              <dt className="truncate text-[9px] uppercase tracking-wide text-muted-foreground">
                {fact.label}
              </dt>
              <dd className="truncate text-[10px] font-medium" title={fact.value}>
                {fact.value}
              </dd>
            </div>
          ))}
        </dl>
      </div>
    </div>
  )
}
