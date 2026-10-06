import { execFileSync } from "node:child_process";
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";

import { LaneRefusal } from "./guards";

/**
 * T0 proof about the APP UNDER TEST (the one process that talks to providers). The harness does not start the Next server, so it proves
 * what the server says about itself: the egress guard, preloaded into the server, writes a `guard_loaded` line at load with its pid, its
 * provider environment (runtime truth: no `ps` parsing), the Dialpad redirect it installed and the git checkout it runs from. The engine
 * finds the process listening on the app port and requires a line from THAT pid:
 *  - it logs to STRESS_APP_EGRESS_LOG and runs from the same commit as the harness (git HEAD), with no tracked changes;
 *  - every provider is stub/test: MESSAGING_PROVIDER=mock, Dropbox Sign at the harness stub, the Dialpad API diverted to the harness stub
 *    (the stub server then holds the receipts), no hosted-runtime markers.
 * Any gap refuses the run before the first provider-capable action.
 */

export type GuardLine = {
  at?: string;
  cwd?: string;
  kind?: string;
  pid?: number;
  log?: string;
  sha?: string | null;
  dirty?: boolean;
  redirect?: string | null;
  spawnGuard?: boolean;
  forbiddenPresent?: string[];
  unexpectedEnv?: string[];
  env?: Record<string, string | null>;
};

export function findListenerPid(port: number): number | null {
  try {
    const out = execFileSync("lsof", ["-nP", `-iTCP:${port}`, "-sTCP:LISTEN", "-t"], { encoding: "utf8" }).trim().split("\n").filter(Boolean);
    return out.length ? Number(out[0]) : null;
  } catch {
    return null;
  }
}

export function readProcessUid(pid: number): number | null {
  try {
    const n = Number(execFileSync("ps", ["-o", "uid=", "-p", String(pid)], { encoding: "utf8" }).trim());
    return Number.isInteger(n) ? n : null;
  } catch {
    return null;
  }
}

export type AppProofInput = {
  listenerPid: number | null;
  /** The uid the app listener runs as and the uid the harness runs as. */
  listenerUid: number | null;
  harnessUid: number;
  appEgressLog: string;
  logLines: string[];
  stubUrl: string;
  harnessSha: string;
  /** `.env*` files in the app's checkout that `next dev` would load (they can set provider env AFTER the guard announced it). */
  envFiles?: string[];
  /** When the listener process started (ms epoch), from `ps -o lstart`. A guard line older than this is a stale one from an earlier process. */
  listenerStartMs?: number | null;
  /** The harness's own Supabase API URL and database URL: the app must be on the SAME loopback stack. */
  supabaseUrl?: string;
  dbUrl?: string;
};

/** Any `.env*` file other than `.env.example` (Next loads .env, .env.local, .env.development*, and the .env.production and .env.test families in other modes): refuse them all. */
export function envFilesIn(cwd: string): string[] {
  try { return readdirSync(cwd).filter((f) => /^\.env/.test(f) && f !== ".env.example").sort(); } catch { return []; }
}

export function readProcessStartMs(pid: number): number | null {
  try {
    const t = Date.parse(execFileSync("ps", ["-o", "lstart=", "-p", String(pid)], { encoding: "utf8", env: { ...process.env, LC_ALL: "C" } }).trim());
    return Number.isFinite(t) ? t : null;
  } catch {
    return null;
  }
}

/** Tracked changes or untracked files (excluding build caches) in a checkout; null when clean. */
export function checkoutDirtyReason(cwd: string): string | null {
  try {
    const out = execFileSync("git", ["status", "--porcelain", "--", ".", ":!.swc", ":!.next", ":!node_modules", ":!artifacts"], { cwd, encoding: "utf8" }).trim();
    return out ? `uncommitted or untracked files in the app checkout: ${out.split("\n").slice(0, 5).join("; ")}` : null;
  } catch (e) {
    return `could not read the app checkout state (${(e as Error).message.split("\n")[0]})`;
  }
}

export function guardLineFor(lines: string[], pid: number): GuardLine | null {
  let found: GuardLine | null = null;
  for (const l of lines) {
    try { const j = JSON.parse(l) as GuardLine; if (j.kind === "guard_loaded" && j.pid === pid) found = j; } catch { /* not a line */ }
  }
  return found;
}

