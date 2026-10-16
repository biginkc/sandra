import { Client } from "pg";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

import { createTestClient } from "@tests/integration/client";
import { BMH_ORG_ID, getCanonicalTestOrgId } from "@tests/integration/fixtures/multi-user";
import { MOCK_SENDER_PRIMARY, seedSenderCatalog } from "@tests/integration/delivery";
import { getMockMessageLog, resetMockState } from "@/lib/messaging/providers/mock";
import { assertLocalOnlyTestEnv } from "@/lib/testing/local-only-test-env";
import {
  NINE_QUESTION_IDS,
  NINE_QUESTIONS,
  type NineAnswer,
  type NineQuestionId,
} from "@/lib/sms-classification/nine-questions";

import { startRun } from "@/lib/pipeline-runs";
import { HOT_TEXT_SOURCE_TYPE } from "@/lib/hot-sellers/assign";
import { dispatchAiResponse } from "./dispatch";
import { enrollNineDrip } from "./nine-questions-engine";
import type { AnthropicLike } from "./generate";
import { IDENTITY_REPLY_BODY } from "./identity";
import { APPROVED_REPLY_TEXTS } from "./approved-reply-texts";

/**
 * Messages v2 PR 3 (nine questions), end to end through `dispatchAiResponse` on a
 * DISPOSABLE local stack (it resets tenant tables): faked Jev (no provider call),
 * mock SMS provider, real database, real enrollLead, real send gates.
 *
 * Run (see the report for the stack): TEST_SUPABASE_DB_URL / LOCAL_SUPABASE_URL
 * pointing at a throwaway database, then
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
// The thresholds table is closed to the API (owner RPCs only), so the fixture writes it directly.
const pg = new Client({ connectionString: process.env.TEST_SUPABASE_DB_URL });
const realFetch = globalThis.fetch;

type JevCall = { state: { our_last_text_to_homeowner: string | null; homeowner_reply: string }; questions: Record<string, { instructions: string }> };
let jevCalls: JevCall[] = [];
let jevProbabilities: Partial<Record<NineQuestionId, number>> = {};
/** Questions the fake Jev leaves out of its answer (a partial 200). */
let jevOmit: NineQuestionId[] = [];

