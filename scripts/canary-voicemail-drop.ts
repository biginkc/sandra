#!/usr/bin/env tsx
/**
 * Production canary for the send_voicemail_drop drip step. Owner-run only.
 * See e2e/prod-canary/README.md ("Voicemail drop canary").
 *
 *   create:          --script "<approved text>" [--run-id rvm-...] [--kick]
 *   watch:           --watch --run-id rvm-... [--kick]
 *   after callback:  --after-callback --run-id rvm-...
 *   cleanup:         --cleanup --run-id rvm-...
 *
 * Only ever targets +13107540662 and only touches rows named for its run id.
 * The voicemail wording comes from --script; this file has no default text.
 */
import { createClient, type SupabaseClient } from "@supabase/supabase-js";

import type { Database } from "../src/lib/supabase/types";
import { assertProdSupabaseUrl, DEFAULT_PROD_BASE_URL, loadProdCanaryEnvFiles } from "../src/lib/prod-canary/env";
import { checkVoicemailDropEligibility } from "../src/lib/voicemail-drop/eligibility";
import { PROOF_BUCKET } from "../src/lib/voicemail-drop/proof-shared";
import {
  assertCanaryRow, assertCanaryTargetPhone, assertUuid, CANARY_CALL_PROVIDER, CANARY_TARGET_PHONE,
  canaryNames, isWatchDone, parseCanaryArgs, type CanaryArgs,
} from "./canary-voicemail-drop-guards";

type Client = SupabaseClient<Database>;
type Ids = { orgId: string; contactId: string; propertyId: string; sequenceId: string | null; enrollmentId: string | null };

function setup(): { client: Client; args: CanaryArgs; orgId: string } {
  loadProdCanaryEnvFiles();
  const args = parseCanaryArgs(process.argv.slice(2));
  if (process.env.CI) throw new Error("Owner-run only; refusing to run in CI");
  if (process.env.RUN_PROD_CANARIES !== "1") throw new Error("Set RUN_PROD_CANARIES=1 to run production canaries");
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !key) throw new Error("NEXT_PUBLIC_SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY are required");
  assertProdSupabaseUrl(url);
  const orgId = assertUuid(process.env.RVM_CANARY_ORG_ID ?? process.env.SEQUENCE_CANARY_ORG_ID, "RVM_CANARY_ORG_ID");
  const client = createClient<Database>(url, key, { auth: { persistSession: false, autoRefreshToken: false } });
  return { client, args, orgId };
}

function must<T>(result: { data: T; error: { message: string } | null }, what: string): NonNullable<T> {
  if (result.error) throw new Error(`${what}: ${result.error.message}`);
  if (result.data === null) throw new Error(`${what}: no row`);
  return result.data as NonNullable<T>;
}

/** Re-find this run's rows by marker, validating each one. */
async function loadRun(client: Client, orgId: string, runId: string): Promise<Ids | null> {
  const names = canaryNames(runId);
  const contacts = must(await client.from("contacts").select("id,org_id,last_name,phone_1,phone_2,phone_3")
    .eq("org_id", orgId).eq("last_name", names.contactLastName), "contact lookup");
  const properties = must(await client.from("properties").select("id,org_id,address,homeowner_contact_id")
    .eq("org_id", orgId).eq("address", names.propertyAddress), "property lookup");
  if (contacts.length === 0 && properties.length === 0) return null;
  if (contacts.length !== 1 || properties.length !== 1) throw new Error(`Run ${runId}: expected 1 contact and 1 property`);
  assertCanaryRow("contact", contacts[0], runId);
  assertCanaryRow("property", properties[0], runId);
  if (properties[0].homeowner_contact_id !== contacts[0].id) throw new Error("Canary property/contact link mismatch");
  const sequences = must(await client.from("sequences").select("id,name").eq("org_id", orgId).eq("name", names.sequenceName), "sequence lookup");
  if (sequences.length > 1) throw new Error("More than one canary sequence for this run");
  const sequenceId = sequences[0]?.id ?? null;
  let enrollmentId: string | null = null;
  if (sequenceId) {
    const enrollments = must(await client.from("sequence_enrollments").select("id,property_id,contact_id")
      .eq("sequence_id", sequenceId), "enrollment lookup");
    for (const e of enrollments) assertCanaryRow("enrollment", e, runId, { propertyId: properties[0].id, contactId: contacts[0].id });
    if (enrollments.length > 1) throw new Error("More than one canary enrollment for this run");
    enrollmentId = enrollments[0]?.id ?? null;
  }
  return { orgId, contactId: contacts[0].id, propertyId: properties[0].id, sequenceId, enrollmentId };
}

