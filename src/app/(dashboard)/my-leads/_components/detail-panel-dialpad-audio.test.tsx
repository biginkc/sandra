import { render, screen, waitFor } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import { afterEach, describe, expect, it, vi } from "vitest"

import { detailView } from "../adapter"
import type { AcquisitionDetail, AcquisitionRoster } from "@/lib/my-leads/queries"
import { MyLeadDetailPanel } from "./detail-panel"

// The real detailView() feeding the real detail panel: the adapter decides which call identity reaches the UI.
const view = (rows: Record<string, unknown>[]) => detailView(
  { groups: { attempts: { rows: rows.map((r, i) => ({ id: `a${i}`, actorId: null, at: "2026-10-06T18:00:00Z", outcome: "reached", ...r })), hasMore: false, cursor: null } } } as unknown as AcquisitionDetail,
  { members: [] } as unknown as AcquisitionRoster,
)
const panel = (detail: ReturnType<typeof view>) => render(<MyLeadDetailPanel state={{ status: "ready", detail }} onRetry={vi.fn()} />)
const artifacts = (recordingStatus: string, durationSeconds: number | null = 36) => ({
  ok: true, json: async () => ({ recordingStatus, durationSeconds, transcriptStatus: "none", summaryStatus: "none", summary: null, transcript: null }),
}) as Response

afterEach(() => vi.restoreAllMocks())

describe("Dialpad recording in the lead detail", () => {
  it("available: the player appears and loads through the recording-url route; the pasted link stays", async () => {
    const fetchMock = vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(artifacts("available")).mockResolvedValueOnce({
      ok: true, json: async () => ({ signedUrl: "https://audio.example.test/dialpad.mp3", expiresAt: new Date(Date.now() + 600_000).toISOString() }),
    } as Response)
    panel(view([{ source: "dialpad", callActivityId: "call-7", recordingUrl: "https://dialpad.com/r/abc" }]))
    expect(screen.getByRole("link", { name: "Recording" })).toHaveAttribute("href", "https://dialpad.com/r/abc")
    await userEvent.click(await screen.findByRole("button", { name: /Load recording/ }))
    expect(fetchMock).toHaveBeenCalledWith("/api/leads/calls/call-7/artifacts", expect.anything())
    expect(fetchMock).toHaveBeenCalledWith("/api/leads/calls/call-7/recording-url", expect.anything())
    await waitFor(() => expect(screen.getByLabelText("Call recording")).toHaveAttribute("src", "https://audio.example.test/dialpad.mp3"))
    expect(screen.queryByText("Call details below")).not.toBeInTheDocument()
    expect(screen.queryByText(/Loading recording and summary/)).not.toBeInTheDocument()
  })

  it.each([["none"], ["pending"], ["failed"]])("unavailable (%s): no player, no status text, and the pasted link is the whole story", async (state) => {
    const fetchMock = vi.spyOn(globalThis, "fetch").mockResolvedValue(artifacts(state))
    panel(view([{ source: "dialpad", callActivityId: "call-7", recordingUrl: "https://dialpad.com/r/abc" }]))
    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1))
    expect(screen.queryByRole("button", { name: /Load recording/ })).not.toBeInTheDocument()
    expect(screen.queryByLabelText("Call recording")).not.toBeInTheDocument()
    expect(screen.queryByText(/Recording (processing|unavailable)|No recording captured/)).not.toBeInTheDocument()
    expect(screen.getByRole("link", { name: "Recording" })).toHaveAttribute("href", "https://dialpad.com/r/abc")
  })

  it("no pasted link and no stored audio: the existing empty label, and no player", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(artifacts("none"))
    panel(view([{ source: "dialpad", callActivityId: "call-7", recordingUrl: null }]))
    expect(screen.getByText("No recording link added")).toBeInTheDocument()
    await waitFor(() => expect(globalThis.fetch).toHaveBeenCalled())
    expect(screen.queryByRole("button", { name: /Load recording/ })).not.toBeInTheDocument()
  })

  it("a refused artifacts request leaves the row quiet (no error banner)", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue({ ok: false, json: async () => ({}) } as Response)
    panel(view([{ source: "dialpad", callActivityId: "call-7", recordingUrl: null }]))
    await waitFor(() => expect(globalThis.fetch).toHaveBeenCalled())
    expect(screen.queryByText(/could not be refreshed/)).not.toBeInTheDocument()
    expect(screen.getByText("No recording link added")).toBeInTheDocument()
  })

  it("a Dialpad attempt with no linked call makes no artifacts request", () => {
    const fetchMock = vi.spyOn(globalThis, "fetch")
    panel(view([{ source: "dialpad", callActivityId: null, recordingUrl: "https://dialpad.com/r/abc" }]))
    expect(fetchMock).not.toHaveBeenCalled()
    expect(screen.getByRole("link", { name: "Recording" })).toBeInTheDocument()
  })

  it("Sandra attempts are unchanged: 'Call details below' and the full artifact block", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(artifacts("none"))
    panel(view([{ source: "sandra", callActivityId: "call-9", recordingUrl: null }]))
    expect(screen.getByText("Call details below")).toBeInTheDocument()
    expect(await screen.findByText("No recording captured")).toBeInTheDocument()
    expect(screen.getByRole("button", { name: "Refresh call details" })).toBeInTheDocument()
  })
})
