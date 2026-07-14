import { describe, expect, it } from "vitest"

import {
  CONNECTION_HEALTH,
  CONNECTION_PORT,
  EDGE_TYPE,
  SERVICE_SOCKET,
} from "@/constants/topology"
import {
  CONNECTION_PORT_GUIDANCE,
  canConnect,
  canConnectServiceSockets,
  connectionMissingRequirements,
  connectionGuidance,
  connectionHealthForOperation,
  connectionPorts,
  domainJoinBlockReason,
  domainJoinOperations,
  domainRegionSummary,
  isConnectable,
  lintTopologyRelationships,
  serviceSocketHandleId,
  serviceSocketsForNode,
  trustGravityLayout,
} from "@/lib/topology"
import type { Edge, Node } from "@xyflow/react"
import type { MachineData } from "@/store/topology"

function machine(
  id: string,
  name: string,
  typeId: string,
  config: Record<string, string> = {},
): Node<MachineData> {
  return {
    id,
    position: { x: 0, y: 0 },
    data: {
      name,
      typeId,
      config,
      lifecycle: "staged",
      poweredOn: false,
    },
  }
}

function relationship(
  id: string,
  source: string,
  target: string,
  edgeType: string,
  health = "planned",
): Edge {
  return { id, source, target, data: { edgeType, health } }
}

describe("connection capability guidance", () => {
  it("keeps configured staged nodes connectable before deployment", () => {
    const root = machine("root", "CA01", "certificateAuthority", {
      caType: "Root",
    })
    const issuing = machine("issuing", "CA02", "certificateAuthority", {
      caType: "Issuing",
    })

    expect(isConnectable(root.data)).toBe(true)
    expect(isConnectable(issuing.data)).toBe(true)
    expect(canConnect(root.id, issuing.id, [root, issuing], [])).toEqual({
      ok: true,
    })
  })

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

  it("maps operation progress to the five connection health states", () => {
    expect(connectionHealthForOperation("staged")).toBe(CONNECTION_HEALTH.planned)
    expect(connectionHealthForOperation("running")).toBe(CONNECTION_HEALTH.applying)
    expect(connectionHealthForOperation("done")).toBe(CONNECTION_HEALTH.verified)
    expect(connectionHealthForOperation("cancelled")).toBe(CONNECTION_HEALTH.degraded)
    expect(connectionHealthForOperation("error")).toBe(CONNECTION_HEALTH.broken)
  })
})

describe("topology relationship linter", () => {
  const nodes = [
    machine("dc", "DC01", "domainController"),
    machine("root", "CA01", "certificateAuthority", { caType: "Root" }),
    machine("issuing", "CA02", "certificateAuthority", { caType: "Issuing" }),
    machine("web", "SRV1", "webServer", { enableOcsp: "Enabled" }),
  ]

  it("reports missing domain, publication, and OCSP grant relationships", () => {
    const diagnostics = lintTopologyRelationships(nodes, [
      relationship("parent", "root", "issuing", EDGE_TYPE.caHierarchy),
    ])

    expect(diagnostics.map((item) => item.message)).toEqual([
      "CA02 has a parent but is not inside an AD domain.",
      "CA02 publishes HTTP CDP/AIA, but no web host is connected.",
      "SRV1 has OCSP enabled, but no issuing CA grants its enrollment templates.",
    ])
  })

  it("reports a planned CNAME whose web target has no A record", () => {
    const diagnostics = lintTopologyRelationships(nodes, [
      relationship("parent", "root", "issuing", EDGE_TYPE.caHierarchy),
      relationship("issuing-domain", "issuing", "dc", EDGE_TYPE.domainJoin),
      relationship("publication", "issuing", "web", EDGE_TYPE.webServerCert),
    ])

    expect(diagnostics.map((item) => item.message)).toContain(
      "PKI CNAME is planned, but its target SRV1 has no A record.",
    )
  })

  it("reports a failed probe revocation path", () => {
    const diagnostics = lintTopologyRelationships(nodes, [
      relationship("parent", "root", "issuing", EDGE_TYPE.caHierarchy),
      relationship("issuing-domain", "issuing", "dc", EDGE_TYPE.domainJoin),
      relationship("web-domain", "web", "dc", EDGE_TYPE.domainJoin),
      relationship(
        "publication",
        "issuing",
        "web",
        EDGE_TYPE.webServerCert,
        CONNECTION_HEALTH.broken,
      ),
    ])

    expect(diagnostics).toContainEqual(
      expect.objectContaining({
        code: "probe-ocsp-path-unverified",
        severity: "error",
        message: "SRV1 can enroll its probe, but no verified OCSP path reaches its certificate.",
      }),
    )
  })
})

