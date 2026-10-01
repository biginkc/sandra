import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { InboxWorkspaceClient } from "./workspace-client";
import { workspaceId } from "./selection";
import type { WorkspaceRow } from "./inbox-workspace";

const state = vi.hoisted(() => ({
  callbacks: null as null | { onChange: (value: unknown) => void; onProbe?: () => void },
  replacements: [] as unknown[],
  publishedNames: [] as string[],
  lastSnapshot: null as unknown,
  visibleName: "Ada",
  pageTwoName: "B",
  scopes: new Map<string, { revoked: boolean }>(),
  cursors: new Map<string, string>(),
  worksetBodies: [] as Array<Record<string, unknown>>,
  requestTimes: [] as number[],
  queuedStatuses: [] as number[],
  deferred: null as null | ((response: Response) => void),
  markerResolvers: [] as Array<(response: Response) => void>,
  deferMarkers: false,
  deferNext: false,
  failCursorPage: false,
  active: 0,
  maxConcurrent: 0,
  scopeNumber: 0,
}));

const orgId = "00000000-0000-0000-0000-000000000001";
const userId = "00000000-0000-0000-0000-000000000002";
const sessionId = "00000000-0000-0000-0000-000000000003";
const conversationId = "00000000-0000-0000-0000-000000000004";
const identity = { orgId, userId, sessionId, accessEpoch: "1", expiresAt: Date.now() + 60000 };
const row: WorkspaceRow = { target: { kind: "conversation", orgId, conversationId }, name: "Ada", context: "123 Oak", preview: "A real conversation", timeLabel: "Now", outcomeLabel: "Needs outcome", assignedLabel: "Unassigned" };
const id = workspaceId(row.target);

function publishedRow(): WorkspaceRow { return { ...row, name: state.visibleName }; }

vi.mock("@/lib/inbox/workspace-sync", () => ({
  createWorkspaceSync: (callbacks: typeof state.callbacks) => {
    state.callbacks = callbacks;
    return {
      replace: (value: unknown) => { state.replacements.push(value); state.publishedNames.push(state.visibleName); callbacks?.onChange({ state: "live", rows: [publishedRow()] }); },
      getSnapshot: () => ({ state: "live", rows: [publishedRow()] }),
      reset: () => callbacks?.onChange({ state: "resync_required", rows: [] }),
      revoke: () => { state.lastSnapshot = { state: "permission_lost", rows: [] }; callbacks?.onChange({ state: "permission_lost", rows: [] }); },
    };
  },
}));
vi.mock("./use-metadata-actions", () => ({
  useInboxMetadataActions: (options: { onCompleted: () => void }) => ({
    actions: [], prepare: () => {}, review: null, clear: () => {},
    activity: <button type="button" onClick={options.onCompleted}>Complete action</button>,
  }),
}));

function responseFor(_body: Record<string, unknown>, scopeId: string, nextCursor: string | null) {
  return Response.json({ scopeId, orgId, requesterId: userId, sessionId, accessEpoch: "1", expiresAt: Date.now() + 60000, orderedIds: [id], nextCursor, refreshed: false });
}

