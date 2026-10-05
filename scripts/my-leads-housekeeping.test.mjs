import assert from "node:assert/strict";
import test from "node:test";
import { canonicalJson, parseArgs, run, sha256Hex } from "./my-leads-housekeeping.mjs";

const ORG = "11111111-1111-4111-8111-111111111111";
const JARRAD = "22222222-2222-4222-8222-222222222222";
const RUN = "33333333-3333-4333-8333-333333333333";
const OP_TOKEN = "ops_service-account-token-DO-NOT-LOG-9876";
const KEY = "service-role-key-DO-NOT-LOG-0123456789";

const HOST = { supabaseHost: "example.supabase.co" };
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
    env: { SUPABASE_URL: "https://example.supabase.co", SUPABASE_SERVICE_ROLE_KEY: KEY, OP_SERVICE_ACCOUNT_TOKEN: OP_TOKEN },
    out: (t) => out.push(t),
    err: (t) => err.push(t),
    createClient: () => client,
  };
  return { io, calls, out, err };
}

const MARIA = "44444444-4444-4444-8444-444444444444";
const MEL = "55555555-5555-4555-8555-555555555555";
const reassign = ["reassign", "--org", ORG, "--from", `${MEL},${MARIA}`];

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
  const hash = sha256Hex(canonicalJson({ ...HOST, ...PREVIEW }));
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
  const approved = sha256Hex(canonicalJson({ ...HOST, ...PREVIEW }));
  const h = harness({ preview: { ...PREVIEW, leadCount: 16 } });
  assert.equal(await run([...reassign, "--apply", "--confirm", approved], h.io), 1);
  assert.ok(h.calls.every((c) => c.args.p_apply === false));
});

test("close-attempts and rollback route to their RPCs", async () => {
  const closePreview = { kind: "close_attempts", count: 137, cutoff: "2026-09-27T00:00:00+00:00", fingerprint: "e".repeat(64) };
  const c = harness({ preview: closePreview });
  assert.equal(await run(["close-attempts", "--org", ORG, "--apply", "--cutoff", closePreview.cutoff, "--confirm", sha256Hex(canonicalJson({ ...HOST, ...closePreview }))], c.io), 0);
  assert.deepEqual(c.calls.map((x) => x.name), ["fn_my_leads_housekeeping_close_attempts", "fn_my_leads_housekeeping_close_attempts"]);
  assert.equal(c.calls[1].args.p_older_than, "7 days");
  assert.equal(c.calls[1].args.p_cutoff, closePreview.cutoff); // explicit, never recomputed
  const noCut = harness({ preview: closePreview });
  assert.equal(await run(["close-attempts", "--org", ORG, "--apply", "--confirm", "0".repeat(64)], noCut.io), 1);
  assert.match(noCut.err.join(""), /--cutoff/);
  assert.equal(noCut.calls.length, 0);

  const infoPreview = { kind: "rollback", run: { id: RUN }, fingerprint: "d".repeat(64) };
  const r = harness({ preview: infoPreview });
  assert.equal(await run(["rollback", "--org", ORG, "--run", RUN, "--apply", "--confirm", sha256Hex(canonicalJson({ ...HOST, ...infoPreview }))], r.io), 0);
  assert.deepEqual(r.calls.map((x) => x.name), ["fn_contact_phone_numbers_backfill_run_info", "fn_my_leads_housekeeping_run_info", "fn_my_leads_housekeeping_rollback"]);
  assert.deepEqual(r.calls[2].args, { p_run: RUN, p_org_id: ORG, p_fingerprint: infoPreview.fingerprint });
});

