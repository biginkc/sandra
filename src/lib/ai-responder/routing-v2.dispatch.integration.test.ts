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
import type { Json } from "@/lib/supabase/types";

import { dispatchAiResponse, runRoutingV2OutboxReplies } from "./dispatch";
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
vi.mock("@/lib/messaging/quiet-hours", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/messaging/quiet-hours")>()),
  checkQuietHours: () => {
    let open = propertyWindow.open;
    if (propertyWindow.openCalls !== null) {
      open = propertyWindow.openCalls > 0;
      propertyWindow.openCalls = Math.max(0, propertyWindow.openCalls - 1);
    }
    return open
      ? { ok: true, localTime: "12:00", zone: "America/Chicago" }
      : { ok: false, reason: "outside_window", localTime: "22:00", zone: "America/Chicago" };
  },
}));
const recipientWindow = vi.hoisted(() => ({ open: true }));
vi.mock("@/lib/messaging/quiet-hours-recipient", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/messaging/quiet-hours-recipient")>()),
  // A test can close the seller's window so a queued v2 reply waits in the outbox.
  checkRecipientQuietHours: () => recipientWindow.open
    ? { ok: true, state: "MO", localTime: "12:00", florida: false }
    : { ok: false, reason: "outside_window", state: "MO", localTime: "22:00" },
}));

// The REAL webhook path: handleInboundWebhook starts the delay workflow; the workflow runtime is
// not available in vitest, so start() queues the real aiReplyDelayWorkflow body and runWorkflows()
// runs it in-process (sleep resolves at once). Nothing else about the path is faked.
const workflows = vi.hoisted(() => ({ pending: [] as Array<{ fn: (p: unknown) => Promise<unknown>; params: unknown }> }));
vi.mock("workflow/api", async (importOriginal) => ({
  ...(await importOriginal<typeof import("workflow/api")>()),
  start: async (fn: (p: unknown) => Promise<unknown>, args: unknown[]) => {
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
    const body = JSON.parse(String(init?.body)) as { questions: Record<string, unknown> };
    const answers: Record<string, unknown> = {};
    for (const id of Object.keys(body.questions)) {
      answers[id] = id === "property_type"
        ? { choice: "residential", probabilities: { residential: 0.9, lot: 0.02, commercial: 0.02, rental: 0.02, didnt_say: 0.04 } }
        : id === "asked_how_number_obtained"
          // The existing approved number-source question, asked in the same v2 call.
          ? { choice: numberAsked ? "yes" : "no", probabilities: numberAsked ? { yes: 0.95, no: 0.05 } : { yes: 0.05, no: 0.95 } }
          : { choice: "noul", noul: jevProbabilities[id] ?? 0.02 };
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
      expect(p.last_ai_escalation_reason).toMatch(/^(reply_skipped:newer_inbound|nine_reply_not_sent:)/);
    }

    it("M-1: the newer text's webhook died after the insert (no handler): the cancelled older reply still holds for a person", async () => {
      const lead = await olderReplyQueued();
      await newerText(lead);
      await deliverOlderAndExpectHold(lead);
    });

    it("M-1: the newer text's handler ended without handling it: the cancelled older reply still holds for a person", async () => {
      const lead = await olderReplyQueued();
      const newer = await newerText(lead, { processing: { aiResponder: { outcome: "delayed", workflowRunId: "ended-run", delaySeconds: 30 } } });
      await pg.query("insert into ai_response_claims (org_id, inbound_message_id, property_id, contact_id, status, completed_at, outcome, error_message) values ($1, $2, $3, $4, 'error', now(), 'skipped', 'reply_ineligible')", [orgId, newer, lead.propertyId, lead.contactId]);
      await deliverOlderAndExpectHold(lead);
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
