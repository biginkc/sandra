import { execFileSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";

import { createClient } from "@supabase/supabase-js";
import { Client } from "pg";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

import { BMH_ORG_ID, getCanonicalTestOrgId } from "@tests/integration/fixtures/multi-user";
import { MOCK_SENDER_PRIMARY, seedSenderCatalog } from "@tests/integration/delivery";
import { APPROVED_REPLY_TEXTS } from "@/lib/ai-responder/approved-reply-texts";
import { dispatchAiResponse } from "@/lib/ai-responder/dispatch";
import type { AnthropicLike } from "@/lib/ai-responder/generate";
import { resetMockState } from "@/lib/messaging/providers/mock";
import { NINE_QUESTION_IDS, type NineAnswer, type NineQuestionId } from "@/lib/sms-classification/nine-questions";
import type { Database } from "@/lib/supabase/types";
import { assertLocalOnlyTestEnv } from "@/lib/testing/local-only-test-env";

import { guardedFetch } from "../replay/nine-core";
import { loadCorpus } from "./corpus";
import {
  assertStressDbEnv,
  bucketFromDispatch,
  estimateJevCost,
  mulberry32,
  renderReport,
  stubProbabilities,
  summarize,
  type RunRow,
} from "./core";

/**
 * Messages v2 Stage 5: wording x repeat matrix, DISPATCH lane. The REAL `dispatchAiResponse`
 * (nine-question engine on, new_lead switch on, approved replies seeded, Jarrad's four drips
 * seeded, mock SMS provider) on a DISPOSABLE local stack, one fresh lead per run. The bucket
 * is read back from the real outcome and rows (core.ts bucketFromDispatch).
 *
 * Opt-in and fail closed (core.ts assertStressDbEnv): every binding explicit, loopback, never
 * the long-running dev stack (54321/54322/54329/54331), no hosted refs, no provider credential,
 * MV2_STRESS_DISPOSABLE_DB=1. Provision a throwaway stack with
 * `node e2e/stress/provision-stack.mjs --workdir <dir> --api-port 55431 --db-port 55430`.
 *
 *   MV2_STRESS_JEV=stub   (default) deterministic stub; no paid call; proves the lane end to end
 *   MV2_STRESS_JEV=live   real Jev (key via `op read`, hard request ceiling = run count)
 *   MV2_STRESS_REPEATS    default 3
 *   MV2_STRESS_ONLY       comma-separated scenario ids
 *   MV2_STRESS_OUT_DIR    default test-results/messages-v2-stress
 *
 * Run: npm run stress:messages-v2:db
 */
vi.mock("@/lib/messaging/quiet-hours", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/messaging/quiet-hours")>()),
  checkQuietHours: () => ({ ok: true, localTime: "12:00", zone: "America/Chicago" }),
}));
vi.mock("@/lib/messaging/quiet-hours-recipient", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/messaging/quiet-hours-recipient")>()),
  checkRecipientQuietHours: () => ({ ok: true, state: "MO", localTime: "12:00", florida: false }),
}));

const OP_REF = "op://BMH Secrets/TypeSafe - Jev API Key/credential";
const JEV = process.env.MV2_STRESS_JEV === "live" ? "live" : "stub";
const REPEATS = Number(process.env.MV2_STRESS_REPEATS ?? "3");
const ONLY = process.env.MV2_STRESS_ONLY?.split(",").filter(Boolean) ?? null;
const OUT = path.resolve(process.env.MV2_STRESS_OUT_DIR ?? "test-results/messages-v2-stress");
const DRIPS = ["Maybe later", "Asked who is texting", "Not interested", "Confirmed owner"] as const;

const NO_ANTHROPIC: AnthropicLike = {
  messages: {
    create: async () => {
      throw new Error("Claude must not be called on the nine-question path");
    },
  } as unknown as AnthropicLike["messages"],
};

