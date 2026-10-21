import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { createTestClient } from "@tests/integration/client";

// Real-DB proof of 20261021130000: the worker records the POST answer in one
// transaction, and only the unknown -> accepted flip advances the enrollment.
const client = createTestClient();
const org = randomUUID();
const property = randomUUID();
const twoStep = randomUUID();
const oneStep = randomUUID();
const stepIds: Record<string, string> = {};

const ok = <T,>(r: { data: T; error: { message: string } | null }): T => {
  if (r.error) throw new Error(r.error.message);
  return r.data;
};
const rpc = client.rpc.bind(client) as unknown as (
  fn: string,
  args: Record<string, unknown>,
) => Promise<{ data: string | null; error: { message: string } | null }>;

beforeAll(async () => {
  ok(await client.from("organizations").insert({ id: org, name: `Drop record ${org}` }));
  ok(await client.from("sequences").insert([
    { id: twoStep, org_id: org, name: "Two" },
    { id: oneStep, org_id: org, name: "One" },
  ]));
  const steps = ok(await client.from("sequence_steps").insert([
    { sequence_id: twoStep, step_index: 0, action_type: "send_voicemail_drop", vm_tts_body: "Hi", delay_after_previous_minutes: 0 },
    { sequence_id: twoStep, step_index: 1, action_type: "send_sms", template_body: "Hello", delay_after_previous_minutes: 60 },
    { sequence_id: oneStep, step_index: 0, action_type: "send_voicemail_drop", vm_tts_body: "Hi", delay_after_previous_minutes: 0 },
  ]).select("id, sequence_id, step_index"));
  for (const s of steps!) stepIds[`${s.sequence_id}:${s.step_index}`] = s.id;
  ok(await client.from("properties").insert({ id: property, org_id: org, address: "1 Main", state: "MO" }));
});

afterAll(async () => {
  await client.from("voicemail_drops").delete().eq("org_id", org);
  await client.from("sequence_enrollments").delete().eq("org_id", org);
  await client.from("properties").delete().eq("org_id", org);
  await client.from("sequences").delete().eq("org_id", org);
  await client.from("organizations").delete().eq("id", org);
});

async function seed(opts: { sequence?: string; status?: string; pauseReason?: string | null; dropStatus?: string } = {}) {
  const sequence = opts.sequence ?? twoStep;
  await client.from("voicemail_drops").delete().eq("org_id", org);
  await client.from("sequence_enrollments").delete().eq("org_id", org);
  const enrollment = randomUUID();
  ok(await client.from("sequence_enrollments").insert({
    id: enrollment, org_id: org, sequence_id: sequence, property_id: property,
    status: opts.status ?? "active", pause_reason: opts.pauseReason ?? null, current_step_index: 0,
  }));
  const run = ok(await client.from("sequence_step_runs").insert({
    enrollment_id: enrollment, step_id: stepIds[`${sequence}:0`], scheduled_for: new Date().toISOString(),
    claim_active: true, run_at: new Date().toISOString(), attempt_outcome: "unknown",
  }).select("id").single())!.id;
  const drop = ok(await client.from("voicemail_drops").insert({
    org_id: org, enrollment_id: enrollment, step_run_id: run, idempotency_key: run,
    to_phone: "+18165550101", provider: "dropcowboy", audio_kind: "tts", attempt_outcome: "unknown",
    status: opts.dropStatus ?? "queued",
    ...(opts.dropStatus === "delivered" ? { provider_payload: { from: "callback" } } : {}),
  }).select("id").single())!.id;
  return { enrollment, run, drop };
}

async function state(ids: { enrollment: string; run: string; drop: string }) {
  const [r, e, d] = await Promise.all([
    client.from("sequence_step_runs").select("attempt_outcome, claim_active, skipped_reason, failure_reason").eq("id", ids.run).single(),
    client.from("sequence_enrollments").select("status, pause_reason, current_step_index, next_run_at, updated_at").eq("id", ids.enrollment).single(),
    client.from("voicemail_drops").select("status, attempt_outcome, queued_at, provider_payload, reason").eq("id", ids.drop).single(),
  ]);
  return { run: r.data!, enrollment: e.data!, drop: d.data! };
}

