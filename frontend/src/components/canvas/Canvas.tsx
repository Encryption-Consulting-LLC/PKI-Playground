import { useCallback, useRef, useState } from "react"
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
import { DomainRegions } from "./DomainRegions"
import { DomainConfirmDialog } from "./DomainConfirmDialog"
import {
  useTopologyStore,
  type MachineData,
  type DomainSyncChange,
} from "@/store/topology"
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
  const computeDomainChanges = useTopologyStore((s) => s.computeDomainChanges)
  const applyDomainChanges = useTopologyStore((s) => s.applyDomainChanges)
  const selectNode = useTopologyStore((s) => s.selectNode)
  const addNode = useTopologyStore((s) => s.addNode)
  const { screenToFlowPosition } = useReactFlow()
  const wrapperRef = useRef<HTMLDivElement>(null)
  const resolvedTheme = useResolvedTheme()

  // Pending domain join/leave awaiting confirmation. We remember where the
  // dragged node started so a declined change can snap it back — keeping the
  // circle (geometry) and membership in agreement.
  const dragStart = useRef<{ id: string; position: { x: number; y: number } } | null>(null)
  const [pendingChanges, setPendingChanges] = useState<DomainSyncChange[] | null>(null)

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

  const onNodeDragStart = useCallback(
    (_: MouseEvent | TouchEvent, node: Node<MachineData>) => {
      dragStart.current = { id: node.id, position: { ...node.position } }
    },
    [],
  )

  // When a node is dropped, see whether the move changes domain membership. If
  // so, defer it to a confirmation prompt rather than applying immediately.
  const onNodeDragStop = useCallback(
    (_: MouseEvent | TouchEvent, node: Node<MachineData>) => {
      const changes = computeDomainChanges(node.id)
      if (changes.length === 0) {
        dragStart.current = null
        return
      }
      setPendingChanges(changes)
    },
    [computeDomainChanges],
  )

  const confirmDomainChanges = useCallback(() => {
    if (!pendingChanges) return
    applyDomainChanges(pendingChanges)
    for (const c of pendingChanges) {
      if (c.domainName) toast.success(`${c.nodeName} joined ${c.domainName}`)
      else toast(`${c.nodeName} left its domain`)
    }
    dragStart.current = null
    setPendingChanges(null)
  }, [pendingChanges, applyDomainChanges])

  const cancelDomainChanges = useCallback(() => {
    // Snap the dragged node back so it no longer sits in a region it didn't join.
    const start = dragStart.current
    if (start) {
      applyNodeChanges([
        { id: start.id, type: "position", position: start.position },
      ])
    }
    dragStart.current = null
    setPendingChanges(null)
  }, [applyNodeChanges])

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
        onNodeDragStart={onNodeDragStart}
        onNodeDragStop={onNodeDragStop}
        onDragOver={onDragOver}
        onDrop={onDrop}
        colorMode={resolvedTheme}
        proOptions={{ hideAttribution: true }}
      >
        <DomainRegions />
        <Background gap={16} size={1} />
        <Controls />
        <MiniMap zoomable pannable nodeColor={miniMapColor} />
      </ReactFlow>
      <DomainConfirmDialog
        changes={pendingChanges}
        onConfirm={confirmDomainChanges}
        onCancel={cancelDomainChanges}
      />
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
