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
//  {"mode":"send","from":"+1...","to":"+1...","body":"...","override":{...}}
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
const { createSyntheticReplyTransport, registerSyntheticReplyOverride, buildSyntheticReplyCallback } = mod;

const input = JSON.parse(process.argv[2]);

if (input.mode === "send") {
  if (input.override) registerSyntheticReplyOverride(input.to, input.override);
  const transport = createSyntheticReplyTransport("synthetic-e2e-proof-key");
  const controller = new AbortController();
  const result = await transport({ from: input.from, to: input.to, body: input.body }, controller.signal);
  process.stdout.write(JSON.stringify(result));
} else if (input.mode === "callback") {
  const envelope = buildSyntheticReplyCallback(input.externalId, input.terminal, input.extra);
  process.stdout.write(JSON.stringify(envelope));
} else {
  throw new Error("Unknown mode: " + input.mode);
}
