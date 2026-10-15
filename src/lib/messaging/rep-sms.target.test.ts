import { beforeEach, describe, expect, it, vi } from "vitest";

const createClient = vi.hoisted(() => vi.fn());
vi.mock("@/lib/supabase/server", () => ({ createClient }));

import { ledgerTargetDisposition, messageTargetDisposition, obligationTargetDisposition, readRepSmsContext } from "./rep-sms";

const ID = "33333333-3333-4333-8333-333333333333";
const sender = { id: "sender-1", number: "+18163706846", label: "Mel", isDefault: true, provider: "sendillo", providerAccountId: "a", providerSenderId: "p", grantStatus: "active", compositionPolicyVersion: 1 };

/** A fake client: context RPCs, a ledger-target RPC, and one table row per table keyed by the filters used. */
function fakeClient(opts: { ledger?: unknown; obligationRow?: unknown; messageRow?: unknown; defaultObligation?: unknown }) {
  const calls: Array<{ table: string; filters: Array<[string, string]> }> = [];
  const rpc = vi.fn((name: string, args: Record<string, unknown>) => {
    if (name === "fn_get_rep_sms_context") {
      return Promise.resolve({ data: { orgId: "org-1", actorId: "rep-1", contactId: "contact-1", provider: "sendillo", senders: [sender], obligation: opts.defaultObligation ?? null }, error: null });
    }
    if (name === "fn_get_rep_sms_delivery_draft") return Promise.resolve({ data: { draft: null }, error: null });
    if (name === "fn_get_rep_sms_delivery_target") return Promise.resolve({ data: { target: opts.ledger ?? null }, error: null, args });
    return Promise.resolve({ data: null, error: { message: "unexpected rpc" } });
  });
  const from = vi.fn((table: string) => {
    const call = { table, filters: [] as Array<[string, string]> };
    calls.push(call);
    const chain: Record<string, unknown> = {};
    const result = () => {
      if (table === "rep_sms_obligations") return opts.obligationRow ?? null;
      if (table === "messages") return opts.messageRow ?? null;
      return { phone_1: "+18165550123", phone_1_type: "mobile" };
    };
    chain.select = () => chain;
    chain.eq = (c: string, v: string) => (call.filters.push([c, v]), chain);
    chain.or = (f: string) => (call.filters.push(["or", f]), chain);
    chain.maybeSingle = () => Promise.resolve({ data: result(), error: null });
    return chain;
  });
  return { client: { rpc, from }, calls, rpc };
}

beforeEach(() => {
  vi.resetAllMocks();
  vi.stubEnv("MESSAGING_PROVIDER", "sendillo");
  vi.stubEnv("SENDILLO_ORG_ID", "org-1");
});

describe("target dispositions", () => {
  it("ledger: definitive failures replace, unverified check, blocked review", () => {
    expect(ledgerTargetDisposition("failed_not_dispatched")).toBe("replace");
    expect(ledgerTargetDisposition("delivery_failed")).toBe("replace");
    expect(ledgerTargetDisposition("blocked")).toBe("review");
    for (const s of ["reserved", "sending", "unknown"]) expect(ledgerTargetDisposition(s)).toBe("check");
    expect(ledgerTargetDisposition("delivered")).toBe("resolved");
  });
  it("obligation: only required/draft/failed_not_dispatched resume; delivery_failed replaces", () => {
    for (const s of ["required", "draft", "failed_not_dispatched"]) expect(obligationTargetDisposition(s)).toBe("resume");
    expect(obligationTargetDisposition("delivery_failed")).toBe("replace");
    expect(obligationTargetDisposition("blocked")).toBe("review");
    for (const s of ["unknown", "claimed", "sending"]) expect(obligationTargetDisposition(s)).toBe("check");
  });
  it("message: failed without provider_unknown replaces; transport-only unknown checks", () => {
    expect(messageTargetDisposition("failed", undefined)).toBe("replace");
    expect(messageTargetDisposition("failed", "provider_unknown")).toBe("check");
    expect(messageTargetDisposition("pending", undefined)).toBe("check");
    expect(messageTargetDisposition("sent", undefined)).toBe("resolved");
  });
});

