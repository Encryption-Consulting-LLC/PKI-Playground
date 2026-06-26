/**
 * Persisted theme preference store.
 *
 * Three values: "light" | "dark" | "system".
 * "system" resolves to light or dark at runtime via matchMedia (see hooks/useTheme.ts).
 * The resolved .dark class on <html> is toggled by useApplyTheme() in App.tsx.
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
