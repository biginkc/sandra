import { randomUUID } from "node:crypto";

import { Client } from "pg";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

import { createTestClient } from "@tests/integration/client";

vi.mock("@/lib/errors/report", () => ({ reportError: vi.fn(), reportInfo: vi.fn() }));
// Lead-timeline writes are best-effort side effects of the stop paths.
vi.mock("@/lib/events", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/events")>()),
  recordLeadEvent: vi.fn(async () => {}),
  recordLeadEvents: vi.fn(async () => {}),
}));

import { pauseEnrollmentsForInboundCall } from "@/lib/norma/inbound-call-pause";
import { pauseContactEnrollments, pausePropertyEnrollments } from "@/lib/sequences/enrollment";

import { handleDropCallback, handleDropStatusEvent, supabaseDropStatusStore } from "./status-updates";
import { parseDropCowboyCallback, parseDropCowboyStatusWebhook } from "./webhook";

// Acceptance matrix for the consolidated reconcile design
// (record_voicemail_drop_accepted/unknown 20261021130000,
// resolve_voicemail_drop_outcome 20261021140000, stop-path filter).
// Real DB. Where a row specifies concurrency, a third connection holds the
// enrollment row lock, the two contenders queue on it in a forced order
// (row-lock waiters are served FIFO), then the lock is released; both
// orders are run.

const client = createTestClient();
const store = supabaseDropStatusStore(client);
const dbUrl = process.env.TEST_SUPABASE_DB_URL ?? "";
const org = randomUUID();
const property = randomUUID();
const contact = randomUUID();
const twoStep = randomUUID();
const oneStep = randomUUID();
const PHONE = "+18165550101";
const CONSENT = "voicemail_drop_consent_blocked";
const obsSchema = `recon_obs_${org.replace(/-/g, "").slice(0, 12)}`;
const stepIds: Record<string, string> = {};
let admin!: Client;
let eventSeq = 0;

type Ids = { enrollment: string; run: string; drop: string };
let ids!: Ids;

const ok = <T,>(r: { data: T; error: { message: string } | null }): T => {
  if (r.error) throw new Error(r.error.message);
  return r.data;
};

async function connect() {
  const c = new Client({ connectionString: dbUrl });
  await c.connect();
  return c;
}

beforeAll(async () => {
  admin = await connect();
  ok(await client.from("organizations").insert({ id: org, name: `Reconcile matrix ${org}` }));
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
  ok(await client.from("contacts").insert({ id: contact, org_id: org, phone_1: "8165550101", phone_1_type: "mobile" }));
  ok(await client.from("properties").insert({ id: property, org_id: org, address: "1 Main", state: "MO", homeowner_contact_id: contact }));
  // Observer: every committed-or-not row version the enrollment passes through.
  await admin.query(`create schema ${obsSchema}`);
  await admin.query(`create table ${obsSchema}.log (seq bigserial primary key, enrollment_id uuid, status text, pause_reason text, step int)`);
  await admin.query(`create function ${obsSchema}.observe() returns trigger language plpgsql security definer as $f$
    begin
      insert into ${obsSchema}.log (enrollment_id, status, pause_reason, step)
      values (new.id, new.status, new.pause_reason, new.current_step_index);
      return new;
    end $f$`);
  await admin.query(`create trigger ${obsSchema}_observe after update on public.sequence_enrollments
    for each row when (new.org_id = '${org}') execute function ${obsSchema}.observe()`);
});

afterAll(async () => {
  await admin.query(`drop trigger if exists ${obsSchema}_observe on public.sequence_enrollments`);
  await admin.query(`drop trigger if exists ${obsSchema}_fail on public.sequence_enrollments`);
  await admin.query(`drop schema if exists ${obsSchema} cascade`);
  await client.from("norma_inbound_calls").delete().eq("org_id", org);
  await client.from("voicemail_drops").delete().eq("org_id", org);
  await client.from("sequence_enrollments").delete().eq("org_id", org);
  await client.from("properties").delete().eq("org_id", org);
  await client.from("contacts").delete().eq("org_id", org);
  await client.from("sequences").delete().eq("org_id", org);
  await client.from("webhook_events").delete().eq("provider", "dropcowboy").like("external_id", `mx-${org}%`);
  await client.from("organizations").delete().eq("id", org);
  await admin.end();
});

