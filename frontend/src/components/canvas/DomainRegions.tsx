import { ViewportPortal } from "@xyflow/react"

import { NODE_STATUS } from "@/constants/topology"
import { DOMAIN_RADIUS, domainLabel, nodeCenter } from "@/lib/topology"
import { useTopologyStore } from "@/store/topology"

/**
 * Sky-blue translucent circle drawn around each configured domain controller —
 * the visual "domain". Rendered inside a ViewportPortal so the circles live in
 * flow coordinates (panning/zooming with the canvas) and sit behind the nodes.
 *
 * This is purely presentational; the membership logic that reacts to nodes
 * being dragged into a circle lives in the store's `computeDomainChanges` /
 * `applyDomainChanges` (gated behind a confirmation prompt in Canvas).
 */
export function DomainRegions() {
  const nodes = useTopologyStore((s) => s.nodes)
  const domains = nodes.filter(
    (n) =>
      n.data.typeId === "domainController" &&
      n.data.status === NODE_STATUS.configured,
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
          return (
            <div
              key={dc.id}
              style={{
                position: "absolute",
                left: c.x,
                top: c.y,
                width: DOMAIN_RADIUS * 2,
                height: DOMAIN_RADIUS * 2,
                transform: "translate(-50%, -50%)",
                borderRadius: "9999px",
                border: "2px solid rgba(56, 189, 248, 0.45)",
                background: "rgba(56, 189, 248, 0.08)",
                boxShadow: "inset 0 0 80px rgba(56, 189, 248, 0.12)",
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
