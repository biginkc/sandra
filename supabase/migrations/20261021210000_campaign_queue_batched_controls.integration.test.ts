import { randomUUID } from "node:crypto";
import { Client } from "pg";
import { afterAll, beforeAll, beforeEach, expect, it } from "vitest";
import { requireLoopbackPostgresUrl } from "@/lib/testing/loopback-postgres-url";

// Needs a local stack with all migrations applied (this one included).
// 3,000 messages, each with its own contact + property, so every message
// trigger runs as it does in production.
const url = requireLoopbackPostgresUrl(
  process.env.TEST_SUPABASE_DB_URL ?? "postgresql://postgres:postgres@127.0.0.1:54329/postgres");
const a = new Client({ connectionString: url });
const b = new Client({ connectionString: url });
const org = randomUUID();
const campaign = randomUUID();
const ROWS = 3000;
const LIMIT = 500;
const PACE = 4;
const batchMs: number[] = [];

async function asService(client: Client) {
  await client.query(`select set_config('request.jwt.claims', '{"role":"service_role"}', false)`);
}

async function seed(status: "queued" | "paused") {
  await a.query("delete from public.messages where org_id=$1", [org]);
  await a.query("delete from public.campaign_queue_ops where campaign_id=$1", [campaign]);
  await a.query("update public.campaigns set status=$2, pace_seconds=null where id=$1",
    [campaign, status === "paused" ? "paused" : "active"]);
  // Deterministic but shuffled times; every 7th has no time (nulls ordering).
  await a.query(
    `insert into public.messages
       (org_id, campaign_id, contact_id, property_id, channel, direction, status, body,
        from_address, to_address, created_at, scheduled_for, metadata)
     select $1, $2, c.id, p.id, 'sms', 'outbound', $3, 'Hi ' || g.i,
            '+18165550100', '+1816555' || lpad(g.i::text, 4, '0'),
            timestamptz '2026-10-01' + make_interval(secs => (g.i * 37) % 1000),
            case when $3 = 'queued' and g.i % 7 <> 0
              then now() + make_interval(secs => 60 + (g.i * 7919) % 50000) end,
            case when $3 = 'paused' then jsonb_build_object('campaignPause', jsonb_build_object(
              'reason', 'operator_pause',
              'previousScheduledFor', case when g.i % 7 <> 0
                then (now() + make_interval(secs => 60 + (g.i * 7919) % 50000))::text end))
            else '{}'::jsonb end
     from generate_series(1, $4) g(i)
     join public.contacts c on c.org_id = $1 and c.last_name = g.i::text
     join public.properties p on p.org_id = $1 and p.homeowner_contact_id = c.id`,
    [org, campaign, status, ROWS]);
}

async function rows() {
  return (await a.query(
    `select id, status, scheduled_for, created_at, metadata
       from public.messages where org_id=$1`, [org])).rows as Array<{
    id: string; status: string; scheduled_for: Date | null; created_at: Date;
    metadata: Record<string, unknown>;
  }>;
}

const ts = (v: unknown) => (v == null || v === "" ? null : Date.parse(String(v)));
function cmp(x: number | null, y: number | null, nullsLast: boolean) {
  if (x === y) return 0;
  if (x === null) return nullsLast ? 1 : -1;
  if (y === null) return nullsLast ? -1 : 1;
  return x - y;
}
function tie(p: { created_at: Date; id: string }, q: { created_at: Date; id: string }) {
  return p.created_at.getTime() - q.created_at.getTime() || (p.id < q.id ? -1 : p.id > q.id ? 1 : 0);
}

// Each loop is one operation: one op id reused across its batches.
async function loop(client: Client, sql: string, params: unknown[], op: string | null = randomUUID()) {
  const results: Array<Record<string, string>> = [];
  for (let i = 0; i < 100; i += 1) {
    const t0 = performance.now();
    const r = (await client.query(sql, op === null ? params : [...params, op])).rows[0];
    batchMs.push(performance.now() - t0);
    results.push(r);
    if (Number(r.remaining_count) === 0) return results;
  }
  throw new Error("did not converge");
}
const once = (client: Client, sql: string, params: unknown[], op: string) =>
  client.query(sql, [...params, op]).then((r) => r.rows[0] as Record<string, string>);
