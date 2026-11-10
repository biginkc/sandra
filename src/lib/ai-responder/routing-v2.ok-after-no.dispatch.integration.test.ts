import { randomUUID } from "node:crypto";

import { Client } from "pg";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

import { createTestClient } from "@tests/integration/client";
import { BMH_ORG_ID, getCanonicalTestOrgId } from "@tests/integration/fixtures/multi-user";
import { MOCK_SENDER_PRIMARY, seedSenderCatalog } from "@tests/integration/delivery";
import { handleInboundWebhook } from "@/lib/messaging/inbound";
import { getMockMessageLog, MockMessagingProvider, resetMockState } from "@/lib/messaging/providers/mock";
import { assertLocalOnlyTestEnv } from "@/lib/testing/local-only-test-env";
import { V2_REPLY_TEXTS, v2ReplyText } from "@/lib/sms-classification/routing-v2/reply-texts";

import { runRoutingV2OutboxReplies } from "./dispatch";

/**
 * F5 (alert-noise-fixes 2026-11-10). Harness copied from routing-v2.dispatch.integration.test.ts.
 * Routing v2 cutover, end to end on a DISPOSABLE local stack (resets tenant tables):
 * dispatchAiResponse -> live v2 hook -> immutable decision -> one atomic transition ->
 * outbox -> consumer -> mock SMS provider. Faked Jev (no provider call), real database, real
 * send gates, real provider fence (routing_v2_check_authorized_outbox_send).
 *
 * Run: TEST_SUPABASE_DB_URL / TEST_SUPABASE_URL / LOCAL_* at a throwaway stack with every
 * routing v2 migration applied, then
 * `npx vitest run --config vitest.local-integration.config.ts <this file>`.
 */
// The property's own business-hours window. `openCalls` = stay open for that many more checks,
// then close (a window that closes between the outbox's prepare and the send).
const propertyWindow = vi.hoisted(() => ({ open: true, openCalls: null as number | null }));
vi.mock("@/lib/messaging/quiet-hours", async (importOriginal) => {
  const real = await importOriginal<typeof import("@/lib/messaging/quiet-hours")>();
  return {
  ...real,
  checkQuietHours: (state: string | null | undefined) => {
    // An unreadable state is never "open" (B-1): pass the real answer through.
    const actual = real.checkQuietHours(state);
    if (!actual.ok && actual.reason === "unknown_state") return actual;
    let open = propertyWindow.open;
    if (propertyWindow.openCalls !== null) {
      open = propertyWindow.openCalls > 0;
      propertyWindow.openCalls = Math.max(0, propertyWindow.openCalls - 1);
    }
    return open
      ? { ok: true, localTime: "12:00", zone: "America/Chicago" }
      : { ok: false, reason: "outside_window", localTime: "22:00", zone: "America/Chicago" };
  },
  // Keep the reply-delay clamp (delay.ts) on the same mocked clock as checkQuietHours: an open
  // window is local noon, so a reply's delay is not clamped to 0 when the suite runs at night.
  getQuietHoursLocalTime: (state: string | null | undefined, now?: Date) => {
    const actual = real.getQuietHoursLocalTime(state, now);
    if (!actual || !propertyWindow.open) return actual;
    return { ...actual, hour: 12, minute: 0, second: 0 };
  },
  };
});
const recipientWindow = vi.hoisted(() => ({ open: true }));
vi.mock("@/lib/messaging/quiet-hours-recipient", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/messaging/quiet-hours-recipient")>()),
  // A test can close the seller's window so a queued v2 reply waits in the outbox.
  checkRecipientQuietHours: () => recipientWindow.open
    ? { ok: true, state: "MO", localTime: "12:00", florida: false }
    : { ok: false, reason: "outside_window", state: "MO", localTime: "22:00" },
}));

