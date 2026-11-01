import { Client } from "pg";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

import { createTestClient } from "@tests/integration/client";
import { BMH_ORG_ID, getCanonicalTestOrgId } from "@tests/integration/fixtures/multi-user";
import { MOCK_SENDER_PRIMARY, seedSenderCatalog } from "@tests/integration/delivery";
import type { AnthropicLike } from "@/lib/ai-responder/generate";
import { getMockMessageLog, resetMockState } from "@/lib/messaging/providers/mock";
import { claimAiResponse } from "@/lib/ai-responder/claims";
import { V2_REPLY_TEXTS } from "@/lib/sms-classification/routing-v2/reply-texts";
import { APPROVED_REPLY_TEXTS } from "@/lib/ai-responder/approved-reply-texts";
import { assertLocalOnlyTestEnv } from "@/lib/testing/local-only-test-env";
import { clearTestBarriers, setTestBarrier } from "@/lib/testing/test-barriers";

import { markdownReport } from "./report";
import { runBackfill, type BackfillMode } from "./run";

/**
 * Routing v2 backfill on a DISPOSABLE local stack (resets tenant tables): seeded 555-01xx
 * leads with backdated seller texts, the MOCK SMS provider, and stubbed Jev answers (no live
 * model call; Haiku is off). Exercises dry-run, classify-only, the age-split apply (full
 * treatment <= 14 days, sort-only older), skip rules, newest-wins and resume idempotence
 * through the REAL dispatchAiResponse -> v2 decision -> transition -> outbox path.
 *
 * Run: LOCAL_SUPABASE_URL / LOCAL_SUPABASE_SERVICE_ROLE_KEY / LOCAL_SUPABASE_ANON_KEY /
 * TEST_SUPABASE_DB_URL at your own stack with every migration applied, then
 * `npx vitest run --config vitest.local-integration.config.ts <this file>`.
 */
vi.mock("@/lib/messaging/quiet-hours", async (importOriginal) => {
  const real = await importOriginal<typeof import("@/lib/messaging/quiet-hours")>();
  return { ...real, checkQuietHours: () => ({ ok: true, localTime: "12:00", zone: "America/Chicago" }) };
});
vi.mock("@/lib/messaging/quiet-hours-recipient", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/messaging/quiet-hours-recipient")>()),
  checkRecipientQuietHours: () => ({ ok: true, state: "MO", localTime: "12:00", florida: false }),
}));

const supabase = createTestClient();
const pg = new Client({ connectionString: process.env.TEST_SUPABASE_DB_URL });
const realFetch = globalThis.fetch;
/** Stubbed Jev answers per seller text. */
const jevByReply: Record<string, Record<string, number>> = {};
/** Seller texts whose Jev call fails (provider error): the Jev-failed road. */
const jevFails = new Set<string>();
/** Runs while Jev is classifying this seller text (to model something arriving mid-classification). */
const jevDuring: Record<string, () => Promise<void>> = {};
let jevCalls = 0;

function installFakeJev() {
  globalThis.fetch = (async (input: Parameters<typeof fetch>[0], init?: Parameters<typeof fetch>[1]) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
    if (url.includes("api.anthropic.com")) throw new Error("no live Haiku in tests");
    if (!url.includes("/rest/v1/") && url.includes("dealmachine.com")) throw new Error("no live DealMachine in tests (the value comes from the cache)");
    if (!url.includes("api.typesafe.ai")) return realFetch(input, init);
    jevCalls++;
    const body = JSON.parse(String(init?.body)) as { questions: Record<string, unknown>; state?: { homeowner_reply?: string } };
    if (jevFails.has(body.state?.homeowner_reply ?? "")) return new Response("{}", { status: 500 });
    const during = jevDuring[body.state?.homeowner_reply ?? ""];
    if (during) await during();
    const probs = jevByReply[body.state?.homeowner_reply ?? ""] ?? {};
    const answers: Record<string, unknown> = {};
    for (const id of Object.keys(body.questions)) {
      answers[id] = id === "property_type"
        ? { choice: "residential", probabilities: { residential: 0.9, lot: 0.02, commercial: 0.02, rental: 0.02, didnt_say: 0.04 } }
        : id === "asked_how_number_obtained"
          ? { choice: "no", probabilities: { yes: 0.05, no: 0.95 } }
          : { choice: "noul", noul: probs[id] ?? 0.02 };
    }
    return new Response(JSON.stringify({ answers, model: "jev-test", usage: { input_tokens: 1, output_tokens: 1 } }), { status: 200, headers: { "content-type": "application/json" } });
  }) as typeof fetch;
}

const NO_ANTHROPIC: AnthropicLike = {
  messages: { create: async () => { throw new Error("Claude must not be called"); } } as unknown as AnthropicLike["messages"],
};

let orgId = "";
let phoneN = 0;
const leads: Array<{ propertyId: string; contactId: string; phone: string }> = [];

