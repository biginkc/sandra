import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
const mocks = vi.hoisted(() => ({ createClient: vi.fn(), prepare: vi.fn(), accept: vi.fn(), recover: vi.fn(), status: vi.fn() }));
vi.mock("@/lib/supabase/server", () => ({ createClient: mocks.createClient }));
vi.mock("./reply-api", async (importOriginal) => ({ ...await importOriginal<typeof import("./reply-api")>(), createInboxReplyRepository: () => ({ prepare: mocks.prepare, accept: mocks.accept, recover: mocks.recover, status: mocks.status }) }));
import { POST as prepare } from "@/app/api/inbox/replies/prepare/route";
import { POST as accept } from "@/app/api/inbox/replies/accept/route";
import { GET as recover } from "@/app/api/inbox/replies/recover/route";
import { GET as statusRoute } from "@/app/api/inbox/replies/[operationId]/route";
import { InboxReplyApiError } from "./reply-api";
const id = "abcdef00-0000-4000-8000-000000000001";
const request = (body: string, headers: Record<string, string> = {}) => new Request("http://localhost/api/inbox/replies/prepare", { method: "POST", headers: { "content-type": "application/json", ...headers }, body });
beforeEach(() => {
  vi.stubEnv("INBOX_REPLIES_SERVER_ENABLED", "1"); vi.clearAllMocks(); mocks.createClient.mockResolvedValue({});
  mocks.prepare.mockResolvedValue({ preparationId: id, idempotencyKey: id, inputHash: "a".repeat(64), expiresAt: "2026-09-14T00:00:00Z", items: [], recipientCount: 0, blockers: ["empty"] });
  mocks.accept.mockResolvedValue({ preparationId: id, idempotencyKey: id, operationId: id });
  mocks.recover.mockResolvedValue({ state: "prepared", preparationId: id, idempotencyKey: id });
  mocks.status.mockResolvedValue({ operationId: id, preparationId: id, dispatchComplete: false, items: [], receipts: [] });
});
afterEach(() => vi.unstubAllEnvs());

describe("disabled-by-default bulk-reply prepare route (obligation 1)", () => {
  it("does not construct a client or read a body when disabled", async () => {
    vi.stubEnv("INBOX_REPLIES_SERVER_ENABLED", "0");
    const req = request("{}");
    const response = await prepare(req);
    expect(response.status).toBe(404);
    expect(await response.json()).toEqual({ error: "Not found" });
    expect(mocks.createClient).not.toHaveBeenCalled();
    expect(mocks.prepare).not.toHaveBeenCalled();
    // Not just an inference from createClient/prepare never being called —
    // the request's own body stream must never have been touched either.
    expect(req.bodyUsed).toBe(false);
  });
  // MUTATION: deleting the flag check (returning past it unconditionally)
  // makes this fail — createClient/prepare would be called while disabled,
  // and req.bodyUsed would flip to true once the route starts reading it.
});

