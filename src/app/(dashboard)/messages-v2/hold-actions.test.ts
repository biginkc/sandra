import { describe, expect, it, vi } from "vitest";

import {
  assignHold,
  dismissHold,
  editAndSendHeldDraft,
  sendHeldDraft,
  takeOverHold,
  type HoldActionDeps,
} from "./hold-actions";

type Call = { method: string; args: unknown[] };
type Reply = { data?: unknown; error?: { message: string; code?: string } | null; count?: number | null };
type Log = { table: string; calls: Call[] };

/** Table-level fake: every chain is recorded, `reply` decides what it resolves to. */
function fakeAdmin(reply: (table: string, calls: Call[]) => Reply | undefined) {
  const log: Log[] = [];
  const settle = (table: string, calls: Call[]) => {
    const r = reply(table, calls) ?? {};
    return { data: r.data ?? null, error: r.error ?? null, count: r.count ?? null };
  };
  const chain = (table: string): unknown => {
    const entry: Log = { table, calls: [] };
    log.push(entry);
    const proxy: unknown = new Proxy(
      {},
      {
        get(_t, prop: string) {
          if (prop === "then") {
            return (resolve: (v: unknown) => unknown, reject?: (e: unknown) => unknown) =>
              Promise.resolve(settle(table, entry.calls)).then(resolve, reject);
          }
          return (...args: unknown[]) => {
            entry.calls.push({ method: prop, args });
            return proxy;
          };
        },
      },
    );
    return proxy;
  };
  const admin = {
    from: (table: string) => chain(table),
    rpc: (name: string, args: unknown) => {
      const entry: Log = { table: `rpc:${name}`, calls: [{ method: "rpc", args: [args] }] };
      log.push(entry);
      return Promise.resolve(settle(entry.table, entry.calls));
    },
  };
  return { admin: admin as never, log };
}

const has = (calls: Call[], method: string, ...args: unknown[]) =>
  calls.some((c) => c.method === method && args.every((a, i) => JSON.stringify(c.args[i]) === JSON.stringify(a)));
const logFor = (log: Log[], table: string, method?: string) =>
  log.filter((l) => l.table === table && (!method || l.calls.some((c) => c.method === method)));

const DRAFT = {
  id: "draft-1",
  org_id: "org-1",
  run_id: "run-1",
  property_id: "prop-1",
  conversation_id: "conv-1",
  inbound_message_id: "msg-1",
  body: "Original draft text",
  edited_body: null,
  status: "pending",
};
const INBOUND = { id: "msg-1", contact_id: "contact-1", conversation_id: "conv-1", from_address: "+18165550001" };

function baseReply(over: Partial<Record<string, Reply>> = {}) {
  return (table: string, calls: Call[]): Reply | undefined => {
    if (over[table]) return over[table];
    if (table === "ai_reply_drafts") {
      if (calls.some((c) => c.method === "update")) return { data: [{ id: "draft-1" }] };
      return { data: DRAFT };
    }
    if (table === "messages") return { data: INBOUND };
    if (table === "properties") {
      if (calls.some((c) => c.method === "update")) return { data: [{ id: "prop-1" }] };
      return { data: { id: "prop-1", org_id: "org-1" } };
    }
    if (table === "pipeline_runs") return { data: { id: "run-1" } };
    if (table === "rpc:fn_resolve_hold") {
      return { data: { decisionsSuperseded: 0, reviewsSuperseded: 0, draftsDiscarded: 1, propertyUpdated: true, wasFlagged: true } };
    }
    return undefined;
  };
}

function deps(over: Partial<HoldActionDeps> = {}, reply = baseReply()) {
  const { admin, log } = fakeAdmin(reply);
  const d: HoldActionDeps = {
    admin,
    orgId: "org-1",
    userId: "user-1",
    sendHumanDraft: vi.fn().mockResolvedValue({ status: "sent", messageId: "out-1" }),
    recordLeadEvent: vi.fn().mockResolvedValue(undefined),
    resumeRun: vi.fn().mockResolvedValue({ runId: "run-1", orgId: "org-1", seq: 3 }),
    recordStep: vi.fn().mockResolvedValue(undefined),
    updateLeadAssignee: vi.fn().mockResolvedValue({ ok: true, data: null }),
    reportError: vi.fn(),
    ...over,
  };
  return { d, log };
}

