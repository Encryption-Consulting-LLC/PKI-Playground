import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest"

import { STORAGE_KEYS } from "@/constants"
import type { Project } from "@/store/projects"

const storage = new Map<string, string>()

vi.stubGlobal("localStorage", {
  getItem: (key: string) => storage.get(key) ?? null,
  setItem: (key: string, value: string) => storage.set(key, value),
  removeItem: (key: string) => storage.delete(key),
})
vi.stubGlobal("window", {
  addEventListener: vi.fn(),
  removeEventListener: vi.fn(),
})

let initLocalProjects: typeof import("@/lib/projectSync")["initLocalProjects"]
let initServerProjects: typeof import("@/lib/projectSync")["initServerProjects"]
let stopServerProjects: typeof import("@/lib/projectSync")["stopServerProjects"]
let useProjectsStore: typeof import("@/store/projects")["useProjectsStore"]

function project(id: string, name: string): Project {
  return {
    id,
    name,
    nodes: [],
    edges: [],
    counters: {},
    viewport: { x: 0, y: 0, zoom: 1 },
    stagedOps: [],
    deployJobId: null,
    dirty: false,
    updatedAt: 1,
  }
}

beforeAll(async () => {
  ;({ initLocalProjects, initServerProjects, stopServerProjects } =
    await import("@/lib/projectSync"))
  ;({ useProjectsStore } = await import("@/store/projects"))
})

beforeEach(() => {
  storage.clear()
  useProjectsStore.setState({
    projects: [],
    activeProjectId: null,
    nextProjectNumber: 1,
  })
  storage.clear()
})

describe("local project session initialization", () => {
  it("does not expose the previous operator's in-memory projects to a guest", async () => {
    useProjectsStore.setState({
      projects: [project("operator-project", "Operator project")],
      activeProjectId: "operator-project",
      nextProjectNumber: 2,
    })
    storage.delete(STORAGE_KEYS.projects)

    await initLocalProjects()

    expect(useProjectsStore.getState().projects).toEqual([])
    expect(useProjectsStore.getState().activeProjectId).toBeNull()
  })

  it("replaces operator state with the saved guest project set", async () => {
    useProjectsStore.setState({
      projects: [project("operator-project", "Operator project")],
      activeProjectId: "operator-project",
      nextProjectNumber: 2,
    })
    storage.set(STORAGE_KEYS.projects, JSON.stringify({
      state: {
        projects: [project("guest-project", "Guest project")],
        activeProjectId: "guest-project",
        nextProjectNumber: 7,
      },
      version: 1,
    }))

    await initLocalProjects()

    expect(useProjectsStore.getState().projects.map((p) => p.id)).toEqual(["guest-project"])
    expect(useProjectsStore.getState().activeProjectId).toBe("guest-project")
    expect(useProjectsStore.getState().nextProjectNumber).toBe(7)
  })

  it("does not retry a permanent project-write 403", async () => {
    vi.useFakeTimers()
    const serverProject = project("server-project", "Server project")
    const fetchMock = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      const url = String(input)
      if (init?.method === "PUT") {
        return new Response(JSON.stringify({ detail: "Missing project:write." }), {
          status: 403,
          headers: { "content-type": "application/json" },
        })
      }
      if (url.endsWith("/api/projects")) {
        return Response.json({
          projects: [{
            id: serverProject.id,
            name: serverProject.name,
            createdAt: 1,
            updatedAt: 1,
          }],
          count: 1,
        })
      }
      return Response.json({
        ...serverProject,
        createdAt: 1,
        updatedAt: 1,
      })
    })
    vi.stubGlobal("fetch", fetchMock)

    await initServerProjects()
    useProjectsStore.getState().renameProject(serverProject.id, "First edit")
    await vi.advanceTimersByTimeAsync(1_500)
    expect(fetchMock.mock.calls.filter(([, init]) => init?.method === "PUT")).toHaveLength(1)

    useProjectsStore.getState().renameProject(serverProject.id, "Second edit")
    await vi.advanceTimersByTimeAsync(10_000)
    expect(fetchMock.mock.calls.filter(([, init]) => init?.method === "PUT")).toHaveLength(1)

    stopServerProjects()
    vi.useRealTimers()
  })
})
