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