/** Problems found (empty = proven). Pure, so every branch is unit-tested. */
export function appProofProblems(i: AppProofInput): string[] {
  const p: string[] = [];
  if (!i.appEgressLog) p.push("STRESS_APP_EGRESS_LOG is not set (an absolute path; the app must be started with STRESS_EGRESS_LOG pointing at it)");
  if (i.listenerPid == null) { p.push("no process is listening on the app port"); return p; }
  if (i.listenerUid == null || i.listenerUid !== i.harnessUid) p.push(`the app listener runs as uid ${i.listenerUid ?? "unknown"}, the harness as uid ${i.harnessUid}: the app must run as the harness user`);
  const g = guardLineFor(i.logLines, i.listenerPid);
  if (!g) { p.push(`no guard_loaded line from pid ${i.listenerPid} in the app egress log: the guard did not run inside the app`); return p; }
  if (!i.appEgressLog || g.log !== i.appEgressLog) p.push(`the app's guard logs to ${g.log ?? "unknown"}, not STRESS_APP_EGRESS_LOG (${i.appEgressLog || "unset"})`);
  if (!g.sha || g.sha !== i.harnessSha) p.push(`the app runs commit ${g.sha ?? "unknown"}, the harness is at ${i.harnessSha}: the tested app must be this checkout's build`);
  if (g.spawnGuard !== true) p.push("the app does not run the child-process guard (start it with STRESS_GUARD_SPAWN=1): a non-Node child would bypass the in-process egress hooks");
  if (g.dirty !== false) p.push("the app's checkout has uncommitted tracked changes (or its state is unknown)");
  if (i.envFiles?.length) p.push(`the app checkout has ${i.envFiles.join(", ")}: Next loads them after the guard announced the environment, so they could set provider variables the proof never saw; remove them for the run`);
  if (g.at === undefined || i.listenerStartMs == null || Date.parse(g.at) < i.listenerStartMs - 2000) p.push(`the guard_loaded line (${g.at ?? "no time"}) is older than the listener process (started ${i.listenerStartMs == null ? "unknown" : new Date(i.listenerStartMs).toISOString()}): it is a stale line, not this process's`);
  const e = g.env ?? {};
  if (g.redirect !== i.stubUrl) p.push(`the app's Dialpad API is not diverted to the harness stub (redirect "${g.redirect ?? "none"}", expected ${i.stubUrl}); without it the dial receipts are not observable`);
  if (e.DIALPAD_DIAL_PROVIDER === "stub") p.push('DIALPAD_DIAL_PROVIDER=stub keeps dials in process where the harness cannot read the receipts; leave it unset (the diverted live dialer is used)');
  if (e.MESSAGING_PROVIDER !== "mock") p.push(`MESSAGING_PROVIDER is "${e.MESSAGING_PROVIDER ?? "unset"}", must be "mock"`);
  const dbx = e.DROPBOX_SIGN_API_BASE_URL ?? "";
  if (!dbx.startsWith(`${i.stubUrl}/dropbox-sign`)) p.push(`DROPBOX_SIGN_API_BASE_URL is "${dbx || "unset"}", must point at the harness stub (${i.stubUrl}/dropbox-sign/...)`);
  if (g.forbiddenPresent === undefined) p.push("the guard line does not report which provider credentials / proxy variables are present (old guard?)");
  else if (g.forbiddenPresent.length) p.push(`the app process environment holds provider credentials or proxy overrides that must be absent: ${g.forbiddenPresent.join(", ")}`);
  if (g.unexpectedEnv === undefined) p.push("the guard line does not report unexpected environment names (old guard?)");
  else if (g.unexpectedEnv.length) p.push(`the app process environment holds variables outside the allowlist that look like credentials, URLs or provider settings (start it with a clean environment): ${g.unexpectedEnv.join(", ")}`);
  const hp = (u: string) => { try { const x = new URL(u.replace(/^postgres(ql)?:/, "http:")); return `${x.hostname.replace(/^\[|\]$/g, "")}:${x.port || "80"}`; } catch { return null; } };
  if (i.supabaseUrl) {
    const appApi = e.NEXT_PUBLIC_SUPABASE_URL ?? e.SUPABASE_URL ?? null;
    if (!appApi || hp(appApi) !== hp(i.supabaseUrl)) p.push(`the app's Supabase URL (${appApi ?? "unset"}) is not the harness's loopback stack (${i.supabaseUrl})`);
  }
  if (i.dbUrl) for (const k of ["DATABASE_URL", "POSTGRES_URL"]) if (e[k] && hp(e[k]!) !== hp(i.dbUrl)) p.push(`the app's ${k} is not the harness's database (${hp(i.dbUrl)})`);
  for (const k of ["VERCEL_ENV", "VERCEL"]) if (e[k]) p.push(`${k} is set on the app process (hosted runtime marker)`);
  return p;
}

export function readLines(file: string): string[] {
  return existsSync(file) ? readFileSync(file, "utf8").split("\n").filter(Boolean) : [];
}

export type LogSnapshot = { ino: number; size: number };
export function snapshotLog(file: string): LogSnapshot | null {
  if (!existsSync(file)) return null;
  const st = statSync(file);
  return { ino: st.ino, size: st.size };
}

export type LiveAppFacts = { pid: number | null; uid: number | null; startMs: number | null; lines: string[]; envFiles: string[] };

