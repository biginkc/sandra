import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { InboxWorkspaceClient } from "./workspace-client";
import { workspaceId } from "./selection";
import type { WorkspaceRow } from "./inbox-workspace";
const state = vi.hoisted(() => ({ callbacks: null as null | { onChange: (value: unknown) => void; onProbe?: () => void; onAccessBoundary: () => void; onInvalidated: (ids: readonly string[]) => void }, replacements: [] as unknown[], deny: false, itemUnavailable: false, detailUnavailable: false }));
vi.mock("@/lib/inbox/workspace-sync", () => ({ createWorkspaceSync: (callbacks: typeof state.callbacks) => {
  state.callbacks = callbacks;
  return { replace: (value: unknown) => { state.replacements.push(value); }, reset: () => callbacks?.onChange({ state: "resync_required", rows: [] }), revoke: () => callbacks?.onChange({ state: "permission_lost", rows: [] }) };
} }));
const orgId = "00000000-0000-4000-8000-000000000001", userId = "00000000-0000-4000-8000-000000000002", sessionId = "00000000-0000-4000-8000-000000000003";
const conversationId = "00000000-0000-4000-8000-000000000004";
const identity = { orgId, userId, sessionId, accessEpoch: "1", expiresAt: Date.now() + 60000 };
const row: WorkspaceRow = { target: { kind: "conversation", orgId, conversationId }, name: "Ada", context: "123 Oak", preview: "A real conversation", timeLabel: "Now", outcomeLabel: "Needs outcome", assignedLabel: "Unassigned" };
const conversationId2 = "00000000-0000-4000-8000-000000000005";
const row2: WorkspaceRow = { target: { kind: "conversation", orgId, conversationId: conversationId2 }, name: "Bea", context: "456 Pine", preview: "A second conversation", timeLabel: "Now", outcomeLabel: "Needs outcome", assignedLabel: "Unassigned" };
const conversationId3 = "00000000-0000-4000-8000-000000000006";
const row3: WorkspaceRow = { target: { kind: "conversation", orgId, conversationId: conversationId3 }, name: "Diana", context: "789 Cedar", preview: "A third conversation", timeLabel: "Now", outcomeLabel: "Needs outcome", assignedLabel: "Unassigned" };
let calls: string[];
beforeEach(() => {
  vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockImplementation(() => ({ x: 0, y: 0, left: 0, top: 0, width: 900, height: 600, right: 900, bottom: 600, toJSON: () => ({}) }));
  Object.defineProperty(HTMLElement.prototype, "offsetHeight", { configurable: true, get: () => 600 });
  Object.defineProperty(HTMLElement.prototype, "offsetWidth", { configurable: true, get: () => 900 });
  calls = []; state.replacements = []; state.deny = false; state.itemUnavailable = false; state.detailUnavailable = false;
  vi.stubGlobal("fetch", vi.fn(async (url: string, init?: RequestInit) => {
    calls.push(url);
    if (url.includes("/detail")) {
      if (state.detailUnavailable) return Response.json({}, { status: 404 });
      const openedConversationId = url.match(/conversations\/([^/]+)\/detail/)?.[1] ?? conversationId;
      return Response.json({ orgId, requesterId: userId, conversationId: openedConversationId, history: [{ id: "message", direction: "inbound", body: "Hello from history", createdAtRaw: new Date().toISOString(), readAtRaw: null, inboundRevision: "1", status: "received", delivery: "delivered" }], readBoundary: "boundary", boundaryExpiresAt: new Date(Date.now() + 60000).toISOString(), captureGeneration: "capture", headRevision: "1" });
    }
    if (url.endsWith("/replies/prepare")) {
      const body = JSON.parse(String(init?.body)) as { idempotencyKey: string; targets: Array<{ kind: "conversation"; id: string }> };
      const items = body.targets.map((target, index) => ({ id: `00000000-0000-4000-8000-${String(10 + index).padStart(12, "0")}`, target, exclusion: null, duplicateDestination: false, recipient: { contactName: target.id === conversationId ? row.name : target.id === conversationId2 ? row2.name : row3.name, propertyAddress: target.id === conversationId ? row.context : target.id === conversationId2 ? row2.context : row3.context, propertyId: "00000000-0000-4000-8000-000000000010", contactId: "00000000-0000-4000-8000-000000000011", from: "+18165550100", to: "+18165550142", renderedBody: `Hello ${target.id === conversationId ? row.name : target.id === conversationId2 ? row2.name : row3.name}` } }));
      return Response.json({ preparationId: "00000000-0000-4000-8000-000000000012", idempotencyKey: body.idempotencyKey, inputHash: "a".repeat(64), expiresAt: new Date(Date.now() + 60000).toISOString(), items, recipientCount: items.length, blockers: [] });
    }
    if (url.endsWith("/replies/accept")) return Response.json({ operationId: "00000000-0000-4000-8000-000000000013" });
    if (url.includes("/replies/")) return Response.json({ operationId: "00000000-0000-4000-8000-000000000013", preparationId: "00000000-0000-4000-8000-000000000012", dispatchComplete: true, items: [], receipts: [] });
    if (url.includes("/drip-markers")) return Response.json({ orgId, asOf: new Date().toISOString(), rows: [{ conversationId, propertyId: null, inDrip: true, dripReplied: false, dripName: "Fixture Drip" }] });
    if (url.includes("/counts")) return Response.json({ accessEpoch: "1", asOf: new Date().toISOString(), counts: { all: 1000, unread: 10 } });
    if (url.includes("read-acknowledgments")) return state.itemUnavailable ? Response.json({}, { status: 404 }) : Response.json({ boundaryId: "boundary", batch: 0, changed: 1, completed: true });
    if (state.deny) return Response.json({}, { status: 403 });
    return Response.json({ scopeId: "scope", orgId, requesterId: userId, sessionId, accessEpoch: "1", expiresAt: Date.now() + 60000, orderedIds: [workspaceId(row.target)], nextCursor: null, refreshed: false });
  }));
});
afterEach(() => { cleanup(); vi.restoreAllMocks(); vi.unstubAllGlobals(); });
async function loaded() {
  render(<InboxWorkspaceClient identity={identity} initialFilter={{ view: "all", hide_noise: true }} />);
  await waitFor(() => expect(state.replacements).toHaveLength(1));
  act(() => state.callbacks!.onChange({ state: "live", rows: [row] }));
}
it("selection never fetches history; opening and revisiting use the bounded detail cache", async () => {
  await loaded();
  fireEvent.click(screen.getByRole("checkbox", { name: "Select Ada" }));
  expect(calls.some(url => url.includes("/detail"))).toBe(false);
  fireEvent.click(screen.getByRole("button", { name: "Open Ada" }));
  await screen.findByText("Hello from history");
  fireEvent.click(screen.getByRole("button", { name: "Close conversation details" }));
  fireEvent.click(screen.getByRole("button", { name: "Open Ada" }));
  await screen.findByText("Hello from history");
  expect(calls.filter(url => url.includes("/detail"))).toHaveLength(1);
  expect(screen.getByRole("checkbox", { name: "Select Ada" })).toBeChecked();
});
it("does not show the legacy connected-activity placeholder when replies are enabled", async () => {
  render(<InboxWorkspaceClient identity={identity} initialFilter={{ view: "all", hide_noise: true }} repliesEnabled />);
  await waitFor(() => expect(state.replacements).toHaveLength(1));
  act(() => state.callbacks!.onChange({ state: "live", rows: [row] }));
  expect(screen.queryByText(/Replies .*being connected/)).not.toBeInTheDocument();
});
it("decorates resident conversations from a fenced marker snapshot", async () => {
  await loaded();
  await waitFor(() => expect(screen.getByRole("img", { name: "In a drip" })).toHaveAttribute("title", "In a drip · Fixture Drip"));
});
it("keeps selected identities across a view change and permits removing hidden selections", async () => {
  await loaded();
  fireEvent.click(screen.getByRole("checkbox", { name: "Select Ada" }));
  fireEvent.change(screen.getByRole("combobox"), { target: { value: "unread" } });
  await waitFor(() => expect(state.replacements).toHaveLength(2));
  act(() => state.callbacks!.onChange({ state: "live", rows: [] }));
  expect(screen.getByText(/1 selected · 1 not loaded here/)).toBeVisible();
  fireEvent.click(screen.getByRole("button", { name: "Review selection" }));
  expect(screen.getByRole("dialog")).toHaveTextContent("Ada");
  fireEvent.click(screen.getByRole("button", { name: "Remove" }));
  expect(screen.getByRole("dialog")).toHaveTextContent("0 selected conversations");
});
it("clears selection and visible history on a canonical access denial", async () => {
  await loaded();
  fireEvent.click(screen.getByRole("checkbox", { name: "Select Ada" }));
  fireEvent.click(screen.getByRole("button", { name: "Open Ada" }));
  await screen.findByText("Hello from history");
  state.deny = true;
  fireEvent.click(screen.getByRole("button", { name: "Refresh view" }));
  await waitFor(() => expect(screen.getByRole("alert")).toHaveTextContent("Your access has changed"));
  expect(screen.queryByText("Hello from history")).not.toBeInTheDocument();
  expect(screen.queryByRole("checkbox", { name: "Select Ada" })).not.toBeInTheDocument();
});
it("does not render or acknowledge a detail response that arrives after closing", async () => {
  await loaded();
  const normalFetch = fetch;
  let complete!: (response: Response) => void;
  vi.stubGlobal("fetch", vi.fn((url: string, init?: RequestInit) => url.includes("/detail") ? new Promise<Response>(resolve => { complete = resolve; }) : normalFetch(url, init)));
  fireEvent.click(screen.getByRole("button", { name: "Open Ada" }));
  fireEvent.click(screen.getByRole("button", { name: "Close conversation details" }));
  await act(async () => complete(await normalFetch(`/api/inbox/conversations/${conversationId}/detail`)));
  expect(screen.queryByText("Hello from history")).not.toBeInTheDocument();
  expect(calls.some(url => url.includes("read-acknowledgments"))).toBe(false);
});