async function seedOrg(flags: Record<string, unknown>) {
  await supabase.from("ai_responder_configs").delete().eq("org_id", orgId);
  const { error } = await supabase.from("ai_responder_configs").insert({
    org_id: orgId, system_prompt: "test", business_hours_only: false,
    classifier_provider: "jev", classifier_mode: "automatic", classifier_engine: "nine_questions",
  });
  expect(error).toBeNull();
  await pg.query("update public.ai_responder_configs set routing_v2_flags = $2 where org_id = $1", [orgId, JSON.stringify(flags)]);
  await pg.query("begin");
  await pg.query("select set_config('sandra.template_approval', 'on', true)");
  const { rows } = await pg.query(
    "insert into public.sms_templates (org_id, name, content, approved_for_auto_send, approved_content, approved_at) values ($1, 'Auto reply v2: text only', $2, true, $2, now()) returning id",
    [orgId, V2_REPLY_TEXTS.text_only],
  );
  await pg.query("insert into public.auto_reply_templates (org_id, outcome, template_id) values ($1, 'text_only', $2)", [orgId, rows[0].id]);
  // The existing approved wrong-number reply (sent by the direct sender, not the outbox).
  await pg.query("insert into public.jev_outcome_thresholds (org_id, outcome, min_confidence, automation_enabled) values ($1, 'wrong_number', 0.9, true) on conflict do nothing", [orgId]);
  const { rows: wn } = await pg.query("insert into public.sms_templates (org_id, name, content, approved_for_auto_send, approved_content, approved_at) values ($1, 'Auto reply wrong_number', $2, true, $2, now()) returning id", [orgId, APPROVED_REPLY_TEXTS.wrong_number]);
  await pg.query("insert into public.auto_reply_templates (org_id, outcome, template_id) values ($1, 'wrong_number', $2)", [orgId, wn[0].id]);
  await pg.query("commit");
  // v2 drips are migration-edited only; seeded the way the cutover tests do.
  await pg.query("begin");
  await pg.query("select set_config('routing_v2.allow_drip_edit', 'on', true)");
  for (const [key, name] of [["book_appointment", "Book appointment (routing v2)"], ["confirmed_owner", "Confirmed owner (routing v2)"]]) {
    const { rows: s } = await pg.query("insert into sequences(org_id,name,active,routing_v2_key,routing_v2_version) values($1,$2,false,$3,1) returning id", [orgId, name, key]);
    await pg.query("insert into sequence_steps(sequence_id,step_index,delay_after_previous_minutes,action_type,template_body) values($1,0,1440,'send_sms',$2),($1,1,1440,'send_sms',$3)", [s[0].id, `${key} one`, `${key} two`]);
  }
  await pg.query("commit");
}

async function seedLead() {
  const phone = `+1816555${String(100 + phoneN++).padStart(4, "0")}`; // 555-01xx
  const { data: contact } = await supabase.from("contacts").insert({ org_id: orgId, first_name: "Bea", last_name: "Fill", phone_1: phone, phone_1_type: "mobile" }).select("id").single();
  await supabase.from("consent_events").insert({ contact_id: contact!.id, channel: "sms", event_type: "opt_in_marketing_written", source: "backfill-test", org_id: orgId });
  const { data: property } = await supabase.from("properties")
    .insert({ org_id: orgId, address: `${phoneN} Backfill Ln`, city: "Kansas City", zip: "64105", state: "MO", status: "prospect", homeowner_contact_id: contact!.id }).select("id").single();
  const lead = { propertyId: property!.id as string, contactId: contact!.id as string, phone };
  leads.push(lead);
  return lead;
}

const daysAgo = (d: number) => new Date(Date.now() - d * 86_400_000).toISOString();

/** Our opener, then the seller's text `days` ago (with a completed legacy claim, as the old engine left it). */
async function sellerText(lead: Awaited<ReturnType<typeof seedLead>>, body: string, days: number, jev: Record<string, number> = {}, stamp: Record<string, unknown> = { outcome: "skipped", reason: "nine_questions:no_action" }) {
  await supabase.from("messages").insert({ org_id: orgId, channel: "sms", direction: "outbound", status: "delivered", property_id: lead.propertyId, contact_id: lead.contactId, from_address: MOCK_SENDER_PRIMARY, to_address: lead.phone, body: "Hi, would you sell?", created_at: daysAgo(days + 1), metadata: { generated_by: "sequence_tick" } });
  const { data, error } = await supabase.from("messages")
    // Stamped the way the legacy engine left real backlog texts.
    .insert({ org_id: orgId, channel: "sms", direction: "inbound", status: "received", property_id: lead.propertyId, contact_id: lead.contactId, from_address: lead.phone, to_address: MOCK_SENDER_PRIMARY, body, created_at: daysAgo(days), metadata: { processing: { aiResponder: { ...stamp, completedAt: daysAgo(days) } } } })
    .select("id").single();
  expect(error).toBeNull();
  await pg.query(
    "insert into ai_response_claims (org_id, inbound_message_id, property_id, contact_id, status, outcome, completed_at, claimed_at) values ($1,$2,$3,$4,'completed','skipped',$5,$5)",
    [orgId, data!.id, lead.propertyId, lead.contactId, daysAgo(days)],
  );
  jevByReply[body] = jev;
  return data!.id as string;
}

const q = async (sql: string, args: unknown[] = []) => (await pg.query(sql, args)).rows;
const n = async (sql: string, args: unknown[] = []) => Number((await pg.query(sql, args)).rows[0].n);
const sentTo = (phone: string) => getMockMessageLog().filter((m) => m.to === phone);
const run = (mode: BackfillMode, runId: string, extra: Record<string, unknown> = {}, deps: Partial<Parameters<typeof runBackfill>[2]> = {}) =>
  runBackfill(supabase, { orgId, mode, runId, ratePerMinute: 6000, ...extra }, { anthropic: NO_ANTHROPIC, sleep: async () => undefined, ...deps });
/** ONE run id for the whole documented sequence (classify-only -> apply -> resume). */
const RUN = "bf-2026-11-01";
/** Isolated --limit 1 cases: every other lead of this file is test-tagged (skipped) first. */
const parkOthers = (keep: string) => pg.query("update properties set test_run_id = 'parked' where org_id = $1 and id <> $2 and test_run_id is null", [orgId, keep]);
const addToCanary = (...ids: string[]) => pg.query(
  "update ai_responder_configs set routing_v2_flags = jsonb_set(routing_v2_flags, '{canary_property_ids}', (routing_v2_flags->'canary_property_ids') || to_jsonb($2::text[])) where org_id = $1",
  [orgId, ids],
);
const settle = async () => { for (let i = 0; i < 10; i++) await new Promise((r) => setTimeout(r, 100)); };

