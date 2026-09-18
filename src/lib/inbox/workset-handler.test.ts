import { describe, expect, it, vi } from "vitest";
import { createInboxWorksetHandler } from "./workset-handler";
import { InboxHttpError } from "./http-error";
const report = vi.hoisted(() => vi.fn());
vi.mock("./report-failure", () => ({ reportInboxFailure: report }));
import type { DurableInboxScope, InboxWorksetRepository } from "./sync-gateway";
const id = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
function fixture() {
  const scope: DurableInboxScope = { id, orgId: id, userId: id, sessionId: id, accessEpoch: "1", generation: "1", expiresAt: 5000, targets: [{ kind: "known_conversation", id }], handles: [null] };
  const repo: InboxWorksetRepository = { authenticate: vi.fn(async () => ({ userId: id, sessionId: id, expiresAt: 10000 })), createScope: vi.fn(async () => ({ ...scope, createdAt: 1000, nextCursor: null, refreshed: false })), getScope: vi.fn(async () => scope), getAccess: vi.fn(async () => ({ sessionActive: true, activeMembershipCount: 1, status: "active" as const, epoch: "1", expiresAt: null, deletionPrepared: false })), bindHandle: vi.fn(async () => true) };
  const make = () => createInboxWorksetHandler(repo, () => 1000);
  const request = (body = JSON.stringify({ orgId: id, filter: { view: "active" }, cursor: null, limit: 100, replacesScopeId: id })) => new Request("https://example.com/api/inbox/worksets", { method: "POST", headers: { "content-type": "application/json" }, body });
  return { scope, repo, make, request };
}
describe("bounded workset HTTP boundary", () => {
  it("forwards explicit replacement only to the durable creation transaction", async () => {
    const f = fixture(), response = await f.make()(f.request());
    expect(response.status).toBe(201); expect(response.headers.get("cache-control")).toBe("private, no-store");
    expect(await response.json()).toEqual({ scopeId: id, orgId: id, requesterId: id, sessionId: id, accessEpoch: "1", generation: "1", expiresAt: 5000, createdAt: 1000, nextCursor: null, refreshed: false, orderedIds: [JSON.stringify([id, "conversation", id])] });
    expect(f.repo.createScope).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({ replacesScopeId: id }), expect.any(AbortSignal));
  });
  it("accepts a full SQL TTL when creation finishes after the request starts", async () => {
    const f = fixture(); let now = 1000;
    f.repo.createScope = async () => { now = 4000; f.scope.expiresAt = now + 900000; return { ...f.scope, createdAt: now, nextCursor: null, refreshed: false }; };
    f.repo.authenticate = async () => ({ userId: id, sessionId: id, expiresAt: 1000000 });
    expect((await createInboxWorksetHandler(f.repo, () => now)(f.request())).status).toBe(201);
  });
  it("validates canonical TTL without rejecting positive database clock skew", async () => {
    const f = fixture();
    f.repo.authenticate = async () => ({ userId: id, sessionId: id, expiresAt: 1000000 });
    f.scope.expiresAt = 901084;
    f.repo.createScope = async () => ({ ...f.scope, createdAt: 1084, nextCursor: null, refreshed: false });
    expect((await f.make()(f.request())).status).toBe(201);
    f.scope.expiresAt++;
    expect((await f.make()(f.request())).status).toBe(503);
  });
  it("rejects oversized bodies before creating any scope", async () => {
    const f = fixture(); expect((await f.make()(f.request(" ".repeat(16385)))).status).toBe(413);
    expect(f.repo.createScope).not.toHaveBeenCalled();
  });
  it("does not return a scope revoked between creation and response", async () => {
    const f = fixture(); f.repo.getScope = async () => null;
    expect((await f.make()(f.request())).status).toBe(403);
  });
  it("does not disclose database errors or return false success", async () => {
    const f = fixture(); f.repo.createScope = async () => { throw Error("private SQL"); };
    const response = await f.make()(f.request()); expect(response.status).toBe(503); expect(await response.text()).not.toContain("private SQL");
    expect(report).toHaveBeenCalledWith("inbox_workset", "unexpected_failure");
  });
  it("exposes a retry hint only for the transient generation-rate domain error", async () => {
    const f = fixture(); f.repo.createScope = async () => { throw new InboxHttpError(429, 1); };
    const retry = await f.make()(f.request());
    expect(retry.status).toBe(429); expect(retry.headers.get("retry-after")).toBe("1");
    f.repo.createScope = async () => { throw new InboxHttpError(429); };
    const hardLimit = await f.make()(f.request());
    expect(hardLimit.status).toBe(429); expect(hardLimit.headers.get("retry-after")).toBeNull();
  });
  it("rejects a mutated scope reference after creation", async () => {
    const f = fixture(); f.repo.getAccess = async () => { f.scope.targets = []; return { sessionActive: true, activeMembershipCount: 1, status: "active" as const, epoch: "1", expiresAt: null, deletionPrepared: false }; };
    expect((await f.make()(f.request())).status).toBe(403);
  });
  it("cancels stalled incoming bodies on request abort", async () => {
    const f = fixture(), controller = new AbortController();
    let cancelled = false;
    const request = new Request("https://example.com/api/inbox/worksets", { method: "POST", headers: { "content-type": "application/json" }, body: new ReadableStream({ cancel() { cancelled = true; } }), signal: controller.signal, duplex: "half" } as RequestInit);
    const pending = f.make()(request); await new Promise(resolve => setTimeout(resolve, 5)); controller.abort();
    expect((await pending).status).toBe(503); expect(cancelled).toBe(true); expect(f.repo.createScope).not.toHaveBeenCalled();
  });
});
