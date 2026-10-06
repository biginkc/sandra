import { appendFileSync, existsSync, mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { spawn } from "node:child_process";
import path from "node:path";

import { CRON_ROUTES, FaultState, runCron, sleep, TickDeadline, type Ctx } from "./actions";
import { approvedTestSms, type StressConfig } from "./config";
import { assertFreshDatabase, assertOnlyHarnessRows, asRep, asService, openDb, type Db } from "./db";
import { appBenignDenials, appEgressViolations, checkoutDirtyReason, proveAppUnderTest, type LogSnapshot } from "./app-proof";
import { egressChildEnv, proveInProcessDenial, readEgressViolations } from "./egress";
import { GateController } from "./gates";
import { assertStressLane, LaneRefusal } from "./guards";
import { killSwitch, snapshotEvidence, type KillReport } from "./kill-switch";
import { backdateDispatch, expireIntent, expireStripOverride, makeReminderDue, runStaleSweep, scheduleReminders, type LeverProof } from "./levers";
import { buildManifest, toNdjson, type Manifest, type Profile, type Tick } from "./manifest";
import { expectedOutcomes, pendingJarradObservations, safetyInvariants, type Check, type OracleInput } from "./oracle";
import { GateProxy } from "./proxy";
import { newRunSecrets, proofChildEnv, writeAppProof } from "./proof-guard";
import { reminderWindowOpenAt } from "./reminder-window";
import { loadReportKey, sha256, signEvidence } from "./signing";
import { decide, hashConfig, writeReport, type RunSummary } from "./report";
import { IMPLS, newRecord, type TickRecord } from "./scenarios";
import { StubServer } from "./stubs";
import { createAppointment } from "./actions";
import { prepareIntent, dispatchCall } from "./actions";
import { setupWorld, type World } from "./world";

export type RunOptions = {
  cfg: StressConfig;
  profile?: Profile;
  /** Remove tenant rows before the run (self-test reuses one stack). Requires the lane guards to have passed. */
  resetFirst?: boolean;
  /** Skip the final teardown (flags off, connection disabled). The kill switch always cleans up. */
  cleanup?: boolean;
  env?: NodeJS.ProcessEnv;
};

export type RunResult = { summary: RunSummary; dir: string; killed: KillReport | null; exitCode: number; /** The self-test credits a fault only if it actually fired. */ faultFired: boolean };

const log = (m: string) => console.log(`[stress ${new Date().toISOString().slice(11, 19)}] ${m}`);

export function artifactsDirFor(cfg: StressConfig, profile: Profile): string {
  const suffix = `${cfg.fault !== "none" ? `-fault-${cfg.fault}` : ""}${profile !== "full" ? `-${profile}` : ""}`;
  return path.resolve(cfg.artifactsRoot, `chaos-${cfg.seed}-${cfg.sha.slice(0, 12)}${suffix}`);
}

/** The server log lines (after `offset`) that mean an unexpected 5xx or an unhandled rejection. */
export function scanServerLog(file: string, offset: number, opts: { injectedOfflineFetchFailures?: number } = {}): string[] {
  if (!existsSync(file)) return [`server log ${file} not found`];
  // `offset` is a BYTE offset (statSync().size): slice the Buffer, not the decoded string (multibyte text before the offset shifts characters).
  const text = readFileSync(file).subarray(Math.min(offset, statSync(file).size)).toString("utf8");
  const bad: string[] = [];
  // Injected failure with an explicit, bounded expectation: each scripted offline gesture (browser `setOffline` during Send) makes Next's
  // client forward exactly one `[browser] unhandledRejection: TypeError: Failed to fetch` to the server log. Only that many are expected.
  let injectedLeft = opts.injectedOfflineFetchFailures ?? 0;
  for (const line of text.split("\n")) {
    if (/\s5\d\d in \d+/.test(line) || /unhandled(Rejection| rejection)/i.test(line) || /⨯ unhandled/i.test(line)) {
      if (injectedLeft > 0 && /^\[browser\].*unhandledRejection: TypeError: Failed to fetch\s*$/.test(line.trim())) { injectedLeft -= 1; continue; }
      bad.push(line.trim().slice(0, 240));
    }
  }
  return bad;
}

/**
 * Empties tenant tables like the e2e lanes do. `reset_tenant_tables()` re-inserts memberships and the designation
 * guard refuses while a member still has acquisitions_enabled, so each designation is cleared first through the
 * same guard marker the fixture uses. Disposable, loopback database only (the caller proved both).
 */
async function resetTenantData(db: Db): Promise<void> {
  const designated = await db.query<{ org_id: string; user_id: string }>("select org_id, user_id from public.memberships where acquisitions_enabled");
  for (const m of designated.rows) {
    await asService(db, async (c) => {
      await c.query("select set_config('my_leads.designation_update', format(':%s:%s', $1::text, $2::text), true)", [m.org_id, m.user_id]);
      await c.query("update public.memberships set acquisitions_enabled=false where org_id=$1 and user_id=$2", [m.org_id, m.user_id]);
      await c.query("select set_config('my_leads.designation_update', '', true)");
    });
  }
  // Dialpad evidence tables are append-only and keyed to auth.users; a prior run's binding would block this run's claim.
  await db.query("truncate table public.dialpad_member_bindings cascade");
  await db.query("select public.reset_tenant_tables()");
}

/** Demonstrates every time lever BEFORE the chaos sequence (a lever that does not move its decision fails the run). */
async function demonstrateLevers(ctx: Ctx, lead: { slot: number; propertyId: string; contactId: string; phoneE164: string } & Record<string, unknown>): Promise<LeverProof[]> {
  const proofs: LeverProof[] = [];
  const w = lead as never as Parameters<typeof prepareIntent>[1];
  const prove = async (lever: string, fn: () => Promise<string>) => {
    try {
      proofs.push({ lever, ok: true, detail: await fn() });
    } catch (e) {
      proofs.push({ lever, ok: false, detail: (e as Error).message });
    }
  };
  await prove("intent expiry (backdate dispatch + stale sweep, cutoff 30s)", async () => {
    const it = await prepareIntent(ctx, w);
    const d = await dispatchCall(ctx, w, it, { noProvider: true });
    if (d.status !== "authorized") throw new Error(`dispatch ${d.status}`);
    await backdateDispatch(ctx.db, it.intentId, 150);
    const n = await runStaleSweep(ctx.db, 30);
    const failed = (await ctx.db.query<{ failed_at: Date | null }>("select failed_at from public.dialpad_call_intents where id=$1", [it.intentId])).rows[0]?.failed_at;
    if (!failed || n < 1) throw new Error(`sweep marked ${n}, failed_at=${String(failed)}`);
    await expireIntent(ctx.db, it.intentId).catch(() => {}); // a failed-marker intent is no longer 'unmatched prepared'; expiry is demonstrated on a fresh one below
    return `stale sweep marked ${n} intent(s) failed`;
  });
  await prove("intent expiry (fixture backdating to status=expired)", async () => {
    const it = await prepareIntent(ctx, w);
    await dispatchCall(ctx, w, it, { noProvider: true });
    await expireIntent(ctx.db, it.intentId);
    const st = await asService(ctx.db, (c) => c.query<{ s: { state: string } }>("select public.fn_get_dialpad_call_status($1,$2,$3) as s", [ctx.cfg.orgId, ctx.world.repUserId, it.intentId]));
    if (st.rows[0]!.s.state !== "expired") throw new Error(`state ${st.rows[0]!.s.state}`);
    return "fn_get_dialpad_call_status -> expired";
  });
  await prove("reminder eligibility (backdate send_at/send_local_date)", async () => {
    const a = await createAppointment(ctx, w, { title: `${ctx.cfg.runTag} lever`, pick: "tomorrow", now: new Date() });
    if (!a.ok) throw new Error(`appointment ${a.code}`);
    await scheduleReminders(ctx.db, ctx.cfg.orgId);
    const n = await makeReminderDue(ctx.db, [a.taskId!]);
    if (n !== 1) throw new Error(`made ${n} reminder(s) due`);
    // Put the lever lead back: cancel the appointment so no reminder is sent and no open appointment remains.
    await asRep(ctx.db, ctx.world.repUserId, (c) => c.query("select public.fn_cancel_appointment($1)", [a.taskId]));
    await scheduleReminders(ctx.db, ctx.cfg.orgId);
    const left = (await ctx.db.query<{ n: number }>("select count(*)::int n from public.seller_appointment_reminders where task_id=$1 and status='pending'", [a.taskId])).rows[0]!.n;
    if (left !== 0) throw new Error("lever reminder still pending after cancel");
    return "reminder moved to due, then cancelled with its appointment";
  });
  await prove("strip midnight (expireStripOverride)", async () => {
    await asRep(ctx.db, ctx.world.repUserId, (c) => c.query("select public.fn_set_my_leads_strip_override($1,$2,$3,'call_today')", [ctx.cfg.orgId, ctx.world.repUserId, w.propertyId]));
    await expireStripOverride(ctx.db, w.propertyId);
    const r = await ctx.db.query<{ expired: boolean }>("select pinned_until < now() as expired from public.my_leads_strip_overrides where property_id=$1", [w.propertyId]);
    if (r.rows[0]?.expired !== true) throw new Error("override not expired");
    return "pinned_until moved into the past";
  });
  await prove("quiet hours (E2E_QUIET_HOURS_NOW)", async () => {
    const v = process.env.E2E_QUIET_HOURS_NOW;
    if (!v) throw new Error("E2E_QUIET_HOURS_NOW is not set in the harness environment; the app under test must have been started with it");
    return `pinned to ${v} (an env of the app under test; recorded, not changeable mid-run)`;
  });
  return proofs;
}

export async function runChaos(opts: RunOptions): Promise<RunResult> {
  const cfg = opts.cfg;
  const profile = opts.profile ?? "full";
  const env = opts.env ?? process.env;
  const t0 = Date.now();
  const dir = artifactsDirFor(cfg, profile);
  const setupErrors: string[] = [];
  let killed: KillReport | null = null;
  let db: Db | null = null;
  let world: World | null = null;
  let stub: StubServer | null = null;
  let proxy: GateProxy | null = null;

  // Guards run BEFORE any connection of any kind (no DB, no HTTP, no stub, no browser).
  assertStressLane(cfg, env);
  mkdirSync(dir, { recursive: true });
  for (const f of ["executed.ndjson", "invariants.jsonl", "ordering.jsonl", "stub.ndjson", "egress.jsonl", "app-proof.json", "REPORT.md", "REPORT.sig.json", "invariants.final.json", "config.json", "world.json", "schedule.ndjson", "browser-lane.log", "browser-results.jsonl", "KILL", "kill-switch.json", "test-org-dump.json"]) rmSync(path.join(dir, f), { force: true });
  const egressLog = path.join(dir, "egress.jsonl");
  proveInProcessDenial(egressLog);
  log(`lane guards passed; egress guard proven; artifacts ${dir}`);

  const manifest: Manifest = buildManifest(cfg.seed, cfg.runTag, { profile });
  writeFileSync(path.join(dir, "schedule.ndjson"), toNdjson(manifest));
  writeFileSync(path.join(dir, "config.json"), JSON.stringify({ sha: cfg.sha, seed: cfg.seed, profile, scope: cfg.scope, fault: cfg.fault, configHash: hashConfig(cfg), decisions: cfg.decisions, quietHours: env.E2E_QUIET_HOURS_NOW ?? null, scheduleHash: manifest.hash }, null, 2));

  db = openDb(cfg);
  const gates = new GateController(path.join(dir, "ordering.jsonl"));
  stub = new StubServer({ logFile: path.join(dir, "stub.ndjson"), gates });
  const records: TickRecord[] = [];
  const executedFile = path.join(dir, "executed.ndjson");
  const invariantsFile = path.join(dir, "invariants.jsonl");
  const appLog = env.STRESS_APP_LOG ?? "";
  const appLogOffset = appLog && existsSync(appLog) ? statSync(appLog).size : 0;
  let runStart = new Date();
  let levers: LeverProof[] = [];
  let invariantChecks: Check[] = [];
  let outcomeChecks: Check[] = [];
  let pending: string[] = [];
  let appGuardPid: number | null = null;
  let faultFiredFlag = false;
  let appEgressSnap: LogSnapshot | null = null;
  let appCwd: string | null = null;
  let runSecrets: { key: string; nonce: string } | null = null;
  let windowOpenAtStart = true;
  let faultFiredCheck: () => boolean = () => false;
  let browserExecuted = 0;
  let stopRequested: string | null = null;
  let ticker: NodeJS.Timeout | null = null;
  let oracleInput: OracleInput | null = null;
  let finishingInvariants = false;

  try {
    await assertOnlyHarnessRows(db); // BEFORE the reset, so a wipe of foreign data is never the first step
    if (opts.resetFirst) await resetTenantData(db);
    await assertFreshDatabase(db, cfg);
    await stub.start(cfg.stubPort);
    // T0: each stub receives one probe and the probe appears in its request log.
    for (const name of ["dialpad", "dropbox_sign"]) await fetch(`${stub.url}/__probe/${name}`);
    for (const name of ["dialpad", "dropbox_sign"]) if (!stub.records.some((r) => r.probe && r.key === name)) throw new LaneRefusal("STUB_PROBE_MISSING", `the ${name} stub did not log its probe`);
    if (cfg.scope === "full") {
      proxy = new GateProxy(new URL(cfg.appUrl), gates);
      await proxy.start();
      const probe = await fetch(`${proxy.url}/login`, { redirect: "manual" }).catch((e) => ({ status: 0, error: e }));
      if (!("status" in probe) || probe.status === 0) throw new LaneRefusal("PROXY_PROBE_FAILED", "the gate proxy could not reach the app under test");
    }

    // T0, before any provider-capable action: the app under test carries the guard, logs to its own file, and every provider is stub/test.
    if (cfg.stubPort <= 0) throw new LaneRefusal("STUB_PORT_REQUIRED", "STRESS_STUB_PORT must be a fixed port: the app under test is started with DROPBOX_SIGN_API_BASE_URL pointing at it.");
    const appProof = proveAppUnderTest({ appUrl: cfg.appUrl, appEgressLog: cfg.appEgressLog, stubUrl: stub.url, harnessSha: cfg.sha, supabaseUrl: cfg.supabaseUrl, dbUrl: cfg.dbUrl });
    appGuardPid = appProof.pid;
    appEgressSnap = appProof.snapshot;
    appCwd = appProof.cwd;
    // Run-bound proof for the browser lane: signed with a key that lives only in this process and the Playwright child's env.
    runSecrets = newRunSecrets();
    writeAppProof(dir, {
      runId: cfg.runId, runTag: cfg.runTag, nonce: runSecrets.nonce, sha: cfg.sha, appPid: appProof.pid, appListenerStartMs: appProof.startMs ?? 0,
      appEgressLog: cfg.appEgressLog, appEgressLogIno: appProof.snapshot.ino, appEgressLogSizeAtT0: appProof.snapshot.size,
      stubUrl: stub.url, proxyUrl: proxy?.url ?? "", appUrl: cfg.appUrl, proxyUpstream: proxy?.upstreamOrigin ?? new URL(cfg.appUrl).origin,
    }, runSecrets.key);
    log(`app under test proven: egress guard loaded in pid ${appGuardPid}, providers stub/test`);
    world = await setupWorld(db, cfg);
    const dbxMode = await db.query<{ test_mode: boolean }>("select test_mode from public.org_esign_integrations where org_id=$1", [cfg.orgId]);
    if (dbxMode.rowCount !== 1 || dbxMode.rows[0]!.test_mode !== true) throw new LaneRefusal("ESIGN_NOT_TEST_MODE", "the e-sign connection is not in Dropbox Sign test mode.");
    writeFileSync(path.join(dir, "world.json"), JSON.stringify({ orgId: world.orgId, repUserId: world.repUserId, connectionId: world.connectionId, templateId: world.templateId, leads: world.leads.map((l) => ({ slot: l.slot, propertyId: l.propertyId, contactId: l.contactId, phone: l.phoneE164, address: l.address })) }, null, 1));
    // Binding proof: the app under test and the database handle are ONE stack. A signed webhook for a number with no lead
    // is stored by the app; the row must appear through the harness's own database URL.
    const probeCall = `7${String(cfg.seed % 1e9).padStart(9, "0")}000`;
    const { sendCallEvents } = await import("./actions");
    const ctxProbe: Ctx = { cfg, db, world, stub, faults: new FaultState("none"), sleep };
    await sendCallEvents(ctxProbe, { ...world.leads[0]!, phoneE164: "+18165550199" }, { callId: probeCall, order: ["calling"], direction: "inbound" });
    const seen = await db.query("select 1 from public.dialpad_call_events where org_id=$1 and provider_call_id=$2", [cfg.orgId, probeCall]);
    if (seen.rowCount !== 1) throw new LaneRefusal("BINDING_PROOF_FAILED", "the app's webhook write did not appear in the harness database: app and database are not the same stack");
    const authUser = await db.query("select 1 from auth.users where id=$1", [world.repUserId]);
    if (authUser.rowCount !== 1) throw new LaneRefusal("BINDING_PROOF_FAILED", "the Supabase API URL and the database URL are not the same stack");
    log("four bindings proven (app, supabase api, database, cron target) and both stubs probed");

    const faults = new FaultState(cfg.fault);
    faultFiredCheck = () => faults.fired;
    const ctx: Ctx = { cfg, db, world, stub, faults, sleep };
    const spareLead = world.leads[world.leads.length - 1]!;
    levers = await demonstrateLevers(ctx, spareLead as never);
    for (const l of levers) log(`lever ${l.ok ? "ok" : "FAIL"}: ${l.lever} - ${l.detail}`);
    if (levers.some((l) => !l.ok)) throw new LaneRefusal("LEVER_NOT_DEMONSTRATED", levers.filter((l) => !l.ok).map((l) => `${l.lever}: ${l.detail}`).join("; "));

    runStart = new Date();
    windowOpenAtStart = reminderWindowOpenAt(runStart);
    oracleInput = { db, orgId: cfg.orgId, runTag: cfg.runTag, runStart, world, stub, schedule: manifest.ticks, records, browserDeferred: cfg.scope !== "full", get reminderWindowOpen() { return windowOpenAtStart && reminderWindowOpenAt(new Date()); } };
    const killFile = path.join(dir, "KILL");

    // Background: invariants every interval + a random sweep, kill file, watchdog state.
    ticker = setInterval(() => {
      if (finishingInvariants) return;
      void (async () => {
        if (existsSync(killFile)) stopRequested = `KILL file present: ${killFile}`;
        try {
          const checks = await safetyInvariants(oracleInput!);
          appendFileSync(invariantsFile, JSON.stringify({ at: new Date().toISOString(), checks: checks.map((c) => ({ id: c.id, ok: c.ok, violations: c.violations.slice(0, 5) })) }) + "\n");
          const bad = checks.find((c) => !c.ok);
          if (bad && !stopRequested) stopRequested = `invariant ${bad.id} (${bad.name}) violated mid-run`;
        } catch (e) {
          stopRequested = stopRequested ?? `invariant check failed to run: ${(e as Error).message}`;
        }
      })();
    }, cfg.invariantIntervalMs);

    // Execute the replay ticks in order.
    // Debug aid for iterating on the browser lane: skips the replay ticks. A run with it set can never be a PASS (setup error below).
    const skipReplay = env.STRESS_DEBUG_SKIP_REPLAY === "1";
    if (skipReplay) setupErrors.push("STRESS_DEBUG_SKIP_REPLAY=1: the replay lane was skipped (debug run, never a PASS)");
    const replayTicks = skipReplay ? [] : manifest.ticks.filter((t) => t.actor !== "browser");
    for (const tick of replayTicks) {
      if (stopRequested) break;
      const rec = await executeTick(ctx, tick, tick.leadSlot >= 0 ? world.leads[tick.leadSlot]! : null, cfg.tickDeadlineMs);
      records.push(rec);
      appendFileSync(executedFile, JSON.stringify(rec) + "\n");
      if (rec.error && /TICK_DEADLINE/.test(rec.error)) stopRequested = `tick ${tick.tick} overran its ${cfg.tickDeadlineMs}ms deadline`;
      if (rec.error) log(`tick ${tick.tick} ${tick.scenario} ERROR ${rec.error}`);
      else log(`tick ${tick.tick} ${tick.scenario}${tick.args.variant ? `/${String(tick.args.variant)}` : ""} ok (${rec.steps.length} steps)`);
    }

    // Browser lane (full scope): the scripted Playwright specs, run in root's desktop context.
    if (!stopRequested && cfg.scope === "full") {
      browserExecuted = await runBrowserLane(setupErrors, runSecrets, { cfg, dir, world, stub, proxy: proxy!, manifest, env, spec: "chaos-browser" });
      // Browser ticks are judged by the same oracle as replay ticks: merge their records in.
      for (const r of readBrowserResults(dir)) {
        if (r.tick <= 0) continue;
        const base = r.record ?? { ...newRecord(manifest.ticks.find((t) => t.tick === r.tick)!, null), finishedAt: new Date().toISOString() };
        records.push({ ...base, error: r.ok ? base.error : r.error ?? base.error ?? "browser tick failed" });
      }
    }

    if (!stopRequested) await drain(ctx, cfg);
    finishingInvariants = true;
    if (ticker) clearInterval(ticker);
    ticker = null;

    invariantChecks = await safetyInvariants(oracleInput);
    appendFileSync(invariantsFile, JSON.stringify({ at: new Date().toISOString(), final: true, checks: invariantChecks.map((c) => ({ id: c.id, ok: c.ok, violations: c.violations.slice(0, 5) })) }) + "\n");
    outcomeChecks = stopRequested ? [] : await expectedOutcomes(oracleInput);
    if (!stopRequested && cfg.scope === "full") {
      // Oracle 16 (rendered parity) runs after the drain, in the browser, against the settled rows.
      await runBrowserLane(setupErrors, runSecrets, { cfg, dir, world, stub, proxy: proxy!, manifest, env, spec: "rendered-parity" }).catch((e) => { setupErrors.push((e as Error).message); return 0; });
      const parity = readBrowserResults(dir).find((r) => r.tick === -16);
      outcomeChecks = outcomeChecks.map((c) => (c.id === 16 ? { ...c, deferred: undefined, ok: parity?.ok === true, violations: parity?.ok === true ? [] : [{ rule: "rendered_parity", error: parity?.error ?? "no result recorded" }] } : c));
    }
    pending = await pendingJarradObservations(oracleInput);
    if (stopRequested) setupErrors.push(stopRequested);
  } catch (e) {
    setupErrors.push(e instanceof LaneRefusal ? `${e.code}: ${e.message}` : `run aborted: ${(e as Error).message}`);
    if (!(e instanceof LaneRefusal) && env.STRESS_DEBUG === "1") console.error((e as Error).stack);
    log(`ABORT ${setupErrors[setupErrors.length - 1]}`);
  } finally {
    if (ticker) clearInterval(ticker);
  }

  // Egress and server-log verdicts.
  faultFiredFlag = faultFiredCheck();
  // Denials from the harness's own processes AND from the app server (its own log); any denial fails the run.
  // Build identity again at the end: Next hot-reloads edits and serves untracked files, so a change made after T0 is as bad as one made before.
  for (const g of gates.unfiredGates()) setupErrors.push(`gate ${g.id} (${g.stage}) was armed but never reached: the race it was meant to create did not happen`);
  const dirtyAtEnd = appCwd ? checkoutDirtyReason(appCwd) : null;
  if (dirtyAtEnd) setupErrors.push(`app checkout changed during the run: ${dirtyAtEnd}`);
  const benignDenials = appBenignDenials(cfg.appEgressLog, appEgressSnap);
  const egressApp = appEgressViolations(cfg.appEgressLog, appEgressSnap, appGuardPid);
  const egress = [...readEgressViolations(egressLog), ...egressApp.map((t) => ({ at: "", kind: "app", target: t, pid: 0 }))];
  const serverProblems: string[] = [];
  const offlineGestures = records.filter((r) => r.actor === "browser" && r.steps.some((st) => st.startsWith("provider sends while offline"))).length;
  if (appLog) for (const l of scanServerLog(appLog, appLogOffset, { injectedOfflineFetchFailures: offlineGestures })) serverProblems.push(`server log: ${l}`);
  else serverProblems.push("STRESS_APP_LOG not set: the server log cannot be scanned for 5xx/unhandled rejections (required)");

  const failedAny = setupErrors.length > 0 || [...invariantChecks, ...outcomeChecks].some((c) => !c.ok && !c.deferred) || egress.length > 0 || serverProblems.length > 0;
  if (failedAny && db && stub) {
    // Kill switch order is fixed: close gates, flags off, reconcile in-flight, snapshot, then clean up.
    killed = await killSwitch({ reason: setupErrors[0] ?? (egress.length ? "egress violation" : serverProblems[0] ?? "invariant/outcome miss"), cfg, db, world, stub, extraGates: proxy ? [] : [], artifactsDir: dir, cleanup: opts.cleanup ?? env.STRESS_CLEANUP !== "0" });
  } else if (db && world && stub) {
    await snapshotEvidence(db, cfg, path.join(dir, "test-org-dump.json"));
    if (opts.cleanup ?? env.STRESS_CLEANUP !== "0") {
      const { teardownWorld } = await import("./world");
      await teardownWorld(db, world).catch((e) => setupErrors.push(`teardown: ${(e as Error).message}`));
    }
  }

  const summary = decide({ cfg, manifest, records, invariantChecks, outcomeChecks, egressViolations: egress.length, reminderWindowOpen: windowOpenAtStart && reminderWindowOpenAt(new Date()), serverProblems, killed: failedAny ? killed : null, setupErrors, browserExecuted });
  writeFileSync(path.join(dir, "invariants.final.json"), JSON.stringify(summary.checks, null, 1));
  writeReport(dir, {
    cfg, manifest, summary, pending, appGuardPid, benignDenials, levers, killed,
    stubCounts: { dials: stub?.dials().length ?? 0, sends: stub?.sends().length ?? 0 },
    elapsedMs: Date.now() - t0,
    repro: `CHAOS_SEED=${cfg.seed} STRESS_PROFILE=${profile} STRESS_SCOPE=${cfg.scope} STRESS_FAULT=${cfg.fault} tsx e2e/stress/cli.ts run   # same seed + the recorded schedule.ndjson + a fresh stack`,
  });
  // Signed evidence for the live leg (only when a signing key outside the repo is configured; otherwise the report stays unsigned and the live leg refuses it).
  try {
    const key = loadReportKey(env);
    if (key) {
      const text = readFileSync(path.join(dir, "REPORT.md"), "utf8");
      writeFileSync(path.join(dir, "REPORT.sig.json"), JSON.stringify(signEvidence({ v: 1, kind: "stub_leg", runId: cfg.runId, sha: cfg.sha, at: new Date().toISOString(), subjectSha256: sha256(text), verdict: summary.verdict, profile, scope: cfg.scope, fault: cfg.fault, appGuardPid }, key), null, 1), { mode: 0o600 });
    }
  } catch (e) { log(`report not signed: ${(e as Error).message}`); }
  await proxy?.stop().catch(() => {});
  await stub?.stop().catch(() => {});
  await db?.end().catch(() => {});

  const exit = summary.verdict === "PASS" ? 0 : summary.verdict === "PARTIAL_PASS" ? (env.STRESS_ALLOW_PARTIAL === "1" ? 0 : 3) : 1;
  log(`${summary.verdict} (${summary.reasons.length} reason(s)); report ${path.join(dir, "REPORT.md")}`);
  return { summary, dir, killed, exitCode: exit, faultFired: faultFiredFlag };
}

async function executeTick(ctx: Ctx, tick: Tick, lead: World["leads"][number] | null, deadlineMs: number): Promise<TickRecord> {
  const rec = newRecord(tick, lead);
  try {
    if (tick.scenario === "noise_sweep") {
      const routes = (tick.args.crons as string[]) ?? [];
      for (const route of routes) {
        const r = await runCron(ctx, route);
        rec.steps.push(`${route}:${r.status}`);
        if (r.status >= 500) throw new Error(`cron ${route} returned ${r.status}: ${r.body.slice(0, 120)}`);
      }
    } else {
      let rejectDeadline: (e: Error) => void = () => {};
      const deadline = new Promise<never>((_, reject) => { rejectDeadline = reject; });
      const watchdog = new TickDeadline(deadlineMs, () => rejectDeadline(new Error("TICK_DEADLINE")));
      try {
        await Promise.race([IMPLS[tick.scenario]({ ...ctx, tickDeadline: watchdog }, tick, lead!, rec), deadline]);
      } finally {
        watchdog.clear();
      }
    }
  } catch (e) {
    rec.error = (e as Error).message;
  }
  rec.finishedAt = new Date().toISOString();
  return rec;
}

/** Bounded drain: all sweeps run until two consecutive passes leave state unchanged (max cfg.drainMaxMs). */
async function drain(ctx: Ctx, cfg: StressConfig): Promise<void> {
  const fingerprint = async () => {
    const r = await ctx.db.query<{ f: string }>(
      `select concat_ws('|',
        (select count(*) from public.dialpad_call_events), (select count(*) from public.acquisition_attempts), (select count(*) from public.tasks),
        (select count(*) from public.messages), (select coalesce(string_agg(status,''),'') from (select status from public.seller_appointment_reminders order by id) x),
        (select coalesce(string_agg(state,''),'') from (select state from public.acquisition_offer_projections order by id) y),
        (select count(*) from public.acquisition_offers), (select count(*) from public.dialpad_call_intents where failed_at is not null)) as f`,
    );
    return r.rows[0]!.f;
  };
  const started = Date.now();
  let prev = await fingerprint();
  let stable = 0;
  while (Date.now() - started < cfg.drainMaxMs) {
    for (const route of CRON_ROUTES) await runCron(ctx, route);
    await sleep(500);
    const now = await fingerprint();
    stable = now === prev ? stable + 1 : 0;
    prev = now;
    if (stable >= 2) return;
  }
  throw new Error(`drain did not settle within ${cfg.drainMaxMs}ms`);
}

// ------------------------------------------------------------------------------------------------
// Browser lane

type BrowserResult = { tick: number; ok: boolean; error?: string; record?: TickRecord | null };
export function readBrowserResults(dir: string): BrowserResult[] {
  const f = path.join(dir, "browser-results.jsonl");
  if (!existsSync(f)) return [];
  return readFileSync(f, "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l) as BrowserResult);
}

async function runBrowserLane(setupErrors: string[], secrets: { key: string; nonce: string } | null, a: { cfg: StressConfig; dir: string; world: World; stub: StubServer; proxy: GateProxy; manifest: Manifest; env: NodeJS.ProcessEnv; spec: "chaos-browser" | "rendered-parity" }): Promise<number> {
  if (!a.cfg.decisions.rootBrowserContextProvided) throw new LaneRefusal("NO_BROWSER_CONTEXT", "STRESS_ROOT_BROWSER_CONTEXT=1 is required for the browser lane (root provides a browser-capable context; codex exec cannot launch Chromium).");
  // Control API for the browser-side process: the stub server's /__ctl routes.
  const env = {
    ...a.env,
    ...egressChildEnv(path.join(a.dir, "egress.jsonl")),
    STRESS_RUN_DIR: a.dir,
    STRESS_RUN_ID: a.cfg.runId,
    STRESS_APP_URL: a.cfg.appUrl,
    ...(secrets ? proofChildEnv(secrets) : {}),
    STRESS_PROXY_URL: a.proxy.url,
    STRESS_STUB_URL: a.stub.url,
    STRESS_REP_EMAIL: a.world.repEmail,
    STRESS_REP_PASSWORD: a.world.repPassword,
    STRESS_SCHEDULE_FILE: path.join(a.dir, "schedule.ndjson"),
    STRESS_WORLD_FILE: path.join(a.dir, "world.json"),
    STRESS_RUN_TAG: a.cfg.runTag,
  };
  const code: number = await new Promise((resolve) => {
    const grep = a.spec === "chaos-browser" && a.env.STRESS_DEBUG_BROWSER_GREP ? ["--grep", a.env.STRESS_DEBUG_BROWSER_GREP] : []; // debug aid: a subset of ticks makes the run a FAIL by "executed N/M"
    const child = spawn("npx", ["playwright", "test", "-c", "playwright.stress.config.ts", `e2e/stress/browser/${a.spec}.spec.ts`, ...grep], { env, stdio: "inherit", shell: false });
    child.on("close", (c) => resolve(c ?? 1));
    child.on("error", () => resolve(1));
  });
  const results = readBrowserResults(a.dir);
  const problem = browserLaneProblem(a.spec, code);
  if (problem) setupErrors.push(problem);
  return results.filter((r) => r.ok && r.tick > 0).length;
}

/**
 * ANY nonzero Playwright exit fails the run. Each spec records its success before the fixtures tear down, so a teardown failure, a worker crash
 * after the last recorded tick or a timeout in afterAll would otherwise leave "all ticks ok" next to a failed lane.
 */
export function browserLaneProblem(spec: string, exitCode: number): string | null {
  return exitCode === 0 ? null : `browser lane (${spec}) exited ${exitCode}: a nonzero Playwright exit fails the run even when every tick recorded success`;
}

export { approvedTestSms };