function installFakeJev() {
  globalThis.fetch = (async (input: Parameters<typeof fetch>[0], init?: Parameters<typeof fetch>[1]) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
    if (!url.includes("api.typesafe.ai")) return realFetch(input, init);
    const body = JSON.parse(String(init?.body)) as JevCall;
    jevCalls.push(body);
    if (!("asked_stop" in body.questions)) {
      // The eight-answer request: a calm, non-hot read ("unclear") so the old path behaves as today.
      return new Response(
        JSON.stringify({
          model: "jev-test",
          answers: {
            outcome: { choice: "unclear", confidence: 0.5, probabilities: { unclear: 0.5 } },
            escalation_reason: { choice: "not_applicable", probabilities: { not_applicable: 0.9 } },
          },
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      );
    }
    const answers = Object.fromEntries(
      NINE_QUESTION_IDS.filter((id) => !jevOmit.includes(id)).map((id) => [id, { choice: "noul", noul: jevProbabilities[id] ?? 0.02 }]),
    );
    return new Response(JSON.stringify({ answers, model: "jev-test", usage: { input_tokens: 1, output_tokens: 1 } }), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  }) as typeof fetch;
}

const NO_ANTHROPIC: AnthropicLike = {
  messages: {
    create: async () => {
      throw new Error("Claude must not be called on the nine-question path");
    },
  } as unknown as AnthropicLike["messages"],
};

let orgId = "";
let phoneCounter = 0;
const DRIPS = ["Maybe later", "Asked who is texting", "Not interested", "Confirmed owner"] as const;

async function seedOrg(opts: { engine?: string; provider?: string; mode?: string; thresholds?: boolean; drips?: readonly string[]; templates?: boolean; newLeadAuto?: boolean; nurtureDrip?: boolean; identityReply?: boolean; confirmedOwnerDrip?: boolean; templateText?: Partial<Record<"nurture" | "not_interested" | "wrong_number", string>>; outboundMode?: string } = {}) {
  await supabase.from("ai_responder_configs").delete().eq("org_id", orgId);
  const { error } = await supabase.from("ai_responder_configs").insert({
    org_id: orgId,
    system_prompt: "test",
    business_hours_only: false,
    classifier_provider: opts.provider ?? "jev",
    classifier_mode: opts.mode ?? "automatic",
    classifier_engine: opts.engine ?? "nine_questions",
    ...(opts.outboundMode ? { outbound_mode: opts.outboundMode } : {}),
    ...(opts.identityReply === false ? { nine_identity_reply: false } : {}),
    ...(opts.confirmedOwnerDrip === false ? { nine_confirmed_owner_drip: false } : {}),
  });
  expect(error).toBeNull();

  await pg.query("delete from public.jev_outcome_thresholds where org_id = $1", [orgId]);
  if (opts.thresholds !== false) {
    for (const outcome of ["nurture", "not_interested", "wrong_number", "new_lead"]) {
      await pg.query(
        "insert into public.jev_outcome_thresholds (org_id, outcome, min_confidence, automation_enabled) values ($1, $2, 0.9, $3)",
        [orgId, outcome, outcome === "new_lead" ? (opts.newLeadAuto ?? true) : true],
      );
    }
  }

  const seqIds: string[] = [];
  for (const name of opts.drips ?? DRIPS) {
    const { data: seq, error: seqError } = await supabase.from("sequences").insert({ org_id: orgId, name, active: true }).select("id").single();
    expect(seqError).toBeNull();
    seqIds.push(seq!.id);
    const { error: stepError } = await supabase.from("sequence_steps").insert([
      { sequence_id: seq!.id, step_index: 0, delay_after_previous_minutes: 0, action_type: "send_sms", template_body: `${name} one` },
      { sequence_id: seq!.id, step_index: 1, delay_after_previous_minutes: 1440, action_type: "send_sms", template_body: `${name} two` },
    ]);
    expect(stepError).toBeNull();
  }

  // The nurture auto-drip switch ("Maybe later" enrolment); its four drip ids are required when on.
  if (opts.nurtureDrip !== false && seqIds[0]) {
    await pg.query(
      "update public.ai_responder_configs set nurture_auto_drip = true, nurture_drip_maybe_later_sequence_id = $2, nurture_drip_check_in_60_sequence_id = $2, nurture_drip_listed_not_selling_sequence_id = $2, nurture_drip_hot_book_appointment_sequence_id = $2 where org_id = $1",
      [orgId, seqIds[0]],
    );
  }

  if (opts.templates !== false) {
    for (const [outcome, content] of [
      ["nurture", opts.templateText?.nurture ?? APPROVED_REPLY_TEXTS.nurture],
      ["not_interested", opts.templateText?.not_interested ?? APPROVED_REPLY_TEXTS.not_interested],
      ["wrong_number", opts.templateText?.wrong_number ?? APPROVED_REPLY_TEXTS.wrong_number],
    ] as const) {
      // Approval flags are RPC-only in the product; the fixture sets them the way the RPC does.
      await pg.query("begin");
      await pg.query("select set_config('sandra.template_approval', 'on', true)");
      const { rows } = await pg.query(
        "insert into public.sms_templates (org_id, name, content, approved_for_auto_send, approved_content, approved_at) values ($1, $2, $3, true, $3, now()) returning id",
        [orgId, `Auto reply ${outcome}`, content],
      );
      await pg.query("insert into public.auto_reply_templates (org_id, outcome, template_id) values ($1, $2, $3)", [orgId, outcome, rows[0].id]);
      await pg.query("commit");
    }
  }
}

/** The org's one active owner, written straight to the database (a throwaway stack has no auth service). */
async function seedOwner(): Promise<string> {
  const id = crypto.randomUUID();
  await pg.query("insert into auth.users (id, email, aud, role, instance_id) values ($1, $2, 'authenticated', 'authenticated', '00000000-0000-0000-0000-000000000000')", [id, `nine-owner-${id}@test.local`]);
  await pg.query("insert into public.memberships (user_id, org_id, role) values ($1, $2, 'owner')", [id, orgId]);
  // My Leads on and the owner designated (the designation guard wants its transaction-local marker).
  await pg.query("insert into public.acquisition_org_settings (org_id, my_leads_enabled) values ($1, true) on conflict (org_id) do update set my_leads_enabled = true", [orgId]);
  await pg.query("begin");
  try {
    await pg.query("select set_config('my_leads.designation_update', $1, true)", [`:${orgId}:${id}`]);
    await pg.query("update public.memberships set acquisitions_enabled = true where org_id = $1 and user_id = $2", [orgId, id]);
    await pg.query("commit");
  } catch (error) {
    await pg.query("rollback");
    throw error;
  }
  return id;
}

async function seedLead(opts: { optedOut?: boolean; responderDisabled?: boolean } = {}) {
  const phone = `+1816755${String(5000 + phoneCounter++).padStart(4, "0")}`;
  const { data: contact } = await supabase.from("contacts").insert({ org_id: orgId, first_name: "Nine", last_name: "Test", phone_1: phone, phone_1_type: "mobile" }).select("id").single();
  await supabase.from("consent_events").insert({ contact_id: contact!.id, channel: "sms", event_type: "opt_in_marketing_written", source: "nine-test", org_id: orgId });
  if (opts.optedOut) {
    await supabase.from("consent_events").insert({ contact_id: contact!.id, channel: "sms", event_type: "opt_out", source: "nine-test", org_id: orgId });
  }
  const { data: property, error } = await supabase
    .from("properties")
    .insert({ org_id: orgId, address: "1 Nine Ln", state: "MO", status: "prospect", homeowner_contact_id: contact!.id, ...(opts.responderDisabled ? { ai_responder_disabled: true } : {}) })
    .select("id")
    .single();
  expect(error).toBeNull();
  return { propertyId: property!.id, contactId: contact!.id, phone };
}

const OUR_TEXT = "Hi, are you interested in selling 1 Nine Ln?";

async function seedThread(lead: { propertyId: string; contactId: string; phone: string }, reply: string) {
  const { data: out } = await supabase
    .from("messages")
    .insert({ org_id: orgId, channel: "sms", direction: "outbound", status: "delivered", property_id: lead.propertyId, contact_id: lead.contactId, from_address: MOCK_SENDER_PRIMARY, to_address: lead.phone, body: OUR_TEXT, created_at: new Date(Date.now() - 3600_000).toISOString() })
    .select("id, conversation_id")
    .single();
  const { data: inbound, error } = await supabase
    .from("messages")
    .insert({ org_id: orgId, channel: "sms", direction: "inbound", status: "received", property_id: lead.propertyId, contact_id: lead.contactId, from_address: lead.phone, to_address: MOCK_SENDER_PRIMARY, body: reply })
    .select("id, conversation_id")
    .single();
  expect(error).toBeNull();
  void out;
  return { id: inbound!.id, conversationId: inbound!.conversation_id as string };
}

async function hotTextRecords(propertyId: string): Promise<number> {
  const { rows } = await pg.query("select count(*)::int as n from public.lead_events where property_id = $1 and source_type = $2", [propertyId, HOT_TEXT_SOURCE_TYPE]);
  return rows[0].n as number;
}

async function run(answer: Partial<Record<NineQuestionId, number>>, reply = "ok", lead?: Awaited<ReturnType<typeof seedLead>>) {
  const l = lead ?? (await seedLead());
  jevProbabilities = answer;
  const inbound = await seedThread(l, reply);
  const input = {
    propertyId: l.propertyId,
    contactId: l.contactId,
    conversationId: inbound.conversationId,
    inboundMessageId: inbound.id,
    inboundBody: reply,
    inboundFromPhone: l.phone,
    inboundToPhone: MOCK_SENDER_PRIMARY,
  };
  const outcome = await dispatchAiResponse(supabase, input, { anthropic: NO_ANTHROPIC });
  return { lead: l, inbound, input, outcome };
}

async function enrollmentsFor(propertyId: string) {
  const { data } = await supabase
    .from("sequence_enrollments")
    .select("status, current_step_index, sequences(name)")
    .eq("property_id", propertyId);
  return (data ?? []).map((r) => ({
    name: (Array.isArray(r.sequences) ? r.sequences[0] : r.sequences)?.name as string,
    status: r.status as string,
    step: r.current_step_index as number,
  }));
}

async function propertyRow(propertyId: string) {
  const { data } = await supabase
    .from("properties")
    .select("status, outreach_dispo, needs_human_attention, last_ai_escalation_reason, is_dnc_locked")
    .eq("id", propertyId)
    .single();
  return data!;
}

async function outboundBodies(propertyId: string) {
  const { data } = await supabase.from("messages").select("body").eq("property_id", propertyId).eq("direction", "outbound").order("created_at");
  return (data ?? []).map((m) => m.body).filter((b) => b !== OUR_TEXT);
}

describe("nine questions through dispatchAiResponse (disposable local stack)", () => {
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
    // Disposable stack only (guarded in beforeAll). Straight to the SQL reset: the Storage
    // API cleanup in resetTenantTables needs the full stack, which this suite does not.
    // The final-owner guard would block the reset: drop last test's owner first (throwaway DB only).
    await pg.query("begin");
    await pg.query("set local session_replication_role = replica");
    await pg.query("delete from public.memberships where org_id = $1", [BMH_ORG_ID]);
    await pg.query("delete from auth.users where email like 'nine-owner-%'");
    await pg.query("commit");
    const { error: resetError } = await supabase.rpc("reset_tenant_tables");
    expect(resetError).toBeNull();
    resetMockState();
    jevCalls = [];
    jevProbabilities = {};
    jevOmit = [];
    // A schema-only throwaway database has no tenant rows: make sure the canonical org exists.
    const { error: orgError } = await supabase.from("organizations").upsert({ id: BMH_ORG_ID, name: "BMH (nine questions test)" });
    expect(orgError).toBeNull();
    orgId = await getCanonicalTestOrgId(supabase);
    await seedSenderCatalog(supabase, orgId, [MOCK_SENDER_PRIMARY]);
  });

  it("sends all nine approved questions verbatim, with the last text we sent and the reply", async () => {
    await seedOrg();
    const { outcome } = await run({ confirmed_owner: 0.9 }, "yes thats me");
    expect(outcome.outcome).not.toBe("error");
    expect(jevCalls).toHaveLength(1);
    expect(jevCalls[0]!.state).toEqual({ our_last_text_to_homeowner: OUR_TEXT, homeowner_reply: "yes thats me" });
    for (const id of NINE_QUESTION_IDS) expect(jevCalls[0]!.questions[id]!.instructions).toBe(NINE_QUESTIONS[id]);
  });

  it("maybe_later: approved nurture text, then the Maybe later drip from step 1; decision recorded", async () => {
    await seedOrg();
    const { lead } = await run({ maybe_later: 0.8 });
    expect(await outboundBodies(lead.propertyId)).toEqual([APPROVED_REPLY_TEXTS.nurture]);
    expect(await enrollmentsFor(lead.propertyId)).toEqual([{ name: "Maybe later", status: "active", step: 0 }]);
    expect((await propertyRow(lead.propertyId)).outreach_dispo).toBeNull();
    const { data: runs } = await supabase.from("sms_classification_runs").select("decision, schema_version, resolved_outcome").eq("property_id", lead.propertyId);
    expect(runs).toHaveLength(1);
    expect(runs![0]).toMatchObject({ schema_version: "nine_questions_v1", resolved_outcome: null });
    expect(runs![0]!.decision).toMatchObject({ engine: "nine_questions", answer: "maybe_later", cutoff: 0.6, chosen: { id: "maybe_later", probability: 0.8 } });
    expect((runs![0]!.decision as { probabilities: Record<string, number> }).probabilities.maybe_later).toBe(0.8);
  });

  it("asked_who: identity reply, then the drip starting at its second text", async () => {
    await seedOrg();
    const { lead } = await run({ asked_who: 0.9 }, "who is this");
    expect(await outboundBodies(lead.propertyId)).toEqual([IDENTITY_REPLY_BODY]);
    expect(await enrollmentsFor(lead.propertyId)).toEqual([{ name: "Asked who is texting", status: "active", step: 1 }]);
  });

  it("not_interested: approved text, Not interested drip, no terminal disposition", async () => {
    await seedOrg();
    const { lead } = await run({ not_interested: 0.85 }, "no thanks");
    expect(await outboundBodies(lead.propertyId)).toEqual([APPROVED_REPLY_TEXTS.not_interested]);
    expect(await enrollmentsFor(lead.propertyId)).toEqual([{ name: "Not interested", status: "active", step: 0 }]);
    expect((await propertyRow(lead.propertyId)).outreach_dispo).toBeNull();
  });

  it("wrong_person: approved wrong-number text, this property closed as wrong_number, no drip, no DNC", async () => {
    await seedOrg();
    const { lead } = await run({ wrong_person: 0.9 }, "wrong number");
    expect(await outboundBodies(lead.propertyId)).toEqual([APPROVED_REPLY_TEXTS.wrong_number]);
    expect(await enrollmentsFor(lead.propertyId)).toEqual([]);
    const row = await propertyRow(lead.propertyId);
    expect(row.outreach_dispo).toBe("wrong_number");
    expect(row.is_dnc_locked).toBe(false);
    const { data: reviews } = await supabase.from("ai_disposition_reviews").select("disposition, status, classification_run_id").eq("property_id", lead.propertyId);
    expect(reviews).toHaveLength(1);
    expect(reviews![0]).toMatchObject({ disposition: "wrong_number", status: "auto_accepted" });
    expect(reviews![0]!.classification_run_id).not.toBeNull();
  });

  it("confirmed_owner: no reply, enrolled in Confirmed owner from its first text", async () => {
    await seedOrg();
    const { lead } = await run({ confirmed_owner: 0.9 }, "yes its me");
    expect(await outboundBodies(lead.propertyId)).toEqual([]);
    expect(getMockMessageLog()).toHaveLength(0);
    expect(await enrollmentsFor(lead.propertyId)).toEqual([{ name: "Confirmed owner", status: "active", step: 0 }]);
  });

  for (const [answer, probs, reason] of [
    ["asked_stop", { asked_stop: 0.9 }, "nine_asked_stop"],
    ["needs_person", { confirmed_owner: 0.3 }, "nine_needs_person"],
  ] as Array<[NineAnswer, Partial<Record<NineQuestionId, number>>, string]>) {
    it(`${answer}: waits for a person; no text, no drip, no automatic DNC`, async () => {
      await seedOrg();
      const { lead } = await run(probs, "stop");
      expect(await outboundBodies(lead.propertyId)).toEqual([]);
      expect(await enrollmentsFor(lead.propertyId)).toEqual([]);
      const row = await propertyRow(lead.propertyId);
      expect(row).toMatchObject({ needs_human_attention: true, last_ai_escalation_reason: reason, is_dnc_locked: false });
      expect(row.outreach_dispo).toBeNull();
    });
  }

  it("hostile: held for a person through the existing hostile hold; no reply", async () => {
    await seedOrg();
    const { lead } = await run({ hostile: 0.9 }, "leave me alone");
    expect(await outboundBodies(lead.propertyId)).toEqual([]);
    expect(await enrollmentsFor(lead.propertyId)).toEqual([]);
    const row = await propertyRow(lead.propertyId);
    expect(row.needs_human_attention).toBe(true);
    expect(row.last_ai_escalation_reason).toMatch(/^hostile_needs_confirm/);
  });

  for (const [answer, probs] of [
    ["open_to_selling", { open_to_selling: 0.9 }],
    ["talked_price", { talked_price: 0.9 }],
  ] as Array<[NineAnswer, Partial<Record<NineQuestionId, number>>]>) {
    it(`${answer}: today's new_lead promotion (switch on), no automatic text`, async () => {
      await seedOrg();
      const owner = await seedOwner();
      const { lead } = await run(probs, "yes I would sell");
      expect(await outboundBodies(lead.propertyId)).toEqual([]);
      expect((await propertyRow(lead.propertyId)).status).toBe("new_lead");
      const { data: assigned } = await supabase.from("properties").select("assigned_user_id").eq("id", lead.propertyId).single();
      expect(assigned!.assigned_user_id).toBe(owner); // PR 2's hand-off to Jarrad
      const { data: decisions } = await supabase.from("jev_lead_decisions").select("proposed_outcome, status, classification_run_id").eq("property_id", lead.propertyId);
      expect(decisions).toHaveLength(1);
      expect(decisions![0]!.proposed_outcome).toBe("new_lead");
      const { data: runs } = await supabase.from("sms_classification_runs").select("resolved_outcome, decision").eq("property_id", lead.propertyId);
      expect(runs![0]!.resolved_outcome).toBe("new_lead");
      expect(runs![0]!.decision).toMatchObject({ engine: "nine_questions", answer });
    });
  }

  it("hot with the new_lead switch off: held for a person as hot_lead, nothing promoted", async () => {
    await seedOrg({ newLeadAuto: false });
    const { lead } = await run({ open_to_selling: 0.9 });
    const row = await propertyRow(lead.propertyId);
    expect(row).toMatchObject({ status: "prospect", needs_human_attention: true, last_ai_escalation_reason: "hot_lead" });
    expect(await outboundBodies(lead.propertyId)).toEqual([]);
  });

  it("cutoff: 0.5999 is not a yes, 0.6 is", async () => {
    await seedOrg();
    const below = await run({ maybe_later: 0.5999 });
    expect((await propertyRow(below.lead.propertyId)).last_ai_escalation_reason).toBe("nine_needs_person");
    const at = await run({ maybe_later: 0.6 });
    expect(await enrollmentsFor(at.lead.propertyId)).toEqual([{ name: "Maybe later", status: "active", step: 0 }]);
  });

  it("idempotent: dispatching the same inbound again sends one text and keeps one enrolment", async () => {
    await seedOrg();
    const first = await run({ maybe_later: 0.8 });
    const second = await dispatchAiResponse(supabase, first.input, { anthropic: NO_ANTHROPIC });
    expect(second.outcome).not.toBe("sent");
    expect(await outboundBodies(first.lead.propertyId)).toEqual([APPROVED_REPLY_TEXTS.nurture]);
    expect(await enrollmentsFor(first.lead.propertyId)).toHaveLength(1);
  });

  it("missing drip: reply still goes out (it was approved and sent), refusal is flagged where the tape reads it", async () => {
    await seedOrg({ drips: ["Asked who is texting", "Not interested", "Confirmed owner"] });
    const { lead } = await run({ maybe_later: 0.8 });
    expect(await outboundBodies(lead.propertyId)).toEqual([APPROVED_REPLY_TEXTS.nurture]);
    expect(await enrollmentsFor(lead.propertyId)).toEqual([]);
    expect(await propertyRow(lead.propertyId)).toMatchObject({
      needs_human_attention: true,
      last_ai_escalation_reason: "drip_enroll_failed:drip_not_found",
    });
  });

  it("enrollNineDrip is idempotent and a paused enrolment is refused, not called done", async () => {
    await seedOrg();
    const lead = await seedLead();
    const a = await enrollNineDrip(supabase, { orgId, propertyId: lead.propertyId, dripName: "Maybe later", skipFirstStep: false });
    const b = await enrollNineDrip(supabase, { orgId, propertyId: lead.propertyId, dripName: "Maybe later", skipFirstStep: false });
    expect(a.status).toBe("enrolled");
    expect(b.status).toBe("already_enrolled");
    expect(await enrollmentsFor(lead.propertyId)).toHaveLength(1);
    await pg.query("update public.sequence_enrollments set status = 'paused', pause_reason = 'inbound_reply' where property_id = $1", [lead.propertyId]);
    expect(await enrollNineDrip(supabase, { orgId, propertyId: lead.propertyId, dripName: "Maybe later", skipFirstStep: false })).toEqual({ status: "refused", reason: "drip_paused" });
  });

  it("skipping the first text of a one-text drip is refused (nothing would ever be sent) and flagged", async () => {
    await seedOrg();
    await pg.query(
      "delete from public.sequence_steps where step_index = 1 and sequence_id in (select id from public.sequences where org_id = $1 and name = 'Asked who is texting')",
      [orgId],
    );
    const { lead } = await run({ asked_who: 0.9 }, "who is this");
    expect(await outboundBodies(lead.propertyId)).toEqual([IDENTITY_REPLY_BODY]);
    expect(await enrollmentsFor(lead.propertyId)).toEqual([]);
    expect((await propertyRow(lead.propertyId)).last_ai_escalation_reason).toBe("drip_enroll_failed:no_steps");
  });

  it("hot with no owner to hand to: held as hot_lead_assign_failed (still hot), never auto-closed", async () => {
    await seedOrg();
    const { lead, outcome } = await run({ open_to_selling: 0.9 }, "yes I would sell");
    expect(outcome).toMatchObject({ outcome: "escalated", reason: "hot_lead_assign_failed" });
    expect((await propertyRow(lead.propertyId)).last_ai_escalation_reason).toBe("hot_lead_assign_failed");
  });

  const EDITED: Array<[string, string]> = [
    ["edited text", "Fantastic! We will keep in touch!!"],
    ["a variable", "Hi {first_name}, Fantastic! We will keep in touch."],
  ];
  it.each(EDITED)("maybe_later with a template that has %s: nothing sent, no drip, held as reply_text_not_approved", async (_n, text) => {
    await seedOrg({ templateText: { nurture: text } });
    const { lead } = await run({ maybe_later: 0.8 });
    expect(await outboundBodies(lead.propertyId)).toEqual([]);
    expect(await enrollmentsFor(lead.propertyId)).toEqual([]);
    expect((await propertyRow(lead.propertyId)).last_ai_escalation_reason).toBe("reply_text_not_approved");
  });

  it("not_interested with an edited template: nothing sent, held as reply_text_not_approved", async () => {
    await seedOrg({ templateText: { not_interested: "Sounds good." } });
    const { lead } = await run({ not_interested: 0.85 });
    expect(await outboundBodies(lead.propertyId)).toEqual([]);
    expect((await propertyRow(lead.propertyId)).last_ai_escalation_reason).toBe("reply_text_not_approved");
  });

  it.each(EDITED)("wrong_person with a template that has %s: nothing sent and the property is NOT closed", async (_n, text) => {
    await seedOrg({ templateText: { wrong_number: text.replace("Fantastic! We will keep in touch", "Sorry about that") } });
    const { lead } = await run({ wrong_person: 0.9 }, "wrong number");
    expect(await outboundBodies(lead.propertyId)).toEqual([]);
    const row = await propertyRow(lead.propertyId);
    expect(row.outreach_dispo).toBeNull();
    expect(row.last_ai_escalation_reason).toBe("reply_text_not_approved");
  });

  it("wrong_person with no approved template mapped: held, NOT closed", async () => {
    await seedOrg({ templates: false });
    const { lead } = await run({ wrong_person: 0.9 }, "wrong number");
    const row = await propertyRow(lead.propertyId);
    expect(row.outreach_dispo).toBeNull();
    expect(row.last_ai_escalation_reason).toMatch(/^nine_reply_not_sent:/);
  });

  it("wrong_person with sending blocked (outbound hold mode): held, NOT closed", async () => {
    await seedOrg({ outboundMode: "hold" });
    const { lead } = await run({ wrong_person: 0.9 }, "wrong number");
    expect(await outboundBodies(lead.propertyId)).toEqual([]);
    const row = await propertyRow(lead.propertyId);
    expect(row.outreach_dispo).toBeNull();
    expect(row.needs_human_attention).toBe(true);
  });

  it("PR 4 identity-reply switch OFF: nothing sent, no drip, held for a person", async () => {
    await seedOrg({ identityReply: false });
    const { lead } = await run({ asked_who: 0.9 }, "who is this");
    expect(await outboundBodies(lead.propertyId)).toEqual([]);
    expect(getMockMessageLog()).toHaveLength(0);
    expect(await enrollmentsFor(lead.propertyId)).toEqual([]);
    expect(await propertyRow(lead.propertyId)).toMatchObject({
      needs_human_attention: true,
      last_ai_escalation_reason: "nine_automation_disabled:asked_who",
    });
  });

  it("PR 4 Confirmed owner drip switch OFF: no text, nobody enrolled, no hold", async () => {
    await seedOrg({ confirmedOwnerDrip: false });
    const { lead } = await run({ confirmed_owner: 0.9 }, "yes its me");
    expect(await outboundBodies(lead.propertyId)).toEqual([]);
    expect(await enrollmentsFor(lead.propertyId)).toEqual([]);
    expect((await propertyRow(lead.propertyId)).needs_human_attention).toBe(false);
  });

  it("PR 4 switches do not govern each other (identity off: Confirmed owner still enrols)", async () => {
    await seedOrg({ identityReply: false });
    const { lead } = await run({ confirmed_owner: 0.9 }, "yes its me");
    expect(await enrollmentsFor(lead.propertyId)).toEqual([{ name: "Confirmed owner", status: "active", step: 0 }]);
  });

  it("nurture auto-drip switch OFF: the Maybe later reply still goes out, nobody is enrolled, no hold", async () => {
    await seedOrg({ nurtureDrip: false });
    const { lead } = await run({ maybe_later: 0.8 });
    expect(await outboundBodies(lead.propertyId)).toEqual([APPROVED_REPLY_TEXTS.nurture]);
    expect(await enrollmentsFor(lead.propertyId)).toEqual([]);
    expect((await propertyRow(lead.propertyId)).needs_human_attention).toBe(false);
  });

  it("nurture auto-drip switch OFF does not govern the other drips (not_interested still enrols)", async () => {
    await seedOrg({ nurtureDrip: false });
    const { lead } = await run({ not_interested: 0.85 }, "no thanks");
    expect(await enrollmentsFor(lead.propertyId)).toEqual([{ name: "Not interested", status: "active", step: 0 }]);
  });

  it("reply cannot go out (no approved template mapped): nothing sent, no drip, held for a person", async () => {
    await seedOrg({ templates: false });
    const { lead } = await run({ maybe_later: 0.8 });
    expect(await outboundBodies(lead.propertyId)).toEqual([]);
    expect(await enrollmentsFor(lead.propertyId)).toEqual([]);
    expect((await propertyRow(lead.propertyId)).last_ai_escalation_reason).toMatch(/^nine_reply_not_sent:/);
  });

  it("the label's automation switch still gates the reply (nurture switched off): held, nothing sent", async () => {
    await seedOrg();
    await pg.query("update public.jev_outcome_thresholds set automation_enabled = false where org_id = $1 and outcome = 'nurture'", [orgId]);
    const { lead } = await run({ maybe_later: 0.8 });
    expect(await outboundBodies(lead.propertyId)).toEqual([]);
    expect(await enrollmentsFor(lead.propertyId)).toEqual([]);
    expect((await propertyRow(lead.propertyId)).last_ai_escalation_reason).toBe("nine_reply_not_sent:automation_disabled");
  });

  it("Jev failure: no fallback to the other engine; held for a person", async () => {
    await seedOrg();
    const lead = await seedLead();
    const inbound = await seedThread(lead, "hello");
    const keep = globalThis.fetch;
    globalThis.fetch = (async (input: Parameters<typeof fetch>[0], init?: Parameters<typeof fetch>[1]) => {
      const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
      if (url.includes("api.typesafe.ai")) return new Response("nope", { status: 401 });
      return realFetch(input, init);
    }) as typeof fetch;
    try {
      await dispatchAiResponse(
        supabase,
        { propertyId: lead.propertyId, contactId: lead.contactId, conversationId: inbound.conversationId, inboundMessageId: inbound.id, inboundBody: "hello", inboundFromPhone: lead.phone, inboundToPhone: MOCK_SENDER_PRIMARY },
        { anthropic: NO_ANTHROPIC },
      );
    } finally {
      globalThis.fetch = keep;
    }
    expect((await propertyRow(lead.propertyId)).last_ai_escalation_reason).toBe("jev_automatic_failed:auth");
    expect(await outboundBodies(lead.propertyId)).toEqual([]);
  });

  it("switch off (outcome_v1, the default): the nine questions are never asked and today's path runs", async () => {
    await seedOrg({ engine: "outcome_v1", provider: "legacy", mode: "shadow" });
    const lead = await seedLead();
    const inbound = await seedThread(lead, "tell me more");
    const outcome = await dispatchAiResponse(
      supabase,
      { propertyId: lead.propertyId, contactId: lead.contactId, conversationId: inbound.conversationId, inboundMessageId: inbound.id, inboundBody: "tell me more", inboundFromPhone: lead.phone, inboundToPhone: MOCK_SENDER_PRIMARY },
      {
        anthropic: {
          messages: {
            create: async () => ({
              content: [{ type: "tool_use", id: "t", name: "submit_reply", input: { action: "send_reply", body: "Thanks, someone will reach out shortly.", confidence: 0.9, sentiment: "positive" } }],
              role: "assistant",
              stop_reason: "tool_use",
              usage: { input_tokens: 1, output_tokens: 1 },
            }),
          } as unknown as AnthropicLike["messages"],
        },
      },
    );
    expect(outcome.outcome).toBe("sent");
    expect(jevCalls).toHaveLength(0);
    const { data: runs } = await supabase.from("sms_classification_runs").select("id").eq("property_id", lead.propertyId);
    expect(runs).toEqual([]);
    expect(await enrollmentsFor(lead.propertyId)).toEqual([]);
  });

  it("production shape (jev + automatic + outcome_v1) with 'who is this': the identity shortcut fires, the nine questions are never asked", async () => {
    await seedOrg({ engine: "outcome_v1" });
    const lead = await seedLead();
    const inbound = await seedThread(lead, "Who is this?");
    await dispatchAiResponse(
      supabase,
      { propertyId: lead.propertyId, contactId: lead.contactId, conversationId: inbound.conversationId, inboundMessageId: inbound.id, inboundBody: "Who is this?", inboundFromPhone: lead.phone, inboundToPhone: MOCK_SENDER_PRIMARY },
      { anthropic: NO_ANTHROPIC },
    );
    expect(await outboundBodies(lead.propertyId)).toEqual([IDENTITY_REPLY_BODY]);
    expect(jevCalls.filter((c) => "asked_stop" in c.questions)).toHaveLength(0); // the nine questions are never asked
    expect(await enrollmentsFor(lead.propertyId)).toEqual([]);
  });

  it("nine engine in shadow with 'who is this': the shortcut fires exactly as today and nothing is recorded as nine", async () => {
    await seedOrg({ mode: "shadow" });
    const lead = await seedLead();
    const inbound = await seedThread(lead, "Who is this?");
    await dispatchAiResponse(
      supabase,
      { propertyId: lead.propertyId, contactId: lead.contactId, conversationId: inbound.conversationId, inboundMessageId: inbound.id, inboundBody: "Who is this?", inboundFromPhone: lead.phone, inboundToPhone: MOCK_SENDER_PRIMARY },
      { anthropic: NO_ANTHROPIC },
    );
    expect(await outboundBodies(lead.propertyId)).toEqual([IDENTITY_REPLY_BODY]);
    expect(jevCalls).toHaveLength(0);
    expect(await enrollmentsFor(lead.propertyId)).toEqual([]);
  });

  it("shadow records under shadow_engine only (the tape key `engine` is absent) and writes no failure row when Jev fails", async () => {
    await seedOrg({ mode: "shadow" });
    const lead = await seedLead();
    jevProbabilities = { maybe_later: 0.9 };
    const inbound = await seedThread(lead, "maybe later");
    const input = { propertyId: lead.propertyId, contactId: lead.contactId, conversationId: inbound.conversationId, inboundMessageId: inbound.id, inboundBody: "maybe later", inboundFromPhone: lead.phone, inboundToPhone: MOCK_SENDER_PRIMARY };
    const keep = globalThis.fetch;
    globalThis.fetch = (async (i: Parameters<typeof fetch>[0], init?: Parameters<typeof fetch>[1]) => {
      const url = typeof i === "string" ? i : i instanceof URL ? i.toString() : i.url;
      if (url.includes("api.typesafe.ai")) return new Response("nope", { status: 401 });
      return realFetch(i, init);
    }) as typeof fetch;
    try {
      await dispatchAiResponse(supabase, input, { anthropic: NO_ANTHROPIC });
    } finally {
      globalThis.fetch = keep;
    }
    const { data: runs } = await supabase.from("sms_classification_runs").select("schema_version, fallback_reason").eq("property_id", lead.propertyId);
    expect((runs ?? []).filter((r) => r.schema_version === "nine_questions_v1")).toEqual([]);

    const ok = await seedLead();
    const inbound2 = await seedThread(ok, "maybe later");
    await dispatchAiResponse(supabase, { ...input, propertyId: ok.propertyId, contactId: ok.contactId, conversationId: inbound2.conversationId, inboundMessageId: inbound2.id, inboundFromPhone: ok.phone }, { anthropic: NO_ANTHROPIC });
    const { data: okRuns } = await supabase.from("sms_classification_runs").select("decision, schema_version, resolved_outcome").eq("property_id", ok.propertyId).eq("schema_version", "nine_questions_v1");
    expect(okRuns).toHaveLength(1);
    expect(okRuns![0]!.decision).toMatchObject({ shadow_engine: "nine_questions", answer: "maybe_later" });
    expect(okRuns![0]!.decision).not.toHaveProperty("engine");
    expect(okRuns![0]!.resolved_outcome).toBeNull();
    // and the eight-answer queue view never sees a nine row
    const { data: queue } = await supabase.from("jev_needs_decision_classifier_events").select("id").eq("property_id", ok.propertyId).eq("schema_version", "nine_questions_v1");
    expect(queue).toEqual([]);
  });

  it("a live nine failure row is not in the eight-answer Needs-a-decision view", async () => {
    await seedOrg();
    const lead = await seedLead();
    const inbound = await seedThread(lead, "hello");
    const keep = globalThis.fetch;
    globalThis.fetch = (async (i: Parameters<typeof fetch>[0], init?: Parameters<typeof fetch>[1]) => {
      const url = typeof i === "string" ? i : i instanceof URL ? i.toString() : i.url;
      if (url.includes("api.typesafe.ai")) return new Response("nope", { status: 401 });
      return realFetch(i, init);
    }) as typeof fetch;
    try {
      await dispatchAiResponse(supabase, { propertyId: lead.propertyId, contactId: lead.contactId, conversationId: inbound.conversationId, inboundMessageId: inbound.id, inboundBody: "hello", inboundFromPhone: lead.phone, inboundToPhone: MOCK_SENDER_PRIMARY }, { anthropic: NO_ANTHROPIC });
    } finally {
      globalThis.fetch = keep;
    }
    const { data: rows } = await supabase.from("sms_classification_runs").select("id").eq("property_id", lead.propertyId).eq("schema_version", "nine_questions_v1");
    expect(rows).toHaveLength(1);
    const { data: queue } = await supabase.from("jev_needs_decision_classifier_events").select("id").eq("property_id", lead.propertyId);
    expect(queue).toEqual([]);
  });

  /** The same client, except the engine-switch read answers with the given error. */
  function withEngineReadError(error: { code?: string; message: string }) {
    return new Proxy(supabase, {
      get(target, prop, receiver) {
        if (prop !== "from") return Reflect.get(target, prop, receiver);
        return (table: string) => {
          const builder = target.from(table as never) as unknown as { select: (...a: unknown[]) => unknown };
          return new Proxy(builder, {
            get(b, p2) {
              if (p2 !== "select") return Reflect.get(b, p2);
              return (cols: unknown, ...rest: unknown[]) => {
                if (table === "ai_responder_configs" && cols === "classifier_engine") {
                  const chain: Record<string, unknown> = {};
                  chain.eq = () => chain;
                  chain.maybeSingle = async () => ({ data: null, error });
                  return chain;
                }
                return b.select(cols, ...rest);
              };
            },
          });
        };
      },
    });
  }

  it("engine switch unreadable (not a missing column): held as classifier_engine_unreadable, neither engine runs", async () => {
    await seedOrg();
    const lead = await seedLead();
    const inbound = await seedThread(lead, "maybe later");
    const outcome = await dispatchAiResponse(
      withEngineReadError({ code: "57014", message: "statement timeout" }),
      { propertyId: lead.propertyId, contactId: lead.contactId, conversationId: inbound.conversationId, inboundMessageId: inbound.id, inboundBody: "maybe later", inboundFromPhone: lead.phone, inboundToPhone: MOCK_SENDER_PRIMARY },
      { anthropic: NO_ANTHROPIC },
    );
    expect(outcome).toEqual({ outcome: "escalated", reason: "classifier_engine_unreadable" });
    expect(jevCalls).toHaveLength(0);
    expect(await outboundBodies(lead.propertyId)).toEqual([]);
    expect((await propertyRow(lead.propertyId)).last_ai_escalation_reason).toBe("classifier_engine_unreadable");
  });

  it("engine column missing (pre-migration): today's path, no hold for it, nine never asked", async () => {
    await seedOrg();
    const lead = await seedLead();
    const inbound = await seedThread(lead, "maybe later");
    await dispatchAiResponse(
      withEngineReadError({ code: "42703", message: "column ai_responder_configs.classifier_engine does not exist" }),
      { propertyId: lead.propertyId, contactId: lead.contactId, conversationId: inbound.conversationId, inboundMessageId: inbound.id, inboundBody: "maybe later", inboundFromPhone: lead.phone, inboundToPhone: MOCK_SENDER_PRIMARY },
      { anthropic: NO_ANTHROPIC },
    );
    expect(jevCalls.every((c) => !("our_last_text_to_homeowner" in c.state))).toBe(true);
    expect((await propertyRow(lead.propertyId)).last_ai_escalation_reason).not.toBe("classifier_engine_unreadable");
  });

  it("shadow tape order: the first jev/classify step is the eight-answer one; the nine run is shadow/nine_classify", async () => {
    await seedOrg({ mode: "shadow" });
    const lead = await seedLead();
    jevProbabilities = { maybe_later: 0.9 };
    const inbound = await seedThread(lead, "maybe later");
    const ctx = await startRun(supabase, { orgId, inboundMessageId: inbound.id, propertyId: lead.propertyId, contactId: lead.contactId } as never);
    expect(ctx).not.toBeNull();
    await dispatchAiResponse(
      supabase,
      { propertyId: lead.propertyId, contactId: lead.contactId, conversationId: inbound.conversationId, inboundMessageId: inbound.id, inboundBody: "maybe later", inboundFromPhone: lead.phone, inboundToPhone: MOCK_SENDER_PRIMARY, runId: ctx!.runId },
      { anthropic: NO_ANTHROPIC },
    );
    const { data: steps } = await supabase.from("pipeline_run_steps").select("seq, kind, name, detail").eq("run_id", ctx!.runId).order("seq");
    const classify = (steps ?? []).filter((x) => x.kind === "jev" && x.name === "classify");
    expect(classify.length).toBeGreaterThan(0);
    for (const c of classify) expect(c.detail).not.toHaveProperty("shadow_engine");
    const nine = (steps ?? []).filter((x) => x.name === "nine_classify");
    expect(nine).toHaveLength(1);
    expect(nine[0]).toMatchObject({ kind: "shadow" });
    expect(nine[0]!.detail).toMatchObject({ shadow_engine: "nine_questions", answer: "maybe_later" });
  });

  // PR 2's hot-wins precedence on the nine answers (price keyword in the text).
  const PRICE = "how much would you pay";
  it.each([
    ["maybe_later", { maybe_later: 0.8 }],
    ["not_interested", { not_interested: 0.85 }],
    ["needs_person", { confirmed_owner: 0.3 }],
    ["asked_who", { asked_who: 0.9 }],
    ["confirmed_owner", { confirmed_owner: 0.9 }],
  ] as Array<[string, Partial<Record<NineQuestionId, number>>]>)("price keyword + %s: hot hold keyword:price_offer, no text, no drip", async (_a, probs) => {
    await seedOrg();
    const { lead } = await run(probs, `not right now, ${PRICE}`);
    expect(await outboundBodies(lead.propertyId)).toEqual([]);
    expect(await enrollmentsFor(lead.propertyId)).toEqual([]);
    expect((await propertyRow(lead.propertyId)).last_ai_escalation_reason).toBe("keyword:price_offer");
  });

  it("price keyword + asked_stop: asked_stop wins, not a hot hold", async () => {
    await seedOrg();
    const { lead } = await run({ asked_stop: 0.95 }, `STOP, ${PRICE}`);
    expect((await propertyRow(lead.propertyId)).last_ai_escalation_reason).toBe("nine_asked_stop");
    expect(await outboundBodies(lead.propertyId)).toEqual([]);
  });

  // Mixed legal + price text, and the gates that keep a price text silent.
  const LAWYER_PRICE = "My lawyer is involved. What's your price?";
  it.each([
    ["maybe_later", { maybe_later: 0.8 }],
    ["needs_person", { confirmed_owner: 0.3 }],
  ] as Array<[string, Partial<Record<NineQuestionId, number>>]>)("lawyer + price, nine answer %s: held under the legal tier (not price_offer), one hot text record, nothing sent", async (_a, probs) => {
    await seedOrg();
    await seedOwner();
    const { lead } = await run(probs, LAWYER_PRICE);
    const reason = (await propertyRow(lead.propertyId)).last_ai_escalation_reason;
    expect(reason).toMatch(/^keyword:/);
    expect(reason).not.toBe("keyword:price_offer");
    expect(await hotTextRecords(lead.propertyId)).toBe(1);
    expect(await outboundBodies(lead.propertyId)).toEqual([]);
    expect(getMockMessageLog()).toHaveLength(0);
    expect(await enrollmentsFor(lead.propertyId)).toEqual([]);
  });

  it("lawyer + price, nine answer asked_stop: the hold stays, no hot record, nothing sent", async () => {
    await seedOrg();
    await seedOwner();
    const { lead } = await run({ asked_stop: 0.95 }, LAWYER_PRICE);
    const row = await propertyRow(lead.propertyId);
    expect(row.needs_human_attention).toBe(true);
    expect(await hotTextRecords(lead.propertyId)).toBe(0);
    expect(getMockMessageLog()).toHaveLength(0);
  });

  it("opted-out contact + price text: no hot hold, no hot record, nothing sent", async () => {
    await seedOrg();
    await seedOwner();
    const lead = await seedLead({ optedOut: true });
    const { lead: l } = await run({ talked_price: 0.9 }, "what is your price, how much would you pay", lead);
    const row = await propertyRow(l.propertyId);
    expect(row.needs_human_attention).toBe(false);
    expect(row.last_ai_escalation_reason).toBeNull();
    expect(await hotTextRecords(l.propertyId)).toBe(0);
    expect(getMockMessageLog()).toHaveLength(0);
  });

  it.each([
    ["price only", "what is your price, how much would you pay"],
    ["lawyer + price", LAWYER_PRICE],
  ])("responder off for the property + %s: no hold, no hot record, nothing sent", async (_n, text) => {
    await seedOrg();
    await seedOwner();
    const lead = await seedLead({ responderDisabled: true });
    const { lead: l } = await run({ talked_price: 0.9 }, text, lead);
    const row = await propertyRow(l.propertyId);
    expect(row.needs_human_attention).toBe(false);
    expect(row.last_ai_escalation_reason).toBeNull();
    expect(await hotTextRecords(l.propertyId)).toBe(0);
    expect(getMockMessageLog()).toHaveLength(0);
  });

  it("price keyword + wrong_person: the wrong-person path runs, not a hot hold", async () => {
    await seedOrg();
    const { lead } = await run({ wrong_person: 0.9 }, `wrong number, ${PRICE}`);
    expect(await outboundBodies(lead.propertyId)).toEqual([APPROVED_REPLY_TEXTS.wrong_number]);
    const row = await propertyRow(lead.propertyId);
    expect(row.outreach_dispo).toBe("wrong_number");
    expect(row.last_ai_escalation_reason).not.toBe("keyword:price_offer");
  });

  it("classification fails + price keyword: still a hot hold (alert only)", async () => {
    await seedOrg();
    const lead = await seedLead();
    const inbound = await seedThread(lead, `what is your price, ${PRICE}`);
    const keep = globalThis.fetch;
    globalThis.fetch = (async (i: Parameters<typeof fetch>[0], init?: Parameters<typeof fetch>[1]) => {
      const url = typeof i === "string" ? i : i instanceof URL ? i.toString() : i.url;
      if (url.includes("api.typesafe.ai")) return new Response("nope", { status: 401 });
      return realFetch(i, init);
    }) as typeof fetch;
    try {
      await dispatchAiResponse(supabase, { propertyId: lead.propertyId, contactId: lead.contactId, conversationId: inbound.conversationId, inboundMessageId: inbound.id, inboundBody: `what is your price, ${PRICE}`, inboundFromPhone: lead.phone, inboundToPhone: MOCK_SENDER_PRIMARY }, { anthropic: NO_ANTHROPIC });
    } finally {
      globalThis.fetch = keep;
    }
    expect((await propertyRow(lead.propertyId)).last_ai_escalation_reason).toBe("keyword:price_offer");
  });

  async function heldLeadText(probs: Partial<Record<NineQuestionId, number>>, text: string) {
    await seedOrg();
    await seedOwner();
    const lead = await seedLead();
    await supabase.from("properties").update({ needs_human_attention: true, last_ai_escalation_reason: "draft_held", needs_human_attention_since: new Date().toISOString() } as never).eq("id", lead.propertyId);
    jevProbabilities = probs;
    const inbound = await seedThread(lead, text);
    await dispatchAiResponse(supabase, { propertyId: lead.propertyId, contactId: lead.contactId, conversationId: inbound.conversationId, inboundMessageId: inbound.id, inboundBody: text, inboundFromPhone: lead.phone, inboundToPhone: MOCK_SENDER_PRIMARY }, { anthropic: NO_ANTHROPIC });
    const { rows } = await pg.query("select payload from public.lead_events where property_id = $1 and source_type = $2 and source_id = $3", [lead.propertyId, HOT_TEXT_SOURCE_TYPE, inbound.id]);
    return { lead, event: rows[0]?.payload ?? null };
  }

  it("held lead + hot nine answer: the hot text is recorded for Jarrad, nothing is sent", async () => {
    const { lead, event } = await heldLeadText({ talked_price: 0.9 }, "ok how about 200k");
    expect(event).toMatchObject({ held_lead: true });
    expect(await outboundBodies(lead.propertyId)).toEqual([]);
  });

  it("held lead + price keyword on a non-hot answer: the hot text is recorded", async () => {
    expect((await heldLeadText({ maybe_later: 0.8 }, `maybe later, ${PRICE}`)).event).toMatchObject({ held_lead: true });
  });
  it("held lead + price keyword but asked_stop: not recorded", async () => {
    expect((await heldLeadText({ asked_stop: 0.9 }, `stop texting, ${PRICE}`)).event).toBeNull();
  });
  it("held lead + calm non-hot answer: not recorded", async () => {
    expect((await heldLeadText({ maybe_later: 0.8 }, "maybe later")).event).toBeNull();
  });

  it("a partial Jev answer (stop / hostile / wrong_person missing, open_to_selling 0.9) is a failure: held, nothing promoted", async () => {
    await seedOrg();
    await seedOwner();
    jevOmit = ["asked_stop", "hostile", "wrong_person"];
    const { lead } = await run({ open_to_selling: 0.9 }, "yes I would sell");
    const row = await propertyRow(lead.propertyId);
    expect(row.status).toBe("prospect");
    expect(row.last_ai_escalation_reason).toBe("jev_automatic_failed:invalid_response");
    expect(await outboundBodies(lead.propertyId)).toEqual([]);
  });

  it("classification fails + hostile wording + price keyword: the hostile hold wins", async () => {
    await seedOrg();
    const lead = await seedLead();
    const body = `you scammers, ${"how much would you pay"}`;
    const inbound = await seedThread(lead, body);
    const keep = globalThis.fetch;
    globalThis.fetch = (async (i: Parameters<typeof fetch>[0], init?: Parameters<typeof fetch>[1]) => {
      const url = typeof i === "string" ? i : i instanceof URL ? i.toString() : i.url;
      if (url.includes("api.typesafe.ai")) return new Response("nope", { status: 401 });
      return realFetch(i, init);
    }) as typeof fetch;
    try {
      await dispatchAiResponse(supabase, { propertyId: lead.propertyId, contactId: lead.contactId, conversationId: inbound.conversationId, inboundMessageId: inbound.id, inboundBody: body, inboundFromPhone: lead.phone, inboundToPhone: MOCK_SENDER_PRIMARY }, { anthropic: NO_ANTHROPIC });
    } finally {
      globalThis.fetch = keep;
    }
    expect((await propertyRow(lead.propertyId)).last_ai_escalation_reason).toMatch(/^hostile_needs_confirm/);
  });

  it("held lead + hostile wording + price keyword: the hot text is not recorded", async () => {
    expect((await heldLeadText({ maybe_later: 0.8 }, "you scammers, how much would you pay")).event).toBeNull();
  });

  it("nine engine in shadow mode: decision recorded, today's path still acts", async () => {
    await seedOrg({ mode: "shadow" });
    const lead = await seedLead();
    jevProbabilities = { maybe_later: 0.9 };
    const inbound = await seedThread(lead, "maybe later");
    await dispatchAiResponse(
      supabase,
      { propertyId: lead.propertyId, contactId: lead.contactId, conversationId: inbound.conversationId, inboundMessageId: inbound.id, inboundBody: "maybe later", inboundFromPhone: lead.phone, inboundToPhone: MOCK_SENDER_PRIMARY },
      { anthropic: { messages: { create: async () => ({ content: [{ type: "tool_use", id: "t", name: "submit_reply", input: { action: "send_reply", body: "ok", confidence: 0.9, sentiment: "neutral" } }], role: "assistant", stop_reason: "tool_use", usage: { input_tokens: 1, output_tokens: 1 } }) } as unknown as AnthropicLike["messages"] } },
    );
    const { data: runs } = await supabase.from("sms_classification_runs").select("schema_version").eq("property_id", lead.propertyId);
    expect((runs ?? []).some((r) => r.schema_version === "nine_questions_v1")).toBe(true);
    expect(await enrollmentsFor(lead.propertyId)).toEqual([]);
  });
});
