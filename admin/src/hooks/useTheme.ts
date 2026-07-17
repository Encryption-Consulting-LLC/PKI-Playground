/**
 * Theme utilities: resolving the stored preference to an actual "light" | "dark"
 * value, and applying it to the document root.
 *
 * useResolvedTheme()
 *   Returns the concrete theme for the current render. When the stored preference
 *   is "system" it reads matchMedia("(prefers-color-scheme: dark)") via
 *   useSyncExternalStore so a live OS appearance change triggers a re-render.
 *
 * useApplyTheme()
 *   Applies the resolved theme to <html> by toggling the "dark" class.
 *   Call this ONCE, at the top of App.tsx, so every screen (splash, login,
 *   sections) gets the correct theme.
 */

import { useEffect, useSyncExternalStore } from "react"
import { useThemeStore } from "@/store/theme"

// ---------------------------------------------------------------------------
// matchMedia subscribe / snapshot helpers (stable references for useSync…)
// ---------------------------------------------------------------------------

function subscribe(callback: () => void): () => void {
  const mq = window.matchMedia("(prefers-color-scheme: dark)")
  mq.addEventListener("change", callback)
  return () => mq.removeEventListener("change", callback)
}

function getSnapshot(): boolean {
  return window.matchMedia("(prefers-color-scheme: dark)").matches
}

// Server-side snapshot — always false (SSR safety; this app is SPA-only).
function getServerSnapshot(): boolean {
  return false
}

// ---------------------------------------------------------------------------
// useResolvedTheme
// ---------------------------------------------------------------------------

export function useResolvedTheme(): "light" | "dark" {
  const theme = useThemeStore((s) => s.theme)
  const systemPrefersDark = useSyncExternalStore(
    subscribe,
    getSnapshot,
    getServerSnapshot,
  )

  if (theme === "system") return systemPrefersDark ? "dark" : "light"
  return theme
}

// ---------------------------------------------------------------------------
// useApplyTheme
// ---------------------------------------------------------------------------

export function useApplyTheme(): void {
  const resolved = useResolvedTheme()

  useEffect(() => {
    document.documentElement.classList.toggle("dark", resolved === "dark")
  }, [resolved])
}
