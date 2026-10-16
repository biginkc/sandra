import { randomUUID } from "node:crypto";

import type { SupabaseClient } from "@supabase/supabase-js";
import type { Client } from "pg";

import { APPROVED_REPLY_TEXTS } from "@/lib/ai-responder/approved-reply-texts";
import { NINE_QUESTION_IDS, type NineQuestionId } from "@/lib/sms-classification/nine-questions";
import type { Database } from "@/lib/supabase/types";

/**
 * Shared D-lane fixture for Messages v2 Stage 5 Runs 4, 6 and 7 (disposable stack only; the caller runs
 * assertStressDbEnv first). Everything the harness creates lives in the CANARY-STYLE org below (never BMH's
 * org) and every property carries the run tag `STRESS <runId>` at the start of its address, so cleanup.ts can
 * delete by tag alone.
 */
export const CANARY_ORG_ID = "c4a70000-0000-4000-8000-000000005e55";
export const BMH_ORG_ID = "00000000-0000-0000-0000-000000000bbb";
export const DRIPS = ["Maybe later", "Asked who is texting", "Not interested", "Confirmed owner"] as const;

export const runTag = (runId: string) => `STRESS ${runId}`;
export function assertRunId(runId: string): void {
  if (!/^[A-Za-z0-9-]{4,40}$/.test(runId)) throw new Error(`bad run id ${JSON.stringify(runId)} (4-40 of [A-Za-z0-9-])`);
}
export function assertCanaryOrg(orgId: string): void {
  if (orgId === BMH_ORG_ID) throw new Error("refusing BMH's org: the stress harness writes to the canary-style org only");
  if (orgId !== CANARY_ORG_ID) throw new Error(`refusing org ${orgId}: not the stress canary org`);
}

export async function ensureCanaryOrg(supabase: SupabaseClient<Database>): Promise<string> {
  const { error } = await supabase.from("organizations").upsert({ id: CANARY_ORG_ID, name: "STRESS canary (messages v2, disposable)" });
  if (error) throw new Error(`canary org upsert failed: ${error.message}`);
  return CANARY_ORG_ID;
}

/** An active owner of the canary org, inserted directly (no password; RPCs are called as this user through pg). */
export async function seedOwner(pg: Client, orgId: string): Promise<string> {
  assertCanaryOrg(orgId);
  const id = randomUUID();
  await pg.query("insert into auth.users (id, email, aud, role, instance_id) values ($1, $2, 'authenticated', 'authenticated', '00000000-0000-0000-0000-000000000000')", [id, `stress-owner-${id}@test.local`]);
  await pg.query("insert into public.memberships (user_id, org_id, role) values ($1, $2, 'owner')", [id, orgId]);
  return id;
}

/** Runs `fn` inside a transaction as the given user (role authenticated + JWT claims), exactly what PostgREST does. */
export async function asUser<T>(pg: Client, userId: string, fn: () => Promise<T>): Promise<T> {
  await pg.query("begin");
  try {
    await pg.query("set local role authenticated");
    await pg.query("select set_config('request.jwt.claims', $1, true)", [JSON.stringify({ sub: userId, role: "authenticated" })]);
    const out = await fn();
    await pg.query("commit");
    return out;
  } catch (e) {
    await pg.query("rollback");
    throw e;
  }
}

/** Nine-question engine on, four label switches automated, four drips, approved replies, auto drip on. Returns ids. */
export async function seedResponderConfig(pg: Client, supabase: SupabaseClient<Database>, orgId: string): Promise<{ configId: string; seqIds: string[] }> {
  assertCanaryOrg(orgId);
  await supabase.from("ai_responder_configs").delete().eq("org_id", orgId);
  const { data: cfg, error } = await supabase
    .from("ai_responder_configs")
    .insert({ org_id: orgId, system_prompt: "stress", business_hours_only: false, classifier_provider: "jev", classifier_mode: "automatic", classifier_engine: "nine_questions" })
    .select("id")
    .single();
  if (error || !cfg) throw new Error(`config insert failed: ${error?.message}`);
  await pg.query("delete from public.jev_outcome_thresholds where org_id = $1", [orgId]);
  for (const outcome of ["nurture", "not_interested", "wrong_number", "new_lead"]) {
    await pg.query("insert into public.jev_outcome_thresholds (org_id, outcome, min_confidence, automation_enabled) values ($1, $2, 0.9, true)", [orgId, outcome]);
  }
  const seqIds: string[] = [];
  // Re-runnable on the same stack: reuse the canary org's drips if an earlier run made them.
  for (const name of DRIPS) {
    const { rows: existing } = await pg.query("select id from public.sequences where org_id = $1 and name = $2", [orgId, name]);
    if (existing[0]) {
      seqIds.push(existing[0].id as string);
      continue;
    }
    const { data: seq, error: seqError } = await supabase.from("sequences").insert({ org_id: orgId, name, active: true }).select("id").single();
    if (seqError || !seq) throw new Error(`sequence insert failed: ${seqError?.message}`);
    seqIds.push(seq.id);
    const { error: stepError } = await supabase.from("sequence_steps").insert([
      { sequence_id: seq.id, step_index: 0, delay_after_previous_minutes: 0, action_type: "send_sms", template_body: `STRESS ${name} step one` },
      { sequence_id: seq.id, step_index: 1, delay_after_previous_minutes: 1440, action_type: "send_sms", template_body: `STRESS ${name} step two` },
    ]);
    if (stepError) throw new Error(`sequence step insert failed: ${stepError.message}`);
  }
  await pg.query(
    "update public.ai_responder_configs set nurture_auto_drip = true, nurture_drip_maybe_later_sequence_id = $2, nurture_drip_check_in_60_sequence_id = $2, nurture_drip_listed_not_selling_sequence_id = $2, nurture_drip_hot_book_appointment_sequence_id = $2 where org_id = $1",
    [orgId, seqIds[0]],
  );
  await pg.query("delete from public.auto_reply_templates where org_id = $1", [orgId]);
  await pg.query("delete from public.sms_templates where org_id = $1 and name like 'Auto reply %'", [orgId]);
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
  return { configId: cfg.id, seqIds };
}

