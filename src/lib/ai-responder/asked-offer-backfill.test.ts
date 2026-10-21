import { beforeEach, describe, expect, it, vi } from "vitest";

const sendSmsToContact = vi.fn();
const getConsentStateStrict = vi.fn();
const isSmsPhoneSuppressed = vi.fn();
vi.mock("@/lib/messaging/send", () => ({ sendSmsToContact: (...a: unknown[]) => sendSmsToContact(...a) }));
vi.mock("@/lib/messaging/consent", () => ({ getConsentStateStrict: (...a: unknown[]) => getConsentStateStrict(...a) }));
vi.mock("@/lib/messaging/opt-out-phone", () => ({ isSmsPhoneSuppressed: (...a: unknown[]) => isSmsPhoneSuppressed(...a) }));

import {
  ASKED_OFFER_BACKFILL_BODY,
  ASKED_OFFER_BACKFILL_KIND,
  backfillSkipReason,
  chicagoWindowOpen,
  idempotencyKeyFor,
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
  return { client: { from } as never, tables };
}

const ORG = "00000000-0000-0000-0000-000000000bbb";
const window = { since: new Date("2026-10-01T00:00:00Z"), before: new Date("2026-10-21T00:58:00Z") };
/** 10:00 Chicago (CDT, UTC-5). */
const OPEN = new Date("2026-10-21T15:00:00Z");
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
  return { id, org_id: ORG, address: `${id} Main St`, city: "Kansas City", state: "MO", status: "new_lead", outreach_dispo: null, ai_responder_disabled: false, is_dnc_locked: false, ...over };
}

function msg(id: string, propertyId: string, direction: string, created_at: string, body: string, over: Row = {}): Row {
  return { id, property_id: propertyId, contact_id: `c-${propertyId}`, conversation_id: `conv-${propertyId}`, direction, status: direction === "inbound" ? "received" : "delivered", body, from_address: direction === "inbound" ? "+18165550100" : "+18164876899", to_address: null, created_at, channel: "sms", ...over };
}

function classifierSaying(answer: "asked_offer" | "talked_price") {
  const ids = ["open_to_selling", "maybe_later", "asked_who", "not_interested", "wrong_person", "asked_stop", "hostile", "confirmed_owner", "talked_price", "asked_offer", "named_price", "asked_call"];
  const raw = Object.fromEntries(ids.map((k) => [k, k === answer ? 0.95 : 0.01]));
  return vi.fn(async (): Promise<NineQuestionResult> => ({ ...decideNineQuestions(raw), latencyMs: 1, model: "jev", usage: null }));
}

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

beforeEach(() => {
  sendSmsToContact.mockReset().mockResolvedValue({ status: "sent", messageId: "new-row", externalId: "x" });
  getConsentStateStrict.mockReset().mockResolvedValue({ ok: true, state: "implied" });
  isSmsPhoneSuppressed.mockReset().mockResolvedValue(false);
});

describe("approved text", () => {
  it("is Jarrad's approved asked_offer text, byte for byte", () => {
    expect(ASKED_OFFER_BACKFILL_BODY).toBe(NINE_HOT_REPLY_TEXTS.asked_offer);
  });
});

describe("helpers", () => {
  it("summarizeThread: latest inbound, texted since, approved text history, own row ignored", () => {
    const m = [
      msg("o1", "p", "outbound", "2026-10-19T22:00:00Z", "Hi, Mel with BMH"),
      msg("i1", "p", "inbound", "2026-10-20T00:28:00Z", "What's the offer"),
    ] as BackfillMessage[];
    expect(summarizeThread(m)).toMatchObject({ latestInbound: { id: "i1" }, outboundSinceInbound: false, approvedTextBefore: false, ourLastTextBefore: "Hi, Mel with BMH" });
    const after = [...m, msg("own", "p", "outbound", "2026-10-21T15:00:00Z", ASKED_OFFER_BACKFILL_BODY, { status: "pending" }) as BackfillMessage];
    expect(summarizeThread(after)).toMatchObject({ outboundSinceInbound: true, approvedTextBefore: true });
    expect(summarizeThread(after, "own")).toMatchObject({ outboundSinceInbound: false, approvedTextBefore: false });
  });

  it("chicagoWindowOpen is 08:00 up to 21:00 Chicago", () => {
    expect(chicagoWindowOpen(new Date("2026-10-21T12:59:00Z"))).toBe(false); // 07:59 CDT
    expect(chicagoWindowOpen(new Date("2026-10-21T13:00:00Z"))).toBe(true); // 08:00
    expect(chicagoWindowOpen(new Date("2026-10-22T01:59:00Z"))).toBe(true); // 20:59
    expect(chicagoWindowOpen(new Date("2026-10-22T02:00:00Z"))).toBe(false); // 21:00
  });

  it("idempotencyKeyFor is stable per inbound and a valid v4 UUID", () => {
    const k = idempotencyKeyFor("i1");
    expect(k).toBe(idempotencyKeyFor("i1"));
    expect(k).not.toBe(idempotencyKeyFor("i2"));
    expect(k).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
  });
});

