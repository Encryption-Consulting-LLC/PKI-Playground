import { useEffect, useState } from "react"
import {
  AlertTriangle,
  CheckCircle2,
  ChevronRight,
  XCircle,
} from "lucide-react"

import type { DeployPreflightReceipt } from "@/lib/api"
import { useStagingStore } from "@/store/staging"

//: How long a passed receipt stays expanded before collapsing to its chip.
const AUTO_COLLAPSE_MS = 6000

/**
 * The deploy preflight receipt — what the route verified against the live
 * ESXi host before accepting the plan (or the report that made it refuse).
 * A passed receipt opens expanded and collapses to a one-line chip after a
 * few seconds; a failed one stays open. Both toggle on click.
 */
export function PreflightReceipt() {
  const receipt = useStagingStore((s) => s.preflightReceipt)
  if (!receipt) return null
  // Keying on the report identity resets the collapse state per attempt.
  return <ReceiptCard key={receipt.checkedAt ?? 0} receipt={receipt} />
}

function ReceiptCard({ receipt }: { receipt: DeployPreflightReceipt }) {
  const [collapsed, setCollapsed] = useState(false)

  useEffect(() => {
    if (!receipt.ready) return
    const timer = setTimeout(() => setCollapsed(true), AUTO_COLLAPSE_MS)
    return () => clearTimeout(timer)
  }, [receipt.ready])

  // Failures surface first so a long passed list never buries the reason.
  const checks = [...receipt.checks].sort((a, b) => Number(a.ok) - Number(b.ok))
  const failedCount = checks.filter((check) => !check.ok).length

  return (
    <div className="border-t px-2 py-1.5 text-[10px]">
      <button
        type="button"
        className="flex w-full items-center gap-1.5 rounded-sm text-left focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
        aria-expanded={!collapsed}
        onClick={() => setCollapsed((current) => !current)}
      >
        {receipt.ready ? (
          <CheckCircle2 className="h-3 w-3 shrink-0 text-emerald-500" />
        ) : (
          <AlertTriangle className="h-3 w-3 shrink-0 text-red-500" />
        )}
        <span className="font-medium">
          {receipt.ready ? "Preflight passed" : "Preflight failed"}
        </span>
        <span className="text-muted-foreground">
          {receipt.ready
            ? `· ${checks.length} check${checks.length === 1 ? "" : "s"}`
            : `· ${failedCount} of ${checks.length} checks`}
        </span>
        <ChevronRight
          className={`ml-auto h-3 w-3 shrink-0 text-muted-foreground transition-transform ${collapsed ? "" : "rotate-90"}`}
        />
      </button>
      {!collapsed && (
        <ul className="mt-1 max-h-32 space-y-0.5 overflow-y-auto pl-0.5">
          {checks.map((check, i) => (
            <li
              key={`${check.key}-${check.role ?? ""}-${check.datastore ?? ""}-${i}`}
              className="flex items-start gap-1.5"
            >
              {check.ok ? (
                <CheckCircle2 className="mt-px h-2.5 w-2.5 shrink-0 text-emerald-500/70" />
              ) : (
                <XCircle className="mt-px h-2.5 w-2.5 shrink-0 text-red-500" />
              )}
              <span
                className={`min-w-0 break-words leading-snug ${check.ok ? "text-muted-foreground" : ""}`}
              >
                {check.detail}
              </span>
            </li>
          ))}
        </ul>
      )}
    </div>
  )
}
