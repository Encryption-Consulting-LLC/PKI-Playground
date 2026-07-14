/** Convert the React Flow canvas into the backend's versioned semantic graph. */

import type { Edge, Node } from "@xyflow/react"

import { EDGE_TYPE } from "@/constants/topology"
import type { EdgeType } from "@/constants/topology"
import type { TopologyPayload, TopologyRole } from "@/lib/api"
import { connectionPorts } from "@/lib/topology"
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

  for (const edge of edges) {
    if (edge.data?.edgeType !== EDGE_TYPE.webServerCert) continue
    const dcId = memberships.get(edge.source)
    const dc = dcId ? domainControllers.get(dcId) : undefined
    const zone = dc?.data.config?.domainName?.trim()
    if (!dcId || !zone) continue
    dnsRecords.push({
      id: `dns:cname:${dcId}:pki`,
      kind: "CNAME",
      server: dcId,
      subject: edge.target,
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
      config: node.data.config ?? {},
    })),
    edges: edges.flatMap((edge) => {
      const edgeType = edge.data?.edgeType as EdgeType | undefined
      const kind =
        edgeType === EDGE_TYPE.domainJoin
          ? "domainMembership"
          : edgeType === EDGE_TYPE.caHierarchy
            ? "caParent"
            : edgeType === EDGE_TYPE.webServerCert
              ? "caPublication"
              : null
      return kind && edgeType
        ? [{
            id: edge.id,
            kind,
            source: edge.source,
            target: edge.target,
            ports: connectionPorts(edgeType),
          }]
        : []
    }),
    dnsRecords,
  }
}
