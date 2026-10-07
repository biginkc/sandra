import { randomUUID } from "node:crypto";

import type { Pool, PoolClient } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { Harness } from "./harness";
import { rng, sleep, type Rng } from "./trace";

/**
 * [B1] Queue lock-order stress (docs/norma/queue-sql-contract.md, concurrency section).
 *
 * One property, one queue entry, four writers released together in a random order with random head starts:
 *   - completion   fn_norma_complete_call (settles the attempt, ends the entry)
 *   - block        a committed write that makes the lead ineligible (DNC lock / contact DNC / disposition) -> the
 *                  zz_norma_queue_block_* triggers
 *   - claim        fn_norma_queue_claim (SKIP LOCKED; must never wait)
 *   - pause/resume fn_norma_queue_pause then fn_norma_queue_resume (the operator path)
 * The harness delay triggers (stress.delay_*_ms, scratch database only) randomly hold a row lock open inside the
 * completion / enrollment update to widen the window between the first and the next lock.
 *
 * Probabilistic by design: a pass is "no violation seen in N randomised runs", a fail is a hard counter-example.
 * Violations:
 *   - deadlock detected (40P01) in any writer, or any writer still running after HANG_MS (an undetected deadlock);
 *   - a lost settlement: the completion answered ok but the request is not completed / has no settled attempt;
 *   - a lost block: the lead is ineligible at the end but a live entry (queued/paused/calling) carries no block.
 *
 * Needs the queue migrations in the scratch database (the harness applies every *_norma_*.sql); on a baseline without
 * them the file fails fast in beforeAll, by design.
 *
 *   NORMA_QUEUE_B1_RUNS (default 300), NORMA_QUEUE_B1_SEED (default 1001)
 */
const RUNS = Number(process.env.NORMA_QUEUE_B1_RUNS ?? 300);
const SEED = Number(process.env.NORMA_QUEUE_B1_SEED ?? 1001);
const HANG_MS = 20_000;
const V_OPEN = "2030-01-07T17:00:00Z"; // Mon 11:00 Chicago, window open
const TERMINAL = ["callback_requested", "reached_no_callback", "not_interested", "wrong_number"] as const;

type Row = Record<string, unknown>;
let h: Harness;
let pool: Pool;
beforeAll(async () => {
  h = await Harness.create(rng(SEED));
  pool = h.scratch.pool;
  const t = await pool.query("select to_regclass('public.norma_queue_entries') as t");
  if (!t.rows[0].t) throw new Error("queue migrations are not in the scratch database (norma_queue_entries missing)");
}, 180_000);
afterAll(async () => {
  await h?.close();
});

const q = async (sql: string, params: unknown[] = []) => (await pool.query(sql, params)).rows as Row[];
const one = async (sql: string, params: unknown[] = []) => (await q(sql, params))[0]!;

async function seed(shape: "calling" | "queued") {
  const l = await h.world.nextLead({ enrollments: ["active"] });
  const rep = h.world.rep1;
  const enq = await one("select * from public.fn_norma_queue_enqueue($1::uuid,$2::uuid,$3::uuid[],'b1')", [h.world.org, rep, [l.property]]);
  expect(enq.result).toBe("queued");
  const entry = enq.entry_id as string;
  await q("update public.norma_queue_entries set created_at = created_at - interval '1 day', next_attempt_at = '2029-12-01T00:00:00Z' where id=$1", [entry]);
  if (shape === "queued") return { l, entry, requestId: null as string | null, callId: null as string | null };
  const claim = await one("select * from public.fn_norma_queue_claim($1::uuid,$2::timestamptz,true)", [entry, V_OPEN]);
  expect(claim.result).toBe("claimed");
  const req = await one("select * from public.fn_norma_create_request_v2($1::uuid,$2::uuid,$3::text,$4::uuid,'b1',$4::uuid,$5::uuid,$6::uuid)", [l.property, l.contact, l.phone, rep, entry, claim.lease_token]);
  expect(req.outcome).toBe("created");
  const requestId = req.request_id as string;
  expect((await one("select public.fn_norma_claim_dispatch_v2($1::uuid,1,$2::timestamptz,true,1000,100000,'America/Chicago') as r", [requestId, V_OPEN])).r).toBe("claimed");
  await q("update public.norma_call_requests set send_attempted_at=$2::timestamptz where id=$1", [requestId, V_OPEN]);
  const callId = `b1-${randomUUID()}`;
  expect((await one("select public.fn_norma_bind_call_id($1::uuid,$2::text,1::integer) as b", [requestId, callId])).b).toBe("bound");
  return { l, entry, requestId, callId };
}

