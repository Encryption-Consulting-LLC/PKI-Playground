import { TEMPLATE_CATALOG } from "@/constants/templates"
import { cn } from "@/lib/utils"

const DRAG_TYPE = "application/reactflow"

export function Toolbox() {
  return (
    <aside className="flex w-48 shrink-0 flex-col gap-1 border-r bg-sidebar p-3 overflow-y-auto">
      <p className="mb-2 px-1 text-[11px] font-semibold uppercase tracking-wider text-muted-foreground">
        Templates
      </p>

      <div className="grid grid-cols-2 gap-2">
        {TEMPLATE_CATALOG.map((def) => {
          const Icon = def.icon
          return (
            <div
              key={def.id}
              draggable
              onDragStart={(e) => {
                e.dataTransfer.setData(DRAG_TYPE, def.id)
                e.dataTransfer.effectAllowed = "copy"
              }}
              className={cn(
                "flex cursor-grab flex-col items-center justify-center gap-2",
                "rounded-lg border bg-card px-2 py-3",
                "shadow-sm transition-colors select-none",
                "hover:bg-accent hover:text-accent-foreground active:cursor-grabbing",
              )}
            >
              <Icon className={cn("h-6 w-6 shrink-0", def.accent)} />
              <span className="text-center text-[11px] font-semibold leading-tight">
                {def.label}
              </span>
            </div>
          )
        })}
      </div>

      <p className="mt-3 px-1 text-[10px] text-muted-foreground leading-snug">
        Drag a template onto the canvas to add it.
      </p>
    </aside>
  )
}