test("unknown and under-specified commands are refused without any call", async () => {
  for (const argv of [["nope"], ["ack-legacy-prompts"]]) {
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

test("preview JSON carries the Supabase host so the hash is tied to one environment", async () => {
  const a = harness();
  await run(reassign, a.io);
  assert.equal(JSON.parse(a.out.join("")).supabaseHost, "example.supabase.co");
  const other = harness();
  other.io.env.SUPABASE_URL = "https://other.supabase.co";
  await run(reassign, other.io);
  assert.notEqual(sha256Hex(a.out.join("").trimEnd()), sha256Hex(other.out.join("").trimEnd()));
  // a hash approved on one host does not apply on another
  const hash = sha256Hex(canonicalJson({ ...HOST, ...PREVIEW }));
  const wrong = harness();
  wrong.io.env.SUPABASE_URL = "https://other.supabase.co";
  assert.equal(await run([...reassign, "--apply", "--confirm", hash], wrong.io), 1);
  assert.ok(wrong.calls.every((c) => c.args.p_apply === false));
});

test("refuses to start without the 1Password service account token, and never logs it", async () => {
  const h = harness();
  delete h.io.env.OP_SERVICE_ACCOUNT_TOKEN;
  assert.equal(await run(reassign, h.io), 1);
  assert.equal(h.calls.length, 0);
  assert.match(h.err.join(""), /OP_SERVICE_ACCOUNT_TOKEN/);
  const leak = harness({ rpcError: `boom ${OP_TOKEN}` });
  await run(reassign, leak.io);
  assert.ok(![...leak.out, ...leak.err].join("").includes(OP_TOKEN));
});

test("relabel previews with the resolved owner as expected assignee and needs the cutoff to apply", async () => {
  const h = harness();
  assert.equal(await run(["relabel", "--org", ORG], h.io), 0);
  assert.equal(h.calls[0].name, "fn_my_leads_relabel_open_next_steps");
  assert.equal(h.calls[0].args.p_expected_assignee, JARRAD);
  assert.equal(h.calls[0].args.p_apply, false);
  const a = harness();
  assert.equal(await run(["relabel", "--org", ORG, "--apply", "--confirm", "x"], a.io), 1);
  assert.equal(a.calls.length, 0);
});

test("retire-preflight is read-only and cannot be applied", async () => {
  const h = harness({ preview: { openFutureLegacy: 0 } });
  assert.equal(await run(["retire-preflight", "--org", ORG], h.io), 0);
  assert.deepEqual(h.calls, [{ name: "fn_my_leads_next_step_retire_preflight", args: { p_org_id: ORG } }]);
  const a = harness();
  assert.equal(await run(["retire-preflight", "--org", ORG, "--apply", "--confirm", "x"], a.io), 1);
});

test("offer-backfill previews and applies through the offer follow-up function with the resolved owner as actor", async () => {
  const preview = { kind: "offer_follow_up_backfill", fingerprint: "e".repeat(64), candidates: 3 };
  const h = harness({ preview });
  assert.equal(await run(["offer-backfill", "--org", ORG], h.io), 0);
  assert.deepEqual(h.calls[0], { name: "fn_my_leads_backfill_offer_follow_ups", args: { p_org_id: ORG, p_actor: JARRAD, p_apply: false } });
  const a = harness({ preview });
  assert.equal(await run(["offer-backfill", "--org", ORG, "--apply", "--confirm", sha256Hex(canonicalJson({ ...HOST, ...preview }))], a.io), 0);
  assert.deepEqual(a.calls[1].args, { p_org_id: ORG, p_actor: JARRAD, p_apply: true, p_fingerprint: preview.fingerprint });
});

test("reassign requires --from, refuses the target as a source, and passes sorted unique sources", async () => {
  const none = harness();
  assert.equal(await run(["reassign", "--org", ORG], none.io), 1);
  assert.match(none.err.join(""), /--from is required/);
  assert.equal(none.calls.length, 0);
  const self = harness();
  assert.equal(await run(["reassign", "--org", ORG, "--from", `${MEL},${JARRAD}`], self.io), 1);
  assert.match(self.err.join(""), /must not include the target/);
  assert.equal(self.calls.length, 0);
  assert.throws(() => parseArgs(["reassign", "--from", "nope"]), /UUIDs/);
  assert.deepEqual(parseArgs(["reassign", "--from", `${MEL},${MARIA},${MEL}`]).from, [MARIA, MEL]);
  const ok = harness();
  assert.equal(await run(["reassign", "--org", ORG, "--from", `${MEL},${MARIA}`], ok.io), 0);
  assert.deepEqual(ok.calls[0].args.p_sources, [MARIA, MEL]);
});

test("reassign preview prints per-source counts and emails when available", async () => {
  const h = harness({ preview: { ...PREVIEW, leads: [{ from: MEL, count: 12 }, { from: MARIA, count: 2 }], tasks: { byAssignee: [{ assignee: MEL, nonAppointment: 3, appointments: 1 }] } } });
  const client = h.io.createClient();
  client.auth = { admin: { getUserById: async (id) => ({ data: { user: { email: id === MEL ? "mel@example.com" : null } } }) } };
  assert.equal(await run(reassign, h.io), 0);
  const err = h.err.join("");
  assert.match(err, new RegExp(`source ${MEL} \\(mel@example.com\\): 12 leads, 3 tasks, 1 appointments`));
  assert.match(err, new RegExp(`source ${MARIA}: 2 leads, 0 tasks, 0 appointments`));
});

test("link-backfill previews, refuses apply without the confirm hash, and applies through its own function", async () => {
  const preview = { kind: "link_backfill", fingerprint: "d".repeat(64), candidates: 5 };
  const h = harness({ preview });
  assert.equal(await run(["link-backfill", "--org", ORG], h.io), 0);
  assert.deepEqual(h.calls, [{ name: "fn_my_leads_housekeeping_link_backfill", args: { p_org_id: ORG, p_apply: false } }]);
  const none = harness({ preview });
  assert.equal(await run(["link-backfill", "--org", ORG, "--apply"], none.io), 1);
  assert.equal(none.calls.length, 1);
  const a = harness({ preview });
  assert.equal(await run(["link-backfill", "--org", ORG, "--apply", "--confirm", sha256Hex(canonicalJson({ ...HOST, ...preview }))], a.io), 0);
  assert.deepEqual(a.calls[1].args, { p_org_id: ORG, p_apply: true, p_fingerprint: preview.fingerprint });
});

// A fake database for the paged phone backfill: `n` ranges whose ids are r1..rn.
function phoneHarness({ ranges = 3, failApplyAt = null, runKind = null } = {}) {
  const base = harness();
  const calls = [];
  const id = (i) => `00000000-0000-4000-8000-${String(i).padStart(12, "0")}`;
  const digest = (i) => String(i).repeat(64).slice(0, 64);
  base.io.createClient = () => ({
    rpc: async (name, args) => {
      calls.push({ name, args });
      if (name === "fn_contact_phone_numbers_backfill_range") {
        if (!args.p_apply) {
          const at = args.p_after ? Number(args.p_after.slice(-12)) : 0;
          if (at >= ranges) return { data: { done: true, lastId: null }, error: null };
          return { data: { done: false, lastId: id(at + 1), candidates: 10, toCreate: 8, toUpdate: 2, digest: digest(at + 1), sample: [id(at + 1)] }, error: null };
        }
        const n = Number(args.p_upto.slice(-12));
        if (failApplyAt === n) return { data: null, error: { message: "FINGERPRINT_MISMATCH: the cohort changed" } };
        return { data: { runId: RUN, candidates: 10, created: 8, updated: 2 }, error: null };
      }
      if (name === "fn_contact_phone_numbers_backfill_run_info") {
        return { data: { kind: "rollback", run: { id: RUN, kind: runKind, status: "applied", params: { batched: true } } }, error: null };
      }
      if (name === "fn_contact_phone_numbers_backfill_rollback_range") {
        if (!args.p_apply) {
          const at = args.p_after ? Number(args.p_after.slice(-12)) : 0;
          if (at >= ranges) return { data: { done: true }, error: null };
          return { data: { done: false, lastId: id(at + 1), images: 10, digest: digest(at + 1) }, error: null };
        }
        return { data: { restored: 10, alreadyRestored: 0, notRestored: [] }, error: null };
      }
      if (name === "fn_contact_phone_numbers_backfill_rollback_finish") return { data: { status: "rolled_back", restored: args.p_restored }, error: null };
      throw new Error(`unexpected ${name}`);
    },
  });
  return { ...base, calls };
}

test("phone-backfill pages every range, prints one whole-set fingerprint, and applies each range under its own digest", async () => {
  const h = phoneHarness();
  assert.equal(await run(["phone-backfill", "--org", ORG], h.io), 0);
  const preview = JSON.parse(h.out.join(""));
  assert.equal(preview.ranges, 3);
  assert.equal(preview.candidates, 30);
  assert.equal(preview.toCreate, 24);
  assert.equal(preview.fingerprint, sha256Hex(`phone_backfill_batched|2000|${["1".repeat(64), "2".repeat(64), "3".repeat(64)].join(",")}`));
  assert.ok(h.calls.every((c) => c.name === "fn_contact_phone_numbers_backfill_range" && c.args.p_apply === false));
  assert.equal(h.calls.length, 4);

  const none = phoneHarness();
  assert.equal(await run(["phone-backfill", "--org", ORG, "--apply"], none.io), 1);
  assert.ok(none.calls.every((c) => c.args.p_apply === false)); // no confirm hash, nothing written
  const wrong = phoneHarness();
  assert.equal(await run(["phone-backfill", "--org", ORG, "--apply", "--confirm", "0".repeat(64)], wrong.io), 1);
  assert.ok(wrong.calls.every((c) => c.args.p_apply === false));

  const hash = sha256Hex(canonicalJson({ ...HOST, ...preview }));
  const a = phoneHarness();
  assert.equal(await run(["phone-backfill", "--org", ORG, "--apply", "--confirm", hash], a.io), 0);
  const applies = a.calls.filter((c) => c.args.p_apply);
  assert.equal(applies.length, 3);
  assert.deepEqual(applies.map((c) => c.args.p_expected_digest), ["1".repeat(64), "2".repeat(64), "3".repeat(64)]);
  assert.deepEqual(applies.map((c) => c.args.p_run), [null, RUN, RUN]);
  assert.ok(applies.every((c) => c.args.p_fingerprint === preview.fingerprint));
  assert.equal(JSON.parse(a.out.join("")).created, 24);
});

test("phone-backfill stops at the first range that drifted and names the run to roll back", async () => {
  const preview = JSON.parse((await (async () => { const h = phoneHarness(); await run(["phone-backfill", "--org", ORG], h.io); return h.out.join(""); })()));
  const h = phoneHarness({ failApplyAt: 2 });
  assert.equal(await run(["phone-backfill", "--org", ORG, "--apply", "--confirm", sha256Hex(canonicalJson({ ...HOST, ...preview }))], h.io), 1);
  assert.equal(h.calls.filter((c) => c.args.p_apply).length, 2); // range 3 never attempted
  const message = h.err.join("");
  assert.match(message, /FINGERPRINT_MISMATCH/);
  assert.match(message, new RegExp(`rollback --run ${RUN}`));
});

test("phone-backfill batch size is validated and sets the range size", async () => {
  assert.throws(() => parseArgs(["phone-backfill", "--org", ORG, "--batch-size", "0"]), /batch-size/);
  assert.throws(() => parseArgs(["phone-backfill", "--org", ORG, "--batch-size", "9999"]), /batch-size/);
  const h = phoneHarness();
  assert.equal(await run(["phone-backfill", "--org", ORG, "--batch-size", "500"], h.io), 0);
  assert.equal(h.calls[0].args.p_limit, 500);
});

test("rollback of a batched phone run pages its before-images and finishes the run", async () => {
  const h = phoneHarness({ runKind: "phone_backfill" });
  assert.equal(await run(["rollback", "--org", ORG, "--run", RUN], h.io), 0);
  const preview = JSON.parse(h.out.join(""));
  assert.equal(preview.beforeImages, 30);
  const a = phoneHarness({ runKind: "phone_backfill" });
  assert.equal(await run(["rollback", "--org", ORG, "--run", RUN, "--apply", "--confirm", sha256Hex(canonicalJson({ ...HOST, ...preview }))], a.io), 0);
  assert.deepEqual(a.calls.filter((c) => c.args.p_apply).map((c) => c.args.p_expected_digest), ["1".repeat(64), "2".repeat(64), "3".repeat(64)]);
  const finish = a.calls.at(-1);
  assert.equal(finish.name, "fn_contact_phone_numbers_backfill_rollback_finish");
  assert.equal(finish.args.p_restored, 30);
});
for (const [command, rpcName, kind] of [
  ["ack-legacy-prompts", "fn_my_leads_ack_legacy_call_prompts", "ack_legacy_prompts"],
]) {
  test(`${command} previews, refuses apply without the confirm hash, and applies through its own function`, async () => {
    const preview = { kind, fingerprint: "e".repeat(64), candidates: 5 };
    const h = harness({ preview });
    assert.equal(await run([command, "--org", ORG], h.io), 0);
    assert.deepEqual(h.calls, [{ name: rpcName, args: { p_org_id: ORG, p_apply: false } }]);
    const none = harness({ preview });
    assert.equal(await run([command, "--org", ORG, "--apply"], none.io), 1);
    assert.equal(none.calls.length, 1);
    const a = harness({ preview });
    assert.equal(await run([command, "--org", ORG, "--apply", "--confirm", sha256Hex(canonicalJson({ ...HOST, ...preview }))], a.io), 0);
    assert.deepEqual(a.calls[1].args, { p_org_id: ORG, p_apply: true, p_fingerprint: preview.fingerprint });
  });
}
