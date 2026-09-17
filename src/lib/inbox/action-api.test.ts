import { describe, it, expect, vi } from "vitest";
import { createInboxActionRepository, type InboxActionClient } from "./action-api";
import type { PreparedInboxAction } from "./action-api-contract";
import { parseInboxActionAcceptance, parseInboxActionIntent } from "./action-definition";
const id = (n: number) => `abcdef00-0000-4000-8000-${String(n).padStart(12, "0")}`;
const signal = () => new AbortController().signal;
const actor = { org_id: id(1), user_id: id(2), session_active: true, active_membership_count: 1 };
const request = { idempotencyKey: id(3), targets: [{ kind: "conversation", id: id(4) }], definition: { version: 1, steps: [{ type: "outcome", value: "nurture" }] } };
const intent = parseInboxActionIntent(JSON.stringify(request), { organizationId: id(1), requesterId: id(2) });
const prepared = () => ({ preparation_id: id(5), idempotency_key: id(3), input_hash: intent.inputHash, expires_at: "2026-09-14T00:00:00Z", definition: { steps: request.definition.steps, version: 1 }, items: [{ id: id(6), kind: "conversation", target_id: id(4), resolution: { property_id: id(7) }, exclusion_code: null }], effect_count: 1, affected_property_count: 1, sms_safety_summary: null });
function client(results: unknown[]) { const rpc = vi.fn(() => ({ abortSignal: vi.fn(() => { const r = results.shift(); if (r instanceof Error)
        return Promise.reject(r); return Promise.resolve(r); }) })); return { rpc, repository: createInboxActionRepository({ rpc } as unknown as InboxActionClient) }; }
