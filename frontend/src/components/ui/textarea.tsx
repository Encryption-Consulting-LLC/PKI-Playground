import * as React from "react"

import { cn } from "@/lib/utils"

function Textarea({ className, ...props }: React.ComponentProps<"textarea">) {
  return (
    <textarea
      data-slot="textarea"
      className={cn(
        "w-full min-w-0 rounded-lg border border-input bg-transparent px-2.5 py-1.5 text-base transition-colors outline-none placeholder:text-muted-foreground focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/50 disabled:pointer-events-none disabled:cursor-not-allowed disabled:bg-input/50 disabled:opacity-50 aria-invalid:border-destructive aria-invalid:ring-3 aria-invalid:ring-destructive/20 md:text-sm dark:bg-input/30 dark:disabled:bg-input/80 dark:aria-invalid:border-destructive/50 dark:aria-invalid:ring-destructive/40",
        className,
      )}
      {...props}
    />
  )
}

/**
 * Minimal code-editing textarea: monospace, no spellcheck, Tab inserts spaces
 * instead of moving focus. Deliberately not CodeMirror — the authored scripts
 * are ~25 lines and a real editor costs hundreds of KB of bundle; this wrapper
 * is the seam to swap one in later without touching callers.
 */
function CodeEditor({
  value,
  onChange,
  className,
  ...props
}: Omit<React.ComponentProps<"textarea">, "value" | "onChange"> & {
  value: string
  onChange: (value: string) => void
}) {
  function handleKeyDown(e: React.KeyboardEvent<HTMLTextAreaElement>) {
    if (e.key !== "Tab") return
    e.preventDefault()
    const el = e.currentTarget
    const { selectionStart, selectionEnd } = el
    const next =
      value.slice(0, selectionStart) + "    " + value.slice(selectionEnd)
    onChange(next)
    requestAnimationFrame(() => {
      el.selectionStart = el.selectionEnd = selectionStart + 4
    })
  }

  return (
    <Textarea
      value={value}
      onChange={(e) => onChange(e.target.value)}
      onKeyDown={handleKeyDown}
      spellCheck={false}
      autoCapitalize="off"
      autoCorrect="off"
      wrap="off"
      className={cn(
        "font-mono text-xs leading-5 whitespace-pre overflow-auto",
        className,
      )}
      {...props}
    />
  )
}

export { CodeEditor, Textarea }
