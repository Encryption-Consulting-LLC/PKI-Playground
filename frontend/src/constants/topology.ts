export const NODE_STATUS = {
  unconfigured: "unconfigured",
  configuring: "configuring",
  configured: "configured",
  error: "error",
} as const

export type NodeStatus = (typeof NODE_STATUS)[keyof typeof NODE_STATUS]

export const EDGE_TYPE = {
  domainJoin: "domainJoin",
  caHierarchy: "caHierarchy",
  network: "network",
} as const

export type EdgeType = (typeof EDGE_TYPE)[keyof typeof EDGE_TYPE]
