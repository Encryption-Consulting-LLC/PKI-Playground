import { Fragment, useState } from "react"
import {
  AlertTriangle,
  Clock,
  Loader2,
  Network,
  Power,
  PowerOff,
  RefreshCw,
  Settings,
  ShieldCheck,
  Tag,
  Trash2,
  X,
} from "lucide-react"
import { toast } from "sonner"
import { TEMPLATE_BY_ID } from "@/constants/templates"
import type { ConfigField } from "@/constants/templates"
import { LIFECYCLE } from "@/constants/topology"
import { caTier, caDepth, domainMembership, driftedFields, isDeployed, isDrifted } from "@/lib/topology"
import { OP_KIND, OP_STATUS } from "@/lib/staging"
import type { StagedOp } from "@/lib/staging"
import { useTopologyStore } from "@/store/topology"
import { opsReferencingNode, useStagingStore } from "@/store/staging"
import { useAuthStore } from "@/store/auth"
import { CAPABILITIES } from "@/constants/auth"
import { useCan } from "@/hooks/useCan"
import { useIsOperator } from "@/hooks/useIsOperator"
import { useAgentConnected } from "@/hooks/useAgentConnected"
import { dispatchOrchestratorCommand } from "@/lib/api"
import { openJobSocket } from "@/lib/ws"
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
import { StagedRemoveDialog } from "./StagedRemoveDialog"

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
  disabled = false,
}: {
  fields: ConfigField[]
  onSubmit: (values: Record<string, string>) => void
  disabled?: boolean
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
        disabled={disabled}
        onClick={submit}
      >
        <Settings className="mr-2 h-3.5 w-3.5" />
        Configure
      </Button>
    </div>
  )
}

/**
 * Manual agent correlation + the live orchestrator actions.
 *
 * There is no automatic VM<->agent correlation yet (see `MachineData.
 * orchestratorVmId`'s doc comment) — a human pastes in the vm_id a
 * `POST /orchestrator/register` call returned. Every action shares the same
 * end-to-end path `cert.verify` first proved (dispatch -> job socket ->
 * result): the guest-eligible reads (`hostname.read`, `ip.read`,
 * `cert.verify`) plus the operator-only `ip.write` form. The AD DS/ADCS
 * `PlannedAction` stubs above are untouched since no command backs them yet.
 */
