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
  return { orgId, conversationId, requestGeneration: 1, visible: true, onRefresh: vi.fn(), onAccessLost: vi.fn(), snapshot: { requestGeneration: 1, data: {
    requesterId: orgId, orgId, conversationId, headRevision: "1", readBoundary, boundaryExpiresAt: "2030-01-01T00:00:00Z", captureGeneration: orgId,
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
});
