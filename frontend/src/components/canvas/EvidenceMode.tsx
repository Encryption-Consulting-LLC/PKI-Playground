import { useMemo, useState } from "react"
import type { Edge, Node } from "@xyflow/react"
import {
  CheckCircle2,
  ClipboardCheck,
  Download,
  FileLock2,
  Fingerprint,
  Loader2,
  ShieldCheck,
  XCircle,
} from "lucide-react"
import { toast } from "sonner"

import { Button } from "@/components/ui/button"
import { downloadDeployEvidence } from "@/lib/api"
import { buildAuditSnapshot, type LabEvidence } from "@/lib/labEvidence"
import { cn } from "@/lib/utils"
import type { MachineData } from "@/store/topology"

export function EvidenceModeToggle({
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
          ? "Freeze the verified audit snapshot"
          : "Deploy and verify the lab first"
      }
      onClick={onToggle}
      className="h-8 gap-2 bg-background/95 text-[10px] data-[active=true]:bg-primary"
      data-active={active}
    >
      <FileLock2 className="h-3.5 w-3.5" />
      Evidence
    </Button>
  )
}

function countChecks(value: unknown): { passed: number; total: number } {
  if (!value || typeof value !== "object") return { passed: 0, total: 0 }
  if ("ok" in value && typeof (value as { ok?: unknown }).ok === "boolean") {
    return { passed: (value as { ok: boolean }).ok ? 1 : 0, total: 1 }
  }
  return Object.values(value).reduce(
    (sum, item) => {
      const nested = countChecks(item)
      return {
        passed: sum.passed + nested.passed,
        total: sum.total + nested.total,
      }
    },
    { passed: 0, total: 0 },
  )
}

function compactValue(value: unknown): string {
  if (value === null || value === undefined) return "Not reported"
  if (typeof value === "string") return value
  if (typeof value === "boolean" || typeof value === "number")
    return String(value)
  const serialized = JSON.stringify(value)
  return serialized.length > 110 ? `${serialized.slice(0, 107)}…` : serialized
}

export function EvidenceModePanel({
  nodes,
  edges,
  evidence,
}: {
  nodes: Node<MachineData>[]
  edges: Edge[]
  evidence: LabEvidence
}) {
  const [downloading, setDownloading] = useState(false)
  const snapshot = useMemo(
    () => buildAuditSnapshot(nodes, edges, evidence),
    [nodes, edges, evidence],
  )
  const verification = countChecks(evidence.health.checks)
  const fingerprints = snapshot.certificateFingerprints
  const freshness = compactValue(snapshot.revocationFreshness)

  const copySnapshot = async () => {
    try {
      await navigator.clipboard.writeText(JSON.stringify(snapshot, null, 2))
      toast.success("Audit snapshot copied.")
    } catch {
      toast.error("The browser blocked clipboard access.")
    }
  }

  const downloadBundle = async () => {
    setDownloading(true)
    try {
      const bundle = await downloadDeployEvidence(evidence.deploymentJobId)
      const url = URL.createObjectURL(bundle.blob)
      const anchor = document.createElement("a")
      anchor.href = url
      anchor.download = bundle.filename
      anchor.click()
      window.setTimeout(() => URL.revokeObjectURL(url), 0)
      toast.success(
        bundle.digest
          ? `Evidence verified · SHA-256 ${bundle.digest.slice(0, 12)}…`
          : "Evidence bundle downloaded.",
      )
    } catch (error) {
      toast.error(
        error instanceof Error ? error.message : "Evidence download failed.",
      )
    } finally {
      setDownloading(false)
    }
  }

  return (
    <div className="w-[min(980px,calc(100vw-20rem))] overflow-hidden rounded-2xl border bg-background/97 shadow-2xl backdrop-blur">
      <div className="flex items-center justify-between gap-4 border-b px-4 py-2.5 text-[10px]">
        <span className="flex items-center gap-2 font-semibold uppercase tracking-wider">
          <ShieldCheck
            className={cn(
              "h-3.5 w-3.5",
              evidence.health.healthy ? "text-emerald-500" : "text-red-500",
            )}
          />
          Frozen audit snapshot
        </span>
        <span className="text-muted-foreground">
          {new Date(evidence.verifiedAt).toLocaleString()} · job{" "}
          {evidence.deploymentJobId.slice(0, 12)}
        </span>
      </div>

      <div className="grid grid-cols-4 divide-x border-b text-[10px]">
        <EvidenceFact
          icon={evidence.health.healthy ? CheckCircle2 : XCircle}
          label="Verification"
          value={`${verification.passed}/${verification.total} checks passed`}
          bad={!evidence.health.healthy}
        />
        <EvidenceFact
          icon={FileLock2}
          label="Topology"
          value={`${nodes.length} nodes · ${snapshot.topology.relationships.length} relationships`}
        />
        <EvidenceFact
          icon={ShieldCheck}
          label="ML-DSA"
          value={evidence.journey.signatureAlgorithm}
        />
        <EvidenceFact
          icon={Fingerprint}
          label="Fingerprints"
          value={
            fingerprints.length
              ? `${fingerprints.length} captured`
              : "Stored in full bundle"
          }
        />
      </div>

      <div className="grid grid-cols-[1fr_1.35fr_auto] items-center gap-4 px-4 py-3 text-[10px]">
        <div className="min-w-0">
          <p className="font-semibold">CRL / OCSP freshness</p>
          <p className="mt-1 truncate text-muted-foreground" title={freshness}>
            {freshness}
          </p>
        </div>
        <div className="min-w-0">
          <p className="font-semibold">Verification output</p>
          <p
            className={cn(
              "mt-1 truncate",
              evidence.health.healthy ? "text-emerald-500" : "text-red-500",
            )}
          >
            {evidence.health.failures.length
              ? evidence.health.failures.join(" · ")
              : "All required PKI paths verified"}
          </p>
        </div>
        <div className="flex gap-2">
          <Button
            type="button"
            size="sm"
            variant="outline"
            className="h-8 gap-1.5 text-[10px]"
            onClick={copySnapshot}
          >
            <ClipboardCheck className="h-3.5 w-3.5" /> Copy snapshot
          </Button>
          <Button
            type="button"
            size="sm"
            className="h-8 gap-1.5 text-[10px]"
            disabled={downloading}
            onClick={downloadBundle}
          >
            {downloading ? (
              <Loader2 className="h-3.5 w-3.5 animate-spin" />
            ) : (
              <Download className="h-3.5 w-3.5" />
            )}
            Evidence ZIP
          </Button>
        </div>
      </div>
    </div>
  )
}

function EvidenceFact({
  icon: Icon,
  label,
  value,
  bad = false,
}: {
  icon: typeof ShieldCheck
  label: string
  value: string
  bad?: boolean
}) {
  return (
    <div className="flex min-w-0 items-center gap-2.5 px-4 py-3">
      <Icon
        className={cn(
          "h-4 w-4 shrink-0",
          bad ? "text-red-500" : "text-emerald-500",
        )}
      />
      <span className="min-w-0">
        <span className="block font-semibold">{label}</span>
        <span className="block truncate text-muted-foreground" title={value}>
          {value}
        </span>
      </span>
    </div>
  )
}