it("closes and invalidates just this conversation on a benign item-scoped 404, without latching workspace access loss", async () => {
  await loaded();
  fireEvent.click(screen.getByRole("checkbox", { name: "Select Ada" }));
  state.itemUnavailable = true;
  fireEvent.click(screen.getByRole("button", { name: "Open Ada" }));
  await screen.findByText("Hello from history");
  await waitFor(() => expect(screen.queryByText("Hello from history")).not.toBeInTheDocument());
  expect(screen.queryByRole("alert")).not.toBeInTheDocument();
  expect(screen.queryByText(/Your access has changed/)).not.toBeInTheDocument();
  expect(screen.queryByRole("checkbox", { name: "Select Ada" })).not.toBeInTheDocument();
});
it("removes a row on a benign 404 from the INITIAL detail load, instead of a generic pane error", async () => {
  await loaded();
  fireEvent.click(screen.getByRole("checkbox", { name: "Select Ada" }));
  state.detailUnavailable = true;
  fireEvent.click(screen.getByRole("button", { name: "Open Ada" }));
  await waitFor(() => expect(screen.queryByRole("checkbox", { name: "Select Ada" })).not.toBeInTheDocument());
  expect(screen.queryByRole("alert")).not.toBeInTheDocument();
  expect(screen.queryByText(/Your access has changed/)).not.toBeInTheDocument();
});
it("prunes selection (not just visibility) on item-scoped invalidation, so it neither lists in Review nor resurrects on the next load()", async () => {
  await loaded();
  act(() => state.callbacks!.onChange({ state: "live", rows: [row, row2] }));
  fireEvent.click(screen.getByRole("checkbox", { name: "Select Ada" }));
  fireEvent.click(screen.getByRole("checkbox", { name: "Select Bea" }));
  state.detailUnavailable = true;
  fireEvent.click(screen.getByRole("button", { name: "Open Ada" }));
  await waitFor(() => expect(screen.queryByRole("checkbox", { name: "Select Ada" })).not.toBeInTheDocument());
  // The Review dialog reads the raw selection array directly (not the invalidatedIds-
  // filtered list InboxWorkspace renders checkboxes from) — it must not still list Ada.
  fireEvent.click(screen.getByRole("button", { name: "Review selection" }));
  expect(screen.getByRole("dialog")).toHaveTextContent("1 selected conversations");
  expect(screen.getByRole("dialog")).toHaveTextContent("Bea");
  expect(screen.getByRole("dialog")).not.toHaveTextContent("Ada");
  fireEvent.click(screen.getByRole("button", { name: "Close" }));
  // A later load() clears invalidatedIds; Ada's pruned selection must not resurrect.
  state.detailUnavailable = false;
  fireEvent.click(screen.getByRole("button", { name: "Refresh view" }));
  await waitFor(() => expect(state.replacements).toHaveLength(2));
  act(() => state.callbacks!.onChange({ state: "live", rows: [row, row2] }));
  expect(screen.getByRole("checkbox", { name: "Select Ada" })).not.toBeChecked();
  expect(screen.getByRole("checkbox", { name: "Select Bea" })).toBeChecked();
});
it("removes an authoritative tombstone from selection, detail and its revisit cache", async () => {
  await loaded();
  fireEvent.click(screen.getByRole("checkbox", { name: "Select Ada" }));
  fireEvent.click(screen.getByRole("button", { name: "Open Ada" }));
  await screen.findByText("Hello from history");
  act(() => state.callbacks!.onInvalidated([workspaceId(row.target)]));
  expect(screen.queryByText("Hello from history")).not.toBeInTheDocument();
  expect(screen.queryByRole("checkbox", { name: "Select Ada" })).not.toBeInTheDocument();
  expect(screen.getByText("0 selected")).toBeVisible();
  fireEvent.click(screen.getByRole("button", { name: "Refresh view" }));
  await waitFor(() => expect(state.replacements).toHaveLength(2));
  act(() => state.callbacks!.onChange({ state: "live", rows: [row] }));
  fireEvent.click(screen.getByRole("button", { name: "Open Ada" }));
  await screen.findByText("Hello from history");
  expect(calls.filter(url => url.includes("/detail"))).toHaveLength(2);
});

