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

async function loop(client: Client, sql: string, params: unknown[]) {
  const results: Array<Record<string, string>> = [];
  for (let i = 0; i < 100; i += 1) {
    const t0 = performance.now();
    const r = (await client.query(sql, params)).rows[0];
    batchMs.push(performance.now() - t0);
    results.push(r);
    if (Number(r.remaining_count) === 0) return results;
  }
  throw new Error("did not converge");
}

const RESUME = `select * from public.resume_campaign_queue($1, $2, 300, true, $3)`;
const PAUSE = `select * from public.pause_campaign_queue($1, true, $2)`;
const CADENCE = `select * from public.apply_campaign_cadence_reschedule($1, $2, 300, true, $3, $4)`;

function expectContinuousCadence(
  ordered: Array<{ scheduled_for: Date | null }>, pace: number,
) {
  const first = ordered[0].scheduled_for!.getTime();
  ordered.forEach((row, i) => {
    expect(row.scheduled_for!.getTime() - first).toBe(i * pace * 1000);
  });
}

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

beforeEach(() => undefined);

it("resumes 3,000 paused rows in batches with the single-shot order and 4s spacing", async () => {
  await seed("paused");
  const before = await rows();
  const reference = [...before].sort((p, q) =>
    cmp(ts((p.metadata.campaignPause as Record<string, unknown>).previousScheduledFor),
      ts((q.metadata.campaignPause as Record<string, unknown>).previousScheduledFor), true) || tie(p, q));

  const statuses: string[] = [];
  const results: Array<Record<string, string>> = [];
  for (let i = 0; i < 100; i += 1) {
    const t0 = performance.now();
    const r = (await a.query(RESUME, [campaign, PACE, LIMIT])).rows[0];
    batchMs.push(performance.now() - t0);
    results.push(r);
    statuses.push((await a.query("select status from public.campaigns where id=$1", [campaign])).rows[0].status);
    if (Number(r.remaining_count) === 0) break;
  }

  expect(results.map((r) => Number(r.affected_count))).toEqual([500, 500, 500, 500, 500, 500]);
  expect(statuses).toEqual(["paused", "paused", "paused", "paused", "paused", "completed"]);
  const after = new Map((await rows()).map((r) => [r.id, r]));
  const ordered = reference.map((r) => after.get(r.id)!);
  expect(ordered.every((r) => r.status === "queued" && !("campaignPause" in r.metadata))).toBe(true);
  expectContinuousCadence(ordered, PACE);
  expect(Number((await a.query("select pace_seconds from public.campaigns where id=$1", [campaign])).rows[0].pace_seconds)).toBe(PACE);
}, 120_000);

it("two concurrent resumers share one cadence and never double-schedule", async () => {
  await seed("paused");
  const settle = (client: Client) => loop(client, RESUME, [campaign, PACE, LIMIT])
    .catch((e: Error) => {
      // The loser may arrive after the winner flipped the campaign.
      expect(e.message).toMatch(/not paused/);
      return [];
    });
  await Promise.all([settle(a), settle(b)]);

  const after = (await rows()).sort((p, q) => p.scheduled_for!.getTime() - q.scheduled_for!.getTime());
  expect(after).toHaveLength(ROWS);
  expect(after.every((r) => r.status === "queued")).toBe(true);
  expect(new Set(after.map((r) => r.scheduled_for!.getTime())).size).toBe(ROWS);
  expectContinuousCadence(after, PACE);
  expect((await a.query("select status from public.campaigns where id=$1", [campaign])).rows[0].status).toBe("completed");
}, 120_000);

it("pauses 3,000 queued rows in batches; flips the campaign once, at the end", async () => {
  await seed("queued");
  const before = new Map((await rows()).map((r) => [r.id, r.scheduled_for]));
  const statuses: string[] = [];
  for (let i = 0; i < 100; i += 1) {
    const t0 = performance.now();
    const r = (await a.query(PAUSE, [campaign, LIMIT])).rows[0];
    batchMs.push(performance.now() - t0);
    statuses.push((await a.query("select status from public.campaigns where id=$1", [campaign])).rows[0].status);
    if (Number(r.remaining_count) === 0) break;
  }
  expect(statuses).toEqual(["active", "active", "active", "active", "active", "paused"]);
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
  await Promise.all([loop(a, PAUSE, [campaign, LIMIT]), loop(b, PAUSE, [campaign, LIMIT])]);
  const after = await rows();
  expect(after.every((r) => r.status === "paused")).toBe(true);
  for (const r of after) {
    const prev = (r.metadata.campaignPause as Record<string, unknown>).previousScheduledFor;
    expect(ts(prev)).toBe(before.get(r.id)?.getTime() ?? null);
  }
  expect((await a.query("select status from public.campaigns where id=$1", [campaign])).rows[0].status).toBe("paused");
}, 120_000);

it("reschedules 3,000 queued rows in batches with the single-shot order and spacing", async () => {
  await seed("queued");
  const before = await rows();
  const reference = [...before].sort((p, q) =>
    cmp(p.scheduled_for?.getTime() ?? null, q.scheduled_for?.getTime() ?? null, false) || tie(p, q));
  const run = randomUUID();
  const results = await loop(a, CADENCE, [campaign, 6, LIMIT, run]);
  expect(results).toHaveLength(6);
  const after = new Map((await rows()).map((r) => [r.id, r]));
  expectContinuousCadence(reference.map((r) => after.get(r.id)!), 6);
  expect(Number((await a.query("select pace_seconds from public.campaigns where id=$1", [campaign])).rows[0].pace_seconds)).toBe(6);
}, 120_000);

it("a concurrent second caller of the same cadence run never double-schedules", async () => {
  await seed("queued");
  const run = randomUUID();
  await Promise.all([loop(a, CADENCE, [campaign, 6, LIMIT, run]), loop(b, CADENCE, [campaign, 6, LIMIT, run])]);
  const after = (await rows()).sort((p, q) => p.scheduled_for!.getTime() - q.scheduled_for!.getTime());
  expect(new Set(after.map((r) => r.scheduled_for!.getTime())).size).toBe(ROWS);
  expectContinuousCadence(after, 6);
}, 120_000);

it("rejects out-of-range limits and stays service_role only", async () => {
  await expect(a.query(RESUME, [campaign, PACE, 0])).rejects.toThrow(/limit must be between/);
  await expect(a.query(PAUSE, [campaign, 5001])).rejects.toThrow(/limit must be between/);
  const grants = await a.query(`select routine_name, grantee from information_schema.routine_privileges
    where routine_name in ('resume_campaign_queue','pause_campaign_queue','apply_campaign_cadence_reschedule')
      and privilege_type='EXECUTE'`);
  const who = grants.rows.map((r) => r.grantee);
  expect(who).toContain("service_role");
  expect(who).not.toContain("authenticated");
  expect(who).not.toContain("anon");
  expect(who).not.toContain("PUBLIC");
});
