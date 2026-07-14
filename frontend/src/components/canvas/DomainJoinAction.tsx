import { useMemo, useState } from "react"
import { Building2 } from "lucide-react"
import type { Node } from "@xyflow/react"

import { Button } from "@/components/ui/button"
import { EDGE_TYPE } from "@/constants/topology"
import {
  domainJoinBlockReason,
  domainLabel,
  isConnectable,
} from "@/lib/topology"
import { useStagingStore } from "@/store/staging"
import { useTopologyStore, type MachineData } from "@/store/topology"

/** Keyboard-accessible counterpart to dropping a node into a domain boundary. */
export function DomainJoinAction({
  onRequest,
}: {
  onRequest: (node: Node<MachineData>, dc: Node<MachineData>) => void
}) {
  const nodes = useTopologyStore((state) => state.nodes)
  const edges = useTopologyStore((state) => state.edges)
  const selectedNodeId = useTopologyStore((state) => state.selectedNodeId)
  const deploying = useStagingStore((state) => state.deploying)
  const domains = useMemo(
    () =>
      nodes.filter(
        (node) => node.data.typeId === "domainController" && isConnectable(node.data),
      ),
    [nodes],
  )
  const selectedNode = nodes.find((node) => node.id === selectedNodeId) ?? null
  const currentDomainId = selectedNode
    ? edges.find(
        (edge) =>
          edge.source === selectedNode.id && edge.data?.edgeType === EDGE_TYPE.domainJoin,
      )?.target
    : undefined
  const availableDomains = useMemo(
    () => domains.filter((domain) => domain.id !== currentDomainId),
    [domains, currentDomainId],
  )
  const [requestedDomainId, setRequestedDomainId] = useState("")
  const domainId = availableDomains.some((domain) => domain.id === requestedDomainId)
    ? requestedDomainId
    : (availableDomains[0]?.id ?? "")

  if (!selectedNode || domains.length === 0) return null

  const domain = availableDomains.find((candidate) => candidate.id === domainId) ?? null
  const reason = domain
    ? domainJoinBlockReason(selectedNode, domain, edges)
    : currentDomainId
      ? `${selectedNode.data.name} already belongs to this domain.`
      : "No other domain is available."

  return (
    <div className="w-72 rounded-xl border bg-background/95 p-2.5 text-[10px] shadow-lg backdrop-blur-sm">
      <div className="mb-2 flex items-center gap-2">
        <Building2 className="h-3.5 w-3.5 text-sky-500" />
        <div className="min-w-0">
          <p className="font-semibold">Join domain</p>
          <p className="truncate text-muted-foreground">Accessible action for {selectedNode.data.name}</p>
        </div>
      </div>
      <div className="flex gap-1.5">
        <label className="sr-only" htmlFor="accessible-domain-target">Target domain</label>
        <select
          id="accessible-domain-target"
          value={domainId}
          onChange={(event) => setRequestedDomainId(event.target.value)}
          disabled={deploying || availableDomains.length === 0}
          className="h-8 min-w-0 flex-1 rounded-md border bg-background px-2 text-xs text-foreground disabled:opacity-50"
        >
          {availableDomains.map((candidate) => (
            <option key={candidate.id} value={candidate.id}>
              {domainLabel(candidate)}
            </option>
          ))}
          {availableDomains.length === 0 && <option>No available domain</option>}
        </select>
        <Button
          type="button"
          size="sm"
          className="h-8"
          disabled={deploying || !domain || reason !== null}
          onClick={() => domain && onRequest(selectedNode, domain)}
        >
          Join domain…
        </Button>
      </div>
      {reason && <p className="mt-1.5 leading-snug text-amber-600">{reason}</p>}
    </div>
  )
}
