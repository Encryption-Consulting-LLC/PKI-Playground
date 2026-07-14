import { useEffect, useState } from "react"
import { AlertDialog } from "@base-ui/react/alert-dialog"
import {
  CheckCircle2,
  CircleAlert,
  Loader2,
  Settings,
  ShieldCheck,
} from "lucide-react"
import { toast } from "sonner"

import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { useIsOperator } from "@/hooks/useIsOperator"
import {
  getSettings,
  updateSettings,
  validateInfrastructure,
  validateEnvironment,
  type EnvironmentPreflight,
  type InfrastructurePreflight,
  type InfrastructureProfile,
  type ImageQualification,
  type OperatorSettingsUpdate,
} from "@/lib/api"

interface FormState {
  esxiHost: string
  esxiUser: string
  esxiPassword: string
  esxiPort: string
  cloneBase: string
  cloneDatastore: string
  cloneGuestOs: string
  cloneNetwork: string
  cloneMaxUsagePct: string
  guestIpStart: string
  guestIpEnd: string
  guestPrefix: string
  guestGateway: string
  guestDns1: string
  guestDns2: string
  guestDnsSuffix: string
  profiles: InfrastructureProfile[]
  hasPassword: boolean
}

const ROLE_LABELS = {
  domainController: "Domain controller",
  rootCa: "Offline root CA",
  issuingCa: "Issuing CA",
  webServer: "Web and OCSP server",
} as const

const DEFAULT_PROFILES: InfrastructureProfile[] = [
  ["domainController", 2, 4096, 60],
  ["rootCa", 2, 4096, 60],
  ["issuingCa", 4, 8192, 80],
  ["webServer", 4, 8192, 80],
].map(([role, cpus, memoryMb, systemDiskGb]) => ({
  role: role as InfrastructureProfile["role"],
  base: "ws-2025-base",
  datastore: "datastore1",
  expectedGuestOs: "windows2022srvNext-64",
  network: "VM Network",
  cpus: cpus as number,
  memoryMb: memoryMb as number,
  systemDiskGb: systemDiskGb as number,
  maxUsagePct: 80,
  qualification: null,
}))

const EMPTY_FORM: FormState = {
  esxiHost: "",
  esxiUser: "",
  esxiPassword: "",
  esxiPort: "443",
  cloneBase: "ws-2025-base",
  cloneDatastore: "datastore1",
  cloneGuestOs: "windows2022srvNext-64",
  cloneNetwork: "VM Network",
  cloneMaxUsagePct: "80",
  guestIpStart: "",
  guestIpEnd: "",
  guestPrefix: "24",
  guestGateway: "",
  guestDns1: "",
  guestDns2: "",
  guestDnsSuffix: "",
  profiles: DEFAULT_PROFILES,
  hasPassword: false,
}

function formatBytes(value: number | null): string {
  if (value == null) return "unknown"
  const units = ["B", "KiB", "MiB", "GiB", "TiB"]
  let amount = value
  let unit = 0
  while (amount >= 1024 && unit < units.length - 1) {
    amount /= 1024
    unit += 1
  }
  return `${amount.toFixed(unit === 0 ? 0 : 1)} ${units[unit]}`
}

/**
 * Operator setup for the shared ESXi target and guided-deploy golden image.
 */
