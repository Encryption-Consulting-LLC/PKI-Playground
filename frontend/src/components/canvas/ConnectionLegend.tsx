import { CONNECTION_HEALTH, CONNECTION_PORT } from "@/constants/topology"
import {
  CONNECTION_HEALTH_GUIDANCE,
  CONNECTION_PORT_GUIDANCE,
} from "@/lib/topology"
import { cn } from "@/lib/utils"

const PORTS = [
  { port: CONNECTION_PORT.caParent, color: "bg-amber-500" },
  { port: CONNECTION_PORT.caPublication, color: "bg-emerald-500" },
  { port: CONNECTION_PORT.domainBoundary, color: "bg-sky-500" },
  { port: CONNECTION_PORT.webHost, color: "bg-violet-500" },
  { port: CONNECTION_PORT.probeCertificate, color: "bg-slate-200" },
]

const HEALTH = [
  { health: CONNECTION_HEALTH.planned, color: "bg-sky-500" },
  { health: CONNECTION_HEALTH.applying, color: "bg-violet-500" },
  { health: CONNECTION_HEALTH.verified, color: "bg-emerald-500" },
  { health: CONNECTION_HEALTH.degraded, color: "bg-amber-500" },
  { health: CONNECTION_HEALTH.broken, color: "bg-red-500" },
]

export function ConnectionLegend() {
  return (
    <details className="w-72 rounded-lg border bg-background/95 text-[10px] shadow-sm">
      <summary className="cursor-pointer select-none px-3 py-2 font-semibold">
        Connection capabilities
      </summary>
      <div className="space-y-2 border-t px-3 py-2">
        {PORTS.map(({ port, color }) => {
          const guidance = CONNECTION_PORT_GUIDANCE[port]
          return (
            <div key={port} className="flex items-start gap-2">
              <span className={cn("mt-1 h-2 w-2 shrink-0 rounded-full", color)} />
              <span>
                <span className="font-medium">{guidance.label}</span>
                <span className="block text-muted-foreground">
                  {guidance.capabilities.join(" · ")}
                </span>
              </span>
            </div>
          )
        })}
        <div className="border-t pt-2">
          <p className="mb-1.5 font-semibold">Connection health</p>
          <div className="flex flex-wrap gap-x-3 gap-y-1">
            {HEALTH.map(({ health, color }) => (
              <span key={health} className="flex items-center gap-1 text-muted-foreground">
                <span className={cn("h-1.5 w-1.5 rounded-full", color)} />
                {CONNECTION_HEALTH_GUIDANCE[health].label}
              </span>
            ))}
          </div>
        </div>
      </div>
    </details>
  )
}
