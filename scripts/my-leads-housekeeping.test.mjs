import assert from "node:assert/strict";
import test from "node:test";
import { canonicalJson, parseArgs, run, sha256Hex } from "./my-leads-housekeeping.mjs";

const ORG = "11111111-1111-4111-8111-111111111111";
const JARRAD = "22222222-2222-4222-8222-222222222222";
const RUN = "33333333-3333-4333-8333-333333333333";
const KEY = "service-role-key-DO-NOT-LOG-0123456789";

const PREVIEW = { kind: "reassign", leadCount: 15, fingerprint: "f".repeat(64), leads: [{ from: "a", count: 2 }] };

function harness({ preview = PREVIEW, memberships = [{ user_id: JARRAD }], rpcError = null } = {}) {
  const calls = [];
  const out = [];
  const err = [];
  const client = {
    rpc: async (name, args) => {
      calls.push({ name, args });
      if (rpcError) return { data: null, error: { message: rpcError } };
      return { data: args.p_apply === false || name.endsWith("run_info") ? preview : { runId: RUN, closed: 1 }, error: null };
    },
    from: () => {
      const q = { select: () => q, eq: () => q, then: (r) => r({ data: memberships, error: null }) };
      return q;
    },
  };
  const io = {
    env: { SUPABASE_URL: "https://example.supabase.co", SUPABASE_SERVICE_ROLE_KEY: KEY },
    out: (t) => out.push(t),
    err: (t) => err.push(t),
    createClient: () => client,
  };
  return { io, calls, out, err };
}

const reassign = ["reassign", "--org", ORG];

test("parseArgs validates uuids and rejects unknown flags", () => {
  assert.equal(parseArgs(["rollback", "--run", RUN, "--org", ORG]).run, RUN);
  assert.throws(() => parseArgs(["reassign", "--org", "nope"]), /UUID/);
  assert.throws(() => parseArgs(["reassign", "--bogus"]), /Unknown argument/);
  assert.throws(() => parseArgs(["reassign", "--org"]), /needs a value/);
});

test("canonicalJson is key-order independent", () => {
  assert.equal(canonicalJson({ b: 1, a: { d: 1, c: 2 } }), canonicalJson({ a: { c: 2, d: 1 }, b: 1 }));
});

test("preview is the default, writes nothing, and prints the confirm hash", async () => {
  const h = harness();
  assert.equal(await run(reassign, h.io), 0);
  assert.equal(h.calls.length, 1);
  assert.equal(h.calls[0].args.p_apply, false);
  assert.equal(h.calls[0].args.p_target, JARRAD); // resolved from memberships
  const printed = h.out.join("");
  assert.equal(JSON.parse(printed).leadCount, 15);
  assert.match(h.err.join(""), new RegExp(sha256Hex(printed.trimEnd())));
});

test("refuses --apply without --confirm", async () => {
  const h = harness();
  assert.equal(await run([...reassign, "--apply"], h.io), 1);
  assert.ok(h.calls.every((c) => c.args.p_apply === false), "no apply RPC was called");
  assert.match(h.err.join(""), /--apply needs --confirm/);
});

test("refuses --apply with a confirm hash that does not match the current preview", async () => {
  const h = harness();
  assert.equal(await run([...reassign, "--apply", "--confirm", "0".repeat(64)], h.io), 1);
  assert.ok(h.calls.every((c) => c.args.p_apply === false));
  assert.match(h.err.join(""), /does not match the current preview/);
});

test("applies only with the matching hash and passes the preview fingerprint to the RPC", async () => {
  const hash = sha256Hex(canonicalJson(PREVIEW));
  const h = harness();
  assert.equal(await run([...reassign, "--apply", "--confirm", hash], h.io), 0);
  const apply = h.calls.find((c) => c.args.p_apply === true);
  assert.ok(apply);
  assert.equal(apply.name, "fn_my_leads_housekeeping_reassign");
  assert.equal(apply.args.p_fingerprint, PREVIEW.fingerprint);
  assert.equal(apply.args.p_org_id, ORG);
  assert.match(h.err.join(""), new RegExp(`run id: ${RUN}`));
});

test("a changed preview since approval blocks the apply", async () => {
  const approved = sha256Hex(canonicalJson(PREVIEW));
  const h = harness({ preview: { ...PREVIEW, leadCount: 16 } });
  assert.equal(await run([...reassign, "--apply", "--confirm", approved], h.io), 1);
  assert.ok(h.calls.every((c) => c.args.p_apply === false));
});

test("close-attempts and rollback route to their RPCs", async () => {
  const closePreview = { kind: "close_attempts", count: 137, fingerprint: "e".repeat(64) };
  const c = harness({ preview: closePreview });
  assert.equal(await run(["close-attempts", "--org", ORG, "--apply", "--confirm", sha256Hex(canonicalJson(closePreview))], c.io), 0);
  assert.deepEqual(c.calls.map((x) => x.name), ["fn_my_leads_housekeeping_close_attempts", "fn_my_leads_housekeeping_close_attempts"]);
  assert.equal(c.calls[1].args.p_older_than, "7 days");

  const infoPreview = { kind: "rollback", run: { id: RUN }, fingerprint: "d".repeat(64) };
  const r = harness({ preview: infoPreview });
  assert.equal(await run(["rollback", "--org", ORG, "--run", RUN, "--apply", "--confirm", sha256Hex(canonicalJson(infoPreview))], r.io), 0);
  assert.deepEqual(r.calls.map((x) => x.name), ["fn_my_leads_housekeeping_run_info", "fn_my_leads_housekeeping_rollback"]);
  assert.deepEqual(r.calls[1].args, { p_run: RUN, p_org_id: ORG, p_fingerprint: infoPreview.fingerprint });
});

test("later-phase commands and unknown commands are refused without any call", async () => {
  for (const argv of [["relabel", "--org", ORG], ["phone-backfill", "--org", ORG], ["nope"]]) {
    const h = harness();
    assert.equal(await run(argv, h.io), 1);
    assert.equal(h.calls.length, 0);
  }
});

test("never logs the service key, even when an error carries it", async () => {
  const h = harness({ rpcError: `boom with ${KEY} inside` });
  assert.equal(await run(reassign, h.io), 1);
  const everything = [...h.out, ...h.err].join("");
  assert.ok(!everything.includes(KEY));
  assert.match(everything, /\[redacted\]/);
  const ok = harness();
  await run(reassign, ok.io);
  assert.ok(![...ok.out, ...ok.err].join("").includes(KEY));
});

test("requires the credentials from the environment and ambiguity needs explicit flags", async () => {
  const h = harness();
  h.io.env = {};
  assert.equal(await run(reassign, h.io), 1);
  assert.match(h.err.join(""), /op run/);
  const two = harness({ memberships: [{ user_id: JARRAD }, { user_id: RUN }] });
  assert.equal(await run(reassign, two.io), 1);
  assert.match(two.err.join(""), /pass --target and --owner/);
  assert.equal(two.calls.length, 0);
});
