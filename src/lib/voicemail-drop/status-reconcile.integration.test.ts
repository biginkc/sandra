import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, beforeEach, expect, it, vi } from "vitest";

import { createTestClient } from "@tests/integration/client";

vi.mock("@/lib/errors/report", () => ({ reportError: vi.fn(), reportInfo: vi.fn() }));

import {
  handleDropCallback,
  handleDropStatusEvent,
  reconcileHeldDropWithClient,
  supabaseDropStatusStore,
} from "./status-updates";
import { parseDropCowboyCallback, parseDropCowboyStatusWebhook } from "./webhook";

// Real-DB proof of the held-drop reconciliation (fix 1): a callback or signed
// status event for a drop whose POST outcome was unknown marks the run
// accepted, advances the paused enrollment and never touches the provider.
const client = createTestClient();
const org = randomUUID();
const sequence = randomUUID();
const property = randomUUID();
let step0!: string;
let enrollment!: string;
let run!: string;
let dropRow!: string;

beforeAll(async () => {
  const ok = (r: { error: { message: string } | null }) => {
    if (r.error) throw new Error(r.error.message);
  };
  ok(await client.from("organizations").insert({ id: org, name: `Drop reconcile ${org}` }));
  ok(await client.from("sequences").insert({ id: sequence, org_id: org, name: "Reconcile" }));
  const steps = await client
    .from("sequence_steps")
    .insert([
      { sequence_id: sequence, step_index: 0, action_type: "send_voicemail_drop", vm_tts_body: "Hi", delay_after_previous_minutes: 0 },
      { sequence_id: sequence, step_index: 1, action_type: "send_sms", template_body: "Hello", delay_after_previous_minutes: 60 },
    ])
    .select("id, step_index");
  ok(steps);
  step0 = steps.data!.find((s) => s.step_index === 0)!.id;
  ok(await client.from("properties").insert({ id: property, org_id: org, address: "1 Main", state: "MO" }));
});

beforeEach(async () => {
  await client.from("voicemail_drops").delete().eq("org_id", org);
  await client.from("sequence_enrollments").delete().eq("org_id", org);
  enrollment = randomUUID();
  const e = await client.from("sequence_enrollments").insert({
    id: enrollment, org_id: org, sequence_id: sequence, property_id: property,
    status: "paused", pause_reason: "reconciliation_required", current_step_index: 0,
  });
  if (e.error) throw new Error(e.error.message);
  const r = await client.from("sequence_step_runs").insert({
    enrollment_id: enrollment, step_id: step0, scheduled_for: new Date().toISOString(), claim_active: true,
    run_at: new Date().toISOString(), attempt_outcome: "unknown", skipped_reason: "provider_failed",
    failure_reason: "voicemail drop outcome unknown (timeout)",
  }).select("id").single();
  if (r.error) throw new Error(r.error.message);
  run = r.data.id;
  const d = await client.from("voicemail_drops").insert({
    org_id: org, enrollment_id: enrollment, step_run_id: run, idempotency_key: run,
    to_phone: "+18165550101", provider: "dropcowboy", audio_kind: "tts", attempt_outcome: "unknown",
  }).select("id").single();
  if (d.error) throw new Error(d.error.message);
  dropRow = d.data.id;
});

afterAll(async () => {
  await client.from("voicemail_drops").delete().eq("org_id", org);
  await client.from("sequence_enrollments").delete().eq("org_id", org);
  await client.from("properties").delete().eq("org_id", org);
  await client.from("sequences").delete().eq("org_id", org);
  await client.from("webhook_events").delete().eq("provider", "dropcowboy").like("external_id", `rc-${org}%`);
  await client.from("organizations").delete().eq("id", org);
});

async function state() {
  const [r, e, d] = await Promise.all([
    client.from("sequence_step_runs").select("attempt_outcome, claim_active, skipped_reason, recovery_action").eq("id", run).single(),
    client.from("sequence_enrollments").select("status, pause_reason, current_step_index, next_run_at").eq("id", enrollment).single(),
    client.from("voicemail_drops").select("status, attempt_outcome, queued_at").eq("id", dropRow).single(),
  ]);
  return { run: r.data!, enrollment: e.data!, drop: d.data! };
}