const ok = (data: unknown) => ({ data, error: null });
const status = () => ({ operation_id: id(8), accepted_at: "2026-09-13T00:00:00Z", completed: true, result: "failed", items: [{ id: id(6), kind: "conversation", target_id: id(4), property_id: id(7), exclusion_code: null, step_ids: [id(9), id(10)], state: "conflicted", code: "record_changed" }], steps: [{ id: id(9), action: "outcome", state: "conflicted", code: "record_changed", receipt_version: "1", changed: false }, { id: id(10), action: "assign", state: "blocked", code: "predecessor_failed", receipt_version: "1", changed: false }] });
describe("authoritative Inbox action transport", () => {
    it("derives requester/org from live authorization and accepts jsonb member ordering", async () => { const c = client([ok(actor), ok(prepared())]); const p = await c.repository.prepare(JSON.stringify(request), signal()) as PreparedInboxAction; expect(p.eligibleCount).toBe(1); expect(c.rpc.mock.calls[1]).toEqual(["inbox_prepare_action", { canonical_input: intent.canonicalInput, idempotency_key: id(3) }]); });
    it("rejects client-supplied authority before prepare RPC", async () => { const c = client([ok(actor)]); await expect(c.repository.prepare(JSON.stringify({ ...request, organizationId: id(90) }), signal())).rejects.toMatchObject({ status: 400 }); expect(c.rpc).toHaveBeenCalledTimes(1); });
    it.each(["dnc", "callback_requested"])("keeps unsupported %s outcomes gated", async (value) => { const c = client([ok(actor)]); await expect(c.repository.prepare(JSON.stringify({ ...request, definition: { version: 1, steps: [{ type: "outcome", value }] } }), signal())).rejects.toMatchObject({ status: 400 }); expect(c.rpc).toHaveBeenCalledTimes(1); });
    it("rejects altered identity/hash, mapping and effect counts", async () => { for (const mutate of [(p: ReturnType<typeof prepared>) => { p.input_hash = "a".repeat(64); }, (p: ReturnType<typeof prepared>) => { p.items[0].target_id = id(98); }, (p: ReturnType<typeof prepared>) => { p.effect_count = 2; }]) {
        const p = prepared();
        mutate(p);
        const c = client([ok(actor), ok(p)]);
        await expect(c.repository.prepare(JSON.stringify(request), signal())).rejects.toMatchObject({ status: 503 });
    } });
    it("retries only explicit aborted acceptance transaction with exact references", async () => { const c = client([{ data: null, error: { code: "40P01" } }, ok({ operation_id: id(8), accepted_at: "2026-09-13T00:00:00Z" })]); expect((await c.repository.accept(id(5), id(3), signal())).operationId).toBe(id(8)); expect(c.rpc.mock.calls[0]).toEqual(c.rpc.mock.calls[1]); });
    it("retries complete preparation RPC after deadlock, without recomputing client identity", async () => { const c = client([ok(actor), { data: null, error: { code: "40001" } }, ok(prepared())]); await c.repository.prepare(JSON.stringify(request), signal()); expect(c.rpc.mock.calls[1]).toEqual(c.rpc.mock.calls[2]); expect(c.rpc).toHaveBeenCalledTimes(3); });
    it("does not retry ambiguous lost response", async () => { const c = client([new Error("lost response")]); await expect(c.repository.accept(id(5), id(3), signal())).rejects.toThrow("lost response"); expect(c.rpc).toHaveBeenCalledTimes(1); });
    it("exposes terminal conflict and blocked successor without pretending success", async () => { const c = client([ok(status())]); const s = await c.repository.status(id(8), signal()); expect(s.completed).toBe(true); expect(s.result).toBe("failed"); expect(s.items[0].code).toBe("record_changed"); });
    it("rejects fake completion or failed receipt without a code", async () => { for (const mutate of [(s: ReturnType<typeof status>) => { s.result = "succeeded"; }, (s: ReturnType<typeof status>) => { s.steps[0].receipt_version = "0"; }, (s: ReturnType<typeof status>) => { s.steps[0].code = null as unknown as string; }]) {
        const s = status();
        mutate(s);
        await expect(client([ok(s)]).repository.status(id(8), signal())).rejects.toMatchObject({ status: 503 });
    } });
    it("distinguishes conflict from generic PostgreSQL error", async () => { await expect(client([{ data: null, error: { code: "P0001", message: "INBOX_ACTION_PREPARATION_CHANGED" } }]).repository.accept(id(5), id(3), signal())).rejects.toMatchObject({ status: 409, code: "preparation_changed" }); await expect(client([{ data: null, error: { code: "XX000", message: "internal" } }]).repository.accept(id(5), id(3), signal())).rejects.toMatchObject({ status: 503 }); });
    it("keeps missing grants as infrastructure errors while distinguishing revoked session", async () => { await expect(client([{ data: null, error: { code: "42501", message: "permission denied for function inbox_accept_action" } }]).repository.accept(id(5), id(3), signal())).rejects.toMatchObject({ status: 503 }); await expect(client([{ data: null, error: { code: "42501", message: "INBOX_SESSION_REVOKED" } }]).repository.accept(id(5), id(3), signal())).rejects.toMatchObject({ status: 401 }); });
    it("does not issue RPC after cancellation", async () => { const c = client([]), controller = new AbortController(); controller.abort(); await expect(c.repository.accept(id(5), id(3), controller.signal)).rejects.toThrow(); expect(c.rpc).not.toHaveBeenCalled(); });
    it("acceptance reference parser rejects duplicate decoded keys and extra payload", () => { expect(() => parseInboxActionAcceptance(`{"preparationId":"${id(5)}","preparationId":"${id(5)}","idempotencyKey":"${id(3)}"}`)).toThrow(); expect(() => parseInboxActionAcceptance(JSON.stringify({ preparationId: id(5), idempotencyKey: id(3), definition: {} }))).toThrow(); expect(parseInboxActionAcceptance(JSON.stringify({ idempotencyKey: id(3), preparationId: id(5) }))).toEqual({ preparationId: id(5), idempotencyKey: id(3) }); });
});
describe("action review and recovery decoding", () => {
    it("returns bounded canonical assignee choices and rejects duplicate identities", async () => {
        const choices = { members: [{ user_id: id(11), label: "member@example.invalid" }] };
        expect(await client([ok(choices)]).repository.assignees(signal())).toEqual([{ userId: id(11), label: "member@example.invalid" }]);
        await expect(client([ok({ members: [choices.members[0], choices.members[0]] })]).repository.assignees(signal())).rejects.toMatchObject({ status: 503 });
    });
    it("recovers only the exact supplied key and distinguishes not observed", async () => {
        const c = client([ok({ state: "pending", operation: null }), ok({ state: "accepted", operation: { operation_id: id(8), accepted_at: "2026-09-13T00:00:00Z" } })]);
        expect(await c.repository.recover(id(5), id(3), signal())).toEqual({state:"pending",operation:null});
        expect(await c.repository.recover(id(5), id(3), signal())).toEqual({ state: "accepted", operation: { operationId: id(8), acceptedAt: "2026-09-13T00:00:00Z" } });
        expect(c.rpc.mock.calls[0]).toEqual(["inbox_recover_operation", { preparation_id: id(5), idempotency_key: id(3) }]);
    });
    it("requires an explicit expanded SMS scope for opt-out review", async () => {
        const raw = JSON.stringify({ ...request, definition: { version: 1, steps: [{ type: "outcome", value: "opted_out" }] } });
        const parsed = parseInboxActionIntent(raw, { organizationId: id(1), requesterId: id(2) });
        const row = { ...prepared(), input_hash: parsed.inputHash, definition: parsed.input.definition, sms_safety_summary: { contacts: 1, linked_properties: 2, active_enrollments: 3 } };
        expect((await client([ok(actor), ok(row)]).repository.prepare(raw, signal()) as PreparedInboxAction).smsSafetySummary).toEqual({ contacts: 1, linkedProperties: 2, activeEnrollments: 3 });
        await expect(client([ok(actor), ok({ ...row, sms_safety_summary: null })]).repository.prepare(raw, signal())).rejects.toMatchObject({ status: 503 });
    });
});
describe("saved-action prepare glue", () => {
    const savedRow = (definition: unknown, overrides: Record<string, unknown> = {}) => ({ id: id(20), version: 1, name: "Saved", definition, org_id: id(1), requester_id: id(2), is_active: true, created_at: "2026-09-14T00:00:00Z", ...overrides });
    it("resolves the exact stored version via an authorized lookup and threads it into the metadata seam (never the raw client definition)", async () => {
        const savedRequest = { idempotencyKey: id(3), targets: [{ kind: "conversation", id: id(4) }], savedAction: { id: id(20), version: 1 } };
        const savedDefinition = { version: 1, steps: [{ type: "outcome", value: "nurture" }] };
        const preparedRow = { preparation_id: id(5), idempotency_key: id(3), input_hash: "will not be checked here", expires_at: "2026-09-14T00:00:00Z", definition: savedDefinition, items: [{ id: id(6), kind: "conversation", target_id: id(4), resolution: { property_id: id(7) }, exclusion_code: null }], effect_count: 1, affected_property_count: 1, sms_safety_summary: null };
        // input_hash/definition echo must match the real parseInboxActionIntent
        // output for this exact saved snapshot, so compute it the same way the
        // route does rather than hand-typing a hash.
        const intentForHash = parseInboxActionIntent(JSON.stringify(savedRequest), { organizationId: id(1), requesterId: id(2) }, { organizationId: id(1), requesterId: id(2), id: id(20), version: 1, definition: savedDefinition as never });
        preparedRow.input_hash = intentForHash.inputHash;
        const c = client([ok(actor), ok(savedRow(savedDefinition)), ok(preparedRow)]);
        const p = await c.repository.prepare(JSON.stringify(savedRequest), signal()) as PreparedInboxAction;
        expect(p.eligibleCount).toBe(1);
        const calls = c.rpc.mock.calls as unknown as [string, Record<string, unknown>][];
        expect(calls[1][0]).toBe("inbox_saved_action_get");
        expect(calls[1][1]).toEqual({ id: id(20), version: 1 });
        // The canonical input sent to inbox_prepare_action must carry the
        // savedAction reference (not "savedAction":null / a client definition).
        expect((calls[2][1] as { canonical_input: string }).canonical_input).toContain(`"savedAction":{"id":"${id(20)}","version":1}`);
    });
    it("MUTATION: a savedAction reference whose resolved snapshot belongs to a different org/requester than the live session is rejected before any prepare RPC (owner mismatch)", async () => {
        const savedRequest = { idempotencyKey: id(3), targets: [{ kind: "conversation", id: id(4) }], savedAction: { id: id(20), version: 1 } };
        const c = client([ok(actor), ok(savedRow({ version: 1, steps: [{ type: "outcome", value: "nurture" }] }, { org_id: id(99) }))]);
        await expect(c.repository.prepare(JSON.stringify(savedRequest), signal())).rejects.toMatchObject({ status: 403 });
        expect(c.rpc).toHaveBeenCalledTimes(2);
    });
    it("review_reply saved actions hand off to reply PREPARE only — never inbox_accept_action/inbox_accept_reply, i.e. never auto-send", async () => {
        const savedRequest = { idempotencyKey: id(3), targets: [{ kind: "unknown_sender_group", id: id(4) }], savedAction: { id: id(20), version: 1 } };
        const reviewReplyDefinition = { version: 1, steps: [{ type: "review_reply", value: undefined, text: "Hi {{first_name}}" }] };
        const freezeRow = { idempotencyKey: id(3), replayed: false, items: [{ id: id(6), target: { kind: "unknown_sender_group", id: id(4) }, exclusion: "unsupported_target", recipient: null, duplicateDestination: false }], recipientCount: 0, blockers: ["empty"], preparationId: id(7), inputHash: "a".repeat(64), expiresAt: "2026-09-14T00:00:00Z" };
        const c = client([ok(actor), ok(savedRow(reviewReplyDefinition)), ok(freezeRow)]);
        const result = await c.repository.prepare(JSON.stringify(savedRequest), signal());
        expect(result).toMatchObject({ recipientCount: 0, blockers: ["empty"] });
        const calledRpcNames = (c.rpc.mock.calls as unknown as [string, unknown][]).map((call) => call[0]);
        expect(calledRpcNames).toEqual(["inbox_authorize_sync", "inbox_saved_action_get", "inbox_freeze_reply_review"]);
        expect(calledRpcNames).not.toContain("inbox_accept_action");
        expect(calledRpcNames).not.toContain("inbox_accept_reply");
        expect(calledRpcNames).not.toContain("inbox_prepare_action");
    });
    it("a non-savedAction request is unaffected (no saved-action RPC issued)", async () => {
        const c = client([ok(actor), ok(prepared())]);
        await c.repository.prepare(JSON.stringify(request), signal());
        expect((c.rpc.mock.calls as unknown as [string, unknown][]).map((call) => call[0])).toEqual(["inbox_authorize_sync", "inbox_prepare_action"]);
    });
});
it("distinguishes definitive expired-not-accepted from still pending and rejects contradictory recovery data", async () => {
    expect(await client([ok({ state: "expired_not_accepted", operation: null })]).repository.recover(id(5), id(3), signal())).toEqual({ state: "expired_not_accepted", operation: null });
    await expect(client([ok({ state: "expired_not_accepted", operation: { operation_id: id(8) } })]).repository.recover(id(5), id(3), signal())).rejects.toMatchObject({ status: 503 });
    await expect(client([ok({ state: "accepted", operation: null })]).repository.recover(id(5), id(3), signal())).rejects.toMatchObject({ status: 503 });
});
