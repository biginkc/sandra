import { beforeEach, describe, expect, it, vi } from "vitest";

import type { ThresholdMap } from "@/lib/sms-classification/thresholds";

import {
  isTemplateSendable,
  resolveApprovedTemplateReply,
  selectAutoReplyTemplate,
  type TemplateCandidate,
  type TemplateRow,
} from "./template-reply";

const { loadTemplateVars, reportError } = vi.hoisted(() => ({
  loadTemplateVars: vi.fn(),
  reportError: vi.fn(),
}));
vi.mock("@/lib/sequences/template-vars", () => ({ loadTemplateVars }));
vi.mock("@/lib/errors/report", () => ({ reportError }));

const TEXT = "Hi {{first_name | there}}, this is {{my_first_name}}. Thanks for letting us know.";

const approved = (over: Partial<TemplateRow> = {}): TemplateRow => ({
  content: TEXT,
  approved_for_auto_send: true,
  approved_content: TEXT,
  deleted_at: null,
  ...over,
});

const cand = (over: Partial<TemplateCandidate> = {}): TemplateCandidate => ({
  mappingId: "m1",
  templateId: "t1",
  replyIntent: null,
  priority: 100,
  template: approved(),
  ...over,
});

const ON: ThresholdMap = {
  nurture: { minConfidence: 0.95, version: 2, automationEnabled: true },
  not_interested: { minConfidence: 0.9, version: 1, automationEnabled: true },
  new_lead: { minConfidence: 0.9, version: 1, automationEnabled: true },
};

function fakeSupabase(result: { data: unknown; error: { message: string } | null }) {
  const calls: Array<[string, unknown]> = [];
  const builder: Record<string, unknown> = {};
  builder.select = vi.fn(() => builder);
  builder.eq = vi.fn((col: string, val: unknown) => {
    calls.push([col, val]);
    return builder;
  });
  builder.then = (resolve: (v: unknown) => unknown) => Promise.resolve(result).then(resolve);
  const from = vi.fn(() => builder);
  return { client: { from } as never, calls, from };
}

beforeEach(() => {
  loadTemplateVars.mockReset();
  reportError.mockReset();
  loadTemplateVars.mockResolvedValue({
    first_name: "Dana",
    my_first_name: "Mel",
    company_name: "BMH",
  });
});

describe("isTemplateSendable", () => {
  it("requires approval, unchanged text, and not deleted", () => {
    expect(isTemplateSendable(approved())).toBe(true);
    expect(isTemplateSendable(null)).toBe(false);
    expect(isTemplateSendable(approved({ approved_for_auto_send: false }))).toBe(false);
    expect(isTemplateSendable(approved({ approved_content: null }))).toBe(false);
    expect(isTemplateSendable(approved({ content: `${TEXT} edited` }))).toBe(false);
    expect(isTemplateSendable(approved({ deleted_at: "2026-10-01T00:00:00Z" }))).toBe(false);
    expect(isTemplateSendable(approved({ content: "  ", approved_content: "  " }))).toBe(false);
  });
});