const callback = () =>
  parseDropCowboyCallback(JSON.stringify({ foreign_id: dropRow, drop_id: `dc-${org}`, status: "success", reason_code: 0 }));

it("a callback reconciles: run accepted with claim kept, enrollment advanced, drop delivered; replay is a no-op", async () => {
  const store = supabaseDropStatusStore(client);
  expect((await handleDropCallback(store, callback())).status).toBe(200);
  const after = await state();
  expect(after.run).toMatchObject({ attempt_outcome: "accepted", claim_active: true, skipped_reason: null, recovery_action: "voicemail_drop_reconciled" });
  expect(after.enrollment).toMatchObject({ status: "active", pause_reason: null, current_step_index: 1 });
  expect(after.drop).toMatchObject({ status: "delivered", attempt_outcome: "queued" });
  expect(after.drop.queued_at).not.toBeNull();

  await handleDropCallback(store, callback());
  const replay = await state();
  expect(replay.enrollment.current_step_index).toBe(1);
  expect(replay.enrollment.next_run_at).toBe(after.enrollment.next_run_at);
});

it("a signed status event correlated by phone reconciles the same way", async () => {
  const store = supabaseDropStatusStore(client);
  const event = parseDropCowboyStatusWebhook(JSON.stringify({
    event: "contact.rvm.status", event_id: `rc-${org}-1`,
    data: { to: "+18165550101", drop_id: `dc2-${org}`, campaign_type: "rvm", status: "failure", reason_code: 4001 },
  }));
  expect(await handleDropStatusEvent(store, event)).toBe("applied");
  const after = await state();
  expect(after.run.attempt_outcome).toBe("accepted");
  expect(after.enrollment).toMatchObject({ status: "active", current_step_index: 1 });
  expect(after.drop).toMatchObject({ status: "failed", attempt_outcome: "queued" });
});

async function dropRowNow() {
  const d = await client.from("voicemail_drops").select("*").eq("id", dropRow).single();
  if (d.error) throw new Error(d.error.message);
  return d.data;
}

it("claim already released: not_held, enrollment not advanced, drop left unknown", async () => {
  await client.from("sequence_step_runs").update({ claim_active: false }).eq("id", run);
  expect(await reconcileHeldDropWithClient(client, await dropRowNow())).toBe("not_held");
  const after = await state();
  expect(after.run.attempt_outcome).toBe("unknown");
  expect(after.enrollment).toMatchObject({ status: "paused", pause_reason: "reconciliation_required", current_step_index: 0 });
  expect(after.drop.attempt_outcome).toBe("unknown");
});

it("claim released between the run read and the accept write: CAS misses, not_held, no advance", async () => {
  // Release the claim right after reconcile reads the run row.
  let first = true;
  const racing = new Proxy(client, {
    get(target, prop, receiver) {
      if (prop !== "from") return Reflect.get(target, prop, receiver);
      return (table: string) => {
        const builder = target.from(table as never);
        if (table !== "sequence_step_runs" || !first) return builder;
        first = false;
        const select = builder.select.bind(builder);
        (builder as { select: unknown }).select = (...args: Parameters<typeof select>) => {
          const q = select(...args);
          const maybeSingle = q.maybeSingle.bind(q);
          (q as { maybeSingle: unknown }).maybeSingle = async () => {
            const r = await maybeSingle();
            await target.from("sequence_step_runs").update({ claim_active: false }).eq("id", run);
            return r;
          };
          return q;
        };
        return builder;
      };
    },
  });
  expect(await reconcileHeldDropWithClient(racing, await dropRowNow())).toBe("not_held");
  const after = await state();
  expect(after.run).toMatchObject({ attempt_outcome: "unknown", claim_active: false });
  expect(after.enrollment).toMatchObject({ status: "paused", current_step_index: 0 });
  expect(after.drop.attempt_outcome).toBe("unknown");
});

