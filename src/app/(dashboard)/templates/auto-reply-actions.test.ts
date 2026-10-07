import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  org: { id: "org-1" } as { id: string } | null,
  mappings: [] as Array<{ id: string; outcome: string; template_id: string; active: boolean; reply_intent: string | null }>,
  thresholds: [] as Array<{ outcome: string; automation_enabled: boolean }>,
  rpcError: null as { message: string } | null,
  rpcCalls: [] as Array<Record<string, unknown>>,
}));

vi.mock("next/cache", () => ({ revalidatePath: vi.fn() }));
vi.mock("@/lib/errors/report", () => ({ reportError: vi.fn() }));
vi.mock("@/lib/supabase/server", () => ({
  createClient: async () => ({
    from: (table: string) => {
      const chain: Record<string, unknown> = {};
      chain.select = () => chain;
      chain.eq = () => chain;
      chain.is = () => chain;
      chain.limit = () => chain;
      chain.maybeSingle = async () => ({ data: mocks.org, error: null });
      chain.then = (resolve: (v: unknown) => unknown) =>
        Promise.resolve({
          data: table === "auto_reply_templates" ? mocks.mappings : table === "jev_outcome_thresholds" ? mocks.thresholds : null,
          error: null,
        }).then(resolve);
      return chain;
    },
    rpc: async (name: string, args: Record<string, unknown>) => {
      mocks.rpcCalls.push({ name, ...args });
      return { data: { ok: true }, error: mocks.rpcError };
    },
  }),
}));

import { listAutoReplySettings, setAutoReplyMapping, setTemplateAutoSendApproval } from "./auto-reply-actions";

beforeEach(() => {
  mocks.org = { id: "org-1" };
  mocks.mappings = [];
  mocks.thresholds = [];
  mocks.rpcError = null;
  mocks.rpcCalls = [];
});

describe("setTemplateAutoSendApproval", () => {
  it("approves with the exact text the owner saw", async () => {
    const r = await setTemplateAutoSendApproval({ templateId: "t1", approved: true, expectedContent: "Hello" });
    expect(r).toEqual({ ok: true, data: { approved: true } });
    expect(mocks.rpcCalls).toEqual([
      { name: "fn_set_template_auto_send_approval", p_template_id: "t1", p_approved: true, p_expected_content: "Hello" },
    ]);
  });

  it("refuses to approve without the text, before calling the database", async () => {
    for (const expectedContent of [null, ""]) {
      const r = await setTemplateAutoSendApproval({ templateId: "t1", approved: true, expectedContent });
      expect(r.ok).toBe(false);
    }
    expect(mocks.rpcCalls).toHaveLength(0);
  });

  it("revokes without sending text", async () => {
    await setTemplateAutoSendApproval({ templateId: "t1", approved: false, expectedContent: "ignored" });
    expect(mocks.rpcCalls[0]).toMatchObject({ p_approved: false, p_expected_content: null });
  });

  it("turns database refusals into plain messages", async () => {
    mocks.rpcError = { message: "FORBIDDEN" };
    const forbidden = await setTemplateAutoSendApproval({ templateId: "t1", approved: true, expectedContent: "x" });
    expect(forbidden).toMatchObject({ ok: false, error: { message: "Only an org owner can do this." } });
    mocks.rpcError = { message: "CONTENT_CHANGED" };
    const changed = await setTemplateAutoSendApproval({ templateId: "t1", approved: true, expectedContent: "x" });
    expect(changed).toMatchObject({ ok: false });
    expect(!changed.ok && changed.error.message).toMatch(/text changed/);
  });
});

describe("listAutoReplySettings", () => {
  it("returns any-intent mappings and each label's switch", async () => {
    mocks.mappings = [
      { id: "m1", outcome: "nurture", template_id: "t1", active: true, reply_intent: null },
      { id: "m2", outcome: "opted_out", template_id: "t2", active: true, reply_intent: null },
    ];
    mocks.thresholds = [
      { outcome: "nurture", automation_enabled: true },
      { outcome: "new_lead", automation_enabled: false },
      { outcome: "dnc", automation_enabled: true },
    ];
    const r = await listAutoReplySettings();
    expect(r).toEqual({
      ok: true,
      data: {
        orgId: "org-1",
        mappings: [{ id: "m1", outcome: "nurture", templateId: "t1", active: true }],
        labelAutomation: { nurture: true, new_lead: false },
      },
    });
  });
});

describe("setAutoReplyMapping", () => {
  it("creates a mapping when none exists", async () => {
    const r = await setAutoReplyMapping({ outcome: "nurture", templateId: "t1", active: true });
    expect(r.ok).toBe(true);
    expect(mocks.rpcCalls).toEqual([
      expect.objectContaining({
        name: "fn_set_auto_reply_template",
        p_org_id: "org-1",
        p_outcome: "nurture",
        p_reply_intent: null,
        p_template_id: "t1",
        p_active: true,
        p_mapping_id: null,
      }),
    ]);
  });

  it("updates the existing any-intent mapping and removes strays", async () => {
    mocks.mappings = [
      { id: "m1", outcome: "nurture", template_id: "t0", active: true, reply_intent: null },
      { id: "m2", outcome: "nurture", template_id: "t9", active: true, reply_intent: null },
    ];
    await setAutoReplyMapping({ outcome: "nurture", templateId: "t1", active: false });
    expect(mocks.rpcCalls[0]).toMatchObject({ p_mapping_id: "m1", p_template_id: "t1", p_active: false });
    expect(mocks.rpcCalls[1]).toMatchObject({ p_mapping_id: "m2", p_delete: true });
  });

  it("removes the mapping when no template is chosen", async () => {
    mocks.mappings = [{ id: "m1", outcome: "nurture", template_id: "t0", active: true, reply_intent: null }];
    await setAutoReplyMapping({ outcome: "nurture", templateId: null, active: true });
    expect(mocks.rpcCalls).toEqual([
      expect.objectContaining({ p_mapping_id: "m1", p_delete: true, p_template_id: null }),
    ]);
  });

  it("rejects outcomes that must never be answered automatically", async () => {
    for (const outcome of ["opted_out", "dnc", "wrong_number", "unclear"]) {
      const r = await setAutoReplyMapping({ outcome, templateId: "t1", active: true });
      expect(r.ok).toBe(false);
    }
    expect(mocks.rpcCalls).toHaveLength(0);
  });

  it("surfaces a database refusal", async () => {
    mocks.rpcError = { message: "FORBIDDEN" };
    const r = await setAutoReplyMapping({ outcome: "nurture", templateId: "t1", active: true });
    expect(r).toMatchObject({ ok: false, error: { message: "Only an org owner can do this." } });
  });
});