/**
 * held     = POST answered unknown: run unknown, enrollment paused
 *            reconciliation_required @0, drop queued/unknown.
 * inflight = POST not answered yet: run unknown, enrollment active @0.
 * accepted = 202 recorded: run accepted, enrollment active @1, drop queued.
 */
async function seed(kind: "held" | "inflight" | "accepted", opts: { sequence?: string; enrollmentStatus?: string; dropId?: string | null } = {}) {
  const sequence = opts.sequence ?? twoStep;
  await client.from("voicemail_drops").delete().eq("org_id", org);
  await client.from("sequence_enrollments").delete().eq("org_id", org);
  await admin.query(`truncate ${obsSchema}.log`);
  const enrollment = randomUUID();
  ok(await client.from("sequence_enrollments").insert({
    id: enrollment, org_id: org, sequence_id: sequence, property_id: property, contact_id: contact,
    status: opts.enrollmentStatus ?? (kind === "held" ? "paused" : "active"),
    pause_reason: kind === "held" && !opts.enrollmentStatus ? "reconciliation_required" : null,
    current_step_index: kind === "accepted" ? 1 : 0,
  } as never));
  const run = ok(await client.from("sequence_step_runs").insert({
    enrollment_id: enrollment, step_id: stepIds[`${sequence}:0`], scheduled_for: new Date().toISOString(),
    claim_active: true, run_at: new Date().toISOString(), attempt_outcome: kind === "accepted" ? "accepted" : "unknown",
    ...(kind === "held" ? { skipped_reason: "provider_failed", failure_reason: "voicemail drop outcome unknown (timeout)" } : {}),
  }).select("id").single())!.id;
  const drop = ok(await client.from("voicemail_drops").insert({
    org_id: org, enrollment_id: enrollment, step_run_id: run, idempotency_key: run,
    to_phone: PHONE, provider: "dropcowboy", audio_kind: "tts",
    attempt_outcome: kind === "accepted" ? "queued" : "unknown",
    drop_id: opts.dropId ?? null,
    ...(kind === "accepted" ? { queued_at: new Date().toISOString() } : {}),
  }).select("id").single())!.id;
  ids = { enrollment, run, drop };
  return ids;
}

async function state() {
  const [r, e, d] = await Promise.all([
    client.from("sequence_step_runs").select("attempt_outcome, claim_active").eq("id", ids.run).single(),
    client.from("sequence_enrollments").select("status, pause_reason, current_step_index, next_run_at, updated_at").eq("id", ids.enrollment).single(),
    client.from("voicemail_drops").select("status, attempt_outcome, drop_id, proof_url, provider_payload, reason_code").eq("id", ids.drop).single(),
  ]);
  return { run: r.data!, enrollment: e.data!, drop: d.data! };
}

async function observed() {
  const { rows } = await admin.query(`select status, pause_reason, step from ${obsSchema}.log where enrollment_id = $1 order by seq`, [ids.enrollment]);
  return rows as Array<{ status: string; pause_reason: string | null; step: number }>;
}
/** Number of step-pointer moves the enrollment went through (all seeds start at 0). */
async function advances() {
  let last = 0;
  let n = 0;
  for (const row of await observed()) {
    if (row.step !== last) n += 1;
    last = row.step;
  }
  return n;
}

const callback = (body: Record<string, unknown> = {}) =>
  parseDropCowboyCallback(JSON.stringify({ foreign_id: ids.drop, drop_id: `dc-${org}`, status: "success", reason_code: 0, ...body }));
const statusEvent = (data: Record<string, unknown>, eventId = `mx-${org}-${++eventSeq}`) =>
  parseDropCowboyStatusWebhook(JSON.stringify({
    event: "contact.rvm.status", event_id: eventId,
    data: { to: PHONE, campaign_type: "rvm", status: "success", reason_code: 0, ...data },
  }));
const receipt = (data: Record<string, unknown>, eventId = `mx-${org}-${++eventSeq}`) =>
  parseDropCowboyStatusWebhook(JSON.stringify({
    event: "contact.rvm.receipt", event_id: eventId,
    data: { to: PHONE, status: "success", proof_of_delivery_url: "https://proof.invalid/r", ...data },
  }));

