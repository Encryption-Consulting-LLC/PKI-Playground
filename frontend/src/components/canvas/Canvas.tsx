import { useCallback, useRef } from "react"
import {
  ReactFlow,
  Background,
  Controls,
  MiniMap,
  type NodeChange,
  type EdgeChange,
  type Connection,
  type OnConnect,
  type OnSelectionChangeParams,
  useReactFlow,
} from "@xyflow/react"
import { toast } from "sonner"
import type { Node } from "@xyflow/react"
import { MachineNode } from "./nodes/MachineNode"
import { useTopologyStore, type MachineData } from "@/store/topology"
import { useResolvedTheme } from "@/hooks/useTheme"

const DRAG_TYPE = "application/reactflow"

const nodeTypes = { machine: MachineNode }

export function Canvas() {
  const nodes = useTopologyStore((s) => s.nodes)
  const edges = useTopologyStore((s) => s.edges)
  // Select individual action refs (stable across renders) rather than the
  // whole store, so the callbacks below aren't recreated on every state
  // change — recreating onSelectionChange feeds a React Flow update loop.
  const applyNodeChanges = useTopologyStore((s) => s.applyNodeChanges)
  const applyEdgeChanges = useTopologyStore((s) => s.applyEdgeChanges)
  const connect = useTopologyStore((s) => s.connect)
  const selectNode = useTopologyStore((s) => s.selectNode)
  const addNode = useTopologyStore((s) => s.addNode)
  const { screenToFlowPosition } = useReactFlow()
  const wrapperRef = useRef<HTMLDivElement>(null)
  const resolvedTheme = useResolvedTheme()

  const onNodesChange = useCallback(
    (changes: NodeChange<Node<MachineData>>[]) => applyNodeChanges(changes),
    [applyNodeChanges],
  )

  const onEdgesChange = useCallback(
    (changes: EdgeChange[]) => applyEdgeChanges(changes),
    [applyEdgeChanges],
  )

  const onConnect: OnConnect = useCallback(
    (connection: Connection) => {
      const error = connect(connection)
      if (error) toast.error(error)
    },
    [connect],
  )

  const onSelectionChange = useCallback(
    ({ nodes: selected }: OnSelectionChangeParams) => {
      selectNode(selected[0]?.id ?? null)
    },
    [selectNode],
  )

  const onDragOver = useCallback((e: React.DragEvent) => {
    e.preventDefault()
    e.dataTransfer.dropEffect = "copy"
  }, [])

  const onDrop = useCallback(
    (e: React.DragEvent) => {
      e.preventDefault()
      const typeId = e.dataTransfer.getData(DRAG_TYPE)
      if (!typeId) return

      const position = screenToFlowPosition({
        x: e.clientX,
        y: e.clientY,
      })
      addNode(typeId, position)
    },
    [screenToFlowPosition, addNode],
  )

  return (
    <div ref={wrapperRef} className="flex-1 h-full">
      <ReactFlow
        nodes={nodes}
        edges={edges}
        nodeTypes={nodeTypes}
        onNodesChange={onNodesChange}
        onEdgesChange={onEdgesChange}
        onConnect={onConnect}
        onSelectionChange={onSelectionChange}
        onDragOver={onDragOver}
        onDrop={onDrop}
        colorMode={resolvedTheme}
        proOptions={{ hideAttribution: true }}
      >
        <Background gap={16} size={1} />
        <Controls />
        <MiniMap zoomable pannable nodeColor={miniMapColor} />
      </ReactFlow>
    </div>
  )
}

function miniMapColor(node: Node<MachineData>): string {
  const typeId = (node.data as MachineData).typeId
  switch (typeId) {
    case "domainController": return "#3b82f6"
    case "certificateAuthority": return "#f59e0b"
    case "webServer": return "#10b981"
    case "client": return "#a78bfa"
    case "standalone": return "#94a3b8"
    default: return "#94a3b8"
  }
}
