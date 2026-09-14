import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
const mocks = vi.hoisted(() => ({ createClient: vi.fn(), prepare: vi.fn() }));
vi.mock("@/lib/supabase/server", () => ({ createClient: mocks.createClient }));
vi.mock("./reply-api", async (importOriginal) => ({ ...await importOriginal<typeof import("./reply-api")>(), createInboxReplyRepository: () => ({ prepare: mocks.prepare }) }));
import { POST as prepare } from "@/app/api/inbox/replies/prepare/route";
import { InboxReplyApiError } from "./reply-api";
const id = "abcdef00-0000-4000-8000-000000000001";
const request = (body: string, headers: Record<string, string> = {}) => new Request("http://localhost/api/inbox/replies/prepare", { method: "POST", headers: { "content-type": "application/json", ...headers }, body });
beforeEach(() => { vi.stubEnv("INBOX_REPLIES_SERVER_ENABLED", "1"); vi.clearAllMocks(); mocks.createClient.mockResolvedValue({}); mocks.prepare.mockResolvedValue({ preparationId: id, idempotencyKey: id, inputHash: "a".repeat(64), expiresAt: "2026-09-14T00:00:00Z", items: [], recipientCount: 0, blockers: ["empty"] }); });
afterEach(() => vi.unstubAllEnvs());

describe("disabled-by-default bulk-reply prepare route (obligation 1)", () => {
  it("does not construct a client or read a body when disabled", async () => {
    vi.stubEnv("INBOX_REPLIES_SERVER_ENABLED", "0");
    const response = await prepare(request("{}"));
    expect(response.status).toBe(404);
    expect(await response.json()).toEqual({ error: "Not found" });
    expect(mocks.createClient).not.toHaveBeenCalled();
    expect(mocks.prepare).not.toHaveBeenCalled();
  });
  // MUTATION: deleting the flag check (returning past it unconditionally)
  // makes this fail — createClient/prepare would be called while disabled.
});

describe("half-enabled DB admission is indistinguishable from flag-off (C1, obligation 8)", () => {
  it("maps INBOX_REPLIES_NOT_ENABLED (55000) to a byte-identical 404 body", async () => {
    mocks.prepare.mockRejectedValue(new InboxReplyApiError(404, "Not found"));
    const enabledResponse = await prepare(request("{}"));
    vi.stubEnv("INBOX_REPLIES_SERVER_ENABLED", "0");
    const disabledResponse = await prepare(request("{}"));
    expect(enabledResponse.status).toBe(disabledResponse.status);
    expect(await enabledResponse.json()).toEqual(await disabledResponse.json());
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
