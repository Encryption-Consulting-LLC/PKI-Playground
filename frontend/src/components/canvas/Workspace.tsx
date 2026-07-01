import { useEffect } from "react"
import { ReactFlowProvider } from "@xyflow/react"
import { Canvas } from "./Canvas"
import { Inspector } from "./Inspector"
import { ProjectTabBar } from "./ProjectTabBar"
import { Toolbox } from "./Toolbox"
import { useStagingStore } from "@/store/staging"

/**
 * Full-height authenticated workspace: Toolbox | (tab bar above Canvas | Inspector)
 * The toolbox is shared across all projects, so the project tab bar starts
 * after it rather than spanning the full width.
 * Rendered by App.tsx in the authenticated shell; auth gating is upstream.
 */
export function Workspace() {
  // Ctrl/Cmd+Z pops the last staged op — mirrors the Staged panel's Undo
  // button. Ignored while typing (rename field, config form, ...) so it
  // doesn't fight normal text-input undo.
  useEffect(() => {
    function onKeyDown(e: KeyboardEvent) {
      if (e.key.toLowerCase() !== "z" || !(e.ctrlKey || e.metaKey) || e.shiftKey) return
      const target = e.target as HTMLElement | null
      if (
        target &&
        (target.tagName === "INPUT" ||
          target.tagName === "TEXTAREA" ||
          target.isContentEditable)
      ) {
        return
      }
      const { ops, deploying, undo } = useStagingStore.getState()
      if (deploying || ops.length === 0) return
      e.preventDefault()
      undo()
    }
    window.addEventListener("keydown", onKeyDown)
    return () => window.removeEventListener("keydown", onKeyDown)
  }, [])

  return (
    <ReactFlowProvider>
      <div className="flex flex-1 overflow-hidden">
        <Toolbox />
        <div className="flex flex-1 flex-col overflow-hidden">
          <ProjectTabBar />
          <div className="flex flex-1 overflow-hidden">
            <Canvas />
            <Inspector />
          </div>
        </div>
      </div>
    </ReactFlowProvider>
  )
}
