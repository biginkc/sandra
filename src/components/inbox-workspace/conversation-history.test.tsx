import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { StrictMode } from "react";
import { ConversationHistory, type ConversationHistoryProps } from "./conversation-history";
const orgId = "11111111-1111-1111-1111-111111111111";
const conversationId = "22222222-2222-2222-2222-222222222222";
const readBoundary = "33333333-3333-3333-3333-333333333333";
const frameQueue = new Map<number, FrameRequestCallback>();
let frameId = 0;
function props(overrides: Partial<ConversationHistoryProps> = {}): ConversationHistoryProps {
  return { orgId, conversationId, requestGeneration: 1, visible: true, onRefresh: vi.fn(), onAccessLost: vi.fn(), onUnavailable: vi.fn(), snapshot: { requestGeneration: 1, data: {
    requesterId: orgId, orgId, conversationId, headRevision: "1", readBoundary, boundaryExpiresAt: "2030-01-01T00:00:00Z", nextCursor: null, captureGeneration: orgId,
    propertyId: null, contactId: null, contactName: null, propertyAddress: null, propertyStatus: null, outreachDispo: null, assigneeId: null, threadCustomerPhone: null, threadBusinessPhone: null, contactDoNotContact: false, contactSmsOptedOut: false, phoneSuppressed: null, smsSafetyReadFailed: false, isDncLocked: false, aiDispositionReview: null, aiResponderStatus: null, aiResponderReason: null, aiResponderStatusAt: null, aiLastDeliveryStatus: null, aiLastDeliveryError: null,
    history: [{ id: orgId, createdAtRaw: "2026-09-13 12:00:00.123456+00", body: "Visible conversation", direction: "inbound", readAtRaw: null, inboundRevision: "1" }],
  } }, ...overrides };
}
function receipt(batch = 0, complete = true) { return Response.json({ boundaryId: readBoundary, batch, changed: complete ? 1 : 200, completed: complete }); }
async function paint() { await act(async () => { const frames = [...frameQueue.values()]; frameQueue.clear(); for (const frame of frames) frame(1); }); }
beforeEach(() => {
  vi.spyOn(document, "visibilityState", "get").mockReturnValue("visible");
  vi.stubGlobal("requestAnimationFrame", (callback: FrameRequestCallback) => { frameQueue.set(++frameId, callback); return frameId; });
  vi.stubGlobal("cancelAnimationFrame", (id: number) => frameQueue.delete(id));
});
afterEach(() => { cleanup(); frameQueue.clear(); vi.restoreAllMocks(); vi.unstubAllGlobals(); });
describe("render-bound conversation read acknowledgment", () => {
  it("renders history first and acknowledges only after the committed pane reaches a frame", async () => {
    const transport = vi.fn<typeof fetch>().mockResolvedValue(receipt());
    render(<ConversationHistory {...props({ fetch: transport })} />);
    expect(screen.getByText("Visible conversation")).toBeInTheDocument();
    expect(transport).not.toHaveBeenCalled();
    await paint();
    await waitFor(() => expect(transport).toHaveBeenCalledOnce());
    expect(JSON.parse(transport.mock.calls[0][1]!.body as string)).toEqual({ boundaryId: readBoundary, batch: 0 });
  });
  it("does not acknowledge hidden, prefetched, or superseded A→B→A snapshots", async () => {
    const transport = vi.fn<typeof fetch>();
    const view = render(<ConversationHistory {...props({ fetch: transport, visible: false })} />);
    await paint(); expect(transport).not.toHaveBeenCalled();
    view.rerender(<ConversationHistory {...props({ fetch: transport, requestGeneration: 3 })} />);
    await paint(); expect(transport).not.toHaveBeenCalled();
    expect(screen.queryByText("Visible conversation")).not.toBeInTheDocument();
  });
  it("cancels a superseded pane before its first acknowledgment", async () => {
    const transport = vi.fn<typeof fetch>();
    const view = render(<ConversationHistory {...props({ fetch: transport })} />);
    view.rerender(<ConversationHistory {...props({ fetch: transport, conversationId: orgId, requestGeneration: 2 })} />);
    await paint(); expect(transport).not.toHaveBeenCalled();
  });
  it("waits until a hidden browser tab becomes visible", async () => {
    const visibility = vi.spyOn(document, "visibilityState", "get").mockReturnValue("hidden");
    const transport = vi.fn<typeof fetch>().mockResolvedValue(receipt());
    render(<ConversationHistory {...props({ fetch: transport })} />);
    await paint(); expect(transport).not.toHaveBeenCalled();
    visibility.mockReturnValue("visible");
    act(() => document.dispatchEvent(new Event("visibilitychange")));
    await paint(); await waitFor(() => expect(transport).toHaveBeenCalledOnce());
  });
  it("advances only from committed matching receipts, across multiple bounded batches", async () => {
    const transport = vi.fn<typeof fetch>().mockResolvedValueOnce(receipt(0, false)).mockResolvedValueOnce(receipt(1));
    render(<ConversationHistory {...props({ fetch: transport })} />);
    await paint(); await waitFor(() => expect(transport).toHaveBeenCalledTimes(2));
    expect(transport.mock.calls.map(call => JSON.parse(call[1]!.body as string).batch)).toEqual([0, 1]);
    await waitFor(() => expect(screen.queryByText("Updating read status…")).not.toBeInTheDocument());
  });
  it("retries a lost response using the same boundary and batch", async () => {
    const transport = vi.fn<typeof fetch>().mockRejectedValueOnce(new Error("Lost response")).mockResolvedValueOnce(receipt());
    render(<ConversationHistory {...props({ fetch: transport })} />);
    await paint(); await screen.findByRole("button", { name: "Retry" });
    fireEvent.click(screen.getByRole("button", { name: "Retry" }));
    await paint(); await waitFor(() => expect(transport).toHaveBeenCalledTimes(2));
    expect(transport.mock.calls.map(call => JSON.parse(call[1]!.body as string))).toEqual([{ boundaryId: readBoundary, batch: 0 }, { boundaryId: readBoundary, batch: 0 }]);
  });
  it("requires refreshing expired cached content without fetching a fresh head silently", async () => {
    const value = props({ fetch: vi.fn<typeof fetch>() });
    value.snapshot!.data.boundaryExpiresAt = "2000-01-01T00:00:00Z";
    render(<ConversationHistory {...value} />);
    await paint();
    fireEvent.click(await screen.findByRole("button", { name: "Refresh messages" }));
    expect(value.fetch).not.toHaveBeenCalled(); expect(value.onRefresh).toHaveBeenCalledOnce();
  });
  it("hides history and asks the owner to clear caches on live access loss", async () => {
    const value = props({ fetch: vi.fn<typeof fetch>().mockResolvedValue(new Response(null, { status: 401 })) });
    render(<ConversationHistory {...value} />);
    await paint();
    await waitFor(() => expect(value.onAccessLost).toHaveBeenCalledOnce());
    expect(screen.queryByText("Visible conversation")).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Retry" })).not.toBeInTheDocument();
  });
  it("signals a benign item-scoped 404 as onUnavailable, not a workspace-wide access loss", async () => {
    const value = props({ fetch: vi.fn<typeof fetch>().mockResolvedValue(new Response(null, { status: 404 })) });
    render(<ConversationHistory {...value} />);
    await paint();
    await waitFor(() => expect(value.onUnavailable).toHaveBeenCalledExactlyOnceWith(conversationId));
    expect(value.onAccessLost).not.toHaveBeenCalled();
    expect(screen.getByText("This conversation is no longer available.")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Retry" })).not.toBeInTheDocument();
  });
  it("stops acknowledging this boundary after a 404 during a batch, without latching permission_lost", async () => {
    const transport = vi.fn<typeof fetch>().mockResolvedValueOnce(receipt(0, false)).mockResolvedValueOnce(new Response(null, { status: 404 }));
    const value = props({ fetch: transport });
    render(<ConversationHistory {...value} />);
    await paint();
    await waitFor(() => expect(value.onUnavailable).toHaveBeenCalledExactlyOnceWith(conversationId));
    expect(value.onAccessLost).not.toHaveBeenCalled();
    expect(transport).toHaveBeenCalledTimes(2);
  });
  it("does not revive a revoked boundary when the owner's callback changes", async () => {
    const transport = vi.fn<typeof fetch>().mockResolvedValue(new Response(null, { status: 403 }));
    const value = props({ fetch: transport });
    const view = render(<ConversationHistory {...value} />);
    await paint(); await waitFor(() => expect(value.onAccessLost).toHaveBeenCalledOnce());
    view.rerender(<ConversationHistory {...value} onAccessLost={vi.fn()} />);
    await paint();
    expect(transport).toHaveBeenCalledOnce();
    expect(screen.queryByText("Visible conversation")).not.toBeInTheDocument();
  });
  it("does not double-dispatch before the frame under Strict Mode", async () => {
    const transport = vi.fn<typeof fetch>().mockResolvedValue(receipt());
    render(<StrictMode><ConversationHistory {...props({ fetch: transport })} /></StrictMode>);
    await paint(); await waitFor(() => expect(transport).toHaveBeenCalledOnce());
  });
  it("aborts on unmount and does not dispatch another batch from a late response", async () => {
    let resolve!: (response: Response) => void;
    const transport = vi.fn<typeof fetch>().mockImplementation(() => new Promise<Response>(done => { resolve = done; }));
    const view = render(<ConversationHistory {...props({ fetch: transport })} />);
    await paint(); expect(transport).toHaveBeenCalledOnce();
    view.unmount();
    expect(transport.mock.calls[0][1]!.signal!.aborted).toBe(true);
    await act(async () => resolve(receipt(0, false)));
    expect(transport).toHaveBeenCalledOnce();
  });
  it("pages older history without accumulating the transcript or changing the read boundary", async () => {
    const value = props(); value.snapshot!.data.nextCursor = conversationId;
    const older = { ...value.snapshot!.data, nextCursor: orgId, history: [{ ...value.snapshot!.data.history[0], id: conversationId, body: "Older page" }] };
    const oldest = { ...older, nextCursor: null, history: [{ ...older.history[0], id: readBoundary, body: "Oldest page" }] };
    const transport = vi.fn<typeof fetch>().mockResolvedValueOnce(receipt()).mockResolvedValueOnce(Response.json(older)).mockResolvedValueOnce(Response.json(oldest));
    render(<ConversationHistory {...value} fetch={transport} />);
    await paint();
    fireEvent.click(screen.getByRole("button", { name: "Load older messages" }));
    await screen.findByText("Older page");
    expect(screen.queryByText("Visible conversation")).not.toBeInTheDocument();
    expect(String(transport.mock.calls[1][0])).toContain(`before=${conversationId}`);
    fireEvent.click(screen.getByRole("button", { name: "Load older messages" }));
    await screen.findByText("Oldest page");
    expect(screen.queryByText("Older page")).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Load older messages" })).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Back to latest messages" }));
    expect(screen.getByText("Visible conversation")).toBeInTheDocument();
    expect(transport.mock.calls.filter(call => call[1]?.method === "POST")).toHaveLength(1);
  });
  it("rejects mismatched older history and allows retrying its same cursor", async () => {
    const value = props(); value.snapshot!.data.nextCursor = conversationId;
    const transport = vi.fn<typeof fetch>().mockResolvedValueOnce(receipt()).mockResolvedValueOnce(Response.json({ ...value.snapshot!.data, conversationId: orgId }));
    render(<ConversationHistory {...value} fetch={transport} />); await paint();
    fireEvent.click(screen.getByRole("button", { name: "Load older messages" }));
    await screen.findByRole("alert");
    expect(screen.getByText("Visible conversation")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Load older messages" })).toBeEnabled();
  });

  it("cannot redisplay revoked history when an earlier acknowledgment resolves late", async () => {
    let finish!: (response: Response) => void;
    const value = props(); value.snapshot!.data.nextCursor = conversationId;
    const transport = vi.fn<typeof fetch>().mockImplementationOnce(() => new Promise(resolve => { finish = resolve; })).mockResolvedValueOnce(new Response(null, { status: 401 }));
    render(<ConversationHistory {...value} fetch={transport} />); await paint();
    fireEvent.click(screen.getByRole("button", { name: "Load older messages" }));
    await waitFor(() => expect(value.onAccessLost).toHaveBeenCalledOnce());
    await act(async () => { finish(receipt()); });
    expect(transport.mock.calls[0][1]!.signal!.aborted).toBe(true);
    expect(screen.queryByText("Visible conversation")).not.toBeInTheDocument();
  });

  it("signals onUnavailable, not onAccessLost, on a benign 404 while loading an older page", async () => {
    const value = props(); value.snapshot!.data.nextCursor = conversationId;
    const transport = vi.fn<typeof fetch>().mockResolvedValueOnce(receipt()).mockResolvedValueOnce(new Response(null, { status: 404 }));
    render(<ConversationHistory {...value} fetch={transport} />); await paint();
    fireEvent.click(screen.getByRole("button", { name: "Load older messages" }));
    await waitFor(() => expect(value.onUnavailable).toHaveBeenCalledExactlyOnceWith(conversationId));
    expect(value.onAccessLost).not.toHaveBeenCalled();
  });

});
