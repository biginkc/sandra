import { Client } from "pg";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

import { createTestClient } from "@tests/integration/client";
import { BMH_ORG_ID, getCanonicalTestOrgId } from "@tests/integration/fixtures/multi-user";
import { MOCK_SENDER_PRIMARY, seedSenderCatalog } from "@tests/integration/delivery";
import type { AnthropicLike } from "@/lib/ai-responder/generate";
import { getMockMessageLog, resetMockState } from "@/lib/messaging/providers/mock";
import { V2_REPLY_TEXTS } from "@/lib/sms-classification/routing-v2/reply-texts";
import { assertLocalOnlyTestEnv } from "@/lib/testing/local-only-test-env";

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
let jevByReply: Record<string, Record<string, number>> = {};
let jevCalls = 0;

function installFakeJev() {
  globalThis.fetch = (async (input: Parameters<typeof fetch>[0], init?: Parameters<typeof fetch>[1]) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
    if (url.includes("api.anthropic.com")) throw new Error("no live Haiku in tests");
    if (!url.includes("api.typesafe.ai")) return realFetch(input, init);
    jevCalls++;
    const body = JSON.parse(String(init?.body)) as { questions: Record<string, unknown>; state?: { homeowner_reply?: string } };
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
    .insert({ org_id: orgId, address: `${phoneN} Backfill Ln`, state: "MO", status: "prospect", homeowner_contact_id: contact!.id }).select("id").single();
  const lead = { propertyId: property!.id as string, contactId: contact!.id as string, phone };
  leads.push(lead);
  return lead;
}

const daysAgo = (d: number) => new Date(Date.now() - d * 86_400_000).toISOString();

/** Our opener, then the seller's text `days` ago (with a completed legacy claim, as the old engine left it). */
async function sellerText(lead: Awaited<ReturnType<typeof seedLead>>, body: string, days: number, jev: Record<string, number> = {}) {
  await supabase.from("messages").insert({ org_id: orgId, channel: "sms", direction: "outbound", status: "delivered", property_id: lead.propertyId, contact_id: lead.contactId, from_address: MOCK_SENDER_PRIMARY, to_address: lead.phone, body: "Hi, would you sell?", created_at: daysAgo(days + 1), metadata: { generated_by: "sequence_tick" } });
  const { data, error } = await supabase.from("messages")
    .insert({ org_id: orgId, channel: "sms", direction: "inbound", status: "received", property_id: lead.propertyId, contact_id: lead.contactId, from_address: lead.phone, to_address: MOCK_SENDER_PRIMARY, body, created_at: daysAgo(days) })
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
const run = (mode: BackfillMode, runId: string, extra: Record<string, unknown> = {}) =>
  runBackfill(supabase, { orgId, mode, runId, ratePerMinute: 6000, ...extra }, { anthropic: NO_ANTHROPIC, sleep: async () => undefined });
const settle = async () => { for (let i = 0; i < 10; i++) await new Promise((r) => setTimeout(r, 100)); };

describe("routing v2 backfill (disposable local stack, mock provider, stubbed Jev)", () => {
  let fresh: Awaited<ReturnType<typeof seedLead>>, freshId = "";
  let owner: Awaited<ReturnType<typeof seedLead>>, ownerId = "";
  let oldYes: Awaited<ReturnType<typeof seedLead>>, oldYesId = "";
  let oldWrong: Awaited<ReturnType<typeof seedLead>>, oldWrongId = "";
  let twoTexts: Awaited<ReturnType<typeof seedLead>>, olderId = "", newerId = "";
  let held: Awaited<ReturnType<typeof seedLead>>, answered: Awaited<ReturnType<typeof seedLead>>;
  let tagged: Awaited<ReturnType<typeof seedLead>>, takeover: Awaited<ReturnType<typeof seedLead>>;

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

    fresh = await seedLead();
    owner = await seedLead();
    oldYes = await seedLead();
    oldWrong = await seedLead();
    twoTexts = await seedLead();
    held = await seedLead();
    answered = await seedLead();
    tagged = await seedLead();
    takeover = await seedLead();
    await seedOrg({ questions_live: true, replies: true, drips: true, canary_property_ids: leads.map((l) => l.propertyId) });

    freshId = await sellerText(fresh, "Text only please", 3, { text_only: 0.95 });
    ownerId = await sellerText(owner, "Yes I own it", 10, { confirmed_owner: 0.95 });
    oldYesId = await sellerText(oldYes, "Okay", 30, { just_ok: 0.95 });
    oldWrongId = await sellerText(oldWrong, "Wrong number, not my house", 20, { wrong_person: 0.95 });
    olderId = await sellerText(twoTexts, "Who is this", 9, { asked_who: 0.95 });
    newerId = await sellerText(twoTexts, "Text only. I can't talk", 2, { text_only: 0.95 });
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

  it("dry-run: counts the candidate set, writes nothing", async () => {
    const before = await n("select count(*)::int n from messages where metadata ? 'routingV2Backfill' and org_id = $1", [orgId]);
    const r = await run("dry_run", "bf-dry-1");
    expect(r.selection.candidates.map((c) => c.id).sort()).toEqual([freshId, ownerId, oldYesId, oldWrongId, newerId].sort());
    expect(r.selection.superseded.map((s) => s.inboundId)).toEqual([olderId]);
    const reasons = Object.fromEntries(r.selection.skipped.map((s) => [s.propertyId, s.reason]));
    expect(reasons).toMatchObject({
      [held.propertyId]: "needs_human_attention", [answered.propertyId]: "answered_by_human",
      [tagged.propertyId]: "test_tagged", [takeover.propertyId]: "human_takeover_after_inbound",
    });
    expect(jevCalls).toBe(0);
    expect(await n("select count(*)::int n from messages where metadata ? 'routingV2Backfill' and org_id = $1", [orgId])).toBe(before);
    // Scoped to this test's leads: other suites on the same disposable stack may leave rows.
    expect(await n("select count(*)::int n from routing_v2_live_decisions where property_id = any($1::uuid[])", [leads.map((l) => l.propertyId)])).toBe(0);
    expect(markdownReport("sha-test", r).split("\n")[0]).toBe("SHA: sha-test");
  });

  it("classify-only: decisions recorded, nothing sent / enrolled / alerted / held", async () => {
    const r = await run("classify_only", "bf-cls-1");
    expect(r.items.map((i) => i.error)).toEqual(r.items.map(() => null));
    expect(jevCalls).toBe(5);
    const roads = Object.fromEntries(r.items.map((i) => [i.inboundId, [i.treatment, i.road]]));
    expect(roads).toEqual({
      [freshId]: ["full", "text_only_reply"], [newerId]: ["full", "text_only_reply"], [ownerId]: ["full", "confirmed_owner_drip"],
      [oldYesId]: ["sort_only", "book_appointment"], [oldWrongId]: ["sort_only", "wrong_number_close"],
    });
    const yes = r.items.find((i) => i.inboundId === oldYesId)!;
    expect(yes).toMatchObject({ wouldReply: false, wouldDrip: false, wouldAlert: true, wouldHold: true });
    expect(r.items.find((i) => i.inboundId === freshId)).toMatchObject({ wouldReply: true, wouldDrip: false });
    await settle();
    const mine = [leads.map((l) => l.propertyId)];
    expect(await n("select count(*)::int n from routing_v2_outbox where property_id = any($1::uuid[])", mine)).toBe(0);
    expect(await n("select count(*)::int n from routing_v2_reply_transitions where property_id = any($1::uuid[])", mine)).toBe(0);
    expect(await n("select count(*)::int n from sequence_enrollments where routing_v2_engine = 'v2' and property_id = any($1::uuid[])", mine)).toBe(0);
    expect(await n("select count(*)::int n from properties where needs_human_attention and id <> $1 and id = any($2::uuid[])", [held.propertyId, leads.map((l) => l.propertyId)])).toBe(0);
    expect(getMockMessageLog()).toHaveLength(0);
    // The legacy claim was moved aside (kept, reversible) and the marker names the run.
    expect(await n("select count(*)::int n from ai_response_claims where response_kind = 'sms_ai_responder_v1:backfill_prior:bf-cls-1'")).toBe(5);
    const [m] = await q("select metadata->'routingV2Backfill'->'classify'->>'runId' r from messages where id = $1", [freshId]);
    expect(m.r).toBe("bf-cls-1");
    // Spend ledger: one Jev row per text.
    expect(await n("select count(*)::int n from provider_spend_ledger where provider = 'jev' and property_id = any($1::uuid[])", [leads.map((l) => l.propertyId)])).toBe(5);
    // Resume of classify-only: nothing re-classified.
    const again = await run("classify_only", "bf-cls-1");
    expect(again.dispatched).toEqual([]);
    expect(jevCalls).toBe(5);
  });

  it("apply: full treatment <= 14 days, sort-only older, from the stored decisions (no second Jev call)", async () => {
    const r = await run("apply", "bf-apl-1");
    expect(r.items.map((i) => [i.inboundId, i.error])).toEqual(r.items.map((i) => [i.inboundId, null]));
    expect(jevCalls).toBe(5);
    await settle();
    // Full: the approved text-only reply, once each, keyed by the outbox row.
    expect(sentTo(fresh.phone).map((m) => m.body)).toEqual([V2_REPLY_TEXTS.text_only]);
    expect(sentTo(twoTexts.phone).map((m) => m.body)).toEqual([V2_REPLY_TEXTS.text_only]);
    // Full: the confirmed-owner drip started, no reply.
    expect(await n("select count(*)::int n from sequence_enrollments e join sequences s on s.id = e.sequence_id where e.property_id = $1 and s.routing_v2_key = 'confirmed_owner' and e.status = 'active'", [owner.propertyId])).toBe(1);
    expect(sentTo(owner.phone)).toHaveLength(0);
    // Sort-only hot road: owner alert queued + held for a person; NO reply, NO drip.
    expect(sentTo(oldYes.phone)).toHaveLength(0);
    expect(await n("select count(*)::int n from routing_v2_outbox where property_id = $1 and kind = 'reply'", [oldYes.propertyId])).toBe(0);
    expect(await n("select count(*)::int n from routing_v2_outbox where property_id = $1 and kind = 'alert'", [oldYes.propertyId])).toBeGreaterThanOrEqual(1);
    expect(await n("select count(*)::int n from sequence_enrollments where property_id = $1", [oldYes.propertyId])).toBe(0);
    const [yesProp] = await q("select needs_human_attention h from properties where id = $1", [oldYes.propertyId]);
    expect(yesProp.h).toBe(true);
    // Sort-only wrong person: this property closed (wrong_number), no reply to the seller.
    expect(sentTo(oldWrong.phone)).toHaveLength(0);
    const [wrongProp] = await q("select outreach_dispo d from properties where id = $1", [oldWrong.propertyId]);
    expect(wrongProp.d).toBe("wrong_number");
    // Newest wins: the older text is superseded in the audit, never routed.
    const [audit] = await q("select status, failure_reason from routing_v2_live_decisions where inbound_message_id = $1", [olderId]);
    expect(audit).toEqual({ status: "not_routed", failure_reason: "backfill_superseded:bf-apl-1" });
    expect(sentTo(twoTexts.phone).map((m) => m.body)).not.toContain(expect.stringContaining("Mel with BMH"));
    // Skipped leads untouched.
    for (const l of [held, answered, tagged, takeover]) expect(sentTo(l.phone)).toHaveLength(0);
    expect(r.items.find((i) => i.inboundId === oldYesId)).toMatchObject({ treatment: "sort_only", holdCreated: true, repliesQueued: 0, dripsStarted: 0 });
    expect(r.items.find((i) => i.inboundId === freshId)).toMatchObject({ treatment: "full", repliesQueued: 1 });
    const md = markdownReport("sha-test", r);
    expect(md).toContain("## Full treatment");
    expect(md).toContain("## Sort only");
    expect(md).not.toMatch(/\+1816/);
  });

  it("resume / re-run of apply is idempotent: nothing selected, nothing sent again", async () => {
    const before = getMockMessageLog().length;
    const again = await run("apply", "bf-apl-2");
    expect(again.dispatched).toEqual([]);
    expect(again.selection.skipped.filter((s) => [freshId, ownerId, oldYesId, oldWrongId, newerId].includes(s.inboundId)).map((s) => s.reason))
      .toEqual(expect.arrayContaining(["already_backfilled"]));
    await settle();
    expect(getMockMessageLog().length).toBe(before);
    expect(jevCalls).toBe(5);
  });
});