describe("living domain model", () => {
  const dc = machine("dc", "DC01", "domainController", {
    domainName: "encon.pki",
    forestLevel: "Windows Server 2025",
  })

  it("uses one eligibility explanation for spatial and accessible joins", () => {
    const draft = machine("draft", "SRV2", "webServer")
    draft.data.lifecycle = "draft"
    const root = machine("root", "CA01", "certificateAuthority", { caType: "Root" })

    expect(domainJoinBlockReason(draft, dc, [])).toBe(
      "Configure SRV2 before joining it to a domain.",
    )
    expect(domainJoinBlockReason(root, dc, [])).toBe(
      "CA01 is an offline root CA and must remain outside Active Directory.",
    )
    expect(domainJoinBlockReason(machine("web", "SRV1", "webServer"), dc, [])).toBeNull()
  })

  it("previews the exact role-specific domain join command sequence", () => {
    expect(domainJoinOperations(machine("web", "SRV1", "webServer"), dc, [])).toEqual([
      "dns.set_client · use DC01",
      "domain.join · encon.pki",
      "system.reboot → domain.verify",
      "dns.apply_resources → dns.verify · A/PTR",
      "iis.setup_certenroll · share/ACL",
    ])
  })

  it("summarizes forest, member, and service reach health for the rim", () => {
    const summary = domainRegionSummary(dc, [
      relationship("member", "web", "dc", EDGE_TYPE.domainJoin, CONNECTION_HEALTH.degraded),
    ])

    expect(summary).toMatchObject({
      memberCount: 1,
      forestLevel: "Windows Server 2025",
      forestHealth: CONNECTION_HEALTH.planned,
      domainHealth: CONNECTION_HEALTH.degraded,
      services: {
        dns: CONNECTION_HEALTH.degraded,
        ldap: CONNECTION_HEALTH.degraded,
        authentication: CONNECTION_HEALTH.degraded,
      },
    })
  })
})

describe("PKI trust gravity", () => {
  it("settles CA descendants into stable hierarchy tiers", () => {
    const root = { ...machine("root", "CA01", "certificateAuthority"), position: { x: 500, y: 80 } }
    const issuingB = machine("issuing-b", "CA03", "certificateAuthority")
    const issuingA = machine("issuing-a", "CA02", "certificateAuthority")
    const web = machine("web", "SRV1", "webServer")
    const dc = { ...machine("dc", "DC01", "domainController"), position: { x: 40, y: 40 } }
    const edges = [
      relationship("root-b", "root", "issuing-b", EDGE_TYPE.caHierarchy),
      relationship("root-a", "root", "issuing-a", EDGE_TYPE.caHierarchy),
      relationship("publish", "issuing-a", "web", EDGE_TYPE.webServerCert),
    ]

    const settled = trustGravityLayout([root, issuingB, issuingA, web, dc], edges, "issuing-a")
    const position = (id: string) => settled.find((node) => node.id === id)!.position

    expect(position("root")).toEqual({ x: 500, y: 80 })
    expect(position("issuing-a")).toEqual({ x: 370, y: 300 })
    expect(position("issuing-b")).toEqual({ x: 630, y: 300 })
    expect(position("web")).toEqual({ x: 500, y: 520 })
    expect(position("dc")).toEqual({ x: 40, y: 40 })
  })

  it("leaves unrelated standalone CAs untouched", () => {
    const root = machine("root", "CA01", "certificateAuthority")
    const standalone = { ...machine("other", "CA99", "certificateAuthority"), position: { x: 900, y: 700 } }

    expect(trustGravityLayout([root, standalone], [], "root")).toEqual([root, standalone])
  })
})