// A-2 race analysis acceptance: RACE_SKEW_MS shifts the APP clock only (the DB keeps real time),
// as the stress harness did; every A-2 result must be the same at 0 and +/- 1 h.
const RACE_SKEW_MS = Number(process.env.RACE_SKEW_MS ?? 0);
if (RACE_SKEW_MS !== 0) {
  const RealDate = Date;
  class SkewedDate extends RealDate {
    constructor(...args: unknown[]) {
      if (args.length === 0) super(RealDate.now() + RACE_SKEW_MS);
      else super(...(args as [string]));
    }
    static now() { return RealDate.now() + RACE_SKEW_MS; }
  }
  globalThis.Date = SkewedDate as DateConstructor;
}

// The REAL webhook path: handleInboundWebhook starts the delay workflow; the workflow runtime is
// not available in vitest, so start() queues the real aiReplyDelayWorkflow body and runWorkflows()
// runs it in-process (sleep resolves at once). Nothing else about the path is faked.
const workflows = vi.hoisted(() => ({
  pending: [] as Array<{ fn: (p: unknown) => Promise<unknown>; params: unknown }>,
  /** When set, start() waits on it: a webhook held after its insert, before its delay stamp. */
  gate: null as Promise<void> | null,
}));
vi.mock("workflow/api", async (importOriginal) => ({
  ...(await importOriginal<typeof import("workflow/api")>()),
  start: async (fn: (p: unknown) => Promise<unknown>, args: unknown[]) => {
    if (workflows.gate) await workflows.gate;
    workflows.pending.push({ fn, params: args[0] });
    return { runId: `v2-webhook-${workflows.pending.length}` };
  },
}));
vi.mock("workflow", async (importOriginal) => ({
  ...(await importOriginal<typeof import("workflow")>()),
  sleep: async () => undefined,
}));

const supabase = createTestClient();
const pg = new Client({ connectionString: process.env.TEST_SUPABASE_DB_URL });
const realFetch = globalThis.fetch;
let jevProbabilities: Record<string, number> = {};
let haikuAnswer: { road: string; confidence: number } | null = null;
let jevByReply: Record<string, Record<string, number>> = {};
let jevGates: Record<string, { gate: Promise<void>; reached: () => void }> = {};
let jevCalls = 0;
/** The existing eight-answer classification (the number-source detector) says the seller asked. */
let numberAsked = false;

function installFakeJev() {
  globalThis.fetch = (async (input: Parameters<typeof fetch>[0], init?: Parameters<typeof fetch>[1]) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
    if (url.includes("api.anthropic.com")) {
      // Fake Haiku: a set answer, or a provider error (Haiku error road) when none is set.
      if (haikuAnswer === null) return new Response("{}", { status: 500 });
      return new Response(JSON.stringify({ content: [{ type: "text", text: JSON.stringify(haikuAnswer) }], usage: { input_tokens: 1, output_tokens: 1 } }), {
        status: 200, headers: { "content-type": "application/json" },
      });
    }
    if (!url.includes("api.typesafe.ai")) return realFetch(input, init);
    jevCalls++;
    const body = JSON.parse(String(init?.body)) as { questions: Record<string, unknown>; state?: { homeowner_reply?: string } };
    // Per-text answers (bursts): a reply listed in jevByReply uses its own probabilities.
    const own = body.state?.homeowner_reply !== undefined ? jevByReply[body.state.homeowner_reply] : undefined;
    // A test can hold one text's classification open (its dispatch is mid-flight).
    const held = body.state?.homeowner_reply !== undefined ? jevGates[body.state.homeowner_reply] : undefined;
    if (held) { held.reached(); await held.gate; }
    const probs = own ?? jevProbabilities;
    const answers: Record<string, unknown> = {};
    for (const id of Object.keys(body.questions)) {
      answers[id] = id === "property_type"
        ? { choice: "residential", probabilities: { residential: 0.9, lot: 0.02, commercial: 0.02, rental: 0.02, didnt_say: 0.04 } }
        : id === "asked_how_number_obtained"
          // The existing approved number-source question, asked in the same v2 call.
          ? { choice: numberAsked ? "yes" : "no", probabilities: numberAsked ? { yes: 0.95, no: 0.05 } : { yes: 0.05, no: 0.95 } }
          : { choice: "noul", noul: probs[id] ?? 0.02 };
    }
    return new Response(JSON.stringify({ answers, model: "jev-test", usage: { input_tokens: 1, output_tokens: 1 } }), {
      status: 200, headers: { "content-type": "application/json" },
    });
  }) as typeof fetch;
}

