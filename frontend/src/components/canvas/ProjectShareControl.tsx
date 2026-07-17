import { useEffect, useRef, useState } from "react"
import { Loader2, Share2 } from "lucide-react"
import { toast } from "sonner"

import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { publishProjectShare } from "@/lib/api"
import { serializeProject } from "@/lib/projectSerialize"
import { useProjectsStore } from "@/store/projects"

function projectShareUrl(projectId: string): string {
  const url = new URL(window.location.pathname, window.location.origin)
  url.searchParams.set("share", projectId)
  return url.toString()
}

/** Guest-only tab-bar control that publishes and reveals the active share URL. */
export function ProjectShareControl() {
  const activeProjectId = useProjectsStore((s) => s.activeProjectId)
  const saveActiveSnapshot = useProjectsStore((s) => s.saveActiveSnapshot)
  const [open, setOpen] = useState(false)
  const [publishing, setPublishing] = useState(false)
  const [link, setLink] = useState("")
  const containerRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    if (!open) return
    function closeOnOutsideClick(event: MouseEvent) {
      if (!containerRef.current?.contains(event.target as Node)) setOpen(false)
    }
    document.addEventListener("mousedown", closeOnOutsideClick)
    return () => document.removeEventListener("mousedown", closeOnOutsideClick)
  }, [open])

  async function revealShareLink() {
    if (open) {
      setOpen(false)
      return
    }
    if (!activeProjectId) return

    setOpen(true)
    setPublishing(true)
    setLink("")
    try {
      // Sharing is a checkpoint: publish exactly what is currently visible,
      // including edits made since the previous explicit save.
      saveActiveSnapshot()
      const project = useProjectsStore
        .getState()
        .projects.find((candidate) => candidate.id === activeProjectId)
      if (!project) return
      const metadata = await publishProjectShare(serializeProject(project))
      setLink(projectShareUrl(metadata.projectId))
    } catch (error) {
      setOpen(false)
      toast.error(
        error instanceof Error
          ? error.message
          : "Could not create sharing link.",
      )
    } finally {
      setPublishing(false)
    }
  }

  async function copyLink() {
    if (!link) return
    try {
      await navigator.clipboard.writeText(link)
      toast.success("Sharing link copied.")
    } catch {
      toast.error("Could not copy the sharing link.")
    }
  }

  return (
    <div ref={containerRef} className="relative">
      <Button
        variant="ghost"
        size="icon-sm"
        disabled={!activeProjectId || publishing}
        onClick={() => void revealShareLink()}
        aria-label="Share project"
        title="Share project"
      >
        {publishing ? <Loader2 className="animate-spin" /> : <Share2 />}
      </Button>

      {open && (
        <div className="absolute right-0 top-full z-40 mt-1 w-80 rounded-lg border bg-popover p-3 text-popover-foreground shadow-lg ring-1 ring-foreground/10">
          <p className="mb-2 text-xs font-medium">Guest sharing link</p>
          <Input
            readOnly
            value={publishing ? "Creating link…" : link}
            disabled={publishing || !link}
            aria-label="Guest sharing link"
            title={link ? "Click to copy" : undefined}
            className="cursor-copy text-xs"
            onClick={(event) => {
              event.currentTarget.select()
              void copyLink()
            }}
          />
          <p className="mt-2 text-[11px] text-muted-foreground">
            Click the field to copy. Guests with this link can join this
            project.
          </p>
        </div>
      )}
    </div>
  )
}