let phoneCounter = Math.floor(Math.random() * 5000);
export async function seedLead(supabase: SupabaseClient<Database>, orgId: string, runId: string, n: number) {
  assertCanaryOrg(orgId);
  const phone = `+1816756${String(1000 + (phoneCounter++ % 9000)).padStart(4, "0")}`;
  const { data: contact, error: cErr } = await supabase.from("contacts").insert({ org_id: orgId, first_name: "Stress", last_name: runTag(runId), phone_1: phone, phone_1_type: "mobile" }).select("id").single();
  if (cErr || !contact) throw new Error(`contact insert failed: ${cErr?.message}`);
  await supabase.from("consent_events").insert({ contact_id: contact.id, channel: "sms", event_type: "opt_in_marketing_written", source: "mv2-stress", org_id: orgId });
  const { data: property, error } = await supabase
    .from("properties")
    .insert({ org_id: orgId, address: `${runTag(runId)} L${n} Oak St`, state: "MO", status: "prospect", homeowner_contact_id: contact.id })
    .select("id")
    .single();
  if (error || !property) throw new Error(`property insert failed: ${error?.message}`);
  return { propertyId: property.id, contactId: contact.id, phone };
}

/** Stub Jev: the probabilities for the next call come from `next()`; any non-loopback, non-Jev URL throws. */
export function installStubJev(realFetch: typeof fetch, next: () => Record<NineQuestionId, number> | null, counter: { calls: number }) {
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
    if (url.startsWith("https://api.typesafe.ai/")) {
      counter.calls++;
      const probs = next() ?? Object.fromEntries(NINE_QUESTION_IDS.map((id) => [id, 0.02]));
      const answers = Object.fromEntries(NINE_QUESTION_IDS.map((id) => [id, { choice: "noul", noul: probs[id as NineQuestionId] }]));
      return new Response(JSON.stringify({ answers, model: "jev-stub", usage: { input_tokens: 1, output_tokens: 1 } }), { status: 200, headers: { "content-type": "application/json" } });
    }
    const host = new URL(url).hostname;
    if (host !== "127.0.0.1" && host !== "localhost") throw new Error(`unexpected outbound HTTP in the stress lane: ${url}`);
    return realFetch(input, init);
  }) as typeof fetch;
}

/**
 * Run 7 bystanders: untagged rows that cleanup must NOT touch, written before the "before" snapshot so the proof is
 * not trivially 0 -> 0. One lead (contact + property + inbound text) in BMH's org, one in the canary org, and a
 * near-miss in the canary org whose address starts with the run tag plus extra characters (`STRESS <runId>x ...`).
 * All are on a throwaway stack; they are left in place and go away with the stack.
 */
export async function seedBystanders(pg: Client, runId: string): Promise<void> {
  assertRunId(runId);
  for (const [orgId, address] of [
    [BMH_ORG_ID, `BYSTANDER ${runId} 1 Main St`],
    [CANARY_ORG_ID, `BYSTANDER ${runId} 2 Main St`],
    [CANARY_ORG_ID, `${runTag(runId)}x 3 Main St`],
  ] as const) {
    await pg.query("insert into public.organizations (id, name) values ($1, $2) on conflict (id) do nothing", [orgId, orgId === BMH_ORG_ID ? "BMH (stress stack)" : "STRESS canary (messages v2, disposable)"]);
    await pg.query(
      `with c as (insert into public.contacts (org_id, first_name, last_name, phone_1, phone_1_type) values ($1, 'Bystander', $3, '+1913' || lpad((8000000 + floor(random() * 999999))::int::text, 7, '0'), 'mobile') returning id, phone_1),
            p as (insert into public.properties (org_id, address, state, status, homeowner_contact_id) select $1, $2, 'MO', 'prospect', id from c returning id, homeowner_contact_id)
       insert into public.messages (org_id, channel, direction, status, property_id, contact_id, from_address, to_address, body)
       select $1, 'sms', 'inbound', 'received', p.id, p.homeowner_contact_id, c.phone_1, '+18165550000', 'bystander' from p, c`,
      [orgId, address, `BYSTANDER ${runId}`],
    );
  }
}