async function kickTick(): Promise<void> {
  const secret = process.env.CRON_SECRET;
  if (!secret) throw new Error("--kick needs CRON_SECRET");
  const base = process.env.PROD_BASE_URL ?? DEFAULT_PROD_BASE_URL;
  if (!base.startsWith("https://")) throw new Error("PROD_BASE_URL must be https");
  const res = await fetch(`${base}/api/cron/sequence-tick`, { headers: { authorization: `Bearer ${secret}` } });
  console.log("[kick] sequence-tick", res.status, (await res.text()).slice(0, 500));
}

async function create(client: Client, orgId: string, args: CanaryArgs): Promise<void> {
  const names = canaryNames(args.runId);
  const voiceId = process.env.DROPCOWBOY_VOICE_ID?.trim();
  if (!voiceId) throw new Error("DROPCOWBOY_VOICE_ID is required");
  const phoneLineId = process.env.DROPCOWBOY_PHONE_LINE_ID?.trim() || null;
  const phone = assertCanaryTargetPhone(CANARY_TARGET_PHONE, "canary target");
  if (await loadRun(client, orgId, args.runId)) throw new Error(`Run ${args.runId} already exists; use a new run id`);
  must(await client.from("organizations").select("id").eq("id", orgId).maybeSingle(), "organization");

  const contact = must(await client.from("contacts").insert({
    org_id: orgId, first_name: names.contactFirstName, last_name: names.contactLastName,
    phone_1: phone, phone_1_type: "mobile", phone_2: null, phone_3: null,
  }).select("id").single(), "contact insert");
  console.log("[create] contact", contact.id);
  const property = must(await client.from("properties").insert({
    org_id: orgId, address: names.propertyAddress, city: "Kansas City", state: "MO", zip: "64151",
    status: "new_lead", homeowner_contact_id: contact.id, is_training: false,
    ai_responder_disabled: true, skip_trace_disabled: true,
    notes: `Created by ${names.marker}. Safe to delete.`,
  }).select("id").single(), "property insert");
  console.log("[create] property", property.id);

  // "Spoken to" fact: a completed call with talk time, provider prod_canary.
  // Every call_activities trigger and enqueue is gated on provider
  // sandra_softphone / dialpad, so nothing else reacts to this row.
  const startedAt = new Date(Date.now() - 2 * 60_000);
  const call = must(await client.from("call_activities").insert({
    org_id: orgId, property_id: property.id, contact_id: contact.id, provider: CANARY_CALL_PROVIDER,
    jitter_attempt_id: names.callAttemptId, direction: "outbound", call_purpose: "customer",
    phone_e164: phone, started_at: startedAt.toISOString(), ended_at: new Date(startedAt.getTime() + 60_000).toISOString(),
    duration_seconds: 60, talk_duration_seconds: 30, notes: `${names.marker} eligibility fact`,
  }).select("id").single(), "call_activities insert");
  console.log("[create] call_activity", call.id);

  const eligibility = await checkVoicemailDropEligibility(client, { orgId, contactId: contact.id, propertyId: property.id });
  console.log("[create] eligibility", JSON.stringify(eligibility));
  if (!eligibility.eligible) throw new Error("Canary lead is not eligible; not enrolling. Run --cleanup.");
  assertCanaryTargetPhone(eligibility.phone, "eligibility phone");

  const sequence = must(await client.from("sequences").insert({
    org_id: orgId, name: names.sequenceName, description: `Created by ${names.marker}. Safe to delete.`,
    active: true, append_opt_out: false,
  }).select("id").single(), "sequence insert");
  const step = must(await client.from("sequence_steps").insert({
    sequence_id: sequence.id, step_index: 0, action_type: "send_voicemail_drop", delay_after_previous_minutes: 0,
    vm_tts_body: args.script, vm_voice_id: voiceId, vm_phone_line_id: phoneLineId,
  }).select("id").single(), "step insert");
  console.log("[create] sequence", sequence.id, "step", step.id);

  // Last check before the row that makes the worker act.
  const fresh = await loadRun(client, orgId, args.runId);
  if (!fresh || fresh.contactId !== contact.id) throw new Error("Canary re-validation failed before enroll");
  const enrollment = must(await client.from("sequence_enrollments").insert({
    org_id: orgId, sequence_id: sequence.id, property_id: property.id, contact_id: contact.id,
    current_step_index: 0, status: "active", next_run_at: new Date().toISOString(),
  }).select("id").single(), "enrollment insert");
  console.log("[create] enrollment", enrollment.id);
  console.log(`\nNext: --watch --run-id ${args.runId}`);
  if (args.kick) await kickTick();
}

