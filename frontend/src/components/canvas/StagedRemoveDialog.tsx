import { AlertDialog } from "@base-ui/react/alert-dialog"

import { Button } from "@/components/ui/button"
import type { StagedOp } from "@/lib/staging"

/**
 * Confirmation prompt shown before a staged op (or a node carrying staged
 * ops) is removed along with everything that transitively depends on it.
 * Structurally a clone of `DomainConfirmDialog` — same AlertDialog shell,
 * different content. Cancelling leaves the staging list untouched.
 */
export function StagedRemoveDialog({
  ops,
  onConfirm,
  onCancel,
}: {
  /** `[op, ...dependents]`, or null when nothing is pending removal. */
  ops: StagedOp[] | null
  onConfirm: () => void
  onCancel: () => void
}) {
  const open = !!ops && ops.length > 0
  const list = ops ?? []
  const count = list.length

  return (
    <AlertDialog.Root
      open={open}
      onOpenChange={(next) => {
        if (!next) onCancel()
      }}
    >
      <AlertDialog.Portal>
        <AlertDialog.Backdrop className="fixed inset-0 z-50 bg-black/40 backdrop-blur-[1px] data-open:animate-in data-open:fade-in-0 data-closed:animate-out data-closed:fade-out-0" />
        <AlertDialog.Popup className="fixed left-1/2 top-1/2 z-50 w-[min(420px,calc(100vw-2rem))] -translate-x-1/2 -translate-y-1/2 rounded-xl border bg-popover p-5 text-popover-foreground shadow-lg ring-1 ring-foreground/10 data-open:animate-in data-open:fade-in-0 data-open:zoom-in-95 data-closed:animate-out data-closed:fade-out-0 data-closed:zoom-out-95">
          <AlertDialog.Title className="text-sm font-semibold">
            Remove {count === 1 ? "this operation" : `${count} operations`}?
          </AlertDialog.Title>
          <AlertDialog.Description className="mt-2 text-xs text-muted-foreground">
            {count === 1
              ? "This operation depends on nothing else, but removing it will undo:"
              : `Removing this will also undo ${count - 1} dependent ${count - 1 === 1 ? "operation" : "operations"}:`}
          </AlertDialog.Description>
          <ul className="mt-2 max-h-40 list-disc space-y-1 overflow-y-auto pl-4 text-xs text-muted-foreground">
            {list.map((op) => (
              <li key={op.id}>{op.label}</li>
            ))}
          </ul>
          <div className="mt-5 flex justify-end gap-2">
            <Button variant="outline" size="sm" onClick={onCancel}>
              Cancel
            </Button>
            <Button variant="destructive" size="sm" onClick={onConfirm}>
              Remove {count === 1 ? "operation" : `${count} operations`}
            </Button>
          </div>
        </AlertDialog.Popup>
      </AlertDialog.Portal>
    </AlertDialog.Root>
  )
}