describe("selectAutoReplyTemplate", () => {
  it("misses when nothing is mapped", () => {
    expect(selectAutoReplyTemplate([], "positive")).toEqual({ kind: "none", reason: "no_mapping" });
  });

  it("an any-intent mapping answers every intent, including none", () => {
    expect(selectAutoReplyTemplate([cand()], null)).toMatchObject({ kind: "selected" });
    expect(selectAutoReplyTemplate([cand()], "negative")).toMatchObject({ kind: "selected" });
  });

  it("an intent-specific mapping only matches that intent, and beats any-intent", () => {
    const specific = cand({ mappingId: "m2", templateId: "t2", replyIntent: "negative", priority: 500 });
    const any = cand({ mappingId: "m1", priority: 1 });
    expect(selectAutoReplyTemplate([any, specific], "negative")).toMatchObject({
      kind: "selected",
      candidate: { mappingId: "m2" },
    });
    expect(selectAutoReplyTemplate([any, specific], "positive")).toMatchObject({
      candidate: { mappingId: "m1" },
    });
    expect(selectAutoReplyTemplate([specific], null)).toEqual({ kind: "none", reason: "no_mapping" });
    expect(selectAutoReplyTemplate([specific], "positive")).toEqual({ kind: "none", reason: "no_mapping" });
  });

  it("lower priority number wins, ties break by id", () => {
    const a = cand({ mappingId: "a", priority: 20 });
    const b = cand({ mappingId: "b", priority: 10 });
    expect(selectAutoReplyTemplate([a, b], null)).toMatchObject({ candidate: { mappingId: "b" } });
    const c = cand({ mappingId: "c", priority: 10 });
    expect(selectAutoReplyTemplate([c, b], null)).toMatchObject({ candidate: { mappingId: "b" } });
  });

  it("skips an unapproved template and uses the next sendable one, else reports unavailable", () => {
    const unapproved = cand({ mappingId: "a", priority: 1, template: approved({ approved_for_auto_send: false }) });
    const fallback = cand({ mappingId: "b", priority: 2 });
    expect(selectAutoReplyTemplate([unapproved, fallback], null)).toMatchObject({ candidate: { mappingId: "b" } });
    expect(selectAutoReplyTemplate([unapproved], null)).toEqual({ kind: "none", reason: "template_unavailable" });
    expect(selectAutoReplyTemplate([cand({ template: null })], null)).toEqual({
      kind: "none",
      reason: "template_unavailable",
    });
  });
});

