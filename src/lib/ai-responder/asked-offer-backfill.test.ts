import { beforeEach, describe, expect, it, vi } from "vitest";

const sendSmsToContact = vi.fn();
const getConsentState = vi.fn();
const isSmsPhoneSuppressed = vi.fn();
vi.mock("@/lib/messaging/send", () => ({ sendSmsToContact: (...a: unknown[]) => sendSmsToContact(...a) }));
vi.mock("@/lib/messaging/consent", () => ({ getConsentState: (...a: unknown[]) => getConsentState(...a) }));
vi.mock("@/lib/messaging/opt-out-phone", () => ({ isSmsPhoneSuppressed: (...a: unknown[]) => isSmsPhoneSuppressed(...a) }));

import {
  ASKED_OFFER_BACKFILL_BODY,
  ASKED_OFFER_BACKFILL_KIND,
  backfillSkipReason,
  runAskedOfferBackfill,
  summarizeThread,
  type BackfillFacts,
  type BackfillMessage,
  type BackfillOptions,
} from "./asked-offer-backfill";
import { NINE_HOT_REPLY_TEXTS, decideNineQuestions, type NineQuestionResult } from "@/lib/sms-classification/nine-questions";

type Row = Record<string, unknown>;

/** Minimal in-memory stand-in for the supabase-js query chain the backfill uses. */
function fakeSupabase(tables: Record<string, Row[]>) {
  const inserted: Row[] = [];
  const from = (table: string) => {
    let rows = [...(tables[table] ?? [])];
    let limit: number | null = null;
    const q = {
      select: () => q,
      eq: (c: string, v: unknown) => ((rows = rows.filter((r) => r[c] === v)), q),
      in: (c: string, vs: unknown[]) => ((rows = rows.filter((r) => vs.includes(r[c]))), q),
      gt: (c: string, v: string) => ((rows = rows.filter((r) => String(r[c]) > v)), q),
      order: () => q,
      range: (a: number, b: number) => ((rows = rows.slice(a, b + 1)), q),
      limit: (n: number) => ((limit = n), q),
      maybeSingle: async () => ({ data: rows[0] ?? null, error: null }),
      then: (resolve: (v: { data: Row[]; error: null }) => unknown) =>
        resolve({ data: limit === null ? rows : rows.slice(0, limit), error: null }),
    };
    return q;
  };
  return { client: { from } as never, inserted, tables };
}

const ORG = "00000000-0000-0000-0000-000000000bbb";
const window = { since: new Date("2026-10-01T00:00:00Z"), before: new Date("2026-10-21T00:58:00Z") };
const options = (over: Partial<BackfillOptions> = {}): BackfillOptions => ({
  orgId: ORG,
  statuses: ["new_lead"],
  ...window,
  excludePropertyIds: new Set(),
  onlyPropertyIds: null,
  apply: false,
  ...over,
});

function property(id: string, over: Row = {}): Row {
  return { id, org_id: ORG, address: `${id} Main St`, city: "Kansas City", state: "MO", status: "new_lead", outreach_dispo: null, ai_responder_disabled: false, is_dnc_locked: false, needs_human_attention: true, assigned_user_id: null, ...over };
}

function msg(id: string, propertyId: string, direction: string, created_at: string, body: string, over: Row = {}): Row {
  return { id, property_id: propertyId, contact_id: `c-${propertyId}`, conversation_id: `conv-${propertyId}`, direction, status: direction === "inbound" ? "received" : "delivered", body, from_address: direction === "inbound" ? "+18165550100" : "+18164876899", to_address: null, created_at, channel: "sms", ...over };
}

function classifierSaying(answer: "asked_offer" | "talked_price" | "not_interested") {
  const raw: Record<string, number> = { asked_offer: 0.1, talked_price: 0.1, not_interested: 0.1 };
  raw[answer] = 0.95;
  const filled = Object.fromEntries(
    ["open_to_selling", "maybe_later", "asked_who", "not_interested", "wrong_person", "asked_stop", "hostile", "confirmed_owner", "talked_price", "asked_offer", "named_price", "asked_call"].map((k) => [k, raw[k] ?? 0.01]),
  );
  return vi.fn(async (): Promise<NineQuestionResult> => ({ ...decideNineQuestions(filled), latencyMs: 1, model: "jev", usage: null }));
}

beforeEach(() => {
  sendSmsToContact.mockReset().mockResolvedValue({ status: "queued", messageId: "new-row" });
  getConsentState.mockReset().mockResolvedValue("implied");
  isSmsPhoneSuppressed.mockReset().mockResolvedValue(false);
});

