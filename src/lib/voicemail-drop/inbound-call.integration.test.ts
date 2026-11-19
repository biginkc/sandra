import { randomUUID } from "node:crypto";

import { Client } from "pg";
import { afterAll, beforeAll, expect, it, vi } from "vitest";

import { createTestClient } from "@tests/integration/client";

vi.mock("@/lib/errors/report", () => ({ reportError: vi.fn(), reportInfo: vi.fn() }));

import { handleDropCowboyInboundCall, parseDropCowboyCallEvent, supabaseInboundCallPauseStore } from "./inbound-call";
import { supabaseDropStatusStore } from "./status-updates";

// Runs under the REAL service-role client against the migrated grants: the
// webhook_events dedupe, the voicemail_drops org lookup, the contact match and
// pause_enrollments_for_inbound_call all execute as in production.
const client = createTestClient();
// Superuser connection only for cleanup the service role may not do (lead_events is insert-only).
const db = new Client({ connectionString: process.env.TEST_SUPABASE_DB_URL });
const org = randomUUID();
const otherOrg = randomUUID();
const sequence = randomUUID();
const property = randomUUID();
const contact = randomUUID();
const enrollment = randomUUID();
const otherProperty = randomUUID();
const otherContact = randomUUID();
const otherEnrollment = randomUUID();
const LINE = `line-${org}`;
const PHONE = "+18165550177";
const eventPrefix = `ic-${org}`;

const ok = <T extends { error: { message: string } | null }>(r: T): T => {
  if (r.error) throw new Error(r.error.message);
  return r;
};

const ringing = (eventId: string, ivr: string) =>
  parseDropCowboyCallEvent(JSON.stringify({
    event: "contact.call.ringing",
    event_id: eventId,
    data: { call_id: "c", team_id: "t", ivr_id: ivr, call: { call_id: "c", from: "816.555.0177", to: "+18162032828", call_direction: "inbound" } },
  }));

const statusOf = async (id: string) =>
  ok(await client.from("sequence_enrollments").select("status, pause_reason").eq("id", id).single()).data;

beforeAll(async () => {
  await db.connect();
  ok(await client.from("organizations").insert([{ id: org, name: `RVM call ${org}` }, { id: otherOrg, name: `RVM call other ${otherOrg}` }]));
  ok(await client.from("contacts").insert({ id: contact, org_id: org, first_name: "Pat", phone_2: "(816) 555-0177", phone_2_type: "mobile" }));
  // Same number in an org that never dropped on it: must stay untouched.
  ok(await client.from("contacts").insert({ id: otherContact, org_id: otherOrg, first_name: "Sam", phone_1: "8165550177", phone_1_type: "mobile" }));
  ok(await client.from("properties").insert([
    { id: property, org_id: org, address: "1 Main", state: "MO", homeowner_contact_id: contact },
    { id: otherProperty, org_id: otherOrg, address: "2 Main", state: "MO", homeowner_contact_id: otherContact },
  ]));
  ok(await client.from("sequences").insert([{ id: sequence, org_id: org, name: "RVM call" }]));
  const otherSequence = randomUUID();
  ok(await client.from("sequences").insert([{ id: otherSequence, org_id: otherOrg, name: "RVM call other" }]));
  const step = ok(await client.from("sequence_steps").insert({
    sequence_id: sequence, step_index: 0, action_type: "send_voicemail_drop", vm_tts_body: "Hi", vm_voice_id: "v1", vm_phone_line_id: LINE, delay_after_previous_minutes: 0,
  }).select("id").single()).data!.id;
  ok(await client.from("sequence_enrollments").insert([
    { id: enrollment, org_id: org, sequence_id: sequence, property_id: property, contact_id: contact, status: "active", current_step_index: 1, next_run_at: new Date().toISOString() },
    { id: otherEnrollment, org_id: otherOrg, sequence_id: otherSequence, property_id: otherProperty, contact_id: otherContact, status: "active", current_step_index: 0, next_run_at: new Date().toISOString() },
  ]));
  const run = ok(await client.from("sequence_step_runs").insert({
    enrollment_id: enrollment, step_id: step, scheduled_for: new Date().toISOString(), attempt_outcome: "accepted",
  }).select("id").single()).data!.id;
  ok(await client.from("voicemail_drops").insert({
    org_id: org, enrollment_id: enrollment, step_run_id: run, to_phone: PHONE, status: "delivered", attempt_outcome: "queued",
    idempotency_key: `ic-${run}`, provider: "dropcowboy", audio_kind: "tts", contact_id: contact, property_id: property,
  } as never));
});

afterAll(async () => {
  await db.query("delete from public.lead_events where org_id = any($1::uuid[])", [[org, otherOrg]]);
  for (const o of [org, otherOrg]) {
    await client.from("voicemail_drops").delete().eq("org_id", o);
    await client.from("sequence_enrollments").delete().eq("org_id", o);
    await client.from("sequences").delete().eq("org_id", o);
    await client.from("properties").update({ homeowner_contact_id: null }).eq("org_id", o);
    await client.from("contacts").delete().eq("org_id", o);
    await client.from("properties").delete().eq("org_id", o);
  }
  await client.from("webhook_events").delete().eq("provider", "dropcowboy").like("external_id", `${eventPrefix}%`);
  await db.query("delete from public.lead_events where org_id = any($1::uuid[])", [[org, otherOrg]]);
  ok(await client.from("organizations").delete().in("id", [org, otherOrg]));
  await db.end();
});

it("a call to another line is ignored and records nothing", async () => {
  const outcome = await handleDropCowboyInboundCall(
    supabaseDropStatusStore(client), supabaseInboundCallPauseStore(client), ringing(`${eventPrefix}-0`, "other-line"), LINE,
  );
  expect(outcome).toBe("ignored_other_line");
  expect(await statusOf(enrollment)).toMatchObject({ status: "active" });
  expect(ok(await client.from("webhook_events").select("id").like("external_id", `${eventPrefix}%`)).data).toEqual([]);
});

it("the real caller's drips pause as inbound_call in the dropping org only; a replay is a no-op", async () => {
  const events = supabaseDropStatusStore(client);
  const pauses = supabaseInboundCallPauseStore(client);
  expect(await handleDropCowboyInboundCall(events, pauses, ringing(`${eventPrefix}-1`, LINE), LINE)).toBe("paused");
  expect(await statusOf(enrollment)).toMatchObject({ status: "paused", pause_reason: "inbound_call" });
  expect(await statusOf(otherEnrollment)).toMatchObject({ status: "active", pause_reason: null });
  const row = ok(await client.from("webhook_events").select("processing_status, signature_verified")
    .match({ provider: "dropcowboy", event_type: "contact.call.ringing", external_id: `${eventPrefix}-1` }).single()).data;
  expect(row).toEqual({ processing_status: "processed", signature_verified: true });

  // Replay: someone resumes the drip, then the same event arrives again.
  ok(await client.from("sequence_enrollments").update({ status: "active", pause_reason: null }).eq("id", enrollment));
  expect(await handleDropCowboyInboundCall(events, pauses, ringing(`${eventPrefix}-1`, LINE), LINE)).toBe("duplicate");
  expect(await statusOf(enrollment)).toMatchObject({ status: "active", pause_reason: null });
});
