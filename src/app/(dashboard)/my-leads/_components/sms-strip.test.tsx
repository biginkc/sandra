import { act, render, screen, waitFor, within } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import { describe, expect, it, vi } from "vitest"

import { MyLeadSmsStrip } from "./sms-strip"
import type { MyLeadDetail, MyLeadDetailGroup, MyLeadDetailPageResult, MyLeadSmsMessage } from "./types"

const EMPTY_DETAIL: MyLeadDetail = {
  notes: { rows: [], hasMore: false, nextCursor: null },
  attempts: { rows: [], hasMore: false, nextCursor: null },
  appointments: { rows: [], hasMore: false, nextCursor: null },
  offers: { rows: [], hasMore: false, nextCursor: null },
  history: { rows: [], hasMore: false, nextCursor: null },
  messages: { rows: [], hasMore: false, nextCursor: null },
}

function message(id: string, body: string, direction: MyLeadSmsMessage["direction"] = "outbound", overrides: Partial<MyLeadSmsMessage> = {}): MyLeadSmsMessage {
  return {
    id,
    body,
    direction,
    createdAt: "2026-09-13T15:00:00.000Z",
    createdLabel: "Sep 13, 2026 at 10:00 AM",
    deliveryStatus: "delivered",
    attachmentCount: 0,
    ...overrides,
  }
}

function ready(messages: MyLeadDetailGroup<MyLeadSmsMessage>) {
  return { status: "ready" as const, detail: { ...EMPTY_DETAIL, messages } }
}