describe("readRepSmsContext with a target", () => {
  it("loads THAT obligation (scoped to this lead and org) and lets a resumable one replace the lead's current obligation", async () => {
    const f = fakeClient({
      defaultObligation: { id: "other", attemptId: "a0", status: "delivery_failed" },
      obligationRow: { id: ID, attempt_id: "a1", state: "required", message_body: "hi", composition: { remainder: "x" }, blocked_reason: null, sender_assignment_id: "sender-1", from_number: "+18163706846", to_number: "+18165550123" },
    });
    createClient.mockResolvedValue(f.client);
    const ctx = await readRepSmsContext("prop-1", { sourceKind: "obligation", refId: ID });
    expect(ctx.target).toEqual(expect.objectContaining({ sourceKind: "obligation", refId: ID, disposition: "resume" }));
    expect(ctx.obligation?.id).toBe(ID);
    const read = f.calls.find((c) => c.table === "rep_sms_obligations");
    expect(read?.filters).toEqual([["id", ID], ["property_id", "prop-1"], ["org_id", "org-1"]]);
  });

  it("a delivery_failed obligation target is a replacement and leaves the lead's context obligation alone", async () => {
    const f = fakeClient({ obligationRow: { id: ID, attempt_id: "a1", state: "delivery_failed", message_body: "hi", composition: {}, provider_error: "rejected" } });
    createClient.mockResolvedValue(f.client);
    const ctx = await readRepSmsContext("prop-1", { sourceKind: "obligation", refId: ID });
    expect(ctx.target?.disposition).toBe("replace");
    expect(ctx.target?.reason).toBe("rejected");
    expect(ctx.obligation).toBeNull();
  });

  it("reads a ledger receipt through the read function with the chosen id and carries its original key", async () => {
    const f = fakeClient({ ledger: { key: "11111111-1111-4111-8111-111111111111", state: "delivery_failed", assignmentId: "sender-1", from: "+18163706846", to: "+18165550123", body: "b", composition: { remainder: "r" }, providerError: "carrier" } });
    createClient.mockResolvedValue(f.client);
    const ctx = await readRepSmsContext("prop-1", { sourceKind: "ledger", refId: ID });
    expect(f.rpc).toHaveBeenCalledWith("fn_get_rep_sms_delivery_target", { p_property_id: "prop-1", p_ledger_id: ID });
    expect(ctx.target).toEqual(expect.objectContaining({ disposition: "replace", submissionKey: "11111111-1111-4111-8111-111111111111", reason: "carrier" }));
  });

  it("a ledger miss falls through to the same id in messages (text_status_unknown is ambiguous) and a provider_unknown failure is a check", async () => {
    const f = fakeClient({ ledger: null, messageRow: { id: ID, body: "b", status: "failed", metadata: { providerOutcome: "provider_unknown" } } });
    createClient.mockResolvedValue(f.client);
    const ctx = await readRepSmsContext("prop-1", { sourceKind: "ledger", refId: ID });
    expect(ctx.target).toEqual(expect.objectContaining({ sourceKind: "message", disposition: "check" }));
    const read = f.calls.find((c) => c.table === "messages");
    expect(read?.filters).toEqual(expect.arrayContaining([["id", ID], ["org_id", "org-1"], ["channel", "sms"]]));
  });

  it("a failed message without provider_unknown prefills its own composition from repSms metadata", async () => {
    const f = fakeClient({ messageRow: { id: ID, body: "b", status: "failed", metadata: { repSms: { acquisitionsManager: "Maria", introId: "mel-maria-assistant-1", introVersion: 2, finalRemainder: "Body A", senderAssignmentId: "sender-1", from: "+18163706846", finalBody: "full A" } } } });
    createClient.mockResolvedValue(f.client);
    const ctx = await readRepSmsContext("prop-1", { sourceKind: "message", refId: ID });
    expect(ctx.target).toEqual(expect.objectContaining({ disposition: "replace", body: "full A", assignmentId: "sender-1" }));
    expect(ctx.target?.composition).toEqual(expect.objectContaining({ remainder: "Body A" }));
  });

  it("a foreign or malformed id comes back unavailable", async () => {
    const f = fakeClient({});
    createClient.mockResolvedValue(f.client);
    expect((await readRepSmsContext("prop-1", { sourceKind: "obligation", refId: ID })).target?.disposition).toBe("unavailable");
    expect((await readRepSmsContext("prop-1", { sourceKind: "obligation", refId: "not-a-uuid" })).target?.disposition).toBe("unavailable");
  });

  it("no target = today's context (no target key)", async () => {
    const f = fakeClient({});
    createClient.mockResolvedValue(f.client);
    expect((await readRepSmsContext("prop-1")).target).toBeUndefined();
  });
});
