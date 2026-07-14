/** Convert the React Flow canvas into the backend's versioned semantic graph. */

import type { Edge, Node } from "@xyflow/react"

import { EDGE_TYPE, LIFECYCLE } from "@/constants/topology"
import type { EdgeType } from "@/constants/topology"
import type { TopologyPayload, TopologyRole } from "@/lib/api"
import {
  connectionPorts,
  hasCompleteWebServiceRelationship,
  isDeployed,
  webServiceEdges,
} from "@/lib/topology"
import type { MachineData } from "@/store/topology"

function topologyRole(data: MachineData): TopologyRole {
  switch (data.typeId) {
    case "domainController":
      return "domainController"
    case "certificateAuthority":
      return data.config?.caType === "Issuing" ? "issuingCa" : "rootCa"
    case "webServer":
      return "webServer"
    case "client":
      return "client"
    default:
      return "standalone"
  }
}

export function buildDeployTopology(
  nodes: Node<MachineData>[],
  edges: Edge[],
): TopologyPayload {
  const domainControllers = new Map(
    nodes
      .filter((node) => topologyRole(node.data) === "domainController")
      .map((node) => [node.id, node]),
  )
  const memberships = new Map(
    edges
      .filter((edge) => edge.data?.edgeType === EDGE_TYPE.domainJoin)
      .map((edge) => [edge.source, edge.target]),
  )
  const dnsRecords: TopologyPayload["dnsRecords"] = []
  const servicePairs = new Map<string, { source: string; target: string; edges: Edge[] }>()
  for (const edge of webServiceEdges(edges)) {
    const source = nodes.find((node) => node.id === edge.source)
    if (source?.data.config?.caType !== "Issuing") continue
    const key = `${edge.source}\u0000${edge.target}`
    const pair = servicePairs.get(key) ?? { source: edge.source, target: edge.target, edges: [] }
    pair.edges.push(edge)
    servicePairs.set(key, pair)
  }
  const completeServicePairs = [...servicePairs.values()].filter((pair) =>
    hasCompleteWebServiceRelationship(pair.edges, pair.source, pair.target),
  )

  for (const node of nodes) {
    const role = topologyRole(node.data)
    if (!(["domainController", "issuingCa", "webServer"] as TopologyRole[]).includes(role)) {
      continue
    }
    const dcId = role === "domainController" ? node.id : memberships.get(node.id)
    const dc = dcId ? domainControllers.get(dcId) : undefined
    const zone = dc?.data.config?.domainName?.trim()
    if (!dcId || !zone) continue
    dnsRecords.push({
      id: `dns:a:${dcId}:${node.id}`,
      kind: "A",
      server: dcId,
      subject: node.id,
      zone,
    })
    const reverseZone = dc?.data.config?.reverseZone?.trim()
    if (reverseZone) {
      dnsRecords.push({
        id: `dns:ptr:${dcId}:${node.id}`,
        kind: "PTR",
        server: dcId,
        subject: node.id,
        zone: reverseZone,
      })
    }
  }

  for (const pair of completeServicePairs) {
    const dcId = memberships.get(pair.source)
    const dc = dcId ? domainControllers.get(dcId) : undefined
    const zone = dc?.data.config?.domainName?.trim()
    if (!dcId || !zone) continue
    dnsRecords.push({
      id: `dns:cname:${dcId}:pki`,
      kind: "CNAME",
      server: dcId,
      subject: pair.target,
      zone,
      name: "pki",
    })
  }

  return {
    version: 1,
    nodes: nodes.map((node) => ({
      id: node.id,
      name: node.data.name,
      role: topologyRole(node.data),
      state:
        isDeployed(node.data) || node.data.lifecycle === LIFECYCLE.provisioning
          ? "realized"
          : "planned",
      config: node.data.config ?? {},
    })),
    edges: [
      ...edges.flatMap((edge) => {
        const edgeType = edge.data?.edgeType as EdgeType | undefined
        const kind: "domainMembership" | "caParent" | null =
          edgeType === EDGE_TYPE.domainJoin
            ? "domainMembership"
            : edgeType === EDGE_TYPE.caHierarchy
              ? "caParent"
              : null
        return kind && edgeType
          ? [{
              id: edge.id,
              kind,
              source: edge.source,
              target: edge.target,
              state: edge.data?.staged === true ? "planned" as const : "realized" as const,
              ports: connectionPorts(edgeType),
            }]
          : []
      }),
      ...completeServicePairs.map((pair) => ({
        id: `service:${pair.source}:${pair.target}`,
        kind: "caPublication" as const,
        source: pair.source,
        target: pair.target,
        state: pair.edges.some((edge) => edge.data?.staged === true)
          ? "planned" as const
          : "realized" as const,
        ports: connectionPorts(EDGE_TYPE.webServerCert),
      })),
    ],
    dnsRecords,
  }
}
