import { execFileSync } from "node:child_process";
import { existsSync, readFileSync, statSync } from "node:fs";

import { GUARD_PATH } from "./egress";
import { LaneRefusal } from "./guards";

/**
 * T0 proof about the APP UNDER TEST (the one process that talks to providers). The harness does not start the Next server, so it
 * proves the server's own environment instead of trusting a README:
 *  - the process listening on the app port carries the egress guard (`NODE_OPTIONS --require <guard>`), logs to STRESS_APP_EGRESS_LOG, and
 *    that log holds a `guard_loaded` line written by THAT pid (the guard really ran inside it);
 *  - every provider is stub/test: DIALPAD_DIAL_PROVIDER=stub (unset falls back to LIVE in the app), MESSAGING_PROVIDER=mock, Dropbox Sign
 *    pointed at the harness stub; no hosted runtime markers.
 * Any gap refuses the run before the first provider-capable action.
 */

export type AppEnv = Record<string, string>;

/** `ps eww` prints `KEY=value KEY2=value2`, values unquoted and possibly containing spaces: split on `<space>UPPER_KEY=`. */
export function parsePsEnv(text: string): AppEnv {
  const out: AppEnv = {};
  const re = /(?:^|\s)([A-Za-z_][A-Za-z0-9_]*)=/g;
  const marks: Array<{ key: string; start: number; valueAt: number }> = [];
  for (let m = re.exec(text); m; m = re.exec(text)) marks.push({ key: m[1]!, start: m.index, valueAt: m.index + m[0].length });
  marks.forEach((mk, i) => { out[mk.key] = text.slice(mk.valueAt, i + 1 < marks.length ? marks[i + 1]!.start : text.length).trim(); });
  return out;
}

export function findListenerPid(port: number): number | null {
  try {
    const out = execFileSync("lsof", ["-nP", `-iTCP:${port}`, "-sTCP:LISTEN", "-t"], { encoding: "utf8" }).trim().split("\n").filter(Boolean);
    return out.length ? Number(out[0]) : null;
  } catch {
    return null;
  }
}

/**
 * `next-server` rewrites its process title, which erases the environment `ps` can show for it. Its launcher (`next dev` / `npm`) still shows
 * it, and the child inherited exactly that environment, so the nearest ancestor that exposes `NODE_OPTIONS` stands in. The guard itself is
 * proven separately and exactly: a `guard_loaded` line written by the listener's OWN pid.
 */
export function readAppEnv(pid: number): AppEnv | null {
  let cur: number | null = pid;
  for (let depth = 0; cur && depth < 5; depth += 1) {
    const env = readProcessEnv(cur);
    if (env && "NODE_OPTIONS" in env) return env;
    try { cur = Number(execFileSync("ps", ["-o", "ppid=", "-p", String(cur)], { encoding: "utf8" }).trim()) || null; } catch { cur = null; }
  }
  return null;
}

export function readProcessEnv(pid: number): AppEnv | null {
  try {
    if (existsSync(`/proc/${pid}/environ`)) {
      const env: AppEnv = {};
      for (const kv of readFileSync(`/proc/${pid}/environ`, "utf8").split("\0")) { const i = kv.indexOf("="); if (i > 0) env[kv.slice(0, i)] = kv.slice(i + 1); }
      return env;
    }
    return parsePsEnv(execFileSync("ps", ["eww", "-o", "command=", "-p", String(pid)], { encoding: "utf8" }));
  } catch {
    return null;
  }
}

export type AppProofInput = {
  env: AppEnv | null;
  listenerPid: number | null;
  appEgressLog: string;
  /** Lines of the app's egress log. */
  logLines: string[];
  stubUrl: string;
  guardPath?: string;
};

/** Problems found (empty = proven). Pure, so every branch is unit-tested. */
export function appProofProblems(i: AppProofInput): string[] {
  const p: string[] = [];
  if (!i.appEgressLog) p.push("STRESS_APP_EGRESS_LOG is not set (an absolute path; the app must be started with STRESS_EGRESS_LOG pointing at it)");
  if (i.listenerPid == null) { p.push("no process is listening on the app port"); return p; }
  if (!i.env) { p.push(`the environment of the app process (pid ${i.listenerPid}) could not be read`); return p; }
  const e = i.env;
  const guard = i.guardPath ?? GUARD_PATH;
  if (!(e.NODE_OPTIONS ?? "").includes(guard)) p.push(`the app process does not carry the egress guard (NODE_OPTIONS lacks ${guard})`);
  if (!i.appEgressLog || e.STRESS_EGRESS_LOG !== i.appEgressLog) p.push(`the app's STRESS_EGRESS_LOG (${e.STRESS_EGRESS_LOG ?? "unset"}) is not STRESS_APP_EGRESS_LOG (${i.appEgressLog || "unset"})`);
  const loaded = i.logLines.some((l) => { try { const j = JSON.parse(l) as { kind?: string; pid?: number }; return j.kind === "guard_loaded" && j.pid === i.listenerPid; } catch { return false; } });
  if (!loaded) p.push(`no guard_loaded line from pid ${i.listenerPid} in the app egress log: the guard did not run inside the app`);
  if (e.DIALPAD_DIAL_PROVIDER !== "stub") p.push(`DIALPAD_DIAL_PROVIDER is "${e.DIALPAD_DIAL_PROVIDER ?? "unset"}", must be "stub" (unset falls back to the LIVE Dialpad API)`);
  if (e.MESSAGING_PROVIDER !== "mock") p.push(`MESSAGING_PROVIDER is "${e.MESSAGING_PROVIDER ?? "unset"}", must be "mock"`);
  const dbx = e.DROPBOX_SIGN_API_BASE_URL ?? "";
  if (!dbx.startsWith(`${i.stubUrl}/dropbox-sign`)) p.push(`DROPBOX_SIGN_API_BASE_URL is "${dbx || "unset"}", must point at the harness stub (${i.stubUrl}/dropbox-sign/...)`);
  for (const k of ["VERCEL_ENV", "VERCEL"]) if (e[k]) p.push(`${k} is set on the app process (hosted runtime marker)`);
  return p;
}

export function readLines(file: string): string[] {
  return existsSync(file) ? readFileSync(file, "utf8").split("\n").filter(Boolean) : [];
}

/** The live check, used by the engine at T0. */
export function proveAppUnderTest(args: { appUrl: string; appEgressLog: string; stubUrl: string }): { pid: number } {
  const port = Number(new URL(args.appUrl).port || 80);
  const pid = findListenerPid(port);
  const problems = appProofProblems({ env: pid ? readAppEnv(pid) : null, listenerPid: pid, appEgressLog: args.appEgressLog, logLines: readLines(args.appEgressLog), stubUrl: args.stubUrl });
  if (problems.length) throw new LaneRefusal("APP_UNDER_TEST_NOT_PROVEN", problems.join(" | "));
  return { pid: pid! };
}

/** Non-probe denials the APP wrote after `offset` bytes (the position at T0). Any entry fails the run. */
export function appEgressViolations(file: string, offset: number): string[] {
  if (!existsSync(file)) return [];
  const text = readFileSync(file, "utf8").slice(Math.min(offset, statSync(file).size));
  const out: string[] = [];
  for (const l of text.split("\n").filter(Boolean)) {
    try { const j = JSON.parse(l) as { probe?: boolean; kind?: string; target?: string }; if (!j.probe && j.kind !== "guard_loaded") out.push(`${j.kind}:${j.target}`); } catch { out.push(`unparseable app egress line: ${l.slice(0, 80)}`); }
  }
  return out;
}