describe("service socket compatibility", () => {
  const socketConnection = (
    source: string,
    target: string,
    socket: (typeof SERVICE_SOCKET)[keyof typeof SERVICE_SOCKET],
  ) => ({
    source,
    target,
    sourceHandle: serviceSocketHandleId(socket, "source"),
    targetHandle: serviceSocketHandleId(socket, "target"),
  })

  it("accepts only matching role-specific service sockets", () => {
    const root = machine("root", "CA01", "certificateAuthority", { caType: "Root" })
    const issuing = machine("issuing", "CA02", "certificateAuthority", { caType: "Issuing" })
    const web = machine("web", "SRV1", "webServer")

    expect(canConnectServiceSockets(
      socketConnection("root", "issuing", SERVICE_SOCKET.issuance),
      [root, issuing, web],
      [],
    )).toEqual({ ok: true })
    expect(canConnectServiceSockets(
      socketConnection("root", "web", SERVICE_SOCKET.issuance),
      [root, issuing, web],
      [],
    ).ok).toBe(false)
  })

  it("exposes all five discoverable sockets on their supported roles", () => {
    const root = machine("root", "CA01", "certificateAuthority", { caType: "Root" })
    const issuing = machine("issuing", "CA02", "certificateAuthority", { caType: "Issuing" })
    const web = machine("web", "SRV1", "webServer")
    const dc = machine("dc", "DC01", "domainController")

    expect(serviceSocketsForNode(root, []).map(({ socket, type }) => `${socket}:${type}`)).toEqual([
      "issuance:source",
      "publication:source",
      "ocsp:source",
      "enrollment:source",
    ])
    expect(serviceSocketsForNode(issuing, [])).toContainEqual({
      socket: SERVICE_SOCKET.domain,
      type: "source",
    })
    expect(serviceSocketsForNode(web, [])).toContainEqual({
      socket: SERVICE_SOCKET.ocsp,
      type: "target",
    })
    expect(serviceSocketsForNode(dc, [])).toEqual([{
      socket: SERVICE_SOCKET.domain,
      type: "target",
    }])
  })

  it("allows a blue domain socket to stage eligible membership", () => {
    const dc = machine("dc", "DC01", "domainController")
    const web = machine("web", "SRV1", "webServer")

    expect(canConnectServiceSockets(
      socketConnection("web", "dc", SERVICE_SOCKET.domain),
      [dc, web],
      [],
    )).toEqual({ ok: true })
  })

  it("resists second parents and hierarchy cycles during the gesture", () => {
    const root = machine("root", "CA01", "certificateAuthority")
    const issuing = machine("issuing", "CA02", "certificateAuthority")
    const other = machine("other", "CA03", "certificateAuthority")
    const hierarchy = [
      relationship("parent", "root", "other", EDGE_TYPE.caHierarchy),
      relationship("child", "other", "issuing", EDGE_TYPE.caHierarchy),
    ]

    expect(canConnectServiceSockets(
      socketConnection("root", "issuing", SERVICE_SOCKET.issuance),
      [root, issuing, other],
      hierarchy,
    ).reason).toContain("already has an issuer")
    expect(canConnectServiceSockets(
      socketConnection("issuing", "root", SERVICE_SOCKET.issuance),
      [root, issuing, other],
      hierarchy,
    ).reason).toContain("loop")
  })

  it("reports concrete missing publication prerequisites", () => {
    const issuing = machine("issuing", "CA02", "certificateAuthority", { caType: "Issuing" })
    const web = machine("web", "SRV1", "webServer", { enableOcsp: "Disabled" })

    expect(connectionMissingRequirements(
      EDGE_TYPE.webServerCert,
      "issuing",
      "web",
      [issuing, web],
      [],
    )).toEqual([
      "CA02 still needs a root CA parent",
      "CA02 and SRV1 must share an AD domain",
      "SRV1 must enable Online Responder",
    ])
  })
})