describe("sendHeldDraft", () => {
  it("sends the draft as-is through the human send path, then marks it sent and audits it", async () => {
    const { d, log } = deps();
    const result = await sendHeldDraft(d, { draftId: "draft-1" });
    expect(result).toMatchObject({ ok: true });
    expect(d.sendHumanDraft).toHaveBeenCalledWith(
      d.admin,
      expect.objectContaining({
        orgId: "org-1",
        propertyId: "prop-1",
        contactId: "contact-1",
        conversationId: "conv-1",
        inboundMessageId: "msg-1",
        inboundFromPhone: "+18165550001",
        body: "Original draft text",
        userId: "user-1",
        edited: false,
      }),
    );
    const draftUpdate = logFor(log, "ai_reply_drafts", "update").at(-1)!;
    const patch = draftUpdate.calls.find((c) => c.method === "update")!.args[0] as Record<string, unknown>;
    expect(patch).toMatchObject({ status: "sent", resolved_by: "user-1", resolution_reason: "sent", sent_message_id: "out-1" });
    expect(has(draftUpdate.calls, "eq", "status", "pending")).toBe(true);
    expect(d.recordLeadEvent).toHaveBeenCalledWith(
      expect.objectContaining({
        propertyId: "prop-1",
        actorType: "user",
        actorId: "user-1",
        eventType: "hold_reply_sent",
        payload: expect.objectContaining({ draft_id: "draft-1", edited: false, message_id: "out-1" }),
      }),
    );
    expect(d.recordStep).toHaveBeenCalledWith(
      d.admin,
      expect.anything(),
      expect.objectContaining({ kind: "reply", name: "human_send", result: "sent" }),
    );
  });

  it("clears the draft_held flag after a successful send, and only that flag", async () => {
    const { d, log } = deps();
    await sendHeldDraft(d, { draftId: "draft-1" });
    const flagUpdate = logFor(log, "properties", "update").at(-1)!;
    expect(flagUpdate.calls.find((c) => c.method === "update")!.args[0]).toMatchObject({ needs_human_attention: false });
    expect(has(flagUpdate.calls, "eq", "last_ai_escalation_reason", "draft_held")).toBe(true);
  });

  it("never puts message text in the audit trail", async () => {
    const { d } = deps();
    await sendHeldDraft(d, { draftId: "draft-1" });
    const audited = JSON.stringify([
      vi.mocked(d.recordLeadEvent).mock.calls,
      vi.mocked(d.recordStep).mock.calls.map((c) => c[2]),
    ]);
    expect(audited).not.toContain("Original draft text");
  });

  it("answers NOT_FOUND for a missing draft and for another org's draft", async () => {
    const missing = deps({}, baseReply({ ai_reply_drafts: { data: null } }));
    expect(await sendHeldDraft(missing.d, { draftId: "x" })).toMatchObject({ ok: false, error: { code: "DRAFT_NOT_FOUND" } });
    const other = deps({}, baseReply({ ai_reply_drafts: { data: { ...DRAFT, org_id: "org-2" } } }));
    expect(await sendHeldDraft(other.d, { draftId: "draft-1" })).toMatchObject({ ok: false, error: { code: "DRAFT_NOT_FOUND" } });
    expect(other.d.sendHumanDraft).not.toHaveBeenCalled();
  });

  it("refuses a draft that is no longer pending", async () => {
    const { d } = deps({}, baseReply({ ai_reply_drafts: { data: { ...DRAFT, status: "discarded" } } }));
    expect(await sendHeldDraft(d, { draftId: "draft-1" })).toMatchObject({ ok: false, error: { code: "DRAFT_NOT_PENDING" } });
    expect(d.sendHumanDraft).not.toHaveBeenCalled();
  });

  it("surfaces a refusal with its reason, leaves the draft pending, and records a blocking step", async () => {
    const { d, log } = deps({
      sendHumanDraft: vi.fn().mockResolvedValue({ status: "refused", reason: "superseded_before_send", retryable: false, flagged: true }),
    });
    const result = await sendHeldDraft(d, { draftId: "draft-1" });
    expect(result).toMatchObject({
      ok: false,
      error: { code: "SEND_REFUSED", details: { reason: "superseded_before_send", retryable: false } },
    });
    expect(logFor(log, "ai_reply_drafts", "update")).toHaveLength(0);
    expect(d.recordStep).toHaveBeenCalledWith(
      d.admin,
      expect.anything(),
      expect.objectContaining({ kind: "gate", name: "human_send_refused", result: "block", detail: expect.objectContaining({ reason: "superseded_before_send" }) }),
    );
  });

  it("still reports success when the text went out but the draft row could not be updated", async () => {
    const reply = baseReply();
    const { d } = deps({}, (table, calls) =>
      table === "ai_reply_drafts" && calls.some((c) => c.method === "update") ? { error: { message: "db down" } } : reply(table, calls),
    );
    const result = await sendHeldDraft(d, { draftId: "draft-1" });
    expect(result).toMatchObject({ ok: true });
    expect(d.reportError).toHaveBeenCalled();
  });

  it("refuses a draft with no inbound message to answer", async () => {
    const { d } = deps({}, baseReply({ ai_reply_drafts: { data: { ...DRAFT, inbound_message_id: null } } }));
    expect(await sendHeldDraft(d, { draftId: "draft-1" })).toMatchObject({ ok: false, error: { code: "DRAFT_NOT_SENDABLE" } });
    expect(d.sendHumanDraft).not.toHaveBeenCalled();
  });
});

