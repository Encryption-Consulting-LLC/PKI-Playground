export const LIFECYCLE = {
  draft: "draft", // dropped, not configured/staged
  staged: "staged", // pending createVm op (optimistic)
  deploying: "deploying", // op running in an active plan job
  deployed: "deployed",
  drifted: "drifted", // deployed, config edited since lastDeployedConfig
  failed: "failed",
  // Teardown job in flight (DELETE /api/vm/{name}); deliberately not
  // `deploying` — resumeJobs treats a resumed deploying job's `done` as
  // "deployed", exactly wrong for a teardown.
  destroying: "destroying",
} as const

export type Lifecycle = (typeof LIFECYCLE)[keyof typeof LIFECYCLE]

export const EDGE_TYPE = {
  domainJoin: "domainJoin",
  caHierarchy: "caHierarchy",
  webServerCert: "webServerCert",
  network: "network",
} as const

export type EdgeType = (typeof EDGE_TYPE)[keyof typeof EDGE_TYPE]