const status = async () =>
  (await a.query("select status from public.campaigns where id=$1", [campaign])).rows[0].status as string;
const ageOp = () => a.query(
  "update public.campaign_queue_ops set touched_at = now() - interval '3 minutes' where campaign_id=$1 and state='active'", [campaign]);
const pauseLoop = (client: Client) => loop(client, PAUSE, [campaign, LIMIT], null);
const pauseOnce = (client: Client) => client.query(PAUSE, [campaign, LIMIT]).then((r) => r.rows[0]);

const RESUME = `select * from public.resume_campaign_queue($1, $2, 300, true, $3, $4)`;
const PAUSE = `select * from public.pause_campaign_queue($1, true, $2)`;
const CADENCE = `select * from public.apply_campaign_cadence_reschedule($1, $2, 300, true, $3, $4)`;

function expectContinuousCadence(ordered: Array<{ scheduled_for: Date | null }>, pace: number) {
  const first = ordered[0].scheduled_for!.getTime();
  ordered.forEach((row, i) => {
    expect(row.scheduled_for!.getTime() - first).toBe(i * pace * 1000);
  });
}
function pausedReference(before: Awaited<ReturnType<typeof rows>>) {
  return [...before].sort((p, q) =>
    cmp(ts((p.metadata.campaignPause as Record<string, unknown>).previousScheduledFor),
      ts((q.metadata.campaignPause as Record<string, unknown>).previousScheduledFor), true) || tie(p, q));
}
function queuedReference(before: Awaited<ReturnType<typeof rows>>) {
  return [...before].sort((p, q) =>
    cmp(p.scheduled_for?.getTime() ?? null, q.scheduled_for?.getTime() ?? null, false) || tie(p, q));
}
async function inOrder(reference: Array<{ id: string }>) {
  const after = new Map((await rows()).map((r) => [r.id, r]));
  return reference.map((r) => after.get(r.id)!);
}
const sortedByTime = async () =>
  (await rows()).sort((p, q) => p.scheduled_for!.getTime() - q.scheduled_for!.getTime());

beforeAll(async () => {
  await a.connect(); await b.connect();
  await asService(a); await asService(b);
  await a.query("insert into public.organizations(id,name) values ($1,$2)", [org, `Batched queue ${org}`]);
  await a.query("insert into public.campaigns(id,org_id,name,status) values ($1,$2,'Batched','paused')", [campaign, org]);
  await a.query(
    `insert into public.contacts(org_id, first_name, last_name)
     select $1, 'Batch', g.i::text from generate_series(1, $2) g(i)`, [org, ROWS]);
  await a.query(
    `insert into public.properties(org_id, address, state, status, homeowner_contact_id)
     select $1, c.last_name || ' Batch Lane', 'MO', 'new_lead', c.id
       from public.contacts c where c.org_id = $1`, [org]);
}, 120_000);

afterAll(async () => {
  for (const t of ["messages", "properties", "contacts", "campaigns"]) {
    await a.query(`delete from public.${t} where org_id=$1`, [org]);
  }
  await a.query("delete from public.organizations where id=$1", [org]);
  // eslint-disable-next-line no-console
  console.log(`batch timings (ms, limit ${LIMIT}): max ${Math.max(...batchMs).toFixed(0)}, ` +
    `mean ${(batchMs.reduce((s, x) => s + x, 0) / batchMs.length).toFixed(0)}, n ${batchMs.length}`);
  await a.end(); await b.end();
}, 120_000);

