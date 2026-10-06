/**
 * Egress denial for the stubbed leg, in-process layer. Preload with:
 *   NODE_OPTIONS="--require <abs path>/e2e/stress/egress-guard.cjs"
 * into EVERY process of the run (harness, Next server, Playwright workers). It FAILS CLOSED: any
 * connection attempt whose target is not loopback throws EGRESS_DENIED and is appended to
 * $STRESS_EGRESS_LOG (default egress.jsonl) BEFORE any bytes leave. The run fails if that log is
 * non-empty (probes excluded). This is the inner ring; the OS-level pf allowlist (egress-pf.conf) is
 * the outer ring and is verified separately when STRESS_REQUIRE_OS_EGRESS=1.
 */
"use strict";
/* eslint-disable @typescript-eslint/no-require-imports -- a CommonJS preload (NODE_OPTIONS --require) cannot use import */
const net = require("node:net");
const dns = require("node:dns");
const fs = require("node:fs");
const tls = require("node:tls");

const LOG = process.env.STRESS_EGRESS_LOG || "egress.jsonl";
const LOOPBACK = new Set(["127.0.0.1", "localhost", "::1", "[::1]", "0.0.0.0", ""]);
const isLoopbackHost = (h) => {
  if (h == null) return true;
  const s = String(h).toLowerCase();
  if (LOOPBACK.has(s)) return true;
  if (/^127\.\d+\.\d+\.\d+$/.test(s)) return true;
  if (s === "::ffff:127.0.0.1") return true;
  return false;
};
function deny(kind, target, probe) {
  const line = JSON.stringify({ at: new Date().toISOString(), pid: process.pid, kind, target: String(target), probe: !!probe });
  try { fs.appendFileSync(LOG, line + "\n"); } catch { /* the throw below is the control */ }
  const err = new Error("EGRESS_DENIED: " + kind + " to " + target);
  err.code = "EGRESS_DENIED";
  throw err;
}

// Dialpad seam from the harness side (no src change): with STRESS_DIALPAD_STUB_URL (loopback only) set, the app's own live dialer, which POSTs to the
// Dialpad API origin, is diverted to the harness stub server. The stub then holds the receipt (destination + intent key) the oracle checks. Any
// other URL is untouched, and anything non-loopback is still denied below.
const DIALPAD_ORIGIN = "https://dialpad.com"; // DIALPAD_API_ORIGIN in src/lib/dialpad-cti/directory.ts
let dialpadRedirect = null;
// STRESS_GUARD_MODE=announce: ONLY write the guard_loaded line (build identity: commit and cleanliness). No denial, no redirect. For the live-leg app,
// which must reach real providers but whose build identity must still be bound to the harness checkout.
const ANNOUNCE_ONLY = process.env.STRESS_GUARD_MODE === "announce";
if (!ANNOUNCE_ONLY) {
  const raw = process.env.STRESS_DIALPAD_STUB_URL || "";
  try {
    const u = new URL(raw);
    if (u.protocol === "http:" && isLoopbackHost(u.hostname) && typeof globalThis.fetch === "function") {
      dialpadRedirect = u.origin;
      const origFetch = globalThis.fetch;
      globalThis.fetch = function patchedFetch(input, init) {
        const url = typeof input === "string" ? input : input instanceof URL ? input.href : input && input.url;
        if (typeof url === "string" && url.startsWith(DIALPAD_ORIGIN + "/")) return origFetch(dialpadRedirect + "/dialpad" + url.slice(DIALPAD_ORIGIN.length), init);
        return origFetch(input, init);
      };
    }
  } catch { /* no redirect configured */ }
}

// Announce: the harness proves the guard ran inside THIS pid, and what that pid is (runtime truth, no `ps` parsing): its provider environment,
// the redirect, the checkout it runs from. `probe: true` marks it as not a violation.
function git(args) {
  try { return require("node:child_process").execFileSync("git", args, { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"], cwd: process.cwd() }).trim(); } catch { return null; }
}
try {
  const e = process.env;
  const announce = {
    at: new Date().toISOString(), pid: process.pid, kind: "guard_loaded", target: "", probe: true, log: LOG, cwd: process.cwd(),
    sha: git(["rev-parse", "HEAD"]), dirty: git(["status", "--porcelain", "--", ".", ":!.swc", ":!.next", ":!node_modules", ":!artifacts"]) !== "", // tracked changes AND untracked files (Next serves and hot-reloads both)
    redirect: dialpadRedirect,
    env: { DIALPAD_DIAL_PROVIDER: e.DIALPAD_DIAL_PROVIDER ?? null, MESSAGING_PROVIDER: e.MESSAGING_PROVIDER ?? null, DROPBOX_SIGN_API_BASE_URL: e.DROPBOX_SIGN_API_BASE_URL ?? null, VERCEL_ENV: e.VERCEL_ENV ?? null, VERCEL: e.VERCEL ?? null, NODE_OPTIONS: e.NODE_OPTIONS ?? null },
  };
  fs.appendFileSync(LOG, JSON.stringify(announce) + "\n");
} catch { /* no log, no proof: the engine refuses */ }

if (ANNOUNCE_ONLY) { module.exports = { isLoopbackHost, LOG }; return; }

const origConnect = net.Socket.prototype.connect;
net.Socket.prototype.connect = function patchedConnect(...args) {
  // net.connect() hands Socket#connect a pre-normalized array [options, cb].
  const a = Array.isArray(args[0]) ? args[0][0] : args[0];
  let host;
  let isIpc = false;
  if (a && typeof a === "object" && !Array.isArray(a)) {
    if (a.path) isIpc = true;
    host = a.host;
  } else if (typeof a === "string" && isNaN(Number(a))) {
    isIpc = true; // unix socket path
  } else {
    host = typeof args[1] === "string" ? args[1] : undefined;
  }
  if (!isIpc && !isLoopbackHost(host)) deny("connect", host, process.env.STRESS_EGRESS_PROBE === "1");
  return origConnect.apply(this, args);
};

const origLookup = dns.lookup;
dns.lookup = function patchedLookup(hostname, ...rest) {
  if (!isLoopbackHost(hostname)) {
    try { deny("dns", hostname, process.env.STRESS_EGRESS_PROBE === "1"); } catch (e) {
      const cb = rest[rest.length - 1];
      if (typeof cb === "function") return process.nextTick(cb, e);
      throw e;
    }
  }
  return origLookup.call(this, hostname, ...rest);
};
const origTlsConnect = tls.connect;
tls.connect = function patchedTls(...args) {
  const o = args[0];
  const host = o && typeof o === "object" ? o.host || o.servername : typeof args[1] === "string" ? args[1] : undefined;
  if (!isLoopbackHost(host)) deny("tls", host, process.env.STRESS_EGRESS_PROBE === "1");
  return origTlsConnect.apply(this, args);
};
module.exports = { isLoopbackHost, LOG };