type Outcome = { actor: string; ok: boolean; value?: unknown; code?: string; message?: string };

/** Run `fn` on its own connection, optionally with a delay trigger armed (row held open after its lock, before the next one). */
async function onConnection(delay: { guc: "stress.delay_request_ms" | "stress.delay_enrollment_ms"; ms: number } | null, fn: (c: PoolClient) => Promise<unknown>) {
  const c = await pool.connect();
  try {
    if (delay) await c.query(`set ${delay.guc} = ${Math.floor(delay.ms)}`);
    return await fn(c);
  } finally {
    if (delay) await c.query(`reset ${delay.guc}`).catch(() => undefined);
    c.release();
  }
}

async function oneRun(r: Rng, n: number): Promise<{ violations: string[]; shape: string; results: Outcome[] }> {
  const shape = r.chance(0.5) ? "calling" : "queued";
  const s = await seed(shape);
  const rep = h.world.rep1;
  const blockKind = r.pick(["dnc_lock", "contact_dnc", "dispo_dnc"] as const);
  const outcome = r.pick(TERMINAL);
  const delayFor = () =>
    r.chance(0.4) ? { guc: r.pick(["stress.delay_request_ms", "stress.delay_enrollment_ms"] as const), ms: r.int(20, 200) } : null;

  const actors: { name: string; run: () => Promise<unknown> }[] = [];
  if (shape === "calling") {
    const d = delayFor();
    actors.push({
      name: "completion",
      run: () =>
        onConnection(d, async (c) => (await c.query("select public.fn_norma_complete_call($1::uuid,$2::text,$3::text,$4::jsonb) as r", [s.requestId, s.callId, outcome, JSON.stringify({ attempt: 1 })])).rows[0].r),
    });
  }
  {
    const d = delayFor();
    actors.push({
      name: `block:${blockKind}`,
      run: () =>
        onConnection(d, async (c) => {
          if (blockKind === "dnc_lock") {
            // The existing DNC guards refuse a lock with no authoritative signal (DNC_LOCK_INVALID) and make a locked property read-only
            // (DNC_LOCKED), so the signal and the lock commit together and the lock is only written if the signal did not already lock it.
            await c.query("begin");
            try {
              await c.query("update public.contacts set do_not_contact = true where id = $1", [s.l.contact]);
              const n = (await c.query("update public.properties set is_dnc_locked = true where id = $1 and not is_dnc_locked", [s.l.property])).rowCount;
              await c.query("commit");
              return n;
            } catch (e) {
              await c.query("rollback").catch(() => undefined);
              throw e;
            }
          }
          if (blockKind === "contact_dnc") return (await c.query("update public.contacts set do_not_contact = true where id = $1", [s.l.contact])).rowCount;
          return (await c.query("update public.properties set outreach_dispo = 'dnc' where id = $1", [s.l.property])).rowCount;
        }),
    });
  }
  actors.push({
    name: "claim",
    run: () => onConnection(null, async (c) => (await c.query("select * from public.fn_norma_queue_claim($1::uuid,$2::timestamptz,true)", [s.entry, V_OPEN])).rows[0]?.result),
  });
  actors.push({
    name: "pause_resume",
    run: () =>
      onConnection(null, async (c) => {
        const a = (await c.query("select public.fn_norma_queue_pause($1::uuid,$2::uuid) as r", [s.entry, rep])).rows[0].r;
        await sleep(r.int(0, 15));
        const b = (await c.query("select public.fn_norma_queue_resume($1::uuid,$2::uuid,$3::timestamptz) as r", [s.entry, rep, V_OPEN])).rows[0].r;
        return `${a}/${b}`;
      }),
  });

  const order = r.shuffle(actors);
  const heads = order.map(() => r.int(0, 40));
  const settled = Promise.all(
    order.map(
      async (a, i): Promise<Outcome> => {
        await sleep(heads[i]!);
        try {
          return { actor: a.name, ok: true, value: await a.run() };
        } catch (e) {
          const err = e as { code?: string; message?: string };
          return { actor: a.name, ok: false, code: err.code, message: err.message };
        }
      },
    ),
  );
  const hang = new Promise<"hang">((resolve) => setTimeout(() => resolve("hang"), HANG_MS));
  const raced = await Promise.race([settled, hang]);
  const violations: string[] = [];
  if (raced === "hang") {
    const waiting = await q("select pid, wait_event_type, wait_event, state, left(query, 120) as query from pg_stat_activity where datname = current_database() and wait_event_type = 'Lock'");
    violations.push(`run ${n} (${shape}): writers still running after ${HANG_MS} ms (undetected deadlock / lost wake-up); waiting sessions=${JSON.stringify(waiting)}`);
    return { violations, shape, results: [] };
  }
  const results = raced;

  for (const o of results) {
    if (!o.ok) violations.push(`run ${n} (${shape}) ${o.actor}: ${o.code === "40P01" ? "DEADLOCK" : "error"} ${o.code ?? ""} ${o.message ?? ""}`);
  }

  // ---- end state ----
  const entry = await one("select status, pause_reason, end_reason, blocked_reason, lease_token from public.norma_queue_entries where id=$1", [s.entry]);
  const blockNow = (await one("select norma_private.fn_norma_queue_block_reason_core($1::uuid,$2::uuid) as b", [s.l.property, s.l.contact])).b as string | null;
  if (!blockNow) violations.push(`run ${n} (${shape}): test premise broken, the ${blockKind} write left the lead eligible`);

  if (shape === "calling") {
    const done = results.find((o) => o.actor === "completion");
    const r0 = (done?.value ?? null) as Row | null;
    const req = await one("select status, outcome from public.norma_call_requests where id=$1", [s.requestId]);
    const attempts = await q("select outcome from public.norma_queue_attempts where request_id=$1", [s.requestId]);
    if (r0 && (r0 as { result?: string }).result !== "applied") violations.push(`run ${n} (calling): completion answered ${JSON.stringify(r0)}`);
    if (req.status !== "completed") violations.push(`run ${n} (calling): LOST SETTLEMENT request is ${String(req.status)} after an ok completion (outcome ${outcome})`);
    if (attempts.length !== 1 || !attempts[0]!.outcome) violations.push(`run ${n} (calling): LOST SETTLEMENT attempts=${JSON.stringify(attempts)}`);
    if (!["done"].includes(entry.status as string)) violations.push(`run ${n} (calling): entry left ${String(entry.status)} after a terminal settlement ${JSON.stringify(entry)}`);
  }
  // A blocked lead must not keep a live, unflagged entry.
  if (blockNow && ["queued", "paused", "calling"].includes(entry.status as string) && !entry.blocked_reason) {
    violations.push(`run ${n} (${shape}): LOST BLOCK ${blockNow} but entry is ${JSON.stringify(entry)}`);
  }
  if (entry.status === "done" && entry.end_reason == null) violations.push(`run ${n} (${shape}): entry done without an end_reason`);
  return { violations, shape, results };
}

