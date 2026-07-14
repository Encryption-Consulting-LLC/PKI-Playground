import { describe, expect, it } from "vitest"

import { CONNECTION_PORT, EDGE_TYPE } from "@/constants/topology"
import {
  CONNECTION_PORT_GUIDANCE,
  connectionGuidance,
  connectionPorts,
} from "@/lib/topology"

describe("connection capability guidance", () => {
  it("maps deployable relationships to typed capability ports", () => {
    expect(connectionPorts(EDGE_TYPE.caHierarchy)).toEqual([
      CONNECTION_PORT.caParent,
    ])
    expect(connectionPorts(EDGE_TYPE.domainJoin)).toEqual([
      CONNECTION_PORT.domainBoundary,
    ])
    expect(connectionPorts(EDGE_TYPE.webServerCert)).toEqual([
      CONNECTION_PORT.caPublication,
      CONNECTION_PORT.webHost,
      CONNECTION_PORT.probeCertificate,
    ])
  })

  it("defines every capability named by the roadmap", () => {
    expect(CONNECTION_PORT_GUIDANCE).toMatchObject({
      caParent: { capabilities: ["Issues CA certificate"] },
      caPublication: { capabilities: ["HTTP CDP", "HTTP AIA", "OCSP URL"] },
      domainBoundary: {
        capabilities: ["AD membership", "DNS resolver", "LDAP publication"],
      },
      webHost: {
        capabilities: ["CertEnroll share", "HTTP CertEnroll", "Online Responder"],
      },
      probeCertificate: {
        capabilities: ["Enrollment", "Chain validation", "Revocation validation"],
      },
    })
  })

  it("explains prerequisites and generated operations", () => {
    const guidance = connectionGuidance(EDGE_TYPE.webServerCert)

    expect(guidance.intent).toContain("Publishes PKI services")
    expect(guidance.requirements).toContain(
      "Issuing CA and web host share an AD domain",
    )
    expect(guidance.operations[0]).toContain("webServerCert")
  })
})
