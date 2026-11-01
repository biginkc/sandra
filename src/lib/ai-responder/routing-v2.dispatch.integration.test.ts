import { randomUUID } from "node:crypto";

import { Client } from "pg";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

import { createTestClient } from "@tests/integration/client";
import { BMH_ORG_ID, getCanonicalTestOrgId } from "@tests/integration/fixtures/multi-user";
import { MOCK_SENDER_PRIMARY, seedSenderCatalog } from "@tests/integration/delivery";
import { handleInboundWebhook } from "@/lib/messaging/inbound";
import { getMockMessageLog, MockMessagingProvider, resetMockState } from "@/lib/messaging/providers/mock";
import { assertLocalOnlyTestEnv } from "@/lib/testing/local-only-test-env";
import { clearTestBarriers, setTestBarrier, setTestFault, type TestBarrierContext, type TestBarrierName } from "@/lib/testing/test-barriers";
import { V2_REPLY_TEXTS, v2ReplyText } from "@/lib/sms-classification/routing-v2/reply-texts";
import type { Json } from "@/lib/supabase/types";

import { APPROVED_REPLY_TEXTS } from "./approved-reply-texts";
import { dispatchAiResponse, runRoutingV2OutboxReplies, sweepUnstampedV2Inbounds } from "./dispatch";
import type { AnthropicLike } from "./generate";

/**
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
/** Natural (no-barrier) repeats per volume case. */
const RACE_REPEAT = Number(process.env.RACE_REPEAT ?? 3);
/** Repeats of every barrier-forced order (fresh lead each time). */
const FORCED_REPEAT = Number(process.env.FORCED_REPEAT ?? 1);

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

const NO_ANTHROPIC: AnthropicLike = {
  messages: { create: async () => { throw new Error("Claude must not be called"); } } as unknown as AnthropicLike["messages"],
};

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

async function inbound(lead: Awaited<ReturnType<typeof seedLead>>, body: string) {
  await supabase.from("messages").insert({ org_id: orgId, channel: "sms", direction: "outbound", status: "delivered", property_id: lead.propertyId, contact_id: lead.contactId, from_address: MOCK_SENDER_PRIMARY, to_address: lead.phone, body: "Hi, would you sell 2 Vee Ln?", created_at: new Date(Date.now() - 3600_000).toISOString() });
  const { data, error } = await supabase.from("messages")
    .insert({ org_id: orgId, channel: "sms", direction: "inbound", status: "received", property_id: lead.propertyId, contact_id: lead.contactId, from_address: lead.phone, to_address: MOCK_SENDER_PRIMARY, body })
    .select("id, conversation_id").single();
  expect(error).toBeNull();
  return {
    propertyId: lead.propertyId, contactId: lead.contactId, conversationId: data!.conversation_id as string,
    inboundMessageId: data!.id as string, inboundBody: body, inboundFromPhone: lead.phone, inboundToPhone: MOCK_SENDER_PRIMARY,
  };
}

const count = async (sql: string, args: unknown[]) => (await pg.query(sql, args)).rows[0].n as number;
const sentTo = (phone: string) => getMockMessageLog().filter((m) => m.to === phone);
/** Let the detached post-response consumer kick finish. */
const settle = async () => { for (let i = 0; i < 20; i++) await new Promise((r) => setTimeout(r, 100)); };

