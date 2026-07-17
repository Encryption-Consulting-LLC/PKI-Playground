import { useEffect, useRef, useState } from "react"
import { useMutation, useQuery } from "@tanstack/react-query"
import { toast } from "sonner"
import { QUERY_KEYS } from "@/constants"
import {
  ApiError,
  getAuthConfig,
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

/**
 * Admin login screen — same POST /auth/login + OIDC code-flow convention as
 * frontend/src/components/LoginForm.tsx. Any account can sign in here; role
 * is checked afterward by App.tsx (an "operators only" screen for anyone
 * else) — the backend independently 403s every admin route regardless.
 */
export function LoginForm() {
  const [username, setUsername] = useState("")
  const [password, setPassword] = useState("")

  const { data: config } = useQuery({
    queryKey: QUERY_KEYS.config,
    queryFn: getAuthConfig,
  })

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
    <div className="flex min-h-svh items-center justify-center px-(--pad-page) py-10">
      <Card className="w-full max-w-md">
        <CardHeader>
          <CardTitle>EC PKI Playground — Admin</CardTitle>
          <CardDescription>Sign in with an operator account to continue.</CardDescription>
        </CardHeader>
        <CardContent>
          <form
            className="grid gap-(--gap-stack)"
            onSubmit={(e) => {
              e.preventDefault()
              loginMutation.mutate({ username, password })
            }}
          >
            <div className="grid gap-(--gap-inline)">
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

            <div className="grid gap-(--gap-inline)">
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

            <Button type="submit" className="mt-(--gap-inline) w-full" disabled={loginMutation.isPending}>
              {loginMutation.isPending ? "Signing in…" : "Sign in"}
            </Button>

            {config?.oidcEnabled && (
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
