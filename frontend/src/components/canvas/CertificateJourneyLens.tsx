import { useState } from "react"
import {
  ArrowRight,
  CheckCircle2,
  CircleDashed,
  FileCheck2,
  Route,
  XCircle,
} from "lucide-react"

import { Button } from "@/components/ui/button"
import type { CertificateJourneyProjection } from "@/lib/certificateJourney"
import { cn } from "@/lib/utils"

export function CertificateJourneyToggle({
  active,
  available,
  onToggle,
}: {
  active: boolean
  available: boolean
  onToggle: () => void
}) {
  return (
    <Button
      type="button"
      size="sm"
      variant={active ? "default" : "outline"}
      disabled={!available}
      aria-pressed={active}
      title={
        available
          ? "Show the sample certificate path"
          : "Connect an issuing CA to a web host first"
      }
      onClick={onToggle}
      className="h-8 gap-2 bg-background/95 text-[10px] data-[active=true]:bg-primary"
      data-active={active}
    >
      <Route className="h-3.5 w-3.5" />
      Certificate journey
    </Button>
  )
}

export function CertificateJourneyLens({
  projection,
}: {
  projection: CertificateJourneyProjection
}) {
  const [selectedId, setSelectedId] = useState(projection.journey.hops[0]?.id)
  const selected =
    projection.journey.hops.find((hop) => hop.id === selectedId) ??
    projection.journey.hops[0]
  const verifiedLabel =
    projection.live && projection.journey.lastVerifiedAt
      ? new Date(projection.journey.lastVerifiedAt).toLocaleString()
      : "Not verified yet"

  return (
    <div className="w-[min(1040px,calc(100vw-20rem))] overflow-hidden rounded-2xl border bg-background/97 shadow-2xl backdrop-blur">
      <div className="flex items-center justify-between gap-4 border-b px-4 py-2.5 text-[10px]">
        <span className="flex items-center gap-2 font-semibold uppercase tracking-wider">
          <FileCheck2 className="h-3.5 w-3.5 text-violet-500" />
          Sample certificate path
        </span>
        <span className="text-muted-foreground">
          {projection.live ? "Live evidence" : "Planned journey"} ·{" "}
          {verifiedLabel} · {projection.journey.signatureAlgorithm}
        </span>
      </div>
      <div className="flex items-stretch overflow-x-auto p-3">
        {projection.journey.hops.map((hop, index) => (
          <div key={hop.id} className="flex min-w-0 flex-1 items-center">
            <button
              type="button"
              onClick={() => setSelectedId(hop.id)}
              aria-pressed={selected?.id === hop.id}
              className={cn(
                "min-w-36 flex-1 rounded-xl border p-2.5 text-left transition-colors hover:bg-accent focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring",
                selected?.id === hop.id &&
                  "border-violet-500/60 bg-violet-500/5",
                projection.live && hop.ok && "border-emerald-500/40",
                projection.live && !hop.ok && "border-red-500/40",
              )}
            >
              <span className="flex items-center gap-1.5 text-[11px] font-semibold">
                {projection.live ? (
                  hop.ok ? (
                    <CheckCircle2 className="h-3.5 w-3.5 text-emerald-500" />
                  ) : (
                    <XCircle className="h-3.5 w-3.5 text-red-500" />
                  )
                ) : (
                  <CircleDashed className="h-3.5 w-3.5 text-violet-500" />
                )}
                <span className="truncate">{hop.label}</span>
              </span>
              <span className="mt-1 block truncate font-mono text-[9px] text-muted-foreground">
                {hop.url}
              </span>
            </button>
            {index < projection.journey.hops.length - 1 && (
              <ArrowRight className="mx-1 h-3.5 w-3.5 shrink-0 text-violet-500" />
            )}
          </div>
        ))}
      </div>
      {selected && (
        <dl className="grid grid-cols-[80px_minmax(0,1fr)_70px_minmax(0,1fr)] gap-x-2 gap-y-1 border-t bg-muted/30 px-4 py-2.5 text-[10px]">
          <dt className="font-semibold text-muted-foreground">Endpoint</dt>
          <dd className="truncate font-mono" title={selected.url}>
            {selected.url}
          </dd>
          <dt className="font-semibold text-muted-foreground">DNS</dt>
          <dd className="truncate font-mono">
            {selected.dns.hostname} → {selected.dns.address ?? "pending"}
          </dd>
          <dt className="font-semibold text-muted-foreground">Artifacts</dt>
          <dd className="truncate" title={selected.artifacts.join(", ")}>
            {selected.artifacts.join(" · ")}
          </dd>
          <dt className="font-semibold text-muted-foreground">Result</dt>
          <dd
            className={cn(
              "truncate",
              projection.live && selected.ok
                ? "text-emerald-500"
                : projection.live
                  ? "text-red-500"
                  : "text-muted-foreground",
            )}
          >
            {selected.failureReason ?? "Verified"}
          </dd>
        </dl>
      )}
    </div>
  )
}