describe("backfillSkipReason", () => {
  const base = (): BackfillFacts => ({
    property: property("p") as never,
    latestInbound: msg("i", "p", "inbound", "2026-10-20T00:28:00Z", "offer?") as never,
    outboundSinceInbound: false,
    approvedTextBefore: false,
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
    ["already_got_this_text", (f) => (f.approvedTextBefore = true)],
    ["no_inbound_number", (f) => (f.latestInbound!.from_address = null)],
    ["called_since", (f) => (f.callSinceInbound = true)],
    ["no_contact", (f) => (f.contact = null)],
    ["consent_unreadable", (f) => (f.consentState = null)],
    ["dnc", (f) => (f.contact!.do_not_contact = true)],
    ["dnc", (f) => (f.property.is_dnc_locked = true)],
    ["opted_out", (f) => (f.contact!.sms_opted_out = true)],
    ["opted_out", (f) => (f.consentState = "opted_out")],
    ["phone_suppressed", (f) => (f.phoneSuppressed = true)],
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
  it("dry run sends nothing and lists only unanswered asked_offer leads", async () => {
    const classify = classifierSaying("asked_offer");
    const rows = await runAskedOfferBackfill(db().client, options(), { classify, now: () => OPEN });
    expect(sendSmsToContact).not.toHaveBeenCalled();
    expect(rows.filter((r) => r.target).map((r) => r.propertyId)).toEqual(["p1"]);
    // p2 already texted (not listed), p3 DNC (skipped, never classified), p4 not a new lead.
    expect(rows.find((r) => r.propertyId === "p3")?.skip).toBe("dnc");
    expect(rows.some((r) => r.propertyId === "p2" || r.propertyId === "p4")).toBe(false);
    expect(classify).toHaveBeenCalledTimes(1);
    expect(classify).toHaveBeenCalledWith({ our_last_text_to_homeowner: "Hi, Mel with BMH", homeowner_reply: "What's the offer" });
  });

  it("does not target a lead the current classifier reads as something else", async () => {
    const rows = await runAskedOfferBackfill(db().client, options({ apply: true }), { classify: classifierSaying("talked_price"), now: () => OPEN });
    expect(rows.find((r) => r.propertyId === "p1")).toMatchObject({ target: false, answer: "talked_price" });
    expect(sendSmsToContact).not.toHaveBeenCalled();
  });

  it("apply sends the approved text now, automated, to the seller's number, with a per-inbound key", async () => {
    const rows = await runAskedOfferBackfill(db().client, options({ apply: true }), { classify: classifierSaying("asked_offer"), now: () => OPEN });
    expect(sendSmsToContact).toHaveBeenCalledTimes(1);
    const [, input] = sendSmsToContact.mock.calls[0]!;
    expect(input).toMatchObject({
      origin: "automated",
      contactId: "c-p1",
      propertyId: "p1",
      body: NINE_HOT_REPLY_TEXTS.asked_offer,
      to: "+18165550100",
      requireStickyFrom: true,
      idempotencyKey: idempotencyKeyFor("i1"),
      metadata: { kind: ASKED_OFFER_BACKFILL_KIND, sourceInboundMessageId: "i1" },
    });
    expect(input.queueOnly).toBeUndefined();
    expect(typeof input.beforeProviderSubmit).toBe("function");
    expect(rows.find((r) => r.propertyId === "p1")?.sent).toEqual({ status: "sent", messageId: "new-row" });
  });

  it("apply sends nothing outside 08:00-21:00 Chicago", async () => {
    const rows = await runAskedOfferBackfill(db().client, options({ apply: true }), {
      classify: classifierSaying("asked_offer"),
      now: () => new Date("2026-10-21T03:00:00Z"), // 22:00 Chicago
    });
    expect(rows.find((r) => r.propertyId === "p1")?.sent).toEqual({ status: "window_closed" });
    expect(sendSmsToContact).not.toHaveBeenCalled();
  });

  it("a second run finds the earlier text and sends nothing", async () => {
    const d = db();
    d.tables.messages!.push(msg("s1", "p1", "outbound", "2026-10-21T15:00:00Z", NINE_HOT_REPLY_TEXTS.asked_offer));
    const rows = await runAskedOfferBackfill(d.client, options({ apply: true }), { classify: classifierSaying("asked_offer"), now: () => OPEN });
    expect(rows.filter((r) => r.target)).toEqual([]);
    expect(sendSmsToContact).not.toHaveBeenCalled();
  });

  it("skips a seller who got this exact text before their latest inbound", async () => {
    const d = db();
    d.tables.messages!.push(msg("old", "p1", "outbound", "2026-10-02T15:00:00Z", NINE_HOT_REPLY_TEXTS.asked_offer));
    const rows = await runAskedOfferBackfill(d.client, options({ apply: true }), { classify: classifierSaying("asked_offer"), now: () => OPEN });
    expect(rows.find((r) => r.propertyId === "p1")?.skip).toBe("already_got_this_text");
    expect(sendSmsToContact).not.toHaveBeenCalled();
  });

  it("skips excluded leads, leads called since, and leads Jev could not read", async () => {
    const d = db();
    d.tables.call_activities!.push({ id: "call", property_id: "p1", created_at: "2026-10-20T05:00:00Z" });
    let rows = await runAskedOfferBackfill(d.client, options({ apply: true }), { classify: classifierSaying("asked_offer"), now: () => OPEN });
    expect(rows.find((r) => r.propertyId === "p1")?.skip).toBe("called_since");
    rows = await runAskedOfferBackfill(db().client, options({ apply: true, excludePropertyIds: new Set(["p1"]) }), { classify: classifierSaying("asked_offer"), now: () => OPEN });
    expect(rows.find((r) => r.propertyId === "p1")?.skip).toBe("excluded");
    const failing = vi.fn(async () => {
      throw new Error("jev down");
    });
    rows = await runAskedOfferBackfill(db().client, options({ apply: true }), { classify: failing, now: () => OPEN });
    expect(rows.find((r) => r.propertyId === "p1")).toMatchObject({ target: false, classifyError: "jev down" });
    expect(sendSmsToContact).not.toHaveBeenCalled();
  });

  describe("last look before the provider", () => {
    type FenceInput = { beforeProviderSubmit: (c?: { messageId: string }) => Promise<boolean> };
    /** Runs apply with a send mock that inserts the pending row, changes the world, then asks the fence. */
    async function lastLookAfter(change: (d: ReturnType<typeof db>) => void, now: () => Date = () => OPEN) {
      const d = db();
      let allowed: boolean | null = null;
      sendSmsToContact.mockImplementation(async (_s: unknown, input: FenceInput) => {
        d.tables.messages!.push(msg("pending", "p1", "outbound", "2026-10-21T15:00:00Z", ASKED_OFFER_BACKFILL_BODY, { status: "pending" }));
        change(d);
        allowed = await input.beforeProviderSubmit({ messageId: "pending" });
        return allowed ? { status: "sent", messageId: "pending", externalId: "x" } : { status: "blocked_before_provider", messageId: "pending", retired: true };
      });
      await runAskedOfferBackfill(d.client, options({ apply: true }), { classify: classifierSaying("asked_offer"), now });
      return allowed;
    }
    const lead = (d: ReturnType<typeof db>) => d.tables.properties!.find((p) => p.id === "p1")!;

    it("allows the send when nothing changed (its own pending row is ignored)", async () => {
      expect(await lastLookAfter(() => {})).toBe(true);
    });
    it.each<[string, (d: ReturnType<typeof db>) => void]>([
      ["a person texted", (d) => void d.tables.messages!.push(msg("late", "p1", "outbound", "2026-10-21T14:59:00Z", "hey, Jarrad here"))],
      ["the seller texted again", (d) => void d.tables.messages!.push(msg("i1b", "p1", "inbound", "2026-10-21T14:59:00Z", "never mind"))],
      ["a call was logged", (d) => void d.tables.call_activities!.push({ id: "c", property_id: "p1", created_at: "2026-10-21T14:59:00Z" })],
      ["the lead was marked not interested", (d) => void (lead(d).outreach_dispo = "not_interested")],
      ["Jev was switched off for the lead", (d) => void (lead(d).ai_responder_disabled = true)],
    ])("refuses when %s", async (_why, change) => {
      expect(await lastLookAfter(change)).toBe(false);
    });
    it("refuses when the Chicago window closed while sending", async () => {
      const times = [OPEN];
      expect(await lastLookAfter(() => {}, () => times.shift() ?? new Date("2026-10-22T02:00:00Z"))).toBe(false);
    });
  });
});
