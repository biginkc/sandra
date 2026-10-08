import { beforeEach, describe, expect, it, vi } from "vitest";

import type { ThresholdMap } from "@/lib/sms-classification/thresholds";

import { APPROVED_REPLY_TEXTS } from "./approved-reply-texts";
import {
  hasSendableNumberSourceTemplate,
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
  wrong_number: { minConfidence: 0.9, version: 1, automationEnabled: true },
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
    escalationReason: "not_applicable" as const,
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
      key: "nurture",
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

  it("any human follow-up reason (or a missing/unknown one) fails closed before any lookup", async () => {
    const { client, from } = fakeSupabase({ data: [row()], error: null });
    for (const outcome of ["nurture", "not_interested"] as const) {
      for (const escalationReason of [
        "price_or_offer",
        "distress",
        "call_request",
        "hot_lead",
        "multi_property",
        "third_party",
        "needs_review",
        "uncertain",
        null,
        "something_new" as never,
      ] as const) {
        expect(
          await resolveApprovedTemplateReply(client, { ...base, outcome, escalationReason }),
        ).toEqual({ kind: "none", reason: "human_follow_up" });
      }
    }
    expect(from).not.toHaveBeenCalled();
    expect(loadTemplateVars).not.toHaveBeenCalled();
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
    for (const outcome of ["new_lead", "opted_out", "dnc", "unclear", "bad_number"] as const) {
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

  describe("number_source mapping key", () => {
    it("reads the number_source mapping but runs every outcome check for the real outcome", async () => {
      const { client, calls } = fakeSupabase({ data: [row()], error: null });
      const out = await resolveApprovedTemplateReply(client, { ...base, mappingKey: "number_source" });
      expect(out).toMatchObject({ kind: "template", templateId: "t1", outcome: "nurture", key: "number_source" });
      expect(calls).toContainEqual(["outcome", "number_source"]);
      expect(calls).not.toContainEqual(["outcome", "nurture"]);
    });

    it("never sends for a human follow-up reason, a switched-off label, a low cutoff or a non-templatable outcome", async () => {
      const { client, from } = fakeSupabase({ data: [row()], error: null });
      const args = { ...base, mappingKey: "number_source" as const };
      expect(await resolveApprovedTemplateReply(client, { ...args, escalationReason: "price_or_offer" })).toEqual({
        kind: "none",
        reason: "human_follow_up",
      });
      expect(await resolveApprovedTemplateReply(client, { ...args, outcomeConfidence: 0.5 })).toEqual({
        kind: "none",
        reason: "below_threshold",
      });
      expect(
        await resolveApprovedTemplateReply(client, {
          ...args,
          thresholds: { ...ON, nurture: { minConfidence: 0.95, version: 2, automationEnabled: false } },
        }),
      ).toEqual({ kind: "none", reason: "automation_disabled" });
      for (const outcome of ["opted_out", "dnc", "wrong_number", "hostile", "new_lead", "unclear", "bad_number"] as const) {
        expect(await resolveApprovedTemplateReply(client, { ...args, outcome })).toEqual({
          kind: "none",
          reason: "outcome_not_templatable",
        });
      }
      expect(from).not.toHaveBeenCalled();
    });

    it("a blank property_address never renders: render_failed, nothing is sent", async () => {
      const text = "Fair question. Your number came up tied to {{property_address}} in public records.";
      loadTemplateVars.mockResolvedValue({ first_name: "Dana", my_first_name: "Mel", property_address: "  " });
      const { client } = fakeSupabase({
        data: [row({ sms_templates: approved({ content: text, approved_content: text }) })],
        error: null,
      });
      expect(await resolveApprovedTemplateReply(client, { ...base, mappingKey: "number_source" })).toEqual({
        kind: "none",
        reason: "render_failed",
      });
    });

    it("an unapproved or edited number_source template is inert", async () => {
      const { client } = fakeSupabase({
        data: [row({ sms_templates: approved({ approved_for_auto_send: false }) })],
        error: null,
      });
      expect(await resolveApprovedTemplateReply(client, { ...base, mappingKey: "number_source" })).toEqual({
        kind: "none",
        reason: "template_unavailable",
      });
    });
  });
});

describe("hasSendableNumberSourceTemplate", () => {
  const row = (tpl: TemplateRow | null) => ({
    id: "m1",
    template_id: "t1",
    reply_intent: null,
    priority: 100,
    sms_templates: tpl,
  });

  it("is true only for an active mapping to an approved, unedited template", async () => {
    const ok = fakeSupabase({ data: [row(approved())], error: null });
    expect(await hasSendableNumberSourceTemplate(ok.client, "org1")).toBe(true);
    expect(ok.calls).toEqual(
      expect.arrayContaining([
        ["org_id", "org1"],
        ["outcome", "number_source"],
        ["active", true],
      ]),
    );
    for (const data of [[], [row(null)], [row(approved({ approved_for_auto_send: false }))], [row(approved({ content: "changed" }))]]) {
      expect(await hasSendableNumberSourceTemplate(fakeSupabase({ data, error: null }).client, "org1")).toBe(false);
    }
  });

  it("fails closed on a lookup error", async () => {
    expect(await hasSendableNumberSourceTemplate(fakeSupabase({ data: null, error: { message: "boom" } }).client, "org1")).toBe(false);
  });
});

describe("wrong_number and hostile mapping keys", () => {
  const base = {
    orgId: "org1",
    propertyId: "p1",
    contactId: "c1",
    outcomeConfidence: 0.97,
    escalationReason: "not_applicable" as const,
    thresholds: ON,
  };
  const approvedRow = (text: string) => ({
    id: "m1",
    template_id: "t1",
    reply_intent: null,
    priority: 100,
    sms_templates: approved({ content: text, approved_content: text }),
  });

  it("wrong_number is mappable and keeps every Jev gate (follow-up answer, switch, cutoff)", async () => {
    const { client, calls } = fakeSupabase({ data: [approvedRow(APPROVED_REPLY_TEXTS.wrong_number)], error: null });
    expect(await resolveApprovedTemplateReply(client, { ...base, outcome: "wrong_number" })).toMatchObject({
      kind: "template",
      outcome: "wrong_number",
      body: APPROVED_REPLY_TEXTS.wrong_number,
    });
    expect(calls).toContainEqual(["outcome", "wrong_number"]);
    expect(
      await resolveApprovedTemplateReply(client, { ...base, outcome: "wrong_number", escalationReason: "third_party" }),
    ).toEqual({ kind: "none", reason: "human_follow_up" });
    expect(
      await resolveApprovedTemplateReply(client, { ...base, outcome: "wrong_number", outcomeConfidence: 0.5 }),
    ).toEqual({ kind: "none", reason: "below_threshold" });
    expect(
      await resolveApprovedTemplateReply(client, {
        ...base,
        outcome: "wrong_number",
        thresholds: { ...ON, wrong_number: { minConfidence: 0.9, version: 1, automationEnabled: false } },
      }),
    ).toEqual({ kind: "none", reason: "automation_disabled" });
  });

  it("hostile is keyed on 'hostile', needs no Jev confidence, follow-up answer or label switch", async () => {
    const { client, calls } = fakeSupabase({ data: [approvedRow(APPROVED_REPLY_TEXTS.hostile)], error: null });
    const out = await resolveApprovedTemplateReply(client, {
      ...base,
      outcome: "hostile",
      outcomeConfidence: null,
      escalationReason: null,
      thresholds: {},
    });
    expect(out).toEqual({
      kind: "template",
      templateId: "t1",
      mappingId: "m1",
      body: APPROVED_REPLY_TEXTS.hostile,
      outcome: "hostile",
      key: "hostile",
    });
    expect(calls).toContainEqual(["outcome", "hostile"]);
    expect(calls).toContainEqual(["active", true]);
  });

  it("hostile still needs an approved, unchanged, mapped template", async () => {
    const unapproved = { ...approvedRow(APPROVED_REPLY_TEXTS.hostile), sms_templates: approved({ content: APPROVED_REPLY_TEXTS.hostile, approved_content: null, approved_for_auto_send: false }) };
    const { client } = fakeSupabase({ data: [unapproved], error: null });
    expect(
      await resolveApprovedTemplateReply(client, { ...base, outcome: "hostile", outcomeConfidence: null, escalationReason: null }),
    ).toEqual({ kind: "none", reason: "template_unavailable" });
    const none = fakeSupabase({ data: [], error: null });
    expect(
      await resolveApprovedTemplateReply(none.client, { ...base, outcome: "hostile", outcomeConfidence: null, escalationReason: null }),
    ).toEqual({ kind: "none", reason: "no_mapping" });
  });

  it("new_lead, opted_out and dnc are still never answered", async () => {
    const { client, from } = fakeSupabase({ data: [], error: null });
    for (const outcome of ["new_lead", "opted_out", "dnc", "unclear"] as const) {
      expect(await resolveApprovedTemplateReply(client, { ...base, outcome })).toEqual({
        kind: "none",
        reason: "outcome_not_templatable",
      });
    }
    expect(from).not.toHaveBeenCalled();
  });

  it("every approved text renders to itself byte for byte (no variables, no mangling)", async () => {
    for (const [key, text] of Object.entries(APPROVED_REPLY_TEXTS)) {
      const { client } = fakeSupabase({ data: [approvedRow(text)], error: null });
      const outcome = key as "nurture" | "not_interested" | "wrong_number" | "hostile";
      const out = await resolveApprovedTemplateReply(client, {
        ...base,
        outcome,
        outcomeConfidence: outcome === "hostile" ? null : 0.99,
        escalationReason: outcome === "hostile" ? null : "not_applicable",
      });
      expect(out).toMatchObject({ kind: "template", body: text });
    }
  });
});