describe("approved text", () => {
  it("is Jarrad's approved asked_offer text, byte for byte", () => {
    expect(ASKED_OFFER_BACKFILL_BODY).toBe(NINE_HOT_REPLY_TEXTS.asked_offer);
  });
});

describe("summarizeThread", () => {
  it("finds the latest inbound, whether we texted since, and our text before it", () => {
    const m = [
      msg("o1", "p", "outbound", "2026-10-19T22:00:00Z", "Hi, Mel with BMH"),
      msg("i1", "p", "inbound", "2026-10-20T00:28:00Z", "What's the offer"),
    ] as BackfillMessage[];
    expect(summarizeThread(m)).toMatchObject({ latestInbound: { id: "i1" }, outboundSinceInbound: false, ourLastTextBefore: "Hi, Mel with BMH" });
    const after = [...m, msg("o2", "p", "outbound", "2026-10-21T02:00:00Z", "x", { status: "queued" }) as BackfillMessage];
    expect(summarizeThread(after).outboundSinceInbound).toBe(true);
  });
});

describe("backfillSkipReason", () => {
  const base = (): BackfillFacts => ({
    property: property("p") as never,
    latestInbound: msg("i", "p", "inbound", "2026-10-20T00:28:00Z", "offer?") as never,
    outboundSinceInbound: false,
    callSinceInbound: false,
    contact: { id: "c-p", do_not_contact: false, sms_opted_out: false },
    consentState: "implied",
    phoneSuppressed: false,
    excluded: false,
    window,
  });
  it("passes a clean lead", () => expect(backfillSkipReason(base())).toBeNull());
  it("passes a lead still waiting for a sequence", () => {
    const f = base();
    f.property.outreach_dispo = "needs_sequence";
    expect(backfillSkipReason(f)).toBeNull();
  });
  it.each<[string, (f: BackfillFacts) => void]>([
    ["excluded", (f) => (f.excluded = true)],
    ["no_inbound", (f) => (f.latestInbound = null)],
    ["inbound_outside_window", (f) => (f.latestInbound = msg("i", "p", "inbound", "2026-10-21T01:30:00Z", "offer?") as never)],
    ["texted_since", (f) => (f.outboundSinceInbound = true)],
    ["called_since", (f) => (f.callSinceInbound = true)],
    ["no_contact", (f) => (f.contact = null)],
    ["dnc", (f) => (f.contact!.do_not_contact = true)],
    ["opted_out", (f) => (f.contact!.sms_opted_out = true)],
    ["opted_out", (f) => (f.consentState = "opted_out")],
    ["phone_suppressed", (f) => (f.phoneSuppressed = true)],
    ["dnc", (f) => (f.property.is_dnc_locked = true)],
    ["terminal_disposition", (f) => (f.property.outreach_dispo = "not_interested")],
    ["terminal_disposition", (f) => (f.property.outreach_dispo = "nurture")],
    ["ai_responder_disabled", (f) => (f.property.ai_responder_disabled = true)],
  ])("skips: %s", (reason, mutate) => {
    const f = base();
    mutate(f);
    expect(backfillSkipReason(f)).toBe(reason);
  });
});

