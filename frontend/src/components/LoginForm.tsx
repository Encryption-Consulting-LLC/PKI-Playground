import { useState } from "react"
import { useMutation } from "@tanstack/react-query"
import { toast } from "sonner"
import { ApiError, connect, type ConnectRequest } from "@/lib/api"
import { useAuthStore } from "@/store/auth"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card"

/** Login form — POST /auth/connect. On success, writes the session into the
 *  auth store (persisted to localStorage) and the app gates to the console. */
export function LoginForm() {
  const [host, setHost] = useState("")
  const [user, setUser] = useState("")
  const [password, setPassword] = useState("")
  const [port, setPort] = useState(443)

  const mutation = useMutation({
    mutationFn: (req: ConnectRequest) => connect(req),
    onSuccess: ({ token, host: connectedHost, api_version }) => {
      useAuthStore.getState().setSession({
        token,
        host: connectedHost,
        apiVersion: api_version,
      })
    },
    onError: (err) =>
      toast.error(
        err instanceof ApiError ? `${err.status}: ${err.message}` : String(err),
      ),
  })

  return (
    <div className="flex min-h-svh items-center justify-center px-6 py-10">
      <Card className="w-full max-w-md">
        <CardHeader>
          <CardTitle>EC-PKI-Playground</CardTitle>
          <CardDescription>Connect to an ESXi / vCenter host to continue.</CardDescription>
        </CardHeader>
        <CardContent>
          <form
            className="grid gap-4"
            onSubmit={(e) => {
              e.preventDefault()
              mutation.mutate({ host, user, password, port })
            }}
          >
            <div className="grid gap-2">
              <Label htmlFor="esxi-host">Host</Label>
              <Input
                id="esxi-host"
                placeholder="192.168.1.10"
                value={host}
                onChange={(e) => setHost(e.target.value)}
                required
                autoFocus
              />
            </div>

            <div className="grid grid-cols-[1fr_100px] gap-3">
              <div className="grid gap-2">
                <Label htmlFor="esxi-user">Username</Label>
                <Input
                  id="esxi-user"
                  placeholder="root"
                  autoComplete="username"
                  value={user}
                  onChange={(e) => setUser(e.target.value)}
                  required
                />
              </div>
              <div className="grid gap-2">
                <Label htmlFor="esxi-port">Port</Label>
                <Input
                  id="esxi-port"
                  type="number"
                  min={1}
                  max={65535}
                  value={port}
                  onChange={(e) => setPort(Number(e.target.value))}
                  required
                />
              </div>
            </div>

            <div className="grid gap-2">
              <Label htmlFor="esxi-password">Password</Label>
              <Input
                id="esxi-password"
                type="password"
                autoComplete="current-password"
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                required
              />
            </div>

            <Button type="submit" className="mt-2 w-full" disabled={mutation.isPending}>
              {mutation.isPending ? "Connecting…" : "Connect"}
            </Button>
          </form>
        </CardContent>
      </Card>
    </div>
  )
}
