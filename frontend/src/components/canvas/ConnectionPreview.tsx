import { AlertTriangle, CheckCircle2 } from "lucide-react"

import { EDGE_TYPE } from "@/constants/topology"
import {
  SERVICE_SOCKET_GUIDANCE,
  canConnectServiceSockets,
  connectionGuidance,
  connectionMissingRequirements,
  parseServiceSocketHandle,
  serviceSocketEdgeType,
  serviceSocketHandleId,
  serviceSocketsForNode,
} from "@/lib/topology"
import { useConnectionGestureStore } from "@/store/connectionGesture"
import { useTopologyStore } from "@/store/topology"

export function ConnectionPreview() {
  const gesture = useConnectionGestureStore((state) => state.gesture)
  const nodes = useTopologyStore((state) => state.nodes)
  const edges = useTopologyStore((state) => state.edges)
  if (!gesture) return null

  const parsed = parseServiceSocketHandle(gesture.sourceHandleId)
  if (!parsed) return null
  const socketGuidance = SERVICE_SOCKET_GUIDANCE[parsed.socket]
  const connection = gesture.targetNodeId && gesture.targetHandleId
    ? {
        source: gesture.sourceNodeId,
        sourceHandle: gesture.sourceHandleId,
        target: gesture.targetNodeId,
        targetHandle: gesture.targetHandleId,
      }
    : null
  const edgeType = connection ? serviceSocketEdgeType(connection, nodes) : null
  const validation = connection
    ? canConnectServiceSockets(connection, nodes, edges)
    : null
  const guidance = edgeType ? connectionGuidance(edgeType) : null
  const missing = edgeType && connection
    ? connectionMissingRequirements(
        edgeType,
        connection.source,
        connection.target,
        nodes,
        edges,
      )
    : []

  const candidates = nodes.flatMap((node) =>
    serviceSocketsForNode(node, edges)
      .filter((candidate) => candidate.type === "target" && candidate.socket === parsed.socket)
      .map((candidate) => canConnectServiceSockets({
        source: gesture.sourceNodeId,
        sourceHandle: gesture.sourceHandleId,
        target: node.id,
        targetHandle: serviceSocketHandleId(candidate.socket, "target"),
      }, nodes, edges)),
  )
  const compatibleCount = candidates.filter((candidate) => candidate.ok).length
  const blockedReasons = [...new Set(
    candidates.flatMap((candidate) => candidate.reason ? [candidate.reason] : []),
  )].slice(0, 2)

  return (
    <div
      role="status"
      aria-live="polite"
      className="pointer-events-none w-96 rounded-xl border bg-background/95 p-3 text-[11px] shadow-xl backdrop-blur"
    >
      <div className="flex items-start justify-between gap-3">
        <div>
          <p className="font-semibold">{guidance?.intent ?? socketGuidance.intent}</p>
          <p className="mt-0.5 text-muted-foreground">
            {edgeType === EDGE_TYPE.caHierarchy
              ? "issues CA certificate"
              : edgeType === EDGE_TYPE.webServerCert
                ? "publishes PKI services and validates enrollment"
                : edgeType === EDGE_TYPE.domainJoin
                  ? "domain membership and DNS"
                  : socketGuidance.label}
          </p>
        </div>
        <span className="shrink-0 rounded-full bg-emerald-500/10 px-2 py-1 text-[10px] font-medium text-emerald-500">
          {compatibleCount} compatible
        </span>
      </div>

      <div className="mt-2 border-t pt-2">
        <p className="font-medium">Required operation</p>
        <p className="mt-0.5 text-muted-foreground">
          {guidance?.operations[0] ?? socketGuidance.operation}
        </p>
      </div>

      {(validation?.reason || missing.length > 0 || (!connection && compatibleCount === 0)) && (
        <div className="mt-2 border-t pt-2">
          <p className="flex items-center gap-1 font-medium text-amber-500">
            <AlertTriangle className="h-3 w-3" /> Still missing
          </p>
          <ul className="mt-1 space-y-0.5 text-muted-foreground">
            {validation?.reason && <li>{validation.reason}</li>}
            {missing.map((item) => <li key={item}>{item}</li>)}
            {!connection && compatibleCount === 0 && blockedReasons.map((item) => (
              <li key={item}>{item}</li>
            ))}
          </ul>
        </div>
      )}

      {connection && validation?.ok && missing.length === 0 && (
        <p className="mt-2 flex items-center gap-1 border-t pt-2 font-medium text-emerald-500">
          <CheckCircle2 className="h-3 w-3" /> Ready to stage
        </p>
      )}
    </div>
  )
}
