import { beforeEach, describe, expect, it } from "vitest"

import { deserializeProject, serializeProject } from "@/lib/projectSerialize"
import { buildPkiTemplateIntoStores } from "@/lib/projectTemplate"
import { useStagingStore } from "@/store/staging"
import { useTopologyStore } from "@/store/topology"
import type { Project } from "@/store/projects"

describe("project recovery", () => {
  beforeEach(() => buildPkiTemplateIntoStores("recovery-project"))

  it("restores staged operations and an in-flight deployment job", () => {
    const topology = useTopologyStore.getState()
    const staging = useStagingStore.getState()
    const project: Project = {
      id: "recovery-project",
      name: "Recoverable PKI lab",
      nodes: topology.nodes,
      edges: topology.edges,
      counters: topology.counters,
      viewport: topology.viewport,
      stagedOps: staging.ops,
      deployJobId: "job-resume-123",
      dirty: false,
      updatedAt: 10,
    }

    const restored = deserializeProject({
      ...serializeProject(project),
      createdAt: 1,
      updatedAt: 10,
    })

    expect(restored.deployJobId).toBe("job-resume-123")
    expect(restored.stagedOps?.map((operation) => operation.id)).toEqual(
      staging.ops.map((operation) => operation.id),
    )
    expect(restored.nodes.map((node) => node.data.name).sort()).toEqual([
      "CA01", "CA02", "DC01", "SRV1",
    ])
  })
})
