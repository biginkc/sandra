import { appendFileSync, existsSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";

import { createBrowserClient } from "@supabase/ssr";
import { expect, test } from "@playwright/test";

import { createSyntheticLead } from "../../support/my-leads-close-fixture";
import { readConfig } from "../config";
import { openDb } from "../db";
import { driveLiveLeg, summarizeLive, type LivePort } from "../live-driver";
import { collectLiveAppFacts } from "../app-proof";
import { assertLiveLane } from "../guards";
import { loadReportKey } from "../signing";
import { assertLiveLegReady, liveAppRecheckProblems, loadPinnedHashes, pinnedPhoneProblems, type LiveCallStep, type LiveEvidence } from "../live-leg";

/**
 * LIVE LEG driver (DISABLED BY DEFAULT, NEVER IN CI). It is skipped unless STRESS_LIVE_LEG=1 and is refused in CI or a
 * hosted runtime; even then `assertLiveLegReady` throws unless every prerequisite is met (stubbed-leg PASS at this sha,
 * human decisions, numbers via op, tunnel + subscription proof, ...). Nothing in the default Playwright config or CI
 * reaches it (`**\/stress/**` is ignored there, and this spec is only run through playwright.stress.config.ts).
 *
 * It clicks the REAL Call button on the call screen of the isolated instance. It has no provider call of its own and
 * sends no text (the Sendillo spot check is a human step). The owned numbers are resolved at run time through the op CLI,
 * held in memory, written only into the DISPOSABLE local database as two throwaway leads, and never logged or persisted
 * anywhere else. Evidence per call is read back from that database; anything without a terminal event is "unverified".
 */
test.skip(process.env.STRESS_LIVE_LEG !== "1", "live leg is disabled unless STRESS_LIVE_LEG=1 and every prerequisite is met");

const TERMINAL_EVENTS = ["hangup", "missed", "voicemail", "abandoned", "rejected", "blocked", "cancelled"];

test("live leg: ~8 owned-number calls, evidence per call", async ({ page }) => {
  test.setTimeout(60 * 60_000);
  if (process.env.CI || process.env.GITHUB_ACTIONS || process.env.VERCEL || process.env.VERCEL_ENV) throw new Error("the live leg never runs in CI or a hosted runtime");
  const cfg = readConfig(process.env);
  assertLiveLane(cfg, process.env); // loopback bindings (incl. TEST_SUPABASE_URL and STRESS_SUPABASE_URL), disposable DB, no hosted refs, STRESS_LIVE_LEG=1, not CI
  const { numbers, plan } = await assertLiveLegReady(cfg, process.env);
  // Bind the tested app's build to THIS checkout (the sha comes from git HEAD, never from the environment), now and before EVERY dial.
  const identityLog = process.env.STRESS_LIVE_APP_IDENTITY_LOG!;
  const assertIdentity = () => {
    const problems = liveAppRecheckProblems(collectLiveAppFacts(cfg.appUrl, identityLog), cfg.sha, identityLog, process.getuid?.() ?? -1);
    if (problems.length) throw new Error(`the live app's identity check failed: ${problems.join(" | ")}`);
  };
  assertIdentity();
  const world = JSON.parse(readFileSync(process.env.STRESS_LIVE_WORLD_FILE!, "utf8")) as { orgId: string; repUserId: string };
  const outDir = path.join(cfg.artifactsRoot, `live-${cfg.runId}-${cfg.sha.slice(0, 8)}`);
  const logFile = path.join(outDir, "live.log");
  const killFile = path.join(outDir, "KILL");
  const { mkdirSync } = await import("node:fs");
  mkdirSync(outDir, { recursive: true });

  const db = openDb(cfg);
  try {
    const lead = (phone: string) => createSyntheticLead(db, { orgId: world.orgId, repUserId: world.repUserId, runTag: `${cfg.runTag}-live`, phoneE164: phone, lastTouchDaysAgo: 5 });
    const leads = { cell: await lead(numbers.cell), telnyx: await lead(numbers.telnyx) };

    // Sign in to the isolated instance directly (no gate proxy, no browser egress route: the app talks to Dialpad, the browser does not).
    const jar = new Map<string, string>();
    const auth = createBrowserClient(process.env.TEST_SUPABASE_URL!, process.env.TEST_SUPABASE_ANON_KEY!, {
      isSingleton: false,
      cookies: { getAll: () => [...jar].map(([name, value]) => ({ name, value })), setAll: (cs) => { for (const c of cs) { if (c.value) jar.set(c.name, c.value); else jar.delete(c.name); } } },
    });
    const { error } = await auth.auth.signInWithPassword({ email: process.env.STRESS_REP_EMAIL!, password: process.env.STRESS_REP_PASSWORD! });
    if (error) throw error;
    await page.context().addCookies([...jar].map(([name, value]) => ({ name, value, url: cfg.appUrl, sameSite: "Lax" as const })));

    const lastDial = new Map<number, { propertyId: string; since: string }>();
    const lookup = (step: LiveCallStep) => lastDial.get(step.n)!;
    const port: LivePort = {
      async dial(step) {
        assertIdentity();
        const propertyId = leads[step.target].propertyId;
        const since = new Date().toISOString();
        await page.goto(`${cfg.appUrl}/my-leads/call/${propertyId}`);
        // S5: right before the click, the phone the lead holds NOW must still be the pinned owned number for this target.
        const phoneNow = (await db.query<{ p: string | null }>("select c.phone_1 as p from public.properties pr join public.contacts c on c.id = pr.homeowner_contact_id where pr.id=$1", [propertyId])).rows[0]?.p ?? null;
        const pinProblems = pinnedPhoneProblems(phoneNow, step.target, loadPinnedHashes(), loadReportKey(process.env));
        if (pinProblems.length) throw new Error(`refusing to click Call: ${pinProblems.join(" | ")}`);
        const button = page.getByTestId(`call-button-${propertyId}`);
        await expect(button).toBeEnabled({ timeout: 30_000 });
        const before = (await db.query<{ n: number }>("select count(*)::int n from public.dialpad_call_intents where property_id=$1 and dispatch_authorized_at is not null", [propertyId])).rows[0]!.n;
        const clickedAtMs = Date.now();
        await button.click(); // a mutating click: never repeated
        lastDial.set(step.n, { propertyId, since });
        // The database is the judge of a refusal: no new authorized intent appeared.
        let after = before;
        for (let i = 0; i < 16 && after === before; i += 1) {
          await page.waitForTimeout(500);
          after = (await db.query<{ n: number }>("select count(*)::int n from public.dialpad_call_intents where property_id=$1 and dispatch_authorized_at is not null", [propertyId])).rows[0]!.n;
        }
        return after === before ? { refused: true, clickedAtMs, note: (await page.getByTestId("dial-status").first().innerText().catch(() => "no status shown")).slice(0, 160) } : { refused: false, clickedAtMs };
      },
      async lateDial(step) {
        const d = lookup(step);
        const n = (await db.query<{ n: number }>("select count(*)::int n from public.dialpad_call_intents where property_id=$1 and dispatch_authorized_at is not null and prepared_at >= $2::timestamptz", [d.propertyId, d.since])).rows[0]!.n;
        return n > 0;
      },
      recheck: async () => assertIdentity(),
      async awaitTerminal(step, timeoutMs) {
        const d = lookup(step);
        const until = Date.now() + timeoutMs;
        while (Date.now() < until) {
          if (port.killRequested()) return false;
          const e = await readEvidence(d.propertyId, d.since);
          if (e.terminalState) return true;
          await new Promise((r) => setTimeout(r, 3_000));
        }
        return false;
      },
      async evidence(step) {
        const d = lookup(step);
        return readEvidence(d.propertyId, d.since);
      },
      sleep: (ms) => new Promise((r) => setTimeout(r, ms)),
      killRequested: () => existsSync(killFile),
      log: (line) => { try { appendFileSync(logFile, `${new Date().toISOString()} ${line}\n`); } catch { /* the console below is the fallback */ } console.log(`[live] ${line}`); },
    };

    async function readEvidence(propertyId: string, since: string): Promise<LiveEvidence> {
      const intent = (await db.query<{ id: string; matched_provider_call_id: string | null }>(
        "select id, matched_provider_call_id from public.dialpad_call_intents where property_id=$1 and dispatch_authorized_at is not null and prepared_at >= $2::timestamptz order by prepared_at desc limit 1", [propertyId, since])).rows[0];
      if (!intent?.matched_provider_call_id) return { callId: null, terminalState: null, cause: null, attemptMatched: false };
      const ev = (await db.query<{ event_state: string }>("select event_state from public.dialpad_call_events where provider_call_id=$1 order by event_timestamp_ms desc limit 1", [intent.matched_provider_call_id])).rows[0];
      const attempt = await db.query("select 1 from public.call_activities c join public.acquisition_attempts a on a.call_activity_id=c.id where c.provider_call_id=$1 and a.property_id=$2", [intent.matched_provider_call_id, propertyId]);
      const terminal = ev && TERMINAL_EVENTS.includes(ev.event_state) ? ev.event_state : null;
      // terminal state and cause both come from the webhook's own event state; nothing is inferred.
      return { callId: intent.matched_provider_call_id, terminalState: terminal, cause: terminal, attemptMatched: (attempt.rowCount ?? 0) > 0 };
    }

    const results = await driveLiveLeg(plan, port);
    const summary = summarizeLive(results, plan);
    // Numbers are masked in everything written out.
    writeFileSync(path.join(outDir, "live-results.json"), JSON.stringify({ sha: cfg.sha, runId: cfg.runId, summary, results }, null, 2));
    expect(summary.ok, `live leg not fully verified: ${JSON.stringify(summary)} (see ${outDir}/live-results.json; unverified and not-driven steps are reported, never counted as passes)`).toBe(true);
  } finally {
    await db.end();
  }
});
