import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { InboxWorkspaceClient } from "./workspace-client";
import { workspaceId } from "./selection";
import type { WorkspaceRow } from "./inbox-workspace";
const state = vi.hoisted(() => ({ callbacks: null as null | { onChange: (value: unknown) => void; onAccessBoundary: () => void; onInvalidated: (ids: readonly string[]) => void }, replacements: [] as unknown[], deny: false, itemUnavailable: false, detailUnavailable: false, selectionUnavailable: false, deferNextSelectionReview: false, resolveDeferredSelectionReview: null as null | (() => void), worksetUpdates: "none" as "none" | "has" | "required" | "error" }));
vi.mock("@/lib/inbox/workspace-sync", () => ({ createWorkspaceSync: (callbacks: typeof state.callbacks) => {
  state.callbacks = callbacks;
  return { replace: (value: unknown) => { state.replacements.push(value); }, reset: () => callbacks?.onChange({ state: "resync_required", rows: [] }), revoke: () => callbacks?.onChange({ state: "permission_lost", rows: [] }) };
} }));
vi.mock("@/app/(dashboard)/messages/assign-dropdown", () => ({ AssignDropdown: () => <button type="button">Change assignee</button> }));
vi.mock("@/components/appointments/book-appointment-popover", () => ({ BookAppointmentPopover: () => <button type="button">Book appointment</button> }));
const orgId = "00000000-0000-4000-8000-000000000001", userId = "00000000-0000-4000-8000-000000000002", sessionId = "00000000-0000-4000-8000-000000000003";
const conversationId = "00000000-0000-4000-8000-000000000004";
const identity = { orgId, userId, sessionId, accessEpoch: "1", expiresAt: Date.now() + 60000 };
const row: WorkspaceRow = { target: { kind: "conversation", orgId, conversationId }, name: "Ada", context: "123 Oak", preview: "A real conversation", timeLabel: "Now", outcomeLabel: "Needs outcome", assignedLabel: "Unassigned" };
const conversationId2 = "00000000-0000-4000-8000-000000000005";
const row2: WorkspaceRow = { target: { kind: "conversation", orgId, conversationId: conversationId2 }, name: "Bea", context: "456 Pine", preview: "A second conversation", timeLabel: "Now", outcomeLabel: "Needs outcome", assignedLabel: "Unassigned" };
const detailFields = { propertyId: "00000000-0000-0000-0000-000000000006", contactId: "00000000-0000-0000-0000-000000000007", contactName: "Ada", propertyAddress: "123 Oak", propertyStatus: "prospect", outreachDispo: null, assigneeId: null, threadCustomerPhone: "+15555550100", threadBusinessPhone: "+15555550199", contactDoNotContact: false, contactSmsOptedOut: false, phoneSuppressed: false, smsSafetyReadFailed: false, isDncLocked: false, aiDispositionReview: null, aiResponderStatus: null, aiResponderReason: null, aiResponderStatusAt: null, aiLastDeliveryStatus: null, aiLastDeliveryError: null };
let calls: string[];
beforeEach(() => {
  vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockImplementation(() => ({ x: 0, y: 0, left: 0, top: 0, width: 900, height: 600, right: 900, bottom: 600, toJSON: () => ({}) }));
  Object.defineProperty(HTMLElement.prototype, "offsetHeight", { configurable: true, get: () => 600 });
  Object.defineProperty(HTMLElement.prototype, "offsetWidth", { configurable: true, get: () => 900 });
  calls = []; state.replacements = []; state.deny = false; state.itemUnavailable = false; state.detailUnavailable = false; state.selectionUnavailable = false; state.deferNextSelectionReview = false; state.resolveDeferredSelectionReview = null; state.worksetUpdates = "none";
  vi.stubGlobal("fetch", vi.fn(async (url: string, init?: RequestInit) => {
    calls.push(url);
    if (url.includes("/selection-review")) {
      const body = JSON.parse(String(init?.body ?? "{}")) as { generation: string; targets: { kind: string; id: string }[]; filter: { view: string } };
      const response = () => Response.json({ orgId, requesterId: userId, sessionId, accessEpoch: "1", generation: body.generation, items: body.targets.map(target => ({ ...target, status: state.selectionUnavailable && target.id === conversationId2 ? "unavailable" : target.id === conversationId && body.filter.view === "unread" ? "outside_filter" : "matching", name: state.selectionUnavailable && target.id === conversationId2 ? null : target.id === conversationId ? "Ada (authoritative)" : "Bea (authoritative)" })) });
      if (state.deferNextSelectionReview) {
        state.deferNextSelectionReview = false;
        return new Promise<Response>(resolve => { state.resolveDeferredSelectionReview = () => resolve(response()); });
      }
      return response();
    }
    if (url.includes("/workset-updates")) {
      if (state.worksetUpdates === "error") return Response.json({}, { status: 503 });
      return Response.json({ scopeId: "scope", orgId, requesterId: userId, sessionId, accessEpoch: "1", generation: "generation-1", hasUpdates: state.worksetUpdates === "has", refreshRequired: state.worksetUpdates === "required" });
    }
    if (url.includes("/detail")) return state.detailUnavailable ? Response.json({}, { status: 404 }) : Response.json({ orgId, requesterId: userId, conversationId, ...detailFields, history: [{ id: "message", direction: "inbound", body: "Hello from history", createdAtRaw: new Date().toISOString(), readAtRaw: null, inboundRevision: "1" }], readBoundary: "boundary", boundaryExpiresAt: new Date(Date.now() + 60000).toISOString(), captureGeneration: "capture", headRevision: "1" });
    if (url.includes("/counts")) return Response.json({ accessEpoch: "1", asOf: new Date().toISOString(), counts: { all: 1000, unread: 10 } });
    if (url.includes("read-acknowledgments")) return state.itemUnavailable ? Response.json({}, { status: 404 }) : Response.json({ boundaryId: "boundary", batch: 0, changed: 1, completed: true });
    if (state.deny) return Response.json({}, { status: 403 });
    return Response.json({ scopeId: "scope", orgId, requesterId: userId, sessionId, accessEpoch: "1", generation: "generation-1", expiresAt: Date.now() + 60000, orderedIds: [workspaceId(row.target)], nextCursor: null, refreshed: false });
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
it("keeps selected identities across a view change and permits removing hidden selections", async () => {
  await loaded();
  fireEvent.click(screen.getByRole("checkbox", { name: "Select Ada" }));
  fireEvent.change(screen.getByRole("combobox"), { target: { value: "unread" } });
  await waitFor(() => expect(state.replacements).toHaveLength(2));
  act(() => state.callbacks!.onChange({ state: "live", rows: [] }));
  expect(screen.getByText(/1 selected · 1 not loaded here/)).toBeVisible();
  fireEvent.click(screen.getByRole("button", { name: "Review selection" }));
  await screen.findByText(/outside this view/);
  expect(screen.getByRole("dialog")).toHaveTextContent("Ada (authoritative)");
  fireEvent.click(screen.getByRole("button", { name: "Remove" }));
  expect(screen.getByRole("dialog")).toHaveTextContent("0 selected conversations");
});
it("renders matching and outside-filter classifications from the authoritative review", async () => {
  await loaded();
  act(() => state.callbacks!.onChange({ state: "live", rows: [row, row2] }));
  fireEvent.click(screen.getByRole("checkbox", { name: "Select Ada" }));
  fireEvent.click(screen.getByRole("checkbox", { name: "Select Bea" }));
  fireEvent.change(screen.getByRole("combobox"), { target: { value: "unread" } });
  await waitFor(() => expect(state.replacements).toHaveLength(2));
  act(() => state.callbacks!.onChange({ state: "live", rows: [row2] }));
  fireEvent.click(screen.getByRole("button", { name: "Review selection" }));
  await screen.findByText(/1 outside this view/);
  expect(screen.getByRole("dialog")).toHaveTextContent("Ada (authoritative) (outside filter)");
  expect(screen.getByRole("dialog")).toHaveTextContent("Bea (authoritative) (matching loaded)");
});
it("discards a late selection review response after the filter starts a new review generation", async () => {
  await loaded();
  fireEvent.click(screen.getByRole("checkbox", { name: "Select Ada" }));
  state.deferNextSelectionReview = true;
  fireEvent.click(screen.getByRole("button", { name: "Review selection" }));
  await screen.findByText("Checking selected conversations…");
  const resolveStale = state.resolveDeferredSelectionReview!;
  fireEvent.click(screen.getByRole("button", { name: "Close" }));
  fireEvent.change(screen.getByRole("combobox"), { target: { value: "unread" } });
  await waitFor(() => expect(state.replacements).toHaveLength(2));
  fireEvent.click(screen.getByRole("button", { name: "Review selection" }));
  await screen.findByText(/outside this view/);
  expect(screen.getByRole("dialog")).toHaveTextContent("Ada (authoritative) (outside filter)");
  await act(async () => resolveStale());
  expect(screen.getByRole("dialog")).toHaveTextContent("Ada (authoritative) (outside filter)");
});
it("shows a bounded arrival indicator without reordering rows or changing selection until refresh", async () => {
  state.worksetUpdates = "has";
  await loaded();
  act(() => state.callbacks!.onChange({ state: "live", rows: [row, row2] }));
  fireEvent.click(screen.getByRole("checkbox", { name: "Select Ada" }));
  const arrivals = await screen.findByRole("button", { name: /New conversations available/ });
  const list = screen.getByRole("list", { name: "Inbox conversations" });
  expect(list).toHaveTextContent("Ada");
  expect(list).toHaveTextContent("Bea");
  const residentItems = screen.getAllByRole("listitem");
  expect(residentItems[0]).toHaveTextContent("Ada");
  expect(residentItems[1]).toHaveTextContent("Bea");
  expect(screen.getByRole("checkbox", { name: "Select Ada" })).toBeChecked();
  fireEvent.click(arrivals);
  await waitFor(() => expect(state.replacements).toHaveLength(2));
  act(() => state.callbacks!.onChange({ state: "live", rows: [row, row2] }));
  expect(screen.getByRole("checkbox", { name: "Select Ada" })).toBeChecked();
});
it("surfaces a refresh-required workset without auto-loading a new page", async () => {
  state.worksetUpdates = "required";
  await loaded();
  await screen.findByRole("button", { name: /Refresh required to check/ });
  expect(state.replacements).toHaveLength(1);
});
it("surfaces a transient workset probe failure without auto-loading a new page", async () => {
  state.worksetUpdates = "error";
  await loaded();
  await screen.findByText("New conversation check unavailable; retrying.");
  expect(state.replacements).toHaveLength(1);
});
it("does not reuse a cached name for an unavailable authoritative target", async () => {
  await loaded();
  act(() => state.callbacks!.onChange({ state: "live", rows: [row, row2] }));
  fireEvent.click(screen.getByRole("checkbox", { name: "Select Bea" }));
  state.selectionUnavailable = true;
  fireEvent.click(screen.getByRole("button", { name: "Review selection" }));
  await screen.findByText("Unavailable");
  expect(screen.getByRole("dialog")).not.toHaveTextContent("Bea (authoritative)");
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
  await screen.findByText("Bea (authoritative)");
  expect(screen.getByRole("dialog")).toHaveTextContent("1 selected conversations");
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
