import { Client } from "pg";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

import { createTestClient } from "@tests/integration/client";
import { BMH_ORG_ID, getCanonicalTestOrgId } from "@tests/integration/fixtures/multi-user";
import { MOCK_SENDER_PRIMARY, seedSenderCatalog } from "@tests/integration/delivery";
import { getMockMessageLog, resetMockState } from "@/lib/messaging/providers/mock";
import { assertLocalOnlyTestEnv } from "@/lib/testing/local-only-test-env";
import { V2_REPLY_TEXTS } from "@/lib/sms-classification/routing-v2/reply-texts";

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
vi.mock("@/lib/messaging/quiet-hours", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/messaging/quiet-hours")>()),
  checkQuietHours: () => ({ ok: true, localTime: "12:00", zone: "America/Chicago" }),
}));
vi.mock("@/lib/messaging/quiet-hours-recipient", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/messaging/quiet-hours-recipient")>()),
  checkRecipientQuietHours: () => ({ ok: true, state: "MO", localTime: "12:00", florida: false }),
}));

const supabase = createTestClient();
const pg = new Client({ connectionString: process.env.TEST_SUPABASE_DB_URL });
const realFetch = globalThis.fetch;
let jevProbabilities: Record<string, number> = {};
let jevCalls = 0;
/** The existing eight-answer classification (the number-source detector) says the seller asked. */
let numberAsked = false;

function installFakeJev() {
  globalThis.fetch = (async (input: Parameters<typeof fetch>[0], init?: Parameters<typeof fetch>[1]) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
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
});
