import { beforeEach, describe, expect, it, vi } from "vitest";

const sendSmsToContact = vi.fn();
const pickFromPool = vi.fn();
const loadTemplateVarsWithMeta = vi.fn();

vi.mock("@/lib/messaging/send", () => ({ sendSmsToContact: (...a: unknown[]) => sendSmsToContact(...a) }));
vi.mock("@/lib/templates/pool", () => ({ pickFromPool: (...a: unknown[]) => pickFromPool(...a) }));
vi.mock("@/lib/sequences/template-vars", () => ({
  loadTemplateVarsWithMeta: (...a: unknown[]) => loadTemplateVarsWithMeta(...a),
}));
vi.mock("@/lib/messaging/consent", () => ({ getConsentState: vi.fn(async () => "granted") }));
vi.mock("@/lib/messaging/suppression", () => ({ shouldSuppressAutomatedSend: () => false }));
vi.mock("@/lib/messaging/opt-out-phone", () => ({ loadSuppressedSmsPhoneSet: vi.fn(async () => new Set()) }));
vi.mock("@/lib/messaging/registry", () => ({ getMessagingProvider: () => ({ providerId: "p" }) }));
vi.mock("@/lib/messaging/delivery", () => ({
  loadCampaignDeliverySettings: vi.fn(async () => ({
    senderNumber: "+18165550100",
    senderProvider: "p",
    fromAddress: null,
  })),
  normalizeSenderNumber: (n: string) => n,
}));

import { renderTemplate } from "@/lib/sequences/render";

import { freshScheduleState, queueSmsBatch } from "./bulk-queue";
import {
  HOSTILE_NEEDS_CONFIRM_REASON,
  OPTOUT_PHRASE_NEEDS_CONFIRM_REASON,
} from "@/lib/ai-responder/hostile";

const PHONE = { phone_1: "+18165551234", phone_1_type: "mobile", phone_2: null, phone_2_type: null, phone_3: null, phone_3_type: null };

function fakeClient(propertyExtra: Record<string, unknown> = {}) {
  const tables: Record<string, unknown[]> = {
    properties: [{ id: "prop-1", homeowner_contact_id: "c-1", org_id: "org-1", outreach_dispo: null, homeowner: PHONE, ...propertyExtra }],
    campaign_recipients: [{ property_id: "prop-1", contact_id: "c-1" }],
    contacts: [{ id: "c-1", ...PHONE, do_not_contact: false, sms_opted_out: false }],
    messages: [],
  };
  return {
    from(table: string) {
      const rows = tables[table] ?? [];
      const chain: Record<string, unknown> = {};
      for (const m of ["select", "eq", "in", "order", "range", "not"]) chain[m] = () => chain;
      chain.then = (resolve: (v: unknown) => unknown) => resolve({ data: rows, error: null });
      return chain;
    },
  } as never;
}

const OFFER = { amount: 139_000, sourceValue: 185_000, source: "properties.arv", pct: 0.75 };

async function run(opts: { body?: string; templateCategory?: string }) {
  return queueSmsBatch(fakeClient(), {
    propertyIds: ["prop-1"],
    opts: { campaignId: "camp-1", paceSeconds: 60, ...opts },
    state: freshScheduleState(Date.UTC(2026, 10, 2)),
  });
}

describe("queueSmsBatch rapid_offer", () => {
  beforeEach(() => {
    sendSmsToContact.mockReset().mockResolvedValue({ status: "queued" });
    pickFromPool.mockReset();
    loadTemplateVarsWithMeta.mockReset();
  });

  it("renders a literal body with the token and logs rapidOffer metadata", async () => {
    loadTemplateVarsWithMeta.mockResolvedValue({ vars: { rapid_offer: "$139,000" }, rapidOffer: OFFER });
    const state = await run({ body: "Offer {{rapid_offer}}" });
    expect(state.succeeded).toBe(1);
    const input = sendSmsToContact.mock.calls[0][1];
    expect(input.body).toBe("Offer $139,000");
    expect(input.metadata).toEqual({ rapidOffer: { ...OFFER, roundTo: 1000 } });
  });

  it("skips a template using the token when there is no value", async () => {
    pickFromPool.mockResolvedValue({ content: "Offer {{rapid_offer}}" });
    loadTemplateVarsWithMeta.mockResolvedValue({ vars: { rapid_offer: "" }, rapidOffer: null });
    const state = await run({ templateCategory: "Rapid" });
    expect(state.skipped).toBe(1);
    expect(state.skippedNoValue).toBe(1);
    expect(state.succeeded).toBe(0);
    expect(sendSmsToContact).not.toHaveBeenCalled();
  });

  it("sends a body without the token normally when there is no value", async () => {
    loadTemplateVarsWithMeta.mockResolvedValue({ vars: { rapid_offer: "" }, rapidOffer: null });
    const state = await run({ body: "Hello there" });
    expect(state.succeeded).toBe(1);
    expect(state.skippedNoValue).toBe(0);
    const input = sendSmsToContact.mock.calls[0][1];
    expect(input.body).toBe("Hello there");
    expect(input.metadata).toBeUndefined();
  });

  it("does not load template vars for a body with no tokens", async () => {
    await run({ body: "Hello there" });
    expect(loadTemplateVarsWithMeta).not.toHaveBeenCalled();
  });

  it("does not log rapidOffer metadata when the body omits the token", async () => {
    loadTemplateVarsWithMeta.mockResolvedValue({ vars: { rapid_offer: "$139,000" }, rapidOffer: OFFER });
    await run({ body: "Hello there" });
    expect(sendSmsToContact.mock.calls[0][1].metadata).toBeUndefined();
  });
});