it("closes bulk reply review when fewer than two eligible targets remain", async () => {
  render(<InboxWorkspaceClient identity={identity} initialFilter={{ view: "all", hide_noise: true }} repliesEnabled />);
  await waitFor(() => expect(state.replacements).toHaveLength(1));
  act(() => state.callbacks!.onChange({ state: "live", rows: [row, row2] }));

  fireEvent.click(screen.getByRole("checkbox", { name: "Select Ada" }));
  fireEvent.click(screen.getByRole("checkbox", { name: "Select Bea" }));
  fireEvent.click(screen.getByRole("button", { name: "Review reply to 2" }));
  expect(screen.getByRole("dialog")).toHaveTextContent("Bulk reply review");

  act(() => state.callbacks!.onInvalidated([workspaceId(row2.target)]));
  await waitFor(() => expect(screen.queryByRole("dialog")).not.toBeInTheDocument());
});

it("keeps the single reply bound to open B when A is selected, names B in the composer and review, and prepares B", async () => {
  render(<InboxWorkspaceClient identity={identity} initialFilter={{ view: "all", hide_noise: true }} repliesEnabled />);
  await waitFor(() => expect(state.replacements).toHaveLength(1));
  act(() => state.callbacks!.onChange({ state: "live", rows: [row, row2, row3] }));

  fireEvent.click(screen.getByRole("checkbox", { name: "Select Ada" }));
  fireEvent.click(screen.getByRole("button", { name: "Open Bea" }));
  await screen.findByRole("heading", { name: "Reply to Bea" });
  fireEvent.click(screen.getByRole("checkbox", { name: "Select Diana" }));
  expect(screen.getByRole("heading", { name: "Reply to Bea" })).toBeVisible();
  expect(screen.queryByText(/characters · 1 selected/)).not.toBeInTheDocument();

  const textarea = screen.getByRole("textbox", { name: "Reply message" });
  fireEvent.change(textarea, { target: { value: "Hello Bea" } });
  expect(textarea).toHaveValue("Hello Bea");
  fireEvent.click(screen.getByRole("button", { name: "Review reply" }));
  await screen.findByText("Review before sending");
  expect(screen.getAllByText("Bea").length).toBeGreaterThan(1);
  const prepare = vi.mocked(fetch).mock.calls.find(([url]) => String(url).endsWith("/replies/prepare"));
  expect(JSON.parse(String(prepare?.[1]?.body)).targets).toEqual([{ kind: "conversation", id: conversationId2 }]);
});

