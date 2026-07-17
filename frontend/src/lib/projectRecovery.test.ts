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
    const stagedOps = staging.ops.map((operation, index) =>
      index === 0
        ? {
            ...operation,
            executionGroup: {
              id: operation.id,
              kind: operation.kind,
              label: operation.label,
              target: operation.targetNodeId,
              dependsOn: [],
              steps: [
                {
                  id: `${operation.id}:clone`,
                  label: "Clone the saved machine",
                  kind: "clone" as const,
                  targetNodeId: operation.targetNodeId,
                  dependsOn: [],
                },
              ],
            },
          }
        : operation,
    )
    const project: Project = {
      id: "recovery-project",
      name: "Recoverable PKI lab",
      nodes: topology.nodes,
      edges: topology.edges,
      counters: topology.counters,
      viewport: topology.viewport,
      stagedOps,
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
    expect(restored.stagedOps?.[0].executionGroup?.steps[0].label).toBe(
      "Clone the saved machine",
    )
    expect(restored.nodes.map((node) => node.data.name).sort()).toEqual([
      "CA01",
      "CA02",
      "DC01",
      "SRV1",
    ])
  })

  it("persists terminal failure detail while stripping transient progress state", () => {
    const topology = useTopologyStore.getState()
    const failedNodes = topology.nodes.map((node, index) =>
      index === 0
        ? {
            ...node,
            data: {
              ...node.data,
              lifecycle: "failed" as const,
              progress: 72,
              phase: "Installing role",
              errorDetail: "Access was denied by the remote command",
            },
          }
        : node,
    )
    const project: Project = {
      id: "recovery-project",
      name: "Recoverable PKI lab",
      nodes: failedNodes,
      edges: topology.edges,
      counters: topology.counters,
      viewport: topology.viewport,
      stagedOps: [],
      deployJobId: null,
      dirty: false,
      updatedAt: 10,
    }

    const [restored] = deserializeProject({
      ...serializeProject(project),
      createdAt: 1,
      updatedAt: 10,
    }).nodes

    expect(restored.data.errorDetail).toBe(
      "Access was denied by the remote command",
    )
    expect(restored.data.progress).toBeUndefined()
    expect(restored.data.phase).toBeUndefined()
  })
})
