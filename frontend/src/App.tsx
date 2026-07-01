import { useEffect, useRef } from "react"
import { useMutation, useQuery } from "@tanstack/react-query"
import { toast } from "sonner"
import { AUTH_MODES, QUERY_KEYS } from "@/constants"
import { ApiError, getMode, guestConnect } from "@/lib/api"
import { useAuthStore } from "@/store/auth"
import { Badge } from "@/components/ui/badge"
import { HealthBadge } from "@/components/HealthBadge"
import { LoginForm } from "@/components/LoginForm"
import { LogoutButton } from "@/components/LogoutButton"
import { Splash } from "@/components/Splash"
import { SettingsDialog } from "@/components/SettingsDialog"
import { ThemeToggle } from "@/components/ThemeToggle"
import { Workspace } from "@/components/canvas/Workspace"
import { useApplyTheme } from "@/hooks/useTheme"
import { useBeforeUnloadWarning } from "@/hooks/useBeforeUnloadWarning"
import { initProjectAutosave } from "@/lib/projectAutosave"
import { useProjectsStore } from "@/store/projects"

function App() {
  // Apply the resolved theme to <html> on every render. Must be called before
  // any early returns so theme applies to the splash / login screens too.
  useApplyTheme()

  useBeforeUnloadWarning()

  const token = useAuthStore((s) => s.token)

  const { data: meta, isLoading: modeLoading } = useQuery({
    queryKey: QUERY_KEYS.mode,
    queryFn: getMode,
  })

  const autoConnect = useMutation({
    mutationFn: guestConnect,
    onSuccess: ({ token, host, api_version }) => {
      useAuthStore.getState().setSession({ token, host, apiVersion: api_version })
    },
    onError: (err) =>
      toast.error(
        err instanceof ApiError ? `${err.status}: ${err.message}` : String(err),
      ),
  })

  // In guest mode, always establish a fresh session on load. A persisted token
  // may be stale: the backend's session store is in-process, so any restart
  // wipes it while localStorage keeps the dead token. Trusting it would send a
  // dead token with the first request (e.g. the standalone clone) and 401.
  // Clear any persisted token first so the splash shows until reconnect lands.
  const didInit = useRef(false)
  useEffect(() => {
    if (meta?.mode !== AUTH_MODES.guest || didInit.current) return
    didInit.current = true
    useAuthStore.getState().clear()
    autoConnect.mutate()
  }, [meta, autoConnect])

  // Once a session exists, load the active project's topology (or bootstrap a
  // default one) and start the autosave bridge. Runs once per session.
  //
  // Gated on `sessionReady` rather than the raw `token`: in guest mode the
  // first render after a reload still has the *stale* persisted token (the
  // `didInit` effect above hasn't cleared it yet), so gating on `token` would
  // run this before `autoConnect` lands — `ensureDefaultProject`'s `loadSnapshot`
  // would call `resumeJobs()` in the brief window where `clear()` already
  // nulled the token but the fresh guest session hasn't arrived yet, making
  // every resumed job socket fail its handshake (401) and revert to
  // `unconfigured`. Waiting for `autoConnect.isSuccess` ensures a live token
  // is in the store before resume runs.
  const sessionReady =
    meta?.mode === AUTH_MODES.guest
      ? autoConnect.isSuccess
      : meta?.mode === AUTH_MODES.login
        ? !!token
        : false
  const didInitProjects = useRef(false)
  useEffect(() => {
    if (!sessionReady || didInitProjects.current) return
    didInitProjects.current = true
    initProjectAutosave()
    useProjectsStore.getState().ensureDefaultProject()
  }, [sessionReady])

  if (modeLoading) return <Splash />

  if (!token) {
    if (meta?.mode === AUTH_MODES.login) return <LoginForm />
    return <Splash label="Connecting to playground…" />
  }

  const isGuest = meta?.mode === AUTH_MODES.guest

  return (
    <div className="flex h-svh flex-col overflow-hidden">
      {/* Top bar */}
      <header className="flex shrink-0 items-center justify-between gap-4 border-b px-4 py-2">
        <div>
          <h1 className="text-base font-semibold tracking-tight">EC PKI Playground</h1>
        </div>
        <div className="flex shrink-0 items-center gap-3">
          <HealthBadge />
          {isGuest ? (
            <Badge variant="secondary">Guest</Badge>
          ) : (
            <LogoutButton />
          )}
          <SettingsDialog />
          <ThemeToggle />
        </div>
      </header>

      {/* Canvas workspace — takes the remaining viewport height */}
      <Workspace />
    </div>
  )
}

export default App
