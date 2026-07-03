import { useEffect, useRef, useState } from "react"
import { useMutation, useQuery } from "@tanstack/react-query"
import { toast } from "sonner"
import { QUERY_KEYS } from "@/constants"
import {
  ApiError,
  getMode,
  login,
  oidcCallback,
  oidcLoginUrl,
  type LoginRequest,
  type SessionResponse,
} from "@/lib/api"
import { useAuthStore } from "@/store/auth"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { Splash } from "@/components/Splash"
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card"

function storeSession(s: SessionResponse) {
  useAuthStore.getState().setSession({
    token: s.token,
    username: s.username,
    role: s.role,
    host: s.host,
  })
}

const showError = (err: unknown) =>
  toast.error(err instanceof ApiError ? `${err.status}: ${err.message}` : String(err))

/** Login screen — POST /auth/login with an admin-provisioned account, or the
 *  OIDC SSO flow (redirect out via GET /auth/oidc/login; on return, the
 *  `?code&state` the IdP appended is exchanged at POST /auth/oidc/callback).
 *  On success, writes the session into the auth store (persisted to
 *  localStorage) and the app gates to the console. */
export function LoginForm() {
  const [username, setUsername] = useState("")
  const [password, setPassword] = useState("")

  const { data: meta } = useQuery({ queryKey: QUERY_KEYS.mode, queryFn: getMode })

  const loginMutation = useMutation({
    mutationFn: (req: LoginRequest) => login(req),
    onSuccess: storeSession,
    onError: showError,
  })

  const ssoStart = useMutation({
    mutationFn: oidcLoginUrl,
    onSuccess: ({ url }) => {
      window.location.assign(url)
    },
    onError: showError,
  })

  const ssoFinish = useMutation({
    mutationFn: ({ code, state }: { code: string; state: string }) =>
      oidcCallback(code, state),
    onSuccess: storeSession,
    onError: showError,
  })

  // Returning leg of the SSO redirect: the IdP sent the browser back with
  // ?code&state on our origin. Exchange exactly once, then scrub the params
  // from the URL so a reload doesn't retry a consumed code.
  const didExchange = useRef(false)
  useEffect(() => {
    if (didExchange.current) return
    const params = new URLSearchParams(window.location.search)
    const code = params.get("code")
    const state = params.get("state")
    if (!code || !state) return
    didExchange.current = true
    window.history.replaceState(null, "", window.location.pathname)
    ssoFinish.mutate({ code, state })
  }, [ssoFinish])

  if (ssoFinish.isPending) return <Splash label="Completing SSO sign-in…" />

  return (
    <div className="flex min-h-svh items-center justify-center px-6 py-10">
      <Card className="w-full max-w-md">
        <CardHeader>
          <CardTitle>EC-PKI-Playground</CardTitle>
          <CardDescription>Sign in with your account to continue.</CardDescription>
        </CardHeader>
        <CardContent>
          <form
            className="grid gap-4"
            onSubmit={(e) => {
              e.preventDefault()
              loginMutation.mutate({ username, password })
            }}
          >
            <div className="grid gap-2">
              <Label htmlFor="login-username">Username</Label>
              <Input
                id="login-username"
                autoComplete="username"
                value={username}
                onChange={(e) => setUsername(e.target.value)}
                required
                autoFocus
              />
            </div>

            <div className="grid gap-2">
              <Label htmlFor="login-password">Password</Label>
              <Input
                id="login-password"
                type="password"
                autoComplete="current-password"
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                required
              />
            </div>

            <Button type="submit" className="mt-2 w-full" disabled={loginMutation.isPending}>
              {loginMutation.isPending ? "Signing in…" : "Sign in"}
            </Button>

            {meta?.oidcEnabled && (
              <Button
                type="button"
                variant="outline"
                className="w-full"
                disabled={ssoStart.isPending}
                onClick={() => ssoStart.mutate()}
              >
                {ssoStart.isPending ? "Redirecting…" : "Sign in with SSO"}
              </Button>
            )}
          </form>
        </CardContent>
      </Card>
    </div>
  )
}
