import { useEffect } from "react"

import { flushAllPending, useProjectSyncStore } from "@/lib/projectSync"
import { useProjectsStore } from "@/store/projects"

/**
 * Warns on browser navigate-away/close while any project has unsaved changes —
 * either canvas edits not yet checkpointed (`dirty`) or, in server-persistence
 * mode, checkpoints not yet flushed to the backend (`pendingIds`). The handler
 * also fires a best-effort keepalive flush so a confirmed unload still tries
 * to land the pending writes.
 */
export function useBeforeUnloadWarning() {
  const hasDirty = useProjectsStore((s) => s.projects.some((p) => p.dirty))
  const hasPending = useProjectSyncStore((s) => s.pendingIds.length > 0)
  const shouldWarn = hasDirty || hasPending

  useEffect(() => {
    if (!shouldWarn) return
    const handler = (e: BeforeUnloadEvent) => {
      flushAllPending({ keepalive: true })
      e.preventDefault()
      e.returnValue = ""
    }
    window.addEventListener("beforeunload", handler)
    return () => window.removeEventListener("beforeunload", handler)
  }, [shouldWarn])
}
