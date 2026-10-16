import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";

import { expect, test, type BrowserContext, type Page } from "@playwright/test";
import { createBrowserClient } from "@supabase/ssr";
import { Client } from "pg";

import { CANARY_ORG_ID, runTag } from "./d-lane-fixture";

/**
 * Messages v2 Stage 5, Run 4 (UI load), D LANE ONLY. Runs after `npm run stress:messages-v2:load-seed` on the same
 * disposable stack, against an app started on that stack (see playwright.messages-v2-stress.config.ts).
 *
 * Gates (STRESS-PLAN Run 4):
 *   1. first paint: 5 cold loads (fresh browser context each, after one warm-up), median and worst reported; gate:
 *      worst < 3 s for "content painted" (both columns showing cards). FCP is reported alongside.
 *   2. (4.2a, refresh poll paused) "Show older" pages the waiting column to the end: the union of flag times equals the open
 *      holds exactly (no gaps, no duplicates). "Show yesterday's tape" pages the seeded day to the end: the union of
 *      run tokens equals R00001..R0<n> exactly.
 *      (4.2b, real timers) the same walk at automation speed must reach the end before the page's 60 s refresh poll
 *      rebuilds the list (a rebuild drops every "Show older" card loaded so far).
 *   3. memory: CDP heap (after a forced GC) sampled every 30 s for MV2_STRESS_SOAK_MS (default 5 min; the plan's
 *      full soak is 30 min: MV2_STRESS_SOAK_MS=1800000) with realtime on and a tagged run inserted every 15 s;
 *      gate: < 20% growth after the first minute.
 */
const OUT = path.resolve(process.env.MV2_STRESS_OUT_DIR ?? "test-results/messages-v2-stress");
const seed = JSON.parse(readFileSync(path.join(OUT, "load-seed.json"), "utf8")) as { runId: string; day: string; requested: { holds: number; runs: number } };
const owner = JSON.parse(readFileSync(path.join(OUT, "load-owner.json"), "utf8")) as { email: string; password: string };
const TAG = runTag(seed.runId);
const SOAK_MS = Number(process.env.MV2_STRESS_SOAK_MS ?? "300000");
const PAINT_GATE_MS = 3000;
const results: Record<string, unknown> = {};
/** One file per measure: a failed test restarts the Playwright worker, so nothing may live only in memory. */
function save(key: string, value: unknown) {
  results[key] = value;
  mkdirSync(OUT, { recursive: true });
  writeFileSync(path.join(OUT, `ui-load-${key}.json`), JSON.stringify({ lane: "D", runId: seed.runId, appUrl: process.env.MV2_STRESS_APP_URL, [key]: value }, null, 1));
  console.log(JSON.stringify({ [key]: value }, null, 1));
}
const pg = new Client({ connectionString: process.env.TEST_SUPABASE_DB_URL });

async function login(context: BrowserContext, baseURL: string) {
  const jar = new Map<string, string>();
  const auth = createBrowserClient(process.env.TEST_SUPABASE_URL!, process.env.TEST_SUPABASE_ANON_KEY!, {
    isSingleton: false,
    cookies: {
      getAll: () => [...jar].map(([name, value]) => ({ name, value })),
      setAll: (cookies) => {
        for (const c of cookies) {
          if (c.value) jar.set(c.name, c.value);
          else jar.delete(c.name);
        }
      },
    },
  });
  const { error } = await auth.auth.signInWithPassword({ email: owner.email, password: owner.password });
  if (error) throw error;
  await context.addCookies([...jar].map(([name, value]) => ({ name, value, url: baseURL, sameSite: "Lax" as const })));
}

async function contentReady(page: Page) {
  await expect(page.getByTestId("waiting-card").first()).toBeVisible({ timeout: 60_000 });
  await expect(page.getByTestId("tape-card").first()).toBeVisible({ timeout: 60_000 });
}

const quantile = (xs: number[], q: number) => [...xs].sort((a, b) => a - b)[Math.min(xs.length - 1, Math.floor(q * xs.length))];

