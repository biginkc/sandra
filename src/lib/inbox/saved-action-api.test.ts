import { describe, it, expect, vi } from "vitest";
import { createInboxSavedActionRepository, resolveSavedInboxActionSnapshot, savedActionReferenceFromRaw, isReviewReplySavedDefinition, buildReplyHandoffPayload, InboxSavedActionApiError, type InboxSavedActionClient } from "./saved-action-api";
import { InvalidInboxActionError } from "./action-definition";

const id = (n: number) => `abcdef00-0000-4000-8000-${String(n).padStart(12, "0")}`;
const signal = () => new AbortController().signal;
const ok = (data: unknown) => ({ data, error: null });
function client(results: unknown[]) {
    const rpc = vi.fn(() => ({ abortSignal: vi.fn(() => { const r = results.shift(); if (r instanceof Error) return Promise.reject(r); return Promise.resolve(r); }) }));
    return { rpc, repository: createInboxSavedActionRepository({ rpc } as unknown as InboxSavedActionClient) };
}
const outcomeDefinition = { version: 1, steps: [{ type: "outcome", value: "nurture" }] };
const row = (overrides: Record<string, unknown> = {}) => ({
    id: id(1), version: 1, name: "Test saved action", definition: outcomeDefinition,
    org_id: id(2), requester_id: id(3), is_active: true, created_at: "2026-09-14T00:00:00Z", ...overrides,
});

describe("saved-action repository", () => {
    it("round-trips create/update/deactivate/list/get and decodes RPC rows", async () => {
        const c = client([ok(row({ version: 1 }))]);
        const created = await c.repository.create("Test saved action", outcomeDefinition as never, signal());
        expect(created).toEqual({ id: id(1), version: 1, name: "Test saved action", definition: outcomeDefinition, createdAt: "2026-09-14T00:00:00Z" });
        expect(c.rpc.mock.calls[0]).toEqual(["inbox_saved_action_create", { name: "Test saved action", definition: outcomeDefinition }]);
    });
    it("rejects malformed rows fail-closed (503) instead of returning a partial value", async () => {
        const c = client([ok(row({ name: 123 }))]);
        await expect(c.repository.create("x", outcomeDefinition as never, signal())).rejects.toMatchObject({ status: 503 });
    });
    it("maps known P0001 codes to distinguishable statuses/codes", async () => {
        const cases: [string, number, string][] = [
            ["INBOX_SAVED_ACTION_NOT_FOUND", 404, "saved_action_not_found"],
            ["INBOX_SAVED_ACTION_STALE_VERSION", 409, "stale_version"],
            ["INBOX_SAVED_ACTION_STEP_TYPE_DISABLED", 409, "step_type_disabled"],
            ["INBOX_SAVED_ACTION_ASSIGNEE_UNAVAILABLE", 409, "assignee_unavailable"],
            ["permanent_dnc_not_enabled", 409, "permanent_dnc_not_enabled"],
        ];
        for (const [message, status, code] of cases) {
            const c = client([{ data: null, error: { code: "P0001", message } }]);
            await expect(c.repository.get(id(1), 1, signal())).rejects.toMatchObject({ status, code });
        }
    });
    it("maps cross-actor 42501 to 403 and revoked session to 401", async () => {
        await expect(client([{ data: null, error: { code: "42501", message: "INBOX_ACTION_FORBIDDEN" } }]).repository.get(id(1), 1, signal())).rejects.toMatchObject({ status: 403 });
        await expect(client([{ data: null, error: { code: "42501", message: "INBOX_SESSION_REVOKED" } }]).repository.get(id(1), 1, signal())).rejects.toMatchObject({ status: 401 });
    });
    it("get() asserts the returned row echoes the exact requested id+version", async () => {
        const c = client([ok(row({ id: id(9), version: 1 }))]);
        await expect(c.repository.get(id(1), 1, signal())).rejects.toMatchObject({ status: 503 });
    });
});

