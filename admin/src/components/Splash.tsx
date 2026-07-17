interface SplashProps {
  label?: string
}

/** Full-viewport centered status message — shown while loading or auto-connecting. */
export function Splash({ label = "Loading…" }: SplashProps) {
  return (
    <div className="flex min-h-svh items-center justify-center">
      <p className="text-sm text-muted-foreground">{label}</p>
    </div>
  )
}