it("discards B's review when C opens and never sends B", async () => {
  render(<InboxWorkspaceClient identity={identity} initialFilter={{ view: "all", hide_noise: true }} repliesEnabled />);
  await waitFor(() => expect(state.replacements).toHaveLength(1));
  act(() => state.callbacks!.onChange({ state: "live", rows: [row, row2, row3] }));

  fireEvent.click(screen.getByRole("button", { name: "Open Bea" }));
  await screen.findByRole("heading", { name: "Reply to Bea" });
  const textarea = screen.getByRole("textbox", { name: "Reply message" });
  fireEvent.change(textarea, { target: { value: "Hello Bea" } });
  expect(textarea).toHaveValue("Hello Bea");
  fireEvent.click(screen.getByRole("button", { name: "Review reply" }));
  await screen.findByText("Review before sending");
  fireEvent.click(screen.getByRole("button", { name: "Open Diana" }));
  await screen.findByRole("heading", { name: "Reply to Diana" });
  await waitFor(() => expect(screen.queryByText("Review before sending")).not.toBeInTheDocument());
  expect(screen.queryByRole("button", { name: "Send reply" })).not.toBeInTheDocument();
  expect(vi.mocked(fetch).mock.calls.some(([url]) => String(url).endsWith("/replies/accept"))).toBe(false);
});

