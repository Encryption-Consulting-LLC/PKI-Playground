import { ReactFlowProvider } from "@xyflow/react"
import { Canvas } from "./Canvas"
import { Inspector } from "./Inspector"
import { Toolbox } from "./Toolbox"

/**
 * Full-height authenticated workspace: Toolbox | Canvas | Inspector
 * Rendered by App.tsx in the authenticated shell; auth gating is upstream.
 */
export function Workspace() {
  return (
    <ReactFlowProvider>
      <div className="flex flex-1 overflow-hidden">
        <Toolbox />
        <Canvas />
        <Inspector />
      </div>
    </ReactFlowProvider>
  )
}