it("resumes 3,000 paused rows in batches with the single-shot order and 4s spacing", async () => {
  await seed("paused");
  const reference = pausedReference(await rows());
  const op = randomUUID();
  const statuses: string[] = [];
  const affected: number[] = [];
  for (let i = 0; i < 100; i += 1) {
    const t0 = performance.now();
    const r = await once(a, RESUME, [campaign, PACE, LIMIT], op);
    batchMs.push(performance.now() - t0);
    affected.push(Number(r.affected_count));
    statuses.push(await status());
    if (Number(r.remaining_count) === 0) break;
  }
  expect(affected).toEqual([500, 500, 500, 500, 500, 500]);
  expect(statuses).toEqual(["paused", "paused", "paused", "paused", "paused", "completed"]);
  const ordered = await inOrder(reference);
  expect(ordered.every((r) => r.status === "queued" && !("campaignPause" in r.metadata))).toBe(true);
  expectContinuousCadence(ordered, PACE);
  expect((await a.query("select pace_seconds from public.campaigns where id=$1", [campaign])).rows[0].pace_seconds).toBe(PACE);
  expect((await a.query("select state from public.campaign_queue_ops where campaign_id=$1", [campaign])).rows)
    .toEqual([{ state: "done" }]);
  expect((await a.query("select count(*)::int n from public.campaign_queue_plan p join public.campaign_queue_ops o on o.id=p.op_id where o.campaign_id=$1", [campaign])).rows[0].n).toBe(0);
}, 120_000);

it("a second concurrent resume is refused; the first finishes one cadence, nothing double-scheduled", async () => {
  await seed("paused");
  const reference = pausedReference(await rows());
  const results = await Promise.allSettled([loop(a, RESUME, [campaign, PACE, LIMIT]), loop(b, RESUME, [campaign, PACE, LIMIT])]);
  const rejected = results.filter((r) => r.status === "rejected") as PromiseRejectedResult[];
  expect(rejected).toHaveLength(1);
  expect(String(rejected[0].reason)).toMatch(/in progress|not paused/);
  expectContinuousCadence(await inOrder(reference), PACE);
  expect(await status()).toBe("completed");
}, 120_000);

it("pauses 3,000 queued rows in batches; holds the campaign from the first batch", async () => {
  await seed("queued");
  const before = new Map((await rows()).map((r) => [r.id, r.scheduled_for]));
  const statuses: string[] = [];
  for (let i = 0; i < 100; i += 1) {
    const t0 = performance.now();
    const r = await pauseOnce(a);
    batchMs.push(performance.now() - t0);
    statuses.push(await status());
    if (Number(r.remaining_count) === 0) break;
  }
  expect(statuses).toEqual(["paused", "paused", "paused", "paused", "paused", "paused"]);
  for (const r of await rows()) {
    expect(r.status).toBe("paused");
    expect(r.scheduled_for).toBeNull();
    const prev = (r.metadata.campaignPause as Record<string, unknown>).previousScheduledFor;
    expect(ts(prev)).toBe(before.get(r.id)?.getTime() ?? null);
  }
}, 120_000);

it("two concurrent pausers converge without losing previousScheduledFor", async () => {
  await seed("queued");
  const before = new Map((await rows()).map((r) => [r.id, r.scheduled_for]));
  await Promise.all([pauseLoop(a), pauseLoop(b)]);
  for (const r of await rows()) {
    expect(r.status).toBe("paused");
    const prev = (r.metadata.campaignPause as Record<string, unknown>).previousScheduledFor;
    expect(ts(prev)).toBe(before.get(r.id)?.getTime() ?? null);
  }
  expect(await status()).toBe("paused");
}, 120_000);

it("reschedules 3,000 queued rows in batches with the single-shot order and spacing", async () => {
  await seed("queued");
  const reference = queuedReference(await rows());
  const op = randomUUID();
  const statuses: string[] = [];
  for (let i = 0; i < 100; i += 1) {
    const r = await once(a, CADENCE, [campaign, 6, LIMIT], op);
    statuses.push(await status());
    if (Number(r.remaining_count) === 0) break;
  }
  // 6 hold batches + 6 release batches; held (paused) until the last one.
  expect(statuses).toHaveLength(12);
  expect(statuses.slice(0, 11).every((x) => x === "paused")).toBe(true);
  expect(statuses[11]).toBe("active");
  const ordered = await inOrder(reference);
  expect(ordered.every((r) => r.status === "queued" && !("campaignPause" in r.metadata))).toBe(true);
  expectContinuousCadence(ordered, 6);
  expect((await a.query("select pace_seconds from public.campaigns where id=$1", [campaign])).rows[0].pace_seconds).toBe(6);
}, 120_000);

