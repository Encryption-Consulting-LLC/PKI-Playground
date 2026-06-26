import { useState } from "react"
import {
  AlertTriangle,
  Loader2,
  Power,
  PowerOff,
  RefreshCw,
  Settings,
  ShieldCheck,
  Trash2,
  X,
} from "lucide-react"
import { toast } from "sonner"
import { TEMPLATE_BY_ID } from "@/constants/templates"
import type { ConfigField } from "@/constants/templates"
import { NODE_STATUS } from "@/constants/topology"
import { caTier, caDepth, domainMembership } from "@/lib/topology"
import { useTopologyStore } from "@/store/topology"
import { CAPABILITIES } from "@/constants/auth"
import { useCan } from "@/hooks/useCan"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select"
import { cn } from "@/lib/utils"

function PlannedAction({
  icon: Icon,
  label,
  tip,
  disabled = true,
  onClick,
}: {
  icon: React.ElementType
  label: string
  tip: string
  disabled?: boolean
  onClick?: () => void
}) {
  return (
    <Button
      variant="outline"
      size="sm"
      className="w-full justify-start gap-2 text-muted-foreground"
      disabled={disabled}
      title={tip}
      onClick={onClick}
    >
      <Icon className="h-3.5 w-3.5" />
      {label}
    </Button>
  )
}

/**
 * Inline config form rendered in the Inspector when a node is unconfigured
 * and its template defines configFields. Keyed by nodeId so state resets
 * when the selection changes.
 */
