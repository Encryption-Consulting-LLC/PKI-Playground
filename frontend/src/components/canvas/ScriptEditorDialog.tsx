import { useState } from "react"
import { Dialog } from "@base-ui/react/dialog"
import { toast } from "sonner"

import { ISO_FILE_MAX_BYTES, ISO_FILE_NAME_RE } from "@/constants/iso"
import type { IsoFileEntry } from "@/store/topology"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { CodeEditor } from "@/components/ui/textarea"

/**
 * Double-click-to-edit dialog for one authored firstboot script (PACK mode).
 * Same Dialog shell styling as `StagedRemoveDialog`'s AlertDialog. Renames are
 * ordinary edits — save validates the (possibly new) filename against the
 * shared regex and the sibling set, mirroring the backend's checks.
 */
export function ScriptEditorDialog({
  file,
  siblings,
  onSave,
  onDelete,
  onClose,
}: {
  /** The script being edited, or null when the dialog is closed. */
  file: IsoFileEntry | null
  /** Names of the other files in the panel — the rename-collision set. */
  siblings: string[]
  onSave: (previousName: string, next: IsoFileEntry) => void
  onDelete: (name: string) => void
  onClose: () => void
}) {
  if (!file) return null
  // Keyed by filename so a different file remounts with fresh draft state.
  return (
    <ScriptEditorForm
      key={file.name}
      file={file}
      siblings={siblings}
      onSave={onSave}
      onDelete={onDelete}
      onClose={onClose}
    />
  )
}

function ScriptEditorForm({
  file,
  siblings,
  onSave,
  onDelete,
  onClose,
}: {
  file: IsoFileEntry
  siblings: string[]
  onSave: (previousName: string, next: IsoFileEntry) => void
  onDelete: (name: string) => void
  onClose: () => void
}) {
  const [name, setName] = useState(file.name)
  const [content, setContent] = useState(file.content)

  function save() {
    const trimmed = name.trim()
    if (!ISO_FILE_NAME_RE.test(trimmed)) {
      toast.error(
        "Filename must be letters/digits/._- with a .ps1 or .sh extension.",
      )
      return
    }
    if (trimmed !== file.name && siblings.includes(trimmed)) {
      toast.error(`A file named "${trimmed}" already exists.`)
      return
    }
    if (new TextEncoder().encode(content).length > ISO_FILE_MAX_BYTES) {
      toast.error(`Script exceeds ${ISO_FILE_MAX_BYTES / 1024} KiB.`)
      return
    }
    onSave(file.name, { name: trimmed, content })
    onClose()
  }

  return (
    <Dialog.Root
      open
      onOpenChange={(next) => {
        if (!next) onClose()
      }}
    >
      <Dialog.Portal>
        <Dialog.Backdrop className="fixed inset-0 z-50 bg-black/40 backdrop-blur-[1px] data-open:animate-in data-open:fade-in-0 data-closed:animate-out data-closed:fade-out-0" />
        <Dialog.Popup className="fixed left-1/2 top-1/2 z-50 flex max-h-[min(600px,calc(100vh-2rem))] w-[min(640px,calc(100vw-2rem))] -translate-x-1/2 -translate-y-1/2 flex-col gap-3 rounded-xl border bg-popover p-5 text-popover-foreground shadow-lg ring-1 ring-foreground/10 data-open:animate-in data-open:fade-in-0 data-open:zoom-in-95 data-closed:animate-out data-closed:fade-out-0 data-closed:zoom-out-95">
          <Dialog.Title className="text-sm font-semibold">
            Edit firstboot script
          </Dialog.Title>
          <div className="grid gap-1.5">
            <Label className="text-[11px] text-muted-foreground">
              Filename
            </Label>
            <Input
              value={name}
              onChange={(e) => setName(e.target.value)}
              className="h-7 font-mono text-xs"
            />
          </div>
          <CodeEditor
            value={content}
            onChange={setContent}
            className="min-h-64 flex-1"
            placeholder="# PowerShell (.ps1) — runs as SYSTEM on first boot; never reboot from a script"
            autoFocus
          />
          <div className="flex justify-between gap-2">
            <Button
              variant="destructive"
              size="sm"
              onClick={() => {
                onDelete(file.name)
                onClose()
              }}
            >
              Delete file
            </Button>
            <div className="flex gap-2">
              <Button variant="outline" size="sm" onClick={onClose}>
                Cancel
              </Button>
              <Button size="sm" onClick={save}>
                Save
              </Button>
            </div>
          </div>
        </Dialog.Popup>
      </Dialog.Portal>
    </Dialog.Root>
  )
}