beforeEach(() => {
  vi.useFakeTimers();
  detailVersion = 1;
  state.callbacks = null;
  state.replacements = [];
  state.publishedNames = [];
  state.lastSnapshot = null;
  state.visibleName = "Ada";
  state.pageTwoName = "B";
  state.scopes.clear();
  state.cursors.clear();
  state.worksetBodies = [];
  state.requestTimes = [];
  state.queuedStatuses = [];
  state.deferred = null;
  state.markerResolvers = [];
  state.deferMarkers = false;
  state.deferNext = false;
  state.failCursorPage = false;
  state.active = 0;
  state.maxConcurrent = 0;
  state.scopeNumber = 0;
  vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockImplementation(() => ({ x: 0, y: 0, left: 0, top: 0, width: 900, height: 600, right: 900, bottom: 600, toJSON: () => ({}) }));
  Object.defineProperty(HTMLElement.prototype, "offsetHeight", { configurable: true, get: () => 600 });
  Object.defineProperty(HTMLElement.prototype, "offsetWidth", { configurable: true, get: () => 900 });
  vi.stubGlobal("fetch", vi.fn(async (url: string, init?: RequestInit) => {
    if (url.includes("/worksets")) {
      const body = JSON.parse(String(init?.body)) as Record<string, unknown>;
      state.worksetBodies.push(body);
      state.requestTimes.push(Date.now());
      state.active++;
      state.maxConcurrent = Math.max(state.maxConcurrent, state.active);
      const finish = (response: Response) => { state.active--; return response; };
      const status = state.queuedStatuses.shift();
      if (status) return finish(Response.json({ error: status === 429 ? "Please wait" : "Unavailable" }, { status }));
      const replaces = typeof body.replacesScopeId === "string" ? body.replacesScopeId : null;
      if (replaces && state.scopes.get(replaces)?.revoked) return finish(Response.json({ error: "Cursor denied" }, { status: 403 }));
      const cursor = typeof body.cursor === "string" ? body.cursor : null;
      if (cursor && (!state.cursors.has(cursor) || state.scopes.get(state.cursors.get(cursor)!)?.revoked)) return finish(Response.json({ error: "Cursor denied" }, { status: 403 }));
      if (state.failCursorPage && cursor) return finish(Response.json({ error: "Unavailable" }, { status: 503 }));
      if (replaces) state.scopes.get(replaces)!.revoked = true;
      const scopeId = `00000000-0000-0000-0000-${String(++state.scopeNumber).padStart(12, "0")}`;
      const nextCursor = `cursor-${state.scopeNumber}`;
      state.scopes.set(scopeId, { revoked: false });
      state.cursors.set(nextCursor, scopeId);
      state.visibleName = cursor === "cursor-stale" ? "STALE" : cursor ? state.pageTwoName : "Ada";
      const response = responseFor(body, scopeId, nextCursor);
      if (state.deferNext) {
        state.deferNext = false;
        return await new Promise<Response>(resolve => { state.deferred = (deferredResponse) => { state.deferred = null; state.active--; resolve(deferredResponse); }; });
      }
      return finish(response);
    }
    if (url.includes("/counts")) return Response.json({ counts: { all: 1, mine: 1, unassigned: 0, unread: 0, escalated: 0, dispo: 0, needs_outcome: 0, unknown: 0, dismissed: 0 }, accessEpoch: "1", asOf: new Date(Date.now()).toISOString(), updating: null });
    if (url.includes("/drip-markers")) {
      if (state.deferMarkers) return await new Promise<Response>(resolve => state.markerResolvers.push(resolve));
      return Response.json({ orgId, asOf: new Date(Date.now() + state.publishedNames.length + 1).toISOString(), rows: [{ conversationId, propertyId: null, inDrip: false, dripReplied: false, dripName: null }] });
    }
    if (url.includes("/detail")) return Response.json({ orgId, requesterId: userId, conversationId, history: [{ id: "00000000-0000-0000-0000-000000000010", direction: "inbound", body: `History version ${detailVersion}`, createdAtRaw: new Date(Date.now()).toISOString(), readAtRaw: null, inboundRevision: "1", status: "received", delivery: "delivered" }], readBoundary: "00000000-0000-0000-0000-000000000011", boundaryExpiresAt: new Date(Date.now() + 60000).toISOString(), captureGeneration: "00000000-0000-0000-0000-000000000012", headRevision: "1" });
    if (url.includes("read-acknowledgments")) return Response.json({ boundaryId: "00000000-0000-0000-0000-000000000011", batch: 0, changed: 0, completed: true });
    return Response.json({});
  }));
});

let detailVersion = 1;

afterEach(() => { cleanup(); vi.restoreAllMocks(); vi.unstubAllGlobals(); vi.useRealTimers(); });

async function flush() {
  await act(async () => { for (let i = 0; i < 8; i++) await Promise.resolve(); });
}

async function advance(ms: number) {
  await act(async () => { await vi.advanceTimersByTimeAsync(ms); });
  await flush();
}

async function loaded(filter: { view: "all" | "in_drip" }) {
  render(<InboxWorkspaceClient identity={identity} initialFilter={{ ...filter, hide_noise: true }} actionsEnabled />);
  await flush();
  expect(state.replacements).toHaveLength(1);
}

async function moveToPageTwo(filter: { view: "all" | "in_drip" }) {
  await loaded(filter);
  fireEvent.click(screen.getByRole("button", { name: "Next 500" }));
  await advance(1100);
  expect(state.replacements).toHaveLength(2);
}

it("T1 re-derives the displayed page with fresh cursors and keeps page two visible", async () => {
  await moveToPageTwo({ view: "in_drip" });
  state.pageTwoName = "B'";
  act(() => state.callbacks!.onProbe!());
  await advance(1100);
  await advance(1100);
  expect(state.worksetBodies[2].cursor).toBeNull();
  expect(state.worksetBodies[3].cursor).not.toBe(state.worksetBodies[1].cursor);
  expect(state.publishedNames.at(-1)).toBe("B'");
  expect(state.lastSnapshot).not.toMatchObject({ state: "permission_lost" });
  expect(screen.queryByText("The request could not be completed. Try again.")).not.toBeInTheDocument();
});