let orgId = "";
let phoneCounter = 0;

async function seedOrg(flags: Record<string, unknown>) {
  await supabase.from("ai_responder_configs").delete().eq("org_id", orgId);
  const { error } = await supabase.from("ai_responder_configs").insert({
    org_id: orgId, system_prompt: "test", business_hours_only: false,
    classifier_provider: "jev", classifier_mode: "automatic", classifier_engine: "nine_questions",
  });
  expect(error).toBeNull();
  await pg.query("update public.ai_responder_configs set routing_v2_flags = $2 where org_id = $1", [orgId, JSON.stringify(flags)]);
  // The approved text-only reply, mapped and approved the way the owner RPC does.
  await pg.query("begin");
  await pg.query("select set_config('sandra.template_approval', 'on', true)");
  const { rows } = await pg.query(
    "insert into public.sms_templates (org_id, name, content, approved_for_auto_send, approved_content, approved_at) values ($1, 'Auto reply v2: text only', $2, true, $2, now()) returning id",
    [orgId, V2_REPLY_TEXTS.text_only],
  );
  await pg.query("insert into public.auto_reply_templates (org_id, outcome, template_id) values ($1, 'text_only', $2)", [orgId, rows[0].id]);
  const { rows: ns } = await pg.query(
    "insert into public.sms_templates (org_id, name, content, approved_for_auto_send, approved_content, approved_at) values ($1, 'Auto reply v2: How did you get my number', $2, true, $2, now()) returning id",
    [orgId, V2_REPLY_TEXTS.number_source],
  );
  await pg.query("insert into public.auto_reply_templates (org_id, outcome, template_id) values ($1, 'number_source', $2)", [orgId, ns[0].id]);
  for (const [outcome, name] of [["not_interested", "Auto reply v2: Not interested"], ["where_located", "Auto reply v2: Where located"]] as const) {
    const { rows: t } = await pg.query(
      "insert into public.sms_templates (org_id, name, content, approved_for_auto_send, approved_content, approved_at) values ($1, $2, $3, true, $3, now()) returning id",
      [orgId, name, v2ReplyText(outcome)],
    );
    await pg.query("insert into public.auto_reply_templates (org_id, outcome, template_id) values ($1, $2, $3)", [orgId, outcome, t[0].id]);
  }
  await pg.query("commit");
}

async function seedLead() {
  const phone = `+1816756${String(5000 + phoneCounter++).padStart(4, "0")}`;
  const { data: contact } = await supabase.from("contacts").insert({ org_id: orgId, first_name: "Vee", last_name: "Two", phone_1: phone, phone_1_type: "mobile" }).select("id").single();
  await supabase.from("consent_events").insert({ contact_id: contact!.id, channel: "sms", event_type: "opt_in_marketing_written", source: "v2-test", org_id: orgId });
  const { data: property } = await supabase.from("properties")
    .insert({ org_id: orgId, address: "2 Vee Ln", state: "MO", status: "prospect", homeowner_contact_id: contact!.id }).select("id").single();
  return { propertyId: property!.id as string, contactId: contact!.id as string, phone };
}

const count = async (sql: string, args: unknown[]) => (await pg.query(sql, args)).rows[0].n as number;
const sentTo = (phone: string) => getMockMessageLog().filter((m) => m.to === phone);
/** Let the detached post-response consumer kick finish. */
const settle = async () => { for (let i = 0; i < 20; i++) await new Promise((r) => setTimeout(r, 100)); };

