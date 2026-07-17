import type * as React from "react"
import { AlertDialog } from "@base-ui/react/alert-dialog"

import { cn } from "@/lib/utils"

/**
 * Reusable confirmation/form dialog shell, extracted from the
 * AlertDialog-backdrop-plus-popup pattern used throughout the operator app
 * (frontend/src/components/canvas/StagedRemoveDialog.tsx,
 * DomainConfirmDialog.tsx). Every dimension here comes from a token: padding
 * from --pad-card/--gap-*, radius from the derived --radius-* scale — none of
 * it is a bare Tailwind number.
 */

const Dialog = AlertDialog.Root
const DialogTrigger = AlertDialog.Trigger
const DialogPortal = AlertDialog.Portal

function DialogBackdrop({ className, ...props }: AlertDialog.Backdrop.Props) {
  return (
    <AlertDialog.Backdrop
      data-slot="dialog-backdrop"
      className={cn(
        "fixed inset-0 z-50 bg-black/40 backdrop-blur-[1px] data-open:animate-in data-open:fade-in-0 data-closed:animate-out data-closed:fade-out-0",
        className
      )}
      {...props}
    />
  )
}

function DialogPopup({ className, ...props }: AlertDialog.Popup.Props) {
  return (
    <AlertDialog.Popup
      data-slot="dialog-popup"
      className={cn(
        "fixed left-1/2 top-1/2 z-50 max-h-[calc(100svh-2rem)] w-[min(480px,calc(100vw-2rem))] -translate-x-1/2 -translate-y-1/2 overflow-y-auto rounded-xl border bg-popover p-(--pad-card) text-popover-foreground shadow-lg ring-1 ring-foreground/10 data-open:animate-in data-open:fade-in-0 data-open:zoom-in-95 data-closed:animate-out data-closed:fade-out-0 data-closed:zoom-out-95",
        className
      )}
      {...props}
    />
  )
}

function DialogTitle({ className, ...props }: AlertDialog.Title.Props) {
  return (
    <AlertDialog.Title
      data-slot="dialog-title"
      className={cn("text-sm font-semibold", className)}
      {...props}
    />
  )
}

function DialogDescription({ className, ...props }: AlertDialog.Description.Props) {
  return (
    <AlertDialog.Description
      data-slot="dialog-description"
      className={cn("mt-(--gap-inline) text-xs text-muted-foreground", className)}
      {...props}
    />
  )
}

function DialogFooter({ className, ...props }: React.ComponentProps<"div">) {
  return (
    <div
      data-slot="dialog-footer"
      className={cn(
        "mt-(--gap-stack) flex flex-wrap justify-end gap-(--gap-inline) border-t pt-(--gap-row)",
        className
      )}
      {...props}
    />
  )
}

function DialogBody({ className, ...props }: React.ComponentProps<"div">) {
  return (
    <div
      data-slot="dialog-body"
      className={cn("mt-(--gap-stack) space-y-(--gap-stack)", className)}
      {...props}
    />
  )
}

export {
  Dialog,
  DialogTrigger,
  DialogPortal,
  DialogBackdrop,
  DialogPopup,
  DialogTitle,
  DialogDescription,
  DialogFooter,
  DialogBody,
}