describe("MyLeadSmsStrip", () => {
  it("shows actual sender order, including consecutive sends, from oldest to newest", () => {
    render(<MyLeadSmsStrip state={ready({
      rows: [message("4", "Tuesday works", "inbound"), message("3", "Does Tuesday work?"), message("2", "We can discuss timing"), message("1", "Are you interested?")],
      hasMore: false,
      nextCursor: null,
    })} onRetry={vi.fn()} />)

    const list = screen.getByRole("list", { name: "Text message history" })
    expect(within(list).getAllByRole("button").map((button) => button.textContent)).toEqual([
      "Us:Are you interested?",
      "Us:We can discuss timing",
      "Us:Does Tuesday work?",
      "Them:Tuesday works",
    ])
    expect(list).toHaveClass("flex-wrap")
    expect(screen.getByText("4 texts · oldest to newest")).toBeInTheDocument()
  })

  it("keeps literal excerpts compact and opens the full message and timestamp by click", async () => {
    const user = userEvent.setup()
    const body = `Hello\n\n  there! ${"LongUnbrokenText".repeat(30)} <strong>literal text</strong>`
    render(<MyLeadSmsStrip state={ready({ rows: [message("long", body)], hasMore: false, nextCursor: null })} onRetry={vi.fn()} />)

    const trigger = screen.getByRole("button", { name: /^Us: Hello there! .*Open full text$/ })
    expect(trigger.textContent).toHaveLength(67) // 64-character excerpt plus "Us:".
    expect(trigger.textContent).toMatch(/…$/)
    expect(screen.queryByText(/literal text/)).not.toBeInTheDocument()
    await user.click(trigger)

    const popup = await screen.findByRole("dialog", { name: "Text from us" })
    const fullBody = within(popup).getByText(/literal text/)
    expect(fullBody.textContent).toBe(body)
    expect(fullBody.querySelector("strong")).toBeNull()
    expect(fullBody).toHaveClass("[overflow-wrap:anywhere]")
    expect(within(popup).getByText("Sep 13, 2026 at 10:00 AM")).toHaveAttribute("dateTime", "2026-09-13T15:00:00.000Z")
    expect(popup).toHaveClass("overflow-y-auto")
  })

  it("opens a message using the keyboard and restores focus when dismissed", async () => {
    const user = userEvent.setup()
    render(<MyLeadSmsStrip state={ready({ rows: [message("reply", "Yes, call tomorrow", "inbound")], hasMore: false, nextCursor: null })} onRetry={vi.fn()} />)

    const trigger = screen.getByRole("button", { name: "Them: Yes, call tomorrow. Open full text" })
    await user.tab()
    expect(trigger).toHaveFocus()
    await user.keyboard("{Enter}")
    expect(await screen.findByRole("dialog", { name: "Text from them" })).toBeVisible()
    await user.keyboard("{Escape}")
    await waitFor(() => expect(screen.queryByRole("dialog")).not.toBeInTheDocument())
    expect(trigger).toHaveFocus()
  })

  it("distinguishes loading, a failed initial load with retry, and a confirmed empty history", async () => {
    const user = userEvent.setup()
    const onRetry = vi.fn()
    const { rerender } = render(<MyLeadSmsStrip state={{ status: "loading" }} onRetry={onRetry} />)
    expect(screen.getByRole("status")).toHaveTextContent("Loading texts…")
    expect(screen.queryByText("No texts yet.")).not.toBeInTheDocument()

    rerender(<MyLeadSmsStrip state={{ status: "error", message: "Connection unavailable" }} onRetry={onRetry} />)
    expect(screen.getByRole("alert")).toHaveTextContent("Text history unavailable. Connection unavailable")
    await user.click(screen.getByRole("button", { name: "Retry text history" }))
    expect(onRetry).toHaveBeenCalledOnce()
    expect(screen.queryByText("No texts yet.")).not.toBeInTheDocument()

    rerender(<MyLeadSmsStrip state={ready(EMPTY_DETAIL.messages)} onRetry={onRetry} />)
    expect(screen.getByText("No texts yet.")).toBeInTheDocument()
    expect(screen.getByRole("button", { name: "Refresh texts" })).toBeEnabled()
  })

  it("labels an attachment-only message without inventing message text", async () => {
    const user = userEvent.setup()
    render(<MyLeadSmsStrip state={ready({ rows: [message("attachment", " \n ", "inbound", { attachmentCount: 2 })], hasMore: false, nextCursor: null })} onRetry={vi.fn()} />)

    await user.click(screen.getByRole("button", { name: "Them: 2 attachments. Open full text" }))
    const popup = await screen.findByRole("dialog", { name: "Text from them" })
    expect(within(popup).getByText("Attachment-only message")).toBeVisible()
    expect(within(popup).getByText("2 attachments")).toBeVisible()
  })

  it.each(["failed", "bounced"])("makes an outbound %s status visible before opening the message", async (deliveryStatus) => {
    const user = userEvent.setup()
    render(<MyLeadSmsStrip state={ready({ rows: [message("failed", "Can we call?", "outbound", { deliveryStatus })], hasMore: false, nextCursor: null })} onRetry={vi.fn()} />)

    const trigger = screen.getByRole("button", { name: "Us: Can we call? · Not delivered. Open full text" })
    expect(within(trigger).getByText("Not delivered")).toBeVisible()
    await user.click(trigger)
    expect(within(await screen.findByRole("dialog")).getByText("Not delivered")).toBeVisible()
  })

  it("retains messages during paging and errors, retries the same cursor, and prepends older history", async () => {
    const user = userEvent.setup()
    let resolvePage!: (result: MyLeadDetailPageResult) => void
    const onLoadDetailPage = vi.fn()
      .mockImplementationOnce(() => new Promise<MyLeadDetailPageResult>((resolve) => { resolvePage = resolve }))
      .mockResolvedValueOnce({ ok: true, group: "messages", page: { rows: [message("1", "Earlier message")], hasMore: false, nextCursor: null } })
    const current = message("2", "Recent reply", "inbound")
    const props = { onRetry: vi.fn(), onLoadDetailPage }
    const { rerender } = render(<MyLeadSmsStrip {...props} state={ready({ rows: [current], hasMore: true, nextCursor: "older-cursor" })} />)

    expect(screen.getByText("Latest 1 text · oldest to newest")).toBeVisible()
    await user.click(screen.getByRole("button", { name: "Load earlier texts" }))
    expect(screen.getByRole("button", { name: "Loading earlier texts…" })).toBeDisabled()
    expect(screen.getByRole("button", { name: "Refresh texts" })).toBeDisabled()
    expect(screen.getByRole("button", { name: /^Them: Recent reply/ })).toBeVisible()
    await act(async () => { resolvePage({ ok: false, message: "Temporary text history failure" }) })
    expect(screen.getByRole("alert")).toHaveTextContent("Temporary text history failure")
    expect(screen.getByRole("button", { name: /^Them: Recent reply/ })).toBeVisible()

    await user.click(screen.getByRole("button", { name: "Retry earlier texts" }))
    expect(onLoadDetailPage).toHaveBeenNthCalledWith(1, "messages", "older-cursor")
    expect(onLoadDetailPage).toHaveBeenNthCalledWith(2, "messages", "older-cursor")
    await waitFor(() => expect(screen.queryByRole("alert")).not.toBeInTheDocument())
    rerender(<MyLeadSmsStrip {...props} state={ready({ rows: [current, message("1", "Earlier message")], hasMore: false, nextCursor: null })} />)

    expect(within(screen.getByRole("list")).getAllByRole("button").map((button) => button.textContent)).toEqual(["Us:Earlier message", "Them:Recent reply"])
    expect(screen.getByText("2 texts · oldest to newest")).toBeVisible()
    expect(screen.queryByRole("button", { name: "Load earlier texts" })).not.toBeInTheDocument()
  })

  it("shows a recoverable paging error when the request throws", async () => {
    const user = userEvent.setup()
    render(<MyLeadSmsStrip state={ready({ rows: [message("1", "Existing message")], hasMore: true, nextCursor: "cursor" })} onRetry={vi.fn()} onLoadDetailPage={vi.fn().mockRejectedValue(new Error("Network failure"))} />)
    await user.click(screen.getByRole("button", { name: "Load earlier texts" }))
    expect(await screen.findByRole("alert")).toHaveTextContent("Unable to load earlier texts.")
    expect(screen.getByRole("button", { name: "Retry earlier texts" })).toBeEnabled()
    expect(screen.getByRole("button", { name: /^Us: Existing message/ })).toBeVisible()
  })

  it.each([false, true])("refreshes only texts and retains the previous history through failure and retry (empty=%s)", async (empty) => {
    const user = userEvent.setup()
    let resolveRefresh!: (result: MyLeadDetailPageResult) => void
    const onRetry = vi.fn()
    const onLoadDetailPage = vi.fn()
      .mockImplementationOnce(() => new Promise<MyLeadDetailPageResult>((resolve) => { resolveRefresh = resolve }))
      .mockResolvedValueOnce({ ok: true, group: "messages", page: { rows: [], hasMore: false, nextCursor: null } })
    const rows = empty ? [] : [message("current", "Existing text")]
    render(<MyLeadSmsStrip state={ready({ rows, hasMore: false, nextCursor: null })} onRetry={onRetry} onLoadDetailPage={onLoadDetailPage} />)
    const assertPreviousHistory = () => {
      if (empty) expect(screen.getByText("No texts yet.")).toBeVisible()
      else expect(screen.getByRole("button", { name: /^Us: Existing text/ })).toBeVisible()
    }

    await user.click(screen.getByRole("button", { name: "Refresh texts" }))
    expect(screen.getByRole("button", { name: "Refreshing texts…" })).toBeDisabled()
    assertPreviousHistory()
    await act(async () => { resolveRefresh({ ok: false, message: "New texts are temporarily unavailable" }) })
    expect(screen.getByRole("alert")).toHaveTextContent("New texts are temporarily unavailable")
    assertPreviousHistory()
    await user.click(screen.getByRole("button", { name: "Retry refresh" }))

    expect(onLoadDetailPage).toHaveBeenNthCalledWith(1, "messages", null)
    expect(onLoadDetailPage).toHaveBeenNthCalledWith(2, "messages", null)
    expect(onRetry).not.toHaveBeenCalled()
    await waitFor(() => expect(screen.queryByRole("alert")).not.toBeInTheDocument())
    expect(screen.getByRole("button", { name: "Refresh texts" })).toBeEnabled()
  })

  it("disables paging during refresh and recovers from a thrown refresh request", async () => {
    const user = userEvent.setup()
    let rejectRefresh!: (error: Error) => void
    const onLoadDetailPage = vi.fn(() => new Promise<MyLeadDetailPageResult>((_resolve, reject) => { rejectRefresh = reject }))
    render(<MyLeadSmsStrip state={ready({ rows: [message("current", "Existing text")], hasMore: true, nextCursor: "cursor" })} onRetry={vi.fn()} onLoadDetailPage={onLoadDetailPage} />)
    await user.click(screen.getByRole("button", { name: "Refresh texts" }))
    expect(screen.getByRole("button", { name: "Load earlier texts" })).toBeDisabled()
    await act(async () => { rejectRefresh(new Error("Offline")) })
    expect(screen.getByRole("alert")).toHaveTextContent("Unable to refresh texts.")
    expect(screen.getByRole("button", { name: "Load earlier texts" })).toBeEnabled()
    expect(screen.getByRole("button", { name: "Retry refresh" })).toBeEnabled()
  })

  it("falls back to retrying details for refresh only when a group loader is unavailable", async () => {
    const user = userEvent.setup()
    const onRetry = vi.fn()
    render(<MyLeadSmsStrip state={ready(EMPTY_DETAIL.messages)} onRetry={onRetry} />)
    await user.click(screen.getByRole("button", { name: "Refresh texts" }))
    expect(onRetry).toHaveBeenCalledOnce()
  })
})
