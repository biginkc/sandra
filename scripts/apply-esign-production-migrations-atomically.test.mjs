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
const verifyWorkflowPath = join(repoRoot, ".github/workflows/verify.yml");
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
const expectedWebhookRequestColumns = Object.freeze([
  "id",
  "org_id",
  "property_id",
  "status",
  "signed_pdf_path",
  "template_title",
  "test_mode",
]);

function hash(value) {
  return createHash("sha256").update(value).digest("hex");
}

function packetHarness(plan, options = {}) {
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
  const historyRows = options.historyRows ?? [
    {
      version: plan.switchboard.version,
      name: plan.switchboard.name,
      statements: plan.switchboard.statements,
    },
  ];
  const client = {
    async query(sql, params) {
      calls.push({ sql, params });
      if (/current_database\(\)/u.test(sql)) {
        return { rows: [{ database: "postgres", system_identifier: "system-1" }] };
      }
      if (/from supabase_migrations\.schema_migrations/u.test(sql)) {
        return {
          rows: historyRows,
        };
      }
      if (/jsonb_build_object/u.test(sql)) {
        return { rows: [{ value: protectedSwitchboard }] };
      }
      if (/switchboard_consumers/u.test(sql)) return { rows: [counts] };
      if (/conrelid='public\.webhook_consumers'::regclass/u.test(sql)) {
        return { rows: constraints };
      }
      if (/select \* from public\.find_esign_webhook_request/u.test(sql)) {
        const names = options.badWebhookColumns
          ? expectedWebhookRequestColumns.slice(0, -1)
          : expectedWebhookRequestColumns;
        return { rows: [], fields: names.map((name) => ({ name })) };
      }
      if (/to_regprocedure\(\$1\)/u.test(sql)) {
        const signature = params?.[0] ?? "";
        const authenticated = /esign_template_is_available|get_latest_esign_requests_for_properties/u.test(
          signature,
        );
        return {
          rows: [
            {
              exists: options.missingFunction !== signature,
              service_role: options.missingServiceRoleGrant !== signature,
              authenticated,
              anon: false,
            },
          ],
        };
      }
      if (/from pg_trigger trigger/u.test(sql) && /trg_esign_requests_created_at_immutable/u.test(sql)) {
        return {
          rows: options.missingRequestModeTrigger
            ? []
            : [{
                tgname: "trg_esign_requests_created_at_immutable",
                proname: "reject_esign_request_snapshot_change",
                definition:
                  "CREATE TRIGGER trg_esign_requests_created_at_immutable BEFORE UPDATE ON public.esign_requests FOR EACH ROW EXECUTE FUNCTION reject_esign_request_snapshot_change()",
              }],
        };
      }
      if (/from information_schema\.columns/u.test(sql)) {
        return {
          rows: [
            ...[
              "live_send_monthly_limit",
              "live_send_monthly_used",
              "live_send_monthly_period_key",
              "live_send_monthly_period_started_at",
              "provider_account_id",
              "test_mode",
              "sending_enabled",
            ].map((column_name) => ({ table_name: "org_esign_integrations", column_name })),
            ...[
              "test_mode",
              "live_send_reserved_at",
              "provider_remaining_at_claim",
              "delivery_state",
              "sign_request_id",
            ].map((column_name) => ({ table_name: "esign_requests", column_name })),
            ...[
              "template_origin",
              "provider_metadata",
              "provider_metadata_attested_at",
              "provider_metadata_unavailable_at",
              "provider_metadata_unavailable_reason",
              "provider_account_id",
              "sign_template_id",
            ].map((column_name) => ({ table_name: "esign_templates", column_name })),
          ],
        };
      }
      if (/to_regclass\('public\.available_esign_templates'\)/u.test(sql)) {
        return {
          rows: [{ exists: true, authenticated_select: true, service_role_select: true }],
        };
      }
      if (/from unnest\(\$1::text\[\]\) as required/u.test(sql)) {
        return {
          rows: [
            "org_esign_integrations",
            "esign_templates",
            "esign_requests",
            "esign_request_signers",
          ].map((table_name) => ({
            table_name,
            can_select: true,
            can_insert: true,
            can_update: true,
            can_delete: true,
          })),
        };
      }
      if (/from information_schema\.column_privileges/u.test(sql)) {
        return {
          rows: [
            "id",
            "org_id",
            "provider",
            "api_key_last_four",
            "client_id",
            "sending_enabled",
            "test_mode",
            "live_send_monthly_limit",
            "live_send_monthly_used",
            "live_send_monthly_period_key",
            "live_send_monthly_period_started_at",
          ].map((column_name) => ({ column_name })),
        };
      }
      if (/from pg_class rel/u.test(sql)) {
        return {
          rows: [
            "org_esign_integrations",
            "esign_templates",
            "esign_requests",
            "esign_request_signers",
          ].map((relname) => ({ relname, relrowsecurity: true })),
        };
      }
      if (/from pg_policies/u.test(sql)) {
        return {
          rows: [
            "org_esign_integrations_org_select",
            "org_esign_integrations_owner_insert",
            "org_esign_integrations_owner_update",
            "org_esign_integrations_owner_delete",
          ].map((policyname) => ({ tablename: "org_esign_integrations", policyname })).concat([
            { tablename: "esign_templates", policyname: "esign_templates_org_select" },
            { tablename: "esign_requests", policyname: "esign_requests_org_select" },
            { tablename: "esign_request_signers", policyname: "esign_request_signers_org_select" },
          ]),
        };
      }
      if (/from pg_constraint con/u.test(sql)) {
        return {
          rows: [
            {
              table_name: "org_esign_integrations",
              conname: "org_esign_integrations_live_send_monthly_limit_check",
              convalidated: true,
              definition: "CHECK (live_send_monthly_limit between 1 and 40)",
            },
            {
              table_name: "esign_requests",
              conname: "esign_requests_provider_remaining_at_claim_check",
              convalidated: true,
              definition: "CHECK (provider_remaining_at_claim is null or provider_remaining_at_claim >= 0)",
            },
            {
              table_name: "esign_templates",
              conname: "esign_templates_template_origin_check",
              convalidated: true,
              definition: "CHECK (template_origin in ('sandra_embedded','dropbox_website'))",
            },
            {
              table_name: "esign_templates",
              conname: "esign_templates_provider_metadata_check",
              convalidated: true,
              definition: "CHECK (provider_metadata_attested_at is not null and provider_metadata_unavailable_reason is null)",
            },
            {
              table_name: "esign_templates",
              conname: "esign_templates_source_snapshot_check",
              convalidated: true,
              definition: "CHECK (template_origin = 'sandra_embedded' or template_origin = 'dropbox_website')",
            },
          ],
        };
      }
      if (/from pg_indexes/u.test(sql)) {
        return {
          rows: [
            {
              indexdef:
                "CREATE UNIQUE INDEX idx_esign_templates_provider_id ON public.esign_templates USING btree (provider_account_id, sign_template_id) WHERE (sign_template_id IS NOT NULL)",
            },
          ],
        };
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
      "20260902180000",
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

test("applyProductionPacket upgrades the already-applied four-row ledger by applying only the new migration", async () => {
  const plan = loadReviewedPlan(planPath);
  const oldFour = plan.migrations.slice(0, 4).map((entry) => ({
    version: entry.version,
    name: entry.name,
    statements: entry.statements,
  }));
  const { calls, client, snapshot } = packetHarness(plan, {
    historyRows: [
      {
        version: plan.switchboard.version,
        name: plan.switchboard.name,
        statements: plan.switchboard.statements,
      },
      ...oldFour,
    ],
  });

  await assert.doesNotReject(
    applyProductionPacket(client, plan, snapshot, {
      beforeCommit: async () => {},
    }),
  );

  const ledgerInserts = calls.filter((call) =>
    /insert into supabase_migrations\.schema_migrations/u.test(call.sql),
  );
  assert.deepEqual(
    ledgerInserts.map((call) => call.params?.[0]),
    ["20260902180000"],
  );
  assert.equal(
    calls.some((call) => call.params?.[0] === "20260829194500"),
    false,
  );
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
  const postApplyIndex = calls.findIndex((call) =>
    /select \* from public\.find_esign_webhook_request/u.test(call.sql),
  );
  const commitIndex = calls.findIndex((call) => call.sql === "commit");
  assert.ok(postApplyIndex >= 0, "post-apply eSign assertions did not run");
  assert.ok(postApplyIndex < commitIndex, "post-apply eSign assertions did not run before commit");
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

test("applyProductionPacket rolls back when post-apply eSign assertions fail", async () => {
  const plan = loadReviewedPlan(planPath);
  const { calls, client, snapshot } = packetHarness(plan, { badWebhookColumns: true });
  await assert.rejects(
    applyProductionPacket(client, plan, snapshot),
    /seven-column return shape/u,
  );
  assert.ok(calls.some((call) => call.sql === "rollback"));
  assert.equal(calls.some((call) => call.sql === "commit"), false);
});

test("applyProductionPacket rolls back when immutable request-mode trigger is missing", async () => {
  const plan = loadReviewedPlan(planPath);
  const { calls, client, snapshot } = packetHarness(plan, {
    missingRequestModeTrigger: true,
  });
  await assert.rejects(
    applyProductionPacket(client, plan, snapshot),
    /trg_esign_requests_created_at_immutable/u,
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

test("CI verify job uses ankane/setup-postgres runner account without a password", () => {
  const workflow = readFileSync(verifyWorkflowPath, "utf8");
  assert.match(
    workflow,
    /SUPABASE_LOCAL_DB_URL:\s*postgresql:\/\/runner@localhost:5432\/postgres/u,
  );
  assert.doesNotMatch(
    workflow,
    /SUPABASE_LOCAL_DB_URL:\s*postgresql:\/\/postgres(?::postgres)?@localhost:5432\/postgres/u,
  );
});