async function resolveSql(c: Client, status: "delivered" | "failed", pauseReason: string | null, reasonCode = status === "delivered" ? "0" : "4001") {
  const { rows } = await c.query(
    "select * from public.resolve_voicemail_drop_outcome($1, $2, $3, $4, null, $5, null, null, $6)",
    [ids.drop, status, pauseReason, reasonCode, `dc-${org}`, JSON.stringify({ via: "callback", status })],
  );
  return rows[0] as { drop_result: string; enrollment_action: string };
}
async function recordSql(c: Client, fn: "accepted" | "unknown") {
  const { rows } = fn === "accepted"
    ? await c.query("select public.record_voicemail_drop_accepted($1, $2, $3) as r", [ids.run, ids.drop, JSON.stringify({ via: "202" })])
    : await c.query("select public.record_voicemail_drop_unknown($1, $2, $3, $4) as r", [ids.run, ids.drop, "timeout", null]);
  return rows[0].r as string;
}

async function inboundCall() {
  const call = ok(await client.from("norma_inbound_calls")
    .insert({ org_id: org, provider_call_id: `pc-${randomUUID()}`, from_e164: PHONE, to_e164: "+18165550199" } as never)
    .select("id").single()) as { id: string };
  return pauseEnrollmentsForInboundCall(client, call.id);
}

/**
 * Run `first` then `second` contending on the enrollment row lock in that
 * order: a third connection holds the lock until both are queued on it.
 */
async function ordered<A, B>(first: () => Promise<A>, second: () => Promise<B>): Promise<[A, B]> {
  const lock = await connect();
  try {
    await lock.query("begin");
    await lock.query("select 1 from public.sequence_enrollments where id = $1 for update", [ids.enrollment]);
    const lockPid = (await lock.query("select pg_backend_pid() as pid")).rows[0].pid as number;
    const waiters = async (n: number) => {
      for (let i = 0; i < 200; i += 1) {
        const { rows } = await admin.query(
          "select count(*)::int as n from pg_locks where not granted and pid <> $1 and (locktype in ('transactionid', 'tuple'))",
          [lockPid],
        );
        if (rows[0].n >= n) return;
        await new Promise((r) => setTimeout(r, 25));
      }
      throw new Error(`expected ${n} lock waiters`);
    };
    const a = first();
    await waiters(1);
    const b = second();
    await waiters(2);
    await lock.query("commit");
    return await Promise.all([a, b]);
  } finally {
    await lock.end();
  }
}

beforeEach(() => {
  eventSeq += 100;
});

