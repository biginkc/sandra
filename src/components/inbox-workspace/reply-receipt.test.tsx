import { act, cleanup, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { InboxReplyStatus } from "@/lib/inbox/reply-api-contract";
import { InboxReplyComposer, PreviewInboxReplyComposer } from "./reply-composer";
import { MAX_POLL_DURATION_MS } from "./reply-receipt-policy";
import { InboxReplyReceipt } from "./reply-receipt";

const conversationId = "00000000-0000-4000-8000-000000000001";
const operationId = "00000000-0000-4000-8000-000000000002";
const itemId = "00000000-0000-4000-8000-000000000003";
const preparationId = "00000000-0000-4000-8000-000000000004";

function status(state: InboxReplyStatus["receipts"][number]["state"], version = "1"): InboxReplyStatus {
  return {
    operationId,
    preparationId,
    dispatchComplete: ["provider_accepted", "delivered", "delivery_failed", "rejected_unsent", "confirmed_not_submitted"].includes(state),
    items: [{
      id: itemId,
      target: { kind: "conversation", id: conversationId },
      exclusion: null,
      duplicateDestination: false,
      recipient: {
        contactName: "Ada Lovelace",
        propertyAddress: "123 Oak St",
        propertyId: "00000000-0000-4000-8000-000000000005",
        contactId: "00000000-0000-4000-8000-000000000006",
        from: "+18165550100",
        to: "+18165550142",
        renderedBody: "Hello Ada",
      },
    }],
    receipts: [{ itemId, attemptId: null, version, state, reason: null }],
  };
}

function bulkStatus(states: readonly InboxReplyStatus["receipts"][number]["state"][]): InboxReplyStatus {
  const base = status(states[0]);
  const items = states.map((_, index) => ({
    ...base.items[0],
    id: `${itemId.slice(0, -1)}${index + 3}`,
    target: { kind: "conversation" as const, id: `${conversationId.slice(0, -1)}${index + 1}` },
    recipient: { ...base.items[0].recipient!, contactName: `Recipient ${index + 1}` },
  }));
  return {
    ...base,
    dispatchComplete: states.every(receiptState => ["provider_accepted", "delivered", "delivery_failed", "rejected_unsent", "confirmed_not_submitted"].includes(receiptState)),
    items,
    receipts: states.map((receiptState, index) => ({ itemId: items[index].id, attemptId: null, version: "1", state: receiptState, reason: receiptState === "uncertain" ? "reentered_without_result" : null })),
  };
}

function mountReceipt() {
  return render(<InboxReplyReceipt operationId={operationId} />);
}

beforeEach(() => {
  vi.stubGlobal("fetch", vi.fn());
});

afterEach(() => {
  cleanup();
  vi.useRealTimers();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("InboxReplyReceipt", () => {
  it("uses the documented 120-second no-change bound", () => {
    expect(MAX_POLL_DURATION_MS).toBe(120_000);
  });

  it("keeps dispatch_started in-flight before the bound", async () => {
    const fetcher = vi.mocked(fetch).mockResolvedValue(Response.json(status("dispatch_started")));
    mountReceipt();
    await screen.findByText("Still sending…");
    expect(fetcher).toHaveBeenCalled();
    expect(screen.queryByText("Send result not confirmed")).not.toBeInTheDocument();
    expect(screen.getByText(/1 sending/)).toBeVisible();
    expect(screen.getByText("Still sending…").closest("section")).toHaveClass(/receiptPending/);
  });

  it("treats blocked as final even when dispatchComplete is false", async () => {
    vi.useFakeTimers();
    const fetcher = vi.mocked(fetch).mockResolvedValue(Response.json(status("blocked")));
    mountReceipt();
    await act(async () => { await Promise.resolve(); await Promise.resolve(); });
    expect(screen.getAllByText("Not sent").length).toBeGreaterThan(0);
    expect(screen.queryByText("Still sending…")).not.toBeInTheDocument();
    await act(async () => { await vi.advanceTimersByTimeAsync(120_000); });
    expect(fetcher).toHaveBeenCalledTimes(1);
  });

  it("keeps the mixed not-confirmed bulk banner amber instead of pending blue", async () => {
    vi.useFakeTimers();
    const fetcher = vi.mocked(fetch).mockResolvedValue(Response.json(bulkStatus(["delivered", "uncertain", "pending"])));
    mountReceipt();
    await act(async () => { await Promise.resolve(); await Promise.resolve(); });
    const banner = screen.getByText("Some not confirmed, do not resend").closest("section");
    expect(banner).toHaveClass(/uncertain/);
    expect(banner).not.toHaveClass(/receiptPending/);
    expect(fetcher).toHaveBeenCalledTimes(1);
  });

  it("resets the no-change clock when receipt progress changes", async () => {
    vi.useFakeTimers();
    const fetcher = vi.mocked(fetch).mockImplementation(async () => {
      const version = fetcher.mock.calls.length <= 1 ? "1" : "2";
      return Response.json(status("pending", version));
    });
    mountReceipt();
    await act(async () => { await Promise.resolve(); await Promise.resolve(); });
    await act(async () => { await vi.advanceTimersByTimeAsync(500); });
    expect(fetcher).toHaveBeenCalledTimes(2);
    expect(screen.queryByText("Send result not confirmed")).not.toBeInTheDocument();
    await act(async () => { await vi.advanceTimersByTimeAsync(MAX_POLL_DURATION_MS - 1); });
    expect(screen.queryByText("Send result not confirmed")).not.toBeInTheDocument();
    await act(async () => { await vi.advanceTimersByTimeAsync(1); });
    expect(screen.getByText("Send result not confirmed")).toBeVisible();
    expect(screen.getByRole("button", { name: "Refresh" })).toBeVisible();
  });

  it("stops polling at the no-change bound and keeps Refresh available", async () => {
    vi.useFakeTimers();
    const fetcher = vi.mocked(fetch).mockResolvedValue(Response.json(status("pending")));
    mountReceipt();
    await act(async () => { await Promise.resolve(); await Promise.resolve(); });
    await act(async () => { await vi.advanceTimersByTimeAsync(MAX_POLL_DURATION_MS); });
    expect(screen.getByText("Send result not confirmed")).toBeVisible();
    const attemptsAtBound = fetcher.mock.calls.length;
    await act(async () => { await vi.advanceTimersByTimeAsync(MAX_POLL_DURATION_MS); });
    expect(fetcher).toHaveBeenCalledTimes(attemptsAtBound);
  });

  it("stops polling as soon as every receipt is terminal", async () => {
    vi.useFakeTimers();
    const fetcher = vi.mocked(fetch).mockResolvedValue(Response.json(status("delivered")));
    mountReceipt();
    await act(async () => { await Promise.resolve(); await Promise.resolve(); });
    expect(screen.getAllByText("Delivered").length).toBeGreaterThan(0);
    const attempts = fetcher.mock.calls.length;
    await act(async () => { await vi.advanceTimersByTimeAsync(MAX_POLL_DURATION_MS); });
    expect(fetcher).toHaveBeenCalledTimes(attempts);
  });

  it.each(["pending", "dispatch_started", "provider_accepted", "uncertain", "blocked", "delivered", "delivery_failed", "confirmed_not_submitted", "rejected_unsent"] as const)("classifies %s the same in composer and receipt page", async (receiptState) => {
    const receipt = status(receiptState);
    const composer = render(<PreviewInboxReplyComposer targets={[{ kind: "conversation", id: conversationId }]} enabled initialState={{ phase: "sending", draft: "Draft", operationId, status: receipt }} />);
    const composerReceipt = screen.queryByRole("alert") ?? screen.getByRole("status");
    const composerHeadline = composerReceipt.querySelector("strong")?.textContent ?? "";
    composer.unmount();
    vi.mocked(fetch).mockResolvedValue(Response.json(receipt));
    render(<InboxReplyReceipt operationId={operationId} />);
    await act(async () => { await Promise.resolve(); await Promise.resolve(); });
    const receiptSection = screen.queryByRole("alert") ?? screen.getByRole("status");
    const receiptHeadline = receiptSection.querySelector("strong")?.textContent ?? "";
    expect(receiptHeadline).toBe(composerHeadline);
    expect(screen.queryByRole("button", { name: /resend|retry/i })).not.toBeInTheDocument();
  });

  it("does not allow production callers to hydrate the composer", () => {
    // @ts-expect-error initialState is intentionally preview-only.
    const rejectedProductionProps: Parameters<typeof InboxReplyComposer>[0] = { targets: [{ kind: "conversation", id: conversationId }], enabled: true, initialState: { phase: "sending", draft: "Draft", operationId, status: status("delivered") } };
    expect(rejectedProductionProps).toHaveProperty("initialState");
    const productionProps = { targets: [{ kind: "conversation" as const, id: conversationId }], enabled: true, initialState: { phase: "sending" as const, draft: "Draft", operationId, status: status("delivered") } } as unknown as Parameters<typeof InboxReplyComposer>[0];
    render(<InboxReplyComposer {...productionProps} />);
    expect(screen.getByRole("button", { name: "Review reply" })).toBeVisible();
    expect(screen.queryByText("Delivered")).not.toBeInTheDocument();
  });
});
