/**
 * Generic client for the backend's job-progress WebSocket.
 *
 * Mirrors the backend `ProgressMessage` union (app/core/jobs/models.py). Opening
 * a socket subscribes to one job's stream; the returned `close()` tears it down.
 * The URL is built from the current origin + API base so the Vite dev proxy
 * forwards the upgrade (see vite.config.ts `ws: true`).
 */

import { API_BASE, URLS } from "@/constants"

export interface ProgressEvent {
  type: "progress"
  percent: number
  phase: string
  key: string
  unit: string
}

export interface DoneEvent {
  type: "done"
  result: Record<string, unknown>
}

export interface ErrorEvent {
  type: "error"
  status: number
  detail: string
}

export type JobMessage = ProgressEvent | DoneEvent | ErrorEvent

export interface JobSocketHandlers {
  onProgress?: (event: ProgressEvent) => void
  onDone?: (event: DoneEvent) => void
  /** Backend `error` frame, or a transport failure (status 0). */
  onError?: (event: ErrorEvent) => void
}

function jobSocketUrl(jobId: string, token: string | null | undefined): string {
  const proto = window.location.protocol === "https:" ? "wss:" : "ws:"
  const base = `${proto}//${window.location.host}${API_BASE}${URLS.ws.jobs(jobId)}`
  return token ? `${base}?token=${encodeURIComponent(token)}` : base
}

/**
 * Subscribe to a job's progress. Returns a `close()` that detaches handlers and
 * closes the socket; safe to call once the job has reached a terminal state.
 */
export function openJobSocket(
  jobId: string,
  token: string | null | undefined,
  handlers: JobSocketHandlers,
): () => void {
  const ws = new WebSocket(jobSocketUrl(jobId, token))
  let settled = false

  ws.onmessage = (ev) => {
    let msg: JobMessage
    try {
      msg = JSON.parse(ev.data) as JobMessage
    } catch {
      return
    }
    switch (msg.type) {
      case "progress":
        handlers.onProgress?.(msg)
        break
      case "done":
        settled = true
        handlers.onDone?.(msg)
        break
      case "error":
        settled = true
        handlers.onError?.(msg)
        break
    }
  }

  // A socket that closes without a terminal frame (backend crash, dropped
  // connection) is a failure the caller needs to react to.
  ws.onclose = () => {
    if (!settled) {
      settled = true
      handlers.onError?.({
        type: "error",
        status: 0,
        detail: "Progress connection closed before completion.",
      })
    }
  }

  return () => {
    ws.onmessage = null
    ws.onclose = null
    ws.close()
  }
}
