import { useState } from "react"

import { TEMPLATE_CATALOG } from "@/constants/templates"
import { cn } from "@/lib/utils"
import { useStagingStore } from "@/store/staging"
import { StagedPanel } from "./StagedPanel"

const DRAG_TYPE = "application/reactflow"

type Tab = "templates" | "staged"

export function Toolbox() {
  const [tab, setTab] = useState<Tab>("templates")
  const opsCount = useStagingStore((s) => s.ops.length)
  const deploying = useStagingStore((s) => s.deploying)

  return (
    <aside
      className={cn(
        "flex shrink-0 flex-col overflow-hidden border-r bg-sidebar transition-[width] duration-200 ease-in-out",
        tab === "staged" ? "w-72" : "w-48",
      )}
    >
      <div className="flex shrink-0 border-b text-[11px] font-semibold uppercase tracking-wider">
        <button
          onClick={() => setTab("templates")}
          className={cn(
            "flex-1 border-b-2 px-2 py-2 transition-colors",
            tab === "templates"
              ? "border-primary text-foreground"
              : "border-transparent text-muted-foreground hover:text-foreground",
          )}
        >
          Templates
        </button>
        <button
          onClick={() => setTab("staged")}
          className={cn(
            "flex-1 border-b-2 px-2 py-2 transition-colors",
            tab === "staged"
              ? "border-primary text-foreground"
              : "border-transparent text-muted-foreground hover:text-foreground",
          )}
        >
          Staged{opsCount > 0 ? ` (${opsCount})` : ""}
        </button>
      </div>

      {tab === "templates" ? (
        <div className="flex flex-1 flex-col gap-1 overflow-y-auto p-3">
          <div className="grid grid-cols-2 gap-2">
            {TEMPLATE_CATALOG.map((def) => {
              const Icon = def.icon
              return (
                <div
                  key={def.id}
                  draggable={!deploying}
                  onDragStart={(e) => {
                    e.dataTransfer.setData(DRAG_TYPE, def.id)
                    e.dataTransfer.effectAllowed = "copy"
                  }}
                  className={cn(
                    "flex flex-col items-center justify-center gap-2",
                    "rounded-lg border bg-card px-2 py-3",
                    "shadow-sm transition-colors select-none",
                    deploying
                      ? "cursor-not-allowed opacity-50"
                      : "cursor-grab hover:bg-accent hover:text-accent-foreground active:cursor-grabbing",
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
        </div>
      ) : (
        <StagedPanel />
      )}
    </aside>
  )
}
