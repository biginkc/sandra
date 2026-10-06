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

// Announce: the harness proves the guard ran inside THIS pid by finding this line in the log (probe: not a violation).
try { fs.appendFileSync(LOG, JSON.stringify({ at: new Date().toISOString(), pid: process.pid, kind: "guard_loaded", target: "", probe: true }) + "\n"); } catch { /* no log, no proof: the engine refuses */ }

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
