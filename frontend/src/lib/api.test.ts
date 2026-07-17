import { describe, expect, it } from "vitest"

import { formatApiErrorDetail } from "@/lib/api"

describe("formatApiErrorDetail", () => {
  it("surfaces failed preflight checks instead of stringifying the response", () => {
    expect(
      formatApiErrorDetail({
        message: "Control-plane preflight failed.",
        preflight: {
          ready: false,
          checks: [
            { key: "mongo", ok: true, detail: "MongoDB responded to ping." },
            {
              key: "agentBinary",
              ok: false,
              detail: "Agent digest does not match.",
            },
          ],
        },
      }),
    ).toBe("Control-plane preflight failed. Agent digest does not match.")
  })

  it("preserves ordinary FastAPI string details", () => {
    expect(formatApiErrorDetail("VM already exists.")).toBe(
      "VM already exists.",
    )
  })
})