describe("queueSmsBatch literal-body rendering compatibility", () => {
  beforeEach(() => {
    sendSmsToContact.mockReset().mockResolvedValue({ status: "queued" });
    loadTemplateVarsWithMeta.mockReset().mockResolvedValue({ vars: { rapid_offer: "" }, rapidOffer: null });
  });

  it("an unknown token in a literal body now renders blank (behaviour change)", async () => {
    await run({ body: "Reference {{external_id}}" });
    expect(sendSmsToContact.mock.calls[0][1].body).toBe("Reference ");
  });

  it("legacy serialized state without skippedNoValue still counts a no-value skip", async () => {
    const legacy = { ...freshScheduleState(Date.UTC(2026, 10, 2)) } as Record<string, unknown>;
    delete legacy.skippedNoValue;
    const state = await queueSmsBatch(fakeClient(), {
      propertyIds: ["prop-1"],
      opts: { campaignId: "camp-1", paceSeconds: 60, body: "Offer {{rapid_offer}}" },
      state: legacy as never,
    });
    expect(state.skippedNoValue).toBe(1);
    expect(state.skipped).toBe(1);
    expect(sendSmsToContact).not.toHaveBeenCalled();
  });
});

describe("renderTemplate identity", () => {
  it("returns text with no tokens unchanged", () => {
    const text = "Plain body, $5 {not a token} } { | 100% as-is.";
    expect(renderTemplate(text, { first_name: "X", rapid_offer: "$1,000" })).toBe(text);
  });
});

describe("queueSmsBatch open stop-texting / hostile hold skip", () => {
  beforeEach(() => {
    sendSmsToContact.mockReset().mockResolvedValue({ status: "queued" });
    loadTemplateVarsWithMeta.mockReset().mockResolvedValue({ vars: { rapid_offer: "" }, rapidOffer: null });
  });

  async function runWith(extra: Record<string, unknown>) {
    return queueSmsBatch(fakeClient(extra), {
      propertyIds: ["prop-1"],
      opts: { campaignId: "camp-1", paceSeconds: 60, body: "Hello there" },
      state: freshScheduleState(Date.UTC(2026, 10, 8)),
    });
  }

  it.each([
    ["stop-texting", `${OPTOUT_PHRASE_NEEDS_CONFIRM_REASON}:msg-1`],
    ["hostile", `${HOSTILE_NEEDS_CONFIRM_REASON}:msg-2`],
  ])("skips a property with an open %s hold and counts it", async (_label, reason) => {
    const state = await runWith({ needs_human_attention: true, last_ai_escalation_reason: reason });
    expect(state.skipped).toBe(1);
    expect(state.skippedConfirmHold).toBe(1);
    expect(state.succeeded).toBe(0);
    expect(sendSmsToContact).not.toHaveBeenCalled();
  });

  it("queues a property whose hold a person already cleared", async () => {
    const state = await runWith({ needs_human_attention: false, last_ai_escalation_reason: `${HOSTILE_NEEDS_CONFIRM_REASON}:msg-2` });
    expect(state.succeeded).toBe(1);
    expect(state.skippedConfirmHold).toBe(0);
    expect(sendSmsToContact).toHaveBeenCalledTimes(1);
  });

  it("queues a property flagged for an unrelated reason", async () => {
    const state = await runWith({ needs_human_attention: true, last_ai_escalation_reason: "something_else" });
    expect(state.succeeded).toBe(1);
    expect(sendSmsToContact).toHaveBeenCalledTimes(1);
  });
});