describe("[B1] queue lock-order stress: completion vs block trigger vs claim vs resume on one property", () => {
  it(`${RUNS} randomised runs: no deadlock, no hang, no lost settlement, no lost block`, async () => {
    const r = rng(SEED);
    const all: string[] = [];
    const shapes = { calling: 0, queued: 0 };
    const byActor = new Map<string, number>();
    for (let n = 1; n <= RUNS; n += 1) {
      const out = await oneRun(r, n);
      shapes[out.shape as "calling" | "queued"] += 1;
      for (const o of out.results) byActor.set(`${o.actor.split(":")[0]}:${o.ok ? "ok" : "err"}`, (byActor.get(`${o.actor.split(":")[0]}:${o.ok ? "ok" : "err"}`) ?? 0) + 1);
      all.push(...out.violations);
      if (out.violations.some((v) => v.includes("undetected"))) break; // sessions are wedged: stop and report
    }
    // eslint-disable-next-line no-console
    console.log(`[norma-queue-b1] seed=${SEED} runs=${RUNS} shapes=${JSON.stringify(shapes)} actors=${JSON.stringify(Object.fromEntries(byActor))} violations=${all.length}`);
    expect(all, `FAILING SEED ${SEED} (replay: NORMA_QUEUE_B1_SEED=${SEED} NORMA_QUEUE_B1_RUNS=${RUNS})\n${all.slice(0, 20).join("\n")}`).toEqual([]);
  }, 20 * 60_000);
});