export function SettingsDialog() {
  const isOperator = useIsOperator()
  const [open, setOpen] = useState(false)
  const [form, setForm] = useState<FormState>(EMPTY_FORM)
  const [loading, setLoading] = useState(false)
  const [saving, setSaving] = useState(false)
  const [validating, setValidating] = useState(false)
  const [loadError, setLoadError] = useState<string | null>(null)
  const [preflight, setPreflight] = useState<InfrastructurePreflight | null>(null)
  const [environment, setEnvironment] = useState<EnvironmentPreflight | null>(null)

  useEffect(() => {
    if (!open || !isOperator) return
    let active = true
    getSettings()
      .then((settings) => {
        if (!active) return
        setForm({
          esxiHost: settings.esxiHost ?? "",
          esxiUser: settings.esxiUser ?? "",
          esxiPassword: "",
          esxiPort: String(settings.esxiPort ?? 443),
          cloneBase: settings.cloneBase ?? "ws-2025-base",
          cloneDatastore: settings.cloneDatastore ?? "datastore1",
          cloneGuestOs: settings.cloneGuestOs ?? "windows2022srvNext-64",
          cloneNetwork: settings.cloneNetwork ?? "VM Network",
          cloneMaxUsagePct: String(settings.cloneMaxUsagePct ?? 80),
          guestIpStart: settings.guestIpStart ?? "",
          guestIpEnd: settings.guestIpEnd ?? "",
          guestPrefix: String(settings.guestPrefix ?? 24),
          guestGateway: settings.guestGateway ?? "",
          guestDns1: settings.guestDns1 ?? "",
          guestDns2: settings.guestDns2 ?? "",
          guestDnsSuffix: settings.guestDnsSuffix ?? "",
          profiles: settings.infrastructureProfiles?.length === 4
            ? settings.infrastructureProfiles
            : DEFAULT_PROFILES.map((profile) => ({
                ...profile,
                base: settings.cloneBase ?? profile.base,
                datastore: settings.cloneDatastore ?? profile.datastore,
                expectedGuestOs: settings.cloneGuestOs ?? profile.expectedGuestOs,
                network: settings.cloneNetwork ?? profile.network,
                maxUsagePct: settings.cloneMaxUsagePct ?? profile.maxUsagePct,
              })),
          hasPassword: settings.hasPassword,
        })
      })
      .catch((error: Error) => {
        if (active) setLoadError(error.message)
      })
      .finally(() => {
        if (active) setLoading(false)
      })
    return () => {
      active = false
    }
  }, [open, isOperator])

  if (!isOperator) return null

  function handleOpenChange(next: boolean) {
    setOpen(next)
    if (next) {
      setLoading(true)
      setLoadError(null)
      setPreflight(null)
      setEnvironment(null)
    }
  }

  function patch(field: keyof FormState, value: string) {
    setForm((current) => ({ ...current, [field]: value }))
    setPreflight(null)
    setEnvironment(null)
  }

  function patchProfile(
    role: InfrastructureProfile["role"],
    field: keyof Omit<InfrastructureProfile, "role">,
    value: string,
  ) {
    setForm((current) => ({
      ...current,
      profiles: current.profiles.map((profile) =>
        profile.role === role
          ? {
              ...profile,
              [field]: ["cpus", "memoryMb", "systemDiskGb", "maxUsagePct"].includes(field)
                ? Number(value)
                : value,
            }
          : profile,
      ),
    }))
    setPreflight(null)
    setEnvironment(null)
  }

  function patchQualification(
    role: InfrastructureProfile["role"],
    field: keyof ImageQualification,
    value: string | number | boolean | string[] | null,
  ) {
    setForm((current) => ({
      ...current,
      profiles: current.profiles.map((profile) => {
        if (profile.role !== role || !profile.qualification) return profile
        return {
          ...profile,
          qualification: {
            ...profile.qualification,
            [field]: ["windowsBuild", "publicationManifestVersion"].includes(field)
              ? Number(value)
              : value,
            validatedAt: Date.now(),
          },
        }
      }),
    }))
    setPreflight(null)
    setEnvironment(null)
  }

  function addQualification(role: InfrastructureProfile["role"]) {
    setForm((current) => ({
      ...current,
      profiles: current.profiles.map((profile) =>
        profile.role === role
          ? {
              ...profile,
              qualification: {
                baseChangeVersion: "",
                windowsBuild: 26100,
                runnerVersion: "",
                agentSha256: environment?.agentSha256 ?? "",
                validatedAt: Date.now(),
                mlDsa87Available: false,
                systemContextValidated: false,
                timeSynchronized: false,
                windowsUpdatesCurrent: false,
                backendCallbackReachable: false,
                agentCommands: [],
                publicationManifestVersion: 0,
                ocspReferenceSha256: null,
              },
            }
          : profile,
      ),
    }))
    setPreflight(null)
    setEnvironment(null)
  }

  function useBundledAgentDigest() {
    const digest = environment?.agentSha256
    if (!digest) return
    setForm((current) => ({
      ...current,
      profiles: current.profiles.map((profile) =>
        profile.qualification
          ? {
              ...profile,
              qualification: {
                ...profile.qualification,
                agentSha256: digest,
                validatedAt: Date.now(),
              },
            }
          : profile,
      ),
    }))
    setPreflight(null)
    setEnvironment(null)
    toast.success("Bundled agent digest applied. Save and validate again.")
  }

  function payload(): OperatorSettingsUpdate {
    return {
      esxiHost: form.esxiHost.trim(),
      esxiUser: form.esxiUser.trim(),
      ...(form.esxiPassword ? { esxiPassword: form.esxiPassword } : {}),
      esxiPort: Number(form.esxiPort),
      cloneBase: form.cloneBase.trim(),
      cloneDatastore: form.cloneDatastore.trim(),
      cloneGuestOs: form.cloneGuestOs.trim(),
      cloneNetwork: form.cloneNetwork.trim(),
      cloneMaxUsagePct: Number(form.cloneMaxUsagePct),
      guestIpStart: form.guestIpStart.trim(),
      guestIpEnd: form.guestIpEnd.trim(),
      guestPrefix: Number(form.guestPrefix),
      guestGateway: form.guestGateway.trim(),
      guestDns1: form.guestDns1.trim(),
      guestDns2: form.guestDns2.trim(),
      guestDnsSuffix: form.guestDnsSuffix.trim(),
      infrastructureProfiles: form.profiles,
    }
  }

  const formValid =
    !!form.esxiHost.trim() &&
    !!form.esxiUser.trim() &&
    (form.hasPassword || !!form.esxiPassword) &&
    Number(form.esxiPort) > 0 &&
    !!form.cloneBase.trim() &&
    !!form.cloneDatastore.trim() &&
    !!form.cloneGuestOs.trim() &&
    !!form.cloneNetwork.trim() &&
    Number(form.cloneMaxUsagePct) > 0 &&
    Number(form.cloneMaxUsagePct) <= 100 &&
    !!form.guestIpStart.trim() &&
    !!form.guestIpEnd.trim() &&
    Number(form.guestPrefix) >= 1 &&
    Number(form.guestPrefix) <= 32 &&
    !!form.guestGateway.trim() &&
    !!form.guestDns1.trim() &&
    form.profiles.every((profile) =>
      !!profile.base.trim() && !!profile.datastore.trim() &&
      !!profile.expectedGuestOs.trim() && !!profile.network.trim() &&
      profile.cpus > 0 && profile.memoryMb >= 1024 &&
      profile.systemDiskGb >= 32 && profile.maxUsagePct > 0 &&
      profile.maxUsagePct <= 100,
    )

  async function save(showToast = true) {
    setSaving(true)
    try {
      const saved = await updateSettings(payload())
      setForm((current) => ({
        ...current,
        esxiPassword: "",
        hasPassword: saved.hasPassword,
      }))
      if (showToast) toast.success("Infrastructure settings saved.")
      return true
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "Could not save settings.")
      return false
    } finally {
      setSaving(false)
    }
  }

  async function runValidation() {
    setPreflight(null)
    setEnvironment(null)
    const saved = await save(false)
    if (!saved) return
    setValidating(true)
    try {
      const [result, controlPlane] = await Promise.all([
        validateInfrastructure(),
        validateEnvironment(),
      ])
      setPreflight(result)
      setEnvironment(controlPlane)
      if (result.ready && controlPlane.ready) toast.success("Infrastructure is deploy-ready.")
      else toast.error("Infrastructure validation found blocking issues.")
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "Validation failed.")
    } finally {
      setValidating(false)
    }
  }

  return (
    <AlertDialog.Root open={open} onOpenChange={handleOpenChange}>
      <AlertDialog.Trigger
        render={
          <Button variant="ghost" size="icon-sm" aria-label="Settings" title="Settings">
            <Settings className="h-4 w-4" />
          </Button>
        }
      />
      <AlertDialog.Portal>
        <AlertDialog.Backdrop className="fixed inset-0 z-50 bg-black/40 backdrop-blur-[1px] data-open:animate-in data-open:fade-in-0 data-closed:animate-out data-closed:fade-out-0" />
        <AlertDialog.Popup className="fixed left-1/2 top-1/2 z-50 max-h-[calc(100svh-2rem)] w-[min(620px,calc(100vw-2rem))] -translate-x-1/2 -translate-y-1/2 overflow-y-auto rounded-xl border bg-popover p-5 text-popover-foreground shadow-lg ring-1 ring-foreground/10 data-open:animate-in data-open:fade-in-0 data-open:zoom-in-95 data-closed:animate-out data-closed:fade-out-0 data-closed:zoom-out-95">
          <AlertDialog.Title className="text-sm font-semibold">
            Infrastructure settings
          </AlertDialog.Title>
          <AlertDialog.Description className="mt-2 text-xs text-muted-foreground">
            Configure ESXi, guest addressing, and per-role placement, then prove
            the complete four-machine reservation before cloning.
          </AlertDialog.Description>

          {loading ? (
            <div className="flex items-center gap-2 py-10 text-xs text-muted-foreground">
              <Loader2 className="h-4 w-4 animate-spin" /> Loading settings…
            </div>
          ) : loadError ? (
            <div className="mt-4 rounded-lg border border-destructive/40 bg-destructive/5 p-3 text-xs text-destructive">
              {loadError}
            </div>
          ) : (
            <div className="mt-5 space-y-5">
              <section>
                <h3 className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">
                  ESXi target
                </h3>
                <div className="mt-3 grid gap-3 sm:grid-cols-2">
                  <div className="space-y-1.5">
                    <Label htmlFor="esxi-host">Host</Label>
                    <Input id="esxi-host" value={form.esxiHost} onChange={(event) => patch("esxiHost", event.target.value)} placeholder="192.168.100.10" />
                  </div>
                  <div className="space-y-1.5">
                    <Label htmlFor="esxi-port">Port</Label>
                    <Input id="esxi-port" type="number" min="1" max="65535" value={form.esxiPort} onChange={(event) => patch("esxiPort", event.target.value)} />
                  </div>
                  <div className="space-y-1.5">
                    <Label htmlFor="esxi-user">Username</Label>
                    <Input id="esxi-user" value={form.esxiUser} onChange={(event) => patch("esxiUser", event.target.value)} placeholder="root" />
                  </div>
                  <div className="space-y-1.5">
                    <Label htmlFor="esxi-password">Password</Label>
                    <Input id="esxi-password" type="password" value={form.esxiPassword} onChange={(event) => patch("esxiPassword", event.target.value)} placeholder={form.hasPassword ? "Saved — enter to replace" : "Required"} />
                  </div>
                </div>
              </section>

              <section className="border-t pt-5">
                <h3 className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">
                  Guest network
                </h3>
                <div className="mt-3 grid gap-3 sm:grid-cols-3">
                  <div className="space-y-1.5"><Label htmlFor="guest-start">IP range start</Label><Input id="guest-start" value={form.guestIpStart} onChange={(event) => patch("guestIpStart", event.target.value)} /></div>
                  <div className="space-y-1.5"><Label htmlFor="guest-end">IP range end</Label><Input id="guest-end" value={form.guestIpEnd} onChange={(event) => patch("guestIpEnd", event.target.value)} /></div>
                  <div className="space-y-1.5"><Label htmlFor="guest-prefix">Prefix</Label><Input id="guest-prefix" type="number" min="1" max="32" value={form.guestPrefix} onChange={(event) => patch("guestPrefix", event.target.value)} /></div>
                  <div className="space-y-1.5"><Label htmlFor="guest-gateway">Gateway</Label><Input id="guest-gateway" value={form.guestGateway} onChange={(event) => patch("guestGateway", event.target.value)} /></div>
                  <div className="space-y-1.5"><Label htmlFor="guest-dns1">Primary DNS</Label><Input id="guest-dns1" value={form.guestDns1} onChange={(event) => patch("guestDns1", event.target.value)} /></div>
                  <div className="space-y-1.5"><Label htmlFor="guest-dns2">Secondary DNS</Label><Input id="guest-dns2" value={form.guestDns2} onChange={(event) => patch("guestDns2", event.target.value)} /></div>
                  <div className="space-y-1.5 sm:col-span-3"><Label htmlFor="guest-suffix">DNS suffix</Label><Input id="guest-suffix" value={form.guestDnsSuffix} onChange={(event) => patch("guestDnsSuffix", event.target.value)} placeholder="encon.pki" /></div>
                </div>
              </section>

              <section className="border-t pt-5">
                <h3 className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">
                  Windows Server golden image
                </h3>
                <div className="mt-3 grid gap-3 sm:grid-cols-2">
                  <div className="space-y-1.5">
                    <Label htmlFor="clone-base">Inventory name</Label>
                    <Input id="clone-base" value={form.cloneBase} onChange={(event) => patch("cloneBase", event.target.value)} />
                  </div>
                  <div className="space-y-1.5">
                    <Label htmlFor="clone-datastore">Datastore</Label>
                    <Input id="clone-datastore" value={form.cloneDatastore} onChange={(event) => patch("cloneDatastore", event.target.value)} />
                  </div>
                  <div className="space-y-1.5">
                    <Label htmlFor="clone-guest-os">Expected VMware guest OS</Label>
                    <Input id="clone-guest-os" value={form.cloneGuestOs} onChange={(event) => patch("cloneGuestOs", event.target.value)} />
                  </div>
                  <div className="space-y-1.5">
                    <Label htmlFor="clone-usage">Maximum datastore usage (%)</Label>
                    <Input id="clone-usage" type="number" min="1" max="100" step="0.1" value={form.cloneMaxUsagePct} onChange={(event) => patch("cloneMaxUsagePct", event.target.value)} />
                  </div>
                </div>
              </section>

              <section className="border-t pt-5">
                <h3 className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">
                  Role images and sizing
                </h3>
                <div className="mt-3 space-y-4">
                  {form.profiles.map((profile) => (
                    <div key={profile.role} className="rounded-lg border p-3">
                      <h4 className="text-xs font-medium">{ROLE_LABELS[profile.role]}</h4>
                      <div className="mt-3 grid gap-3 sm:grid-cols-4">
                        <div className="space-y-1.5 sm:col-span-2"><Label>Image</Label><Input value={profile.base} onChange={(event) => patchProfile(profile.role, "base", event.target.value)} /></div>
                        <div className="space-y-1.5"><Label>Datastore</Label><Input value={profile.datastore} onChange={(event) => patchProfile(profile.role, "datastore", event.target.value)} /></div>
                        <div className="space-y-1.5"><Label>Port group</Label><Input value={profile.network} onChange={(event) => patchProfile(profile.role, "network", event.target.value)} /></div>
                        <div className="space-y-1.5 sm:col-span-2"><Label>VMware guest OS</Label><Input value={profile.expectedGuestOs} onChange={(event) => patchProfile(profile.role, "expectedGuestOs", event.target.value)} /></div>
                        <div className="space-y-1.5"><Label>vCPU</Label><Input type="number" min="1" value={profile.cpus} onChange={(event) => patchProfile(profile.role, "cpus", event.target.value)} /></div>
                        <div className="space-y-1.5"><Label>Memory (MiB)</Label><Input type="number" min="1024" step="1024" value={profile.memoryMb} onChange={(event) => patchProfile(profile.role, "memoryMb", event.target.value)} /></div>
                        <div className="space-y-1.5"><Label>Disk reservation (GiB)</Label><Input type="number" min="32" value={profile.systemDiskGb} onChange={(event) => patchProfile(profile.role, "systemDiskGb", event.target.value)} /></div>
                        <div className="space-y-1.5"><Label>Usage limit (%)</Label><Input type="number" min="1" max="100" value={profile.maxUsagePct} onChange={(event) => patchProfile(profile.role, "maxUsagePct", event.target.value)} /></div>
                      </div>
                      {profile.qualification ? (
                        <div className="mt-3 border-t pt-3">
                          <div className="grid gap-3 sm:grid-cols-3">
                            <div className="space-y-1.5"><Label>Qualified image revision</Label><Input value={profile.qualification.baseChangeVersion} onChange={(event) => patchQualification(profile.role, "baseChangeVersion", event.target.value)} /></div>
                            <div className="space-y-1.5"><Label>Windows build</Label><Input type="number" min="26100" value={profile.qualification.windowsBuild} onChange={(event) => patchQualification(profile.role, "windowsBuild", event.target.value)} /></div>
                            <div className="space-y-1.5"><Label>Runner version</Label><Input value={profile.qualification.runnerVersion} onChange={(event) => patchQualification(profile.role, "runnerVersion", event.target.value)} /></div>
                            <div className="space-y-1.5 sm:col-span-3"><Label>Agent SHA-256</Label><Input value={profile.qualification.agentSha256} onChange={(event) => patchQualification(profile.role, "agentSha256", event.target.value)} /></div>
                            <div className="space-y-1.5 sm:col-span-2"><Label>Qualified agent commands</Label><Input value={profile.qualification.agentCommands.join(", ")} onChange={(event) => patchQualification(profile.role, "agentCommands", event.target.value.split(",").map((item) => item.trim()).filter(Boolean))} /></div>
                            <div className="space-y-1.5"><Label>Publication manifest version</Label><Input type="number" min="1" value={profile.qualification.publicationManifestVersion} onChange={(event) => patchQualification(profile.role, "publicationManifestVersion", Number(event.target.value))} /></div>
                            {profile.role === "webServer" && <div className="space-y-1.5 sm:col-span-3"><Label>OCSP reference dump SHA-256</Label><Input value={profile.qualification.ocspReferenceSha256 ?? ""} onChange={(event) => patchQualification(profile.role, "ocspReferenceSha256", event.target.value || null)} /></div>}
                          </div>
                          <div className="mt-3 flex flex-wrap gap-4 text-xs text-muted-foreground">
                            <label className="flex items-center gap-2"><input type="checkbox" checked={profile.qualification.systemContextValidated} onChange={(event) => patchQualification(profile.role, "systemContextValidated", event.target.checked)} /> SYSTEM operations validated</label>
                            <label className="flex items-center gap-2"><input type="checkbox" checked={profile.qualification.timeSynchronized} onChange={(event) => patchQualification(profile.role, "timeSynchronized", event.target.checked)} /> Time synchronized</label>
                            <label className="flex items-center gap-2"><input type="checkbox" checked={profile.qualification.windowsUpdatesCurrent} onChange={(event) => patchQualification(profile.role, "windowsUpdatesCurrent", event.target.checked)} /> Windows updates current</label>
                            <label className="flex items-center gap-2"><input type="checkbox" checked={profile.qualification.backendCallbackReachable} onChange={(event) => patchQualification(profile.role, "backendCallbackReachable", event.target.checked)} /> Backend callback reached</label>
                            {(profile.role === "rootCa" || profile.role === "issuingCa") && <label className="flex items-center gap-2"><input type="checkbox" checked={profile.qualification.mlDsa87Available} onChange={(event) => patchQualification(profile.role, "mlDsa87Available", event.target.checked)} /> ML-DSA-87 provider validated</label>}
                          </div>
                        </div>
                      ) : (
                        <Button className="mt-3" variant="outline" size="sm" onClick={() => addQualification(profile.role)}>
                          Add canary qualification
                        </Button>
                      )}
                    </div>
                  ))}
                </div>
              </section>

              {preflight && (
                <section className="rounded-lg border bg-muted/30 p-3">
                  <div className="flex items-center justify-between gap-3">
                    <div className="flex items-center gap-2 text-sm font-medium">
                      {preflight.ready ? <ShieldCheck className="h-4 w-4 text-emerald-500" /> : <CircleAlert className="h-4 w-4 text-destructive" />}
                      {preflight.ready ? "Image ready" : "Action required"}
                    </div>
                    <span className="text-[10px] text-muted-foreground">
                      reserve {formatBytes(preflight.datastores.reduce((sum, item) => sum + (item.reservedBytes ?? 0), 0))}
                    </span>
                  </div>
                  <ul className="mt-3 space-y-2">
                    {preflight.checks.map((check) => (
                      <li key={check.key} className="flex items-start gap-2 text-xs">
                        {check.ok ? <CheckCircle2 className="mt-0.5 h-3.5 w-3.5 shrink-0 text-emerald-500" /> : <CircleAlert className="mt-0.5 h-3.5 w-3.5 shrink-0 text-destructive" />}
                        <span className={check.ok ? "text-muted-foreground" : "text-destructive"}>{check.detail}</span>
                      </li>
                    ))}
                  </ul>
                </section>
              )}
              {environment && (
                <section className="rounded-lg border bg-muted/30 p-3">
                  <div className="flex items-center gap-2 text-sm font-medium">
                    {environment.ready ? <ShieldCheck className="h-4 w-4 text-emerald-500" /> : <CircleAlert className="h-4 w-4 text-destructive" />}
                    {environment.ready ? "Control plane ready" : "Control plane action required"}
                  </div>
                  <ul className="mt-3 space-y-2">
                    {environment.checks.map((check) => (
                      <li key={check.key} className="flex items-start gap-2 text-xs">
                        {check.ok ? <CheckCircle2 className="mt-0.5 h-3.5 w-3.5 shrink-0 text-emerald-500" /> : <CircleAlert className="mt-0.5 h-3.5 w-3.5 shrink-0 text-destructive" />}
                        <span className={check.ok ? "text-muted-foreground" : "text-destructive"}>{check.detail}</span>
                      </li>
                    ))}
                  </ul>
                  {environment.agentSha256 && environment.checks.some((check) => check.key === "agentBinary" && !check.ok) && (
                    <div className="mt-3 border-t pt-3">
                      <p className="text-xs text-muted-foreground">
                        The agent is injected into each clone&apos;s first-boot ISO; it does not belong in the base VM. If this binary has already passed your image canary, apply its digest to the existing role qualifications.
                      </p>
                      <Button className="mt-2" variant="outline" size="sm" onClick={useBundledAgentDigest}>
                        Use bundled agent digest
                      </Button>
                    </div>
                  )}
                </section>
              )}
            </div>
          )}

          <div className="mt-5 flex flex-wrap justify-end gap-2 border-t pt-4">
            <Button variant="ghost" size="sm" onClick={() => setOpen(false)}>
              Close
            </Button>
            <Button variant="outline" size="sm" disabled={loading || saving || validating || !formValid} onClick={() => void save()}>
              {saving && !validating ? <Loader2 className="animate-spin" /> : null}
              Save
            </Button>
            <Button size="sm" disabled={loading || saving || validating || !formValid} onClick={() => void runValidation()}>
              {validating ? <Loader2 className="animate-spin" /> : <ShieldCheck />}
              Validate infrastructure
            </Button>
          </div>
        </AlertDialog.Popup>
      </AlertDialog.Portal>
    </AlertDialog.Root>
  )
}