describe("resolveSavedInboxActionSnapshot", () => {
    it("resolves the exact stored snapshot for the matching actor", async () => {
        const c = client([ok(row({ id: id(1), version: 1, org_id: id(2), requester_id: id(3) }))]);
        const snapshot = await resolveSavedInboxActionSnapshot({ rpc: c.rpc } as unknown as InboxSavedActionClient, { id: id(1), version: 1 }, { organizationId: id(2), requesterId: id(3) }, signal());
        expect(snapshot).toEqual({ organizationId: id(2), requesterId: id(3), id: id(1), version: 1, definition: outcomeDefinition });
    });
    it("MUTATION: fails closed when the resolved row's org/requester does not match the calling actor (tampered/forged reference)", async () => {
        const c = client([ok(row({ id: id(1), version: 1, org_id: id(2), requester_id: id(3) }))]);
        await expect(resolveSavedInboxActionSnapshot({ rpc: c.rpc } as unknown as InboxSavedActionClient, { id: id(1), version: 1 }, { organizationId: id(2), requesterId: id(99) }, signal())).rejects.toMatchObject({ status: 403 });
    });
    it("rejects a non-UUID or non-positive-integer reference before any RPC", async () => {
        const c = client([]);
        await expect(resolveSavedInboxActionSnapshot({ rpc: c.rpc } as unknown as InboxSavedActionClient, { id: "not-a-uuid", version: 1 }, { organizationId: id(2), requesterId: id(3) }, signal())).rejects.toMatchObject({ status: 400 });
        expect(c.rpc).not.toHaveBeenCalled();
    });
});

describe("savedActionReferenceFromRaw (routing sniff only, never trusted for authorization)", () => {
    it("extracts a well-formed reference", () => {
        expect(savedActionReferenceFromRaw(JSON.stringify({ savedAction: { id: id(1), version: 2 } }))).toEqual({ id: id(1), version: 2 });
    });
    it("returns null for a definition-based (non-saved) request", () => {
        expect(savedActionReferenceFromRaw(JSON.stringify({ definition: { version: 1, steps: [] } }))).toBeNull();
    });
    it("returns null, never throws, on malformed input", () => {
        expect(savedActionReferenceFromRaw("not json")).toBeNull();
        expect(savedActionReferenceFromRaw(JSON.stringify({ savedAction: null }))).toBeNull();
        expect(savedActionReferenceFromRaw(JSON.stringify({ savedAction: { id: "bad", version: 1 } }))).toBeNull();
        expect(savedActionReferenceFromRaw(JSON.stringify({ savedAction: { id: id(1), version: 0 } }))).toBeNull();
        expect(savedActionReferenceFromRaw(JSON.stringify({ savedAction: { id: id(1), version: -1 } }))).toBeNull();
        expect(savedActionReferenceFromRaw(JSON.stringify([1, 2]))).toBeNull();
    });
});

describe("review_reply hand-off (never auto-send)", () => {
    it("identifies a single review_reply step as the hand-off shape", () => {
        expect(isReviewReplySavedDefinition({ version: 1, steps: [{ type: "review_reply", text: "Hi {{first_name}}" }] })).toBe(true);
        expect(isReviewReplySavedDefinition(outcomeDefinition as never)).toBe(false);
    });
    it("MUTATION: a review_reply step mixed with another step is NOT treated as the hand-off shape (would otherwise smuggle a second, unreviewed effect through the reply lane)", () => {
        expect(isReviewReplySavedDefinition({ version: 1, steps: [{ type: "review_reply", text: "Hi" }, { type: "assign", userId: null }] } as never)).toBe(false);
    });
    it("builds a reply-prepare payload from the ALREADY-VALIDATED idempotencyKey/targets (never a re-parse of the raw body) plus the saved text as template", () => {
        const definition = { version: 1 as const, steps: [{ type: "review_reply" as const, text: "Hi {{first_name}}" }] };
        const built = JSON.parse(buildReplyHandoffPayload(id(4), [{ kind: "conversation", id: id(5) }], definition));
        expect(built).toEqual({ idempotencyKey: id(4), targets: [{ kind: "conversation", id: id(5) }], template: "Hi {{first_name}}" });
    });
    it("MUTATION: refuses to build a hand-off payload for a non-review_reply (or multi-step) definition — this is the only gate that keeps a metadata definition out of the reply lane and vice versa", () => {
        expect(() => buildReplyHandoffPayload(id(4), [], outcomeDefinition as never)).toThrow(InvalidInboxActionError);
        expect(() => buildReplyHandoffPayload(id(4), [], { version: 1, steps: [{ type: "review_reply", text: "a" }, { type: "review_reply", text: "b" }] } as never)).toThrow(InvalidInboxActionError);
    });
    it("never includes an 'accept'/'send' field — the hand-off can only ever reach reply PREPARE, not accept", () => {
        const definition = { version: 1 as const, steps: [{ type: "review_reply" as const, text: "Hi" }] };
        const built = JSON.parse(buildReplyHandoffPayload(id(4), [{ kind: "conversation", id: id(5) }], definition));
        expect(Object.keys(built).sort()).toEqual(["idempotencyKey", "targets", "template"]);
    });
});

describe("InboxSavedActionApiError", () => {
    it("carries a stable status/code pair", () => {
        const err = new InboxSavedActionApiError(404, "saved_action_not_found");
        expect(err.status).toBe(404);
        expect(err.code).toBe("saved_action_not_found");
    });
});
