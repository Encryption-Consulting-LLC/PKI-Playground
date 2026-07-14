export interface CertificateJourneyHop {
  id: "enroll" | "issue" | "aia" | "cdp" | "ocsp"
  label: string
  url: string
  dns: { hostname: string; address: string | null }
  artifacts: string[]
  ok: boolean
  failureReason: string | null
}

export interface CertificateJourney {
  schemaVersion: 1
  healthy: boolean
  lastVerifiedAt: string
  signatureAlgorithm: string
  hops: CertificateJourneyHop[]
}

export function isCertificateJourney(value: unknown): value is CertificateJourney {
  if (!value || typeof value !== "object") return false
  const candidate = value as Partial<CertificateJourney>
  return candidate.schemaVersion === 1 &&
    typeof candidate.lastVerifiedAt === "string" &&
    typeof candidate.signatureAlgorithm === "string" &&
    Array.isArray(candidate.hops) &&
    candidate.hops.every((hop) =>
      !!hop && typeof hop === "object" &&
      typeof hop.id === "string" &&
      typeof hop.label === "string" &&
      typeof hop.url === "string" &&
      Array.isArray(hop.artifacts),
    )
}

export interface CertificateJourneyProjection {
  journey: CertificateJourney
  nodeIds: string[]
  edgeIds: string[]
  live: boolean
}

/** Build the lens from persisted evidence, falling back to a concrete planned path. */
export function projectCertificateJourney(
  nodes: Node<MachineData>[],
  edges: Edge[],
): CertificateJourneyProjection | null {
  const publication = edges.find((edge) =>
    edge.data?.edgeType === EDGE_TYPE.webServerCert &&
    edgeServiceSocket(edge) === SERVICE_SOCKET.publication,
  )
  if (!publication) return null
  const issuing = nodes.find((node) => node.id === publication.source)
  const web = nodes.find((node) => node.id === publication.target)
  if (!issuing || !web) return null
  const parent = edges.find(
    (edge) => edge.data?.edgeType === EDGE_TYPE.caHierarchy && edge.target === issuing.id,
  )
  const membership = edges.find(
    (edge) => edge.data?.edgeType === EDGE_TYPE.domainJoin && edge.source === web.id,
  )
  const dc = nodes.find((node) => node.id === membership?.target)
  const nodeIds = Array.from(new Set([
    web.id,
    issuing.id,
    ...(parent ? [parent.source] : []),
  ]))
  const ocsp = edges.find((edge) =>
    edge.data?.edgeType === EDGE_TYPE.webServerCert &&
    edge.source === publication.source &&
    edge.target === publication.target &&
    edgeServiceSocket(edge) === SERVICE_SOCKET.ocsp,
  )
  const edgeIds = [publication.id, ...(ocsp ? [ocsp.id] : []), ...(parent ? [parent.id] : [])]
  if (web.data.certificateJourney) {
    return { journey: web.data.certificateJourney, nodeIds, edgeIds, live: true }
  }

  const domain = dc?.data.config?.domainName || "domain pending"
  const pkiHost = domain === "domain pending" ? "pki.domain" : `pki.${domain}`
  const caHost = domain === "domain pending"
    ? issuing.data.name
    : `${issuing.data.name}.${domain}`
  const signature = issuing.data.config?.keyAlgorithm || "signature pending"
  const pending = "Awaiting deployment verification."
  const dns = (hostname: string, address?: string) => ({ hostname, address: address ?? null })
  const hop = (
    id: CertificateJourneyHop["id"],
    label: string,
    url: string,
    host: ReturnType<typeof dns>,
    artifacts: string[],
  ): CertificateJourneyHop => ({
    id,
    label,
    url,
    dns: host,
    artifacts,
    ok: false,
    failureReason: pending,
  })
  return {
    live: false,
    nodeIds,
    edgeIds,
    journey: {
      schemaVersion: 1,
      healthy: false,
      lastVerifiedAt: "",
      signatureAlgorithm: signature,
      hops: [
        hop("enroll", `${web.data.name} probe enrolls`, `adcs://${caHost}/Workstation`, dns(caHost, issuing.data.ip), ["lab-health-probe.cer"]),
        hop("issue", `${issuing.data.name} issues`, `adcs://${caHost}/${issuing.data.config?.commonName ?? issuing.data.name}`, dns(caHost, issuing.data.ip), ["lab-health-probe.cer"]),
        hop("aia", "AIA builds the chain", `http://${pkiHost}/CertEnroll/`, dns(pkiHost, web.data.ip), ["issuing CA certificate", "root CA certificate"]),
        hop("cdp", "CDP checks revocation", `http://${pkiHost}/CertEnroll/`, dns(pkiHost, web.data.ip), ["base CRLs", "delta CRL"]),
        hop("ocsp", "OCSP checks status", `http://${pkiHost}/ocsp`, dns(pkiHost, web.data.ip), ["verified OCSP response"]),
      ],
    },
  }
}
import type { Edge, Node } from "@xyflow/react"

import { EDGE_TYPE, SERVICE_SOCKET } from "@/constants/topology"
import { edgeServiceSocket } from "@/lib/topology"
import type { MachineData } from "@/store/topology"
