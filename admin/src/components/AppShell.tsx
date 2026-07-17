import type * as React from "react"
import type { LucideIcon } from "lucide-react"
import { Badge } from "@/components/ui/badge"
import { LogoutButton } from "@/components/LogoutButton"
import { ThemeToggle } from "@/components/ThemeToggle"
import { cn } from "@/lib/utils"

export interface NavItem {
  id: string
  label: string
  icon: LucideIcon
}

interface AppShellProps {
  username: string
  sections: NavItem[]
  active: string
  onSelect: (id: string) => void
  children: React.ReactNode
}

/**
 * Left-nav shell for the admin app — replaces the operator app's single
 * scrolling SettingsDialog with a persistent sidebar of sections, each its
 * own focused view instead of "one after another".
 */
export function AppShell({ username, sections, active, onSelect, children }: AppShellProps) {
  return (
    <div className="flex h-svh overflow-hidden">
      <aside className="flex w-56 shrink-0 flex-col gap-(--gap-stack) border-r bg-sidebar p-(--gap-row) text-sidebar-foreground">
        <div className="px-(--gap-inline) py-(--gap-inline)">
          <img
            src={`${import.meta.env.BASE_URL}ec-logo.png`}
            alt="PQC Playground"
            className="ec-logo mb-1 h-5"
          />
          <p className="text-xs text-muted-foreground">Admin</p>
        </div>
        <nav className="flex flex-1 flex-col gap-1">
          {sections.map(({ id, label, icon: Icon }) => (
            <button
              key={id}
              type="button"
              onClick={() => onSelect(id)}
              data-active={active === id || undefined}
              className={cn(
                "flex items-center gap-(--gap-inline) rounded-lg px-(--pad-control) py-(--gap-inline) text-left text-sm font-medium text-sidebar-foreground/80 transition-colors hover:bg-sidebar-accent hover:text-sidebar-accent-foreground",
                "data-active:bg-sidebar-accent data-active:text-sidebar-accent-foreground",
              )}
            >
              <Icon className="size-4 shrink-0" />
              {label}
            </button>
          ))}
        </nav>
        <div className="border-t px-(--gap-inline) pt-(--gap-row) text-xs text-muted-foreground">
          Signed in as <Badge variant="outline">{username}</Badge>
        </div>
      </aside>

      <div className="flex min-w-0 flex-1 flex-col overflow-hidden">
        <header className="flex shrink-0 items-center justify-between gap-(--gap-row) border-b px-(--pad-section) py-(--gap-row)">
          <h1 className="text-sm font-semibold tracking-tight">
            {sections.find((s) => s.id === active)?.label ?? "Admin"}
          </h1>
          <div className="flex shrink-0 items-center gap-(--gap-inline)">
            <LogoutButton />
            <ThemeToggle />
          </div>
        </header>
        <main className="flex-1 overflow-y-auto p-(--pad-page)">{children}</main>
      </div>
    </div>
  )
}
