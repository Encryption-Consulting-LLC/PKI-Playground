import { BadgeCheck, FileText, Network, Radio, ShieldCheck } from "lucide-react"

import { CONNECTION_HEALTH, SERVICE_SOCKET } from "@/constants/topology"
import {
  CONNECTION_HEALTH_GUIDANCE,
  SERVICE_SOCKET_GUIDANCE,
} from "@/lib/topology"
import { cn } from "@/lib/utils"

const PORTS = [
  { socket: SERVICE_SOCKET.issuance, icon: ShieldCheck, color: "bg-amber-500 text-stone-950" },
  { socket: SERVICE_SOCKET.publication, icon: FileText, color: "bg-emerald-500 text-emerald-950" },
  { socket: SERVICE_SOCKET.ocsp, icon: Radio, color: "bg-violet-500 text-violet-950" },
  { socket: SERVICE_SOCKET.domain, icon: Network, color: "bg-sky-500 text-sky-950" },
  { socket: SERVICE_SOCKET.enrollment, icon: BadgeCheck, color: "bg-slate-100 text-slate-900" },
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
        Service sockets
      </summary>
      <div className="space-y-2 border-t px-3 py-2">
        {PORTS.map(({ socket, icon: Icon, color }) => {
          const guidance = SERVICE_SOCKET_GUIDANCE[socket]
          return (
            <div key={socket} className="flex items-start gap-2">
              <span className={cn("mt-0.5 flex h-5 w-5 shrink-0 items-center justify-center rounded-md", color)}>
                <Icon className="h-3 w-3" />
              </span>
              <span>
                <span className="font-medium">{guidance.label}</span>
                <span className="block text-muted-foreground">
                  {guidance.intent}
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