describe("reconcile acceptance matrix", () => {
  it("1 R1-1: resolve errors mid-way on 4016 -> nothing commits; retry -> drop failed, paused consent", async () => {
    await seed("held");
    await admin.query(`create function ${obsSchema}.fail() returns trigger language plpgsql as $f$
      begin raise exception 'injected failure after the drop write'; end $f$`);
    await admin.query(`create trigger ${obsSchema}_fail before update on public.sequence_enrollments
      for each row when (new.id = '${ids.enrollment}' and new.pause_reason = '${CONSENT}') execute function ${obsSchema}.fail()`);
    try {
      await expect(handleDropCallback(store, callback({ status: "failure", reason_code: 4016 }))).rejects.toThrow("injected failure");
    } finally {
      await admin.query(`drop trigger ${obsSchema}_fail on public.sequence_enrollments`);
      await admin.query(`drop function ${obsSchema}.fail()`);
    }
    const failed = await state();
    expect(failed.run.attempt_outcome).toBe("unknown");
    expect(failed.drop).toMatchObject({ status: "queued", attempt_outcome: "unknown", drop_id: null });
    expect(failed.enrollment).toMatchObject({ status: "paused", pause_reason: "reconciliation_required", current_step_index: 0 });

    expect((await handleDropCallback(store, callback({ status: "failure", reason_code: 4016 }))).status).toBe(200);
    const after = await state();
    expect(after.drop).toMatchObject({ status: "failed", reason_code: "4016" });
    expect(after.enrollment).toMatchObject({ status: "paused", pause_reason: CONSENT, current_step_index: 1 });
  });

  it("2 R1-2: an AI-broadcast status to the same phone is unmatched; the genuine 4016 pauses consent", async () => {
    await seed("accepted");
    expect(await handleDropStatusEvent(store, statusEvent({ campaign_type: "ai_broadcast", drop_id: `bc-${org}` }))).toBe("unmatched");
    expect((await state()).drop).toMatchObject({ status: "queued", drop_id: null });
    expect(await handleDropStatusEvent(store, statusEvent({ drop_id: `dc-${org}`, status: "failure", reason_code: 4016 }))).toBe("applied");
    const after = await state();
    expect(after.drop).toMatchObject({ status: "failed", drop_id: `dc-${org}` });
    expect(after.enrollment).toMatchObject({ status: "paused", pause_reason: CONSENT, current_step_index: 1 });
  });

  it("3 R1-3: inbound call during reconciliation, then delivery callback -> paused inbound_call @1, never active", async () => {
    await seed("held");
    expect((await inboundCall()).paused).toBe(1);
    await handleDropCallback(store, callback());
    expect((await state()).enrollment).toMatchObject({ status: "paused", pause_reason: "inbound_call", current_step_index: 1 });
    expect((await observed()).some((r) => r.status === "active")).toBe(false);
  });

  it("5 R1-5: callback then worker unknown -> active @1; worker returns already_reconciled", async () => {
    await seed("inflight");
    await handleDropCallback(store, callback());
    expect((await state()).enrollment).toMatchObject({ status: "active", current_step_index: 1 });
    expect(await recordSql(admin, "unknown")).toBe("already_reconciled");
    const after = await state();
    expect(after.enrollment).toMatchObject({ status: "active", pause_reason: null, current_step_index: 1 });
    expect(after.run.attempt_outcome).toBe("accepted");
  });

  it("6 R1-6: terminal callback then 202 -> drop stays delivered with the callback payload, advanced once", async () => {
    await seed("inflight");
    await handleDropCallback(store, callback());
    const afterCallback = await state();
    expect(await recordSql(admin, "accepted")).toBe("already_settled");
    const after = await state();
    expect(after.drop.status).toBe("delivered");
    expect(after.drop.provider_payload).toEqual(afterCallback.drop.provider_payload);
    expect((after.drop.provider_payload as { foreign_id?: string }).foreign_id).toBe(ids.drop);
    expect(after.enrollment).toMatchObject({ status: "active", current_step_index: 1, updated_at: afterCallback.enrollment.updated_at });
    expect(await advances()).toBe(1);
  });

  it("7 R2-1: broadcast receipts to the same phone (no stored drop_id) are unmatched; the genuine 4016 pauses consent", async () => {
    await seed("accepted");
    expect(await handleDropStatusEvent(store, receipt({ campaign_type: "voice", drop_id: `bc-${org}` }))).toBe("unmatched");
    expect(await handleDropStatusEvent(store, receipt({ drop_id: `bc2-${org}` }))).toBe("unmatched");
    expect(await handleDropStatusEvent(store, receipt({ campaign_type: "rvm" }))).toBe("unmatched");
    expect((await state()).drop).toMatchObject({ status: "queued", drop_id: null, proof_url: null });
    expect(await handleDropStatusEvent(store, statusEvent({ drop_id: `dc-${org}`, status: "failure", reason_code: 4016 }))).toBe("applied");
    expect((await state()).enrollment).toMatchObject({ status: "paused", pause_reason: CONSENT, current_step_index: 1 });
  });

  it("8 R2-2: SMS reply during reconciliation, then callback -> paused inbound_reply @1", async () => {
    await seed("held");
    expect((await pausePropertyEnrollments(client, { propertyId: property, reason: "inbound_reply" })).paused).toBe(1);
    await handleDropCallback(store, callback());
    expect((await state()).enrollment).toMatchObject({ status: "paused", pause_reason: "inbound_reply", current_step_index: 1 });
    expect((await observed()).some((r) => r.status === "active")).toBe(false);
  });

  it.each(["resolve_first", "call_first"] as const)("9 R2-3: resolve vs inbound call on two connections (%s) -> paused inbound_call", async (order) => {
    await seed("held");
    const resolver = await connect();
    try {
      const resolve = () => resolveSql(resolver, "delivered", null);
      const call = () => inboundCall();
      const [r] = order === "resolve_first"
        ? await ordered(resolve, call)
        : (await ordered(call, resolve)).reverse() as [{ enrollment_action: string }, unknown];
      expect(r.enrollment_action).toBe(order === "resolve_first" ? "advanced" : "advanced_paused");
    } finally {
      await resolver.end();
    }
    expect((await state()).enrollment).toMatchObject({ status: "paused", pause_reason: "inbound_call", current_step_index: 1 });
  });

  it("10 R2-4: consent outcome on a held drop -> the observer never sees active; paused consent @1", async () => {
    await seed("held");
    await handleDropCallback(store, callback({ status: "failure", reason_code: 4016 }));
    const rows = await observed();
    expect(rows.length).toBeGreaterThan(0);
    expect(rows.some((r) => r.status === "active")).toBe(false);
    expect((await state()).enrollment).toMatchObject({ status: "paused", pause_reason: CONSENT, current_step_index: 1 });
  });

  describe("11 R2-5: worker unknown vs callback, every interleaving + 3 replays", () => {
    const replaysAndCheck = async () => {
      for (let i = 0; i < 3; i += 1) await handleDropCallback(store, callback());
      const evt = statusEvent({ drop_id: `dc-${org}` });
      await handleDropStatusEvent(store, evt);
      expect(await handleDropStatusEvent(store, evt)).toBe("duplicate");
      const after = await state();
      expect(after.enrollment).toMatchObject({ status: "active", pause_reason: null, current_step_index: 1 });
      expect(after.run.attempt_outcome).toBe("accepted");
      expect(await advances()).toBe(1);
      // Never stranded: the only reconciliation_required version is the
      // worker's hold before the callback, never after an advance.
      const rows = await observed();
      const firstAdvance = rows.findIndex((r) => r.step === 1);
      expect(rows.slice(firstAdvance).some((r) => r.pause_reason === "reconciliation_required")).toBe(false);
    };

    it("unknown, then callback (sequential)", async () => {
      await seed("inflight");
      expect(await recordSql(admin, "unknown")).toBe("held");
      await handleDropCallback(store, callback());
      await replaysAndCheck();
    });

    it("callback, then unknown (sequential)", async () => {
      await seed("inflight");
      await handleDropCallback(store, callback());
      expect(await recordSql(admin, "unknown")).toBe("already_reconciled");
      await replaysAndCheck();
    });

    it.each(["unknown_first", "callback_first"] as const)("concurrent on two connections, %s", async (order) => {
      await seed("inflight");
      const worker = await connect();
      const webhook = await connect();
      try {
        const unknown = () => recordSql(worker, "unknown");
        const resolve = () => resolveSql(webhook, "delivered", null);
        if (order === "unknown_first") {
          const [u, r] = await ordered(unknown, resolve);
          expect(u).toBe("held");
          expect(r.enrollment_action).toBe("advanced");
        } else {
          const [r, u] = await ordered(resolve, unknown);
          expect(r.enrollment_action).toBe("advanced");
          expect(u).toBe("already_reconciled");
        }
      } finally {
        await worker.end();
        await webhook.end();
      }
      await replaysAndCheck();
    });

    it("unordered races x5", async () => {
      for (let i = 0; i < 5; i += 1) {
        await seed("inflight");
        const worker = await connect();
        const webhook = await connect();
        try {
          await Promise.all([recordSql(worker, "unknown"), resolveSql(webhook, "delivered", null)]);
        } finally {
          await worker.end();
          await webhook.end();
        }
        await replaysAndCheck();
      }
    });
  });

  it.each(["202_first", "callback_first"] as const)("12: 202 vs callback concurrent (%s) -> advanced once, never re-paused", async (order) => {
    await seed("inflight");
    const worker = await connect();
    const webhook = await connect();
    try {
      const accepted = () => recordSql(worker, "accepted");
      const resolve = () => resolveSql(webhook, "delivered", null);
      if (order === "202_first") {
        const [a, r] = await ordered(accepted, resolve);
        expect(a).toBe("advanced");
        expect(r.enrollment_action).toBe("none");
      } else {
        const [r, a] = await ordered(resolve, accepted);
        expect(r.enrollment_action).toBe("advanced");
        expect(a).toBe("already_settled");
      }
    } finally {
      await worker.end();
      await webhook.end();
    }
    const after = await state();
    expect(after.enrollment).toMatchObject({ status: "active", pause_reason: null, current_step_index: 1 });
    expect(after.drop.status).toBe("delivered");
    expect(await advances()).toBe(1);
    expect((await observed()).some((r) => r.status === "paused")).toBe(false);
  });

  it.each(["a_first", "b_first"] as const)("13: two status events for the same held drop concurrently (%s) -> one owner, one advance", async (order) => {
    await seed("held");
    const a = await connect();
    const b = await connect();
    try {
      const first = () => resolveSql(order === "a_first" ? a : b, "delivered", null);
      const second = () => resolveSql(order === "a_first" ? b : a, "delivered", null);
      const [r1, r2] = await ordered(first, second);
      expect(r1).toEqual({ drop_result: "applied", enrollment_action: "advanced" });
      expect(r2).toEqual({ drop_result: "replay", enrollment_action: "none" });
    } finally {
      await a.end();
      await b.end();
    }
    expect((await state()).enrollment).toMatchObject({ status: "active", current_step_index: 1 });
    expect(await advances()).toBe(1);
  });

  it("14: callback replays and duplicate event ids -> no second advance; the duplicate is skipped", async () => {
    await seed("held");
    for (let i = 0; i < 3; i += 1) await handleDropCallback(store, callback());
    const evt = statusEvent({ drop_id: `dc-${org}` });
    expect(await handleDropStatusEvent(store, evt)).toBe("applied");
    expect(await handleDropStatusEvent(store, evt)).toBe("duplicate");
    expect((await state()).enrollment).toMatchObject({ status: "active", current_step_index: 1 });
    expect(await advances()).toBe(1);
  });

  it.each([4001, 4013])("16: %s failure on a held drop advances active", async (code) => {
    await seed("held");
    await handleDropCallback(store, callback({ status: "failure", reason_code: code }));
    const after = await state();
    expect(after.drop).toMatchObject({ status: "failed", reason_code: String(code) });
    expect(after.enrollment).toMatchObject({ status: "active", pause_reason: null, current_step_index: 1 });
  });

  it("17: 3007 -> paused step_misconfigured, never active", async () => {
    await seed("held");
    await handleDropCallback(store, callback({ status: "failure", reason_code: 3007 }));
    expect((await state()).enrollment).toMatchObject({ status: "paused", pause_reason: "step_misconfigured", current_step_index: 1 });
    expect((await observed()).some((r) => r.status === "active")).toBe(false);
  });

  it("18: held last step success -> completed; reply first, then success -> completed", async () => {
    await seed("held", { sequence: oneStep });
    await handleDropCallback(store, callback());
    expect((await state()).enrollment.status).toBe("completed");

    await seed("held", { sequence: oneStep });
    await pausePropertyEnrollments(client, { propertyId: property, reason: "inbound_reply" });
    expect((await state()).enrollment).toMatchObject({ status: "paused", pause_reason: "inbound_reply" });
    await handleDropCallback(store, callback());
    expect((await state()).enrollment.status).toBe("completed");
  });

  it("19: STOP during reconciliation, then callback -> stays opted_out", async () => {
    await seed("held");
    await pauseContactEnrollments(client, { contactId: contact, reason: "consent_revoked", permanent: true });
    await handleDropCallback(store, callback());
    const after = await state();
    expect(after.enrollment).toMatchObject({ status: "opted_out", current_step_index: 0 });
    expect(after.drop.status).toBe("delivered");
  });

  it("20: cancelled enrollment / released claim, then callback -> drop recorded, enrollment untouched", async () => {
    await seed("held", { enrollmentStatus: "completed" });
    await handleDropCallback(store, callback());
    let after = await state();
    expect(after.drop.status).toBe("delivered");
    expect(after.enrollment).toMatchObject({ status: "completed", current_step_index: 0 });

    await seed("held");
    ok(await client.from("sequence_step_runs").update({ claim_active: false }).eq("id", ids.run));
    await handleDropCallback(store, callback());
    after = await state();
    expect(after.drop.status).toBe("delivered");
    expect(after.enrollment).toMatchObject({ status: "paused", pause_reason: "reconciliation_required", current_step_index: 0 });
    expect(after.run.attempt_outcome).toBe("unknown");
  });

  it.each(["call_in_progress", "norma_call"] as const)("21: a %s pause does not take over reconciliation_required", async (reason) => {
    await seed("held");
    expect((await pausePropertyEnrollments(client, { propertyId: property, reason })).paused).toBe(0);
    expect((await state()).enrollment).toMatchObject({ status: "paused", pause_reason: "reconciliation_required" });
    await handleDropCallback(store, callback());
    expect((await state()).enrollment).toMatchObject({ status: "active", current_step_index: 1 });
  });

  it("24: consent after the 202 (active @1) -> paused consent; replay is idempotent", async () => {
    await seed("accepted", { dropId: `dc-${org}` });
    await handleDropCallback(store, callback({ status: "failure", reason_code: 4016 }));
    const once = await state();
    expect(once.enrollment).toMatchObject({ status: "paused", pause_reason: CONSENT, current_step_index: 1 });
    await handleDropCallback(store, callback({ status: "failure", reason_code: 4016 }));
    expect(await handleDropStatusEvent(store, statusEvent({ drop_id: `dc-${org}`, status: "failure", reason_code: 4016 }))).toBe("applied");
    expect(await state()).toEqual(once);
  });
});
