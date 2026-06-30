/**
 * Small inline progress bar for a node being configured: a thin track that fills
 * left-to-right with the percentage shown to its right, vertically centered
 * against the (small) bar via `items-center`.
 */
import { cn } from "@/lib/utils"

export function ProgressBar({ pct }: { pct: number }) {
  const clamped = Math.max(0, Math.min(100, pct))
  return (
    <div className="flex items-center gap-2">
      <div className="flex-1 h-1.5 rounded-full bg-muted overflow-hidden">
        <div
          className={cn("h-full rounded-full bg-primary transition-[width] duration-200")}
          style={{ width: `${clamped}%` }}
        />
      </div>
      <span className="text-[10px] tabular-nums text-muted-foreground w-9 text-right">
        {Math.round(clamped)}%
      </span>
    </div>
  )
}
