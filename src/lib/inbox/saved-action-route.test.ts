import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({ createClient: vi.fn(), pilot: vi.fn(), memberships: vi.fn(), list: vi.fn(), create: vi.fn(), update: vi.fn(), deactivate: vi.fn() }));
const SavedActionError = vi.hoisted(() => class extends Error { constructor(readonly status: number, code = "saved_action_unavailable") { super(code); } });
vi.mock("@/lib/supabase/server", () => ({ createClient: mocks.createClient }));
vi.mock("./pilot-cohort", () => ({ isInboxPilotRequest: mocks.pilot }));
vi.mock("@/lib/auth/memberships", () => ({ getCallerMembershipsOrThrow: mocks.memberships }));
vi.mock("./saved-action-api", () => ({ InboxSavedActionApiError: SavedActionError, createInboxSavedActionRepository: () => ({ list: mocks.list, create: mocks.create, update: mocks.update, deactivate: mocks.deactivate }) }));

import { GET, POST, PATCH, DELETE } from "@/app/api/inbox/saved-actions/route";

const id = "abcdef00-0000-4000-8000-000000000001";
const definition = { version: 1, steps: [{ type: "outcome", value: "nurture" }] };
const summary = { id, version: 1, name: "Nurture", definition, createdAt: "2026-09-17T00:00:00Z" };
const bodyRequest = (method: string, body: string, headers: Record<string, string> = {}) => new Request("http://localhost/api/inbox/saved-actions", { method, headers: { "content-type": "application/json", ...headers }, body });

beforeEach(() => {
  vi.stubEnv("INBOX_ACTIONS_SERVER_ENABLED", "1");
  vi.stubEnv("INBOX_WORKSPACE_ROLLOUT_MODE", "all");
  vi.clearAllMocks();
  mocks.createClient.mockResolvedValue({});
  mocks.pilot.mockResolvedValue(true);
  mocks.memberships.mockResolvedValue([{ user_id: id, org_id: id, role: "owner", acquisitions_enabled: false, access_status: "active" }]);
  mocks.list.mockResolvedValue([summary]);
  mocks.create.mockResolvedValue(summary);
  mocks.update.mockResolvedValue({ ...summary, version: 2 });
  mocks.deactivate.mockResolvedValue({ id, version: 3 });
});
afterEach(() => vi.unstubAllEnvs());

describe("saved action CRUD route boundary", () => {
  it("is flag-off before client creation and body consumption", async () => {
    vi.stubEnv("INBOX_ACTIONS_SERVER_ENABLED", "0");
    const request = bodyRequest("POST", JSON.stringify({ name: "Nurture", definition }));
    expect((await POST(request)).status).toBe(404);
    expect(request.bodyUsed).toBe(false);
    expect(mocks.createClient).not.toHaveBeenCalled();
  });

  it("requires cohort admission before repository calls", async () => {
    mocks.pilot.mockResolvedValue(false);
    expect((await GET(new Request("http://localhost/api/inbox/saved-actions"))).status).toBe(404);
    expect(mocks.createClient).toHaveBeenCalledOnce();
    expect(mocks.list).not.toHaveBeenCalled();
  });
  it("returns 404 before repository calls for an acquisitions-only member", async () => {
    mocks.memberships.mockResolvedValue([{ user_id: id, org_id: id, role: "member", acquisitions_enabled: true, access_status: "active" }]);
    expect((await GET(new Request("http://localhost/api/inbox/saved-actions"))).status).toBe(404);
    expect(mocks.list).not.toHaveBeenCalled();
  });

  it("lists through the repository with private response headers", async () => {
    const response = await GET(new Request("http://localhost/api/inbox/saved-actions"));
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ items: [summary] });
    expect(response.headers.get("cache-control")).toBe("private, no-store");
    expect(response.headers.get("vary")).toBe("Cookie, Authorization");
  });

  it("accepts only the exact create envelope and never accepts client targets", async () => {
    const response = await POST(bodyRequest("POST", JSON.stringify({ name: "Nurture", definition })));
    expect(response.status).toBe(200);
    expect(mocks.create).toHaveBeenCalledWith("Nurture", definition, expect.anything());
    expect((await response.json()).item).toEqual(summary);
    expect((await POST(bodyRequest("POST", JSON.stringify({ name: "Nurture", definition, targets: [] })))).status).toBe(400);
    expect(mocks.create).toHaveBeenCalledOnce();
  });

  it("uses strict JSON id for patch/delete and rejects duplicate keys, queries, and cross-site requests", async () => {
    expect((await PATCH(bodyRequest("PATCH", JSON.stringify({ id, name: "Renamed", definition })))).status).toBe(200);
    expect(mocks.update).toHaveBeenCalledWith(id, "Renamed", definition, expect.anything());
    expect((await DELETE(bodyRequest("DELETE", JSON.stringify({ id })))).status).toBe(200);
    expect(mocks.deactivate).toHaveBeenCalledWith(id, expect.anything());
    expect((await DELETE(bodyRequest("DELETE", JSON.stringify({ id, version: 1 })))).status).toBe(400);
    expect((await DELETE(bodyRequest("DELETE", `{"id":"${id}","id":"${id}"}`))).status).toBe(400);
    expect((await DELETE(new Request(`http://localhost/api/inbox/saved-actions?x=1`, { method: "DELETE", headers: { "content-type": "application/json" }, body: JSON.stringify({ id }) }))).status).toBe(403);
    expect((await DELETE(bodyRequest("DELETE", JSON.stringify({ id }), { "sec-fetch-site": "cross-site" }))).status).toBe(403);
  });

  it("caps malformed/oversized bodies before repository access", async () => {
    expect((await POST(bodyRequest("POST", "x".repeat(131073)))).status).toBe(413);
    expect((await POST(new Request("http://localhost/api/inbox/saved-actions", { method: "POST", headers: { "content-type": "text/plain" }, body: "{}" }))).status).toBe(415);
    expect(mocks.create).not.toHaveBeenCalled();
  });

  it("cancels a body that is still streaming when the request aborts", async () => {
    const controller = new AbortController();
    let cancelled = false;
    const stream = new ReadableStream<Uint8Array>({ cancel() { cancelled = true; } });
    const request = { url: "http://localhost/api/inbox/saved-actions", headers: new Headers({ "content-type": "application/json" }), body: stream, signal: controller.signal } as unknown as Request;
    const response = POST(request);
    await Promise.resolve();
    controller.abort();
    const result = await response;
    expect(result.status).toBe(503);
    expect(cancelled).toBe(true);
    expect(mocks.createClient).not.toHaveBeenCalled();
  });
});