function ConfigForm({
  fields,
  onSubmit,
}: {
  fields: ConfigField[]
  onSubmit: (values: Record<string, string>) => void
}) {
  const [values, setValues] = useState<Record<string, string>>(() =>
    Object.fromEntries(fields.map((f) => [f.key, f.default])),
  )

  function set(key: string, value: string) {
    setValues((prev) => ({ ...prev, [key]: value }))
  }

  const isHidden = (field: ConfigField) => {
    const cond = field.hideWhen
    if (!cond) return false
    const current = values[cond.key]
    if (cond.equals !== undefined && current === cond.equals) return true
    if (cond.notEquals !== undefined && current !== cond.notEquals) return true
    return false
  }

  const visibleFields = fields.filter((f) => !isHidden(f))

  function submit() {
    onSubmit(
      Object.fromEntries(visibleFields.map((f) => [f.key, values[f.key]])),
    )
  }

  return (
    <div className="flex flex-col gap-3">
      {visibleFields.map((field) => (
        <div key={field.key} className="grid gap-1.5">
          <Label className="text-[11px] text-muted-foreground">{field.label}</Label>
          {field.type === "fixed" ? (
            <div className="flex h-7 items-center rounded-md border bg-muted/40 px-3 text-xs text-muted-foreground">
              {values[field.key]}
            </div>
          ) : field.type === "text" ? (
            <Input
              value={values[field.key]}
              onChange={(e) => set(field.key, e.target.value)}
              placeholder={field.placeholder}
              className="h-7 text-xs"
            />
          ) : (
            <Select
              value={values[field.key]}
              onValueChange={(v) => v !== null && set(field.key, v)}
            >
              <SelectTrigger className="h-7 text-xs">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {field.options.map((opt) => (
                  <SelectItem key={opt} value={opt} className="text-xs">
                    {opt}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          )}
        </div>
      ))}
      <Button
        size="sm"
        className="mt-1 w-full"
        onClick={submit}
      >
        <Settings className="mr-2 h-3.5 w-3.5" />
        Configure
      </Button>
    </div>
  )
}

export function Inspector() {
  const selectedId = useTopologyStore((s) => s.selectedNodeId)
  const store = useTopologyStore()
  const nodes = useTopologyStore((s) => s.nodes)
  const edges = useTopologyStore((s) => s.edges)

  const [editingName, setEditingName] = useState(false)
  const [draftName, setDraftName] = useState("")
  const [reconfiguring, setReconfiguring] = useState(false)

  const canPower = useCan(CAPABILITIES.vmPower)
  const canUpdate = useCan(CAPABILITIES.vmUpdate)

  const node = nodes.find((n) => n.id === selectedId) ?? null

  if (!node) {
    return (
      <aside className="flex w-64 shrink-0 flex-col items-center justify-center gap-2 border-l bg-sidebar p-4 text-muted-foreground text-sm">
        <Settings className="h-6 w-6 opacity-30" />
        <span className="text-xs text-center">
          Click a node to inspect it, or drag a template from the toolbox.
        </span>
      </aside>
    )
  }

  const nodeId = node.id
  const { data } = node
  const def = TEMPLATE_BY_ID[data.typeId]
  const Icon = def?.icon ?? Settings
  const isConfigured = data.status === NODE_STATUS.configured
  const isConfiguring = data.status === NODE_STATUS.configuring

  const tier =
    data.typeId === "certificateAuthority" ? caTier(nodeId, edges) : null
  const depth =
    tier !== null && tier !== "root" && tier !== "standalone"
      ? caDepth(nodeId, edges)
      : null
  const domain = domainMembership(nodeId, edges, nodes)

  function startRename() {
    setDraftName(data.name)
    setEditingName(true)
  }

  function commitRename() {
    const trimmed = draftName.trim()
    if (trimmed && trimmed !== data.name) {
      store.renameNode(nodeId, trimmed)
      toast.success(`Renamed to "${trimmed}"`)
    }
    setEditingName(false)
  }

  function handleDelete() {
    store.removeNode(nodeId)
    toast("Node removed.")
  }

  function handleConfigure(config?: Record<string, string>) {
    store.configureNode(nodeId, config)
    toast.info(`Configuring "${data.name}"…`)
    setReconfiguring(false)
  }

  const hasConfigFields = !!(def?.configFields && def.configFields.length > 0)
  const showConfigForm =
    (!isConfigured && !isConfiguring) ||
    (isConfigured && reconfiguring)

  return (
    <aside className="flex w-64 shrink-0 flex-col gap-0 border-l bg-sidebar overflow-y-auto">
      {/* Header */}
      <div className="flex items-center gap-2 border-b px-3 py-3">
        <Icon className={cn("h-4 w-4 shrink-0", def?.accent)} />
        <span className="flex-1 text-sm font-semibold truncate">{data.name}</span>
        <button
          onClick={() => store.selectNode(null)}
          className="text-muted-foreground hover:text-foreground transition-colors"
          aria-label="Close inspector"
        >
          <X className="h-4 w-4" />
        </button>
      </div>

      <div className="flex flex-col gap-4 p-3">
        {/* Identity */}
        <section className="flex flex-col gap-2">
          <p className="text-[11px] font-semibold uppercase tracking-wider text-muted-foreground">
            Identity
          </p>

          <div className="grid grid-cols-[auto_1fr] gap-x-2 gap-y-1 text-xs">
            <span className="text-muted-foreground">Role</span>
            <span>{def?.label ?? data.typeId}</span>
            {(data.status === NODE_STATUS.unconfigured || data.status === NODE_STATUS.configuring) && (
              <>
                <span className="text-muted-foreground">Status</span>
                <span className="flex items-center gap-1">
                  {data.status === NODE_STATUS.unconfigured && (
                    <><AlertTriangle className="h-3 w-3 text-amber-500" /> unconfigured</>
                  )}
                  {data.status === NODE_STATUS.configuring && (
                    <><Loader2 className="h-3 w-3 animate-spin text-muted-foreground" /> configuring…</>
                  )}
                </span>
              </>
            )}
          </div>

          {/* Derived chips */}
          {tier === "root" && (
            <Badge variant="outline" className="text-[10px] border-amber-500/50 text-amber-500 self-start">
              CA: Root
            </Badge>
          )}
          {tier === "intermediate" && (
            <Badge variant="outline" className="text-[10px] border-amber-500/40 text-amber-400 self-start">
              CA: Intermediate · T{depth}
            </Badge>
          )}
          {tier === "issuing" && (
            <Badge variant="outline" className="text-[10px] border-amber-500/30 text-amber-300 self-start">
              CA: Issuing · T{depth}
            </Badge>
          )}
          {domain && (
            <Badge variant="outline" className="text-[10px] border-blue-500/40 text-blue-400 self-start">
              Domain: {domain}
            </Badge>
          )}
        </section>

        {/* Rename */}
        <section className="flex flex-col gap-2">
          <p className="text-[11px] font-semibold uppercase tracking-wider text-muted-foreground">
            Name
          </p>
          {editingName ? (
            <div className="flex gap-1">
              <Input
                value={draftName}
                onChange={(e) => setDraftName(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === "Enter") commitRename()
                  if (e.key === "Escape") setEditingName(false)
                }}
                className="h-7 text-xs"
                autoFocus
              />
              <Button size="sm" className="h-7 px-2 text-xs" onClick={commitRename}>
                OK
              </Button>
            </div>
          ) : (
            <button
              onClick={startRename}
              className="text-left text-xs text-muted-foreground hover:text-foreground underline-offset-2 hover:underline transition-colors"
            >
              {data.name} — click to rename
            </button>
          )}
        </section>

        {/* Configuration inputs (shown when unconfigured with fields, or reconfiguring) */}
        {showConfigForm && hasConfigFields && (
          <section className="flex flex-col gap-2">
            <p className="text-[11px] font-semibold uppercase tracking-wider text-muted-foreground">
              Configuration
            </p>
            {!isConfiguring && (
              <>
                {!isConfigured && (
                  <div className="flex items-start gap-2 rounded-md border border-amber-500/30 bg-amber-500/5 p-2 text-xs text-amber-600">
                    <AlertTriangle className="mt-0.5 h-3 w-3 shrink-0" />
                    Configure this VM before connecting it or taking actions.
                  </div>
                )}
                <ConfigForm
                  key={nodeId}
                  fields={def!.configFields!}
                  onSubmit={handleConfigure}
                />
              </>
            )}
          </section>
        )}

        {/* Simple configure (no config fields) */}
        {!isConfigured && !isConfiguring && !hasConfigFields && (
          <section className="flex flex-col gap-2">
            <div className="flex items-start gap-2 rounded-md border border-amber-500/30 bg-amber-500/5 p-2 text-xs text-amber-600">
              <AlertTriangle className="mt-0.5 h-3 w-3 shrink-0" />
              Configure this VM before connecting it or taking actions.
            </div>
            <Button
              size="sm"
              className="w-full"
              onClick={() => handleConfigure()}
            >
              <Settings className="mr-2 h-3.5 w-3.5" />
              Configure
            </Button>
          </section>
        )}

        {/* Configuring spinner */}
        {isConfiguring && (
          <section className="flex items-center gap-2 text-xs text-muted-foreground">
            <Loader2 className="h-3.5 w-3.5 animate-spin" />
            Cloning VM…
          </section>
        )}

        {/* Stored config values (post-configure) */}
        {isConfigured && data.config && !reconfiguring && (
          <section className="flex flex-col gap-2">
            <p className="text-[11px] font-semibold uppercase tracking-wider text-muted-foreground">
              Configuration
            </p>
            <div className="grid grid-cols-[auto_1fr] gap-x-2 gap-y-1 text-xs">
              {Object.entries(data.config).map(([key, value]) => {
                const fieldLabel =
                  def?.configFields?.find((f) => f.key === key)?.label ?? key
                return (
                  <>
                    <span key={`k-${key}`} className="text-muted-foreground">{fieldLabel}</span>
                    <span key={`v-${key}`} className="truncate">{value}</span>
                  </>
                )
              })}
            </div>
          </section>
        )}

        {/* Actions */}
        {isConfigured && !reconfiguring && (
          <section className="flex flex-col gap-2">
            <p className="text-[11px] font-semibold uppercase tracking-wider text-muted-foreground">
              Actions
            </p>

            <div className="flex flex-col gap-1.5">
              <>
                  <PlannedAction
                    icon={Power}
                    label="Power On"
                    tip={`Future: POST /api/vm/${data.name}/power-on`}
                    disabled={!canPower}
                  />
                  <PlannedAction
                    icon={PowerOff}
                    label="Power Off"
                    tip={`Future: POST /api/vm/${data.name}/power-off`}
                    disabled={!canPower}
                  />
                  {hasConfigFields && (
                    <PlannedAction
                      icon={RefreshCw}
                      label="Reconfigure"
                      tip="Edit configuration and re-apply"
                      disabled={!canUpdate}
                      onClick={() => setReconfiguring(true)}
                    />
                  )}
                  {!hasConfigFields && (
                    <PlannedAction
                      icon={RefreshCw}
                      label="Reconfigure"
                      tip={`Future: PATCH /api/vm/${data.name}`}
                      disabled={!canUpdate}
                    />
                  )}
                  {data.typeId === "domainController" && (
                    <PlannedAction
                      icon={Settings}
                      label="Promote to DC"
                      tip="Future: orchestrator — AD DS promotion via firstboot"
                      disabled
                    />
                  )}
                  {data.typeId === "certificateAuthority" && (
                    <PlannedAction
                      icon={ShieldCheck}
                      label={
                        tier === "root" ? "Install Root CA"
                        : tier === "intermediate" ? "Install Intermediate CA"
                        : tier === "issuing" ? "Install Issuing CA"
                        : "Install CA"
                      }
                      tip="Future: orchestrator — ADCS install via firstboot"
                      disabled
                    />
                  )}
              </>
            </div>
          </section>
        )}

        {/* Danger zone */}
        <section className="flex flex-col gap-2 border-t pt-3">
          <Button
            variant="destructive"
            size="sm"
            className="w-full justify-start gap-2"
            onClick={handleDelete}
          >
            <Trash2 className="h-3.5 w-3.5" />
            Delete node
          </Button>
        </section>
      </div>
    </aside>
  )
}