it("a second concurrent cadence change is refused; no row is rewritten twice", async () => {
  await seed("queued");
  const reference = queuedReference(await rows());
  const results = await Promise.allSettled([loop(a, CADENCE, [campaign, 6, LIMIT]), loop(b, CADENCE, [campaign, 6, LIMIT])]);
  const rejected = results.filter((r) => r.status === "rejected") as PromiseRejectedResult[];
  expect(rejected).toHaveLength(1);
  expect(String(rejected[0].reason)).toMatch(/in progress/);
  const fulfilled = results.find((r) => r.status === "fulfilled") as PromiseFulfilledResult<unknown[]>;
  expect(fulfilled.value).toHaveLength(12);
  expectContinuousCadence(await inOrder(reference), 6);
}, 120_000);

it("an abandoned cadence pass (300 rows released) is taken over at a new pace in the original order", async () => {
  await seed("queued");
  const reference = queuedReference(await rows());
  const dead = randomUUID();
  for (let i = 0; i < 33; i += 1) await once(a, CADENCE, [campaign, 6, 100], dead); // all held + 300 released
  expect(await status()).toBe("paused"); // abandoned pass keeps the campaign held
  await expect(loop(a, CADENCE, [campaign, 8, 100])).rejects.toThrow(/in progress/);
  await ageOp();
  await loop(a, CADENCE, [campaign, 8, 100]);
  expectContinuousCadence(await inOrder(reference), 8);
  expect(await status()).toBe("active");
}, 120_000);

it("an interrupted resume is finished by a retry at the same pace; a different pace is refused", async () => {
  await seed("paused");
  const reference = pausedReference(await rows());
  const dead = randomUUID();
  await once(a, RESUME, [campaign, PACE, LIMIT], dead);
  await once(a, RESUME, [campaign, PACE, LIMIT], dead);
  await ageOp();
  await expect(loop(b, RESUME, [campaign, 6, LIMIT])).rejects.toThrow(/interrupted resume used 4/);
  await ageOp();
  await loop(b, RESUME, [campaign, PACE, LIMIT]);
  expectContinuousCadence(await inOrder(reference), PACE);
  expect(await status()).toBe("completed");
}, 120_000);

it("pause preempts an in-flight resume, and that resume can never continue", async () => {
  await seed("paused");
  const resumeOp = randomUUID();
  await once(a, RESUME, [campaign, PACE, LIMIT], resumeOp);
  await pauseLoop(b);
  expect((await rows()).every((r) => r.status === "paused")).toBe(true);
  await expect(once(a, RESUME, [campaign, PACE, LIMIT], resumeOp)).rejects.toThrow(/is cancelled/);
  await loop(a, RESUME, [campaign, PACE, LIMIT]);
  expect(await status()).toBe("completed");
}, 120_000);

it("resume refuses after an interrupted pause, even after an earlier completed resume", async () => {
  await seed("paused");
  await loop(a, RESUME, [campaign, PACE, LIMIT]); // older resume generation tags every row
  await pauseOnce(a); // pause dies after one batch
  expect(await status()).toBe("paused");
  await expect(loop(a, RESUME, [campaign, PACE, LIMIT])).rejects.toThrow(/pause has not finished/);
  await pauseLoop(a);
  await loop(a, RESUME, [campaign, PACE, LIMIT]);
  expect((await rows()).every((r) => r.status === "queued")).toBe(true);
  expectContinuousCadence(await sortedByTime(), PACE);
}, 120_000);

it("old callers (no p_limit, no p_op_id) keep the unbounded single-shot behaviour", async () => {
  await seed("queued");
  const r = (await a.query("select * from public.pause_campaign_queue($1, true)", [campaign])).rows[0];
  expect(Number(r.affected_count)).toBe(ROWS);
  expect(Number(r.remaining_count)).toBe(0);
}, 120_000);

