import { beforeEach, describe, expect, it } from "vitest"

import { buildDeployTopology } from "@/lib/deployTopology"
import { buildPkiTemplateIntoStores } from "@/lib/projectTemplate"
import type { StagedOp } from "@/lib/staging"
import { useStagingStore } from "@/store/staging"
import { useTopologyStore } from "@/store/topology"

function operationShape(ops: StagedOp[]) {
  const names = new Map(
    useTopologyStore.getState().nodes.map((node) => [node.id, node.data.name]),
  )
  return ops.map((op) => ({
    kind: op.kind,
    target: names.get(op.targetNodeId),
    secondary: op.secondaryNodeId
      ? names.get(op.secondaryNodeId)
      : undefined,
  }))
}

describe("supplied PKI project template", () => {
  beforeEach(() => buildPkiTemplateIntoStores("template-regression"))

  it("stages domain membership before dependent PKI services", () => {
    const { ops } = useStagingStore.getState()

    expect(operationShape(ops)).toEqual([
      { kind: "createVm", target: "CA01", secondary: undefined },
      { kind: "createVm", target: "CA02", secondary: undefined },
      { kind: "createVm", target: "DC01", secondary: undefined },
      { kind: "createVm", target: "SRV1", secondary: undefined },
      { kind: "domainJoin", target: "CA02", secondary: "DC01" },
      { kind: "domainJoin", target: "SRV1", secondary: "DC01" },
      { kind: "caConnect", target: "CA02", secondary: "CA01" },
      { kind: "webServerCert", target: "CA02", secondary: "SRV1" },
    ])

    const indexes = new Map(ops.map((op, index) => [op.id, index]))
    for (const [index, op] of ops.entries()) {
      expect(op.dependsOn.every((id) => (indexes.get(id) ?? index) < index)).toBe(true)
    }
  })

  it("preserves the compiler-safe order across persisted reloads", () => {
    const expected = operationShape(useStagingStore.getState().ops)
    const restored = JSON.parse(
      JSON.stringify(useStagingStore.getState().ops),
    ) as StagedOp[]

    useStagingStore.getState().loadOps(restored, null)

    expect(operationShape(useStagingStore.getState().ops)).toEqual(expected)
  })

  it("emits all semantic relationships required by the backend compiler", () => {
    const { nodes, edges } = useTopologyStore.getState()
    const topology = buildDeployTopology(nodes, edges)
    const names = new Map(topology.nodes.map((node) => [node.id, node.name]))

    expect(
      topology.edges.map((edge) => ({
        kind: edge.kind,
        source: names.get(edge.source),
        target: names.get(edge.target),
      })),
    ).toEqual([
      { kind: "domainMembership", source: "CA02", target: "DC01" },
      { kind: "domainMembership", source: "SRV1", target: "DC01" },
      { kind: "caParent", source: "CA01", target: "CA02" },
      { kind: "caPublication", source: "CA02", target: "SRV1" },
    ])

    expect(
      topology.dnsRecords.map((record) => ({
        kind: record.kind,
        server: names.get(record.server),
        subject: names.get(record.subject),
        zone: record.zone,
        name: record.name,
      })),
    ).toEqual([
      { kind: "A", server: "DC01", subject: "CA02", zone: "encon.pki", name: undefined },
      { kind: "A", server: "DC01", subject: "DC01", zone: "encon.pki", name: undefined },
      { kind: "A", server: "DC01", subject: "SRV1", zone: "encon.pki", name: undefined },
      { kind: "CNAME", server: "DC01", subject: "SRV1", zone: "encon.pki", name: "pki" },
    ])
  })
})
