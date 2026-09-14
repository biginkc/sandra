import { render, screen, waitFor } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import { describe, expect, it, vi } from "vitest"

import { MyLeadDetailPanel } from "./detail-panel"
import type { MyLeadDetail } from "./types"

const EMPTY_DETAIL: MyLeadDetail = {
  messages: { rows: [], hasMore: false, nextCursor: null },
  notes: { rows: [], hasMore: false, nextCursor: null },
  attempts: { rows: [], hasMore: false, nextCursor: null },
  appointments: { rows: [], hasMore: false, nextCursor: null },
  offers: { rows: [], hasMore: false, nextCursor: null },
  history: { rows: [], hasMore: false, nextCursor: null },
}

describe("MyLeadDetailPanel", () => {
  it("keeps detail loading state local to the expanded row", () => {
    render(<MyLeadDetailPanel state={{ status: "loading" }} onRetry={vi.fn()} />)

    expect(screen.getByRole("status")).toHaveTextContent("Loading details…")
  })

  it("exposes a retry action when detail loading fails", async () => {
    const user = userEvent.setup()
    const onRetry = vi.fn()
    render(
      <MyLeadDetailPanel
        state={{ status: "error", message: "Temporary detail failure" }}
        onRetry={onRetry}
      />
    )

    expect(screen.getByRole("alert")).toHaveTextContent("Temporary detail failure")
    await user.click(screen.getByRole("button", { name: "Retry" }))
    expect(onRetry).toHaveBeenCalledOnce()
  })

  it("renders bounded detail groups with truthful empty states", () => {
    render(<MyLeadDetailPanel state={{ status: "ready", detail: EMPTY_DETAIL }} onRetry={vi.fn()} />)

    expect(screen.getByRole("region", { name: "Lead details" })).toBeInTheDocument()
    expect(screen.getAllByText("No notes recorded.")).toHaveLength(1)
    expect(screen.getByText("No outreach attempts recorded.")).toBeInTheDocument()
    expect(screen.getByText("No appointments recorded.")).toBeInTheDocument()
    expect(screen.getByText("No offers recorded.")).toBeInTheDocument()
    expect(screen.getByText("No history recorded.")).toBeInTheDocument()
  })

  it("places attempts before notes and presents the available source and recording", () => {
    render(<MyLeadDetailPanel state={{ status: "ready", detail: {
      ...EMPTY_DETAIL,
      attempts: { rows: [{ id: "attempt", actorLabel: "Maria", outcomeLabel: "Reached", occurredLabel: "Sep 11", sourceLabel: "DialPad", recordingUrl: "https://dialpad.com/call/123" }], hasMore: false, nextCursor: null },
    } }} onRetry={vi.fn()} />)
    expect(screen.getAllByRole("heading", { level: 3 }).map(heading => heading.textContent)).toEqual(["Attempts · 1", "Notes", "Appointments", "$Offers", "History"])
    expect(screen.getByText("DialPad")).toBeVisible()
    expect(screen.getByRole("link", { name: "Recording" })).toHaveAttribute("href", "https://dialpad.com/call/123")
    expect(screen.getByRole("link", { name: "Recording" })).toHaveAttribute("rel", "noopener noreferrer")
  })

  it("uses authenticated Sandra playback when the external recording URL is absent", async () => {
    const fetchMock = vi.spyOn(globalThis, "fetch").mockResolvedValueOnce({
      ok: true, json: async () => ({ recordingStatus: "available", durationSeconds: null, transcriptStatus: "none", summaryStatus: "failed", summary: null, transcript: null }),
    } as Response).mockResolvedValueOnce({
      ok: true,
      json: async () => ({ signedUrl: "https://audio.example.com/call.mp3", expiresAt: new Date(Date.now() + 600000).toISOString() }),
    } as Response)
    render(<MyLeadDetailPanel state={{ status: "ready", detail: {
      ...EMPTY_DETAIL,
      attempts: { rows: [{ id: "attempt", actorLabel: "Maria", outcomeLabel: "Reached", occurredLabel: "Sep 12", sourceLabel: "Sandra", recordingUrl: null, callActivityId: "call-123" }], hasMore: false, nextCursor: null },
    } }} onRetry={vi.fn()} />)
    expect(screen.queryByText("no recording")).not.toBeInTheDocument()
    await userEvent.click(await screen.findByRole("button", { name: "Load recording" }))
    expect(fetchMock).toHaveBeenCalledWith("/api/leads/calls/call-123/recording-url", expect.anything())
    await waitFor(() => expect(screen.getByLabelText("Call recording")).toHaveAttribute("src", "https://audio.example.com/call.mp3"))
    expect(screen.queryByRole("alert")).not.toBeInTheDocument()
    fetchMock.mockRestore()
  })

  it("shows a group page error and retries with the same cursor", async () => {
    const user = userEvent.setup()
    const onLoadDetailPage = vi
      .fn()
      .mockRejectedValueOnce(new Error("Page unavailable"))
      .mockResolvedValueOnce({
        ok: true as const,
        group: "notes" as const,
        page: { rows: [], hasMore: false, nextCursor: null },
      })
    render(
      <MyLeadDetailPanel
        state={{
          status: "ready",
          detail: {
            ...EMPTY_DETAIL,
            notes: { rows: [], hasMore: true, nextCursor: "notes-cursor" },
          },
        }}
        onRetry={vi.fn()}
        onLoadDetailPage={onLoadDetailPage}
      />
    )

    await user.click(screen.getByRole("button", { name: "Load more notes" }))
    expect(await screen.findByRole("alert")).toHaveTextContent("Unable to load more detail.")
    await user.click(screen.getByRole("button", { name: "Retry" }))

    expect(onLoadDetailPage).toHaveBeenNthCalledWith(1, "notes", "notes-cursor")
    expect(onLoadDetailPage).toHaveBeenNthCalledWith(2, "notes", "notes-cursor")
  })

  it("reuses the shared append-only note composer for a property detail", () => {
    render(
      <MyLeadDetailPanel
        state={{ status: "ready", detail: EMPTY_DETAIL }}
        propertyId="property-1"
        onRetry={vi.fn()}
      />
    )

    expect(screen.getByTestId("lead-add-note-composer")).toBeInTheDocument()
    expect(screen.getByText("+ Add note")).toBeInTheDocument()
  })
})