const pg = new Client({ connectionString: process.env.TEST_SUPABASE_DB_URL });
const supabase = createClient<Database>(process.env.TEST_SUPABASE_URL!, process.env.TEST_SUPABASE_SERVICE_ROLE_KEY!, {
  auth: { persistSession: false, autoRefreshToken: false },
});
const realFetch = globalThis.fetch;
let orgId = "";
let phoneCounter = 0;
/** Set per run: the stub's probabilities for the next Jev call. */
let nextStub: Record<NineQuestionId, number> | null = null;
/** Set per run for outcome_v1 scenarios: the fixture outcome + escalation reason the stub returns. */
let nextOutcomeV1: { outcome: string; escalation: string } | null = null;
let jevCalls = 0;

function installFetch(live: { fetch: typeof fetch } | null) {
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
    if (url.startsWith("https://api.typesafe.ai/")) {
      jevCalls++;
      if (live) return live.fetch(input, init);
      const body = JSON.parse(String(init?.body)) as { questions: Record<string, unknown> };
      if (!("asked_stop" in body.questions)) {
        if (!nextOutcomeV1) throw new Error("the eight-answer request must not be made with the nine-question engine on");
        // outcome_v1 scenario: answer with the corpus fixture outcome (same shape as hot-acceptance-matrix's fake Jev).
        const { outcome, escalation } = nextOutcomeV1;
        return new Response(
          JSON.stringify({
            model: "jev-stub",
            answers: {
              outcome: { choice: outcome, confidence: 0.95, probabilities: { [outcome]: 0.95 } },
              escalation_reason: { choice: escalation, probabilities: { [escalation]: 0.9 } },
            },
          }),
          { status: 200, headers: { "content-type": "application/json" } },
        );
      }
      if (nextOutcomeV1) throw new Error("a nine-question request was made for an outcome_v1 scenario");
      const probs = nextStub ?? Object.fromEntries(NINE_QUESTION_IDS.map((id) => [id, 0.02]));
      const answers = Object.fromEntries(NINE_QUESTION_IDS.map((id) => [id, { choice: "noul", noul: probs[id as NineQuestionId] }]));
      return new Response(JSON.stringify({ answers, model: "jev-stub", usage: { input_tokens: 1, output_tokens: 1 } }), { status: 200, headers: { "content-type": "application/json" } });
    }
    const host = new URL(url).hostname;
    if (host !== "127.0.0.1" && host !== "localhost") throw new Error(`unexpected outbound HTTP in the stress lane: ${url}`);
    return realFetch(input, init);
  }) as typeof fetch;
}

async function seedOrg() {
  await supabase.from("ai_responder_configs").delete().eq("org_id", orgId);
  const { error } = await supabase.from("ai_responder_configs").insert({
    org_id: orgId,
    system_prompt: "stress",
    business_hours_only: false,
    classifier_provider: "jev",
    classifier_mode: "automatic",
    classifier_engine: "nine_questions",
  });
  expect(error).toBeNull();
  await pg.query("delete from public.jev_outcome_thresholds where org_id = $1", [orgId]);
  for (const outcome of ["nurture", "not_interested", "wrong_number", "new_lead"]) {
    await pg.query("insert into public.jev_outcome_thresholds (org_id, outcome, min_confidence, automation_enabled) values ($1, $2, 0.9, true)", [orgId, outcome]);
  }
  const seqIds: string[] = [];
  for (const name of DRIPS) {
    const { data: seq, error: seqError } = await supabase.from("sequences").insert({ org_id: orgId, name, active: true }).select("id").single();
    expect(seqError).toBeNull();
    seqIds.push(seq!.id);
    // Step bodies are harness placeholders on a throwaway database, never sent anywhere.
    const { error: stepError } = await supabase.from("sequence_steps").insert([
      { sequence_id: seq!.id, step_index: 0, delay_after_previous_minutes: 0, action_type: "send_sms", template_body: `STRESS ${name} step one` },
      { sequence_id: seq!.id, step_index: 1, delay_after_previous_minutes: 1440, action_type: "send_sms", template_body: `STRESS ${name} step two` },
    ]);
    expect(stepError).toBeNull();
  }
  await pg.query(
    "update public.ai_responder_configs set nurture_auto_drip = true, nurture_drip_maybe_later_sequence_id = $2, nurture_drip_check_in_60_sequence_id = $2, nurture_drip_listed_not_selling_sequence_id = $2, nurture_drip_hot_book_appointment_sequence_id = $2 where org_id = $1",
    [orgId, seqIds[0]],
  );
  for (const [outcome, content] of [
    ["nurture", APPROVED_REPLY_TEXTS.nurture],
    ["not_interested", APPROVED_REPLY_TEXTS.not_interested],
    ["wrong_number", APPROVED_REPLY_TEXTS.wrong_number],
  ] as const) {
    await pg.query("begin");
    await pg.query("select set_config('sandra.template_approval', 'on', true)");
    const { rows } = await pg.query("insert into public.sms_templates (org_id, name, content, approved_for_auto_send, approved_content, approved_at) values ($1, $2, $3, true, $3, now()) returning id", [orgId, `Auto reply ${outcome}`, content]);
    await pg.query("insert into public.auto_reply_templates (org_id, outcome, template_id) values ($1, $2, $3)", [orgId, outcome, rows[0].id]);
    await pg.query("commit");
  }
}

