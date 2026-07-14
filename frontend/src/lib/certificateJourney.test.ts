import { describe, expect, it } from "vitest"
import type { Edge, Node } from "@xyflow/react"

import { EDGE_TYPE, LIFECYCLE } from "@/constants/topology"
import { projectCertificateJourney } from "@/lib/certificateJourney"
import type { MachineData } from "@/store/topology"

const node = (id: string, typeId: string, config: Record<string, string> = {}): Node<MachineData> => ({
  id,
  type: "machine",
  position: { x: 0, y: 0 },
  data: { id, name: id.toUpperCase(), typeId, config, lifecycle: LIFECYCLE.staged, poweredOn: false },
})

it("projects the planned certificate path from topology relationships", () => {
  const nodes = [
    node("root", "certificateAuthority", { caType: "Root" }),
    node("ca", "certificateAuthority", { caType: "Issuing", keyAlgorithm: "ML-DSA-87" }),
    node("web", "webServer"),
    node("dc", "domainController", { domainName: "encon.pki" }),
  ]
  const edges: Edge[] = [
    { id: "trust", source: "root", target: "ca", data: { edgeType: EDGE_TYPE.caHierarchy } },
    { id: "publish", source: "ca", target: "web", data: { edgeType: EDGE_TYPE.webServerCert } },
    { id: "member", source: "web", target: "dc", data: { edgeType: EDGE_TYPE.domainJoin } },
  ]

  const projection = projectCertificateJourney(nodes, edges)

  expect(projection?.live).toBe(false)
  expect(projection?.nodeIds).toEqual(["web", "ca", "root"])
  expect(projection?.edgeIds).toEqual(["publish", "trust"])
  expect(projection?.journey.hops.map((hop) => hop.id)).toEqual(["enroll", "issue", "aia", "cdp", "ocsp"])
  expect(projection?.journey.hops[4].url).toBe("http://pki.encon.pki/ocsp")
  expect(projection?.journey.signatureAlgorithm).toBe("ML-DSA-87")
})

describe("certificate journey availability", () => {
  it("requires an issuing CA publication relationship", () => {
    expect(projectCertificateJourney([], [])).toBeNull()
  })
})