describe("F5: a bare ok after the approved not-interested reply, through the REAL webhook (disposable local stack)", () => {
  beforeAll(async () => {
    assertLocalOnlyTestEnv(process.env.TEST_SUPABASE_DB_URL, process.env.TEST_SUPABASE_URL);
    await pg.connect();
    process.env.TYPESAFE_API_KEY = "test-key";
    process.env.ANTHROPIC_API_KEY_SANDRA = "test-key";
    process.env.MESSAGING_PROVIDER = "mock";
    installFakeJev();
  });
  afterAll(async () => {
    globalThis.fetch = realFetch;
    await pg.end();
  });
  beforeEach(async () => {
    await pg.query("begin");
    await pg.query("set local session_replication_role = replica");
    await pg.query("delete from public.memberships where org_id = $1", [BMH_ORG_ID]);
    await pg.query("commit");
    const { error: resetError } = await supabase.rpc("reset_tenant_tables");
    expect(resetError).toBeNull();
    resetMockState();
    jevProbabilities = {};
    haikuAnswer = null;
    jevByReply = {};
    jevGates = {};
    propertyWindow.open = true;
    propertyWindow.openCalls = null;
    jevCalls = 0;
    numberAsked = false;
    const { error: orgError } = await supabase.from("organizations").upsert({ id: BMH_ORG_ID, name: "BMH (routing v2 test)" });
    expect(orgError).toBeNull();
    orgId = await getCanonicalTestOrgId(supabase);
    await seedSenderCatalog(supabase, orgId, [MOCK_SENDER_PRIMARY]);
  });

  async function seedV2Drips() {
    await pg.query("begin");
    await pg.query("select set_config('routing_v2.allow_drip_edit', 'on', true)");
    for (const [key, name] of [["book_appointment", "Book appointment (routing v2)"], ["not_interested", "Not interested (routing v2)"]]) {
      const { rows } = await pg.query("insert into sequences(org_id,name,active,routing_v2_key,routing_v2_version) values($1,$2,false,$3,1) returning id", [orgId, name, key]);
      await pg.query("insert into sequence_steps(sequence_id,step_index,delay_after_previous_minutes,action_type,template_body) values($1,0,129600,'send_sms',$2),($1,1,1440,'send_sms',$3)", [rows[0].id, `${key} one`, `${key} two`]);
    }
    await pg.query("commit");
  }
  const enrollments = async (propertyId: string) => (await pg.query(
    "select s.routing_v2_key k, e.status, coalesce(e.ended_reason, e.pause_reason) r, e.next_run_at > now() future from sequence_enrollments e join sequences s on s.id = e.sequence_id where e.property_id = $1 order by e.enrolled_at, e.id", [propertyId])).rows;
  async function runWorkflows() {
    for (let guard = 0; workflows.pending.length && guard < 20; guard++) {
      const w = workflows.pending.shift()!;
      await w.fn(w.params);
    }
    await settle();
  }
  const deliver = async () => { await runRoutingV2OutboxReplies(supabase, { limit: 20 }); await settle(); await runRoutingV2OutboxReplies(supabase, { limit: 20 }); };
  async function say(lead: Awaited<ReturnType<typeof seedLead>>, body: string, externalId = `v2-f5-${randomUUID()}`) {
    const res = await handleInboundWebhook(new Request("https://v2.test/webhooks/mock", {
      method: "POST",
      headers: { "content-type": "application/json", "x-mock-signature": "valid" },
      body: JSON.stringify({ externalId, from: lead.phone, to: MOCK_SENDER_PRIMARY, body }),
    }), { includeFullUrl: false, provider: new MockMessagingProvider() });
    expect(res.status).toBe(200);
    const { rows: [m] } = await pg.query("select id from messages where property_id = $1 and direction = 'inbound' order by created_at desc limit 1", [lead.propertyId]);
    return m.id as string;
  }
  async function setup() {
    workflows.pending.length = 0;
    workflows.gate = null;
    recipientWindow.open = true;
    const lead = await seedLead();
    await seedOrg({ questions_live: true, replies: true, drips: true, canary_property_ids: [lead.propertyId] });
    await pg.query("update ai_responder_configs set reply_delay_min_seconds = 30, reply_delay_max_seconds = 60 where org_id = $1", [orgId]);
    await seedV2Drips();
    await supabase.from("messages").insert({ org_id: orgId, channel: "sms", direction: "outbound", status: "delivered", property_id: lead.propertyId, contact_id: lead.contactId, from_address: MOCK_SENDER_PRIMARY, to_address: lead.phone, body: "Hi, would you sell 2 Vee Ln?", created_at: new Date(Date.now() - 3600_000).toISOString() });
    return lead;
  }
  /** A first "no": the approved not-interested reply goes out and the Not interested drip starts. */
  async function firstNo(lead: Awaited<ReturnType<typeof seedLead>>) {
    jevProbabilities = { not_interested: 0.95 };
    await say(lead, "not interested");
    await runWorkflows();
    await deliver();
    const { rows: [last] } = await pg.query("select body from messages where property_id = $1 and direction = 'outbound' order by created_at desc limit 1", [lead.propertyId]);
    expect(last.body.trim()).toBe(v2ReplyText("not_interested"));
    expect(await enrollments(lead.propertyId)).toMatchObject([{ k: "not_interested", status: "active" }]);
  }

  it("\"Ok\" right after the not-interested reply: kept on Not interested, nothing sent, no alert, no hold; audit shows Jev row 19", async () => {
    const lead = await setup();
    await firstNo(lead);
    const sentBefore = sentTo(lead.phone).length;
    jevProbabilities = { just_ok: 0.95 };
    const externalId = `v2-f5-${randomUUID()}`;
    const ok = await say(lead, "Ok", externalId);
    await runWorkflows();
    await deliver();

    const rows = await enrollments(lead.propertyId);
    expect(rows.filter((e) => e.status === "active")).toEqual([{ k: "not_interested", status: "active", r: null, future: true }]);
    expect(rows.filter((e) => e.status === "paused")).toEqual([]);
    expect(rows.some((e) => e.k === "book_appointment")).toBe(false);
    expect(await count("select count(*)::int n from routing_v2_outbox where inbound_message_id = $1", [ok])).toBe(0);
    expect(sentTo(lead.phone)).toHaveLength(sentBefore);
    expect((await pg.query("select needs_human_attention from properties where id = $1", [lead.propertyId])).rows[0].needs_human_attention).toBe(false);
    const { rows: [decision] } = await pg.query("select road, jev_road, provenance, action from routing_v2_live_decisions where inbound_message_id = $1", [ok]);
    expect(decision).toMatchObject({
      road: "not_interested_drip", jev_road: "book_appointment",
      provenance: { by: "jev", row: "19", signal: "just_ok" },
      action: { road: "not_interested_drip", steps: [{ kind: "drip", drip: "Not interested" }] },
    });

    // Replaying the same inbound (provider retry) changes nothing.
    const snapshot = { rows: await enrollments(lead.propertyId), outbox: await count("select count(*)::int n from routing_v2_outbox where property_id = $1", [lead.propertyId]) };
    await handleInboundWebhook(new Request("https://v2.test/webhooks/mock", {
      method: "POST",
      headers: { "content-type": "application/json", "x-mock-signature": "valid" },
      body: JSON.stringify({ externalId, from: lead.phone, to: MOCK_SENDER_PRIMARY, body: "Ok" }),
    }), { includeFullUrl: false, provider: new MockMessagingProvider() });
    await runWorkflows();
    await deliver();
    expect({ rows: await enrollments(lead.propertyId), outbox: await count("select count(*)::int n from routing_v2_outbox where property_id = $1", [lead.propertyId]) }).toEqual(snapshot);
    expect(sentTo(lead.phone)).toHaveLength(sentBefore);
    expect(await count("select count(*)::int n from routing_v2_live_decisions where inbound_message_id = $1", [ok])).toBe(1);
  });

  it("\"Ok\" after any other text still books (today's row 19 behaviour)", async () => {
    const lead = await setup();
    jevProbabilities = { just_ok: 0.95 };
    const ok = await say(lead, "Ok");
    await runWorkflows();
    const { rows: [decision] } = await pg.query("select road, jev_road from routing_v2_live_decisions where inbound_message_id = $1", [ok]);
    expect(decision).toMatchObject({ road: "book_appointment", jev_road: "book_appointment" });
  });
});
