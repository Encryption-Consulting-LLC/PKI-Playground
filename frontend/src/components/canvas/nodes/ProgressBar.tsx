/**
 * Small inline progress bar for a node being configured: a thin track that fills
 * left-to-right with the percentage shown to its right, vertically centered
 * against the (small) bar via `items-center`.
 */
import { cn } from "@/lib/utils"

export function ProgressBar({ pct }: { pct: number }) {
  const clamped = Math.max(0, Math.min(100, pct))
  return (
    <div className="flex w-full min-w-0 items-center gap-2 overflow-hidden">
      <div className="h-1.5 min-w-0 flex-1 overflow-hidden rounded-full bg-muted">
        <div
          className={cn("h-full rounded-full bg-primary transition-[width] duration-200")}
          style={{ width: `${clamped}%` }}
        />
      </div>
      <span className="w-9 shrink-0 text-right text-[10px] tabular-nums text-muted-foreground">
        {Math.round(clamped)}%
      </span>
    </div>
  )
}