describe("resolveApprovedTemplateReply", () => {
  const base = {
    orgId: "org1",
    propertyId: "p1",
    contactId: "c1",
    outcome: "nurture" as const,
    outcomeConfidence: 0.97,
    thresholds: ON,
  };
  const row = (over: Record<string, unknown> = {}) => ({
    id: "m1",
    template_id: "t1",
    reply_intent: null,
    priority: 100,
    sms_templates: approved(),
    ...over,
  });

  it("mapping hit: renders the approved text with the Mel persona", async () => {
    const { client, calls, from } = fakeSupabase({ data: [row()], error: null });
    const out = await resolveApprovedTemplateReply(client, base);
    expect(out).toEqual({
      kind: "template",
      templateId: "t1",
      mappingId: "m1",
      body: "Hi Dana, this is Mel. Thanks for letting us know.",
      outcome: "nurture",
    });
    expect(from).toHaveBeenCalledWith("auto_reply_templates");
    expect(calls).toEqual(
      expect.arrayContaining([
        ["org_id", "org1"],
        ["outcome", "nurture"],
        ["active", true],
      ]),
    );
  });

  it("uses the template fallback when the contact has no first name", async () => {
    loadTemplateVars.mockResolvedValue({ first_name: null, my_first_name: "Mel" });
    const { client } = fakeSupabase({ data: [row()], error: null });
    const out = await resolveApprovedTemplateReply(client, base);
    expect(out).toMatchObject({ kind: "template", body: "Hi there, this is Mel. Thanks for letting us know." });
  });

  it("mapping miss falls through", async () => {
    const { client } = fakeSupabase({ data: [], error: null });
    expect(await resolveApprovedTemplateReply(client, base)).toEqual({ kind: "none", reason: "no_mapping" });
  });

  it("an intent-specific mapping is only used for that intent", async () => {
    const { client } = fakeSupabase({ data: [row({ reply_intent: "negative" })], error: null });
    expect(await resolveApprovedTemplateReply(client, { ...base, replyIntent: "positive" })).toEqual({
      kind: "none",
      reason: "no_mapping",
    });
    expect(await resolveApprovedTemplateReply(client, { ...base, replyIntent: "negative" })).toMatchObject({
      kind: "template",
    });
  });

  it("a label that is switched off never sends, even at confidence 1.0", async () => {
    const { client, from } = fakeSupabase({ data: [row()], error: null });
    const out = await resolveApprovedTemplateReply(client, {
      ...base,
      outcome: "not_interested",
      outcomeConfidence: 1,
      thresholds: { ...ON, not_interested: { minConfidence: 0.9, version: 1, automationEnabled: false } },
    });
    expect(out).toEqual({ kind: "none", reason: "automation_disabled" });
    expect(from).not.toHaveBeenCalled();
  });

  it("below the label's cutoff falls through, exactly at the cutoff sends", async () => {
    const { client } = fakeSupabase({ data: [row()], error: null });
    expect(await resolveApprovedTemplateReply(client, { ...base, outcomeConfidence: 0.949 })).toEqual({
      kind: "none",
      reason: "below_threshold",
    });
    expect(await resolveApprovedTemplateReply(client, { ...base, outcomeConfidence: 0.95 })).toMatchObject({
      kind: "template",
    });
  });

  it("missing or invalid confidence, or no threshold row, falls through", async () => {
    const { client } = fakeSupabase({ data: [row()], error: null });
    for (const c of [null, Number.NaN, 1.2, -0.1]) {
      expect(await resolveApprovedTemplateReply(client, { ...base, outcomeConfidence: c })).toMatchObject({
        kind: "none",
        reason: "threshold_unavailable",
      });
    }
    expect(await resolveApprovedTemplateReply(client, { ...base, thresholds: {} })).toEqual({
      kind: "none",
      reason: "threshold_unavailable",
    });
  });

  it("outcomes that must never be answered automatically fall through before any lookup", async () => {
    const { client, from } = fakeSupabase({ data: [row()], error: null });
    for (const outcome of ["new_lead", "opted_out", "dnc", "wrong_number", "unclear", "bad_number"] as const) {
      expect(await resolveApprovedTemplateReply(client, { ...base, outcome })).toEqual({
        kind: "none",
        reason: "outcome_not_templatable",
      });
    }
    expect(from).not.toHaveBeenCalled();
  });

  it("an unapproved, edited, or deleted template falls through", async () => {
    for (const tpl of [
      approved({ approved_for_auto_send: false }),
      approved({ content: `${TEXT}!` }),
      approved({ deleted_at: "2026-10-02T00:00:00Z" }),
      null,
    ]) {
      const { client } = fakeSupabase({ data: [row({ sms_templates: tpl })], error: null });
      expect(await resolveApprovedTemplateReply(client, base)).toEqual({
        kind: "none",
        reason: "template_unavailable",
      });
    }
  });

  it("an inactive mapping is excluded by the query itself", async () => {
    const { client, calls } = fakeSupabase({ data: [], error: null });
    await resolveApprovedTemplateReply(client, base);
    expect(calls).toContainEqual(["active", true]);
  });

  it("a lookup failure falls through and is reported", async () => {
    const { client } = fakeSupabase({ data: null, error: { message: "boom" } });
    expect(await resolveApprovedTemplateReply(client, base)).toEqual({ kind: "none", reason: "lookup_failed" });
    expect(reportError).toHaveBeenCalled();
  });

  it("an unrenderable template (missing variable, no fallback) falls through", async () => {
    loadTemplateVars.mockResolvedValue({ first_name: "Dana", my_first_name: null });
    const { client } = fakeSupabase({ data: [row()], error: null });
    expect(await resolveApprovedTemplateReply(client, base)).toEqual({ kind: "none", reason: "render_failed" });
    loadTemplateVars.mockRejectedValue(new Error("vars"));
    expect(await resolveApprovedTemplateReply(client, base)).toEqual({ kind: "none", reason: "render_failed" });
  });

  it("accepts the embedded template as a one-element array", async () => {
    const { client } = fakeSupabase({ data: [row({ sms_templates: [approved()] })], error: null });
    expect(await resolveApprovedTemplateReply(client, base)).toMatchObject({ kind: "template" });
  });
});
