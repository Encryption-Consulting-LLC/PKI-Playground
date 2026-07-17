/**
 * Persisted theme preference store.
 *
 * Three values: "light" | "dark" | "system". "system" resolves to light or
 * dark at runtime via matchMedia (see hooks/useTheme.ts). The resolved .dark
 * class on <html> is toggled by useApplyTheme() in App.tsx.
 *
 * Uses the same localStorage key as the operator app (STORAGE_KEYS.theme):
 * both apps are served same-origin, so a theme choice made in one is honored
 * in the other with no extra sync code.
 */

import { create } from "zustand"
import { persist } from "zustand/middleware"

import { STORAGE_KEYS } from "@/constants"

export type ThemePreference = "light" | "dark" | "system"

interface ThemeState {
  theme: ThemePreference
  setTheme: (t: ThemePreference) => void
}

export const useThemeStore = create<ThemeState>()(
  persist(
    (set) => ({
      theme: "system",
      setTheme: (t) => set({ theme: t }),
    }),
    { name: STORAGE_KEYS.theme },
  ),
)
