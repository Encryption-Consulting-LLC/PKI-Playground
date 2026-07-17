import { Menu } from "@base-ui/react/menu"
import { Check, Monitor, Moon, Sun } from "lucide-react"

import { Button } from "@/components/ui/button"
import { useThemeStore, type ThemePreference } from "@/store/theme"

const OPTIONS: {
  value: ThemePreference
  icon: React.ElementType
  label: string
}[] = [
  { value: "system", icon: Monitor, label: "System" },
  { value: "light", icon: Sun, label: "Light" },
  { value: "dark", icon: Moon, label: "Dark" },
]

/**
 * Single-icon theme switcher.
 * The trigger shows the icon for the current preference; clicking it opens a
 * dropdown to pick System / Light / Dark. Reads from / writes to the persisted
 * theme store.
 */
export function ThemeToggle() {
  const theme = useThemeStore((s) => s.theme)
  const setTheme = useThemeStore((s) => s.setTheme)

  const Active = (OPTIONS.find((o) => o.value === theme) ?? OPTIONS[0]).icon

  return (
    <Menu.Root>
      <Menu.Trigger
        render={
          <Button
            variant="ghost"
            size="icon-sm"
            aria-label="Theme"
            title="Theme"
          >
            <Active className="h-4 w-4" />
          </Button>
        }
      />
      <Menu.Portal>
        <Menu.Positioner
          side="bottom"
          align="end"
          sideOffset={6}
          className="isolate z-50"
        >
          <Menu.Popup className="min-w-36 origin-(--transform-origin) rounded-lg bg-popover p-1 text-popover-foreground shadow-md ring-1 ring-foreground/10 duration-100 data-open:animate-in data-open:fade-in-0 data-open:zoom-in-95 data-closed:animate-out data-closed:fade-out-0 data-closed:zoom-out-95">
            <Menu.RadioGroup
              value={theme}
              onValueChange={(v) => setTheme(v as ThemePreference)}
            >
              {OPTIONS.map(({ value, icon: Icon, label }) => (
                <Menu.RadioItem
                  key={value}
                  value={value}
                  className="relative flex w-full cursor-default items-center gap-2 rounded-md py-1 pr-8 pl-2 text-sm outline-hidden select-none data-highlighted:bg-accent data-highlighted:text-accent-foreground"
                >
                  <Icon className="h-4 w-4" />
                  <span className="flex-1">{label}</span>
                  <Menu.RadioItemIndicator className="absolute right-2 flex size-4 items-center justify-center">
                    <Check className="size-4" />
                  </Menu.RadioItemIndicator>
                </Menu.RadioItem>
              ))}
            </Menu.RadioGroup>
          </Menu.Popup>
        </Menu.Positioner>
      </Menu.Portal>
    </Menu.Root>
  )
}
