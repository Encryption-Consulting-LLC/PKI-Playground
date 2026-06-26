import { useEffect } from "react"
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
import { ThemeToggle } from "@/components/ThemeToggle"
import { Workspace } from "@/components/canvas/Workspace"
import { useApplyTheme } from "@/hooks/useTheme"

function App() {
  // Apply the resolved theme to <html> on every render. Must be called before
  // any early returns so theme applies to the splash / login screens too.
  useApplyTheme()

  const token = useAuthStore((s) => s.token)
  const host = useAuthStore((s) => s.host)

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

  // In guest mode, auto-connect once the mode is known and no session exists.
  useEffect(() => {
    if (meta?.mode === AUTH_MODES.guest && !token && autoConnect.isIdle) {
      autoConnect.mutate()
    }
  }, [meta, token, autoConnect])

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
          {host && (
            <p className="hidden text-xs text-muted-foreground sm:block">{host}</p>
          )}
        </div>
        <div className="flex shrink-0 items-center gap-3">
          <HealthBadge />
          {isGuest ? (
            <Badge variant="secondary">Guest</Badge>
          ) : (
            <LogoutButton />
          )}
          <ThemeToggle />
        </div>
      </header>

      {/* Canvas workspace — takes the remaining viewport height */}
      <Workspace />
    </div>
  )
}

export default App
