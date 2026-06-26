import { Handle, Position, type NodeProps } from "@xyflow/react"
import type { Employee } from "@/lib/api"
import { EmployeeAvatar } from "@/components/ui/employee-avatar"
import { deptHue } from "@/components/org/layout/dept-color"

type EmployeeNodeData = Employee & Record<string, unknown>

function roleLabel(emp: EmployeeNodeData): string {
  if (emp.rank === "executive") return "COO"
  return emp.rank.charAt(0).toUpperCase() + emp.rank.slice(1)
}

export function EmployeeNode({ data, selected }: NodeProps) {
  const employee = data as EmployeeNodeData
  const isExec = employee.rank === "executive"

  return (
    <div
      className="group hover-lift relative w-[200px] h-[64px] flex items-center gap-[var(--space-2)] px-[var(--space-3)] rounded-[var(--radius-md)] bg-[var(--material-regular)] backdrop-blur-[20px] backdrop-saturate-[180%] [-webkit-backdrop-filter:blur(20px)_saturate(180%)] cursor-pointer overflow-hidden"
      style={{
        border: `1px solid ${selected ? "var(--accent)" : isExec ? "color-mix(in srgb, var(--accent) 45%, var(--separator))" : "var(--separator)"}`,
        boxShadow: selected
          ? "0 0 0 1px var(--accent), var(--shadow-card)"
          : isExec
            ? "var(--inset-shine), var(--shadow-card)"
            : "var(--shadow-subtle)",
      }}
    >
      {/* COO accent stripe — the only chromatic emphasis on a node */}
      {isExec && (
        <span
          aria-hidden
          className="absolute left-0 top-0 bottom-0 w-[2px] bg-[var(--accent)]"
        />
      )}

      <EmployeeAvatar name={employee.name} avatar={employee.avatar as string | undefined} size={isExec ? 28 : 22} />

      <div className="flex-1 min-w-0">
        <div
          className={`${isExec ? "text-[length:var(--text-body)] font-[var(--weight-bold)] tracking-[var(--tracking-tight)]" : "text-[length:var(--text-subheadline)] font-[var(--weight-semibold)]"} text-[var(--text-primary)] whitespace-nowrap overflow-hidden text-ellipsis leading-[var(--leading-tight)]`}
        >
          {employee.displayName || employee.name}
        </div>
        <div className="text-[length:var(--text-caption1)] text-[var(--text-tertiary)] whitespace-nowrap overflow-hidden text-ellipsis">
          {roleLabel(employee)}
        </div>
      </div>

      {/* Engine always; model revealed on hover/selected to keep nodes quiet */}
      <div className="flex flex-col items-end gap-[2px] shrink-0">
        <span className="text-[length:var(--text-caption2)] font-[var(--weight-semibold)] text-[var(--accent)] bg-[var(--accent-fill)] py-px px-[7px] rounded-[10px]">
          {employee.engine}
        </span>
        {employee.model && (
          <span
            className={`text-[length:var(--text-caption2)] text-[var(--text-tertiary)] bg-[var(--fill-quaternary)] py-px px-[7px] rounded-[10px] transition-opacity duration-150 ${selected ? "opacity-100" : "opacity-0 group-hover:opacity-100"}`}
          >
            {employee.model}
          </span>
        )}
      </div>

      <Handle type="target" position={Position.Top} style={{ opacity: 0 }} />
      <Handle type="source" position={Position.Bottom} style={{ opacity: 0 }} />
    </div>
  )
}

export function DepartmentGroupNode({ data }: NodeProps) {
  const { label } = data as { label: string } & Record<string, unknown>
  const hue = deptHue(label)
  return (
    <div
      className="w-full h-full relative rounded-[var(--radius-lg)] bg-[var(--fill-quaternary)] overflow-hidden"
      style={{ border: "1px solid var(--separator)", ["--dept-h" as string]: String(hue) }}
    >
      {/* Subtle per-department hue: left stripe only (amber stays for selection) */}
      <span
        aria-hidden
        className="org-dept-accent absolute left-0 top-0 bottom-0 w-[3px] opacity-70"
      />
      <div className="absolute top-[10px] left-0 right-0 flex items-center justify-center gap-[6px] select-none pointer-events-none">
        <span className="org-dept-accent w-[6px] h-[6px] rounded-full" />
        <span className="text-[length:var(--text-caption2)] font-[var(--weight-semibold)] tracking-[var(--tracking-wide)] uppercase text-[var(--text-tertiary)]">
          {label}
        </span>
      </div>
    </div>
  )
}

export const nodeTypes = {
  employeeNode: EmployeeNode,
  departmentGroup: DepartmentGroupNode,
}
