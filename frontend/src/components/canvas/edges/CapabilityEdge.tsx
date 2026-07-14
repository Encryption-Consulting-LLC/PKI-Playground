import { useState } from "react"
import {
  BaseEdge,
  EdgeLabelRenderer,
  getBezierPath,
  getSmoothStepPath,
  type EdgeProps,
} from "@xyflow/react"

import { CONNECTION_HEALTH, EDGE_TYPE } from "@/constants/topology"
import type { ConnectionHealth, EdgeType } from "@/constants/topology"
import {
  CONNECTION_HEALTH_GUIDANCE,
  CONNECTION_PORT_GUIDANCE,
  connectionGuidance,
} from "@/lib/topology"
import { cn } from "@/lib/utils"

export function CapabilityEdge(props: EdgeProps) {
  const [hovered, setHovered] = useState(false)
  const edgeType = props.data?.edgeType as EdgeType | undefined
  if (!edgeType) return null

  const guidance = connectionGuidance(edgeType, {
    rootIssuer: props.data?.rootIssuer === true,
  })
  const [path, labelX, labelY] =
    edgeType === EDGE_TYPE.webServerCert
      ? getBezierPath(props)
      : getSmoothStepPath(props)
  const expanded = hovered || props.selected
  const health = (props.data?.health as ConnectionHealth | undefined) ??
    (props.data?.staged === true
      ? CONNECTION_HEALTH.planned
      : CONNECTION_HEALTH.verified)
  const healthGuidance = CONNECTION_HEALTH_GUIDANCE[health]
  const pathStyle = {
    ...props.style,
    ...(health === CONNECTION_HEALTH.applying
      ? { strokeDasharray: "7 4", opacity: 1 }
      : health === CONNECTION_HEALTH.degraded
        ? { stroke: "#f59e0b", strokeDasharray: "4 4", opacity: 1 }
        : health === CONNECTION_HEALTH.broken
          ? { stroke: "#ef4444", strokeWidth: 2.5, opacity: 1 }
          : {}),
  }

  return (
    <>
      <BaseEdge
        id={props.id}
        path={path}
        markerEnd={props.markerEnd}
        style={pathStyle}
      />
      {edgeType === EDGE_TYPE.caHierarchy && props.data?.rootIssuer === true && (
        <g className="offline-relay-package pointer-events-none" aria-hidden="true">
          <title>Sealed certificate request and signed certificate relay</title>
          <rect
            x="-9"
            y="-7"
            width="18"
            height="14"
            rx="3"
            fill="#1c1917"
            stroke="#fbbf24"
            strokeWidth="1.5"
          />
          <path
            d="M -7 -4 L 0 1 L 7 -4 M -7 5 L -2 0 M 7 5 L 2 0"
            fill="none"
            stroke="#fde68a"
            strokeWidth="1"
          />
          <animateMotion
            dur="4s"
            repeatCount="indefinite"
            path={path}
            keyPoints="0;1;0"
            keyTimes="0;0.5;1"
            calcMode="linear"
          />
        </g>
      )}
      <EdgeLabelRenderer>
        <div
          className="nodrag nopan absolute z-10"
          style={{
            transform: `translate(-50%, -50%) translate(${labelX}px, ${labelY}px)`,
          }}
          onMouseEnter={() => setHovered(true)}
          onMouseLeave={() => setHovered(false)}
        >
          <button
            type="button"
            aria-expanded={expanded}
            aria-label={`${guidance.intent}. Show connection requirements.`}
            onFocus={() => setHovered(true)}
            onBlur={() => setHovered(false)}
            className={cn(
              "flex max-w-64 items-center gap-1.5 rounded-full border bg-background/95 px-2 py-1 text-[10px] font-semibold shadow-sm",
              "transition-colors hover:bg-accent focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring",
              props.selected && "ring-2 ring-ring",
            )}
          >
            <span className="truncate">{guidance.intent}</span>
            <span
              className={cn(
                "shrink-0 rounded-full px-1.5 py-0.5 text-[9px] uppercase tracking-wide",
                health === CONNECTION_HEALTH.planned && "bg-sky-500/15 text-sky-500",
                health === CONNECTION_HEALTH.applying && "bg-violet-500/15 text-violet-500",
                health === CONNECTION_HEALTH.verified && "bg-emerald-500/15 text-emerald-500",
                health === CONNECTION_HEALTH.degraded && "bg-amber-500/15 text-amber-500",
                health === CONNECTION_HEALTH.broken && "bg-red-500/15 text-red-500",
              )}
            >
              {healthGuidance.label}
            </span>
          </button>

          {expanded && (
            <div className="absolute left-1/2 top-full mt-2 w-80 -translate-x-1/2 rounded-lg border bg-popover p-3 text-popover-foreground shadow-xl">
              <p className="text-[11px] font-semibold">Capabilities</p>
              <div className="mt-1.5 space-y-1.5">
                {guidance.ports.map((port) => {
                  const item = CONNECTION_PORT_GUIDANCE[port]
                  return (
                    <div key={port} className="text-[10px] leading-snug">
                      <span className="font-medium">{item.label}:</span>{" "}
                      <span className="text-muted-foreground">
                        {item.capabilities.join(" · ")}
                      </span>
                    </div>
                  )
                })}
              </div>

              <p className="mt-3 text-[11px] font-semibold">Health</p>
              <p className="mt-1 text-[10px] text-muted-foreground">
                {healthGuidance.label}: {healthGuidance.detail}
              </p>

              <p className="mt-3 text-[11px] font-semibold">Requirements</p>
              <ul className="mt-1 list-disc space-y-0.5 pl-4 text-[10px] text-muted-foreground">
                {guidance.requirements.map((requirement) => (
                  <li key={requirement}>{requirement}</li>
                ))}
              </ul>

              <p className="mt-3 text-[11px] font-semibold">Generated operations</p>
              <ul className="mt-1 list-disc space-y-0.5 pl-4 text-[10px] text-muted-foreground">
                {guidance.operations.map((operation) => (
                  <li key={operation}>{operation}</li>
                ))}
              </ul>
            </div>
          )}
        </div>
      </EdgeLabelRenderer>
    </>
  )
}