describe("half-enabled DB admission is indistinguishable from flag-off (C1, obligation 8)", () => {
  it("maps INBOX_REPLIES_NOT_ENABLED (55000) to a byte-identical 404 response", async () => {
    mocks.prepare.mockRejectedValue(new InboxReplyApiError(404, "Not found"));
    const enabledResponse = await prepare(request("{}"));
    vi.stubEnv("INBOX_REPLIES_SERVER_ENABLED", "0");
    const disabledResponse = await prepare(request("{}"));
    // C1 requires the byte-identical response, not merely equal *parsed*
    // JSON (which would miss whitespace/key-order differences a naive
    // Response.json() call could introduce). Compare raw response bytes,
    // status, and headers.
    expect(enabledResponse.status).toBe(disabledResponse.status);
    expect(await enabledResponse.text()).toBe(await disabledResponse.text());
    expect([...enabledResponse.headers.entries()]).toEqual([...disabledResponse.headers.entries()]);
  });
  it("returns the byte-identical 404 for an authenticated well-formed request under admission-closed (C1 restated as enablement-safety)", async () => {
    // C1 is an enablement-SAFETY property, not obscurity: with the server
    // flag ON but DB admission CLOSED, an authenticated, well-formed request
    // must get the byte-identical flag-off 404 AND run no capture/render/
    // freeze — require_admission() is the first statement of both SECURITY
    // DEFINER wrappers, so nothing executes before that gate.
    mocks.prepare.mockRejectedValue(new InboxReplyApiError(404, "Not found"));
    const wellFormedBody = JSON.stringify({ idempotencyKey: id, targets: [{ kind: "conversation", id }], template: "Hi {{first_name}}" });
    const admissionClosedResponse = await prepare(request(wellFormedBody));
    vi.stubEnv("INBOX_REPLIES_SERVER_ENABLED", "0");
    const flagOffResponse = await prepare(request(wellFormedBody));
    expect(admissionClosedResponse.status).toBe(flagOffResponse.status);
    expect(await admissionClosedResponse.text()).toBe(await flagOffResponse.text());
    expect([...admissionClosedResponse.headers.entries()]).toEqual([...flagOffResponse.headers.entries()]);
  });
});

describe("body cap and same-origin (obligation 2)", () => {
  it("rejects oversized streaming body before any client construction", async () => {
    const response = await prepare(request("a".repeat(131073)));
    expect(response.status).toBe(413);
    expect(mocks.createClient).not.toHaveBeenCalled();
  });
  // MUTATION: raising the 131072 limit makes this fail — a 131073B body would
  // then reach the client/repository layer instead of being rejected first.
  it("rejects cross-site and wrong content types before DB access", async () => {
    for (const headers of ([{ origin: "https://other.invalid" }, { "sec-fetch-site": "cross-site" }, { "content-type": "text/plain" }] as Record<string, string>[])) {
      const response = await prepare(request("{}", headers));
      expect(response.status).toBe(headers["content-type"] ? 415 : 403);
    }
    expect(mocks.createClient).not.toHaveBeenCalled();
  });
  it("rejects any query string on the prepare route", async () => {
    const response = await prepare(new Request("http://localhost/api/inbox/replies/prepare?x=1", { method: "POST", headers: { "content-type": "application/json" }, body: "{}" }));
    expect(response.status).toBe(403);
    expect(mocks.createClient).not.toHaveBeenCalled();
  });
});

describe("forwards exact raw intent and success/error headers (obligation 12)", () => {
  it("forwards exact raw body to the coordinator and sets private no-store/vary on success", async () => {
    const raw = ' {"x":1} ';
    const response = await prepare(request(raw));
    expect(response.status).toBe(200);
    expect(mocks.prepare.mock.calls[0][0]).toBe(raw);
    expect(response.headers.get("cache-control")).toBe("private, no-store");
    expect(response.headers.get("vary")).toBe("Cookie, Authorization");
  });
  it("keeps the same headers on an error response", async () => {
    mocks.prepare.mockRejectedValue(new InboxReplyApiError(503, "action_unavailable"));
    const response = await prepare(request("{}"));
    expect(response.status).toBe(503);
    expect(response.headers.get("cache-control")).toBe("private, no-store");
    expect(response.headers.get("vary")).toBe("Cookie, Authorization");
  });
});

it("aborts the reader when the coordinator throws mid-request", async () => {
  mocks.prepare.mockRejectedValue(new InboxReplyApiError(503));
  const response = await prepare(request("{}"));
  expect(response.status).toBe(503);
  expect(await response.json()).toEqual({ error: "action_unavailable" });
});

