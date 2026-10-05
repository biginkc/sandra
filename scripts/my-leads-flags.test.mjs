import assert from "node:assert/strict";
import test from "node:test";
import { FLAGS, parseArgs, run } from "./my-leads-flags.mjs";

const ORG = "11111111-1111-4111-8111-111111111111";
const KEY = "service-role-key-DO-NOT-LOG-0123456789";

function harness({ rows = [null, { org_id: ORG, call_screen: true }], upsertError = null, readError = null } = {}) {
  const upserts = [];
  const out = [];
  const err = [];
  let reads = 0;
  const client = {
    from: (table) => {
      assert.equal(table, "my_leads_feature_flags");
      return {
        select: () => ({
          eq: () => ({
            maybeSingle: async () => (readError ? { data: null, error: { message: readError } } : { data: rows[reads++] ?? null, error: null }),
          }),
        }),
        upsert: async (row, opts) => {
          upserts.push({ row, opts });
          return { error: upsertError ? { message: upsertError } : null };
        },
      };
    },
  };
  const io = {
    env: { SUPABASE_URL: "https://example.supabase.co", SUPABASE_SERVICE_ROLE_KEY: KEY },
    out: (t) => out.push(t),
    err: (t) => err.push(t),
    createClient: () => client,
  };
  return { io, upserts, out, err };
}

test("allowlist has the thirteen flags", () => {
  assert.equal(FLAGS.length, 13);
  assert.equal(new Set(FLAGS).size, 13);
});

test("parseArgs accepts a valid call", () => {
  assert.deepEqual(parseArgs(["call_screen", "on", "--org", ORG]), { flag: "call_screen", value: true, org: ORG });
  assert.equal(parseArgs(["comp_queue", "off", "--org", ORG]).value, false);
});

test("parseArgs rejects unknown flag, bad state, bad or missing org, extras", () => {
  assert.throws(() => parseArgs(["nope", "on", "--org", ORG]), /Unknown flag/);
  assert.throws(() => parseArgs(["updated_at", "on", "--org", ORG]), /Unknown flag/);
  assert.throws(() => parseArgs(["call_screen", "maybe", "--org", ORG]), /on or off/);
  assert.throws(() => parseArgs(["call_screen", "on", "--org", "nope"]), /UUID/);
  assert.throws(() => parseArgs(["call_screen", "on"]), /--org is required/);
  assert.throws(() => parseArgs(["call_screen", "on", "--org"]), /needs a value/);
  assert.throws(() => parseArgs(["call_screen", "on", "--org", ORG, "--x"]), /Unknown argument/);
});

test("upserts only the named flag and prints before and after", async () => {
  const h = harness();
  assert.equal(await run(["call_screen", "on", "--org", ORG], h.io), 0);
  assert.equal(h.upserts.length, 1);
  const { row, opts } = h.upserts[0];
  assert.equal(row.org_id, ORG);
  assert.equal(row.call_screen, true);
  assert.deepEqual(Object.keys(row).sort(), ["call_screen", "org_id", "updated_at"]);
  assert.equal(opts.onConflict, "org_id");
  const printed = JSON.parse(h.out.join(""));
  assert.equal(printed.before, null);
  assert.equal(printed.after.call_screen, true);
});

test("fails without env and never logs the key", async () => {
  const h = harness({ upsertError: `bad ${KEY}` });
  assert.equal(await run(["call_screen", "off", "--org", ORG], h.io), 1);
  const all = h.out.join("") + h.err.join("");
  assert.ok(!all.includes(KEY));
  const noEnv = harness();
  noEnv.io.env = {};
  assert.equal(await run(["call_screen", "on", "--org", ORG], noEnv.io), 1);
  assert.match(noEnv.err.join(""), /op run/);
  const readFail = harness({ readError: "table missing" });
  assert.equal(await run(["call_screen", "on", "--org", ORG], readFail.io), 1);
  assert.equal(readFail.upserts.length, 0);
});