/** What is true of the app right now: who listens on its port, as which uid, since when, what its egress log says, which .env files its checkout holds. */
export function collectLiveAppFacts(appUrl: string, appEgressLog: string): LiveAppFacts {
  const pid = findListenerPid(Number(new URL(appUrl).port || 80));
  const lines = readLines(appEgressLog);
  const g = pid ? guardLineFor(lines, pid) : null;
  return { pid, uid: pid ? readProcessUid(pid) : null, startMs: pid ? readProcessStartMs(pid) : null, lines, envFiles: g?.cwd ? envFilesIn(g.cwd) : [] };
}

/** The live check, used by the engine at T0. */
export function proveAppUnderTest(args: { appUrl: string; appEgressLog: string; stubUrl: string; harnessSha: string; supabaseUrl?: string; dbUrl?: string }): { pid: number; snapshot: LogSnapshot; cwd: string | null; startMs: number | null } {
  const port = Number(new URL(args.appUrl).port || 80);
  const pid = findListenerPid(port);
  const facts = collectLiveAppFacts(args.appUrl, args.appEgressLog);
  const g = pid ? guardLineFor(facts.lines, pid) : null;
  const problems = appProofProblems({
    listenerPid: facts.pid, listenerUid: facts.uid, harnessUid: process.getuid?.() ?? -1,
    appEgressLog: args.appEgressLog, logLines: facts.lines, stubUrl: args.stubUrl, harnessSha: args.harnessSha,
    envFiles: facts.envFiles, listenerStartMs: facts.startMs, supabaseUrl: args.supabaseUrl, dbUrl: args.dbUrl,
  });
  const snapshot = snapshotLog(args.appEgressLog);
  if (!snapshot) problems.push("the app egress log does not exist");
  if (problems.length) throw new LaneRefusal("APP_UNDER_TEST_NOT_PROVEN", problems.join(" | "));
  return { pid: pid!, snapshot: snapshot!, cwd: g?.cwd ?? null, startMs: facts.startMs };
}

/**
 * The one known-benign egress attempt of the Next dev server itself: its update indicator fetches the npm dist-tags (`hot-reloader-shared-utils.js`;
 * failures are ignored by Next and the guard denies it before bytes leave). Exactly this host, only tls/dns/connect, and it is reported, not hidden.
 * No provider host is ever on this list.
 */
export const BENIGN_DEV_EGRESS_HOSTS: readonly string[] = ["registry.npmjs.org"];
export const isBenignDevEgress = (kind: string | undefined, target: string | undefined) => ["tls", "dns", "connect"].includes(kind ?? "") && BENIGN_DEV_EGRESS_HOSTS.includes(target ?? "");

/** The tolerated (benign dev-server) denials since T0, counted so the report shows them instead of hiding them. */
export function appBenignDenials(file: string, snapshot: LogSnapshot | null): number {
  if (!snapshot || !existsSync(file)) return 0;
  let n = 0;
  for (const l of readFileSync(file, "utf8").slice(snapshot.size).split("\n").filter(Boolean)) {
    try { const j = JSON.parse(l) as { probe?: boolean; kind?: string; target?: string }; if (!j.probe && isBenignDevEgress(j.kind, j.target)) n += 1; } catch { /* counted as a violation elsewhere */ }
  }
  return n;
}

/**
 * The app's denials since T0, failing closed on the evidence itself: a missing, replaced (new inode), truncated (smaller than at T0) log, or one
 * that lost the app's own guard_loaded line, is a violation: deleting or rotating the log must not erase a denial and keep "guard proven".
 */
export function appEgressViolations(file: string, snapshot: LogSnapshot | null, guardPid: number | null = null): string[] {
  const out: string[] = [];
  if (!snapshot) return ["app egress log was never snapshotted at T0"];
  if (!existsSync(file)) return ["app egress log is missing"];
  const st = statSync(file);
  if (st.ino !== snapshot.ino) out.push("app egress log was replaced (inode changed)");
  if (st.size < snapshot.size) { out.push(`app egress log was truncated (${st.size} < ${snapshot.size} bytes at T0)`); return out; }
  const all = readFileSync(file, "utf8");
  if (guardPid != null && !guardLineFor(all.split("\n").filter(Boolean), guardPid)) out.push("the app's guard_loaded line is gone from the log");
  for (const l of all.slice(snapshot.size).split("\n").filter(Boolean)) {
    try { const j = JSON.parse(l) as { probe?: boolean; kind?: string; target?: string }; if (!j.probe && j.kind !== "guard_loaded" && !isBenignDevEgress(j.kind, j.target)) out.push(`${j.kind}:${j.target}`); } catch { out.push(`unparseable app egress line: ${l.slice(0, 80)}`); }
  }
  return out;
}