it("rejects out-of-range limits; queue RPCs are service_role only and helpers are not callable", async () => {
  await expect(a.query(RESUME, [campaign, PACE, 0, randomUUID()])).rejects.toThrow(/limit must be between/);
  await expect(a.query(PAUSE, [campaign, 5001])).rejects.toThrow(/limit must be between/);
  const grants = await a.query(`select routine_name, grantee from information_schema.routine_privileges
    where routine_name in ('resume_campaign_queue','pause_campaign_queue','apply_campaign_cadence_reschedule',
      'campaign_queue_claim_op','campaign_queue_finish_op')
      and privilege_type='EXECUTE' and grantee <> 'postgres'`);
  const by = (n: string) => grants.rows.filter((r) => r.routine_name === n).map((r) => r.grantee).sort();
  for (const n of ["resume_campaign_queue", "pause_campaign_queue", "apply_campaign_cadence_reschedule"]) {
    expect(by(n)).toEqual(["service_role"]);
  }
  expect(by("campaign_queue_claim_op")).toEqual([]);
  expect(by("campaign_queue_finish_op")).toEqual([]);
});

it("a superseded resume can never continue after a takeover", async () => {
  await seed("paused");
  const reference = pausedReference(await rows());
  const first = randomUUID();
  await once(a, RESUME, [campaign, PACE, LIMIT], first);
  await ageOp();
  const second = randomUUID();
  await once(b, RESUME, [campaign, PACE, LIMIT], second);
  await expect(once(a, RESUME, [campaign, PACE, LIMIT], first)).rejects.toThrow(/superseded/);
  await loop(b, RESUME, [campaign, PACE, LIMIT], second);
  expectContinuousCadence(await inOrder(reference), PACE);
}, 120_000);

it("rows the sender re-pauses mid-resume get their planned slot back, order intact", async () => {
  await seed("paused");
  const reference = pausedReference(await rows());
  const op = randomUUID();
  await once(a, RESUME, [campaign, PACE, LIMIT], op);
  await once(a, RESUME, [campaign, PACE, LIMIT], op);
  // What send.ts does to a due queued row of a paused campaign.
  await a.query(
    `update public.messages m
        set status = 'paused', scheduled_for = null,
            metadata = m.metadata || jsonb_build_object('campaignPause', jsonb_build_object(
              'reason', 'operator_pause', 'previousScheduledFor', m.scheduled_for))
      where m.id in (select id from public.messages where org_id = $1 and status = 'queued'
                     order by scheduled_for limit 50)`, [org]);
  await loop(a, RESUME, [campaign, PACE, LIMIT], op);
  const ordered = await inOrder(reference);
  expect(ordered.every((r) => r.status === "queued")).toBe(true);
  expectContinuousCadence(ordered, PACE);
  expect(await status()).toBe("completed");
}, 120_000);

it("a second cadence pass after a completed one follows the current schedule order", async () => {
  await seed("queued");
  await loop(a, CADENCE, [campaign, 6, LIMIT]);
  // New / moved rows between passes (e.g. a bulk-sms chunk).
  await a.query(
    `update public.messages set scheduled_for = now() + make_interval(secs => (abs(hashtext(id::text)) % 20000))
      where id in (select id from public.messages where org_id = $1 order by id limit 300)`, [org]);
  const reference = queuedReference(await rows());
  await loop(a, CADENCE, [campaign, 8, LIMIT]);
  expectContinuousCadence(await inOrder(reference), 8);
}, 120_000);

it("a resume retried long after a crash is re-timed from now, never in the past", async () => {
  await seed("paused");
  const reference = pausedReference(await rows());
  const dead = randomUUID();
  await once(a, RESUME, [campaign, PACE, LIMIT], dead);
  // Hours later: the old plan and the rows it queued are in the past.
  await a.query("update public.campaign_queue_plan set scheduled_for = scheduled_for - interval '6 hours' where op_id=$1", [dead]);
  await a.query("update public.messages set scheduled_for = scheduled_for - interval '6 hours' where org_id=$1 and status='queued'", [org]);
  await ageOp();
  const before = Date.now();
  await loop(b, RESUME, [campaign, PACE, LIMIT]);
  const ordered = await inOrder(reference);
  expect(ordered.every((r) => r.status === "queued" && r.scheduled_for!.getTime() >= before)).toBe(true);
  expectContinuousCadence(ordered, PACE);
}, 120_000);