describe("runAskedOfferBackfill", () => {
  const db = () =>
    fakeSupabase({
      properties: [property("p1"), property("p2"), property("p3"), property("p4", { status: "prospect" })],
      messages: [
        msg("o1", "p1", "outbound", "2026-10-19T22:00:00Z", "Hi, Mel with BMH"),
        msg("i1", "p1", "inbound", "2026-10-20T00:28:00Z", "What's the offer"),
        msg("i2", "p2", "inbound", "2026-10-20T01:24:00Z", "What are you offering"),
        msg("o2", "p2", "outbound", "2026-10-21T02:03:00Z", NINE_HOT_REPLY_TEXTS.asked_offer, { status: "queued" }),
        msg("i3", "p3", "inbound", "2026-10-20T03:00:00Z", "What's your offer"),
        msg("i4", "p4", "inbound", "2026-10-20T03:00:00Z", "What's your offer"),
      ],
      contacts: [
        { id: "c-p1", do_not_contact: false, sms_opted_out: false },
        { id: "c-p3", do_not_contact: true, sms_opted_out: false },
      ],
      call_activities: [],
    });

  it("dry run writes nothing and lists only unanswered asked_offer leads", async () => {
    const { client } = db();
    const classify = classifierSaying("asked_offer");
    const rows = await runAskedOfferBackfill(client, options(), { classify, now: () => new Date() });
    expect(sendSmsToContact).not.toHaveBeenCalled();
    expect(rows.filter((r) => r.target).map((r) => r.propertyId)).toEqual(["p1"]);
    // p2 already texted (not listed), p3 DNC (skipped, never classified), p4 not a new lead.
    expect(rows.find((r) => r.propertyId === "p3")?.skip).toBe("dnc");
    expect(rows.some((r) => r.propertyId === "p2" || r.propertyId === "p4")).toBe(false);
    expect(classify).toHaveBeenCalledTimes(1);
    expect(classify).toHaveBeenCalledWith({ our_last_text_to_homeowner: "Hi, Mel with BMH", homeowner_reply: "What's the offer" });
  });

  it("does not target a lead the current classifier reads as something else", async () => {
    const rows = await runAskedOfferBackfill(db().client, options({ apply: true }), { classify: classifierSaying("talked_price"), now: () => new Date() });
    expect(rows.find((r) => r.propertyId === "p1")).toMatchObject({ target: false, answer: "talked_price" });
    expect(sendSmsToContact).not.toHaveBeenCalled();
  });

  it("apply queues the approved text through the normal send path, as an automated reply", async () => {
    const now = new Date("2026-10-21T14:00:00Z");
    const rows = await runAskedOfferBackfill(db().client, options({ apply: true }), { classify: classifierSaying("asked_offer"), now: () => now });
    expect(sendSmsToContact).toHaveBeenCalledTimes(1);
    const [, input] = sendSmsToContact.mock.calls[0]!;
    expect(input).toMatchObject({
      origin: "automated",
      contactId: "c-p1",
      propertyId: "p1",
      body: NINE_HOT_REPLY_TEXTS.asked_offer,
      to: "+18165550100",
      requireStickyFrom: true,
      queueOnly: true,
      scheduledFor: now,
      metadata: { kind: ASKED_OFFER_BACKFILL_KIND, sourceInboundMessageId: "i1" },
    });
    expect(rows.find((r) => r.propertyId === "p1")?.queued).toEqual({ status: "queued", messageId: "new-row" });
  });

  it("a second run finds the queued row and sends nothing", async () => {
    const d = db();
    d.tables.messages!.push(msg("q1", "p1", "outbound", "2026-10-21T14:00:00Z", NINE_HOT_REPLY_TEXTS.asked_offer, { status: "queued" }));
    const rows = await runAskedOfferBackfill(d.client, options({ apply: true }), { classify: classifierSaying("asked_offer"), now: () => new Date() });
    expect(rows.filter((r) => r.target)).toEqual([]);
    expect(sendSmsToContact).not.toHaveBeenCalled();
  });

  it("skips excluded leads, leads called since, and leads Jev could not read", async () => {
    const d = db();
    d.tables.call_activities!.push({ id: "call", property_id: "p1", created_at: "2026-10-20T05:00:00Z" });
    let rows = await runAskedOfferBackfill(d.client, options({ apply: true }), { classify: classifierSaying("asked_offer"), now: () => new Date() });
    expect(rows.find((r) => r.propertyId === "p1")?.skip).toBe("called_since");
    rows = await runAskedOfferBackfill(db().client, options({ apply: true, excludePropertyIds: new Set(["p1"]) }), { classify: classifierSaying("asked_offer"), now: () => new Date() });
    expect(rows.find((r) => r.propertyId === "p1")?.skip).toBe("excluded");
    const failing = vi.fn(async () => {
      throw new Error("jev down");
    });
    rows = await runAskedOfferBackfill(db().client, options({ apply: true }), { classify: failing, now: () => new Date() });
    expect(rows.find((r) => r.propertyId === "p1")).toMatchObject({ target: false, classifyError: "jev down" });
    expect(sendSmsToContact).not.toHaveBeenCalled();
  });

  it("re-checks for a newer outbound right before queueing", async () => {
    const d = db();
    const answer = classifierSaying("asked_offer");
    const classify = vi.fn(async () => {
      // A person texts while Jev is thinking.
      d.tables.messages!.push(msg("late", "p1", "outbound", "2026-10-21T14:00:00Z", "hey, Jarrad here"));
      return answer();
    });
    const rows = await runAskedOfferBackfill(d.client, options({ apply: true }), { classify, now: () => new Date() });
    expect(rows.find((r) => r.propertyId === "p1")?.queued).toEqual({ status: "texted_since_recheck" });
    expect(sendSmsToContact).not.toHaveBeenCalled();
  });
});