describe("routing v2 cutover through dispatchAiResponse (disposable local stack)", () => {
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

  it("flags off: today's nine-question engine runs; no v2 evidence, transition or outbox row", async () => {
    await seedOrg({});
    const lead = await seedLead();
    const input = await inbound(lead, "Text only please");
    jevProbabilities = { text_only: 0.95 };
    await dispatchAiResponse(supabase, input, { anthropic: NO_ANTHROPIC });
    await settle();
    expect(await count("select count(*)::int n from routing_v2_live_decisions where inbound_message_id = $1", [input.inboundMessageId])).toBe(0);
    expect(await count("select count(*)::int n from routing_v2_outbox where property_id = $1", [lead.propertyId])).toBe(0);
  });

  it("eligible: one decision, one transition, the approved reply sent exactly once keyed by the outbox id", async () => {
    const lead = await seedLead();
    await seedOrg({ questions_live: true, replies: true, drips: true, canary_property_ids: [lead.propertyId] });
    const input = await inbound(lead, "Text only please, I can't talk");
    jevProbabilities = { text_only: 0.95 };
    const outcome = await dispatchAiResponse(supabase, input, { anthropic: NO_ANTHROPIC });
    expect(outcome).toEqual({ outcome: "auto_closed", reason: "routing_v2:text_only_reply" });
    // ONE Jev call: the v2 set with the existing number-source question; no eight-answer run.
    expect(jevCalls).toBe(1);
    expect(await count("select count(*)::int n from sms_classification_runs where source_inbound_message_id = $1", [input.inboundMessageId])).toBe(0);
    // The detached kick and an explicit consumer pass race for the same row: one wins the claim.
    await Promise.all([runRoutingV2OutboxReplies(supabase, { limit: 5 }), runRoutingV2OutboxReplies(supabase, { propertyId: lead.propertyId })]);
    await settle();
    await runRoutingV2OutboxReplies(supabase, { limit: 5 });
    expect(sentTo(lead.phone).map((m) => m.body)).toEqual([V2_REPLY_TEXTS.text_only]);
    const { rows: [box] } = await pg.query("select id, status, provider_receipt from routing_v2_outbox where property_id = $1 and kind = 'reply'", [lead.propertyId]);
    expect(box.status).toBe("sent");
    const { rows: [msg] } = await pg.query("select id, idempotency_key from messages where property_id = $1 and direction = 'outbound' and body = $2", [lead.propertyId, V2_REPLY_TEXTS.text_only]);
    expect(msg.idempotency_key).toBe(box.id);
    expect(box.provider_receipt).toBe(msg.id);
    expect(await count("select count(*)::int n from routing_v2_live_decisions where inbound_message_id = $1 and status = 'decided' and road = 'text_only_reply'", [input.inboundMessageId])).toBe(1);
    expect(await count("select count(*)::int n from routing_v2_reply_transitions where inbound_message_id = $1 and outcome in ('applied','replies_only')", [input.inboundMessageId])).toBe(1);

    // A duplicate webhook / retry of the same inbound never sends again.
    await dispatchAiResponse(supabase, input, { anthropic: NO_ANTHROPIC });
    await settle();
    await runRoutingV2OutboxReplies(supabase, { limit: 5 });
    expect(sentTo(lead.phone)).toHaveLength(1);
    expect(await count("select count(*)::int n from routing_v2_live_decisions where inbound_message_id = $1", [input.inboundMessageId])).toBe(1);
  });

  it("\"how did you get my number\" (existing approved question, same Jev call): the approved number_source reply replaces the road's reply", async () => {
    const lead = await seedLead();
    await seedOrg({ questions_live: true, replies: true, drips: true, canary_property_ids: [lead.propertyId] });
    const input = await inbound(lead, "Text only. How did you get my number?");
    jevProbabilities = { text_only: 0.95 };
    numberAsked = true;
    await dispatchAiResponse(supabase, input, { anthropic: NO_ANTHROPIC });
    await settle();
    await runRoutingV2OutboxReplies(supabase, { limit: 5 });
    expect(sentTo(lead.phone).map((m) => m.body)).toEqual([V2_REPLY_TEXTS.number_source]);
  });

  it("a slice switched off before delivery: nothing sent, the inbound goes back to a person", async () => {
    const lead = await seedLead();
    await seedOrg({ questions_live: true, replies: true, drips: true, canary_property_ids: [lead.propertyId] });
    const input = await inbound(lead, "text only");
    jevProbabilities = { text_only: 0.95 };
    // Flip replies off right after the transition commits.
    const outcome = await dispatchAiResponse(supabase, input, { anthropic: NO_ANTHROPIC });
    await pg.query("update public.ai_responder_configs set routing_v2_flags = routing_v2_flags || '{\"replies\": false}'::jsonb where org_id = $1", [orgId]);
    await settle();
    await runRoutingV2OutboxReplies(supabase, { limit: 5 });
    expect(outcome.outcome).toBe("auto_closed");
    const { rows: [box] } = await pg.query("select status, cancel_reason from routing_v2_outbox where property_id = $1 and kind = 'reply'", [lead.propertyId]);
    // The detached kick may have delivered before the flip; if not, the flip refused it.
    if (box.status === "sent") {
      expect(sentTo(lead.phone)).toHaveLength(1);
    } else {
      // Refused before the claim (reply preparation reads the fresh flags) or at the claim.
      expect(box.status).toBe("cancelled");
      expect(box.cancel_reason).toMatch(/flag_off$/);
      expect(sentTo(lead.phone)).toHaveLength(0);
      const { rows: [prop] } = await pg.query("select needs_human_attention from properties where id = $1", [lead.propertyId]);
      expect(prop.needs_human_attention).toBe(true);
    }
  });

  it("a newer seller text before delivery cancels the older auto reply (latest wins)", async () => {
    const lead = await seedLead();
    await seedOrg({ questions_live: true, replies: true, drips: true, canary_property_ids: [lead.propertyId] });
    const first = await inbound(lead, "text only");
    jevProbabilities = { text_only: 0.95 };
    await dispatchAiResponse(supabase, first, { anthropic: NO_ANTHROPIC });
    // A newer text lands before (or while) the first reply is delivered.
    await supabase.from("messages").insert({ org_id: orgId, channel: "sms", direction: "inbound", status: "received", property_id: lead.propertyId, contact_id: lead.contactId, from_address: lead.phone, to_address: MOCK_SENDER_PRIMARY, body: "actually call me" });
    await settle();
    await runRoutingV2OutboxReplies(supabase, { limit: 5 });
    const { rows: [box] } = await pg.query("select status, cancel_reason from routing_v2_outbox where property_id = $1 and kind = 'reply'", [lead.propertyId]);
    if (box.status === "sent") {
      // Delivered before the newer text existed (the detached kick won): exactly once.
      expect(sentTo(lead.phone)).toHaveLength(1);
    } else {
      expect(box.status).toBe("cancelled");
      expect(sentTo(lead.phone)).toHaveLength(0);
    }
  });

  describe("§5.4 final send boundary (test-run taint)", () => {
    const tagLead = (propertyId: string) => pg.query("update properties set test_run_id = 'stress-run-1' where id = $1", [propertyId]);
    afterAll(() => { delete process.env.TEST_DEST_ALLOWLIST; });

    it("a test-tagged lead to a non-owned number: refused at the boundary, zero provider calls, recorded", async () => {
      const lead = await seedLead();
      await tagLead(lead.propertyId);
      process.env.TEST_DEST_ALLOWLIST = "+18165550142";
      await seedOrg({ questions_live: true, replies: true, drips: true, canary_property_ids: [lead.propertyId] });
      const input = await inbound(lead, "text only");
      jevProbabilities = { text_only: 0.95 };
      await dispatchAiResponse(supabase, input, { anthropic: NO_ANTHROPIC });
      await settle();
      await runRoutingV2OutboxReplies(supabase, { limit: 5 });
      // Terminal: a second (and third) consumer pass never retries it.
      await runRoutingV2OutboxReplies(supabase, { limit: 5 });
      await runRoutingV2OutboxReplies(supabase, { limit: 5 });
      expect(sentTo(lead.phone)).toHaveLength(0);
      const { rows: [box] } = await pg.query("select test_run_id, status, cancel_reason from routing_v2_outbox where property_id = $1 and kind = 'reply'", [lead.propertyId]);
      expect(box.test_run_id).toBe("stress-run-1"); // taint reached the outbox row
      expect(box).toMatchObject({ status: "cancelled", cancel_reason: "not_sent:test_send_refused" });
      const { rows: refusals } = await pg.query("select reason, destination_last4 from test_send_refusals where property_id = $1", [lead.propertyId]);
      expect(refusals).toEqual([{ reason: "refused_non_owned", destination_last4: lead.phone.slice(-4) }]);
      // One refused message row (never re-created by a retry), never sent.
      expect(await count("select count(*)::int n from messages where property_id = $1 and direction = 'outbound' and body = $2 and status = 'failed'", [lead.propertyId, V2_REPLY_TEXTS.text_only])).toBe(1);
      expect(await count("select count(*)::int n from messages where property_id = $1 and direction = 'outbound' and body = $2", [lead.propertyId, V2_REPLY_TEXTS.text_only])).toBe(1);
    });

    it("the outbox row's own tag lost by a bug: the lead's tag still refuses it", async () => {
      const lead = await seedLead();
      process.env.TEST_DEST_ALLOWLIST = "+18165550142";
      await seedOrg({ questions_live: true, replies: true, drips: true, canary_property_ids: [lead.propertyId] });
      const input = await inbound(lead, "text only");
      jevProbabilities = { text_only: 0.95 };
      // Hold delivery back until the tag is in place: no detached delivery before it.
      await tagLead(lead.propertyId);
      await pg.query("alter table routing_v2_outbox disable trigger trg_routing_v2_outbox_inherit_test_run");
      try {
        await dispatchAiResponse(supabase, input, { anthropic: NO_ANTHROPIC });
      } finally {
        await pg.query("alter table routing_v2_outbox enable trigger trg_routing_v2_outbox_inherit_test_run");
      }
      await settle();
      await runRoutingV2OutboxReplies(supabase, { limit: 5 });
      const { rows: [box] } = await pg.query("select test_run_id from routing_v2_outbox where property_id = $1 and kind = 'reply'", [lead.propertyId]);
      expect(box.test_run_id).toBeNull();
      expect(sentTo(lead.phone)).toHaveLength(0);
    });

    it("a test-tagged lead on an allowlisted (owned) number in any format: sent once", async () => {
      const lead = await seedLead();
      await tagLead(lead.propertyId);
      const d = lead.phone.replace(/\D/g, "").slice(-10);
      process.env.TEST_DEST_ALLOWLIST = `(${d.slice(0, 3)}) ${d.slice(3, 6)}-${d.slice(6)}`;
      await seedOrg({ questions_live: true, replies: true, drips: true, canary_property_ids: [lead.propertyId] });
      const input = await inbound(lead, "text only");
      jevProbabilities = { text_only: 0.95 };
      await dispatchAiResponse(supabase, input, { anthropic: NO_ANTHROPIC });
      await settle();
      await runRoutingV2OutboxReplies(supabase, { limit: 5 });
      expect(sentTo(lead.phone).map((m) => m.body)).toEqual([V2_REPLY_TEXTS.text_only]);
      expect(await count("select count(*)::int n from test_send_refusals where property_id = $1", [lead.propertyId])).toBe(0);
    });
  });

  describe("stress A-2: every reply stops the current drip and the newest reply wins", () => {
    /** v2 drips for this org (seeded the way a migration does; v2 drips are migration-edited only). */
    async function seedV2Drips() {
      await pg.query("begin");
      await pg.query("select set_config('routing_v2.allow_drip_edit', 'on', true)");
      for (const [key, name] of [["book_appointment", "Book appointment (routing v2)"], ["confirmed_owner", "Confirmed owner (routing v2)"]]) {
        const { rows } = await pg.query("insert into sequences(org_id,name,active,routing_v2_key,routing_v2_version) values($1,$2,false,$3,1) returning id", [orgId, name, key]);
        await pg.query("insert into sequence_steps(sequence_id,step_index,delay_after_previous_minutes,action_type,template_body) values($1,0,1440,'send_sms',$2),($1,1,1440,'send_sms',$3)", [rows[0].id, `${key} one`, `${key} two`]);
      }
      await pg.query("commit");
    }
    const enrollments = async (propertyId: string) => (await pg.query(
      "select s.routing_v2_key k, e.status, e.ended_reason r from sequence_enrollments e join sequences s on s.id = e.sequence_id where e.property_id = $1 order by e.enrolled_at, e.id", [propertyId])).rows;
    async function setup() {
      const lead = await seedLead();
      await seedOrg({ questions_live: true, replies: true, drips: true, canary_property_ids: [lead.propertyId] });
      await seedV2Drips();
      return lead;
    }
    async function routeYes(lead: Awaited<ReturnType<typeof seedLead>>) {
      jevProbabilities = { just_ok: 0.95 };
      const yes = await inbound(lead, "Okay");
      await pg.query("update messages set created_at = now() - interval '30 minutes' where id = $1", [yes.inboundMessageId]);
      await dispatchAiResponse(supabase, yes, { anthropic: NO_ANTHROPIC });
      await settle();
      expect(await enrollments(lead.propertyId)).toEqual([{ k: "book_appointment", status: "active", r: null }]);
    }

    it("a reply onto an ACTIVE v2 drip retires it (rerouted) and starts the new road", async () => {
      const lead = await setup();
      await routeYes(lead);
      jevProbabilities = { confirmed_owner: 0.95 };
      const out = await dispatchAiResponse(supabase, await inbound(lead, "Yes I own it"), { anthropic: NO_ANTHROPIC });
      expect(out).toEqual({ outcome: "auto_closed", reason: "routing_v2:confirmed_owner_drip" });
      expect(await enrollments(lead.propertyId)).toEqual([
        { k: "book_appointment", status: "completed", r: "rerouted" }, { k: "confirmed_owner", status: "active", r: null },
      ]);
    });

    it("a reply onto a PAUSED drip (the webhook paused it) is retired and rerouted, never left paused", async () => {
      const lead = await setup();
      await routeYes(lead);
      await pg.query("update sequence_enrollments set status = 'paused', pause_reason = 'inbound_reply' where property_id = $1 and status = 'active'", [lead.propertyId]);
      jevProbabilities = { confirmed_owner: 0.95 };
      await dispatchAiResponse(supabase, await inbound(lead, "Yes I own it"), { anthropic: NO_ANTHROPIC });
      const rows = await enrollments(lead.propertyId);
      expect(rows.filter((e) => e.status === "paused")).toEqual([]);
      expect(rows).toContainEqual({ k: "confirmed_owner", status: "active", r: null });
    });

    it("a reply racing the tick (a drip text went out after the reply landed): still routed, drip retired", async () => {
      const lead = await setup();
      await routeYes(lead);
      jevProbabilities = { confirmed_owner: 0.95 };
      const reply = await inbound(lead, "Yes I own it");
      await pg.query("update messages set created_at = now() - interval '2 minutes' where id = $1", [reply.inboundMessageId]);
      // The tick sent the drip's next text a moment after the reply landed.
      await supabase.from("messages").insert({ org_id: orgId, channel: "sms", direction: "outbound", status: "delivered", property_id: lead.propertyId, contact_id: lead.contactId, from_address: MOCK_SENDER_PRIMARY, to_address: lead.phone, body: "book_appointment two", metadata: { generated_by: "sequence_tick" }, created_at: new Date(Date.now() - 60_000).toISOString(), sent_at: new Date(Date.now() - 60_000).toISOString() });
      const out = await dispatchAiResponse(supabase, reply, { anthropic: NO_ANTHROPIC, checkSuperseded: true });
      const rows = await enrollments(lead.propertyId);
      expect({ out, rows }).toEqual({ out: { outcome: "auto_closed", reason: "routing_v2:confirmed_owner_drip" }, rows: [{ k: "book_appointment", status: "completed", r: "rerouted" }, { k: "confirmed_owner", status: "active", r: null }] });
    });

    it("two replies (the older dispatched first, past the grace): the newest wins, the older only queues alerts, nothing parked or paused", async () => {
      const lead = await setup();
      await routeYes(lead);
      jevProbabilities = { confirmed_owner: 0.95 };
      const older = await inbound(lead, "Yes I own it");
      const newer = await inbound(lead, "Yes I own it, still here");
      // As in the blast-day replay: both texts landed minutes ago (past the newer-inbound grace),
      // and the delayed dispatch of the OLDER one runs first, then the newer one.
      await pg.query("update messages set created_at = now() - interval '11 minutes' where id = $1", [older.inboundMessageId]);
      await pg.query("update messages set created_at = now() - interval '10 minutes' where id = $1", [newer.inboundMessageId]);
      await dispatchAiResponse(supabase, older, { anthropic: NO_ANTHROPIC, checkSuperseded: true });
      await dispatchAiResponse(supabase, newer, { anthropic: NO_ANTHROPIC, checkSuperseded: true });
      await settle();
      const rows = await enrollments(lead.propertyId);
      expect(rows.filter((e) => e.status === "paused")).toEqual([]);
      expect(rows.filter((e) => e.status === "active")).toEqual([{ k: "confirmed_owner", status: "active", r: null }]);
      const { rows: tr } = await pg.query("select inbound_message_id, outcome from routing_v2_reply_transitions where property_id = $1 and inbound_message_id = any($2)", [lead.propertyId, [older.inboundMessageId, newer.inboundMessageId]]);
      expect(tr.find((t) => t.inbound_message_id === newer.inboundMessageId)?.outcome).toBe("applied");
      expect(tr.find((t) => t.inbound_message_id === older.inboundMessageId)?.outcome).toBe("superseded");
      const { rows: [p] } = await pg.query("select needs_human_attention, last_ai_escalation_reason from properties where id = $1", [lead.propertyId]);
      expect(p.last_ai_escalation_reason ?? "").not.toMatch(/^reply_skipped/);
    });
  });
  describe("the REAL webhook + delay workflow path (stress A-2 / AUD round 2)", () => {
    async function seedV2DripsWh() {
      await pg.query("begin");
      await pg.query("select set_config('routing_v2.allow_drip_edit', 'on', true)");
      for (const [key, name] of [["book_appointment", "Book appointment (routing v2)"], ["confirmed_owner", "Confirmed owner (routing v2)"], ["not_interested", "Not interested (routing v2)"], ["asked_who", "Asked who is texting (routing v2)"]]) {
        const { rows } = await pg.query("insert into sequences(org_id,name,active,routing_v2_key,routing_v2_version) values($1,$2,false,$3,1) returning id", [orgId, name, key]);
        await pg.query("insert into sequence_steps(sequence_id,step_index,delay_after_previous_minutes,action_type,template_body) values($1,0,1440,'send_sms',$2),($1,1,1440,'send_sms',$3)", [rows[0].id, `${key} one`, `${key} two`]);
      }
      await pg.query("commit");
    }
    const enrollments = async (propertyId: string) => (await pg.query(
      "select s.routing_v2_key k, e.status, coalesce(e.ended_reason, e.pause_reason) r from sequence_enrollments e join sequences s on s.id = e.sequence_id where e.property_id = $1 order by e.enrolled_at, e.id", [propertyId])).rows;
    async function runWorkflows() {
      for (let guard = 0; workflows.pending.length && guard < 20; guard++) {
        const w = workflows.pending.shift()!;
        await w.fn(w.params);
      }
      await settle();
    }
    async function say(lead: Awaited<ReturnType<typeof seedLead>>, body: string) {
      const res = await handleInboundWebhook(new Request("https://v2.test/webhooks/mock", {
        method: "POST",
        headers: { "content-type": "application/json", "x-mock-signature": "valid" },
        body: JSON.stringify({ externalId: `v2-wh-${randomUUID()}`, from: lead.phone, to: MOCK_SENDER_PRIMARY, body }),
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
      await seedV2DripsWh();
      await supabase.from("messages").insert({ org_id: orgId, channel: "sms", direction: "outbound", status: "delivered", property_id: lead.propertyId, contact_id: lead.contactId, from_address: MOCK_SENDER_PRIMARY, to_address: lead.phone, body: "Hi, would you sell 2 Vee Ln?", created_at: new Date(Date.now() - 3600_000).toISOString() });
      return lead;
    }
    async function yesThroughWebhook(lead: Awaited<ReturnType<typeof seedLead>>) {
      // As in the stress run: a hot "yes, what's the offer" (open to selling), not a plain okay.
      jevProbabilities = { open_to_selling: 0.95 };
      await say(lead, "sure what's the offer");
      await runWorkflows();
      await runRoutingV2OutboxReplies(supabase, { limit: 10 });
      expect({ e: await enrollments(lead.propertyId), p: await prop(lead.propertyId) }).toMatchObject({ e: [{ k: "book_appointment", status: "active", r: null }] });
    }
    const auditRows = async (inboundId: string) => count("select count(*)::int n from routing_v2_live_decisions where inbound_message_id = $1", [inboundId]);
    const prop = async (id: string) => (await pg.query("select needs_human_attention, last_ai_escalation_reason from properties where id = $1", [id])).rows[0];

    it("a reply onto an ACTIVE drip through the webhook: drip retired (rerouted), new road active, nothing paused", async () => {
      const lead = await setup();
      await yesThroughWebhook(lead);
      jevProbabilities = { confirmed_owner: 0.95 };
      const second = await say(lead, "Yes I own it");
      await runWorkflows();
      const rows = await enrollments(lead.propertyId);
      expect({ rows, prop: await prop(lead.propertyId) }).toMatchObject({
        rows: [{ k: "book_appointment", status: "completed", r: "rerouted" }, { k: "confirmed_owner", status: "active", r: null }],
      });
      expect(await auditRows(second)).toBe(1);
    });

    it("a reply onto a PAUSED drip through the webhook: retired and rerouted, never left paused", async () => {
      const lead = await setup();
      await yesThroughWebhook(lead);
      await pg.query("update sequence_enrollments set status = 'paused', pause_reason = 'inbound_reply' where property_id = $1 and status = 'active'", [lead.propertyId]);
      jevProbabilities = { confirmed_owner: 0.95 };
      await say(lead, "Yes I own it");
      await runWorkflows();
      const rows = await enrollments(lead.propertyId);
      expect(rows.filter((e) => e.status === "paused")).toEqual([]);
      expect(rows).toContainEqual({ k: "confirmed_owner", status: "active", r: null });
    });

    it("a reply racing the tick through the webhook: still routed, drip retired", async () => {
      const lead = await setup();
      await yesThroughWebhook(lead);
      jevProbabilities = { confirmed_owner: 0.95 };
      await say(lead, "Yes I own it");
      // The tick sends the drip's next text after the reply landed, before the delayed dispatch runs.
      await supabase.from("messages").insert({ org_id: orgId, channel: "sms", direction: "outbound", status: "delivered", property_id: lead.propertyId, contact_id: lead.contactId, from_address: MOCK_SENDER_PRIMARY, to_address: lead.phone, body: "book_appointment two", metadata: { generated_by: "sequence_tick" }, created_at: new Date(Date.now() + 1000).toISOString(), sent_at: new Date(Date.now() + 1000).toISOString() });
      await runWorkflows();
      const rows = await enrollments(lead.propertyId);
      expect(rows.filter((e) => e.status === "paused")).toEqual([]);
      expect(rows).toEqual([{ k: "book_appointment", status: "completed", r: "rerouted" }, { k: "confirmed_owner", status: "active", r: null }]);
    });

    it("the older reply still queued when the newer text lands (stress run order): newer text routed, never parked, no reply_skipped hold", async () => {
      const lead = await setup();
      // The yes reply waits in the outbox (seller's window closed) while the next text arrives.
      recipientWindow.open = false;
      jevProbabilities = { open_to_selling: 0.95 };
      await say(lead, "sure what's the offer");
      await runWorkflows();
      expect(await enrollments(lead.propertyId)).toEqual([{ k: "book_appointment", status: "active", r: null }]);
      jevProbabilities = { confirmed_owner: 0.95 };
      const second = await say(lead, "Yes I own it");
      // The window opens; the cron delivers the OLDER queued reply before the newer text's delayed dispatch.
      recipientWindow.open = true;
      await runRoutingV2OutboxReplies(supabase, { limit: 10 });
      await runWorkflows();
      await runRoutingV2OutboxReplies(supabase, { limit: 10 });
      const rows = await enrollments(lead.propertyId);
      const p = await prop(lead.propertyId);
      const { rows: [stamp] } = await pg.query("select metadata->'processing'->'aiResponder'->>'outcome' o, metadata->'processing'->'aiResponder'->>'reason' r from messages where id = $1", [second]);
      expect({ rows, reason: p.last_ai_escalation_reason ?? null, stamp }).toEqual({
        rows: [{ k: "book_appointment", status: "completed", r: "rerouted" }, { k: "confirmed_owner", status: "active", r: null }],
        reason: null,
        stamp: { o: "auto_closed", r: "routing_v2:confirmed_owner_drip" },
      });
      expect(await auditRows(second)).toBe(1);
      // The older reply was cancelled; its owner alerts were not (review M-1).
      const { rows: alerts } = await pg.query("select o.status from routing_v2_outbox o join messages m on m.id = o.inbound_message_id where o.property_id = $1 and o.kind = 'alert' and m.body = $2", [lead.propertyId, "sure what's the offer"]);
      expect(alerts.length).toBeGreaterThan(0);
      expect(alerts.filter((a) => a.status === "cancelled")).toEqual([]);
    });

    async function olderReplyQueued() {
      const lead = await setup();
      recipientWindow.open = false;
      jevProbabilities = { open_to_selling: 0.95 };
      await say(lead, "sure what's the offer");
      await runWorkflows();
      const { rows: [box] } = await pg.query("select status from routing_v2_outbox where property_id = $1 and kind = 'reply'", [lead.propertyId]);
      expect(box.status).toBe("pending");
      return lead;
    }
    const newerText = async (lead: Awaited<ReturnType<typeof seedLead>>, metadata: Json = {}) => {
      const { data, error } = await supabase.from("messages").insert({ org_id: orgId, channel: "sms", direction: "inbound", status: "received", property_id: lead.propertyId, contact_id: lead.contactId, from_address: lead.phone, to_address: MOCK_SENDER_PRIMARY, body: "Yes I own it", metadata }).select("id").single();
      expect(error).toBeNull();
      return data!.id as string;
    };
    async function deliverOlderAndExpectHold(lead: Awaited<ReturnType<typeof seedLead>>) {
      recipientWindow.open = true;
      await runRoutingV2OutboxReplies(supabase, { limit: 10 });
      const { rows: [box] } = await pg.query("select status from routing_v2_outbox where property_id = $1 and kind = 'reply'", [lead.propertyId]);
      expect(box.status).toBe("cancelled");
      expect(sentTo(lead.phone)).toHaveLength(0);
      const p = await prop(lead.propertyId);
      expect(p.needs_human_attention).toBe(true);
      // A dead newer webhook may also be found first by the outbox cron's unstamped-inbound sweep.
      expect(p.last_ai_escalation_reason).toMatch(/^(reply_skipped:newer_inbound|nine_reply_not_sent:|nine_needs_person$)/);
    }

    it("A-2 round 3, the EXACT stress order: yes -> Book drip, reply in flight; the newer text is saved but its webhook has not stamped it yet when the older reply cancels; the newer text is then routed (no reply_skipped hold, no already_terminal, drip rerouted)", async () => {
      const lead = await setup();
      recipientWindow.open = false; // the yes reply stays in flight (queued in the outbox)
      jevProbabilities = { open_to_selling: 0.95 };
      await say(lead, "sure what's the offer");
      await runWorkflows();
      expect(await enrollments(lead.propertyId)).toEqual([{ k: "book_appointment", status: "active", r: null }]);
      // The newer text's webhook: hold it inside start(), i.e. after the inbound is saved and
      // before its delay stamp / any claim.
      let release!: () => void;
      workflows.gate = new Promise<void>((r) => { release = r; });
      jevProbabilities = { not_interested: 0.95 };
      const webhook = say(lead, "not interested");
      let newer: string | null = null;
      for (let i = 0; i < 100 && !newer; i++) {
        const { rows } = await pg.query("select id from messages where property_id = $1 and direction = 'inbound' and body = 'not interested'", [lead.propertyId]);
        newer = rows[0]?.id ?? null;
        if (!newer) await new Promise((r) => setTimeout(r, 50));
      }
      expect(newer).not.toBeNull();
      expect(await stampOf(newer!)).toMatchObject({ o: null });
      // The older reply goes to send now and is cancelled (superseded_before_send).
      recipientWindow.open = true;
      await runRoutingV2OutboxReplies(supabase, { limit: 10 });
      const { rows: [older] } = await pg.query("select status, cancel_reason from routing_v2_outbox where property_id = $1 and kind = 'reply' order by created_at asc limit 1", [lead.propertyId]);
      expect(older.status).toBe("cancelled");
      expect((await prop(lead.propertyId)).needs_human_attention).toBe(false);
      // The newer text's webhook finishes; its delayed dispatch runs.
      workflows.gate = null;
      release();
      await webhook;
      await runWorkflows();
      await deliver();
      expect(await stampOf(newer!)).toMatchObject({ o: "auto_closed", r: "routing_v2:not_interested_drip" });
      expect(await prop(lead.propertyId)).toMatchObject({ needs_human_attention: false });
      expect(await enrollments(lead.propertyId)).toEqual([
        { k: "book_appointment", status: "completed", r: "rerouted" }, { k: "not_interested", status: "active", r: null },
      ]);
    });

    it("M-1: the newer text's webhook died after the insert (no stamp past the webhook lease): the cancelled older reply still holds", async () => {
      const lead = await olderReplyQueued();
      // Both texts landed long ago; the newer one never got a stamp or claim within the 5-minute
      // webhook lease, so its webhook is dead (a young unstamped text is still in flight: A-2 r3).
      await pg.query("update messages set created_at = now() - interval '20 minutes' where property_id = $1 and direction = 'inbound'", [lead.propertyId]);
      const newer = await newerText(lead);
      await pg.query("update messages set created_at = now() - interval '10 minutes' where id = $1", [newer]);
      await deliverOlderAndExpectHold(lead);
    });

    it("A-2 F1 (was M-1): the newer text's own handler ended (claim error): the older reply is cancelled with NO hold; the newer text's own outcome stands", async () => {
      const lead = await olderReplyQueued();
      const newer = await newerText(lead, { processing: { aiResponder: { outcome: "delayed", workflowRunId: "ended-run", delaySeconds: 30 } } });
      await pg.query("insert into ai_response_claims (org_id, inbound_message_id, property_id, contact_id, status, completed_at, outcome, error_message) values ($1, $2, $3, $4, 'error', now(), 'skipped', 'reply_ineligible')", [orgId, newer, lead.propertyId, lead.contactId]);
      recipientWindow.open = true;
      await runRoutingV2OutboxReplies(supabase, { limit: 10 });
      const { rows: [box] } = await pg.query("select status from routing_v2_outbox where property_id = $1 and kind = 'reply'", [lead.propertyId]);
      expect(box.status).toBe("cancelled");
      expect(sentTo(lead.phone)).toHaveLength(0);
      expect((await prop(lead.propertyId)).needs_human_attention).toBe(false);
    });

    // ---- A-2 consolidated fix (A2-ROOT-CAUSE-ANALYSIS.md, matrix cases 1-10) ----
    const box = async (inboundId: string) => (await pg.query("select status, cancel_reason from routing_v2_outbox where inbound_message_id = $1 and kind = 'reply'", [inboundId])).rows[0] ?? null;
    const stampOf = async (inboundId: string) => (await pg.query("select metadata->'processing'->'aiResponder'->>'outcome' o, metadata->'processing'->'aiResponder'->>'reason' r from messages where id = $1", [inboundId])).rows[0];
    const activeFor = async (inboundId: string) => count("select count(*)::int n from sequence_enrollments where routing_v2_inbound_id = $1 and status = 'active'", [inboundId]);
    const deliver = async () => { await runRoutingV2OutboxReplies(supabase, { limit: 20 }); await settle(); await runRoutingV2OutboxReplies(supabase, { limit: 20 }); };
    async function text(lead: Awaited<ReturnType<typeof seedLead>>, body: string, p: Record<string, number>) {
      jevProbabilities = p;
      const id = await say(lead, body);
      await runWorkflows();
      await deliver();
      return id;
    }

    it("case 1: not interested twice: the repeat reply is a no-op, NO hold, the new Not interested drip is active, audit decided", async () => {
      const lead = await setup();
      await text(lead, "not interested", { not_interested: 0.95 });
      const second = await text(lead, "still not interested", { not_interested: 0.95 });
      expect(await box(second)).toMatchObject({ status: "cancelled", cancel_reason: "not_sent:template_already_sent" });
      expect((await prop(lead.propertyId)).needs_human_attention).toBe(false);
      expect(await activeFor(second)).toBe(1);
      expect(await count("select count(*)::int n from routing_v2_live_decisions where inbound_message_id = $1 and status = 'decided'", [second])).toBe(1);
    });

    it("case 2: case 1, then \"who is this?\": rerouted, identity reply sent, Asked-who drip active, no already_terminal", async () => {
      const lead = await setup();
      await text(lead, "not interested", { not_interested: 0.95 });
      const second = await text(lead, "still not interested", { not_interested: 0.95 });
      const third = await text(lead, "who is this?", { asked_who: 0.95 });
      expect(await stampOf(third)).toMatchObject({ o: "auto_closed" });
      const rows = await enrollments(lead.propertyId);
      expect(rows.filter((e) => e.status === "active")).toEqual([{ k: "asked_who", status: "active", r: null }]);
      expect(await count("select count(*)::int n from sequence_enrollments where routing_v2_inbound_id = $1 and ended_reason = 'rerouted'", [second])).toBe(1);
      expect(sentTo(lead.phone).map((m) => m.body)).toContain(v2ReplyText("identity"));
    });

    it("case 3: a reply-only question repeated: the second reply is cancelled and the lead IS held (no drip to fall back on)", async () => {
      const lead = await setup();
      await text(lead, "where are you located?", { where_located: 0.95 });
      const second = await text(lead, "where are you located again?", { where_located: 0.95 });
      expect(await box(second)).toMatchObject({ status: "cancelled", cancel_reason: "not_sent:template_already_sent" });
      expect(await prop(lead.propertyId)).toMatchObject({ needs_human_attention: true, last_ai_escalation_reason: "nine_reply_not_sent:template_already_sent" });
      expect(await activeFor(second)).toBe(0);
    });

    it("case 4: the property window is closed (recipient open): the reply waits pending, then sends when it opens; no hold", async () => {
      const lead = await setup();
      recipientWindow.open = false; // hold the first delivery attempt back during the dispatch
      jevProbabilities = { not_interested: 0.95 };
      const id = await say(lead, "not interested");
      await runWorkflows();
      recipientWindow.open = true;
      propertyWindow.open = false;
      await deliver();
      expect(await box(id)).toMatchObject({ status: "pending" });
      expect(sentTo(lead.phone)).toHaveLength(0);
      propertyWindow.open = true;
      await deliver();
      expect(await box(id)).toMatchObject({ status: "sent" });
      expect(sentTo(lead.phone)).toHaveLength(1);
      expect((await prop(lead.propertyId)).needs_human_attention).toBe(false);
    });

    it("case 5: the window closes between prepare and send: a drip road is a quiet no-op (drip active), a reply-only road holds", async () => {
      const drip = await setup();
      recipientWindow.open = false;
      jevProbabilities = { not_interested: 0.95 };
      const a = await say(drip, "not interested");
      await runWorkflows();
      recipientWindow.open = true;
      propertyWindow.openCalls = 1; // open at the outbox prepare, closed at the send
      await runRoutingV2OutboxReplies(supabase, { limit: 20 });
      propertyWindow.openCalls = null;
      expect((await box(a)).status).toBe("cancelled");
      expect((await prop(drip.propertyId)).needs_human_attention).toBe(false);
      expect(await activeFor(a)).toBe(1);

      const only = await seedLead();
      await pg.query("update ai_responder_configs set routing_v2_flags = jsonb_set(routing_v2_flags, '{canary_property_ids}', (routing_v2_flags->'canary_property_ids') || to_jsonb($2::text)) where org_id = $1", [orgId, only.propertyId]);
      await supabase.from("messages").insert({ org_id: orgId, channel: "sms", direction: "outbound", status: "delivered", property_id: only.propertyId, contact_id: only.contactId, from_address: MOCK_SENDER_PRIMARY, to_address: only.phone, body: "Hi, would you sell 2 Vee Ln?", created_at: new Date(Date.now() - 3600_000).toISOString() });
      recipientWindow.open = false;
      jevProbabilities = { where_located: 0.95 };
      const b = await say(only, "where are you located?");
      await runWorkflows();
      recipientWindow.open = true;
      propertyWindow.openCalls = 1;
      await runRoutingV2OutboxReplies(supabase, { limit: 20 });
      propertyWindow.openCalls = null;
      expect((await box(b)).status).toBe("cancelled");
      expect((await prop(only.propertyId)).needs_human_attention).toBe(true);
    });

    async function doubleText(trigger: "ai" | "human") {
      const lead = await setup();
      // Text A gets its reply; text B landed just BEFORE that reply was submitted (the double-text race).
      const a = await text(lead, "text only please", { text_only: 0.95 });
      expect(sentTo(lead.phone)).toHaveLength(1);
      if (trigger === "human") {
        // Instead of our own reply, a rep's manual text went out after B landed.
        await pg.query("update messages set metadata = '{}'::jsonb where property_id = $1 and direction = 'outbound' and body = $2", [lead.propertyId, V2_REPLY_TEXTS.text_only]);
      }
      jevProbabilities = { not_interested: 0.95 };
      const b = await say(lead, "actually not interested");
      const { rows: [sent] } = await pg.query("select coalesce(sent_at, created_at) t from messages where property_id = $1 and direction = 'outbound' and body = $2", [lead.propertyId, V2_REPLY_TEXTS.text_only]);
      // B landed after A but before A's reply went out.
      await pg.query("update messages set created_at = (select created_at from messages where id = $3) + ($2::timestamptz - (select created_at from messages where id = $3)) / 2 where id = $1", [b, sent.t, a]);
      await runWorkflows();
      await deliver();
      return { lead, a, b };
    }

    it("case 6: double text, our own older auto reply went out after B landed: B's reply cancelled v2_older_auto_reply_sent, NO hold, B's drip active", async () => {
      const { lead, b } = await doubleText("ai");
      expect(await box(b)).toMatchObject({ status: "cancelled", cancel_reason: "not_sent:v2_older_auto_reply_sent" });
      expect((await prop(lead.propertyId)).needs_human_attention).toBe(false);
      expect(await activeFor(b)).toBe(1);
    });

    it("case 7: the same race with a rep's manual text: B's auto reply is never sent (the rep answered: today's rule 2, unchanged)", async () => {
      const { lead, b } = await doubleText("human");
      expect(sentTo(lead.phone).filter((m) => m.body === v2ReplyText("not_interested"))).toHaveLength(0);
      expect(await box(b)).toBeNull();
      expect(await stampOf(b)).toMatchObject({ r: "already_answered" });
    });

    it("case 8: a possible-stop hold stays with the person: \"ok\" and \"call me now\" never auto-send or reroute (Jarrad Q2 default)", async () => {
      const lead = await setup();
      await pg.query("update ai_responder_configs set routing_v2_flags = routing_v2_flags || '{\"haiku\": true}'::jsonb where org_id = $1", [orgId]);
      haikuAnswer = { road: "asked_stop", confidence: 0.9 };
      await text(lead, "I think I'm all set", { asked_stop: 0.65 });
      expect(await prop(lead.propertyId)).toMatchObject({ needs_human_attention: true, last_ai_escalation_reason: "nine_asked_stop" });
      const before = sentTo(lead.phone).length;
      const ok = await text(lead, "ok", { just_ok: 0.95 });
      const call = await text(lead, "call me now", { asked_call: 0.95 });
      expect(sentTo(lead.phone)).toHaveLength(before);
      expect(await prop(lead.propertyId)).toMatchObject({ needs_human_attention: true });
      expect(await count("select count(*)::int n from sequence_enrollments where property_id = $1 and status = 'active'", [lead.propertyId])).toBe(0);
      for (const id of [ok, call]) {
        expect(await stampOf(id)).toMatchObject({ r: "already_terminal" });
        expect(await auditRows(id)).toBe(1);
      }
    });

    it("case 9: a needs-person hold (Haiku error) stays held and in the hold list after a later text", async () => {
      const lead = await setup();
      await pg.query("update ai_responder_configs set routing_v2_flags = routing_v2_flags || '{\"haiku\": true}'::jsonb where org_id = $1", [orgId]);
      haikuAnswer = null; // Haiku provider error
      await text(lead, "hmm", { just_ok: 0.65 });
      expect(await prop(lead.propertyId)).toMatchObject({ needs_human_attention: true, last_ai_escalation_reason: "nine_needs_person" });
      const later = await text(lead, "hello?", { just_ok: 0.95 });
      expect(await prop(lead.propertyId)).toMatchObject({ needs_human_attention: true, last_ai_escalation_reason: "nine_needs_person" });
      expect(await count("select count(*)::int n from properties where id = $1 and needs_human_attention = true and is_dnc_locked = false", [lead.propertyId])).toBe(1);
      expect(await auditRows(later)).toBe(1);
    });

    it.each([["blank", ""], ["spelled out", "Missouri"]] as const)("B-1: a property whose state is %s (unreadable) ends HELD: the reply holds and the drip is paused for a person, never silent", async (_label, state) => {
      const lead = await setup();
      await pg.query("update properties set state = $2 where id = $1", [lead.propertyId, state]);
      const id = await text(lead, "not interested", { not_interested: 0.95 });
      expect(sentTo(lead.phone)).toHaveLength(0);
      expect(await box(id)).toMatchObject({ status: "cancelled", cancel_reason: "not_sent:nine_window_unknown_state" });
      expect(await prop(lead.propertyId)).toMatchObject({ needs_human_attention: true, last_ai_escalation_reason: "nine_reply_not_sent:nine_window_unknown_state" });
      // The drip never reschedules +10h forever: the tick pauses it for a person.
      await pg.query("begin; set local session_replication_role = replica; update public.sequence_enrollments set next_run_at = least(now(), '" + new Date().toISOString() + "'::timestamptz) - interval '1 minute' where property_id = '" + lead.propertyId + "' and status = 'active'; commit;");
      const { runSequenceTick } = await import("@/app/api/cron/sequence-tick/handlers");
      await runSequenceTick(supabase as never, { budgetMs: 20_000 });
      // Paused for the person: by the held-lead send check (410000, the lead is already held) or
      // the unknown-state gate, whichever the tick reaches first. Never active, never sent.
      const drip = (await enrollments(lead.propertyId)).find((e) => e.k === "not_interested");
      expect(drip).toMatchObject({ status: "paused" });
      expect(["held_for_person", "inbound_reply", "timezone_unconfirmed"]).toContain(drip!.r);
      expect(sentTo(lead.phone)).toHaveLength(0);
    });

    async function seedWrongNumberAutomation() {
      await pg.query("insert into public.jev_outcome_thresholds (org_id, outcome, min_confidence, automation_enabled) values ($1, 'wrong_number', 0.9, true) on conflict do nothing", [orgId]);
      await pg.query("begin");
      await pg.query("select set_config('sandra.template_approval', 'on', true)");
      const { rows: t } = await pg.query("insert into public.sms_templates (org_id, name, content, approved_for_auto_send, approved_content, approved_at) values ($1, 'Auto reply wrong_number', $2, true, $2, now()) returning id", [orgId, APPROVED_REPLY_TEXTS.wrong_number]);
      await pg.query("insert into public.auto_reply_templates (org_id, outcome, template_id) values ($1, 'wrong_number', $2)", [orgId, t[0].id]);
      await pg.query("commit");
    }
    const dispoOf = async (id: string) => (await pg.query("select outreach_dispo, needs_human_attention from properties where id = $1", [id])).rows[0];

    it("H1(i) round 3: v2 decides wrong person with wrong_number_all OFF (today's this-property close): the paused v2 drip is retired", async () => {
      const lead = await setup();
      await seedWrongNumberAutomation();
      await text(lead, "not interested", { not_interested: 0.95 });
      expect(await enrollments(lead.propertyId)).toEqual([{ k: "not_interested", status: "active", r: null }]);
      // No webhook keyword matches this wording: v2 decides wrong_number_close.
      const id = await text(lead, "That is not my place, never was", { wrong_person: 0.95 });
      expect(await count("select count(*)::int n from routing_v2_live_decisions where inbound_message_id = $1 and road = 'wrong_number_close'", [id])).toBe(1);
      expect({ rows: await enrollments(lead.propertyId), p: await dispoOf(lead.propertyId) }).toEqual({
        rows: [{ k: "not_interested", status: "completed", r: "rerouted" }],
        p: { outreach_dispo: "wrong_number", needs_human_attention: false },
      });
    });

    it("H1(i) round 3: the webhook's this-property wrong-number keyword close also retires the v2 drip (a phone-wide claim stays held + paused)", async () => {
      const lead = await setup();
      await text(lead, "not interested", { not_interested: 0.95 });
      await text(lead, "I don't own that house", {});
      expect({ rows: await enrollments(lead.propertyId), p: await dispoOf(lead.propertyId) }).toEqual({
        rows: [{ k: "not_interested", status: "completed", r: "rerouted" }],
        p: { outreach_dispo: "wrong_number", needs_human_attention: false },
      });
      const other = await seedLead();
      await pg.query("update ai_responder_configs set routing_v2_flags = jsonb_set(routing_v2_flags, '{canary_property_ids}', (routing_v2_flags->'canary_property_ids') || to_jsonb($2::text)) where org_id = $1", [orgId, other.propertyId]);
      await supabase.from("messages").insert({ org_id: orgId, channel: "sms", direction: "outbound", status: "delivered", property_id: other.propertyId, contact_id: other.contactId, from_address: MOCK_SENDER_PRIMARY, to_address: other.phone, body: "Hi, would you sell 2 Vee Ln?", created_at: new Date(Date.now() - 3600_000).toISOString() });
      await text(other, "not interested", { not_interested: 0.95 });
      await text(other, "wrong number", {});
      expect(await enrollments(other.propertyId)).toEqual([{ k: "not_interested", status: "paused", r: "inbound_reply" }]);
      expect((await dispoOf(other.propertyId)).needs_human_attention).toBe(true);
    });

    // ---- H1(iii) round 4 (property 3d6fcb49): "No!" + "No thank you" + a third text within ~100 ms ----
    const BURST = { "No!": { asked_stop: 0.65 }, "No thank you": { not_interested: 0.95 }, "ok": { just_ok: 0.95 } };
    async function burstSetup() {
      const lead = await setup();
      await pg.query("update ai_responder_configs set routing_v2_flags = routing_v2_flags || '{\"haiku\": true}'::jsonb where org_id = $1", [orgId]);
      haikuAnswer = { road: "asked_stop", confidence: 0.9 }; // "No!" is a genuine possible stop
      jevByReply = BURST;
      return lead;
    }
    /** Nothing enrolled or sent survives the possible-stop hold, through the outbox and the tick. */
    async function expectNothingSurvivesHold(lead: Awaited<ReturnType<typeof seedLead>>) {
      await settle();
      await deliver();
      // Held, whichever hold commits first in the burst: the possible stop itself, or a reply the
      // outbox could not send (never a hold written over another hold). The zero-send checks are exact.
      const held = await prop(lead.propertyId);
      expect(held.needs_human_attention).toBe(true);
      expect(held.last_ai_escalation_reason).toMatch(/^(nine_asked_stop|nine_reply_not_sent:.+)$/);
      expect(await count("select count(*)::int n from sequence_enrollments where property_id = $1 and status = 'active'", [lead.propertyId])).toBe(0);
      expect(await count("select count(*)::int n from routing_v2_outbox where property_id = $1 and kind = 'reply' and status = 'sent'", [lead.propertyId])).toBe(0);
      expect(sentTo(lead.phone)).toHaveLength(0);
      // Every enrollment made due, then the tick: no drip step goes out.
      await pg.query("begin; set local session_replication_role = replica; update public.sequence_enrollments set next_run_at = least(now(), '" + new Date().toISOString() + "'::timestamptz) - interval '1 minute' where property_id = '" + lead.propertyId + "'; commit;");
      const { runSequenceTick } = await import("@/app/api/cron/sequence-tick/handlers");
      await runSequenceTick(supabase as never, { budgetMs: 20_000 });
      await deliver();
      expect(sentTo(lead.phone)).toHaveLength(0);
      expect(await count("select count(*)::int n from sequence_step_runs r join sequence_enrollments e on e.id = r.enrollment_id where e.property_id = $1 and r.message_id is not null", [lead.propertyId])).toBe(0);
      expect(await count("select count(*)::int n from sequence_enrollments where property_id = $1 and status = 'active'", [lead.propertyId])).toBe(0);
    }
    async function burst(lead: Awaited<ReturnType<typeof seedLead>>, order: string[]) {
      await Promise.all(order.map((body, i) => new Promise((r) => setTimeout(r, i * 40)).then(() => say(lead, body))));
      const batch = workflows.pending.splice(0); // the three delayed dispatches run at the same time
      await Promise.all(batch.map((w) => w.fn(w.params)));
    }

    it("H1(iii) 3d6fcb49 order A: \"No!\" then \"No thank you\" then \"ok\" within ~100 ms, decided in parallel: held as a possible stop, nothing enrolled or sent survives", async () => {
      const lead = await burstSetup();
      await burst(lead, ["No!", "No thank you", "ok"]);
      await expectNothingSurvivesHold(lead);
    });

    it("H1(iii) 3d6fcb49 order B: \"No thank you\" then \"No!\" then \"ok\": held as a possible stop, nothing enrolled or sent survives", async () => {
      const lead = await burstSetup();
      await burst(lead, ["No thank you", "No!", "ok"]);
      await expectNothingSurvivesHold(lead);
    });

    it("H1(iii) 3d6fcb49 hold lands mid-enrollment: \"No thank you\" passed its gates and is classifying when the \"No!\" hold commits; its transition then enrolls: drip paused, nothing sent", async () => {
      const lead = await burstSetup();
      await say(lead, "No!");
      await say(lead, "No thank you"); // newer: latest reply wins, so it enrolls the Not interested drip
      const batch = workflows.pending.splice(0);
      const [stopRun, niRun] = batch;
      let release!: () => void;
      let reached!: () => void;
      const reachedP = new Promise<void>((r) => { reached = r; });
      jevGates["No thank you"] = { gate: new Promise<void>((r) => { release = r; }), reached };
      const niDispatch = niRun!.fn(niRun!.params); // past the pre-gates, now waiting inside Jev
      await reachedP;
      await stopRun!.fn(stopRun!.params);          // the possible-stop hold commits meanwhile
      expect(await prop(lead.propertyId)).toMatchObject({ needs_human_attention: true, last_ai_escalation_reason: "nine_asked_stop" });
      release();
      await niDispatch;                              // its transition enrolls on the now-held lead
      await expectNothingSurvivesHold(lead);
    });

    // ---- 410000 (review of 30d35369b, BLOCKING): the hold is checked at drip SEND time ----
    async function tickDue(lead: Awaited<ReturnType<typeof seedLead>>) {
      await pg.query("begin; set local session_replication_role = replica; update public.sequence_enrollments set next_run_at = least(now(), '" + new Date().toISOString() + "'::timestamptz) - interval '1 minute' where property_id = '" + lead.propertyId + "' and status = 'active'; commit;");
      const { runSequenceTick } = await import("@/app/api/cron/sequence-tick/handlers");
      await runSequenceTick(supabase as never, { budgetMs: 20_000 });
    }

    it("send-time hold (a): the reply on a reply+drip road cannot be sent, the outbox holds the lead, and its new drip never texts the held lead", async () => {
      const lead = await setup();
      await pg.query("delete from auto_reply_templates where org_id = $1 and outcome = 'not_interested'", [orgId]); // the reply cannot be prepared
      const id = await text(lead, "not interested", { not_interested: 0.95 });
      expect((await box(id)).status).toBe("cancelled");
      expect((await prop(lead.propertyId)).needs_human_attention).toBe(true);
      await tickDue(lead);
      expect(sentTo(lead.phone)).toHaveLength(0);
      expect(await count("select count(*)::int n from sequence_enrollments where property_id = $1 and status = 'active'", [lead.propertyId])).toBe(0);
    });

    it("send-time hold (b): a keyword / legal hold that lands after the decision's re-read (webhook race) never lets the drip text the held lead", async () => {
      const lead = await setup();
      await text(lead, "not interested", { not_interested: 0.95 });
      const sentBefore = sentTo(lead.phone).length;
      expect(await count("select count(*)::int n from sequence_enrollments where property_id = $1 and status = 'active'", [lead.propertyId])).toBe(1);
      // The webhook's keyword / legal hold commits only now, after the decision's own re-read.
      await pg.query("update properties set needs_human_attention = true, last_ai_escalation_reason = 'keyword:legal_contract' where id = $1", [lead.propertyId]);
      await tickDue(lead);
      expect(sentTo(lead.phone)).toHaveLength(sentBefore);
      // 420000: every hold pauses the v2 drips in the same transaction (held_for_person).
      expect(await enrollments(lead.propertyId)).toEqual([{ k: "not_interested", status: "paused", r: "held_for_person" }]);
    });

    it("A-2 lease death: a newer text whose webhook died inside its lease (no stamp, no claim) is swept by the outbox cron once it is past the lease: a person looks; a young one is left in flight", async () => {
      const lead = await setup();
      await text(lead, "not interested", { not_interested: 0.95 });
      const dead = await newerText(lead);
      await pg.query("update messages set created_at = now() - interval '6 minutes' where id = $1", [dead]);
      const young = await newerText(lead);
      await runRoutingV2OutboxReplies(supabase, { limit: 10 });
      expect(await prop(lead.propertyId)).toMatchObject({ needs_human_attention: true, last_ai_escalation_reason: "nine_needs_person" });
      expect(await count("select count(*)::int n from routing_v2_live_decisions where inbound_message_id = $1 and status = 'not_routed' and failure_reason = 'webhook_lease_expired_unstamped'", [dead])).toBe(1);
      expect(await auditRows(young)).toBe(0);
      // Once per text: a second pass writes nothing new.
      await runRoutingV2OutboxReplies(supabase, { limit: 10 });
      expect(await auditRows(dead)).toBe(1);
    });

    it("sweep N-1: 51 handled unstamped texts ahead of 1 dead text never stall the sweep: the dead text's lead is held", async () => {
      const lead = await setup();
      const busy = await seedLead();
      // 51 older texts on another lead that were handled (each has a claim) but carry no stamp.
      const { rows: handled } = await pg.query(
        "insert into messages (org_id, channel, direction, status, property_id, contact_id, from_address, to_address, body, created_at) select $1, 'sms', 'inbound', 'received', $2, $3, $4, $5, 'handled ' || g, now() - interval '30 minutes' - (g || ' seconds')::interval from generate_series(1, 51) g returning id",
        [orgId, busy.propertyId, busy.contactId, busy.phone, MOCK_SENDER_PRIMARY],
      );
      for (const h of handled) {
        await pg.query("insert into ai_response_claims (org_id, inbound_message_id, property_id, contact_id, status, completed_at, outcome) values ($1, $2, $3, $4, 'completed', now(), 'auto_closed')", [orgId, h.id, busy.propertyId, busy.contactId]);
      }
      const dead = await newerText(lead);
      await pg.query("update messages set created_at = now() - interval '10 minutes' where id = $1", [dead]);
      // Passes run until the backlog is through (each pass examines at most 50 texts).
      for (let i = 0; i < 3; i++) await runRoutingV2OutboxReplies(supabase, { limit: 10 });
      expect(await prop(lead.propertyId)).toMatchObject({ needs_human_attention: true, last_ai_escalation_reason: "nine_needs_person" });
      expect(await count("select count(*)::int n from routing_v2_live_decisions where inbound_message_id = $1 and failure_reason = 'webhook_lease_expired_unstamped'", [dead])).toBe(1);
    });

    it("sweep time budget: out of time = no text examined (nothing held, nothing marked); the next pass does it", async () => {
      const lead = await setup();
      const dead = await newerText(lead);
      await pg.query("update messages set created_at = now() - interval '10 minutes' where id = $1", [dead]);
      expect(await sweepUnstampedV2Inbounds(supabase, Date.now(), () => true)).toBe(0);
      expect((await prop(lead.propertyId)).needs_human_attention).toBe(false);
      expect((await pg.query("select metadata->'processing'->'routingV2Sweep' s from messages where id = $1", [dead])).rows[0].s).toBeNull();
      expect(await sweepUnstampedV2Inbounds(supabase, Date.now())).toBe(1);
    });

    it("N-3: unknown time zone on a lead with no other hold: the tick puts the drip in the person queue (paused timezone_unconfirmed), 0 sends", async () => {
      const lead = await setup();
      await text(lead, "not interested", { not_interested: 0.95 });
      const sentBefore = sentTo(lead.phone).length;
      await pg.query("update properties set state = '' where id = $1", [lead.propertyId]);
      expect((await prop(lead.propertyId)).needs_human_attention).toBe(false);
      await pg.query("begin; set local session_replication_role = replica; update public.sequence_enrollments set next_run_at = least(now(), '" + new Date().toISOString() + "'::timestamptz) - interval '1 minute' where property_id = '" + lead.propertyId + "' and status = 'active'; commit;");
      const { runSequenceTick } = await import("@/app/api/cron/sequence-tick/handlers");
      await runSequenceTick(supabase as never, { budgetMs: 20_000 });
      expect(await enrollments(lead.propertyId)).toEqual([{ k: "not_interested", status: "paused", r: "timezone_unconfirmed" }]);
      expect(await count("select count(*)::int n from sequence_enrollments where property_id = $1 and status = 'active'", [lead.propertyId])).toBe(0);
      expect(sentTo(lead.phone)).toHaveLength(sentBefore);
    });

    it("wrong-number keyword: when the close does NOT apply (a person's disposition blocks it), the v2 drip is not retired", async () => {
      const lead = await setup();
      await text(lead, "not interested", { not_interested: 0.95 });
      await pg.query("update properties set outreach_dispo = 'callback_requested' where id = $1", [lead.propertyId]);
      await text(lead, "I don't own that house", {});
      expect((await dispoOf(lead.propertyId)).outreach_dispo).toBe("callback_requested");
      expect(await enrollments(lead.propertyId)).toEqual([{ k: "not_interested", status: "paused", r: "inbound_reply" }]);
    });

    // ================= A-2 race analysis acceptance matrix (M1-M12) =================
    // Order is forced only by named barriers (F6) and the DB; no sleeps decide an interleaving.
    const A_TEXT = "sure what's the offer";
    const B_TEXT = "not interested";
    const C_TEXT = "Yes I own it";
    const RACE_JEV = { [A_TEXT]: { open_to_selling: 0.95 }, [B_TEXT]: { not_interested: 0.95 }, [C_TEXT]: { confirmed_owner: 0.95 } };
    function gate(name: TestBarrierName, match: (c: TestBarrierContext) => boolean = () => true) {
      let release!: () => void;
      let reached!: () => void;
      const released = new Promise<void>((r) => { release = r; });
      const hit = new Promise<void>((r) => { reached = r; });
      let fired = false;
      setTestBarrier(name, async (c) => {
        if (fired || !match(c)) return;
        fired = true;
        reached();
        await released;
      });
      const timed = Promise.race([hit, new Promise<never>((_, rej) => setTimeout(() => rej(new Error(`barrier ${name} never reached`)), 20_000))]);
      return { reached: timed, release };
    }
    const idOf = async (lead: Awaited<ReturnType<typeof seedLead>>, body: string) =>
      ((await pg.query("select id from messages where property_id = $1 and direction = 'inbound' and body = $2 order by created_at desc limit 1", [lead.propertyId, body])).rows[0]?.id ?? null) as string | null;
    const waitForId = async (lead: Awaited<ReturnType<typeof seedLead>>, body: string) => {
      for (let i = 0; i < 400; i++) { const id = await idOf(lead, body); if (id) return id; await new Promise((r) => setTimeout(r, 25)); }
      throw new Error(`inbound ${body} never inserted`);
    };
    const takeWorkflow = (inboundId: string) => {
      const i = workflows.pending.findIndex((w) => (w.params as { inboundMessageId?: string }).inboundMessageId === inboundId);
      if (i < 0) throw new Error(`no workflow for ${inboundId}`);
      return workflows.pending.splice(i, 1)[0]!;
    };
    async function raceSetup() {
      const lead = await setup();
      jevByReply = RACE_JEV;
      return lead;
    }
    /** Another canary lead in the same org (seedOrg runs once per test). */
    async function addRaceLead() {
      const l = await seedLead();
      await pg.query("update ai_responder_configs set routing_v2_flags = jsonb_set(routing_v2_flags, '{canary_property_ids}', (routing_v2_flags->'canary_property_ids') || to_jsonb($2::text)) where org_id = $1", [orgId, l.propertyId]);
      await supabase.from("messages").insert({ org_id: orgId, channel: "sms", direction: "outbound", status: "delivered", property_id: l.propertyId, contact_id: l.contactId, from_address: MOCK_SENDER_PRIMARY, to_address: l.phone, body: "Hi, would you sell 2 Vee Ln?", created_at: new Date(Date.now() - 3600_000).toISOString() });
      return l;
    }
    /** A routed (book drip) with its reply still queued (the seller's window closed for now). */
    async function aRoutedReplyQueued(lead: Awaited<ReturnType<typeof seedLead>>) {
      recipientWindow.open = false;
      const a = await say(lead, A_TEXT);
      await runWorkflows();
      expect(await enrollments(lead.propertyId)).toEqual([{ k: "book_appointment", status: "active", r: null }]);
      recipientWindow.open = true;
      return a;
    }
    /** The newest text B won: routed, only its drip active, its reply sent once, nobody held, no reply_skipped. */
    async function expectBWon(lead: Awaited<ReturnType<typeof seedLead>>, b: string) {
      await settle();
      await runRoutingV2OutboxReplies(supabase, { propertyId: lead.propertyId, limit: 10 });
      expect(await stampOf(b)).toMatchObject({ o: "auto_closed", r: "routing_v2:not_interested_drip" });
      expect((await enrollments(lead.propertyId)).filter((e) => e.status === "active")).toEqual([{ k: "not_interested", status: "active", r: null }]);
      expect(await count("select count(*)::int n from sequence_enrollments where property_id = $1 and status = 'paused'", [lead.propertyId])).toBe(0);
      const p = await prop(lead.propertyId);
      expect(p.needs_human_attention).toBe(false);
      expect(p.last_ai_escalation_reason ?? "").not.toMatch(/^reply_skipped/);
      expect(sentTo(lead.phone).filter((m) => m.body === v2ReplyText("not_interested"))).toHaveLength(1);
    }
    afterEach(() => clearTestBarriers());
    /** Runs a forced-order case FORCED_REPEAT times, each on a fresh lead; every failure is listed. */
    async function forcedRun(body: (lead: Awaited<ReturnType<typeof seedLead>>) => Promise<void>) {
      const failures: string[] = [];
      for (let i = 0; i < FORCED_REPEAT; i++) {
        const lead = i === 0 ? await raceSetup() : await addRaceLead();
        jevByReply = RACE_JEV; recipientWindow.open = true; propertyWindow.openCalls = null; workflows.pending.length = 0;
        try { await body(lead); } catch (e) {
          failures.push(`${i}: ${e instanceof Error ? e.message.split("\n")[0] : String(e)}`);
        } finally { clearTestBarriers(); }
      }
      expect(failures).toEqual([]);
    }
    const forced = (name: string, body: (lead: Awaited<ReturnType<typeof seedLead>>) => Promise<void>) =>
      it(`${name} [x${FORCED_REPEAT}]`, () => forcedRun(body), 3_600_000);

    forced("M1(i): A's whole flow before B: B wins", async (lead) => {
      await say(lead, A_TEXT); await runWorkflows(); await deliver();
      const b = await say(lead, B_TEXT); await runWorkflows();
      await expectBWon(lead, b);
    });

    forced("M1(ii): B is inserted (webhook held at webhook:inserted) while A's transition runs: A is superseded, B wins", async (lead) => {
      const a = await say(lead, A_TEXT);
      const g = gate("webhook:inserted", (c) => c.inboundMessageId !== a);
      const bWebhook = say(lead, B_TEXT);
      await g.reached;
      await runWorkflows();                       // A's transition: B already exists
      expect(await stampOf(a)).toMatchObject({ o: "skipped", r: "superseded_by_newer_inbound" });
      g.release(); const b = await bWebhook; await runWorkflows();
      await expectBWon(lead, b);
    });

    forced("M1(iii): A's reply held at outbox:presend_after_evidence until B is inserted, released before B stamps: A cancelled, NO hold, B wins", async (lead) => {
      const a = await aRoutedReplyQueued(lead);
      const k0 = gate("outbox:presend_after_evidence", (c) => c.inboundMessageId === a);
      const delivery = runRoutingV2OutboxReplies(supabase, { propertyId: lead.propertyId, limit: 10 });
      await k0.reached;
      const stamp = gate("webhook:before_stamp", (c) => c.inboundMessageId !== a);
      const bWebhook = say(lead, B_TEXT);
      await stamp.reached;                        // B inserted, not stamped
      k0.release(); await delivery;
      expect((await prop(lead.propertyId)).needs_human_attention).toBe(false);
      stamp.release(); const b = await bWebhook; await runWorkflows();
      expect(sentTo(lead.phone).filter((m) => m.body !== v2ReplyText("not_interested")).filter((m) => m.body !== "Hi, would you sell 2 Vee Ln?")).toHaveLength(0);
      await expectBWon(lead, b);
    });

    forced("M1(iv): A's reply released while B's dispatch is past its early gate (claim processing): A cancelled, NO hold, B wins", async (lead) => {
      const a = await aRoutedReplyQueued(lead);
      const k0 = gate("outbox:presend_after_evidence", (c) => c.inboundMessageId === a);
      const delivery = runRoutingV2OutboxReplies(supabase, { propertyId: lead.propertyId, limit: 10 });
      await k0.reached;
      const b = await say(lead, B_TEXT);
      const early = gate("dispatch:after_early_gate", (c) => c.inboundMessageId === b);
      const w = takeWorkflow(b);
      const bDispatch = w.fn(w.params);
      await early.reached;
      k0.release(); await delivery;
      expect((await prop(lead.propertyId)).needs_human_attention).toBe(false);
      early.release(); await bDispatch;
      await expectBWon(lead, b);
    });

    forced("M1(v): A's reply is refused at its send (window closed) and its mechanics hold is attempted between B's insert and B's early gate: superseded, NO hold, B wins", async (lead) => {
      recipientWindow.open = false;
      jevByReply = { ...RACE_JEV, [A_TEXT]: { text_only: 0.95 } };   // a reply-only road: its refusal would hold
      const a = await say(lead, A_TEXT); await runWorkflows();
      recipientWindow.open = true;
      const ins = gate("webhook:inserted", (c) => c.inboundMessageId !== a);
      const bWebhook = say(lead, B_TEXT);
      await ins.reached;
      propertyWindow.openCalls = 1;   // open at prepare, closed at the send: A's reply is refused
      await runRoutingV2OutboxReplies(supabase, { propertyId: lead.propertyId, limit: 10 });  // A refused -> mechanics hold -> superseded
      propertyWindow.openCalls = null;
      expect((await box(a)).status).toBe("cancelled");
      expect((await prop(lead.propertyId)).needs_human_attention).toBe(false);
      ins.release(); const b = await bWebhook; await runWorkflows();
      await expectBWon(lead, b);
    });

    forced("M2(i): reply vs tick, the tick passes its send check first: <=1 old step, then retired; new road active, no hold", async (lead) => {
      await say(lead, A_TEXT); await runWorkflows(); await deliver();
      await pg.query("begin; set local session_replication_role = replica; update public.sequence_enrollments set next_run_at = least(now(), '" + new Date().toISOString() + "'::timestamptz) - interval '1 minute' where property_id = '" + lead.propertyId + "' and status = 'active'; commit;");
      const before = sentTo(lead.phone).length;
      const t = gate("tick:after_send_check", (c) => c.propertyId === lead.propertyId);
      const { runSequenceTick } = await import("@/app/api/cron/sequence-tick/handlers");
      const tick = runSequenceTick(supabase as never, { budgetMs: 20_000 });
      await t.reached;
      const b = await say(lead, B_TEXT);
      t.release(); await tick;
      await runWorkflows();
      const oldSteps = sentTo(lead.phone).slice(before).filter((m) => /book_appointment/.test(m.body));
      expect(oldSteps.length).toBeLessThanOrEqual(1);
      await expectBWon(lead, b);
      expect(await enrollments(lead.propertyId)).toContainEqual({ k: "book_appointment", status: "completed", r: "rerouted" });
    });

    forced("M2(ii): reply vs tick, the transition goes first: 0 old steps; new road active, no hold", async (lead) => {
      await say(lead, A_TEXT); await runWorkflows(); await deliver();
      const b = await say(lead, B_TEXT); await runWorkflows();
      await pg.query("begin; set local session_replication_role = replica; update public.sequence_enrollments set next_run_at = least(now(), '" + new Date().toISOString() + "'::timestamptz) - interval '1 minute' where property_id = '" + lead.propertyId + "' and status = 'active' and routing_v2_inbound_id is distinct from '" + b + "'; commit;");
      const before = sentTo(lead.phone).length;
      const { runSequenceTick } = await import("@/app/api/cron/sequence-tick/handlers");
      await runSequenceTick(supabase as never, { budgetMs: 20_000 });
      expect(sentTo(lead.phone).slice(before).filter((m) => /book_appointment/.test(m.body))).toHaveLength(0);
      await expectBWon(lead, b);
    });

    forced("M3: the second text +0.4 s while the first reply is in presend, held across B's whole webhook and dispatch: no reply_skipped anywhere, B wins", async (lead) => {
      const a = await aRoutedReplyQueued(lead);
      const k0 = gate("outbox:presend_after_evidence", (c) => c.inboundMessageId === a);
      const delivery = runRoutingV2OutboxReplies(supabase, { propertyId: lead.propertyId, limit: 10 });
      await k0.reached;
      const b = await say(lead, B_TEXT);
      await runWorkflows();                        // B fully routed while A's reply sits in presend
      k0.release(); await delivery;
      await expectBWon(lead, b);
    });

    forced("M4: the new drip's step comes due before its reply is sent: the send check says reply_pending, the drip stays active, 0 drip sends; the reply goes; the next tick sends step 1", async (lead) => {
      recipientWindow.open = false;
      const b = await say(lead, B_TEXT); await runWorkflows();
      await pg.query("begin; set local session_replication_role = replica; update public.sequence_enrollments set next_run_at = least(now(), '" + new Date().toISOString() + "'::timestamptz) - interval '1 minute' where property_id = '" + lead.propertyId + "' and status = 'active'; commit;");
      const { runSequenceTick } = await import("@/app/api/cron/sequence-tick/handlers");
      await runSequenceTick(supabase as never, { budgetMs: 20_000 });
      expect(await enrollments(lead.propertyId)).toEqual([{ k: "not_interested", status: "active", r: null }]);
      expect(sentTo(lead.phone)).toHaveLength(0);
      recipientWindow.open = true;
      await runRoutingV2OutboxReplies(supabase, { propertyId: lead.propertyId, limit: 10 });
      expect(sentTo(lead.phone).map((m) => m.body)).toEqual([v2ReplyText("not_interested")]);
      await pg.query("begin; set local session_replication_role = replica; update public.sequence_enrollments set next_run_at = least(now(), '" + new Date().toISOString() + "'::timestamptz) - interval '1 minute' where property_id = '" + lead.propertyId + "' and status = 'active'; commit;");
      await runSequenceTick(supabase as never, { budgetMs: 20_000 });
      expect(sentTo(lead.phone).map((m) => m.body).slice(1)).toEqual([expect.stringMatching(/^not_interested (one|two)\b/)]);
      expect((await prop(lead.propertyId)).needs_human_attention).toBe(false);
      expect(await stampOf(b)).toMatchObject({ o: "auto_closed" });
    });

    forced("M5 (Jarrad Q2 default): unknown state on a reply+drip road: held nine_reply_not_sent:nine_window_unknown_state, the trigger pauses the drip held_for_person, 0 sends, in the hold list", async (lead) => {
      await pg.query("update properties set state = '' where id = $1", [lead.propertyId]);
      await say(lead, B_TEXT); await runWorkflows(); await deliver();
      expect(await prop(lead.propertyId)).toMatchObject({ needs_human_attention: true, last_ai_escalation_reason: "nine_reply_not_sent:nine_window_unknown_state" });
      expect(await enrollments(lead.propertyId)).toEqual([{ k: "not_interested", status: "paused", r: "held_for_person" }]);
      expect(sentTo(lead.phone)).toHaveLength(0);
      expect(await count("select count(*)::int n from properties where id = $1 and needs_human_attention and not is_dnc_locked", [lead.propertyId])).toBe(1);
    });

    forced("M6: a safety hold (possible stop) lands while the newer text is held at dispatch:before_transition: transition 'held', no reply, no active drip, alerts kept, lead held", async (lead) => {
      await pg.query("update ai_responder_configs set routing_v2_flags = routing_v2_flags || '{\"haiku\": true}'::jsonb where org_id = $1", [orgId]);
      haikuAnswer = { road: "asked_stop", confidence: 0.9 };
      jevByReply = { ...RACE_JEV, "I think I'm all set": { asked_stop: 0.65 } };
      const a = await say(lead, "I think I'm all set");
      const b = await say(lead, B_TEXT);
      const t = gate("dispatch:before_transition", (c) => c.inboundMessageId === b);
      const wb = takeWorkflow(b); const bRun = wb.fn(wb.params);
      await t.reached;
      const wa = takeWorkflow(a); await wa.fn(wa.params);       // the possible-stop hold commits
      expect(await prop(lead.propertyId)).toMatchObject({ needs_human_attention: true, last_ai_escalation_reason: "nine_asked_stop" });
      t.release(); await bRun;
      await deliver();
      expect(await stampOf(b)).toMatchObject({ r: "routing_v2:already_held" });
      expect(await count("select count(*)::int n from sequence_enrollments where property_id = $1 and status = 'active'", [lead.propertyId])).toBe(0);
      expect(sentTo(lead.phone)).toHaveLength(0);
      expect(await count("select count(*)::int n from routing_v2_reply_transitions where inbound_message_id = $1 and decision->>'alerts_only_reason' = 'held'", [b])).toBe(1);
      expect(await prop(lead.propertyId)).toMatchObject({ needs_human_attention: true, last_ai_escalation_reason: "nine_asked_stop" });
    });

    forced("M7 (Jarrad Q1 default): an older mechanics hold, then a newer text: the newer text is routed and the hold cleared (audited mechanics_hold_superseded); its drip active", async (lead) => {
      jevByReply = { ...RACE_JEV, "where are you located?": { where_located: 0.95 } };
      recipientWindow.open = false;
      await say(lead, "where are you located?"); await runWorkflows();
      recipientWindow.open = true;
      propertyWindow.openCalls = 1;   // open at prepare, closed at the send: a reply-only road holds
      await runRoutingV2OutboxReplies(supabase, { propertyId: lead.propertyId, limit: 10 });
      propertyWindow.openCalls = null;
      expect((await prop(lead.propertyId)).needs_human_attention).toBe(true);
      expect((await pg.query("select hold_kind from properties where id = $1", [lead.propertyId])).rows[0].hold_kind).toBe("mechanics");
      const b = await say(lead, B_TEXT); await runWorkflows();
      await expectBWon(lead, b);
      expect(await count("select count(*)::int n from lead_events where property_id = $1 and event_type = 'ai_escalation_cleared' and payload->>'reason' = 'mechanics_hold_superseded'", [lead.propertyId])).toBe(1);
    });

    it.each([
      ["(a) webhook killed after INSERT", {} as Record<string, unknown>, false],
      ["(b) killed after the delayed stamp, no workflow", { processing: { aiResponder: { outcome: "delayed", workflowRunId: "dead-run", scheduledAt: "OLD" } } }, false],
      ["(c) claim lease expired", { processing: { aiResponder: { outcome: "delayed", workflowRunId: "dead-run", scheduledAt: "NOW" } } }, true],
    ] as const)("M8 %s: the older reply is cancelled with NO hold; the sweep then holds the dead newest text (nine_needs_person, safety), one audit row; the trigger pauses the drip; 0 sends", (_label, meta, claim) => forcedRun(async (lead) => {
      const a = await aRoutedReplyQueued(lead);
      // DB clock for the stored times (the sweep ages them on the DB clock, whatever the app's is).
      const { rows: [dbt] } = await pg.query("select (now() - interval '1 hour') as old, now() as cur");
      const resolved = JSON.parse(JSON.stringify(meta).replace('"OLD"', JSON.stringify(new Date(dbt.old).toISOString())).replace('"NOW"', JSON.stringify(new Date(dbt.cur).toISOString())));
      const dead = await newerText(lead, resolved);
      await pg.query("update messages set created_at = now() - interval '30 minutes' where id = $1", [a]);
      await pg.query("update messages set created_at = now() - interval '6 minutes' where id = $1", [dead]);
      if (claim) {
        // A claim is stamped on the DB clock when written (round 17, C); its lease then runs out.
        await pg.query("insert into ai_response_claims (org_id, inbound_message_id, property_id, contact_id, status, lease_expires_at) values ($1,$2,$3,$4,'processing', now() + interval '5 minutes')", [orgId, dead, lead.propertyId, lead.contactId]);
        await pg.query("update ai_response_claims set lease_expires_at = now() - interval '1 hour' where inbound_message_id = $1", [dead]);
      }
      // The per-property delivery runs this lead's sweep step first (round 17, D): the dead newest
      // text is held (safety) right away; A's reply is cancelled, never a mechanics hold for A.
      await runRoutingV2OutboxReplies(supabase, { propertyId: lead.propertyId, limit: 10 });
      expect((await box(a)).status).toBe("cancelled");
      expect(await prop(lead.propertyId)).toMatchObject({ needs_human_attention: true, last_ai_escalation_reason: "nine_needs_person" });
      await runRoutingV2OutboxReplies(supabase, { limit: 10 });                                 // the cron: sweep
      expect(await prop(lead.propertyId)).toMatchObject({ needs_human_attention: true, last_ai_escalation_reason: "nine_needs_person" });
      expect((await pg.query("select hold_kind from properties where id = $1", [lead.propertyId])).rows[0].hold_kind).toBe("safety");
      expect(await auditRows(dead)).toBe(1);
      expect(await count("select count(*)::int n from sequence_enrollments where property_id = $1 and status = 'active'", [lead.propertyId])).toBe(0);
      expect(sentTo(lead.phone)).toHaveLength(0);
    }), 3_600_000);

    it.each([["ABC", [0, 1, 2]], ["ACB", [0, 2, 1]], ["BAC", [1, 0, 2]], ["BCA", [1, 2, 0]], ["CAB", [2, 0, 1]], ["CBA", [2, 1, 0]]] as const)("M9 burst A<B<C, transitions in order %s: C applied, A and B superseded, one active = C's road, no hold", (_name, order) => forcedRun(async (lead) => {
      const ids = [await say(lead, A_TEXT), await say(lead, B_TEXT), await say(lead, C_TEXT)];
      const runs = ids.map((id) => takeWorkflow(id));
      for (const i of order) await runs[i]!.fn(runs[i]!.params);
      await settle(); await runRoutingV2OutboxReplies(supabase, { propertyId: lead.propertyId, limit: 10 });
      expect(await stampOf(ids[2]!)).toMatchObject({ o: "auto_closed", r: "routing_v2:confirmed_owner_drip" });
      expect((await enrollments(lead.propertyId)).filter((e) => e.status === "active")).toEqual([{ k: "confirmed_owner", status: "active", r: null }]);
      expect((await prop(lead.propertyId)).needs_human_attention).toBe(false);
    }), 3_600_000);

    it.each([
      ["markPropertyNeedsAttention (app)", "app"],
      ["routing_v2_write_hold", "write_hold"],
      ["v2 live hold (possible stop)", "live_hold"],
      ["webhook keyword hold", "keyword"],
      ["the sweep", "sweep"],
      ["a person / UI (plain SQL)", "ui"],
    ] as const)("M10 every hold writer pauses the v2 drips in the same transaction: %s", async (_label, writer) => {
      const lead = await raceSetup();
      const b = await say(lead, B_TEXT); await runWorkflows(); await deliver();
      expect(await enrollments(lead.propertyId)).toEqual([{ k: "not_interested", status: "active", r: null }]);
      if (writer === "app") {
        const { markPropertyNeedsAttention } = await import("./dispatch");
        await markPropertyNeedsAttention(supabase, lead.propertyId, "nine_needs_person");
      } else if (writer === "write_hold") {
        await pg.query("select public.routing_v2_write_hold($1,$2,'nine_needs_person','safety')", [lead.propertyId, b]);
      } else if (writer === "live_hold") {
        await pg.query("update ai_responder_configs set routing_v2_flags = routing_v2_flags || '{\"haiku\": true}'::jsonb where org_id = $1", [orgId]);
        haikuAnswer = { road: "asked_stop", confidence: 0.9 };
        jevByReply = { ...RACE_JEV, "I think I'm all set": { asked_stop: 0.65 } };
        await say(lead, "I think I'm all set"); await runWorkflows();
      } else if (writer === "keyword") {
        await say(lead, "can I talk to someone please"); await runWorkflows();
      } else if (writer === "sweep") {
        const dead = await newerText(lead);
        await pg.query("update messages set created_at = now() - interval '10 minutes' where id = $1", [dead]);
        await runRoutingV2OutboxReplies(supabase, { limit: 10 });
      } else {
        await pg.query("update properties set needs_human_attention = true, last_ai_escalation_reason = 'needs_reply' where id = $1", [lead.propertyId]);
      }
      expect((await prop(lead.propertyId)).needs_human_attention).toBe(true);
      const drip = (await enrollments(lead.propertyId)).find((e) => e.k === "not_interested");
      expect(drip).toMatchObject({ status: "paused" });
      expect(["held_for_person", "inbound_reply"]).toContain(drip!.r);
    });

    // Stress §14: a person takes over between the seller's text and the routing commit.
    // (a) the takeover's transaction starts before the transition (its DB stamp, now(), is the
    //     transaction start, as the assignment trigger writes it) and commits after it;
    // (b) the takeover (the real hot-lead takeover writer) commits before the transition.
    it(`M13(a) x${RACE_REPEAT}: takeover stamped before, committed after the routing commit: no auto reply, no active drip, 0 sends`, async () => {
      const failures: string[] = [];
      const first = await raceSetup();
      for (let i = 0; i < RACE_REPEAT; i++) {
        const lead = i === 0 ? first : await addRaceLead();
        const person = new Client({ connectionString: process.env.TEST_SUPABASE_DB_URL });
        await person.connect();
        try {
          const b = await say(lead, A_TEXT);
          const t = gate("dispatch:before_transition", (c) => c.inboundMessageId === b);
          const w = takeWorkflow(b); const run = w.fn(w.params);
          await t.reached;
          await person.query("begin");
          await person.query("select now()");               // the takeover's DB stamp is fixed here
          t.release(); await run;                            // the routing commits (enrolls)
          await person.query("update properties set last_person_takeover_at = now() where id = $1", [lead.propertyId]);
          await person.query("commit");
          await settle();
          await runRoutingV2OutboxReplies(supabase, { propertyId: lead.propertyId, limit: 10 });
          await tickDue(lead);
          expect(sentTo(lead.phone)).toEqual([]);
          expect(await count("select count(*)::int n from sequence_enrollments where property_id = $1 and status = 'active'", [lead.propertyId])).toBe(0);
        } catch (e) {
          failures.push(`${i}: ${e instanceof Error ? e.message.split("\n")[0] : String(e)}`);
        } finally {
          await person.query("rollback").catch(() => {});
          await person.end();
          clearTestBarriers();
        }
      }
      expect(failures).toEqual([]);
    }, 900_000);

    it(`M13(b) x${RACE_REPEAT}: takeover (hot-lead takeover writer) committed between the inbound and the routing: nothing enrolled, no auto reply, 0 sends`, async () => {
      const { pauseHotBookAppointmentOnTakeover } = await import("@/lib/sequences/hot-lead-takeover");
      const failures: string[] = [];
      const first = await raceSetup();
      for (let i = 0; i < RACE_REPEAT; i++) {
        const lead = i === 0 ? first : await addRaceLead();
        try {
          const b = await say(lead, A_TEXT);
          const t = gate("dispatch:before_transition", (c) => c.inboundMessageId === b);
          const w = takeWorkflow(b); const run = w.fn(w.params);
          await t.reached;
          await pauseHotBookAppointmentOnTakeover({ propertyIds: [lead.propertyId], actor: { actorType: "user", actorId: null } as never });
          t.release(); await run;
          await settle();
          await runRoutingV2OutboxReplies(supabase, { propertyId: lead.propertyId, limit: 10 });
          await tickDue(lead);
          expect(await count("select count(*)::int n from sequence_enrollments where property_id = $1", [lead.propertyId])).toBe(0);
          expect(sentTo(lead.phone)).toEqual([]);
        } catch (e) {
          failures.push(`${i}: ${e instanceof Error ? e.message.split("\n")[0] : String(e)}`);
        } finally {
          clearTestBarriers();
        }
      }
      expect(failures).toEqual([]);
    }, 900_000);

    // Review B-1 (3288da8ef6b3): a seller-words hold stacked on our own mechanics hold must not
    // keep the mechanics label, or the next text clears it.
    async function mechanicsHoldOnA(lead: Awaited<ReturnType<typeof seedLead>>) {
      jevByReply = { ...RACE_JEV, "where are you located?": { where_located: 0.95 } };
      recipientWindow.open = false;
      await say(lead, "where are you located?"); await runWorkflows();
      recipientWindow.open = true;
      propertyWindow.openCalls = 1;   // open at prepare, closed at the send: refused -> mechanics hold
      await runRoutingV2OutboxReplies(supabase, { propertyId: lead.propertyId, limit: 10 });
      propertyWindow.openCalls = null;
      expect((await pg.query("select needs_human_attention h, hold_kind k from properties where id = $1", [lead.propertyId])).rows[0]).toEqual({ h: true, k: "mechanics" });
    }
    async function expectCStaysHeld(lead: Awaited<ReturnType<typeof seedLead>>, reason: string) {
      const before = sentTo(lead.phone).length;
      const c = await say(lead, B_TEXT); await runWorkflows();
      await settle();
      await runRoutingV2OutboxReplies(supabase, { propertyId: lead.propertyId, limit: 10 });
      await tickDue(lead);
      // Held at the early gate (rule 0: the hold no longer yields) or, if it raced past it, at the transition.
      const stamp = await stampOf(c);
      // (or, with a rep text still the latest outbound, C is itself a rep takeover: also held, no reply)
      expect(stamp.o === "skipped:rule_0" || stamp.r === "routing_v2:already_held" || (stamp.o === "escalated" && stamp.r === "rep_sms_human_takeover")).toBe(true);
      expect(await prop(lead.propertyId)).toMatchObject({ needs_human_attention: true, last_ai_escalation_reason: reason });
      expect((await pg.query("select hold_kind from properties where id = $1", [lead.propertyId])).rows[0].hold_kind).toBe("safety");
      expect(await count("select count(*)::int n from sequence_enrollments where property_id = $1 and status = 'active'", [lead.propertyId])).toBe(0);
      expect(sentTo(lead.phone).slice(before)).toEqual([]);
      expect(await count("select count(*)::int n from lead_events where property_id = $1 and event_type = 'ai_escalation_cleared' and payload->>'reason' = 'mechanics_hold_superseded'", [lead.propertyId])).toBe(0);
    }
    forced("M14: mechanics hold (A's reply refused), then a possible stop (B), then any text (C): C stays held, no reply, no drip", async (lead) => {
      await pg.query("update ai_responder_configs set routing_v2_flags = routing_v2_flags || '{\"haiku\": true}'::jsonb where org_id = $1", [orgId]);
      await mechanicsHoldOnA(lead);
      haikuAnswer = { road: "asked_stop", confidence: 0.9 };
      jevByReply = { ...RACE_JEV, "I think I'm all set": { asked_stop: 0.65 } };
      await say(lead, "I think I'm all set"); await runWorkflows();
      await expectCStaysHeld(lead, "nine_asked_stop");
    });
    forced("M15: mechanics hold (A's reply refused), then a keyword hold (B), then any text (C): C stays held, no reply, no drip", async (lead) => {
      await mechanicsHoldOnA(lead);
      await say(lead, "can I talk to someone please"); await runWorkflows();
      const reason = (await prop(lead.propertyId)).last_ai_escalation_reason as string;
      expect(reason).not.toMatch(/^nine_reply_not_sent/);
      await expectCStaysHeld(lead, reason);
    });

    // Review B-1' (251a3321672a): a rep (Maria-through-Mel) texting a lead held only for our own
    // unsent reply; the seller's answer is a rep takeover; the next seller text must not clear it.
    forced("M16: mechanics hold (A's reply refused), then a rep SMS, then the seller (B, rep takeover), then C: C stays held, no reply, no drip", async (lead) => {
      await mechanicsHoldOnA(lead);
      const { rows: [a] } = await pg.query("select conversation_id from messages where property_id = $1 and direction = 'inbound' order by created_at desc limit 1", [lead.propertyId]);
      await supabase.from("messages").insert({
        org_id: orgId, channel: "sms", direction: "outbound", status: "sent", property_id: lead.propertyId, contact_id: lead.contactId,
        conversation_id: a.conversation_id, from_address: MOCK_SENDER_PRIMARY, to_address: lead.phone, body: "rep text (test)",
        // The rep text went out just before the seller's reply on every clock the webhook compares
        // (the DB's, and the provider/app event time).
        // The rep's send is stamped by the DB (send.ts writes sent_at = 'now').
        sent_at: new Date(new Date((await pg.query("select now() as t")).rows[0].t).getTime() - 1000).toISOString(),
        metadata: { repSms: { workflow: "maria-through-mel", persona: "Mel", assistant: "Maria", actorUserId: randomUUID(), senderAssignmentId: randomUUID() } },
      });
      const b = await say(lead, "ok call me tomorrow"); await runWorkflows();
      expect(await prop(lead.propertyId)).toMatchObject({ needs_human_attention: true, last_ai_escalation_reason: "rep_sms_human_takeover" });
      await settle();
      expect(await auditRows(b)).toBe(1);   // AUD: one audit row per inbound, the rep takeover too
      await expectCStaysHeld(lead, "rep_sms_human_takeover");
    });

    // Astra review of 921b71c2a133 (P1 #1): a safety hold committed between the reply's authorization
    // and the final SQL fence refuses the send (held_for_person).
    const M17_REPEAT = Number(process.env.M17_REPEAT ?? 20);
    it(`M17 x${M17_REPEAT}: a hold committed after the reply is authorized but before the provider fence: no send, cancelled held_for_person, lead held`, async () => {
      const failures: string[] = [];
      const first = await raceSetup();
      for (let i = 0; i < M17_REPEAT; i++) {
        const lead = i === 0 ? first : await addRaceLead();
        jevByReply = RACE_JEV; recipientWindow.open = true; workflows.pending.length = 0;
        try {
          const a = await aRoutedReplyQueued(lead);
          const f = gate("outbox:before_fence", (c) => c.inboundMessageId === a);
          const delivery = runRoutingV2OutboxReplies(supabase, { propertyId: lead.propertyId, limit: 10 });
          await f.reached;
          await pg.query("update properties set needs_human_attention = true, last_ai_escalation_reason = 'needs_reply' where id = $1", [lead.propertyId]);
          f.release(); await delivery;
          expect(sentTo(lead.phone)).toEqual([]);
          expect(await box(a)).toMatchObject({ status: "cancelled" });
          expect((await pg.query("select cancel_reason from routing_v2_outbox where inbound_message_id = $1 and kind = 'reply'", [a])).rows[0].cancel_reason).toBe("held_for_person");
          expect((await prop(lead.propertyId)).needs_human_attention).toBe(true);
        } catch (e) {
          failures.push(`${i}: ${e instanceof Error ? e.message.split("\n")[0] : String(e)}`);
        } finally { clearTestBarriers(); }
      }
      expect(failures).toEqual([]);
    }, 900_000);

    // Astra P1 #2: v2 left a mechanics hold, then every v2 flag is turned off: the hold is terminal
    // for the legacy path (only the v2 transition clears it).
    forced("M18: v2 leaves a mechanics hold, then all v2 flags off, then a newer text: terminal (rule 0), no send, still held", async (lead) => {
      await mechanicsHoldOnA(lead);
      const { rows: [cfg] } = await pg.query("select routing_v2_flags from ai_responder_configs where org_id = $1", [orgId]);
      try {
        await pg.query("update ai_responder_configs set routing_v2_flags = '{}'::jsonb where org_id = $1", [orgId]);
        const before = sentTo(lead.phone).length;
        const b = await say(lead, B_TEXT); await runWorkflows(); await settle();
        await runRoutingV2OutboxReplies(supabase, { propertyId: lead.propertyId, limit: 10 });
        expect(await stampOf(b)).toMatchObject({ o: "skipped:rule_0" });
        expect(sentTo(lead.phone).slice(before)).toEqual([]);
        expect(await prop(lead.propertyId)).toMatchObject({ needs_human_attention: true });
      } finally {
        await pg.query("update ai_responder_configs set routing_v2_flags = $2::jsonb where org_id = $1", [orgId, JSON.stringify(cfg.routing_v2_flags)]);
      }
    });

    // Astra P1 #3: the DB-clock takeover stamp fails and the app clock is an hour behind: the
    // fallback must still be later than the seller's text (DB time), so the drip never texts.
    forced("M19: takeover while the DB-clock stamp is unavailable and the app clock is 1 h behind: the drip is paused (person_took_over), 0 drip sends", async (lead) => {
      await say(lead, A_TEXT); await runWorkflows(); await deliver();
      expect(await enrollments(lead.propertyId)).toEqual([{ k: "book_appointment", status: "active", r: null }]);
      const before = sentTo(lead.phone).length;
      const { pauseHotBookAppointmentOnTakeover } = await import("@/lib/sequences/hot-lead-takeover");
      await pg.query("revoke execute on function public.routing_v2_mark_person_takeover(uuid) from service_role");
      const RealDate = Date;
      class Behind extends RealDate {
        constructor(...args: unknown[]) { if (args.length === 0) super(RealDate.now() - 3600_000); else super(...(args as [string])); }
        static now() { return RealDate.now() - 3600_000; }
      }
      try {
        globalThis.Date = Behind as DateConstructor;
        await pauseHotBookAppointmentOnTakeover({ propertyIds: [lead.propertyId], actor: { actorType: "user", actorId: null } as never });
      } finally {
        globalThis.Date = RealDate;
        await pg.query("grant execute on function public.routing_v2_mark_person_takeover(uuid) to service_role");
      }
      const { rows: [t] } = await pg.query("select p.last_person_takeover_at > m.created_at as after from properties p join messages m on m.property_id = p.id and m.direction = 'inbound' where p.id = $1 order by m.created_at desc limit 1", [lead.propertyId]);
      expect(t.after).toBe(true);
      await tickDue(lead);
      expect(sentTo(lead.phone).slice(before)).toEqual([]);
      expect(await count("select count(*)::int n from sequence_enrollments where property_id = $1 and status = 'active'", [lead.propertyId])).toBe(0);
    });

    // Opus review of 93a8070932bd (B1): the "is v2 live" read fails once for B. The decision is made
    // once (strict): an error is "not live", so the older mechanics hold stays terminal and the
    // legacy road never answers the held lead.
    forced("M20: mechanics hold, then the v2-live read fails once for the newer text: B stays held, 0 sends, no reply or drip", async (lead) => {
      await mechanicsHoldOnA(lead);
      const before = sentTo(lead.phone).length;
      setTestFault("dispatch:v2_live_read", (c) => c.propertyId === lead.propertyId);
      const b = await say(lead, B_TEXT); await runWorkflows(); await settle();
      await runRoutingV2OutboxReplies(supabase, { propertyId: lead.propertyId, limit: 10 });
      await tickDue(lead);
      expect(sentTo(lead.phone).slice(before)).toEqual([]);
      expect((await prop(lead.propertyId)).needs_human_attention).toBe(true);
      expect(await count("select count(*)::int n from sequence_enrollments where property_id = $1 and status = 'active'", [lead.propertyId])).toBe(0);
      expect(await count("select count(*)::int n from routing_v2_outbox where inbound_message_id = $1 and kind = 'reply'", [b])).toBe(0);
    });

    // Astra review of a0c905d42390 (P1 #1): a possible-stop decision is stored, then the worker dies
    // before its hold. A newer ordinary text routes nothing; the sweep then lands the hold.
    forced("M21: decision stored, worker dies before its hold: the newer text routes nothing (0 sends, no drip); the sweep holds the lead", async (lead) => {
      await pg.query("update ai_responder_configs set routing_v2_flags = routing_v2_flags || '{\"haiku\": true}'::jsonb where org_id = $1", [orgId]);
      haikuAnswer = { road: "asked_stop", confidence: 0.9 };
      jevByReply = { ...RACE_JEV, "I think I'm all set": { asked_stop: 0.65 } };
      const a = await say(lead, "I think I'm all set");
      const dead = gate("dispatch:after_decision", (c) => c.inboundMessageId === a);
      const wa = takeWorkflow(a); void wa.fn(wa.params).catch(() => {});   // the worker "dies" at the barrier (never released)
      await dead.reached;
      // Round 17 (A): the safety decision and its hold commit together, so the lead is already held
      // when the worker dies after the decision.
      expect(await prop(lead.propertyId)).toMatchObject({ needs_human_attention: true });
      const b = await say(lead, B_TEXT); await runWorkflows(); await settle();
      await runRoutingV2OutboxReplies(supabase, { propertyId: lead.propertyId, limit: 10 });
      await tickDue(lead);
      expect(sentTo(lead.phone)).toEqual([]);
      expect(await count("select count(*)::int n from sequence_enrollments where property_id = $1 and status = 'active'", [lead.propertyId])).toBe(0);
      const bStamp = await stampOf(b);
      expect(bStamp.o === "skipped:rule_0" || bStamp.r === "routing_v2:already_held").toBe(true);
      // The dead run's lease runs out; the next cron pass lands the hold.
      await pg.query("update ai_response_claims set lease_expires_at = now() - interval '1 hour' where inbound_message_id = $1", [a]);
      await pg.query("update messages set created_at = now() - interval '10 minutes' where id = $1", [a]);
      await runRoutingV2OutboxReplies(supabase, { limit: 10 });
      expect(await prop(lead.propertyId)).toMatchObject({ needs_human_attention: true });
      expect((await pg.query("select hold_kind from properties where id = $1", [lead.propertyId])).rows[0].hold_kind).toBe("safety");
    });

    // Astra P1 #2: the reply on a reply+drip road is cancelled, then the worker dies before the hold:
    // the drip must not send; the cron lands the hold.
    forced("M22: reply cancelled, worker dies before its hold: the due drip sends nothing (reply_pending); the cron writes the hold and the drip pauses", async (lead) => {
      recipientWindow.open = false;
      const b = await say(lead, B_TEXT); await runWorkflows();
      expect(await enrollments(lead.propertyId)).toEqual([{ k: "not_interested", status: "active", r: null }]);
      const { rows: [gone] } = await pg.query("delete from auto_reply_templates where org_id = $1 and outcome = 'not_interested' returning template_id", [orgId]); // the reply cannot be prepared
      recipientWindow.open = true;
      try {
      const dead = gate("outbox:before_hold", (c) => c.inboundMessageId === b);
      void runRoutingV2OutboxReplies(supabase, { propertyId: lead.propertyId, limit: 10 }).catch(() => {});
      await dead.reached;                                   // cancelled; the hold never comes from this worker
      expect((await box(b)).status).toBe("cancelled");
      await tickDue(lead);
      expect(sentTo(lead.phone)).toEqual([]);
      await runRoutingV2OutboxReplies(supabase, { limit: 10 });   // the cron: holds_due
      expect((await prop(lead.propertyId)).needs_human_attention).toBe(true);
      expect(await count("select count(*)::int n from sequence_enrollments where property_id = $1 and status = 'active'", [lead.propertyId])).toBe(0);
      await tickDue(lead);
      expect(sentTo(lead.phone)).toEqual([]);
      } finally {
        await pg.query("begin");
        await pg.query("select set_config('sandra.template_approval', 'on', true)");
        await pg.query("insert into public.auto_reply_templates (org_id, outcome, template_id) values ($1, 'not_interested', $2)", [orgId, gone.template_id]);
        await pg.query("commit");
      }
    });

    // Astra P2 #3: the 24 h reply age is decided on the DB clock, whatever the app clock says.
    it.each([
      ["DB age 23.5 h, app clock 1 h ahead: still sent", 23.5, 3600_000, true],
      ["DB age 24.5 h, app clock 1 h behind: refused (expired), the lead held", 24.5, -3600_000, false],
    ] as const)("M23 %s", (_label, ageHours, appSkew, sent) => forcedRun(async (lead) => {
      recipientWindow.open = false;
      const b = await say(lead, B_TEXT); await runWorkflows();
      recipientWindow.open = true;
      await pg.query("update routing_v2_outbox set created_at = now() - make_interval(secs => $2) where inbound_message_id = $1", [b, ageHours * 3600]);
      const RealDate = Date;
      class Skewed extends RealDate {
        constructor(...args: unknown[]) { if (args.length === 0) super(RealDate.now() + appSkew); else super(...(args as [string])); }
        static now() { return RealDate.now() + appSkew; }
      }
      try {
        globalThis.Date = Skewed as DateConstructor;
        await runRoutingV2OutboxReplies(supabase, { propertyId: lead.propertyId, limit: 10 });
      } finally { globalThis.Date = RealDate; }
      if (sent) {
        expect(sentTo(lead.phone).map((m) => m.body)).toEqual([v2ReplyText("not_interested")]);
      } else {
        expect(sentTo(lead.phone)).toEqual([]);
        expect((await box(b)).status).toBe("cancelled");
        await runRoutingV2OutboxReplies(supabase, { limit: 10 });
        expect((await prop(lead.propertyId)).needs_human_attention).toBe(true);
      }
    }), 3_600_000);

    // Opus + Fable reviews of 531f2034f581 (B1): after the sweep handled a dead run and a person
    // cleared the hold, the lead's next ordinary text routes exactly as on a clean lead.
    forced("M24: worker dies after a stop decision, the sweep holds, a person clears the hold, then an ordinary text routes normally (1 reply, its drip active)", async (lead) => {
      await pg.query("update ai_responder_configs set routing_v2_flags = routing_v2_flags || '{\"haiku\": true}'::jsonb where org_id = $1", [orgId]);
      haikuAnswer = { road: "asked_stop", confidence: 0.9 };
      jevByReply = { ...RACE_JEV, "I think I'm all set": { asked_stop: 0.65 } };
      const a = await say(lead, "I think I'm all set");
      const dead = gate("dispatch:after_decision", (c) => c.inboundMessageId === a);
      const wa = takeWorkflow(a); void wa.fn(wa.params).catch(() => {});
      await dead.reached;
      await pg.query("update ai_response_claims set lease_expires_at = now() - interval '1 hour' where inbound_message_id = $1", [a]);
      await pg.query("update messages set created_at = now() - interval '10 minutes' where id = $1", [a]);
      await runRoutingV2OutboxReplies(supabase, { limit: 10 });          // the sweep holds and closes the dead claim
      expect((await prop(lead.propertyId)).needs_human_attention).toBe(true);
      expect((await pg.query("select status, error_message from ai_response_claims where inbound_message_id = $1", [a])).rows[0]).toEqual({ status: "error", error_message: "lease_dead_swept" });
      await pg.query("update properties set needs_human_attention = false where id = $1", [lead.propertyId]);   // a person clears it
      haikuAnswer = null;
      const c = await say(lead, B_TEXT); await runWorkflows(); await settle();
      await runRoutingV2OutboxReplies(supabase, { propertyId: lead.propertyId, limit: 10 });
      expect(await stampOf(c)).toMatchObject({ o: "auto_closed", r: "routing_v2:not_interested_drip" });
      expect(sentTo(lead.phone).filter((m) => m.body === v2ReplyText("not_interested"))).toHaveLength(1);
      expect((await enrollments(lead.propertyId)).filter((e) => e.status === "active")).toEqual([{ k: "not_interested", status: "active", r: null }]);
      expect((await prop(lead.propertyId)).needs_human_attention).toBe(false);
    });

    // ---- Astra third review of b6a00a0a2f17 (round 17) ----
    const withHoldRefused = async <T,>(propertyId: string, run: () => Promise<T>): Promise<T> => {
      const fn = `refuse_hold_${propertyId.replace(/-/g, "")}`;
      await pg.query(`create or replace function public.${fn}() returns trigger language plpgsql as $f$ begin if new.id = '${propertyId}' and new.needs_human_attention then raise exception 'forced hold failure (test)'; end if; return new; end $f$`);
      await pg.query(`create trigger ${fn} before update of needs_human_attention on public.properties for each row execute function public.${fn}()`);
      try { return await run(); } finally {
        await pg.query(`drop trigger if exists ${fn} on public.properties`);
        await pg.query(`drop function if exists public.${fn}()`);
      }
    };
    const legacySafetyDecision = async (lead: Awaited<ReturnType<typeof seedLead>>, body: string, claim: "dead" | "flag_failed") => {
      const { rows: [m] } = await pg.query("insert into messages (org_id, property_id, contact_id, direction, channel, status, body, from_address, to_address, created_at) values ($1,$2,$3,'inbound','sms','received',$4,$5,$6, now() - interval '2 hours') returning id",
        [orgId, lead.propertyId, lead.contactId, body, lead.phone, MOCK_SENDER_PRIMARY]);
      await pg.query("insert into routing_v2_live_decisions (org_id, property_id, inbound_message_id, status, road, expected_revision, action) values ($1,$2,$3,'decided','stop',0,$4)",
        [orgId, lead.propertyId, m.id, JSON.stringify({ road: "stop", steps: [{ kind: "hold", reason: "asked_stop" }] })]);
      await pg.query("insert into ai_response_claims (org_id, inbound_message_id, property_id, contact_id, status, error_message, lease_expires_at) values ($1,$2,$3,$4,$5,$6, now() - interval '2 hours')",
        [orgId, m.id, lead.propertyId, lead.contactId, claim === "dead" ? "processing" : "error", claim === "dead" ? null : "flag_failed"]);
      await pg.query("update ai_response_claims set lease_expires_at = now() - interval '2 hours', updated_at = now() - interval '2 hours' where inbound_message_id = $1", [m.id]);
      return m.id as string;
    };
    forced("M25: a possible stop whose hold cannot be written: no decision row, claim v2_safety_hold_failed, the newer text blocked (0 sends); once writes work the per-property delivery holds the lead", async (lead) => {
      await pg.query("update ai_responder_configs set routing_v2_flags = routing_v2_flags || '{\"haiku\": true}'::jsonb where org_id = $1", [orgId]);
      haikuAnswer = { road: "asked_stop", confidence: 0.9 };
      jevByReply = { ...RACE_JEV, "I think I'm all set": { asked_stop: 0.65 } };
      const a = await withHoldRefused(lead.propertyId, async () => {
        const id = await say(lead, "I think I'm all set"); await runWorkflows(); await settle();
        return id;
      });
      // no decision row (only the after-response audit row, status not_routed)
      expect(await count("select count(*)::int n from routing_v2_live_decisions where inbound_message_id = $1 and status <> 'not_routed'", [a])).toBe(0);
      expect((await pg.query("select status, error_message from ai_response_claims where inbound_message_id = $1", [a])).rows[0]).toEqual({ status: "error", error_message: "v2_safety_hold_failed" });
      haikuAnswer = null;
      const b = await withHoldRefused(lead.propertyId, async () => { const id = await say(lead, B_TEXT); await runWorkflows(); await settle(); return id; });
      expect(await stampOf(b)).toMatchObject({ r: "routing_v2:already_held" });
      expect(sentTo(lead.phone)).toEqual([]);
      await runRoutingV2OutboxReplies(supabase, { propertyId: lead.propertyId, limit: 10 });   // per-property: the sweep step runs first
      expect((await prop(lead.propertyId)).needs_human_attention).toBe(true);
      expect(sentTo(lead.phone)).toEqual([]);
      expect(await count("select count(*)::int n from sequence_enrollments where property_id = $1 and status = 'active'", [lead.propertyId])).toBe(0);
    });
    forced("M26: an unrecovered (legacy-style) safety decision, its run dead for 2 h and the cron down: the newer text is still blocked; the per-property delivery recovers it (hold)", async (lead) => {
      const a = await legacySafetyDecision(lead, "stop texting me maybe", "dead");
      const b = await say(lead, B_TEXT); await runWorkflows(); await settle();
      expect(await stampOf(b)).toMatchObject({ r: "routing_v2:already_held" });
      await runRoutingV2OutboxReplies(supabase, { propertyId: lead.propertyId, limit: 10 });   // no cron: the per-property step
      expect(sentTo(lead.phone)).toEqual([]);
      expect((await prop(lead.propertyId)).needs_human_attention).toBe(true);
      expect((await pg.query("select metadata->'processing'->'routingV2Sweep'->>'result' r from messages where id = $1", [a])).rows[0].r).toBe("held");
    });
    forced("M27: a safety decision whose hold write failed (claim error/flag_failed): the newer text is blocked until the sweep recovers it", async (lead) => {
      await legacySafetyDecision(lead, "lawyer letter coming", "flag_failed");
      const b = await say(lead, B_TEXT); await runWorkflows(); await settle();
      expect(await stampOf(b)).toMatchObject({ r: "routing_v2:already_held" });
      expect(sentTo(lead.phone)).toEqual([]);
      await runRoutingV2OutboxReplies(supabase, { propertyId: lead.propertyId, limit: 10 });
      expect((await prop(lead.propertyId)).needs_human_attention).toBe(true);
      expect(sentTo(lead.phone)).toEqual([]);
    });
    forced("M28: a rep text (DB-clock sent_at), then the seller replies while the app clock is 1 h behind: still a rep takeover (hold rep_sms_human_takeover), 0 sends", async (lead) => {
      // A first seller text opens the conversation; the rep then writes in it.
      const first = await say(lead, "hello?"); await runWorkflows(); await deliver();
      const { rows: [c2] } = await pg.query("select conversation_id from messages where id = $1", [first]);
      const before = sentTo(lead.phone).length;
      await pg.query("update properties set needs_human_attention = false where id = $1", [lead.propertyId]);
      await pg.query("insert into messages (org_id, channel, direction, status, property_id, contact_id, conversation_id, from_address, to_address, body, sent_at, metadata) values ($1,'sms','outbound','sent',$2,$3,$4,$5,$6,'rep text (test)', now() - interval '1 second', $7)",
        [orgId, lead.propertyId, lead.contactId, c2.conversation_id, MOCK_SENDER_PRIMARY, lead.phone, JSON.stringify({ repSms: { workflow: "maria-through-mel", persona: "Mel", assistant: "Maria", actorUserId: randomUUID(), senderAssignmentId: randomUUID() } })]);
      const RealDate = Date;
      class Behind extends RealDate {
        constructor(...args: unknown[]) { if (args.length === 0) super(RealDate.now() - 3600_000); else super(...(args as [string])); }
        static now() { return RealDate.now() - 3600_000; }
      }
      let b: string;
      try { globalThis.Date = Behind as DateConstructor; b = await say(lead, "ok call me tomorrow"); }
      finally { globalThis.Date = RealDate; }
      await runWorkflows(); await settle();
      expect(await prop(lead.propertyId)).toMatchObject({ needs_human_attention: true, last_ai_escalation_reason: "rep_sms_human_takeover" });
      expect(await stampOf(b!)).toMatchObject({ o: "escalated" });
      expect(sentTo(lead.phone).slice(before)).toEqual([]);
    });

    forced("M29: a keyword (legal / needs-person) text whose hold cannot be written: not marked escalated (webhook retryable), the newer text blocked, 0 sends; the per-property delivery then holds the lead", async (lead) => {
      const kw = "can I talk to someone please";
      // Webhook path: the webhook fails (retryable) and the text is not marked escalated. Dispatch
      // path: the claim records flag_failed (never handled). Either way it failed closed.
      await withHoldRefused(lead.propertyId, async () => {
        try { await say(lead, kw); await runWorkflows(); await settle(); } catch { /* retryable webhook */ }
      });
      const { rows: [k] } = await pg.query("select m.id, m.metadata->'processing'->'aiResponder'->>'outcome' o, c.status cs, c.error_message ce from messages m left join ai_response_claims c on c.inbound_message_id = m.id where m.property_id = $1 and m.body = $2", [lead.propertyId, kw]);
      expect(k.o !== "escalated" || (k.cs === "error" && k.ce === "flag_failed")).toBe(true);
      expect((await prop(lead.propertyId)).needs_human_attention).toBe(false);
      const b = await say(lead, B_TEXT); await runWorkflows(); await settle();
      expect(await stampOf(b)).toMatchObject({ r: "routing_v2:already_held" });
      expect(sentTo(lead.phone)).toEqual([]);
      await runRoutingV2OutboxReplies(supabase, { propertyId: lead.propertyId, limit: 10 });
      expect((await prop(lead.propertyId)).needs_human_attention).toBe(true);
      expect(sentTo(lead.phone)).toEqual([]);
      expect(await count("select count(*)::int n from sequence_enrollments where property_id = $1 and status = 'active'", [lead.propertyId])).toBe(0);
    });

    // ---- Follow-up PR (Opus N1 / Fable N-B): a keyword hold that cannot be written ----
    const sayRaw = async (lead: Awaited<ReturnType<typeof seedLead>>, body: string, externalId: string) => (await handleInboundWebhook(new Request("https://v2.test/webhooks/mock", {
      method: "POST",
      headers: { "content-type": "application/json", "x-mock-signature": "valid" },
      body: JSON.stringify({ externalId, from: lead.phone, to: MOCK_SENDER_PRIMARY, body }),
    }), { includeFullUrl: false, provider: new MockMessagingProvider() })).status;
    /** The hot-text alert needs exactly one active owner to go to; returns the prior env pick. */
    async function seedHotOwner() {
      const owner = randomUUID();
      await pg.query("begin");
      await pg.query("set local session_replication_role = replica");
      await pg.query("insert into auth.users (id, email) values ($1, $2)", [owner, `owner-${owner}@test.local`]);
      await pg.query("delete from memberships where org_id = $1 and role = 'owner'", [orgId]);
      await pg.query("insert into memberships (org_id, user_id, role, access_status) values ($1, $2, 'owner', 'active')", [orgId, owner]);
      await pg.query("commit");
      const prior = process.env.HOT_LEAD_ASSIGNEE_USER_ID;
      process.env.HOT_LEAD_ASSIGNEE_USER_ID = owner;
      return prior;
    }
    /** The v2 recovery marker (a failed decision row) cannot be inserted for this lead either. */
    const withMarkerRefused = async <T,>(propertyId: string, run: () => Promise<T>): Promise<T> => {
      const fn = `refuse_marker_${propertyId.replace(/-/g, "")}`;
      await pg.query(`create or replace function public.${fn}() returns trigger language plpgsql as $f$ begin if new.property_id = '${propertyId}' then raise exception 'forced marker failure (test)'; end if; return new; end $f$`);
      await pg.query(`create trigger ${fn} before insert on public.routing_v2_live_decisions for each row execute function public.${fn}()`);
      try { return await run(); } finally {
        await pg.query(`drop trigger if exists ${fn} on public.routing_v2_live_decisions`);
        await pg.query(`drop function if exists public.${fn}()`);
      }
    };
    it("B1 (Astra, 1d7825003): hold write AND recovery-marker insert both fail on a mixed price + legal text: the hot alert lands once, the webhook answers 500; writes restored, NO redelivery, aged past the lease: the sweep holds the lead, no second alert, 0 sends", async () => {
      const lead = await setup();
      await pg.query("update ai_responder_configs set escalation_keywords = $2 where org_id = $1", [orgId, ["price", "how much", "lawyer"]]);
      const priorPick = await seedHotOwner();
      try {
        jevProbabilities = { open_to_selling: 0.95 };
        const body = "How much? My lawyer is involved";
        const status = await withMarkerRefused(lead.propertyId, () => withHoldRefused(lead.propertyId, async () => {
          const st = await sayRaw(lead, body, `v2-wh-b1-${randomUUID()}`); await runWorkflows(); await settle();
          return st;
        }));
        expect(status).toBe(500);
        const { rows: [m] } = await pg.query("select id from messages where property_id = $1 and body = $2", [lead.propertyId, body]);
        const hotEvents = () => count("select count(*)::int n from lead_events where property_id = $1 and source_type = 'hot_seller_text'", [lead.propertyId]);
        expect(await hotEvents()).toBe(1);
        expect(await count("select count(*)::int n from routing_v2_live_decisions where inbound_message_id = $1", [m.id])).toBe(0);
        // The hot check claimed this inbound; the claim must not hide it from the sweep.
        expect((await pg.query("select status, error_message from ai_response_claims where inbound_message_id = $1", [m.id])).rows)
          .toEqual([{ status: "error", error_message: "v2_safety_hold_failed" }]);
        expect((await stampOf(m.id)).o).toBeNull();
        expect((await prop(lead.propertyId)).needs_human_attention).toBe(false);
        // Writes work again; the provider never redelivers; the text ages past the webhook lease.
        await pg.query("update messages set created_at = now() - interval '10 minutes' where id = $1", [m.id]);
        await pg.query("update ai_response_claims set lease_expires_at = now() - interval '10 minutes' where inbound_message_id = $1", [m.id]);
        expect(await sweepUnstampedV2Inbounds(supabase, Date.now(), () => false, lead.propertyId)).toBe(1);
        expect(await prop(lead.propertyId)).toMatchObject({ needs_human_attention: true, last_ai_escalation_reason: "nine_needs_person" });
        expect((await pg.query("select metadata->'processing'->'routingV2Sweep'->>'result' r from messages where id = $1", [m.id])).rows[0].r).toBe("held");
        expect(await hotEvents()).toBe(1);
        expect(sentTo(lead.phone)).toEqual([]);
      } finally {
        if (priorPick === undefined) delete process.env.HOT_LEAD_ASSIGNEE_USER_ID; else process.env.HOT_LEAD_ASSIGNEE_USER_ID = priorPick;
      }
    });

    /** Claim writes for this lead are refused: "repair" = any write after the claim left processing; "all" = every update (the completion never lands, as if the worker died after classifying). */
    const withClaimWritesRefused = async <T,>(propertyId: string, mode: "repair" | "all", run: () => Promise<T>): Promise<T> => {
      const fn = `refuse_claim_${mode}_${propertyId.replace(/-/g, "")}`;
      const cond = mode === "repair" ? "and old.status <> 'processing'" : "";
      await pg.query(`create or replace function public.${fn}() returns trigger language plpgsql as $f$ begin if new.property_id = '${propertyId}' ${cond} then raise exception 'forced claim write failure (test)'; end if; return new; end $f$`);
      await pg.query(`create trigger ${fn} before update on public.ai_response_claims for each row execute function public.${fn}()`);
      try { return await run(); } finally {
        await pg.query(`drop trigger if exists ${fn} on public.ai_response_claims`);
        await pg.query(`drop function if exists public.${fn}()`);
      }
    };
    async function b1DoubleFailure(lead: Awaited<ReturnType<typeof seedLead>>, claimMode: "none" | "repair" | "all", externalId = `v2-wh-b1-${randomUUID()}`) {
      await pg.query("update ai_responder_configs set escalation_keywords = $2 where org_id = $1", [orgId, ["price", "how much", "lawyer"]]);
      jevProbabilities = { open_to_selling: 0.95 };
      const body = "How much? My lawyer is involved";
      const send = async () => { const st = await sayRaw(lead, body, externalId); await runWorkflows(); await settle(); return st; };
      const status = await withMarkerRefused(lead.propertyId, () => withHoldRefused(lead.propertyId,
        () => claimMode === "none" ? send() : withClaimWritesRefused(lead.propertyId, claimMode, send)));
      const { rows: [m] } = await pg.query("select id from messages where property_id = $1 and body = $2", [lead.propertyId, body]);
      return { status, id: m.id as string, body, externalId };
    }
    const hotEventsOf = (propertyId: string) => count("select count(*)::int n from lead_events where property_id = $1 and source_type = 'hot_seller_text'", [propertyId]);
    const claimOf = async (id: string) => (await pg.query("select status, error_message from ai_response_claims where inbound_message_id = $1", [id])).rows;
    async function ageAndSweep(lead: Awaited<ReturnType<typeof seedLead>>, id: string) {
      await pg.query("update messages set created_at = now() - interval '10 minutes' where id = $1", [id]);
      await pg.query("update ai_response_claims set lease_expires_at = now() - interval '10 minutes' where inbound_message_id = $1", [id]);
      return sweepUnstampedV2Inbounds(supabase, Date.now(), () => false, lead.propertyId);
    }
    it("B1b (Astra, 051ee6d4f): hold + marker fail AND any claim write after completion is refused (no repair can land): the hot-only claim is completed straight into error/v2_safety_hold_failed; no redelivery; the sweep holds the lead, one alert, 0 sends", async () => {
      const lead = await setup();
      const priorPick = await seedHotOwner();
      try {
        const r = await b1DoubleFailure(lead, "repair");
        expect(r.status).toBe(500);
        expect(await hotEventsOf(lead.propertyId)).toBe(1);
        expect(await claimOf(r.id)).toEqual([{ status: "error", error_message: "v2_safety_hold_failed" }]);
        expect(await ageAndSweep(lead, r.id)).toBe(1);
        expect(await prop(lead.propertyId)).toMatchObject({ needs_human_attention: true, last_ai_escalation_reason: "nine_needs_person" });
        expect(await hotEventsOf(lead.propertyId)).toBe(1);
        expect(sentTo(lead.phone)).toEqual([]);
      } finally {
        if (priorPick === undefined) delete process.env.HOT_LEAD_ASSIGNEE_USER_ID; else process.env.HOT_LEAD_ASSIGNEE_USER_ID = priorPick;
      }
    });
    it("B1c (Astra, 051ee6d4f) crash boundary: hold + marker fail and the claim's completion never lands (worker dies after classifying): the claim stays processing; no redelivery; past its lease the sweep holds the lead, one alert, 0 sends", async () => {
      const lead = await setup();
      const priorPick = await seedHotOwner();
      try {
        const r = await b1DoubleFailure(lead, "all");
        expect(r.status).toBe(500);
        expect(await hotEventsOf(lead.propertyId)).toBe(1);
        expect((await claimOf(r.id)).map((c) => c.status)).toEqual(["processing"]);
        expect(await ageAndSweep(lead, r.id)).toBe(1);
        expect(await prop(lead.propertyId)).toMatchObject({ needs_human_attention: true, last_ai_escalation_reason: "nine_needs_person" });
        expect(await hotEventsOf(lead.propertyId)).toBe(1);
        expect(sentTo(lead.phone)).toEqual([]);
      } finally {
        if (priorPick === undefined) delete process.env.HOT_LEAD_ASSIGNEE_USER_ID; else process.env.HOT_LEAD_ASSIGNEE_USER_ID = priorPick;
      }
    });
    it("B1d (Astra non-blocking, 051ee6d4f): a LATE redelivery after the claim's lease expired does not pay for a second classification; the hold lands, one alert", async () => {
      const lead = await setup();
      const priorPick = await seedHotOwner();
      try {
        const r = await b1DoubleFailure(lead, "none");
        expect(r.status).toBe(500);
        const runs = () => count("select count(*)::int n from sms_classification_runs where source_inbound_message_id = $1", [r.id]);
        const runsBefore = await runs();
        expect(runsBefore).toBe(1);
        await pg.query("update ai_response_claims set lease_expires_at = now() - interval '10 minutes' where inbound_message_id = $1", [r.id]);
        const callsBefore = jevCalls;
        expect(await sayRaw(lead, r.body, r.externalId)).toBe(200);
        await runWorkflows(); await settle();
        expect(jevCalls - callsBefore).toBe(0);
        expect(await runs()).toBe(1);
        expect(await prop(lead.propertyId)).toMatchObject({ needs_human_attention: true, last_ai_escalation_reason: "keyword:legal_contract" });
        expect(await hotEventsOf(lead.propertyId)).toBe(1);
        expect(sentTo(lead.phone)).toEqual([]);
      } finally {
        if (priorPick === undefined) delete process.env.HOT_LEAD_ASSIGNEE_USER_ID; else process.env.HOT_LEAD_ASSIGNEE_USER_ID = priorPick;
      }
    });

    it("N1: a mixed price + legal text whose keyword hold cannot be written: the hot-text alert still lands once, the webhook answers 500 with the event marked error (not processed), the text is not stamped; the redelivery holds it, answers 200 and adds no second alert", async () => {
      const lead = await setup();
      await pg.query("update ai_responder_configs set escalation_keywords = $2 where org_id = $1", [orgId, ["price", "how much", "lawyer"]]);
      const priorPick = await seedHotOwner();
      try {
      jevProbabilities = { open_to_selling: 0.95 };
      const body = "How much? My lawyer is involved";
      const externalId = `v2-wh-n1-${randomUUID()}`;
      const status = await withHoldRefused(lead.propertyId, async () => {
        const st = await sayRaw(lead, body, externalId); await runWorkflows(); await settle();
        return st;
      });
      expect(status).toBe(500);
      const event = async () => (await pg.query("select processing_status s from webhook_events where external_id = $1", [externalId])).rows[0].s as string;
      expect(await event()).toBe("error");
      const { rows: [m] } = await pg.query("select id from messages where property_id = $1 and body = $2", [lead.propertyId, body]);
      expect((await stampOf(m.id)).o).toBeNull();
      expect((await prop(lead.propertyId)).needs_human_attention).toBe(false);
      const hotEvents = () => count("select count(*)::int n from lead_events where property_id = $1 and source_type = 'hot_seller_text'", [lead.propertyId]);
      expect(await hotEvents()).toBe(1);
      expect(sentTo(lead.phone)).toEqual([]);
      // Redelivery once writes work again.
      expect(await sayRaw(lead, body, externalId)).toBe(200);
      await runWorkflows(); await settle();
      expect(await event()).toBe("processed");
      expect(await prop(lead.propertyId)).toMatchObject({ needs_human_attention: true, last_ai_escalation_reason: "keyword:legal_contract" });
      expect(await stampOf(m.id)).toMatchObject({ o: "escalated", r: "keyword:legal_contract" });
      expect(await count("select count(*)::int n from messages where property_id = $1 and body = $2", [lead.propertyId, body])).toBe(1);
      expect(await hotEvents()).toBe(1);
      expect(sentTo(lead.phone)).toEqual([]);
      } finally {
        if (priorPick === undefined) delete process.env.HOT_LEAD_ASSIGNEE_USER_ID; else process.env.HOT_LEAD_ASSIGNEE_USER_ID = priorPick;
      }
    });

    // ---- Follow-up PR (Fable N-1 / Opus N6): model_stop_suppression hold-and-suppress ----
    const modelStops = async (lead: Awaited<ReturnType<typeof seedLead>>) => count("select count(*)::int n from sms_phone_suppressions where org_id = $1 and phone_e164 = $2 and source = 'model_stop'", [orgId, lead.phone]);
    const stopFlags = (extra: Record<string, unknown>) => pg.query("update ai_responder_configs set routing_v2_flags = routing_v2_flags || $2::jsonb where org_id = $1", [orgId, JSON.stringify(extra)]);
    it("N-1 flag ON, Jev-decided stop (asked_stop 0.95): suppressed automatically and NOT left held for a person; 0 sends", async () => {
      const lead = await setup();
      await stopFlags({ model_stop_suppression: true });
      jevProbabilities = { asked_stop: 0.95 };
      const a = await say(lead, "I think I'm all set"); await runWorkflows(); await settle();
      expect(await stampOf(a)).toMatchObject({ r: "routing_v2:model_stop" });
      expect(await modelStops(lead)).toBe(1);
      expect((await prop(lead.propertyId)).needs_human_attention).toBe(false);
      expect(await count("select count(*)::int n from lead_events where property_id = $1 and event_type = 'ai_escalation_cleared' and payload->>'reason' = 'model_stop_suppressed'", [lead.propertyId])).toBe(1);
      expect(sentTo(lead.phone)).toEqual([]);
      expect(await count("select count(*)::int n from sequence_enrollments where property_id = $1 and status = 'active'", [lead.propertyId])).toBe(0);
    });
    it("N-1 flag ON, Haiku-decided stop (asked_stop 0.65, Haiku asked_stop): held for a person, nothing suppressed; 0 sends", async () => {
      const lead = await setup();
      await stopFlags({ model_stop_suppression: true, haiku: true });
      haikuAnswer = { road: "asked_stop", confidence: 0.9 };
      jevProbabilities = { asked_stop: 0.65 };
      await say(lead, "I think I'm all set"); await runWorkflows(); await settle();
      expect(await prop(lead.propertyId)).toMatchObject({ needs_human_attention: true, last_ai_escalation_reason: "nine_asked_stop" });
      expect(await modelStops(lead)).toBe(0);
      expect(sentTo(lead.phone)).toEqual([]);
    });
    it("N-1 flag OFF, the same confident stop: today's human review (held nine_asked_stop), nothing suppressed; 0 sends", async () => {
      const lead = await setup();
      jevProbabilities = { asked_stop: 0.95 };
      await say(lead, "I think I'm all set"); await runWorkflows(); await settle();
      expect(await prop(lead.propertyId)).toMatchObject({ needs_human_attention: true, last_ai_escalation_reason: "nine_asked_stop" });
      expect(await modelStops(lead)).toBe(0);
      expect(sentTo(lead.phone)).toEqual([]);
    });

    it("M11: a mechanics hold about an older inbound after a newer one is committed: superseded, the lead is not held", async () => {
      const lead = await raceSetup();
      const a = await say(lead, A_TEXT);
      await say(lead, B_TEXT);
      expect((await pg.query("select public.routing_v2_write_hold($1,$2,'nine_reply_not_sent:provider_failed','mechanics') as r", [lead.propertyId, a])).rows[0].r).toBe("superseded");
      expect((await prop(lead.propertyId)).needs_human_attention).toBe(false);
    });

    it(`volume (barriers off, x${RACE_REPEAT}): A's queued reply delivered while B arrives and is routed, concurrently: always B wins, never a hold`, async () => {
      const lead0 = await raceSetup();
      const leads = [lead0];
      for (let i = 1; i < RACE_REPEAT; i++) leads.push(await addRaceLead());
      const failures: string[] = [];
      for (const lead of leads) {
        try {
          await aRoutedReplyQueued(lead);
          const [, b] = await Promise.all([
            runRoutingV2OutboxReplies(supabase, { propertyId: lead.propertyId, limit: 10 }),
            (async () => { const id = await say(lead, B_TEXT); await runWorkflows(); return id; })(),
          ]);
          await expectBWon(lead, b);
        } catch (e) {
          failures.push(`${lead.propertyId}: ${e instanceof Error ? e.message.split("\n")[0] : String(e)}`);
        }
      }
      expect(failures).toEqual([]);
    }, 600_000);

    it(`volume (barriers off, x${RACE_REPEAT}): bursts of 3 dispatched in parallel: always C wins, one active, never a hold`, async () => {
      const lead0 = await raceSetup();
      const failures: string[] = [];
      for (let i = 0; i < RACE_REPEAT; i++) {
        const lead = i === 0 ? lead0 : await addRaceLead();
        try {
          await Promise.all([A_TEXT, B_TEXT, C_TEXT].map((t, k) => new Promise((r) => setTimeout(r, k * 30)).then(() => say(lead, t))));
          const c = await idOf(lead, C_TEXT);
          const batch = workflows.pending.splice(0);
          await Promise.all(batch.map((w) => w.fn(w.params)));
          await settle(); await runRoutingV2OutboxReplies(supabase, { propertyId: lead.propertyId, limit: 10 });
          expect(await stampOf(c!)).toMatchObject({ r: "routing_v2:confirmed_owner_drip" });
          expect((await enrollments(lead.propertyId)).filter((e) => e.status === "active")).toEqual([{ k: "confirmed_owner", status: "active", r: null }]);
          expect((await prop(lead.propertyId)).needs_human_attention).toBe(false);
        } catch (e) {
          failures.push(`${lead.propertyId}: ${e instanceof Error ? e.message.split("\n")[0] : String(e)}`);
        }
      }
      expect(failures).toEqual([]);
    }, 600_000);

    it("AUD: a second text to a lead already held for a person gets exactly one audit row (webhook path)", async () => {
      const lead = await setup();
      await pg.query("update properties set needs_human_attention = true, last_ai_escalation_reason = 'needs_reply' where id = $1", [lead.propertyId]);
      jevProbabilities = { text_only: 0.95 };
      const first = await say(lead, "hello?");
      await runWorkflows();
      const second = await say(lead, "anyone there");
      await runWorkflows();
      expect([await auditRows(first), await auditRows(second)]).toEqual([1, 1]);
    });

    it("AUD: a delayed-path keyword hold (\"talk to someone\") gets exactly one audit row", async () => {
      const lead = await setup();
      const inbound = await say(lead, "can I talk to someone please");
      await runWorkflows();
      const { rows: [stamp] } = await pg.query("select metadata->'processing'->'aiResponder'->>'outcome' o from messages where id = $1", [inbound]);
      expect(stamp.o).not.toBe("auto_closed");
      expect(await auditRows(inbound)).toBe(1);
    });
  });
});
