import { randomUUID } from "node:crypto";

import { Client } from "pg";
import { afterAll, beforeAll, expect, it, vi } from "vitest";

import { createTestClient } from "@tests/integration/client";

vi.mock("@/lib/errors/report", () => ({ reportError: vi.fn(), reportInfo: vi.fn() }));
vi.mock("@/lib/messaging/quiet-hours", () => ({
  checkQuietHours: vi.fn(() => ({ ok: true, localTime: "10:00", zone: "America/Chicago" })),
}));
vi.mock("@/lib/events", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/events")>()),
  recordLeadEvent: vi.fn(async () => {}),
  recordLeadEvents: vi.fn(async () => {}),
}));

import { pauseEnrollmentsForInboundCall } from "@/lib/norma/inbound-call-pause";
import { processVoicemailDropStep } from "@/lib/sequences/voicemail-drop-step";
import { getMockVoicemailDropLog, resetMockVoicemailDropState } from "@/lib/voicemail-drop/providers/mock";

import { checkVoicemailDropEligibility } from "./eligibility";
import { handleDropCallback, handleDropStatusEvent, supabaseDropStatusStore } from "./status-updates";
import { parseDropCowboyCallback, parseDropCowboyStatusWebhook } from "./webhook";

// Every voicemail-drop read and write runs here through the REAL service-role
// client against the migrated grants, as in production. The unit tests use a
// fake client, so a table the service role cannot read (acquisition_attempts:
// "permission denied") only shows up here. Seeding of rows the service role
// may not write goes through a direct superuser connection.
const client = createTestClient();
const db = new Client({ connectionString: process.env.TEST_SUPABASE_DB_URL });
const org = randomUUID();
const user = randomUUID();
const sequence = randomUUID();
const property = randomUUID();
const deletedProperty = randomUUID();
const contact = randomUUID();
const callId = randomUUID();
const PHONE = "+18165550142";
let step0!: string;

const ok = <T extends { error: { message: string } | null }>(r: T): T => {
  if (r.error) throw new Error(r.error.message);
  return r;
};

beforeAll(async () => {
  await db.connect();
  await db.query(
    "insert into auth.users (id, instance_id, aud, role, email) values ($1, '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated', $2)",
    [user, `rvm-grants-${user}@example.test`],
  );
  ok(await client.from("organizations").insert({ id: org, name: `RVM grants ${org}` }));
  ok(await client.from("contacts").insert({ id: contact, org_id: org, first_name: "Pat", phone_1: "816-555-0142", phone_1_type: "mobile" }));
  ok(await client.from("properties").insert([
    { id: property, org_id: org, address: "1 Main", state: "MO", homeowner_contact_id: contact },
    { id: deletedProperty, org_id: org, address: "2 Main", state: "MO", homeowner_contact_id: contact },
  ]));
  // Spoken to only through a reached acquisition attempt (no talk time on the
  // call row), so eligibility depends on the acquisition_attempts read.
  ok(await client.from("call_activities").insert({
    id: callId, org_id: org, property_id: property, contact_id: contact, phone_e164: PHONE,
    provider: "dialpad", jitter_attempt_id: `rvm-grants-${org}`, talk_duration_seconds: 0, started_at: new Date().toISOString(),
  } as never));
  await db.query(
    `insert into public.acquisition_attempts
       (org_id, property_id, actor_user_id, attempt_kind, source, occurred_at, idempotency_key, outcome, call_activity_id, provider_attempt_key)
     values ($1, $2, $3, 'call', 'sandra', now(), gen_random_uuid(), 'reached', $4, $5)`,
    [org, property, user, callId, `rvm-grants-${org}`],
  );
  ok(await client.from("sequences").insert({ id: sequence, org_id: org, name: "RVM grants" }));
  const steps = ok(await client.from("sequence_steps").insert([
    { sequence_id: sequence, step_index: 0, action_type: "send_voicemail_drop", vm_tts_body: "Hi {{first_name}}", vm_voice_id: "v1", vm_phone_line_id: "l1", delay_after_previous_minutes: 0 },
    { sequence_id: sequence, step_index: 1, action_type: "send_sms", template_body: "Hello", delay_after_previous_minutes: 60 },
  ]).select("id, step_index"));
  step0 = steps.data!.find((s) => s.step_index === 0)!.id;
});

afterAll(async () => {
  await client.from("voicemail_drops").delete().eq("org_id", org);
  await client.from("sequence_enrollments").delete().eq("org_id", org);
  await client.from("sequences").delete().eq("org_id", org);
  await client.from("norma_inbound_calls").delete().eq("org_id", org);
  await db.query("delete from public.acquisition_attempts where org_id = $1", [org]);
  await client.from("call_activities").delete().eq("org_id", org);
  await client.from("properties").update({ homeowner_contact_id: null }).eq("org_id", org);
  await client.from("contacts").delete().eq("org_id", org);
  await client.from("properties").delete().eq("org_id", org);
  await client.from("webhook_events").delete().eq("provider", "dropcowboy").like("external_id", `rg-${org}%`);
  await client.from("organizations").delete().eq("id", org);
  await db.query("delete from auth.users where id = $1", [user]);
  await db.end();
});

