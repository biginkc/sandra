import { appendFileSync, readFileSync } from "node:fs";
import path from "node:path";

import { createBrowserClient } from "@supabase/ssr";
import type { BrowserContext, Page } from "@playwright/test";

import { FaultState, type Ctx } from "../actions";
import { readConfig } from "../config";
import { asRep, openDb } from "../db";
import { assertStressLane } from "../guards";
import { parseNdjson, type Tick } from "../manifest";
import type { TickRecord } from "../scenarios";
import { StubControl } from "../stubs";
import type { AppProof } from "../proof-guard";
import type { World, WorldLead } from "../world";

/** The browser ticks of the run's schedule: a pure file read (no database, no mutation), needed at collection time to define one test per tick. */
export function loadScheduleTicks(env: Readonly<Record<string, string | undefined>> = process.env): Tick[] {
  const file = env.STRESS_SCHEDULE_FILE;
  if (!file) throw new Error("STRESS_SCHEDULE_FILE is not set: the browser specs run only under the engine (npm run stress -- run).");
  return parseNdjson(readFileSync(file, "utf8")).filter((t) => t.actor === "browser");
}

export type Run = ReturnType<typeof loadRun>;

/** Everything a browser spec needs, loaded from the run directory the engine wrote. REQUIRES the verified app proof: it cannot be called without one. */
export function loadRun(proof: AppProof) {
  if (!proof || proof.v !== 1 || !proof.mac) throw new Error("loadRun needs the verified app-egress proof (use the `run` fixture from ./fixtures).");
  const cfg = readConfig({ ...process.env, STRESS_APP_URL: process.env.STRESS_APP_URL });
  assertStressLane(cfg, process.env);
  const dir = process.env.STRESS_RUN_DIR!;
  const ticks = loadScheduleTicks();
  const w = JSON.parse(readFileSync(process.env.STRESS_WORLD_FILE!, "utf8")) as { orgId: string; repUserId: string; connectionId: string; templateId: string; leads: Array<{ slot: number; propertyId: string; contactId: string; phone: string; address: string }> };
  const leads: WorldLead[] = w.leads.map((l) => ({ slot: l.slot, propertyId: l.propertyId, contactId: l.contactId, phoneE164: l.phone, address: l.address, episodeId: "", runTag: cfg.runTag }));
  const world: World = { orgId: w.orgId, repUserId: w.repUserId, repEmail: process.env.STRESS_REP_EMAIL!, repPassword: process.env.STRESS_REP_PASSWORD!, connectionId: w.connectionId, bindingId: "", templateId: w.templateId, leads, runTag: cfg.runTag };
  const db = openDb(cfg);
  const control = new StubControl(process.env.STRESS_STUB_URL!);
  const ctx: Ctx = { cfg, db, world, stub: null as never, faults: new FaultState("none"), sleep: (ms) => new Promise((r) => setTimeout(r, ms)) };
  return { cfg, dir, ticks, world, db, control, ctx, lead: (t: Tick) => leads[t.leadSlot]! };
}

/** One line per browser tick. `record` is the same TickRecord shape the replay engine writes, so the oracle judges browser ticks exactly like replay ticks. */
export function recordResult(dir: string, tick: number, ok: boolean, error?: string, record?: TickRecord): void {
  appendFileSync(path.join(dir, "browser-results.jsonl"), JSON.stringify({ tick, ok, error: error ?? null, record: record ?? null }) + "\n");
}

/**
 * Browser egress denial (fail closed): any request to a non-loopback host is aborted before it leaves and logged as a
 * violation in the same egress.jsonl the Node guard writes (the run fails if it is non-empty). Complements the pf ring.
 */
export async function denyBrowserEgress(context: BrowserContext): Promise<void> {
  const log = path.join(process.env.STRESS_RUN_DIR!, "egress.jsonl");
  await context.route(
    (url) => !["127.0.0.1", "localhost", "[::1]"].includes(url.hostname) && url.protocol.startsWith("http"),
    async (route) => {
      appendFileSync(log, JSON.stringify({ at: new Date().toISOString(), pid: process.pid, kind: "browser", target: route.request().url().slice(0, 200), probe: false }) + "\n");
      await route.abort("blockedbyclient");
    },
  );
}

/** Signs the rep in with the SSR cookie jar (the isolated stack has no Hugo OAuth client), then proves the shell loads. */
export async function signIn(context: BrowserContext, page: Page): Promise<void> {
  await denyBrowserEgress(context);
  const jar = new Map<string, string>();
  const auth = createBrowserClient(process.env.TEST_SUPABASE_URL!, process.env.TEST_SUPABASE_ANON_KEY!, {
    isSingleton: false,
    cookies: {
      getAll: () => [...jar].map(([name, value]) => ({ name, value })),
      setAll: (cs) => { for (const c of cs) { if (c.value) jar.set(c.name, c.value); else jar.delete(c.name); } },
    },
  });
  const { error } = await auth.auth.signInWithPassword({ email: process.env.STRESS_REP_EMAIL!, password: process.env.STRESS_REP_PASSWORD! });
  if (error) throw error;
  const base = process.env.STRESS_PROXY_URL!;
  await context.addCookies([...jar].map(([name, value]) => ({ name, value, url: base, sameSite: "Lax" as const })));
  await page.goto("/dashboard");
}

/** Non-mutating waits may retry (max 2, logged); a mutating click never does. */
export async function retryNonMutating<T>(label: string, fn: () => Promise<T>, log: string[]): Promise<T> {
  let last: unknown;
  for (let i = 0; i < 3; i += 1) {
    try { return await fn(); } catch (e) { last = e; log.push(`retry ${i + 1}/2 ${label}: ${(e as Error).message.slice(0, 80)}`); }
  }
  throw last;
}

/**
 * Dismisses every pending post-call prompt of the rep, as the rep (the app's own `fn_acknowledge_call_prompt`).
 * WHY: the queue page opens the OLDEST of the newest 20 pending prompts, and does nothing at all when that one is a
 * lead outside the loaded queue. The replay lane leaves ~60 ended calls with an open prompt, so without this the prompt
 * of the call the browser just made is never the one shown (the first browser tick used to time out here). A rep with a
 * backlog behaves the same way; that is a product observation, reported, not worked around in the app. Acknowledging
 * touches no outcome, note or appointment, so the oracle's expectations are unchanged.
 */
export async function dismissPendingPrompts(db: ReturnType<typeof openDb>, orgId: string, repUserId: string): Promise<number> {
  const rows = await db.query<{ id: string }>(
    "select id from public.acquisition_attempts where org_id=$1 and actor_user_id=$2 and source='dialpad' and outcome is null and prompt_acknowledged_at is null and call_activity_id is not null",
    [orgId, repUserId],
  );
  for (const r of rows.rows) {
    await asRep(db, repUserId, (c) => c.query("select public.fn_acknowledge_call_prompt($1,$2,'dismissed')", [orgId, r.id]));
  }
  return rows.rowCount ?? 0;
}
