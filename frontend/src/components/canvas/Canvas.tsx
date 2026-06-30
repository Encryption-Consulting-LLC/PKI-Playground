import { useCallback, useEffect, useRef, useState } from "react"
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
  type OnMoveEnd,
  type OnNodeDrag,
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
import { EDGE_TYPE } from "@/constants/topology"
import { findOverlappingId, nearestFreePosition } from "@/lib/topology"
import { useResolvedTheme } from "@/hooks/useTheme"

const DRAG_TYPE = "application/reactflow"

const nodeTypes = { machine: MachineNode }

/**
 * Snapshot of a drag in progress. When the dragged node is a domain
 * controller, `members` carries its *committed* members (a `domainJoin` edge
 * targeting it) so they can be dragged along rigidly and reverted together.
 */
interface DragSnapshot {
  id: string
  position: { x: number; y: number }
  members: { id: string; position: { x: number; y: number } }[]
}

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
  const setViewport = useTopologyStore((s) => s.setViewport)
  const setOverlapNode = useTopologyStore((s) => s.setOverlapNode)
  const { screenToFlowPosition, setViewport: rfSetViewport } = useReactFlow()
  const wrapperRef = useRef<HTMLDivElement>(null)
  const resolvedTheme = useResolvedTheme()
  const [initialViewport] = useState(() => useTopologyStore.getState().viewport)

  // The canvas's own pan/zoom is uncontrolled (smooth, no per-frame store
  // writes); we only need to (a) imperatively snap the camera when a project
  // switch loads a different viewport into the store, and (b) capture the
  // final position back into the store once the user stops panning/zooming.
  useEffect(() => {
    return useTopologyStore.subscribe((state, prev) => {
      if (state.viewport !== prev.viewport) {
        rfSetViewport(state.viewport, { duration: 0 })
      }
    })
  }, [rfSetViewport])

  const onMoveEnd: OnMoveEnd = useCallback(
    (_, viewport) => setViewport(viewport),
    [setViewport],
  )

  // Pending domain join/leave awaiting confirmation. We remember where the
  // dragged node (and, if it's a domain controller, its committed members)
  // started so a declined change can snap the whole cluster back — keeping
  // the circle (geometry) and membership in agreement.
  const dragStart = useRef<DragSnapshot | null>(null)
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
      // Only surface a single node to the Inspector; 0 or 2+ selected both
      // collapse to "nothing selected" so the panel hides for multi-select.
      selectNode(selected.length === 1 ? selected[0].id : null)
    },
    [selectNode],
  )

  const onNodeDragStart = useCallback(
    (_: MouseEvent | TouchEvent, node: Node<MachineData>) => {
      // A multi-node selection is carried as a group by React Flow itself;
      // skip the single-node domain-member/overlap orchestration below.
      if (nodes.filter((n) => n.selected).length > 1) {
        dragStart.current = null
        setOverlapNode(null)
        return
      }
      // Dragging a domain controller carries its committed members along
      // rigidly — snapshot their starting positions too.
      const members =
        node.data.typeId === "domainController"
          ? edges
              .filter((e) => e.target === node.id && e.data?.edgeType === EDGE_TYPE.domainJoin)
              .map((e) => nodes.find((n) => n.id === e.source))
              .filter((n): n is Node<MachineData> => !!n)
              .map((n) => ({ id: n.id, position: { ...n.position } }))
          : []
      dragStart.current = { id: node.id, position: { ...node.position }, members }
      setOverlapNode(null)
    },
    [nodes, edges, setOverlapNode],
  )

  // Live drag tick: carry a domain controller's members along with it
  // (preserving their offsets), and flag the dragged node red if it's
  // currently overlapping another node.
  const onNodeDrag: OnNodeDrag<Node<MachineData>> = useCallback(
    (_, node) => {
      if (nodes.filter((n) => n.selected).length > 1) {
        setOverlapNode(null)
        return
      }

      const start = dragStart.current
      const memberIds = start?.members.map((m) => m.id) ?? []

      if (start && start.id === node.id && start.members.length > 0) {
        const delta = {
          x: node.position.x - start.position.x,
          y: node.position.y - start.position.y,
        }
        applyNodeChanges(
          start.members.map((m) => ({
            id: m.id,
            type: "position" as const,
            position: { x: m.position.x + delta.x, y: m.position.y + delta.y },
          })),
        )
      }

      const others = nodes.filter((n) => n.id !== node.id && !memberIds.includes(n.id))
      setOverlapNode(findOverlappingId(node, others) ? node.id : null)
    },
    [nodes, applyNodeChanges, setOverlapNode],
  )

  // When a node is dropped: if it lands on top of another, relocate it (and
  // its cluster, if any) to the nearest clear spot. Then see whether the move
  // changes domain membership — if so, defer to a confirmation prompt rather
  // than applying immediately.
  const onNodeDragStop = useCallback(
    (_: MouseEvent | TouchEvent, node: Node<MachineData>) => {
      if (nodes.filter((n) => n.selected).length > 1) {
        setOverlapNode(null)
        return
      }

      const start = dragStart.current
      const memberIds = start?.members.map((m) => m.id) ?? []
      const others = nodes.filter((n) => n.id !== node.id && !memberIds.includes(n.id))

      if (findOverlappingId(node, others)) {
        const freePosition = nearestFreePosition(node, others, node.position)
        const delta = {
          x: freePosition.x - node.position.x,
          y: freePosition.y - node.position.y,
        }
        const corrections: NodeChange<Node<MachineData>>[] = [
          { id: node.id, type: "position", position: freePosition },
        ]
        for (const id of memberIds) {
          const member = nodes.find((n) => n.id === id)
          if (!member) continue
          corrections.push({
            id,
            type: "position",
            position: { x: member.position.x + delta.x, y: member.position.y + delta.y },
          })
        }
        applyNodeChanges(corrections)
      }
      setOverlapNode(null)

      const changes = computeDomainChanges(node.id)
      if (changes.length === 0) {
        dragStart.current = null
        return
      }
      setPendingChanges(changes)
    },
    [nodes, applyNodeChanges, computeDomainChanges, setOverlapNode],
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
    // Snap the dragged node (and any members carried along with it) back so
    // nothing sits in a region it didn't join.
    const start = dragStart.current
    if (start) {
      applyNodeChanges([
        { id: start.id, type: "position", position: start.position },
        ...start.members.map((m) => ({
          id: m.id,
          type: "position" as const,
          position: m.position,
        })),
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
        onNodeDrag={onNodeDrag}
        onNodeDragStop={onNodeDragStop}
        onDragOver={onDragOver}
        onDrop={onDrop}
        onMoveEnd={onMoveEnd}
        multiSelectionKeyCode="Shift"
        selectionKeyCode="Shift"
        defaultViewport={initialViewport}
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