function OrchestratorPanel({
  nodeId,
  vmId,
  canRead,
  canWrite,
}: {
  nodeId: string
  vmId: string | undefined
  canRead: boolean
  canWrite: boolean
}) {
  const store = useTopologyStore()
  const [draftVmId, setDraftVmId] = useState(vmId ?? "")
  const [path, setPath] = useState("")
  const [ipAddress, setIpAddress] = useState("")
  const [ipPrefix, setIpPrefix] = useState("24")
  const [ipGateway, setIpGateway] = useState("")
  // One command in flight at a time (keyed by command name); results keyed
  // the same way so each action row keeps its own last outcome.
  const [busy, setBusy] = useState<string | null>(null)
  const [results, setResults] = useState<Record<string, string>>({})
  const connected = useAgentConnected(vmId)

  function saveVmId() {
    const trimmed = draftVmId.trim()
    store.patchNodeData(nodeId, { orchestratorVmId: trimmed || undefined })
  }

  function run(command: string, params: Record<string, string>) {
    if (!vmId || busy) return
    setBusy(command)
    setResults((prev) => {
      const next = { ...prev }
      delete next[command]
      return next
    })
    const finish = (text: string) => {
      setBusy(null)
      setResults((prev) => ({ ...prev, [command]: text }))
    }
    dispatchOrchestratorCommand(vmId, command, params)
      .then(({ job_id }) => {
        const token = useAuthStore.getState().token
        const close = openJobSocket(job_id, token, {
          onDone: (e) => {
            finish(JSON.stringify(e.result))
            close()
          },
          onError: (e) => {
            finish(`Error: ${e.detail}`)
            close()
          },
        })
      })
      .catch((err) => {
        finish(err instanceof Error ? err.message : "Failed to dispatch command.")
      })
  }

  const actionDisabled = !connected || busy !== null

  return (
    <div className="flex flex-col gap-2">
      <div className="flex gap-1">
        <Input
          value={draftVmId}
          onChange={(e) => setDraftVmId(e.target.value)}
          placeholder="agent vm_id"
          className="h-7 text-xs"
        />
        <Button size="sm" className="h-7 px-2 text-xs" onClick={saveVmId}>
          Set
        </Button>
      </div>
      {vmId && (
        <div className="flex items-center gap-1.5 text-xs text-muted-foreground">
          <span
            className={cn(
              "h-1.5 w-1.5 rounded-full",
              connected ? "bg-emerald-500" : "bg-muted-foreground/40",
            )}
          />
          Agent: {connected ? "Connected" : "Not connected"}
        </div>
      )}
      {canRead && (
        <div className="flex flex-col gap-1.5">
          <Button
            variant="outline"
            size="sm"
            className="w-full justify-start gap-2"
            disabled={actionDisabled}
            onClick={() => run("hostname.read", {})}
          >
            <Tag className="h-3.5 w-3.5" />
            {busy === "hostname.read" ? "Reading…" : "Read Hostname"}
          </Button>
          {results["hostname.read"] && (
            <p className="text-[11px] text-muted-foreground break-all">
              {results["hostname.read"]}
            </p>
          )}
          <Button
            variant="outline"
            size="sm"
            className="w-full justify-start gap-2"
            disabled={actionDisabled}
            onClick={() => run("ip.read", {})}
          >
            <Network className="h-3.5 w-3.5" />
            {busy === "ip.read" ? "Reading…" : "Read IP Addresses"}
          </Button>
          {results["ip.read"] && (
            <p className="text-[11px] text-muted-foreground break-all">
              {results["ip.read"]}
            </p>
          )}
        </div>
      )}
      {canWrite && (
        <div className="flex flex-col gap-1.5">
          <div className="flex gap-1">
            <Input
              value={ipAddress}
              onChange={(e) => setIpAddress(e.target.value)}
              placeholder="IPv4, e.g. 192.168.1.10"
              className="h-7 flex-1 text-xs"
              disabled={actionDisabled}
            />
            <Input
              value={ipPrefix}
              onChange={(e) => setIpPrefix(e.target.value)}
              placeholder="/24"
              className="h-7 w-12 text-xs"
              disabled={actionDisabled}
            />
          </div>
          <Input
            value={ipGateway}
            onChange={(e) => setIpGateway(e.target.value)}
            placeholder="gateway (optional)"
            className="h-7 text-xs"
            disabled={actionDisabled}
          />
          <Button
            variant="outline"
            size="sm"
            className="w-full justify-start gap-2"
            disabled={actionDisabled || !ipAddress}
            onClick={() =>
              run("ip.write", {
                address: ipAddress.trim(),
                prefixLength: ipPrefix.trim() || "24",
                ...(ipGateway.trim() ? { gateway: ipGateway.trim() } : {}),
              })
            }
          >
            <Network className="h-3.5 w-3.5" />
            {busy === "ip.write" ? "Applying…" : "Set Static IP"}
          </Button>
          {results["ip.write"] && (
            <p className="text-[11px] text-muted-foreground break-all">
              {results["ip.write"]}
            </p>
          )}
        </div>
      )}
      {canRead && (
        <div className="flex flex-col gap-1.5">
          <Input
            value={path}
            onChange={(e) => setPath(e.target.value)}
            placeholder="cert path, e.g. C:\win11.cer"
            className="h-7 text-xs"
            disabled={actionDisabled}
          />
          <Button
            variant="outline"
            size="sm"
            className="w-full justify-start gap-2"
            disabled={actionDisabled || !path}
            onClick={() => run("cert.verify", { path })}
          >
            <ShieldCheck className="h-3.5 w-3.5" />
            {busy === "cert.verify" ? "Verifying…" : "Verify Certificate"}
          </Button>
          {results["cert.verify"] && (
            <p className="text-[11px] text-muted-foreground break-all">
              {results["cert.verify"]}
            </p>
          )}
        </div>
      )}
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
  const [pendingDelete, setPendingDelete] = useState<StagedOp[] | null>(null)

  const canPower = useCan(CAPABILITIES.vmPower)
  const canUpdate = useCan(CAPABILITIES.vmUpdate)
  const canRead = useCan(CAPABILITIES.vmRead)
  const isOperator = useIsOperator()
  const deploying = useStagingStore((s) => s.deploying)
  const ops = useStagingStore((s) => s.ops)
  const retryDeploy = useStagingStore((s) => s.deploy)

  const node = nodes.find((n) => n.id === selectedId) ?? null

  if (!node) {
    return (
      <aside className="flex w-0 shrink-0 flex-col overflow-hidden border-l-0 bg-sidebar transition-[width] duration-200 ease-in-out" />
    )
  }

  const nodeId = node.id
  const { data } = node
  const def = TEMPLATE_BY_ID[data.typeId]
  const Icon = def?.icon ?? Settings
  const isConfigured = isDeployed(data)
  const isConfiguring = data.lifecycle === LIFECYCLE.deploying
  const isStaged = data.lifecycle === LIFECYCLE.staged
  const isFailed = data.lifecycle === LIFECYCLE.failed
  const isDestroying = data.lifecycle === LIFECYCLE.destroying
  const failedOp = ops.find(
    (op) => op.kind === OP_KIND.createVm && op.targetNodeId === nodeId && op.status === OP_STATUS.error,
  )

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
    const affected = opsReferencingNode(useStagingStore.getState().ops, nodeId)
    // A deployed node always confirms — deleting only removes it from the
    // canvas, the VM itself is left running on the host, and that's worth a
    // pause even when there's nothing staged to cascade.
    if (affected.length === 0 && !isConfigured) {
      store.removeNode(nodeId)
      toast("Node removed.")
      return
    }
    setPendingDelete(affected)
  }

  function confirmDelete() {
    // removeNode itself cascades any ops referencing the node — this dialog
    // is purely the confirmation gate.
    store.removeNode(nodeId)
    toast("Node removed.")
    setPendingDelete(null)
  }

  function handleConfigure(config?: Record<string, string>) {
    store.configureNode(nodeId, config)
    toast.info(`Configuring "${data.name}"…`)
    setReconfiguring(false)
  }

  const hasConfigFields = !!(def?.configFields && def.configFields.length > 0)
  const showConfigForm =
    (!isConfigured && !isConfiguring && !isStaged && !isDestroying) ||
    (isConfigured && reconfiguring)

  return (
    <aside className="flex w-64 shrink-0 flex-col gap-0 overflow-x-hidden overflow-y-auto border-l bg-sidebar transition-[width] duration-200 ease-in-out">
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
            {data.ip && (
              <>
                <span className="text-muted-foreground">IP address</span>
                <span className="font-mono">{data.ip}</span>
              </>
            )}
            {isOperator && data.vmName && (
              <>
                <span className="text-muted-foreground">VM name</span>
                <span className="truncate font-mono" title={data.vmName}>{data.vmName}</span>
              </>
            )}
            {(!isConfigured || isConfiguring || isDrifted(data)) && (
              <>
                <span className="text-muted-foreground">Status</span>
                <span className="flex items-center gap-1">
                  {data.lifecycle === LIFECYCLE.draft && (
                    <><AlertTriangle className="h-3 w-3 text-amber-500" /> draft</>
                  )}
                  {isStaged && (
                    <><Clock className="h-3 w-3 text-sky-500" /> staged</>
                  )}
                  {isConfiguring && (
                    <><Loader2 className="h-3 w-3 animate-spin text-muted-foreground" /> deploying…</>
                  )}
                  {isFailed && (
                    <><AlertTriangle className="h-3 w-3 text-red-500" /> failed</>
                  )}
                  {isDestroying && (
                    <><Loader2 className="h-3 w-3 animate-spin text-red-500" /> removing…</>
                  )}
                  {isDrifted(data) && (
                    <><RefreshCw className="h-3 w-3 text-orange-500" /> drifted</>
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

        {/* Configuration inputs (shown when draft/failed with fields, or reconfiguring) */}
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
                  disabled={deploying}
                />
              </>
            )}
          </section>
        )}

        {/* Simple configure (no config fields) */}
        {!isConfigured && !isConfiguring && !isStaged && !isDestroying && !hasConfigFields && (
          <section className="flex flex-col gap-2">
            <div className="flex items-start gap-2 rounded-md border border-amber-500/30 bg-amber-500/5 p-2 text-xs text-amber-600">
              <AlertTriangle className="mt-0.5 h-3 w-3 shrink-0" />
              Configure this VM before connecting it or taking actions.
            </div>
            <Button
              size="sm"
              className="w-full"
              disabled={deploying}
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
            Creating VM…
          </section>
        )}

        {/* Tearing down — the destroy job is running; nothing else is actionable */}
        {isDestroying && (
          <section className="flex items-center gap-2 rounded-md border border-red-500/30 bg-red-500/5 p-2 text-xs text-red-600">
            <Loader2 className="h-3.5 w-3.5 animate-spin" />
            Tearing down VM…
          </section>
        )}

        {/* Staged — pending a deploy that will actually create it */}
        {isStaged && (
          <section className="flex items-start gap-2 rounded-md border border-sky-500/30 bg-sky-500/5 p-2 text-xs text-sky-600">
            <Clock className="mt-0.5 h-3 w-3 shrink-0" />
            Staged — will be created when deployed.
          </section>
        )}

        {/* Failed — the createVm op errored out; offer the same retry the Staged panel exposes */}
        {isFailed && (
          <section className="flex flex-col gap-2">
            <div className="flex items-start gap-2 rounded-md border border-red-500/30 bg-red-500/5 p-2 text-xs text-red-600">
              <AlertTriangle className="mt-0.5 h-3 w-3 shrink-0" />
              <div className="flex flex-col gap-1">
                <span>Deploy failed.</span>
                {failedOp?.detail && (
                  <span className="text-[11px] text-muted-foreground">{failedOp.detail}</span>
                )}
              </div>
            </div>
            <Button
              variant="outline"
              size="sm"
              className="w-full justify-start gap-2"
              disabled={deploying}
              onClick={() => retryDeploy()}
            >
              <RefreshCw className="h-3.5 w-3.5" />
              Retry deploy
            </Button>
          </section>
        )}

        {/* Drifted — deployed, but the stored config no longer matches what was last deployed */}
        {isDrifted(data) && data.config && (
          <section className="flex flex-col gap-2">
            <div className="flex items-start gap-2 rounded-md border border-orange-500/30 bg-orange-500/5 p-2 text-xs text-orange-600">
              <RefreshCw className="mt-0.5 h-3 w-3 shrink-0" />
              <div className="flex flex-col gap-1">
                <span>Configuration changed since last deploy.</span>
                {driftedFields(data).map((key) => {
                  const fieldLabel = def?.configFields?.find((f) => f.key === key)?.label ?? key
                  return (
                    <span key={key} className="text-[11px] text-muted-foreground">
                      {fieldLabel}: {data.lastDeployedConfig?.[key] ?? "—"} → {data.config?.[key] ?? "—"}
                    </span>
                  )
                })}
              </div>
            </div>
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
                  <Fragment key={key}>
                    <span className="text-muted-foreground">{fieldLabel}</span>
                    <span className="truncate">{value}</span>
                  </Fragment>
                )
              })}
            </div>
          </section>
        )}

        {/* Actions — guests only ever see the functional Reconfigure; the
            disabled planned-action stubs are operator-facing roadmap, not
            product surface. */}
        {isConfigured && !reconfiguring && (isOperator || hasConfigFields) && (
          <section className="flex flex-col gap-2">
            <p className="text-[11px] font-semibold uppercase tracking-wider text-muted-foreground">
              Actions
            </p>

            <div className="flex flex-col gap-1.5">
              {isOperator && (
                <>
                  <PlannedAction
                    icon={Power}
                    label="Power On"
                    tip="Power controls coming soon"
                    disabled={!canPower || deploying}
                  />
                  <PlannedAction
                    icon={PowerOff}
                    label="Power Off"
                    tip="Power controls coming soon"
                    disabled={!canPower || deploying}
                  />
                </>
              )}
              {hasConfigFields ? (
                <PlannedAction
                  icon={RefreshCw}
                  label="Reconfigure"
                  tip="Edit configuration and re-apply"
                  disabled={!canUpdate || deploying}
                  onClick={() => setReconfiguring(true)}
                />
              ) : (
                isOperator && (
                  <PlannedAction
                    icon={RefreshCw}
                    label="Reconfigure"
                    tip="Coming soon"
                    disabled={!canUpdate || deploying}
                  />
                )
              )}
              {isOperator && data.typeId === "domainController" && (
                <PlannedAction
                  icon={Settings}
                  label="Promote to DC"
                  tip="Automatic AD DS promotion coming soon"
                  disabled
                />
              )}
              {isOperator && data.typeId === "certificateAuthority" && (
                <PlannedAction
                  icon={ShieldCheck}
                  label={
                    tier === "root" ? "Install Root CA"
                    : tier === "intermediate" ? "Install Intermediate CA"
                    : tier === "issuing" ? "Install Issuing CA"
                    : "Install CA"
                  }
                  tip="Automatic CA installation coming soon"
                  disabled
                />
              )}
            </div>
          </section>
        )}

        {/* Orchestrator phone-home: manual agent correlation + live hostname/IP/cert
            actions. Operator-only — raw vm_id/token correlation and agent commands
            are infra internals the guest product surface must not expose. */}
        {isOperator && isConfigured && !reconfiguring && (
          <section className="flex flex-col gap-2 border-t pt-3">
            <p className="text-[11px] font-semibold uppercase tracking-wider text-muted-foreground">
              Orchestrator
            </p>
            <OrchestratorPanel
              nodeId={nodeId}
              vmId={data.orchestratorVmId}
              canRead={canRead}
              canWrite={canUpdate}
            />
          </section>
        )}

        {/* Danger zone */}
        <section className="flex flex-col gap-2 border-t pt-3">
          <Button
            variant="destructive"
            size="sm"
            className="w-full justify-start gap-2"
            disabled={deploying}
            onClick={handleDelete}
          >
            <Trash2 className="h-3.5 w-3.5" />
            Delete node
          </Button>
        </section>
      </div>

      <StagedRemoveDialog
        ops={pendingDelete}
        hostNote={isConfigured}
        onConfirm={confirmDelete}
        onCancel={() => setPendingDelete(null)}
      />
    </aside>
  )
}