describe("editAndSendHeldDraft", () => {
  it("records the edit on the draft row (edited_body, edited_by) and sends the edited text", async () => {
    const { d, log } = deps();
    const result = await editAndSendHeldDraft(d, { draftId: "draft-1", body: "  A better draft  " });
    expect(result).toMatchObject({ ok: true });
    const edit = logFor(log, "ai_reply_drafts", "update")[0]!;
    expect(edit.calls.find((c) => c.method === "update")!.args[0]).toMatchObject({
      edited_body: "A better draft",
      edited_by: "user-1",
    });
    expect(has(edit.calls, "eq", "status", "pending")).toBe(true);
    expect(d.sendHumanDraft).toHaveBeenCalledWith(d.admin, expect.objectContaining({ body: "A better draft", edited: true }));
    expect(d.recordLeadEvent).toHaveBeenCalledWith(
      expect.objectContaining({ payload: expect.objectContaining({ edited: true }), eventType: "hold_reply_sent" }),
    );
  });

  it("rejects an empty or oversized edit before touching anything", async () => {
    const { d, log } = deps();
    expect(await editAndSendHeldDraft(d, { draftId: "draft-1", body: "   " })).toMatchObject({ ok: false, error: { code: "INVALID_BODY" } });
    expect(await editAndSendHeldDraft(d, { draftId: "draft-1", body: "x".repeat(1601) })).toMatchObject({ ok: false, error: { code: "INVALID_BODY" } });
    expect(d.sendHumanDraft).not.toHaveBeenCalled();
    expect(log).toHaveLength(0);
  });

  it("does not send when the draft stopped being pending between the page load and the click", async () => {
    const reply = baseReply();
    const { d } = deps({}, (table, calls) =>
      table === "ai_reply_drafts" && calls.some((c) => c.method === "update") ? { data: [] } : reply(table, calls),
    );
    expect(await editAndSendHeldDraft(d, { draftId: "draft-1", body: "new text" })).toMatchObject({
      ok: false,
      error: { code: "DRAFT_NOT_PENDING" },
    });
    expect(d.sendHumanDraft).not.toHaveBeenCalled();
  });
});