async function report(client: Client, ids: Ids, runId: string) {
  if (!ids.enrollmentId) throw new Error("No canary enrollment for this run");
  const enrollment = must(await client.from("sequence_enrollments")
    .select("id,status,pause_reason,current_step_index,next_run_at,completed_at,property_id,contact_id")
    .eq("id", ids.enrollmentId).single(), "enrollment");
  const runs = must(await client.from("sequence_step_runs")
    .select("id,attempt_outcome,skipped_reason,failure_reason,recovery_action,recovery_evidence,run_at,scheduled_for")
    .eq("enrollment_id", ids.enrollmentId), "step runs");
  const drops = must(await client.from("voicemail_drops")
    .select("id,status,attempt_outcome,drop_id,reason,reason_code,to_phone,property_id,contact_id,provider,queued_at,completed_at,proof_url_at,proof_storage_path,proof_copy_status,proof_copy_attempts,proof_copy_error,proof_fetched_at")
    .eq("enrollment_id", ids.enrollmentId), "voicemail drops");
  for (const d of drops) assertCanaryRow("voicemail_drop", d, runId, ids);
  console.log(JSON.stringify({ enrollment, stepRuns: runs, voicemailDrops: drops }, null, 2));
  return { enrollment, drop: drops[0] ?? null };
}

async function watch(client: Client, ids: Ids, args: CanaryArgs): Promise<void> {
  if (args.kick) await kickTick();
  const deadline = Date.now() + 30 * 60_000;
  for (;;) {
    const { enrollment, drop } = await report(client, ids, args.runId);
    if (isWatchDone(drop, enrollment.status)) return;
    if (Date.now() > deadline) throw new Error("Timed out after 30 minutes");
    await new Promise((r) => setTimeout(r, 20_000));
  }
}

async function afterCallback(client: Client, ids: Ids, runId: string): Promise<void> {
  const { enrollment } = await report(client, ids, runId);
  const calls = must(await client.from("norma_inbound_calls").select("id,from_e164,completed,created_at")
    .eq("org_id", ids.orgId).eq("from_e164", CANARY_TARGET_PHONE).order("created_at", { ascending: false }).limit(3), "norma inbound calls");
  console.log(JSON.stringify({ recentInboundCallsFromTarget: calls }, null, 2));
  if (enrollment.status === "paused" && enrollment.pause_reason === "inbound_call") {
    console.log("PASS: enrollment paused with pause_reason=inbound_call");
  } else {
    console.log(`NOT YET: status=${enrollment.status} pause_reason=${enrollment.pause_reason}`);
    process.exitCode = 2;
  }
}

