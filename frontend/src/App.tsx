import { useEffect } from "react"
import { useMutation, useQuery } from "@tanstack/react-query"
import { toast } from "sonner"
import { AUTH_MODES, QUERY_KEYS } from "@/constants"
import { ApiError, getMode, guestConnect } from "@/lib/api"
import { useAuthStore } from "@/store/auth"
import { Badge } from "@/components/ui/badge"
import { HealthBadge } from "@/components/HealthBadge"
import { HostnameForm } from "@/components/HostnameForm"
import { LoginForm } from "@/components/LoginForm"
import { LogoutButton } from "@/components/LogoutButton"
import { Splash } from "@/components/Splash"

function App() {
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
    // Guest mode: auto-connect in flight (or failed — toast already shown).
    return <Splash label="Connecting to playground…" />
  }

  const isGuest = meta?.mode === AUTH_MODES.guest

  return (
    <div className="mx-auto min-h-svh max-w-3xl px-6 py-10">
      <header className="mb-8 flex items-center justify-between gap-4">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight">EC-PKI-Playground</h1>
          <p className="text-sm text-muted-foreground">
            Web console over the vmkit / configgen / isokit deployment API.
          </p>
        </div>
        <div className="flex shrink-0 items-center gap-3">
          {host && (
            <span className="hidden text-sm text-muted-foreground sm:block">
              {host}
            </span>
          )}
          <HealthBadge />
          {isGuest ? (
            <Badge variant="secondary">Guest</Badge>
          ) : (
            <LogoutButton />
          )}
        </div>
      </header>

      <main className="space-y-6">
        <HostnameForm />
      </main>
    </div>
  )
}

export default App
