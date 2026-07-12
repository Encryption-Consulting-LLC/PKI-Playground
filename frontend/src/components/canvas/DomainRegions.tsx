import { ViewportPortal } from "@xyflow/react"

import { LIFECYCLE } from "@/constants/topology"
import { domainLabel, domainRadius, isConnectable, nodeCenter } from "@/lib/topology"
import { useTopologyStore } from "@/store/topology"

/**
 * Sky-blue translucent circle drawn around each domain controller that can
 * carry real membership edges — the visual "domain". Rendered inside a
 * ViewportPortal so the circles live in flow coordinates (panning/zooming
 * with the canvas) and sit behind the nodes. A DC that isn't a confirmed,
 * agent-online deployment yet — still `staged`, or `provisioning` (cloned but
 * the orchestrator hasn't phoned home) — gets a dashed outline, so the circle
 * only goes solid once the domain is real.
 *
 * This is purely presentational; the membership logic that reacts to nodes
 * being dragged into a circle lives in the store's `computeDomainChanges` /
 * `applyDomainChanges` (gated behind a confirmation prompt in Canvas).
 */
export function DomainRegions() {
  const nodes = useTopologyStore((s) => s.nodes)
  const edges = useTopologyStore((s) => s.edges)
  const domains = nodes.filter(
    (n) => n.data.typeId === "domainController" && isConnectable(n.data),
  )

  if (domains.length === 0) return null

  return (
    <ViewportPortal>
      <div
        style={{
          position: "absolute",
          top: 0,
          left: 0,
          zIndex: -1,
          pointerEvents: "none",
        }}
      >
        {domains.map((dc) => {
          const c = nodeCenter(dc)
          const r = domainRadius(dc, nodes, edges)
          const pending =
            dc.data.lifecycle === LIFECYCLE.staged ||
            dc.data.lifecycle === LIFECYCLE.provisioning
          return (
            <div
              key={dc.id}
              style={{
                position: "absolute",
                left: c.x,
                top: c.y,
                width: r * 2,
                height: r * 2,
                transform: "translate(-50%, -50%)",
                borderRadius: "9999px",
                border: `2px ${pending ? "dashed" : "solid"} rgba(56, 189, 248, 0.45)`,
                background: "rgba(56, 189, 248, 0.08)",
                boxShadow: "inset 0 0 80px rgba(56, 189, 248, 0.12)",
                transition: "width 600ms cubic-bezier(0.34, 1.56, 0.64, 1), height 600ms cubic-bezier(0.34, 1.56, 0.64, 1)",
              }}
            >
              <span
                style={{
                  position: "absolute",
                  top: 14,
                  left: "50%",
                  transform: "translateX(-50%)",
                  fontSize: 12,
                  fontWeight: 600,
                  letterSpacing: "0.02em",
                  color: "rgba(56, 189, 248, 0.9)",
                  whiteSpace: "nowrap",
                }}
              >
                {domainLabel(dc)}
              </span>
            </div>
          )
        })}
      </div>
    </ViewportPortal>
  )
}