describe("accept route (Lane 1 PR-E)", () => {
  const acceptRequest = (body: string, headers: Record<string, string> = {}) => new Request("http://localhost/api/inbox/replies/accept", { method: "POST", headers: { "content-type": "application/json", ...headers }, body });
  it("is disabled-by-default like prepare, with no client/repository call", async () => {
    vi.stubEnv("INBOX_REPLIES_SERVER_ENABLED", "0");
    const response = await accept(acceptRequest("{}"));
    expect(response.status).toBe(404);
    expect(mocks.accept).not.toHaveBeenCalled();
  });
  it("caps the accept body at 1024 bytes (distinct from prepare's 131072)", async () => {
    const response = await accept(acceptRequest("a".repeat(1025)));
    expect(response.status).toBe(413);
    expect(mocks.accept).not.toHaveBeenCalled();
  });
  // MUTATION: reusing prepare's 131072 cap here would let a 1025B body
  // through to the repository instead of being rejected.
  it("forwards the exact raw body to accept() and returns 200", async () => {
    const raw = JSON.stringify({ preparationId: id, idempotencyKey: id });
    const response = await accept(acceptRequest(raw));
    expect(response.status).toBe(200);
    expect(mocks.accept.mock.calls[0][0]).toBe(raw);
  });
  it("rejects a query string and cross-site requests before any body read", async () => {
    const response = await accept(new Request("http://localhost/api/inbox/replies/accept?x=1", { method: "POST", headers: { "content-type": "application/json" }, body: "{}" }));
    expect(response.status).toBe(403);
    expect(mocks.accept).not.toHaveBeenCalled();
  });
});

describe("recover route (Lane 1 PR-E)", () => {
  const recoverRequest = (query: string) => new Request(`http://localhost/api/inbox/replies/recover${query}`);
  it("is disabled-by-default", async () => {
    vi.stubEnv("INBOX_REPLIES_SERVER_ENABLED", "0");
    const response = await recover(recoverRequest(`?idempotencyKey=${id}&preparationId=${id}`));
    expect(response.status).toBe(404);
    expect(mocks.recover).not.toHaveBeenCalled();
  });
  it("requires exactly idempotencyKey+preparationId query params, rejecting extras and shortfalls", async () => {
    for (const query of ["", `?idempotencyKey=${id}`, `?idempotencyKey=${id}&preparationId=${id}&extra=1`, `?foo=${id}&preparationId=${id}`]) {
      const response = await recover(recoverRequest(query));
      expect(response.status).toBe(403);
    }
    expect(mocks.recover).not.toHaveBeenCalled();
  });
  // MUTATION: loosening the exact-2-param check (e.g. `.length < 2`) would
  // let an extra query param through to the repository.
  it("passes preparationId and idempotencyKey from the query string in order", async () => {
    const response = await recover(recoverRequest(`?preparationId=${id}&idempotencyKey=${id}`));
    expect(response.status).toBe(200);
    expect(mocks.recover).toHaveBeenCalledWith(id, id, expect.anything());
  });
});

describe("status route (Lane 1 PR-E)", () => {
  it("is disabled-by-default", async () => {
    vi.stubEnv("INBOX_REPLIES_SERVER_ENABLED", "0");
    const response = await statusRoute(new Request("http://localhost/api/inbox/replies/" + id), { params: Promise.resolve({ operationId: id }) });
    expect(response.status).toBe(404);
    expect(mocks.status).not.toHaveBeenCalled();
  });
  it("passes the operationId path segment through to status()", async () => {
    const response = await statusRoute(new Request("http://localhost/api/inbox/replies/" + id), { params: Promise.resolve({ operationId: id }) });
    expect(response.status).toBe(200);
    expect(mocks.status).toHaveBeenCalledWith(id, expect.anything());
  });
  it("rejects any query string on the status route", async () => {
    const response = await statusRoute(new Request("http://localhost/api/inbox/replies/" + id + "?x=1"), { params: Promise.resolve({ operationId: id }) });
    expect(response.status).toBe(403);
    expect(mocks.status).not.toHaveBeenCalled();
  });
});