it("rows enqueued 'paused' while a cadence pass holds the campaign are released at the end of the cadence", async () => {
  await seed("queued");
  // Leave 50 contacts' messages out to "enqueue" mid-pass.
  const late = (await a.query(
    "delete from public.messages where id in (select id from public.messages where org_id=$1 order by id limit 50) returning contact_id, property_id",
    [org])).rows as Array<{ contact_id: string; property_id: string }>;
  const op = randomUUID();
  await once(a, CADENCE, [campaign, 6, LIMIT], op); // campaign now held
  expect(await status()).toBe("paused");
  // What send.ts queueForLater inserts while the campaign is paused.
  for (const r of late) {
    await a.query(
      `insert into public.messages (org_id, campaign_id, contact_id, property_id, channel, direction, status, body, scheduled_for, metadata)
       values ($1, $2, $3, $4, 'sms', 'outbound', 'paused', 'late', null,
               jsonb_build_object('sendOrigin', 'bulk', 'campaignPause', jsonb_build_object(
                 'pausedAt', now(), 'previousScheduledFor', now() + interval '1 hour', 'reason', 'operator_pause')))`,
      [org, campaign, r.contact_id, r.property_id]);
  }
  await loop(a, CADENCE, [campaign, 6, LIMIT], op);
  const after = await sortedByTime();
  expect(after).toHaveLength(ROWS);
  expect(after.every((r) => r.status === "queued" && r.scheduled_for !== null)).toBe(true);
  expectContinuousCadence(after, 6);
  expect(after.slice(-50).every((r) => r.created_at.getTime() > Date.parse("2026-10-02"))).toBe(true);
  expect(await status()).toBe("active");
}, 120_000);

it("old cadence callers (no p_limit, no p_op_id) still complete in one call", async () => {
  await seed("queued");
  const reference = queuedReference(await rows());
  const r = (await a.query(
    "select * from public.apply_campaign_cadence_reschedule($1, 5, 300, true)", [campaign])).rows[0];
  expect(Number(r.remaining_count)).toBe(0);
  expect(Number(r.affected_count)).toBe(ROWS);
  expectContinuousCadence(await inOrder(reference), 5);
  expect(await status()).toBe("active");
}, 120_000);

it("rows enqueued 'paused' between resume batches are resumed at the end of the cadence", async () => {
  await seed("paused");
  const late = (await a.query(
    "delete from public.messages where id in (select id from public.messages where org_id=$1 order by id limit 50) returning contact_id, property_id",
    [org])).rows as Array<{ contact_id: string; property_id: string }>;
  const op = randomUUID();
  await once(a, RESUME, [campaign, PACE, LIMIT], op);
  for (const r of late) {
    await a.query(
      `insert into public.messages (org_id, campaign_id, contact_id, property_id, channel, direction, status, body, scheduled_for, metadata)
       values ($1, $2, $3, $4, 'sms', 'outbound', 'paused', 'late', null,
               jsonb_build_object('campaignPause', jsonb_build_object(
                 'pausedAt', now(), 'previousScheduledFor', now() + interval '1 hour', 'reason', 'operator_pause')))`,
      [org, campaign, r.contact_id, r.property_id]);
  }
  await loop(a, RESUME, [campaign, PACE, LIMIT], op);
  const after = await sortedByTime();
  expect(after).toHaveLength(ROWS);
  expect(after.every((r) => r.status === "queued")).toBe(true);
  expectContinuousCadence(after, PACE);
  expect(after.slice(-50).every((r) => r.created_at.getTime() > Date.parse("2026-10-02"))).toBe(true);
  expect(await status()).toBe("completed");
}, 120_000);
