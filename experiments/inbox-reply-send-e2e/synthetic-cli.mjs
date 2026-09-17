// Thin CLI shim over the MERGED synthetic reply-send double
// (src/lib/inbox/reply-provider.synthetic.ts, Lane 1 PR-G) so proof.py can
// drive real per-attempt provider outcomes and build real callback
// envelopes through the ACTUAL TS module (via tsx), never a Python
// reimplementation of its logic. One process per call — the module's
// internal state (log/overrides/counter) is process-local, so registering
// an override and consuming it in the same invocation is exactly the
// "one-shot forced outcome" contract the module documents; no cross-call
// state is relied on.
//
// Usage: tsx synthetic-cli.mjs '<json>'
//  {"mode":"send","from":"+1...","to":"+1...","body":"...","override":{...},
//   "key":"...","logPath":"..."}
//    -> prints the ReplyProviderResult JSON (kind: accepted|not_attempted|uncertain)
//  {"mode":"callback","externalId":"...","terminal":"delivered"|"delivery_failed"}
//    -> prints the {event,data} envelope buildSyntheticReplyCallback produces
// [Node 22 + tsx + this repo's tsconfig] The synthetic module transpiles to
// CJS under this project's tsconfig, so its named exports surface as
// properties of the default export under Node's ESM/CJS interop rather than
// as top-level named exports — destructure from `.default` rather than
// import the names directly (proved via a throwaway probe script; importing
// the names directly silently resolves to `undefined`).
import mod from "../../src/lib/inbox/reply-provider.synthetic.ts";
import fs from "node:fs";
const { createSyntheticReplyTransport, registerSyntheticReplyOverride, buildSyntheticReplyCallback } = mod;

// [Astra e2e gate, finding B1 — the crux] Each CLI invocation is a FRESH
// Node process, so the merged double's own in-memory log/counter (module
// state) resets every call — it CANNOT be used to detect a duplicate send
// across two real invocations (two real sends to the SAME destination in
// two separate processes would even mint the SAME externalId,
// "synthetic_<to>_1", masking a genuine double-send as looking identical).
// This wrapper — proof-owned, NOT the merged double itself — appends one
// durable line per actual transport invocation to a caller-supplied log
// file that survives process boundaries, keyed by whatever identity the
// caller passes (normally the ledger attempt_id; a boundary proof may pass
// a different key, e.g. item_id, to assert "this logical recipient was
// never sent to twice" across a retry/successor attempt). proof.py counts
// lines by key — THAT count, not anything the double's own state exposes,
// is the real no-double-send evidence.
function logSend(logPath, key, result) {
  if (!logPath || !key) return;
  fs.appendFileSync(logPath, JSON.stringify({ key, at: Date.now(), pid: process.pid, result }) + "\n");
}

const input = JSON.parse(process.argv[2]);

if (input.mode === "send") {
  if (input.override) registerSyntheticReplyOverride(input.to, input.override);
  const transport = createSyntheticReplyTransport("synthetic-e2e-proof-key");
  const controller = new AbortController();
  const result = await transport({ from: input.from, to: input.to, body: input.body }, controller.signal);
  // Logged AFTER the real transport call returns, exactly once per actual
  // invocation of it — this is the send-count ledger, independent of the
  // double's own (process-local) state.
  logSend(input.logPath, input.key, result);
  process.stdout.write(JSON.stringify(result));
} else if (input.mode === "callback") {
  const envelope = buildSyntheticReplyCallback(input.externalId, input.terminal, input.extra);
  process.stdout.write(JSON.stringify(envelope));
} else {
  throw new Error("Unknown mode: " + input.mode);
}