it("bulk reply prepares A and D from the selection even while B is open", async () => {
  render(<InboxWorkspaceClient identity={identity} initialFilter={{ view: "all", hide_noise: true }} repliesEnabled />);
  await waitFor(() => expect(state.replacements).toHaveLength(1));
  act(() => state.callbacks!.onChange({ state: "live", rows: [row, row2, row3] }));

  fireEvent.click(screen.getByRole("checkbox", { name: "Select Ada" }));
  fireEvent.click(screen.getByRole("checkbox", { name: "Select Diana" }));
  fireEvent.click(screen.getByRole("button", { name: "Open Bea" }));
  await screen.findByRole("heading", { name: "Reply to Bea" });
  fireEvent.click(screen.getByRole("button", { name: "Review reply to 2" }));
  const dialog = await screen.findByRole("dialog");
  const composer = within(dialog);
  const textarea = composer.getByRole("textbox", { name: "Reply message" });
  fireEvent.change(textarea, { target: { value: "Hello selected owners" } });
  expect(textarea).toHaveValue("Hello selected owners");
  fireEvent.click(composer.getByRole("button", { name: "Review reply" }));
  await composer.findByText("Review before sending");
  const prepare = vi.mocked(fetch).mock.calls.find(([url]) => String(url).endsWith("/replies/prepare"));
  expect(JSON.parse(String(prepare?.[1]?.body)).targets).toEqual([{ kind: "conversation", id: conversationId }, { kind: "conversation", id: conversationId3 }]);
});