test.beforeAll(async () => {
  await pg.connect();
});
test.afterAll(async () => {
  await pg.end();
});

test("Run 4.1: /messages-v2 first paint, 5 cold loads, worst < 3 s", async ({ browser, baseURL }) => {
  const warm = await browser.newContext();
  await login(warm, baseURL!);
  const wp = await warm.newPage();
  await wp.goto("/messages-v2");
  await contentReady(wp);
  await warm.close();
  const loads: Array<{ fcpMs: number | null; contentMs: number; status: number | null }> = [];
  for (let i = 0; i < 5; i++) {
    const ctx = await browser.newContext();
    await login(ctx, baseURL!);
    const page = await ctx.newPage();
    const t0 = Date.now();
    const res = await page.goto("/messages-v2");
    await contentReady(page);
    const contentMs = Date.now() - t0;
    const fcpMs = await page.evaluate(() => performance.getEntriesByName("first-contentful-paint")[0]?.startTime ?? null);
    loads.push({ fcpMs, contentMs, status: res?.status() ?? null });
    await ctx.close();
  }
  const content = loads.map((l) => l.contentMs);
  const fcp = loads.flatMap((l) => (l.fcpMs === null ? [] : [l.fcpMs]));
  save("firstPaint", { loads, contentMedianMs: quantile(content, 0.5), contentWorstMs: Math.max(...content), fcpMedianMs: quantile(fcp, 0.5), fcpWorstMs: Math.max(...fcp), gateMs: PAINT_GATE_MS });
  expect(loads.every((l) => l.status === 200)).toBe(true);
  expect(Math.max(...content), "worst cold load until both columns show cards").toBeLessThan(PAINT_GATE_MS);
});

/**
 * Pages both lists to the end and compares the union with the DB. A drop in the number of waiting cards while
 * paging means the list was rebuilt under the user (the page's 60 s refresh poll makes a new snapshot, which drops
 * every "Show older" card loaded so far); that is recorded as a reset and the walk stops there.
 */