async function cleanup(client: Client, ids: Ids | null, runId: string): Promise<void> {
  if (!ids) { console.log("Nothing to clean for", runId); return; }
  const names = canaryNames(runId);
  // Validate every row before the first delete.
  const callRows = must(await client.from("call_activities").select("id,jitter_attempt_id,provider,property_id")
    .eq("org_id", ids.orgId).eq("jitter_attempt_id", names.callAttemptId), "call lookup");
  for (const c of callRows) {
    assertCanaryRow("call_activity", c, runId);
    if (c.property_id !== ids.propertyId) throw new Error("Canary call is linked to another property");
  }
  const otherLinks = must(await client.from("sequence_enrollments").select("id,sequence_id")
    .eq("property_id", ids.propertyId), "property enrollment lookup");
  if (otherLinks.some((e) => e.sequence_id !== ids.sequenceId)) throw new Error("Canary property is enrolled in a non-canary drip; refusing");
  const drops = ids.enrollmentId
    ? must(await client.from("voicemail_drops").select("id,property_id,contact_id,to_phone,proof_storage_path")
      .eq("enrollment_id", ids.enrollmentId), "drop lookup")
    : [];
  for (const d of drops) assertCanaryRow("voicemail_drop", d, runId, ids);

  const del = async (label: string, req: PromiseLike<{ error: { message: string } | null }>) => {
    const { error } = await req;
    if (error) throw new Error(`cleanup ${label}: ${error.message}`);
    console.log("[cleanup]", label);
  };
  const proofPaths = drops.flatMap((d) => (d.proof_storage_path ? [d.proof_storage_path] : []));
  if (proofPaths.length) {
    const { error } = await client.storage.from(PROOF_BUCKET).remove(proofPaths);
    console.log("[cleanup] proof objects", error ? `kept (${error.message})` : proofPaths.length);
  }
  if (drops.length) await del("voicemail_drops", client.from("voicemail_drops").delete().in("id", drops.map((d) => d.id)));
  if (ids.enrollmentId) {
    await del("step runs", client.from("sequence_step_runs").delete().eq("enrollment_id", ids.enrollmentId));
    await del("enrollment", client.from("sequence_enrollments").delete().eq("id", ids.enrollmentId));
  }
  if (ids.sequenceId) {
    await del("steps", client.from("sequence_steps").delete().eq("sequence_id", ids.sequenceId));
    await del("sequence", client.from("sequences").delete().eq("id", ids.sequenceId).eq("name", names.sequenceName));
  }
  if (callRows.length) await del("call_activities", client.from("call_activities").delete().in("id", callRows.map((c) => c.id)));
  // Property/contact may be held by other FKs (lead events, etc.). Fall back
  // to archiving so the canary lead can never be worked or dialed.
  const { error: propError } = await client.from("properties").delete().eq("id", ids.propertyId).eq("address", names.propertyAddress);
  if (propError) {
    await del("property archived", client.from("properties").update({ deleted_at: new Date().toISOString(), status: "dead" })
      .eq("id", ids.propertyId).eq("address", names.propertyAddress));
  } else console.log("[cleanup] property");
  const { error: contactError } = await client.from("contacts").delete().eq("id", ids.contactId).eq("last_name", names.contactLastName);
  if (contactError) {
    await del("contact archived (do_not_contact)", client.from("contacts").update({ do_not_contact: true })
      .eq("id", ids.contactId).eq("last_name", names.contactLastName));
  } else console.log("[cleanup] contact");
}

async function main() {
  const { client, args, orgId } = setup();
  if (args.mode === "create") return create(client, orgId, args);
  const ids = await loadRun(client, orgId, args.runId);
  if (args.mode === "cleanup") return cleanup(client, ids, args.runId);
  if (!ids) throw new Error(`No canary rows for ${args.runId}`);
  if (args.mode === "watch") return watch(client, ids, args);
  return afterCallback(client, ids, args.runId);
}

main().catch((error) => { console.error(error instanceof Error ? error.message : error); process.exitCode = 1; });
