import * as React from "react"

import { cn } from "@/lib/utils"
import { Input } from "@/components/ui/input"

type FloatingFieldProps = React.ComponentProps<typeof Input> & {
  label: string
}

/**
 * Text field whose label starts as an in-field placeholder and floats up onto
 * the top border once the input is focused or filled — mirrors the Client
 * Portal login's PrimeReact FloatLabel. Driven by React focus/value state (not
 * a CSS sibling selector) so it keeps working through Input's password wrapper.
 * The label's `bg-card` masks the border line it sits on.
 */
function FloatingField({
  id,
  label,
  value,
  className,
  onFocus,
  onBlur,
  ...props
}: FloatingFieldProps) {
  const [focused, setFocused] = React.useState(false)
  const floated = focused || (value != null && String(value).length > 0)

  return (
    <div className="relative">
      <Input
        id={id}
        value={value}
        // Opaque card fill (both themes) so the floated label's bg-card mask is
        // seamless — otherwise dark mode's translucent input tint peeks out
        // below the notch as a darker block.
        className={cn("bg-card dark:bg-card", className)}
        onFocus={(e) => {
          setFocused(true)
          onFocus?.(e)
        }}
        onBlur={(e) => {
          setFocused(false)
          onBlur?.(e)
        }}
        {...props}
      />
      <label
        htmlFor={id}
        className={cn(
          // left-1.5 + px-1 lands the label text at ~10px, exactly over the
          // input's own text (px-2.5) so the placeholder→float move is seamless.
          "pointer-events-none absolute left-1.5 z-10 px-1 text-muted-foreground transition-all duration-150",
          floated
            ? // bg-card only once floated, so the label masks the border line it
              // sits on; unfloated it stays transparent and reads as a placeholder.
              "top-0 -translate-y-1/2 bg-card text-xs"
            : "top-1/2 -translate-y-1/2 text-sm",
        )}
      >
        {label}
      </label>
    </div>
  )
}

export { FloatingField }