describe("takeOverHold", () => {
  it("hands the property to a human atomically and returns the lead link", async () => {
    const { d, log } = deps();
    const result = await takeOverHold(d, { propertyId: "prop-1" });
    expect(result).toEqual({ ok: true, data: { leadHref: "/leads/prop-1" } });
    expect(logFor(log, "rpc:fn_resolve_hold")[0]!.calls[0]!.args[0]).toEqual({
      p_org_id: "org-1",
      p_property_id: "prop-1",
      p_user_id: "user-1",
      p_action: "take_over",
      p_reason: null,
    });
    const events = vi.mocked(d.recordLeadEvent).mock.calls.map((c) => c[0].eventType);
    expect(events).toEqual(expect.arrayContaining(["ai_escalation_cleared", "ai_responder_toggled"]));
    expect(vi.mocked(d.recordLeadEvent).mock.calls.every((c) => c[0].actorType === "user" && c[0].actorId === "user-1")).toBe(true);
    expect(d.recordStep).toHaveBeenCalledWith(d.admin, expect.anything(), expect.objectContaining({ name: "take_over" }));
  });

  it("surfaces the database refusal (forbidden / not found) without recording success", async () => {
    const { d } = deps({}, baseReply({ "rpc:fn_resolve_hold": { error: { message: "FORBIDDEN" } } }));
    expect(await takeOverHold(d, { propertyId: "prop-1" })).toMatchObject({ ok: false, error: { code: "HOLD_RESOLVE_FAILED" } });
    expect(d.recordLeadEvent).not.toHaveBeenCalled();
  });
});

describe("dismissHold", () => {
  it("requires a reason", async () => {
    const { d, log } = deps();
    expect(await dismissHold(d, { propertyId: "prop-1", reason: "   " })).toMatchObject({ ok: false, error: { code: "REASON_REQUIRED" } });
    expect(log).toHaveLength(0);
  });

  it("dismisses with the reason and audits it (reason is the human's note, never message text)", async () => {
    const { d, log } = deps();
    const result = await dismissHold(d, { propertyId: "prop-1", reason: "  called her back  " });
    expect(result).toMatchObject({ ok: true });
    expect(logFor(log, "rpc:fn_resolve_hold")[0]!.calls[0]!.args[0]).toMatchObject({ p_action: "dismiss", p_reason: "called her back" });
    expect(d.recordLeadEvent).toHaveBeenCalledWith(
      expect.objectContaining({
        eventType: "ai_escalation_cleared",
        actorType: "user",
        payload: expect.objectContaining({ via: "messages_v2", action: "dismiss", reason: "called her back" }),
      }),
    );
    expect(d.recordStep).toHaveBeenCalledWith(d.admin, expect.anything(), expect.objectContaining({ name: "dismiss" }));
  });
});

describe("assignHold", () => {
  it("reuses the lead assignment action and records who it went to (ids only)", async () => {
    const { d } = deps();
    expect(await assignHold(d, { propertyId: "prop-1", assigneeId: "user-9" })).toMatchObject({ ok: true });
    expect(d.updateLeadAssignee).toHaveBeenCalledWith("prop-1", "user-9");
    expect(d.recordStep).toHaveBeenCalledWith(
      d.admin,
      expect.anything(),
      expect.objectContaining({ name: "assign", detail: expect.objectContaining({ assigneeId: "user-9" }) }),
    );
  });

  it("passes the assignment failure through unchanged", async () => {
    const { d } = deps({ updateLeadAssignee: vi.fn().mockResolvedValue({ ok: false, error: { code: "INVALID_ASSIGNEE", message: "no" } }) });
    expect(await assignHold(d, { propertyId: "prop-1", assigneeId: "user-9" })).toEqual({
      ok: false,
      error: { code: "INVALID_ASSIGNEE", message: "no" },
    });
    expect(d.recordStep).not.toHaveBeenCalled();
  });

  it("will not assign a property outside the caller's org", async () => {
    const { d } = deps({}, baseReply({ properties: { data: { id: "prop-1", org_id: "org-2" } } }));
    expect(await assignHold(d, { propertyId: "prop-1", assigneeId: "user-9" })).toMatchObject({ ok: false, error: { code: "PROPERTY_NOT_FOUND" } });
    expect(d.updateLeadAssignee).not.toHaveBeenCalled();
  });
});