describe("record_voicemail_drop_accepted", () => {
  it("owner flips the run, queues the drop and advances active@0 -> active@1; a replay is already_settled", async () => {
    const ids = await seed();
    expect(ok(await rpc("record_voicemail_drop_accepted", { p_run_id: ids.run, p_drop_row_id: ids.drop, p_payload: { status: "queued" } }))).toBe("advanced");
    const after = await state(ids);
    expect(after.run).toMatchObject({ attempt_outcome: "accepted", claim_active: true });
    expect(after.drop).toMatchObject({ status: "queued", attempt_outcome: "queued", provider_payload: { status: "queued" } });
    expect(after.enrollment).toMatchObject({ status: "active", pause_reason: null, current_step_index: 1 });

    expect(ok(await rpc("record_voicemail_drop_accepted", { p_run_id: ids.run, p_drop_row_id: ids.drop, p_payload: { again: true } }))).toBe("already_settled");
    const replay = await state(ids);
    expect(replay.enrollment.current_step_index).toBe(1);
    expect(replay.enrollment.updated_at).toBe(after.enrollment.updated_at);
  });

  it("a drop already delivered keeps its status and payload", async () => {
    const ids = await seed({ dropStatus: "delivered" });
    expect(ok(await rpc("record_voicemail_drop_accepted", { p_run_id: ids.run, p_drop_row_id: ids.drop, p_payload: { status: "queued" } }))).toBe("advanced");
    expect((await state(ids)).drop).toMatchObject({ status: "delivered", attempt_outcome: "queued", provider_payload: { from: "callback" } });
  });

  it("last step completes", async () => {
    const ids = await seed({ sequence: oneStep });
    expect(ok(await rpc("record_voicemail_drop_accepted", { p_run_id: ids.run, p_drop_row_id: ids.drop, p_payload: null }))).toBe("completed");
    expect((await state(ids)).enrollment.status).toBe("completed");
  });

  it("paused for another reason: advances in place and keeps the reason", async () => {
    const ids = await seed({ status: "paused", pauseReason: "inbound_reply" });
    expect(ok(await rpc("record_voicemail_drop_accepted", { p_run_id: ids.run, p_drop_row_id: ids.drop, p_payload: null }))).toBe("advanced_paused");
    expect((await state(ids)).enrollment).toMatchObject({ status: "paused", pause_reason: "inbound_reply", current_step_index: 1 });
  });

  it("opted-out enrollment or released claim: enrollment untouched", async () => {
    const cancelled = await seed({ status: "opted_out" });
    expect(ok(await rpc("record_voicemail_drop_accepted", { p_run_id: cancelled.run, p_drop_row_id: cancelled.drop, p_payload: null }))).toBe("none");
    expect((await state(cancelled)).enrollment).toMatchObject({ status: "opted_out", current_step_index: 0 });

    const released = await seed();
    ok(await client.from("sequence_step_runs").update({ claim_active: false }).eq("id", released.run));
    expect(ok(await rpc("record_voicemail_drop_accepted", { p_run_id: released.run, p_drop_row_id: released.drop, p_payload: null }))).toBe("run_changed");
    expect((await state(released)).enrollment).toMatchObject({ status: "active", current_step_index: 0 });
  });
});

describe("record_voicemail_drop_unknown", () => {
  it("holds: run stays unknown, enrollment active@0 -> paused reconciliation_required", async () => {
    const ids = await seed();
    expect(ok(await rpc("record_voicemail_drop_unknown", { p_run_id: ids.run, p_drop_row_id: ids.drop, p_reason: "timeout", p_payload: null }))).toBe("held");
    const after = await state(ids);
    expect(after.run).toMatchObject({ attempt_outcome: "unknown", claim_active: true, skipped_reason: "provider_failed", failure_reason: "timeout" });
    expect(after.drop).toMatchObject({ status: "queued", attempt_outcome: "unknown", reason: "timeout" });
    expect(after.enrollment).toMatchObject({ status: "paused", pause_reason: "reconciliation_required", current_step_index: 0 });
  });

  it("run already accepted: already_reconciled, nothing written", async () => {
    const ids = await seed();
    ok(await rpc("record_voicemail_drop_accepted", { p_run_id: ids.run, p_drop_row_id: ids.drop, p_payload: null }));
    const before = await state(ids);
    expect(ok(await rpc("record_voicemail_drop_unknown", { p_run_id: ids.run, p_drop_row_id: ids.drop, p_reason: "timeout", p_payload: null }))).toBe("already_reconciled");
    expect(await state(ids)).toEqual(before);
  });

  it("enrollment already paused for another reason keeps that reason", async () => {
    const ids = await seed({ status: "paused", pauseReason: "inbound_call" });
    expect(ok(await rpc("record_voicemail_drop_unknown", { p_run_id: ids.run, p_drop_row_id: ids.drop, p_reason: "timeout", p_payload: null }))).toBe("held");
    expect((await state(ids)).enrollment).toMatchObject({ status: "paused", pause_reason: "inbound_call" });
  });
});