it("replay after a crash between step 1 and step 2 converges without double-advance", async () => {
  // Step 1 landed (run accepted), then the process died: enrollment still
  // paused, drop row still unknown.
  await client.from("sequence_step_runs").update({ attempt_outcome: "accepted", skipped_reason: null }).eq("id", run);
  expect(await reconcileHeldDropWithClient(client, await dropRowNow())).toBe("reconciled");
  const once = await state();
  expect(once.enrollment).toMatchObject({ status: "active", current_step_index: 1 });
  expect(once.drop.attempt_outcome).toBe("queued");

  expect(await reconcileHeldDropWithClient(client, await dropRowNow())).toBe("not_held");
  const twice = await state();
  expect(twice.enrollment.current_step_index).toBe(1);
  expect(twice.enrollment.next_run_at).toBe(once.enrollment.next_run_at);
});

it("phone fallback ignores a broadcast outcome and never picks a drop holding another drop_id", async () => {
  const store = supabaseDropStatusStore(client);
  const broadcast = parseDropCowboyStatusWebhook(JSON.stringify({
    event: "contact.rvm.status", event_id: `rc-${org}-bc`,
    data: { to: "+18165550101", drop_id: `bc-${org}`, campaign_type: "ai_broadcast", status: "success", reason_code: 0 },
  }));
  expect(await handleDropStatusEvent(store, broadcast)).toBe("unmatched");
  expect((await state()).drop).toMatchObject({ status: "queued", attempt_outcome: "unknown" });

  await client.from("voicemail_drops").update({ drop_id: `mine-${org}` }).eq("id", dropRow);
  const other = parseDropCowboyStatusWebhook(JSON.stringify({
    event: "contact.rvm.status", event_id: `rc-${org}-other`,
    data: { to: "+18165550101", drop_id: `other-${org}`, campaign_type: "rvm", status: "success", reason_code: 0 },
  }));
  expect(await handleDropStatusEvent(store, other)).toBe("unmatched");
  expect((await state()).drop.status).toBe("queued");

  const real = parseDropCowboyStatusWebhook(JSON.stringify({
    event: "contact.rvm.status", event_id: `rc-${org}-real`,
    data: { to: "+18165550101", drop_id: `mine-${org}`, campaign_type: "rvm", status: "failure", reason_code: 4016 },
  }));
  expect(await handleDropStatusEvent(store, real)).toBe("applied");
  const after = await state();
  expect(after.drop.status).toBe("failed");
  expect(after.enrollment).toMatchObject({ status: "paused", pause_reason: "voicemail_drop_consent_blocked", current_step_index: 1 });
});

it("a seller call-back during reconciliation sticks: reconcile no longer advances the enrollment", async () => {
  const { pauseEnrollmentsForInboundCall } = await import("@/lib/norma/inbound-call-pause");
  const contact = randomUUID();
  const ok = (r: { error: { message: string } | null }) => {
    if (r.error) throw new Error(r.error.message);
  };
  ok(await client.from("contacts").insert({ id: contact, org_id: org, phone_1: "8165550101", phone_1_type: "mobile" }));
  ok(await client.from("properties").update({ homeowner_contact_id: contact }).eq("id", property));
  const call = await client.from("norma_inbound_calls")
    .insert({ org_id: org, provider_call_id: `pc-${org}`, from_e164: "+18165550101", to_e164: "+18165550199" } as never).select("id").single();
  if (call.error) throw new Error(call.error.message);
  try {
    const result = await pauseEnrollmentsForInboundCall(client, (call.data as { id: string }).id);
    expect(result.matchedContactIds).toEqual([contact]);
    expect((await state()).enrollment).toMatchObject({ status: "paused", pause_reason: "inbound_call" });

    await handleDropCallback(supabaseDropStatusStore(client), callback());
    expect((await state()).enrollment).toMatchObject({ status: "paused", pause_reason: "inbound_call", current_step_index: 0 });
  } finally {
    await client.from("norma_inbound_calls").delete().eq("org_id", org);
    await client.from("properties").update({ homeowner_contact_id: null }).eq("id", property);
    await client.from("contacts").delete().eq("id", contact);
  }
});