/** Per-scenario org state: classifier engine and escalation allow-list (null = the column default the org was seeded with). */
let currentOrgState = "";
let seededKeywords: string[] | null = null;
async function applyScenarioOrgState(engine: "nine_questions" | "outcome_v1", keywords: readonly string[] | null) {
  if (!seededKeywords) {
    const { rows } = await pg.query("select escalation_keywords from public.ai_responder_configs where org_id = $1", [orgId]);
    seededKeywords = rows[0].escalation_keywords as string[];
  }
  const key = JSON.stringify([engine, keywords]);
  if (key === currentOrgState) return;
  await pg.query("update public.ai_responder_configs set classifier_engine = $2, escalation_keywords = $3::text[] where org_id = $1", [orgId, engine, keywords ?? seededKeywords]);
  currentOrgState = key;
}

async function seedOwner(): Promise<string> {
  const id = crypto.randomUUID();
  await pg.query("insert into auth.users (id, email, aud, role, instance_id) values ($1, $2, 'authenticated', 'authenticated', '00000000-0000-0000-0000-000000000000')", [id, `stress-owner-${id}@test.local`]);
  await pg.query("insert into public.memberships (user_id, org_id, role) values ($1, $2, 'owner')", [id, orgId]);
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

async function seedLead(disabled: boolean) {
  const phone = `+1816755${String(1000 + phoneCounter++).padStart(4, "0")}`;
  const { data: contact } = await supabase.from("contacts").insert({ org_id: orgId, first_name: "Stress", last_name: "Seller", phone_1: phone, phone_1_type: "mobile" }).select("id").single();
  await supabase.from("consent_events").insert({ contact_id: contact!.id, channel: "sms", event_type: "opt_in_marketing_written", source: "mv2-stress", org_id: orgId });
  const { data: property, error } = await supabase
    .from("properties")
    .insert({ org_id: orgId, address: "STRESS 123 Oak St", state: "MO", status: "prospect", homeowner_contact_id: contact!.id, ...(disabled ? { ai_responder_disabled: true } : {}) })
    .select("id")
    .single();
  expect(error).toBeNull();
  return { propertyId: property!.id, contactId: contact!.id, phone };
}

async function seedThread(lead: { propertyId: string; contactId: string; phone: string }, ourText: string, reply: string) {
  await supabase.from("messages").insert({ org_id: orgId, channel: "sms", direction: "outbound", status: "delivered", property_id: lead.propertyId, contact_id: lead.contactId, from_address: MOCK_SENDER_PRIMARY, to_address: lead.phone, body: ourText, created_at: new Date(Date.now() - 3600_000).toISOString() });
  const { data: inbound, error } = await supabase
    .from("messages")
    .insert({ org_id: orgId, channel: "sms", direction: "inbound", status: "received", property_id: lead.propertyId, contact_id: lead.contactId, from_address: lead.phone, to_address: MOCK_SENDER_PRIMARY, body: reply })
    .select("id, conversation_id")
    .single();
  expect(error).toBeNull();
  return { id: inbound!.id, conversationId: inbound!.conversation_id as string };
}

describe("Messages v2 Stage 5: wording x repeat matrix through the real dispatch (disposable stack)", () => {
  beforeAll(async () => {
    assertStressDbEnv(process.env);
    assertLocalOnlyTestEnv(process.env.TEST_SUPABASE_DB_URL, process.env.TEST_SUPABASE_URL);
    await pg.connect();
    process.env.MESSAGING_PROVIDER = "mock";
    if (JEV === "live") {
      if (!process.env.OP_SERVICE_ACCOUNT_TOKEN) throw new Error("live Jev needs OP_SERVICE_ACCOUNT_TOKEN (op read)");
      process.env.TYPESAFE_API_KEY = execFileSync("op", ["read", OP_REF], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
    } else {
      process.env.TYPESAFE_API_KEY = "stub-key";
    }
    // Reset the tenant tables (throwaway database only; guarded above) and seed one org.
    await pg.query("begin");
    await pg.query("set local session_replication_role = replica");
    await pg.query("delete from public.memberships where org_id = $1", [BMH_ORG_ID]);
    await pg.query("delete from auth.users where email like 'stress-owner-%'");
    await pg.query("commit");
    const { error: resetError } = await supabase.rpc("reset_tenant_tables");
    expect(resetError).toBeNull();
    resetMockState();
    const { error: orgError } = await supabase.from("organizations").upsert({ id: BMH_ORG_ID, name: "BMH (messages v2 stress)" });
    expect(orgError).toBeNull();
    orgId = await getCanonicalTestOrgId(supabase);
    await seedSenderCatalog(supabase, orgId, [MOCK_SENDER_PRIMARY]);
    await seedOwner();
    await seedOrg();
  }, 120_000);

  afterAll(async () => {
    globalThis.fetch = realFetch;
    await pg.end();
  });

  it("runs the corpus and reports flip rate and wrong-bucket rate per scenario", async () => {
    const corpus = loadCorpus().filter((s) => !ONLY || ONLY.includes(s.id));
    const jobs = corpus.flatMap((s) => s.wordings.flatMap((w, wordingIdx) => Array.from({ length: REPEATS }, (_, repeat) => ({ s, w, wordingIdx, repeat }))));
    const est = estimateJevCost(jobs.length);
    const guard = JEV === "live" ? guardedFetch(realFetch, jobs.length) : null;
    installFetch(guard);
    const rnd = mulberry32(Number(process.env.MV2_STRESS_SEED ?? "20261015"));
    const noise = Number(process.env.MV2_STRESS_STUB_NOISE ?? "0");

    const rows: RunRow[] = [];
    for (const j of jobs) {
      if (j.s.jev_engine === "outcome_v1" && JEV === "live") continue; // fixture outcome only; never a paid call on this engine
      await applyScenarioOrgState(j.s.jev_engine ?? "nine_questions", j.s.org_escalation_keywords ?? null);
      nextOutcomeV1 = j.s.jev_engine === "outcome_v1" ? { outcome: j.s.stub_outcome!, escalation: j.s.stub_escalation! } : null;
      nextStub = JEV === "stub" && !nextOutcomeV1 ? stubProbabilities(j.s.expected_answers, { noise, rnd }) : null;
      const lead = await seedLead(j.s.property_disabled === true);
      const inbound = await seedThread(lead, j.s.our_last_text, j.w);
      let bucket: string;
      let answer: NineAnswer | null = null;
      let failed: string | undefined;
      try {
        const outcome = await dispatchAiResponse(
          supabase,
          { propertyId: lead.propertyId, contactId: lead.contactId, conversationId: inbound.conversationId, inboundMessageId: inbound.id, inboundBody: j.w, inboundFromPhone: lead.phone, inboundToPhone: MOCK_SENDER_PRIMARY },
          { anthropic: NO_ANTHROPIC },
        );
        const { data: prop } = await supabase.from("properties").select("needs_human_attention, last_ai_escalation_reason, outreach_dispo, status").eq("id", lead.propertyId).single();
        const { count } = await supabase.from("messages").select("id", { count: "exact", head: true }).eq("property_id", lead.propertyId).eq("direction", "outbound").neq("body", j.s.our_last_text);
        const { data: run } = await supabase.from("sms_classification_runs").select("decision").eq("property_id", lead.propertyId).eq("schema_version", "nine_questions_v1").maybeSingle();
        answer = ((run?.decision as { answer?: NineAnswer } | null)?.answer ?? null);
        bucket = bucketFromDispatch({ outcome: outcome as { outcome: string; reason?: string }, property: prop!, outboundCount: count ?? 0 });
      } catch (e) {
        failed = e instanceof Error ? e.message : String(e);
        bucket = "other:threw";
      }
      rows.push({ scenarioId: j.s.id, wordingIdx: j.wordingIdx, repeat: j.repeat, answer, bucket, ...(failed ? { failed } : {}) });
    }

    const summary = summarize(corpus, rows);
    const generatedAt = new Date().toISOString();
    const md = renderReport({
      lane: "dispatch",
      classifier: JEV,
      summary,
      repeats: REPEATS,
      requests: { made: guard ? guard.count() : 0, estimateUsd: est.usd },
      generatedAt,
      stackHost: new URL(process.env.TEST_SUPABASE_URL!).host,
    });
    mkdirSync(OUT, { recursive: true });
    writeFileSync(path.join(OUT, "dispatch-report.md"), md);
    writeFileSync(path.join(OUT, "dispatch-rows.json"), JSON.stringify({ classifier: JEV, repeats: REPEATS, jevCalls, rows, summary }, null, 1));
    console.log(md);

    // Invariants that hold whatever Jev said: one classification per inbound at most, no seller
    // text ever carried an unapproved body, and the responder-off scenario touched nothing.
    const { count: runs } = await supabase.from("sms_classification_runs").select("id", { count: "exact", head: true }).eq("org_id", orgId);
    expect(runs ?? 0).toBeLessThanOrEqual(jobs.length);
    const approved = new Set<string>([APPROVED_REPLY_TEXTS.nurture, APPROVED_REPLY_TEXTS.not_interested, APPROVED_REPLY_TEXTS.wrong_number, APPROVED_REPLY_TEXTS.hostile]);
    const { data: outbound } = await supabase.from("messages").select("body").eq("org_id", orgId).eq("direction", "outbound").eq("status", "sent");
    const bodies = (outbound ?? []).map((m) => m.body as string).filter((b) => !approved.has(b));
    // The identity reply is also approved text (IDENTITY_REPLY_BODY); anything else is a defect.
    const { IDENTITY_REPLY_BODY } = await import("@/lib/ai-responder/identity");
    expect(bodies.filter((b) => b !== IDENTITY_REPLY_BODY)).toEqual([]);
    expect(summary.overall.failedRuns).toBe(0);
    // With the deterministic stub the harness itself must be deterministic: zero flips. The bucket
    // gates are NOT asserted here even in stub mode, because the non-Jev paths (keyword gate,
    // hostile wording, responder off) are real product behaviour and a red gate is a finding to
    // report (STRESS-RESULTS.md), not a harness defect. The report above carries the verdict.
    if (JEV === "stub" && noise === 0) expect(summary.overall.flipRate).toBe(0);
  }, 3_600_000);
});
