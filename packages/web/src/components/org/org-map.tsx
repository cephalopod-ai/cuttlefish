import "@xyflow/react/dist/style.css"
import {
  ReactFlow,
  Controls,
  useNodesState,
  useEdgesState,
  type Node,
  ConnectionLineType,
} from "@xyflow/react"
import { useCallback, useEffect } from "react"
import type { Employee, OrgHierarchy } from "@/lib/api"
import { nodeTypes } from "@/components/org/employee-node"
import { computeOrgLayout } from "@/components/org/layout/use-layouted-elements"

interface OrgMapProps {
  employees: Employee[]
  hierarchy?: OrgHierarchy
  selectedName: string | null
  onNodeClick: (employee: Employee) => void
}

export function OrgMap({ employees, hierarchy, selectedName, onNodeClick }: OrgMapProps) {
  const buildLayout = useCallback(
    () => computeOrgLayout(employees, hierarchy, selectedName),
    [employees, hierarchy, selectedName],
  )

  const { nodes: initialNodes, edges: initialEdges } = buildLayout()
  const [nodes, setNodes, onNodesChange] = useNodesState(initialNodes)
  const [edges, setEdges, onEdgesChange] = useEdgesState(initialEdges)

  useEffect(() => {
    const { nodes: n, edges: e } = buildLayout()
    setNodes(n)
    setEdges(e)
  }, [buildLayout, setNodes, setEdges])

  const handleNodeClick = useCallback(
    (_: React.MouseEvent, node: Node) => {
      const employee = employees.find((e) => e.name === node.id)
      if (employee) onNodeClick(employee)
    },
    [employees, onNodeClick],
  )

  return (
    <ReactFlow
      nodes={nodes}
      edges={edges}
      onNodesChange={onNodesChange}
      onEdgesChange={onEdgesChange}
      onNodeClick={handleNodeClick}
      nodeTypes={nodeTypes}
      connectionLineType={ConnectionLineType.SmoothStep}
      fitView
      fitViewOptions={{ padding: 0.22, duration: 400 }}
      minZoom={0.2}
      maxZoom={2}
      proOptions={{ hideAttribution: true }}
    >
      {/* Low-noise chrome: fit + zoom only, no lock/interactive toggle. */}
      <Controls
        position="bottom-left"
        showInteractive={false}
        style={{ left: 16, bottom: 16 }}
      />
    </ReactFlow>
  )
}