describe("routing v2 backfill (disposable local stack, mock provider, stubbed Jev)", () => {
  type Lead = Awaited<ReturnType<typeof seedLead>>;
  const L: Record<string, Lead> = {};
  const T: Record<string, string> = {};
  let held: Lead, answered: Lead, tagged: Lead, takeover: Lead, livePending: Lead;
  let livePendingId = "";
  let olderId = "";
  let legacyEnrollment = "";
  const mine = () => [leads.map((l) => l.propertyId)];
  const safetyIds = () => [T.stop, T.legal, T.person, T.jevFail, T.oldStop];

  beforeAll(async () => {
    assertLocalOnlyTestEnv(process.env.TEST_SUPABASE_DB_URL, process.env.TEST_SUPABASE_URL);
    await pg.connect();
    process.env.TYPESAFE_API_KEY = "test-key";
    process.env.ANTHROPIC_API_KEY_SANDRA = "test-key";
    process.env.MESSAGING_PROVIDER = "mock";
    installFakeJev();

    await pg.query("begin");
    await pg.query("set local session_replication_role = replica");
    await pg.query("delete from public.memberships where org_id = $1", [BMH_ORG_ID]);
    await pg.query("commit");
    const { error: resetError } = await supabase.rpc("reset_tenant_tables");
    expect(resetError).toBeNull();
    const { error: orgError } = await supabase.from("organizations").upsert({ id: BMH_ORG_ID, name: "BMH (backfill test)" });
    expect(orgError).toBeNull();
    orgId = await getCanonicalTestOrgId(supabase);
    await seedSenderCatalog(supabase, orgId, [MOCK_SENDER_PRIMARY]);

    for (const k of ["fresh", "owner", "oldYes", "oldWrong", "twoTexts", "stop", "legal", "person", "jevFail", "oldStop", "oldNi", "oldPrice", "freshWrong"]) L[k] = await seedLead();
    livePending = await seedLead();
    held = await seedLead(); answered = await seedLead(); tagged = await seedLead(); takeover = await seedLead();
    // price_check ON: the old price text gets the real "too high" outcome (reply only, no alert).
    await seedOrg({ questions_live: true, replies: true, drips: true, price_check: true, canary_property_ids: leads.map((l) => l.propertyId) });
    process.env.DEALMACHINE_API_KEY = "test-key";

    // Full treatment (<= 14 days).
    T.fresh = await sellerText(L.fresh, "Text only please", 3, { text_only: 0.95 });
    T.owner = await sellerText(L.owner, "Yes I own it", 10, { confirmed_owner: 0.95 });
    olderId = await sellerText(L.twoTexts, "Who is this", 9, { asked_who: 0.95 });
    T.twoTexts = await sellerText(L.twoTexts, "Text only. I can't talk", 2, { text_only: 0.95 });
    // Safety roads: classify-only must leave no trace on the lead.
    T.stop = await sellerText(L.stop, "Please remove me from your list", 4, { asked_stop: 0.95 });
    T.legal = await sellerText(L.legal, "Put everything in writing to me", 5, { legal: 0.95 });
    T.person = await sellerText(L.person, "Hmm interesting", 6, {});
    T.jevFail = await sellerText(L.jevFail, "What do you mean exactly", 7, {});
    jevFails.add("What do you mean exactly");
    // Sort only (15-60 days).
    T.oldYes = await sellerText(L.oldYes, "Okay", 30, { just_ok: 0.95 });
    T.oldWrong = await sellerText(L.oldWrong, "Wrong number, not my house", 20, { wrong_person: 0.95 });
    T.oldStop = await sellerText(L.oldStop, "Do not message this number", 40, { asked_stop: 0.95 });
    T.oldNi = await sellerText(L.oldNi, "No thanks", 22, { not_interested: 0.95 });
    T.oldPrice = await sellerText(L.oldPrice, "I want $500,000 for it", 25, { named_price: 0.95 });
    await pg.query("insert into dealmachine_value_cache (property_id, org_id, state, estimated_value, valid_until) values ($1, $2, 'ok', 100000, now() + interval '20 days')", [L.oldPrice.propertyId, orgId]);
    T.freshWrong = await sellerText(L.freshWrong, "Not my house, you have the wrong person", 3, { wrong_person: 0.95 });
    // The delayed live reply is still pending for this text: the live path owns it.
    livePendingId = await sellerText(livePending, "Okay", 0.02, { just_ok: 0.95 }, { outcome: "delayed", scheduledAt: new Date().toISOString() });
    // A legacy (non-v2) drip on the stop lead: classify-only must not pause it.
    const { rows: seq } = await pg.query("insert into sequences(org_id,name,active) values($1,'Legacy drip',true) returning id", [orgId]);
    const { rows: enr } = await pg.query("insert into sequence_enrollments(org_id,sequence_id,property_id,contact_id,status) values($1,$2,$3,$4,'active') returning id", [orgId, seq[0].id, L.stop.propertyId, L.stop.contactId]);
    legacyEnrollment = enr[0].id;
    // Skipped leads.
    await sellerText(held, "Okay", 4, { just_ok: 0.95 });
    await pg.query("update properties set needs_human_attention = true, last_ai_escalation_reason = 'nine_needs_person' where id = $1", [held.propertyId]);
    await sellerText(answered, "Okay", 5, { just_ok: 0.95 });
    await supabase.from("messages").insert({ org_id: orgId, channel: "sms", direction: "outbound", status: "delivered", property_id: answered.propertyId, contact_id: answered.contactId, from_address: MOCK_SENDER_PRIMARY, to_address: answered.phone, body: "Rep here, calling you now", created_at: daysAgo(4) });
    await sellerText(tagged, "Okay", 5, { just_ok: 0.95 });
    await pg.query("update properties set test_run_id = 'stress-run-x' where id = $1", [tagged.propertyId]);
    await sellerText(takeover, "Okay", 6, { just_ok: 0.95 });
    await pg.query("update properties set last_person_takeover_at = now() - interval '5 days' where id = $1", [takeover.propertyId]);
    resetMockState();
  });
  afterAll(async () => {
    globalThis.fetch = realFetch;
    await pg.end();
  });

  const candidateIds = () => Object.values(T);

  it("dry-run: counts the candidate set, writes nothing", async () => {
    const before = await n("select count(*)::int n from messages where metadata ? 'routingV2Backfill' and org_id = $1", [orgId]);
    const r = await run("dry_run", RUN);
    expect(r.selection.candidates.map((c) => c.id).sort()).toEqual(candidateIds().sort());
    expect(r.selection.superseded.map((s) => s.inboundId)).toEqual([olderId]);
    const reasons = Object.fromEntries(r.selection.skipped.map((s) => [s.propertyId, s.reason]));
    expect(reasons).toMatchObject({
      [held.propertyId]: "needs_human_attention", [answered.propertyId]: "answered_by_human",
      [tagged.propertyId]: "test_tagged", [takeover.propertyId]: "human_takeover_after_inbound",
      [livePending.propertyId]: "live_pending",
    });
    expect(jevCalls).toBe(0);
    expect(await n("select count(*)::int n from messages where metadata ? 'routingV2Backfill' and org_id = $1", [orgId])).toBe(before);
    expect(await n("select count(*)::int n from routing_v2_live_decisions where property_id = any($1::uuid[])", mine())).toBe(0);
    expect(markdownReport("sha-test", r).split("\n")[0]).toBe("SHA: sha-test");
  });

  it("classify-only: every road decided, ZERO side effects (no decision row, hold, pause, cancel, alert, reply, drip)", async () => {
    const r = await run("classify_only", RUN);
    expect(r.items.map((i) => [i.inboundId, i.error])).toEqual(r.items.map((i) => [i.inboundId, null]));
    const roads = Object.fromEntries(r.items.map((i) => [i.inboundId, [i.treatment, i.road]]));
    expect(roads).toMatchObject({
      [T.fresh]: ["full", "text_only_reply"], [T.twoTexts]: ["full", "text_only_reply"], [T.owner]: ["full", "confirmed_owner_drip"],
      [T.stop]: ["full", "stop"], [T.legal]: ["full", "stop"], [T.person]: ["full", "haiku_unsure"], [T.jevFail]: ["full", "(failed)"],
      [T.oldYes]: ["sort_only", "book_appointment"], [T.oldWrong]: ["sort_only", "wrong_number_close"], [T.oldStop]: ["sort_only", "stop"],
      [T.oldNi]: ["sort_only", "not_interested_drip"], [T.oldPrice]: ["sort_only", "price_check"],
      [T.freshWrong]: ["full", "wrong_number_close"],
    });
    // What apply WOULD do is reported; nothing was done.
    for (const id of safetyIds()) expect(r.items.find((i) => i.inboundId === id), id).toMatchObject({ wouldHold: true, holdCreated: false, wouldReply: false });
    expect(r.items.find((i) => i.inboundId === T.oldYes)).toMatchObject({ wouldReply: false, wouldDrip: false, wouldAlert: true, wouldHold: true });
    expect(r.items.find((i) => i.inboundId === T.oldPrice)).toMatchObject({ wouldReply: false, wouldAlert: true, wouldHold: true });
    expect(r.items.find((i) => i.inboundId === T.fresh)).toMatchObject({ wouldReply: true, wouldDrip: false });
    // Spend is read from the ledger per text (one Jev call each; the Jev-failed text retries).
    expect(r.items.find((i) => i.inboundId === T.fresh)!.jevCalls).toBe(1);
    await settle();
    expect(await n("select count(*)::int n from routing_v2_live_decisions where property_id = any($1::uuid[])", mine())).toBe(0);
    expect(await n("select count(*)::int n from routing_v2_outbox where property_id = any($1::uuid[])", mine())).toBe(0);
    expect(await n("select count(*)::int n from routing_v2_reply_transitions where property_id = any($1::uuid[])", mine())).toBe(0);
    expect(await n("select count(*)::int n from sequence_enrollments where routing_v2_engine = 'v2' and property_id = any($1::uuid[])", mine())).toBe(0);
    expect(await n("select count(*)::int n from properties where needs_human_attention and id <> $1 and id = any($2::uuid[])", [held.propertyId, leads.map((l) => l.propertyId)])).toBe(0);
    expect(await n("select count(*)::int n from hold_alert_deliveries where property_id = any($1::uuid[])", mine())).toBe(0);
    const [legacy] = await q("select status from sequence_enrollments where id = $1", [legacyEnrollment]);
    expect(legacy.status).toBe("active");
    expect(await n("select count(*)::int n from sms_phone_suppressions where org_id = $1", [orgId])).toBe(0);
    expect(getMockMessageLog()).toHaveLength(0);
    expect(markdownReport("sha", r)).toContain("Holds actually written by classify-only (must be 0) | 0");
    // The decision lives on the marker; the legacy claim was moved aside under a unique name.
    const [m] = await q("select metadata->'routingV2Backfill'->'classify' c from messages where id = $1", [T.fresh]);
    expect(m.c).toMatchObject({ runId: RUN, decision: expect.objectContaining({ road: "text_only_reply", inbound_message_id: T.fresh }) });
    // Classify-only never touched the live responder claim: nothing moved, the originals intact,
    // and its own claims live under their own key.
    expect(await n("select count(*)::int n from ai_response_claims where response_kind like 'sms_ai_responder_v1:backfill_prior:%'", [])).toBe(0);
    expect(await n("select count(*)::int n from ai_response_claims where inbound_message_id = any($1::uuid[]) and response_kind = 'sms_ai_responder_v1:backfill_classify'", [candidateIds()])).toBe(candidateIds().length);
    expect(await n("select count(*)::int n from ai_response_claims where inbound_message_id = any($1::uuid[]) and response_kind = 'sms_ai_responder_v1' and status = 'completed' and outcome = 'skipped'", [candidateIds()])).toBe(candidateIds().length);
    const [lp] = await q("select count(*)::int n from ai_response_claims where inbound_message_id = $1 and response_kind = 'sms_ai_responder_v1' and outcome = 'skipped'", [livePendingId]);
    expect(lp.n).toBe(1);
    // Resume of classify-only with the same id: nothing re-classified.
    const calls = jevCalls;
    const again = await run("classify_only", RUN);
    expect(again.dispatched).toEqual([]);
    expect(jevCalls).toBe(calls);
  });

  it("apply with the SAME run id: replays the classify-only decisions (no Jev call), full vs sort-only, no claim collision", async () => {
    const calls = jevCalls;
    const r = await run("apply", RUN);
    expect(r.items.map((i) => [i.inboundId, i.error])).toEqual(r.items.map((i) => [i.inboundId, null]));
    expect(jevCalls).toBe(calls);
    await settle();
    // Full: approved replies once each; drip started; no reply on the drip-only road.
    expect(sentTo(L.fresh.phone).map((m) => m.body)).toEqual([V2_REPLY_TEXTS.text_only]);
    expect(sentTo(L.twoTexts.phone).map((m) => m.body)).toEqual([V2_REPLY_TEXTS.text_only]);
    expect(await n("select count(*)::int n from sequence_enrollments e join sequences s on s.id = e.sequence_id where e.property_id = $1 and s.routing_v2_key = 'confirmed_owner' and e.status = 'active'", [L.owner.propertyId])).toBe(1);
    expect(sentTo(L.owner.phone)).toHaveLength(0);
    // Safety roads now hold exactly as live (through the atomic recorder), nothing sent.
    for (const k of ["stop", "legal", "person", "jevFail", "oldStop"]) {
      const [p] = await q("select needs_human_attention h from properties where id = $1", [L[k].propertyId]);
      expect(p.h, k).toBe(true);
      expect(sentTo(L[k].phone), k).toHaveLength(0);
    }
    // Sort-only: hot road = alert + hold, no reply, no drip.
    expect(sentTo(L.oldYes.phone)).toHaveLength(0);
    expect(await n("select count(*)::int n from routing_v2_outbox where property_id = $1 and kind = 'reply'", [L.oldYes.propertyId])).toBe(0);
    expect(await n("select count(*)::int n from routing_v2_outbox where property_id = $1 and kind = 'alert'", [L.oldYes.propertyId])).toBeGreaterThanOrEqual(1);
    expect(await n("select count(*)::int n from sequence_enrollments where property_id = $1", [L.oldYes.propertyId])).toBe(0);
    // Sort-only price check ("too high", reply-only live): its STORED action carries the alert, and it queued.
    const [priceDecision] = await q("select action from routing_v2_live_decisions where inbound_message_id = $1", [T.oldPrice]);
    expect(priceDecision.action.steps).toEqual(expect.arrayContaining([{ kind: "alert", reason: "named_price" }]));
    expect(priceDecision.action.steps.some((st: { kind: string; key?: string }) => st.kind === "reply" && st.key === "price_too_high")).toBe(true);
    // Sort-only price check: an alert (never a silent hold), no reply.
    expect(await n("select count(*)::int n from routing_v2_outbox where property_id = $1 and kind = 'alert'", [L.oldPrice.propertyId])).toBeGreaterThanOrEqual(1);
    expect(await n("select count(*)::int n from routing_v2_outbox where property_id = $1 and kind = 'reply'", [L.oldPrice.propertyId])).toBe(0);
    expect(sentTo(L.oldPrice.phone)).toHaveLength(0);
    // Sort-only closes: wrong person and not interested, no reply.
    const dispo = async (l: Lead) => (await q("select outreach_dispo d from properties where id = $1", [l.propertyId]))[0].d;
    expect(await dispo(L.oldWrong)).toBe("wrong_number");
    expect(await dispo(L.oldNi)).toBe("not_interested");
    expect(sentTo(L.oldWrong.phone)).toHaveLength(0);
    expect(sentTo(L.oldNi.phone)).toHaveLength(0);
    // Newest wins: the older text is superseded in the audit, never routed.
    const [audit] = await q("select status, failure_reason from routing_v2_live_decisions where inbound_message_id = $1", [olderId]);
    expect(audit).toEqual({ status: "not_routed", failure_reason: `backfill_superseded:${RUN}` });
    for (const l of [held, answered, tagged, takeover]) expect(sentTo(l.phone)).toHaveLength(0);
    expect(r.items.find((i) => i.inboundId === T.fresh)).toMatchObject({ treatment: "full", repliesQueued: 1 });
    // The wrong-number reply goes out through the direct sender: still counted.
    expect(sentTo(L.freshWrong.phone).map((m) => m.body)).toEqual([APPROVED_REPLY_TEXTS.wrong_number]);
    expect(r.items.find((i) => i.inboundId === T.freshWrong)).toMatchObject({ repliesQueued: 1, repliesSent: 1 });
    // The live-pending text was never touched.
    expect(sentTo(livePending.phone)).toHaveLength(0);
    // Every applied text had a stored classify-only decision under the same group.
    expect(r.items.filter((i) => i.groupChanged || i.appliedWithoutStoredDecision)).toEqual([]);
    const md = markdownReport("sha-test", r);
    expect(md).toContain("## Full treatment");
    expect(md).toContain("## Sort only");
    expect(md).toContain("builder's reading");
    expect(md).not.toMatch(/\+1816/);
  });

  it("re-run of apply with the same id is idempotent: nothing selected, nothing sent again", async () => {
    const before = getMockMessageLog().length;
    const calls = jevCalls;
    const again = await run("apply", RUN);
    expect(again.dispatched).toEqual([]);
    await settle();
    expect(getMockMessageLog().length).toBe(before);
    expect(jevCalls).toBe(calls);
  });

  it("crash between dispatch and marker, then --resume with the same id: no collision, one reply", async () => {
    const lead = await seedLead();
    await pg.query("update ai_responder_configs set routing_v2_flags = jsonb_set(routing_v2_flags, '{canary_property_ids}', (routing_v2_flags->'canary_property_ids') || to_jsonb($2::text)) where org_id = $1", [orgId, lead.propertyId]);
    const id = await sellerText(lead, "Text only, no calls", 1, { text_only: 0.95 });
    await run("classify_only", "bf-crash", { limit: 1 });
    const crashed = await run("apply", "bf-crash", { limit: 1 }, {
      dispatch: async (...args) => {
        const { dispatchAiResponse } = await import("@/lib/ai-responder/dispatch");
        await dispatchAiResponse(...args);
        throw new Error("simulated crash");
      },
    });
    expect(crashed.items.map((i) => [i.inboundId, i.error])).toEqual([[id, "unexpected_error"]]);
    // The error came AFTER the dispatch queued the reply: the report counts it from the database.
    expect(crashed.items[0].repliesQueued).toBe(1);
    const resumed = await run("apply", "bf-crash", { limit: 1 });
    expect(resumed.items.map((i) => [i.inboundId, i.error])).toEqual([[id, null]]);
    await settle();
    expect(sentTo(lead.phone).map((m) => m.body)).toEqual([V2_REPLY_TEXTS.text_only]);
  });

  it("questions_live switched off mid-run: the rest are skipped, never the legacy engine", async () => {
    const a = await seedLead();
    const b = await seedLead();
    await pg.query("update ai_responder_configs set routing_v2_flags = jsonb_set(routing_v2_flags, '{canary_property_ids}', (routing_v2_flags->'canary_property_ids') || jsonb_build_array($2::text, $3::text)) where org_id = $1", [orgId, a.propertyId, b.propertyId]);
    const first = await sellerText(a, "Text only for me", 1, { text_only: 0.95 });
    const second = await sellerText(b, "Okay sure", 2, { just_ok: 0.95 });
    let dispatched = 0;
    const r = await run("apply", "bf-flip", { limit: 2 }, {
      dispatch: async (...args) => {
        const { dispatchAiResponse } = await import("@/lib/ai-responder/dispatch");
        const out = await dispatchAiResponse(...args);
        if (++dispatched === 1) await pg.query("update ai_responder_configs set routing_v2_flags = routing_v2_flags || '{\"questions_live\": false}'::jsonb where org_id = $1", [orgId]);
        return out;
      },
    });
    await settle();
    expect(r.items.map((i) => i.inboundId)).toEqual([first, second]);
    expect(r.items[1]).toMatchObject({ outcome: "skipped:routing_v2:backfill_v2_not_live", repliesQueued: 0, dripsStarted: 0 });
    expect(r.items[0]).toMatchObject({ appliedWithoutStoredDecision: true });
    expect(markdownReport("sha", r)).toContain("Applied without a stored classify-only decision (not reviewed) | 2");
    expect(sentTo(b.phone)).toHaveLength(0);
    expect(await n("select count(*)::int n from messages where property_id = $1 and direction = 'outbound' and created_at > now() - interval '1 hour'", [b.propertyId])).toBe(0);
    expect(await n("select count(*)::int n from sequence_enrollments where property_id = $1", [b.propertyId])).toBe(0);
    expect(await n("select count(*)::int n from sms_classification_runs where source_inbound_message_id = $1", [second])).toBe(0);
    await pg.query("update ai_responder_configs set routing_v2_flags = routing_v2_flags || '{\"questions_live\": true}'::jsonb where org_id = $1", [orgId]);
  });

  it("classify-only enforces the keyword hold INSIDE dispatch (a keyword added mid-run): skipped, no hold", async () => {
    const lead = await seedLead();
    await addToCanary(lead.propertyId);
    await parkOthers(lead.propertyId);
    const [{ kw }] = await q("select escalation_keywords kw from ai_responder_configs where org_id = $1", [orgId]);
    await pg.query("update ai_responder_configs set escalation_keywords = array['died'] where org_id = $1", [orgId]);
    const id = await sellerText(lead, "Can I talk to a real person", 1, { asked_call: 0.95 });
    try {
      const r = await run("classify_only", "bf-kw", { limit: 1 }, {
        dispatch: async (...args) => {
          // The runner's pre-check already ran with the old list; the dispatch reads the new one.
          await pg.query("update ai_responder_configs set escalation_keywords = array['died','real person'] where org_id = $1", [orgId]);
          const { dispatchAiResponse } = await import("@/lib/ai-responder/dispatch");
          return dispatchAiResponse(...args);
        },
      });
      expect(r.items.map((i) => [i.inboundId, i.road, i.holdCreated])).toEqual([[id, "keyword_hold", false]]);
      const [p] = await q("select needs_human_attention h from properties where id = $1", [lead.propertyId]);
      expect(p.h).toBe(false);
      expect(await n("select count(*)::int n from hold_alert_deliveries where property_id = $1", [lead.propertyId])).toBe(0);
    } finally {
      await pg.query("update ai_responder_configs set escalation_keywords = $2 where org_id = $1", [orgId, kw]);
    }
  });

  it("a claim in an error state (a live safety barrier) is never moved: the text is skipped", async () => {
    const lead = await seedLead();
    await addToCanary(lead.propertyId);
    await parkOthers(lead.propertyId);
    const id = await sellerText(lead, "Text only thanks", 1, { text_only: 0.95 });
    await pg.query("update ai_response_claims set status = 'error', error_message = 'v2_safety_hold_failed', completed_at = null where inbound_message_id = $1", [id]);
    const r = await run("apply", "bf-err", { limit: 1 });
    expect(r.items.map((i) => [i.inboundId, i.outcome, i.error])).toEqual([[id, "skipped:claim_error_state", null]]);
    const [c] = await q("select response_kind, status, error_message from ai_response_claims where inbound_message_id = $1", [id]);
    expect(c).toEqual({ response_kind: "sms_ai_responder_v1", status: "error", error_message: "v2_safety_hold_failed" });
    await settle();
    expect(sentTo(lead.phone)).toHaveLength(0);
    // Leave it to a person so later --limit 1 runs do not pick it again.
    await pg.query("update properties set needs_human_attention = true where id = $1", [lead.propertyId]);
  });

  it("sort-only: a newer seller text after selection fences the old one (no close, no hold)", async () => {
    const lead = await seedLead();
    await addToCanary(lead.propertyId);
    await parkOthers(lead.propertyId);
    const id = await sellerText(lead, "Nope not interested", 20, { not_interested: 0.95 });
    const r = await run("apply", "bf-newer", { limit: 1 }, {
      dispatch: async (...args) => {
        await supabase.from("messages").insert({ org_id: orgId, channel: "sms", direction: "inbound", status: "received", property_id: lead.propertyId, contact_id: lead.contactId, from_address: lead.phone, to_address: MOCK_SENDER_PRIMARY, body: "Actually yes call me" });
        const { dispatchAiResponse } = await import("@/lib/ai-responder/dispatch");
        return dispatchAiResponse(...args);
      },
    });
    expect(r.items.map((i) => [i.inboundId, i.treatment, i.outcome])).toEqual([[id, "sort_only", "skipped:routing_v2:backfill_newer_inbound"]]);
    const [p] = await q("select outreach_dispo d, needs_human_attention h from properties where id = $1", [lead.propertyId]);
    expect(p).toEqual({ d: null, h: false });
    // Only the audit row (not_routed); no decision was recorded from the older text.
    expect(await n("select count(*)::int n from routing_v2_live_decisions where inbound_message_id = $1 and status in ('decided','failed')", [id])).toBe(0);
  });

  it("fresh apply interrupted after the decision row, then resumed with the same id: carries out that decision (no second Jev call)", async () => {
    const lead = await seedLead();
    await addToCanary(lead.propertyId);
    await parkOthers(lead.propertyId);
    const id = await sellerText(lead, "Text only works for me", 1, { text_only: 0.95 });
    setTestBarrier("dispatch:after_decision", async (ctx) => { if (ctx.inboundMessageId === id) throw new Error("crash after decision"); });
    let first;
    try {
      first = await run("apply", "bf-fresh", { limit: 1 });
    } finally {
      clearTestBarriers();
    }
    expect(first.items.map((i) => [i.inboundId, i.error])).toEqual([[id, "unexpected_error"]]);
    expect(await n("select count(*)::int n from routing_v2_live_decisions where inbound_message_id = $1", [id])).toBe(1);
    // The crashed run's claim keeps its 5-minute lease: a resume inside it is refused (claim_in_progress).
    const early = await run("apply", "bf-fresh", { limit: 1 });
    expect(early.items.map((i) => i.error)).toEqual(["claim_in_progress"]);
    await pg.query("update ai_response_claims set lease_expires_at = now() - interval '1 minute' where inbound_message_id = $1 and status = 'processing'", [id]);
    const calls = jevCalls;
    const resumed = await run("apply", "bf-fresh", { limit: 1 });
    expect(resumed.items.map((i) => [i.inboundId, i.error])).toEqual([[id, null]]);
    expect(jevCalls).toBe(calls);
    await settle();
    expect(sentTo(lead.phone).map((m) => m.body)).toEqual([V2_REPLY_TEXTS.text_only]);
  });

  it("apply: an old keyword text never holds the lead once a newer seller text exists", async () => {
    const lead = await seedLead();
    await addToCanary(lead.propertyId);
    await parkOthers(lead.propertyId);
    const id = await sellerText(lead, "Can I talk to a real person about it", 3, { asked_call: 0.95 });
    const r = await run("apply", "bf-kwnew", { limit: 1 }, {
      dispatch: async (...args) => {
        await supabase.from("messages").insert({ org_id: orgId, channel: "sms", direction: "inbound", status: "received", property_id: lead.propertyId, contact_id: lead.contactId, from_address: lead.phone, to_address: MOCK_SENDER_PRIMARY, body: "Never mind, text is fine" });
        const { dispatchAiResponse } = await import("@/lib/ai-responder/dispatch");
        return dispatchAiResponse(...args);
      },
    });
    expect(r.items.map((i) => [i.inboundId, i.outcome])).toEqual([[id, "skipped:routing_v2:backfill_newer_inbound"]]);
    const [p] = await q("select needs_human_attention h from properties where id = $1", [lead.propertyId]);
    expect(p.h).toBe(false);
    expect(await n("select count(*)::int n from sms_classification_runs where source_inbound_message_id = $1", [id])).toBe(0);
  });

  it("crash after the atomic stop hold, before the stop's own effects: the resume finishes them (suppression)", async () => {
    const lead = await seedLead();
    await addToCanary(lead.propertyId);
    await parkOthers(lead.propertyId);
    await pg.query("update ai_responder_configs set routing_v2_flags = routing_v2_flags || '{\"model_stop_suppression\": true}'::jsonb where org_id = $1", [orgId]);
    try {
      const id = await sellerText(lead, "Please stop texting me now", 2, { asked_stop: 0.95 });
      setTestBarrier("dispatch:after_decision", async (ctx) => { if (ctx.inboundMessageId === id) throw new Error("crash after hold"); });
      let first;
      try { first = await run("apply", "bf-stop", { limit: 1 }); } finally { clearTestBarriers(); }
      expect(first.items.map((i) => i.error)).toEqual(["unexpected_error"]);
      const [held1] = await q("select needs_human_attention h, hold_inbound_message_id hi from properties where id = $1", [lead.propertyId]);
      expect(held1).toEqual({ h: true, hi: id });
      expect(await n("select count(*)::int n from sms_phone_suppressions where org_id = $1 and phone_e164 = $2", [orgId, lead.phone])).toBe(0);
      await pg.query("update ai_response_claims set lease_expires_at = now() - interval '1 minute' where inbound_message_id = $1 and status = 'processing'", [id]);
      // The lead is held (by this text's own decision): resume still selects and finishes it.
      const resumed = await run("apply", "bf-stop", { limit: 1 });
      expect(resumed.items.map((i) => [i.inboundId, i.error])).toEqual([[id, null]]);
      expect(await n("select count(*)::int n from sms_phone_suppressions where org_id = $1 and phone_e164 = $2", [orgId, lead.phone])).toBe(1);
      await settle();
      expect(sentTo(lead.phone)).toHaveLength(0);
    } finally {
      await pg.query("update ai_responder_configs set routing_v2_flags = routing_v2_flags || '{\"model_stop_suppression\": false}'::jsonb where org_id = $1", [orgId]);
    }
  });

  it("classify-only never borrows the live claim: a live run claiming mid-classification succeeds", async () => {
    const lead = await seedLead();
    await addToCanary(lead.propertyId);
    await parkOthers(lead.propertyId);
    const id = await sellerText(lead, "Text me the details", 1, { text_only: 0.95 });
    // A text the live path has not claimed yet (no legacy claim).
    await pg.query("delete from ai_response_claims where inbound_message_id = $1", [id]);
    let live: Awaited<ReturnType<typeof claimAiResponse>> | null = null;
    jevDuring["Text me the details"] = async () => {
      live = await claimAiResponse(supabase, { orgId, inboundMessageId: id, propertyId: lead.propertyId, contactId: lead.contactId, conversationId: null });
    };
    try {
      const r = await run("classify_only", "bf-own-claim", { limit: 1 });
      expect(r.items.map((i) => [i.inboundId, i.error])).toEqual([[id, null]]);
    } finally {
      delete jevDuring["Text me the details"];
    }
    expect(live).toMatchObject({ claimed: true });
    const [c] = await q("select status from ai_response_claims where inbound_message_id = $1 and response_kind = 'sms_ai_responder_v1'", [id]);
    expect(c.status).toBe("processing"); // the live run still owns it; classify-only never touched it
  });

  it("apply: a seller text that arrives WHILE Jev classifies wins (no hold, no drip pause, no cancel)", async () => {
    const lead = await seedLead();
    await addToCanary(lead.propertyId);
    await parkOthers(lead.propertyId);
    const id = await sellerText(lead, "Stop messaging me please", 2, { asked_stop: 0.95 });
    const { rows: seq } = await pg.query("insert into sequences(org_id,name,active) values($1,'Legacy drip 2',true) returning id", [orgId]);
    const { rows: enr } = await pg.query("insert into sequence_enrollments(org_id,sequence_id,property_id,contact_id,status) values($1,$2,$3,$4,'active') returning id", [orgId, seq[0].id, lead.propertyId, lead.contactId]);
    jevDuring["Stop messaging me please"] = async () => {
      await supabase.from("messages").insert({ org_id: orgId, channel: "sms", direction: "inbound", status: "received", property_id: lead.propertyId, contact_id: lead.contactId, from_address: lead.phone, to_address: MOCK_SENDER_PRIMARY, body: "Sorry, ignore that, I might sell" });
    };
    let r;
    try {
      r = await run("apply", "bf-midclass", { limit: 1 });
    } finally {
      delete jevDuring["Stop messaging me please"];
    }
    expect(r.items.map((i) => [i.inboundId, i.outcome])).toEqual([[id, "skipped:routing_v2:backfill_newer_inbound"]]);
    const [p] = await q("select needs_human_attention h from properties where id = $1", [lead.propertyId]);
    expect(p.h).toBe(false);
    const [e] = await q("select status from sequence_enrollments where id = $1", [enr[0].id]);
    expect(e.status).toBe("active");
    expect(await n("select count(*)::int n from routing_v2_outbox where property_id = $1 and status = 'cancelled'", [lead.propertyId])).toBe(0);
    expect(await n("select count(*)::int n from routing_v2_live_decisions where inbound_message_id = $1 and status in ('decided','failed')", [id])).toBe(0);
  });

  it("wrong-person reply sent, crash before the close, resume: no second text, the decision finishes", async () => {
    const lead = await seedLead();
    await addToCanary(lead.propertyId);
    await parkOthers(lead.propertyId);
    const id = await sellerText(lead, "Wrong person, I do not own that place", 3, { wrong_person: 0.95 });
    setTestBarrier("dispatch:before_wrong_person_close", async (ctx) => { if (ctx.inboundMessageId === id) throw new Error("crash before close"); });
    let first;
    try { first = await run("apply", "bf-wrong", { limit: 1 }); } finally { clearTestBarriers(); }
    expect(first.items.map((i) => i.error)).toEqual(["unexpected_error"]);
    expect(first.interruptedAfter).toBeGreaterThanOrEqual(1);
    await settle();
    expect(sentTo(lead.phone).map((m) => m.body)).toEqual([APPROVED_REPLY_TEXTS.wrong_number]);
    const [mid] = await q("select outreach_dispo d from properties where id = $1", [lead.propertyId]);
    expect(mid.d).toBeNull();
    await pg.query("update ai_response_claims set lease_expires_at = now() - interval '1 minute' where inbound_message_id = $1 and status = 'processing'", [id]);
    // Its own reply is not "answered by automation": the resume selects it and finishes.
    const resumed = await run("apply", "bf-wrong", { limit: 1 });
    expect(resumed.items.map((i) => [i.inboundId, i.error])).toEqual([[id, null]]);
    expect(resumed.interruptedBefore).toBeGreaterThanOrEqual(1);
    expect(resumed.interruptedAfter).toBe(resumed.interruptedBefore - 1);
    await settle();
    expect(sentTo(lead.phone)).toHaveLength(1); // never sent twice
    const [end] = await q("select outreach_dispo d, needs_human_attention h from properties where id = $1", [lead.propertyId]);
    // Finished: this property is closed as wrong number, not left to a person.
    expect(end).toEqual({ d: "wrong_number", h: false });
  });
});