async function pageToEnd(page: Page, label: string) {
  const errors: string[] = [];
  page.on("console", (m) => { if (m.type() === "error") errors.push(m.text()); });
  page.on("pageerror", (e) => errors.push(String(e)));
  await page.goto("/messages-v2");
  await contentReady(page);

  const cards = page.getByTestId("waiting-card");
  const older = page.getByTestId("show-older");
  let clicks = 0;
  let reset: { atClick: number; cardsBefore: number; cardsAfter: number; afterMs: number } | null = null;
  let most = 0;
  const t0 = Date.now();
  while ((await older.count()) > 0 && clicks < 400 && !reset) {
    const n = await cards.count();
    // A rebuild can land between clicks too: compare with the most cards ever shown, not just the last click.
    if (n < most) {
      reset = { atClick: clicks, cardsBefore: most, cardsAfter: n, afterMs: Date.now() - t0 };
      break;
    }
    most = n;
    await older.click();
    clicks++;
    if (clicks % 25 === 0) console.log(`[${label}] show older: ${clicks} clicks, ${n} cards`);
    await expect.poll(async () => (await older.count()) === 0 || (await cards.count()) < n || ((await cards.count()) > n && !(await older.isDisabled())), { timeout: 60_000 }).toBe(true);
    const now = await cards.count();
    if (now < n) reset = { atClick: clicks, cardsBefore: n, cardsAfter: now, afterMs: Date.now() - t0 };
    most = Math.max(most, now);
  }
  const shown = await page.locator('[data-testid="waiting-card"] [data-testid="waiting-time"] time').evaluateAll((els) => els.map((e) => Date.parse(e.getAttribute("datetime") ?? "")));
  const { rows: dbHolds } = await pg.query(
    "select (extract(epoch from last_ai_escalation_at) * 1000)::bigint as ms from public.properties where org_id = $1 and needs_human_attention and not is_dnc_locked",
    [CANARY_ORG_ID],
  );
  const dbSet = new Set(dbHolds.map((r) => Number(r.ms)));
  const shownSet = new Set(shown);
  const holds = {
    clicks,
    ms: Date.now() - t0,
    cards: shown.length,
    unique: shownSet.size,
    db: dbSet.size,
    gaps: [...dbSet].filter((ms) => !shownSet.has(ms)).length,
    extra: [...shownSet].filter((ms) => !dbSet.has(ms)).length,
    duplicates: shown.length - shownSet.size,
    reset,
  };

  const earlier = page.getByTestId("show-earlier");
  const note = page.getByTestId("earlier-note");
  let tapeClicks = 0;
  const t1 = Date.now();
  while ((await note.count()) === 0 && tapeClicks < 60) {
    await earlier.click();
    tapeClicks++;
    await expect(earlier).toBeEnabled({ timeout: 60_000 });
  }
  const noteText = (await note.count()) ? await note.innerText() : null;
  const tokens = await page.getByTestId("tape-card").evaluateAll((els, tag) => els.flatMap((e) => [...new Set([...(e.textContent ?? "").matchAll(new RegExp(`${tag} (R\\d{5})`, "g"))].map((m) => m[1]))]), TAG);
  // (A card shows the seller's text twice: the run's preview and the thread. One token per card.)
  const tokenSet = new Set(tokens);
  const expected = Array.from({ length: seed.requested.runs }, (_, i) => `R${String(i + 1).padStart(5, "0")}`);
  const tape = {
    clicks: tapeClicks,
    ms: Date.now() - t1,
    cards: await page.getByTestId("tape-card").count(),
    tokens: tokens.length,
    unique: tokenSet.size,
    db: expected.length,
    gaps: expected.filter((t) => !tokenSet.has(t)).length,
    duplicates: tokens.length - tokenSet.size,
    endNote: noteText,
  };
  return { holds, tape, consoleErrorCount: errors.length, consoleErrors: errors.slice(0, 10) };
}

test("Run 4.2a: paging integrity (refresh poll paused): Show older and Show yesterday's tape reach the end with no gaps or duplicates", async ({ browser, baseURL }) => {
  const ctx = await browser.newContext();
  await login(ctx, baseURL!);
  // Isolate the paging mechanism from the page's 60 s refresh poll (4.2b covers the real-timer behaviour).
  await ctx.addInitScript(() => {
    const orig = window.setInterval.bind(window);
    window.setInterval = ((fn: TimerHandler, ms?: number, ...rest: unknown[]) => (ms === 60_000 ? 0 : orig(fn, ms, ...rest))) as typeof window.setInterval;
  });
  const r = await pageToEnd(await ctx.newPage(), "4.2a");
  save("pagingIntegrity", r);
  await ctx.close();
  expect(r.holds.reset).toBeNull();
  expect({ gaps: r.holds.gaps, extra: r.holds.extra, duplicates: r.holds.duplicates, total: r.holds.cards }).toEqual({ gaps: 0, extra: 0, duplicates: 0, total: r.holds.db });
  expect({ gaps: r.tape.gaps, duplicates: r.tape.duplicates, total: r.tape.unique }).toEqual({ gaps: 0, duplicates: 0, total: r.tape.db });
  expect(r.tape.endNote).toContain("No texts came in during the week before that.");
});

test("Run 4.2b: real timers: a person paging 5,000 holds reaches the end before the refresh poll rebuilds the list", async ({ browser, baseURL }) => {
  const ctx = await browser.newContext();
  await login(ctx, baseURL!);
  const r = await pageToEnd(await ctx.newPage(), "4.2b");
  save("pagingRealTimers", r);
  await ctx.close();
  // A reset drops every "Show older" card loaded so far: the end of a 5,000-hold list is not reachable. Reported as a
  // visible failure, not masked (STRESS-PLAN Run 4 gate: "page to the end").
  expect(r.holds.reset, "the waiting list was rebuilt while paging (60 s refresh poll), dropping the older cards").toBeNull();
  expect({ gaps: r.holds.gaps, extra: r.holds.extra, duplicates: r.holds.duplicates }).toEqual({ gaps: 0, extra: 0, duplicates: 0 });
  expect({ gaps: r.tape.gaps, duplicates: r.tape.duplicates }).toEqual({ gaps: 0, duplicates: 0 });
});

