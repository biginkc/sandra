import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { InboxWorkspaceClient } from "./workspace-client";
import { workspaceId } from "./selection";
import type { WorkspaceRow } from "./inbox-workspace";

const state = vi.hoisted(() => ({
  callbacks: null as null | { onChange: (value: unknown) => void; onProbe?: () => void },
  replacements: [] as unknown[],
}));
vi.mock("@/lib/inbox/workspace-sync", () => ({
  createWorkspaceSync: (callbacks: typeof state.callbacks) => {
    state.callbacks = callbacks;
    return {
      replace: (value: unknown) => { state.replacements.push(value); },
      reset: () => callbacks?.onChange({ state: "resync_required", rows: [] }),
      revoke: () => callbacks?.onChange({ state: "permission_lost", rows: [] }),
    };
  },
}));
vi.mock("./use-metadata-actions", () => ({
  useInboxMetadataActions: (options: { onCompleted: () => void }) => ({
    actions: [], prepare: () => {}, review: null, clear: () => {},
    activity: <button type="button" onClick={options.onCompleted}>Complete action</button>,
  }),
}));

const orgId = "00000000-0000-0000-0000-000000000001";
const userId = "00000000-0000-0000-0000-000000000002";
const sessionId = "00000000-0000-0000-0000-000000000003";
const conversationId = "00000000-0000-0000-0000-000000000004";
const identity = { orgId, userId, sessionId, accessEpoch: "1", expiresAt: Date.now() + 60000 };
const row: WorkspaceRow = { target: { kind: "conversation", orgId, conversationId }, name: "Ada", context: "123 Oak", preview: "A real conversation", timeLabel: "Now", outcomeLabel: "Needs outcome", assignedLabel: "Unassigned" };
const id = workspaceId(row.target);

let worksetBodies: Array<Record<string, unknown>>;
let detailVersion: number;
let markerCall = 0;
let markerResolvers: Array<(response: Response) => void>;
let deferMarkers = false;

function scope(scopeId: string, nextCursor: string | null, refreshed = false) {
  return { scopeId, orgId, requesterId: userId, sessionId, accessEpoch: "1", expiresAt: Date.now() + 60000, orderedIds: [id], nextCursor, refreshed };
}

function detail() {
  return { orgId, requesterId: userId, conversationId, history: [{ id: "00000000-0000-0000-0000-000000000010", direction: "inbound", body: `History version ${detailVersion}`, createdAtRaw: new Date().toISOString(), readAtRaw: null, inboundRevision: "1", status: "received", delivery: "delivered" }], readBoundary: "00000000-0000-0000-0000-000000000011", boundaryExpiresAt: new Date(Date.now() + 60000).toISOString(), captureGeneration: "00000000-0000-0000-0000-000000000012", headRevision: "1" };
}

beforeEach(() => {
  state.replacements = [];
  state.callbacks = null;
  worksetBodies = [];
  detailVersion = 1;
  markerCall = 0;
  markerResolvers = [];
  deferMarkers = false;
  vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockImplementation(() => ({ x: 0, y: 0, left: 0, top: 0, width: 900, height: 600, right: 900, bottom: 600, toJSON: () => ({}) }));
  Object.defineProperty(HTMLElement.prototype, "offsetHeight", { configurable: true, get: () => 600 });
  Object.defineProperty(HTMLElement.prototype, "offsetWidth", { configurable: true, get: () => 900 });
  vi.stubGlobal("fetch", vi.fn(async (url: string, init?: RequestInit) => {
    if (url.includes("/worksets")) {
      worksetBodies.push(JSON.parse(String(init?.body)));
      return Response.json(scope(`00000000-0000-0000-0000-${String(worksetBodies.length).padStart(12, "0")}`, worksetBodies.length === 1 ? "cursor-1" : "cursor-2", worksetBodies.length > 1));
    }
    if (url.includes("/counts")) return Response.json({ inDrip: 1, dripReplied: 0, accessEpoch: "1", asOf: new Date().toISOString() });
    if (url.includes("/drip-markers")) {
      markerCall += 1;
      if (deferMarkers) return await new Promise<Response>(resolve => markerResolvers.push(resolve));
      return Response.json({ orgId, asOf: new Date(Date.now() + markerCall).toISOString(), rows: [{ conversationId, propertyId: null, inDrip: false, dripReplied: false, dripName: null }] });
    }
    if (url.includes("/detail")) return Response.json(detail());
    if (url.includes("read-acknowledgments")) return Response.json({ boundaryId: "00000000-0000-0000-0000-000000000011", batch: 0, changed: 0, completed: true });
    return Response.json({});
  }));
});

afterEach(() => { cleanup(); vi.restoreAllMocks(); vi.unstubAllGlobals(); });

async function loaded(filter: { view: "all" | "in_drip" }) {
  render(<InboxWorkspaceClient identity={identity} initialFilter={{ ...filter, hide_noise: true }} actionsEnabled />);
  await waitFor(() => expect(state.replacements).toHaveLength(1));
  act(() => state.callbacks!.onChange({ state: "live", rows: [row] }));
}

it("re-derives the displayed page cursor during drip reconciliation", async () => {
  await loaded({ view: "in_drip" });
  fireEvent.click(screen.getByRole("button", { name: "Next 500" }));
  await waitFor(() => expect(state.replacements).toHaveLength(2));
  act(() => state.callbacks!.onChange({ state: "live", rows: [row] }));
  act(() => state.callbacks!.onProbe!());
  await waitFor(() => expect(worksetBodies).toHaveLength(3));
  expect(worksetBodies[2].cursor).toBe("cursor-1");
});

it("fences an older marker response after a newer snapshot publishes", async () => {
  deferMarkers = true;
  markerResolvers = [];
  await loaded({ view: "all" });
  await waitFor(() => expect(markerResolvers).toHaveLength(1));
  act(() => state.callbacks!.onProbe!());
  await waitFor(() => expect(markerResolvers).toHaveLength(2));
  await act(async () => markerResolvers[1](Response.json({ orgId, asOf: "2026-10-01T00:00:02Z", rows: [] })));
  await waitFor(() => expect(screen.queryByRole("img", { name: "In a drip" })).not.toBeInTheDocument());
  await act(async () => markerResolvers[0](Response.json({ orgId, asOf: "2026-10-01T00:00:01Z", rows: [{ conversationId, propertyId: null, inDrip: true, dripReplied: false, dripName: "Old" }] })));
  expect(screen.queryByRole("img", { name: "In a drip" })).not.toBeInTheDocument();
});

it("refreshes markers and the open detail after a completed workspace action", async () => {
  await loaded({ view: "all" });
  fireEvent.click(screen.getByRole("button", { name: "Open Ada" }));
  await screen.findByText("History version 1");
  detailVersion = 2;
  fireEvent.click(screen.getByRole("button", { name: "Complete action" }));
  await screen.findByText("History version 2");
  expect(worksetBodies).toHaveLength(2);
  expect(worksetBodies[1].cursor).toBeNull();
  expect(markerCall).toBeGreaterThanOrEqual(2);
});
