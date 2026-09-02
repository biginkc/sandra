import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";

import {
  applyProductionPacket,
  loadReviewedPlan,
  splitSupabaseStatements,
} from "./apply-esign-production-migrations-atomically.mjs";

const repoRoot = join(import.meta.dirname, "..");
const planPath = join(import.meta.dirname, "esign-atomic-production-plan.json");
const switchboardPath = join(
  repoRoot,
  "supabase/migrations/20260830092331_switchboard_contact_preferences.sql",
);
const requiredSwitchboardTypes = Object.freeze([
  "lead",
  "provider",
  "jitter_writeback",
  "closer_practice",
  "bmh_institute_course",
  "esign_provider",
  "switchboard_contact_preference",
]);

function hash(value) {
  return createHash("sha256").update(value).digest("hex");
}

function packetHarness(plan) {
  const protectedSwitchboard = [];
  const counts = {
    switchboard_consumers: 0,
    switchboard_events: 0,
    global_dnc_rows: 0,
  };
  const constraints = [
    {
      conname: "webhook_consumers_type_check",
      convalidated: true,
      definition: requiredSwitchboardTypes.join(" "),
    },
    {
      conname: "webhook_consumers_type_source_match_check",
      convalidated: true,
      definition: requiredSwitchboardTypes.join(" "),
    },
  ];
  const calls = [];
  const client = {
    async query(sql, params) {
      calls.push({ sql, params });
      if (/current_database\(\)/u.test(sql)) {
        return { rows: [{ database: "postgres", system_identifier: "system-1" }] };
      }
      if (/from supabase_migrations\.schema_migrations/u.test(sql)) {
        return {
          rows: [
            {
              version: plan.switchboard.version,
              name: plan.switchboard.name,
              statements: plan.switchboard.statements,
            },
          ],
        };
      }
      if (/jsonb_build_object/u.test(sql)) {
        return { rows: [{ value: protectedSwitchboard }] };
      }
      if (/switchboard_consumers/u.test(sql)) return { rows: [counts] };
      if (/conrelid='public\.webhook_consumers'::regclass/u.test(sql)) {
        return { rows: constraints };
      }
      return { rows: [] };
    },
  };
  return {
    calls,
    client,
    snapshot: {
      format: 1,
      recordedAt: new Date().toISOString(),
      productionProjectRef: plan.productionProjectRef,
      database: "postgres",
      systemIdentifier: "system-1",
      counts,
      protectedSwitchboard,
      protectedSwitchboardSha256: hash(JSON.stringify(protectedSwitchboard)),
    },
  };
}

test("Supabase 2.109.1-compatible parser preserves transaction and quoted bodies", () => {
  const sql = `-- header\nbegin;\nselect ';' as value;\nselect (1;);\ndo $body$\nbegin\n  perform 1;\nend\n$body$;\ncommit;`;
  assert.deepEqual(splitSupabaseStatements(sql), [
    "-- header\nbegin",
    "select ';' as value",
    "select (1;)",
    "do $body$\nbegin\n  perform 1;\nend\n$body$",
    "commit",
  ]);
});

test("reviewed packet pins exact file and statement-array identities", () => {
  const manifest = JSON.parse(readFileSync(planPath, "utf8"));
  assert.deepEqual(
    manifest.migrations.map((entry) => entry.version),
    [
      "20260829194500",
      "20260830080000",
      "20260830100000",
      "20260902120100",
      "20260902143000",
    ],
  );
  for (const entry of manifest.migrations) {
    const sql = readFileSync(join(repoRoot, entry.path), "utf8");
    assert.equal(hash(sql), entry.sha256);
    assert.equal(hash(JSON.stringify(splitSupabaseStatements(sql))), entry.statementsSha256);
  }
  assert.equal(manifest.switchboard.sha256, "c4530a37e58cb69140661a62dc355e6555435d9ee8d3c1c4f59aa9134af3f30f");
  assert.equal(manifest.switchboard.statementsSha256, "741a9c39af4b3ef1346ae0e80aae28e1cf916fd331750c3a484fae7b370e1353");
  if (existsSync(switchboardPath)) {
    const plan = loadReviewedPlan(planPath);
    assert.equal(plan.switchboard.statements.length, 32);
  }
});

test("reviewed packet includes the disconnect state migration", () => {
  const manifest = JSON.parse(readFileSync(planPath, "utf8"));
  const entry = manifest.migrations.find(
    (migration) => migration.version === "20260902120100",
  );
  assert.ok(entry, "disconnect migration missing from atomic packet");
  assert.equal(entry.name, "esign_atomic_disconnect_state");
  assert.equal(
    entry.path,
    "supabase/migrations/20260902120100_esign_atomic_disconnect_state.sql",
  );
  assert.equal(
    entry.sha256,
    "3a3fcc87da6a48062861fac5758cef5b1231bfc0babc9549e044486d61daa111",
  );
  assert.equal(
    entry.statementsSha256,
    "5abfc78a20255fdb4df5e24e75fdde1cbb3872b096e8d1a3a6b8441a9a9891eb",
  );
});

test("applyProductionPacket executes the disconnect migration body from the reviewed packet", async () => {
  const plan = loadReviewedPlan(planPath);
  const { calls, client, snapshot } = packetHarness(plan);

  await assert.doesNotReject(
    applyProductionPacket(client, plan, snapshot, {
      beforeCommit: async () => {},
    }),
  );
  assert.ok(
    calls.some((call) =>
      /grant select \(disconnect_pending_at\)/u.test(call.sql),
    ),
    "disconnect migration body was not executed",
  );
  assert.ok(
    calls.some((call) =>
      /insert into supabase_migrations\.schema_migrations/u.test(call.sql) &&
      call.params?.[0] === "20260902120100",
    ),
    "disconnect migration ledger row was not inserted",
  );
});

test("applyProductionPacket rolls back when packet execution fails before commit", async () => {
  const plan = loadReviewedPlan(planPath);
  const { calls, client, snapshot } = packetHarness(plan);
  await assert.rejects(
    applyProductionPacket(client, plan, snapshot, {
      beforeCommit: async () => {
        throw new Error("synthetic packet failure");
      },
    }),
    /synthetic packet failure/u,
  );
  assert.ok(calls.some((call) => call.sql === "rollback"));
  assert.equal(calls.some((call) => call.sql === "commit"), false);
});

test("the manual packet refuses before reading credentials when arguments are incomplete", () => {
  const result = spawnSync(
    process.execPath,
    [join(import.meta.dirname, "apply-esign-production-migrations-atomically.mjs")],
    { encoding: "utf8", env: {} },
  );
  assert.equal(result.status, 1);
  assert.match(result.stderr, /REFUSING: Usage:/u);
  assert.doesNotMatch(result.stderr, /password|postgres:\/\//iu);
});

test("official CLI tag remains pinned for ledger compatibility evidence", () => {
  const manifest = JSON.parse(readFileSync(planPath, "utf8"));
  assert.equal(manifest.supabaseCliVersion, "2.109.1");
});
