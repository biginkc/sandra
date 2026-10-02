import { createHash, randomUUID } from "node:crypto";

import type { PoolClient } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { Harness } from "./harness";
import { rng, sleep } from "./trace";

/**
 * Switchboard's apply_switchboard_contact_preferences locks contact -> property
 * -> enrollments; Norma's completion locks request -> enrollments -> contact ->
 * property. The two orders are not the same, so when a Switchboard global
 * do-not-contact lands while a Norma call is completing on the same lead, a
 * deadlock is possible and Postgres kills one of them. That is accepted and
 * retried (a webhook is redelivered, Switchboard resends). What must hold is
 * that after the retry BOTH effects exist: nothing the victim was doing is lost.
 */
let h: Harness;
let consumerId: string;
beforeAll(async () => {
  h = await Harness.create(rng(77));
  consumerId = randomUUID();
  await h.scratch.pool.query(
    "insert into public.webhook_consumers (id, org_id, name, secret_hash, consumer_type, default_source) values ($1, $2, 'Switchboard stress', $3, 'switchboard_contact_preference', null)",
    [consumerId, h.world.org, consumerId.replaceAll("-", "").padEnd(64, "0")],
  );
});
afterAll(async () => {
  await h?.close();
});

const q = async (sql: string, params: unknown[] = []) => (await h.scratch.pool.query(sql, params)).rows;

/** Run on its own connection with a delay trigger armed (sleeps after the row lock, before the next lock). */
async function delayed<T>(on: "enrollment" | "request", ms: number, run: (c: PoolClient) => Promise<T>): Promise<T> {
  const c = await h.scratch.pool.connect();
  try {
    await c.query(`set stress.delay_${on}_ms = ${Math.floor(ms)}`);
    return await run(c);
  } finally {
    await c.query(`reset stress.delay_${on}_ms`).catch(() => undefined);
    c.release();
  }
}

/** One attempt; a deadlock victim is retried exactly as production would (redelivery / resend). */
async function withRetry(run: () => Promise<unknown>): Promise<{ retries: number }> {
  let retries = 0;
  for (;;) {
    try {
      await run();
      return { retries };
    } catch (error) {
      const code = (error as { code?: string }).code;
      if ((code !== "40P01" && code !== "40001") || retries >= 5) throw error;
      retries += 1;
      await sleep(50);
    }
  }
}

async function switchboardGlobalDnc(c: PoolClient, phone: string, key: string) {
  const category = "explicit_do_not_contact";
  const marker = "analysis:global_dnc_requested";
  const evidence = createHash("sha256").update(`switchboard_contact_preference_v1\0${key}\0${category}\0${marker}`, "utf8").digest("hex");
  await c.query("begin");
  try {
    await c.query("select set_config('request.jwt.claim.role', 'service_role', true)");
    await c.query("select set_config('request.jwt.claim.sub', '', true)");
    const result = await c.query(
      `select public.apply_switchboard_contact_preferences(
         $1, $2, $3, $4, 'provider_call', 'contact_preference.explicit',
         $5, $6, $7, null, now(), $8, $9, null, true, false, $10, $11, null, null, null, null
       ) as result`,
      [h.world.org, consumerId, key, "a".repeat(64), `source-${key}`, `call-${key}`, marker, `corr-${key}`, phone, category, evidence],
    );
    await c.query("commit");
    return result.rows[0].result as { outcome: string };
  } catch (error) {
    await c.query("rollback").catch(() => undefined);
    throw error;
  }
}

async function race(slow: "norma" | "switchboard" | "none", offsetMs: number) {
  const ctx = await h.lead({ enrollments: ["paused:call_in_progress"] }, { kind: "reached" });
  await h.requestCall(ctx, h.world.rep1);
  const request = (await q("select * from public.norma_call_requests where property_id = $1 order by created_at desc limit 1", [ctx.lead.property]))[0];
  const key = randomUUID();

  const norma = withRetry(() =>
    delayed("enrollment", slow === "norma" ? 700 : 0, (c) =>
      c.query("select public.fn_norma_complete_call($1, $2, 'reached_no_callback', '{}'::jsonb) as r", [request.id, request.bland_call_id]),
    ),
  );
  await sleep(offsetMs);
  const switchboard = withRetry(async () => {
    const c = await h.scratch.pool.connect();
    try {
      if (slow === "switchboard") await c.query("set stress.delay_enrollment_ms = 700");
      const out = await switchboardGlobalDnc(c, ctx.lead.phone, key);
      expect(["applied", "replayed"]).toContain(out.outcome);
    } finally {
      await c.query("reset stress.delay_enrollment_ms").catch(() => undefined);
      c.release();
    }
  });
  const [n, s] = await Promise.all([norma, switchboard]);

  // Norma's effect: the call is recorded and the request settled.
  const settled = (await q("select status, outcome from public.norma_call_requests where id = $1", [request.id]))[0];
  expect(settled).toMatchObject({ status: "completed", outcome: "reached_no_callback" });
  expect(Number((await q("select count(*)::int as n from public.lead_events where event_type = 'norma_call_completed' and source_id = $1", [request.id]))[0].n)).toBe(1);
  // Switchboard's effect: contact and property locked, drips opted out, none resumed.
  expect((await q("select do_not_contact from public.contacts where id = $1", [ctx.lead.contact]))[0].do_not_contact).toBe(true);
  expect((await q("select is_dnc_locked from public.properties where id = $1", [ctx.lead.property]))[0].is_dnc_locked).toBe(true);
  const enrollments = await q("select status, pause_reason from public.sequence_enrollments where property_id = $1", [ctx.lead.property]);
  expect(enrollments).toHaveLength(1);
  expect(enrollments[0]).toMatchObject({ status: "opted_out", pause_reason: "dnc" });
  // The idempotency record shows exactly one applied preference.
  expect(Number((await q("select count(*)::int as n from public.webhook_events where org_id = $1 and external_id = $2 and processing_status = 'processed'", [h.world.org, key]))[0].n)).toBe(1);
  return n.retries + s.retries;
}

describe("Switchboard global do-not-contact vs a Norma completion on the same lead", () => {
  it.each([
    ["Norma's enrollment write is slow", "norma"],
    ["Switchboard's enrollment write is slow", "switchboard"],
  ] as const)("%s: both settle and neither effect is lost after retry", async (_name, slow) => {
    const retries = await race(slow, slow === "norma" ? 200 : 0);
    expect(retries).toBeLessThanOrEqual(10);
  });

  it("many races with random offsets: every one settles with both effects (deadlock victims retried)", async () => {
    const r = rng(4242);
    const offsets = Array.from({ length: 16 }, () => r.int(0, 40));
    const retries = await Promise.all(offsets.map((offset) => race("none", offset)));
    console.log(`[norma-stress] switchboard-vs-completion races=${offsets.length} deadlock-retries=${retries.reduce((a, b) => a + b, 0)}`);
  });
});