it("T2 uses the same re-walk after a workspace reply/disposition and rereads the open detail", async () => {
  await moveToPageTwo({ view: "all" });
  fireEvent.click(screen.getByRole("button", { name: "Open B" }));
  await flush();
  expect(screen.getByText("History version 1")).toBeInTheDocument();
  detailVersion = 2;
  fireEvent.click(screen.getByRole("button", { name: "Complete action" }));
  await advance(1100);
  await advance(1100);
  expect(state.worksetBodies.slice(-2).map(body => body.cursor)).toEqual([null, expect.any(String)]);
  expect(screen.getByText("History version 2")).toBeInTheDocument();
  expect(state.publishedNames.at(-1)).toBe("B");
});

it("T3 paces workset creation and retries a 429 with identical inputs", async () => {
  await loaded({ view: "in_drip" });
  state.queuedStatuses = [429];
  act(() => state.callbacks!.onProbe!());
  await advance(1100);
  expect(state.worksetBodies).toHaveLength(2);
  const firstAttempt = JSON.stringify(state.worksetBodies[1]);
  await advance(1100);
  expect(state.worksetBodies).toHaveLength(3);
  expect(JSON.stringify(state.worksetBodies[2])).toBe(firstAttempt);
  expect(state.requestTimes.slice(-2)[1] - state.requestTimes.slice(-2)[0]).toBeGreaterThanOrEqual(1000);

  state.queuedStatuses = [429, 429, 429, 429, 429];
  act(() => state.callbacks!.onProbe!());
  for (let attempt = 0; attempt < 18; attempt++) await advance(1100);
  expect(screen.getByText("Please wait before refreshing this view.")).toBeInTheDocument();
});

it("T4 coalesces probes into one serialized follow-up walk", async () => {
  await moveToPageTwo({ view: "in_drip" });
  state.pageTwoName = "B'";
  act(() => { state.callbacks!.onProbe!(); state.callbacks!.onProbe!(); });
  await advance(1100);
  await advance(1100);
  expect(state.maxConcurrent).toBe(1);
  expect(state.worksetBodies).toHaveLength(4);
  expect(state.publishedNames.at(-1)).toBe("B'");
});

it("T5 fences a stale walk generation when the displayed page changes mid-walk", async () => {
  await moveToPageTwo({ view: "in_drip" });
  state.deferNext = true;
  const throwIfAborted = vi.spyOn(AbortSignal.prototype, "throwIfAborted").mockImplementation(() => {});
  act(() => state.callbacks!.onProbe!());
  await advance(1100);
  expect(state.deferred).toBeTypeOf("function");
  act(() => state.callbacks!.onProbe!());
  state.visibleName = "STALE";
  state.scopes.set("00000000-0000-0000-0000-999999999999", { revoked: false });
  state.cursors.set("cursor-stale", "00000000-0000-0000-0000-999999999999");
  state.deferred!(responseFor({}, "00000000-0000-0000-0000-999999999999", "cursor-stale"));
  await flush();
  await advance(1100);
  await advance(1100);
  expect(state.replacements).toHaveLength(3);
  expect(state.publishedNames).not.toContain("STALE");
  throwIfAborted.mockRestore();
});

it("T6 surfaces a partial-walk error and recovers from the step-one live scope", async () => {
  await moveToPageTwo({ view: "in_drip" });
  state.failCursorPage = true;
  act(() => state.callbacks!.onProbe!());
  await advance(1100);
  await advance(1100);
  expect(screen.getByText("The request could not be completed. Try again.")).toBeInTheDocument();
  state.failCursorPage = false;
  state.pageTwoName = "B'";
  act(() => state.callbacks!.onProbe!());
  await advance(1100);
  await advance(1100);
  expect(state.publishedNames.at(-1)).toBe("B'");
  expect(screen.queryByRole("alert")).toBeNull();
});

it("fences an older marker response after a newer snapshot publishes", async () => {
  state.deferMarkers = true;
  const throwIfAborted = vi.spyOn(AbortSignal.prototype, "throwIfAborted").mockImplementation(() => {});
  render(<InboxWorkspaceClient identity={identity} initialFilter={{ view: "all", hide_noise: true }} actionsEnabled />);
  await flush();
  expect(state.markerResolvers).toHaveLength(2);
  act(() => state.callbacks!.onProbe!());
  await flush();
  expect(state.markerResolvers).toHaveLength(3);
  await act(async () => state.markerResolvers[2](Response.json({ orgId, asOf: "2026-10-01T00:00:02Z", rows: [] })));
  await flush();
  expect(screen.queryByRole("img", { name: "In a drip" })).not.toBeInTheDocument();
  await act(async () => state.markerResolvers[0](Response.json({ orgId, asOf: "2026-10-01T00:00:03Z", rows: [{ conversationId, propertyId: null, inDrip: true, dripReplied: false, dripName: "Old" }] })));
  await flush();
  expect(screen.queryByRole("img", { name: "In a drip" })).not.toBeInTheDocument();
  throwIfAborted.mockRestore();
});
