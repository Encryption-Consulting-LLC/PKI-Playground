import { useState } from "react"
import { Network, Rocket, Server, ShieldAlert, Users2 } from "lucide-react"

import { ROLES } from "@/constants"
import { useAuthStore } from "@/store/auth"
import { AppShell, type NavItem } from "@/components/AppShell"
import { LoginForm } from "@/components/LoginForm"
import { LogoutButton } from "@/components/LogoutButton"
import { Splash } from "@/components/Splash"
import { useApplyTheme } from "@/hooks/useTheme"
import { useMe } from "@/hooks/useMe"
import { UsersSection } from "@/sections/UsersSection"
import { InfrastructureSection } from "@/sections/InfrastructureSection"
import { IpPoolSection } from "@/sections/IpPoolSection"
import { RegistrySection } from "@/sections/RegistrySection"
import { DeploymentsSection } from "@/sections/DeploymentsSection"

const SECTIONS: NavItem[] = [
  { id: "users", label: "Accounts", icon: Users2 },
  { id: "infrastructure", label: "Infrastructure", icon: Server },
  { id: "deployments", label: "Deployments", icon: Rocket },
  { id: "ip-pool", label: "IP Pool", icon: Network },
  { id: "registry", label: "VM Registry", icon: ShieldAlert },
]

function App() {
  // Apply the resolved theme to <html> on every render, before any early
  // return, so the login/splash/denied screens are themed too.
  useApplyTheme()

  const token = useAuthStore((s) => s.token)
  const [active, setActive] = useState("users")

  // Called unconditionally (before any early return) so hook order stays
  // stable across renders — useMe() internally no-ops via `enabled: !!token`
  // until a session exists.
  const me = useMe()

  if (!token) return <LoginForm />
  if (!me) return <Splash label="Loading session…" />

  if (me.role !== ROLES.admin) {
    return (
      <div className="flex min-h-svh flex-col items-center justify-center gap-(--gap-row) px-(--pad-page) text-center">
        <ShieldAlert className="size-8 text-warning" />
        <p className="text-sm font-medium">This console is for admins only.</p>
        <p className="max-w-sm text-xs text-muted-foreground">
          Your account ({me.username}) doesn&apos;t have admin access. Sign out and use an admin
          account, or ask an admin to provision one for you.
        </p>
        <LogoutButton />
      </div>
    )
  }

  return (
    <AppShell username={me.username} sections={SECTIONS} active={active} onSelect={setActive}>
      {active === "users" && <UsersSection />}
      {active === "infrastructure" && <InfrastructureSection />}
      {active === "deployments" && <DeploymentsSection />}
      {active === "ip-pool" && <IpPoolSection />}
      {active === "registry" && <RegistrySection />}
    </AppShell>
  )
}

export default App