it("runs as the real service role: acquisition_attempts is not readable directly (prod grants)", async () => {
  const direct = await client.from("acquisition_attempts").select("id").limit(1);
  expect(direct.error?.message).toMatch(/permission denied/);
  const fn = await db.query(
    "select has_function_privilege('service_role', p, 'execute') s, has_function_privilege('authenticated', p, 'execute') a, has_function_privilege('anon', p, 'execute') n from (select 'public.get_voicemail_drop_reached_attempt_facts(uuid,uuid)'::regprocedure p) x",
  );
  expect(fn.rows[0]).toEqual({ s: true, a: false, n: false });
});

it("eligibility reads a reached acquisition attempt through the definer RPC", async () => {
  const result = await checkVoicemailDropEligibility(client, { orgId: org, contactId: contact, propertyId: property });
  expect(result).toMatchObject({ eligible: true, phone: PHONE, basis: "acquisition_attempt_reached" });
});

it("the RPC is org-, property- and deleted-scoped", async () => {
  const facts = async (o: string, p: string) =>
    ok(await client.rpc("get_voicemail_drop_reached_attempt_facts", { p_org_id: o, p_property_id: p })).data;
  expect(await facts(org, property)).toEqual([{ call_activity_id: callId, occurred_at: expect.any(String) }]);
  expect(await facts(randomUUID(), property)).toEqual([]);
  expect(await facts(org, deletedProperty)).toEqual([]);
  await db.query("update public.properties set deleted_at = now() where id = $1", [property]);
  try {
    expect(await facts(org, property)).toEqual([]);
  } finally {
    await db.query("update public.properties set deleted_at = null where id = $1", [property]);
  }
});

it("worker drop path, status/receipt handlers and the call-back pause all run under the service role", async () => {
  resetMockVoicemailDropState();
  const enrollment = randomUUID();
  ok(await client.from("sequence_enrollments").insert({
    id: enrollment, org_id: org, sequence_id: sequence, property_id: property, contact_id: contact,
    status: "active", current_step_index: 0, next_run_at: new Date().toISOString(),
  }));
  const run = ok(await client.from("sequence_step_runs").insert({
    enrollment_id: enrollment, step_id: step0, scheduled_for: new Date().toISOString(), claim_active: true,
    attempt_outcome: "not_attempted",
  }).select("id").single()).data!.id;

  const env = {
    VOICEMAIL_DROP_PROVIDER: "mock",
    DROPCOWBOY_CALLBACK_SECRET: "cb-secret",
    NEXT_PUBLIC_APP_URL: "https://sandra.test",
  } as unknown as NodeJS.ProcessEnv;
  const outcome = await processVoicemailDropStep(
    client,
    { id: enrollment, org_id: org, sequence_id: sequence, property_id: property, contact_id: contact, current_step_index: 0 },
    { id: step0, step_index: 0, vm_media_id: null, vm_tts_body: "Hi {{first_name}}", vm_voice_id: "v1", vm_phone_line_id: "l1" },
    { state: "MO" },
    run,
    env,
  );
  expect(outcome).toMatchObject({ status: "voicemail_queued", enrollmentId: enrollment, stepIndex: 0 });
  expect(getMockVoicemailDropLog()).toHaveLength(1);
  expect(getMockVoicemailDropLog()[0].input).toMatchObject({ to: PHONE });
  const drop = ok(await client.from("voicemail_drops").select("id, to_phone, status, attempt_outcome").eq("step_run_id", run).single()).data!;
  expect(drop).toMatchObject({ to_phone: PHONE, status: "queued", attempt_outcome: "queued" });
  const runRow = ok(await client.from("sequence_step_runs").select("attempt_outcome, failure_reason, skipped_reason").eq("id", run).single()).data!;
  expect(runRow).toMatchObject({ attempt_outcome: "accepted", failure_reason: null, skipped_reason: null });
  expect(ok(await client.from("sequence_enrollments").select("status, current_step_index").eq("id", enrollment).single()).data)
    .toMatchObject({ status: "active", current_step_index: 1 });

  const store = supabaseDropStatusStore(client);
  const cb = parseDropCowboyCallback(JSON.stringify({ foreign_id: drop.id, drop_id: `rg-${org}`, status: "success", reason_code: 0 }));
  expect((await handleDropCallback(store, cb)).status).toBe(200);
  const event = parseDropCowboyStatusWebhook(JSON.stringify({
    event: "contact.rvm.status", event_id: `rg-${org}-1`,
    data: { to: PHONE, drop_id: `rg-${org}`, campaign_type: "rvm", status: "success", reason_code: 0 },
  }));
  expect(ok(await client.from("voicemail_drops").select("status").eq("id", drop.id).single()).data!.status).toBe("delivered");
  expect(await handleDropStatusEvent(store, event)).toBe("applied");
  expect(ok(await client.from("voicemail_drops").select("status").eq("id", drop.id).single()).data!.status).toBe("delivered");

  await client.from("sequence_enrollments").update({ status: "active", pause_reason: null }).eq("id", enrollment);
  const call = ok(await client.from("norma_inbound_calls")
    .insert({ org_id: org, provider_call_id: `rg-${org}`, from_e164: PHONE, to_e164: "+18165550199" } as never)
    .select("id").single());
  const paused = await pauseEnrollmentsForInboundCall(client, (call.data as { id: string }).id);
  expect(paused.matchedContactIds).toEqual([contact]);
  expect(ok(await client.from("sequence_enrollments").select("status, pause_reason").eq("id", enrollment).single()).data)
    .toMatchObject({ status: "paused", pause_reason: "inbound_call" });
});
