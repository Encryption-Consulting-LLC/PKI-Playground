/** Frontend mirror of the backend's six-character project-name segment. */
export function projectCode(projectId: string | null): string {
  return (projectId ?? "")
    .toLowerCase()
    .replace(/[^a-z0-9]/g, "")
    .slice(0, 6)
}

/** Immutable per-project prefix used by a DC's AD NetBIOS domain name. */
export function projectNetbiosPrefix(projectId: string | null): string {
  const code = projectCode(projectId)
  return code ? `${code}-` : ""
}