test("Run 4.3: memory stable with realtime on (bounded soak)", async ({ browser, baseURL }) => {
  const ctx = await browser.newContext();
  await login(ctx, baseURL!);
  const page = await ctx.newPage();
  await page.goto("/messages-v2");
  await contentReady(page);
  const cdp = await ctx.newCDPSession(page);
  const heap = async () => {
    await cdp.send("HeapProfiler.collectGarbage");
    const u = (await cdp.send("Runtime.getHeapUsage")) as { usedSize: number };
    return u.usedSize;
  };
  const samples: Array<{ t: number; used: number }> = [];
  const start = Date.now();
  let inserted = 0;
  let nextInsert = start + 15_000;
  let nextSample = start;
  while (Date.now() - start <= SOAK_MS) {
    const now = Date.now();
    if (now >= nextSample) {
      samples.push({ t: now - start, used: await heap() });
      nextSample += 30_000;
    }
    if (now >= nextInsert) {
      inserted++;
      const token = `S${String(inserted).padStart(5, "0")}`;
      await pg.query(
        `with c as (insert into public.contacts (org_id, first_name, last_name, phone_1, phone_1_type) values ($1, $3, $2, '+1913' || lpad((7000000 + $4::int)::text, 7, '0'), 'mobile') returning id),
              p as (insert into public.properties (org_id, address, state, status, homeowner_contact_id) select $1, $2 || ' ' || $3 || ' Ash St', 'MO', 'prospect', id from c returning id, homeowner_contact_id),
              m as (insert into public.messages (org_id, channel, direction, status, property_id, contact_id, from_address, to_address, body)
                    select $1, 'sms', 'inbound', 'received', p.id, p.homeowner_contact_id, '+1913' || lpad((7000000 + $4::int)::text, 7, '0'), '+18165550000', 'Not interested ' || $2 || ' ' || $3 from p returning id, property_id, contact_id, conversation_id)
         insert into public.pipeline_runs (org_id, inbound_message_id, property_id, contact_id, conversation_id, status, mode, final_outcome, reason, inbound_preview)
         select $1, m.id, m.property_id, m.contact_id, m.conversation_id, 'closed', 'automatic', 'not_interested', 'nine_questions:not_interested', 'Not interested ' || $2 || ' ' || $3 from m`,
        [CANARY_ORG_ID, TAG, token, inserted],
      );
      nextInsert += 15_000;
    }
    await page.waitForTimeout(1000);
  }
  const baseline = samples.find((s) => s.t >= 60_000) ?? samples[0];
  const after = samples.filter((s) => s.t >= baseline.t);
  const peak = Math.max(...after.map((s) => s.used));
  const last = after[after.length - 1].used;
  const growthPct = ((last - baseline.used) / baseline.used) * 100;
  const peakGrowthPct = ((peak - baseline.used) / baseline.used) * 100;
  const liveCards = await page.getByTestId("tape-card").evaluateAll((els, tag) => els.filter((e) => new RegExp(`${tag} S\\d{5}`).test(e.textContent ?? "")).length, TAG);
  save("memory", { soakMs: SOAK_MS, realtimeInserts: inserted, realtimeCardsSeen: liveCards, baselineAtMs: baseline.t, baselineBytes: baseline.used, lastBytes: last, peakBytes: peak, growthPct: Number(growthPct.toFixed(1)), peakGrowthPct: Number(peakGrowthPct.toFixed(1)), samples });
  await ctx.close();
  expect(growthPct, "heap growth from the 1-minute baseline to the end").toBeLessThan(20);
});
