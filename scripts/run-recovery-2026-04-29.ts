#!/usr/bin/env tsx
/**
 * One-off recovery driver for the 2026-04-29 skip-trace recovery list.
 *
 * Background
 *   Yesterday morning four skip-trace jobs failed in prod. Their failed
 *   property_ids were bundled into a recovery list (id below). PR #61/#62
 *   shipped a retry button + a pre-flight CASS gate; running the retry
 *   pulled 21 hits but left ~37 (now: 46) properties stuck at
 *   `error_class='address_unverified'` because their `cass_status` was
 *   `'unverified'`. SmartyStreets was upgraded to a paid plan today, so
 *   we can finally CASS-verify those 46 and re-run skip-trace through
 *   the post-#62 codepath.
 *
 * What this script does
 *   Phase 0  Dry-run report. Always runs. No DB writes, no vendor calls.
 *            Counts properties by cass_status, estimates total $ cost,
 *            prints property IDs grouped by status. Exits 0.
 *
 *   Phase 1  (only with --execute) Create a `cass_dsf2_ncoa` job and
 *            run `runCassEnrichment` against the unverified subset.
 *            Polls the job until terminal. Prints CASS outcomes.
 *
 *   Phase 2  (only with --execute, only after Phase 1) Re-query the
 *            recovery list, find properties NOW `cass_status='verified'`
 *            that were 'unverified' before Phase 1, create a
 *            `skip_trace` job, kick `runSkipTraceEnrichment`. Doesn't
 *            poll — Tracerfy webhook + cron sweep handles finalization.
 *            Prints the new job ID.
 *
 * Usage
 *   Dry run (safe):
 *     vercel env pull --environment=production /tmp/.env.sandra-prod
 *     env $(grep -v '^#' /tmp/.env.sandra-prod | xargs) \
 *       npx tsx scripts/run-recovery-2026-04-29.ts
 *
 *   Execute (real money + DB writes):
 *     env ... npx tsx scripts/run-recovery-2026-04-29.ts --execute
 *
 *   Notes:
 *     - Hits prod project copflsklaefwzipsrjqz via SUPABASE_SERVICE_ROLE_KEY.
 *     - Requires SMARTY_AUTH_ID/_TOKEN, ADDRESS_VERIFIER_PROVIDER=smartystreets,
 *       TRACERFY_API_KEY, SKIP_TRACE_PROVIDER=tracerfy in process.env.
 *     - The script targets whichever Supabase project NEXT_PUBLIC_SUPABASE_URL
 *       points at. Sanity-checks the recovery list exists before doing
 *       anything destructive.
 */

import { createAdminClient } from "../src/lib/supabase/admin";
import { start } from "workflow/api";
import {
  CASS_COST_PER_LOOKUP_USD,
  runCassEnrichment,
} from "../src/lib/enrichment/cass-job";
import { skipTraceSubmitWorkflow } from "../src/workflows/skip-trace-submit";

const RECOVERY_LIST_ID = "3241368b-0631-45d1-908b-0322660b387f";
const ADMIN_EMAIL_ENV = "RECOVERY_ADMIN_EMAIL";
const TRACERFY_COST_PER_LOOKUP_USD = 0.02;

type Bucket = "verified" | "unverified" | "invalid" | "ambiguous" | "other";

type PropertyRow = {
  id: string;
  org_id: string;
  cass_status: string | null;
  skip_trace_disabled: boolean | null;
};

function classify(status: string | null): Bucket {
  switch (status) {
    case "verified":
      return "verified";
    case "unverified":
      return "unverified";
    case "invalid":
      return "invalid";
    case "ambiguous":
      return "ambiguous";
    default:
      return "other";
  }
}

function fmtUsd(n: number): string {
  return `$${n.toFixed(2)}`;
}

function requiredEnv(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`${name} must be set.`);
  return value;
}

async function loadRecoveryProperties(
  supabase: ReturnType<typeof createAdminClient>,
): Promise<PropertyRow[]> {
  // property_lists.list_id → properties — pull the columns we need to
  // bucket and to feed the runners. Service-role bypasses RLS.
  const { data: members, error: memberErr } = await supabase
    .from("property_lists")
    .select("property_id")
    .eq("list_id", RECOVERY_LIST_ID);

  if (memberErr) {
    throw new Error(`property_lists query failed: ${memberErr.message}`);
  }
  const propertyIds = (members ?? [])
    .map((m) => m.property_id)
    .filter((id): id is string => typeof id === "string");

  if (propertyIds.length === 0) {
    throw new Error(
      `Recovery list ${RECOVERY_LIST_ID} is empty or does not exist on the connected Supabase project.`,
    );
  }

  const { data: rows, error: propErr } = await supabase
    .from("properties")
    .select("id, org_id, cass_status, skip_trace_disabled")
    .in("id", propertyIds);

  if (propErr) {
    throw new Error(`properties query failed: ${propErr.message}`);
  }
  return (rows ?? []) as PropertyRow[];
}

function summarize(rows: PropertyRow[]): Record<Bucket, PropertyRow[]> {
  const out: Record<Bucket, PropertyRow[]> = {
    verified: [],
    unverified: [],
    invalid: [],
    ambiguous: [],
    other: [],
  };
  for (const r of rows) out[classify(r.cass_status)].push(r);
  return out;
}

function printDryRun(rows: PropertyRow[]): {
  unverifiedIds: string[];
  verifiedIds: string[];
} {
  const groups = summarize(rows);
  const total = rows.length;
  const unverified = groups.unverified.length;
  const verified = groups.verified.length;
  const invalid = groups.invalid.length;
  const ambiguous = groups.ambiguous.length;
  const other = groups.other.length;
  const skipDisabled = rows.filter(
    (r) => r.skip_trace_disabled === true,
  ).length;

  // Cost model: SmartyStreets charges per lookup attempted (not just
  // successful). Tracerfy charges per row submitted; verified-no-data
  // returns 0 credits but the worst case bills full price. Estimate
  // worst case so the operator isn't surprised on the upside.
  const cassCost = unverified * CASS_COST_PER_LOOKUP_USD;
  // After Phase 1, anywhere from 0 to `unverified` properties become
  // verified and feed into Phase 2.
  const tracerfyCostMax = unverified * TRACERFY_COST_PER_LOOKUP_USD;
  const totalMax = cassCost + tracerfyCostMax;

  console.log("");
  console.log("=== DRY RUN — Skip-trace recovery 2026-04-29 ===");
  console.log(`Recovery list: ${RECOVERY_LIST_ID}`);
  console.log(`Total properties in list: ${total}`);
  console.log("");
  console.log("Status breakdown");
  console.log(`  verified:        ${verified}`);
  console.log(`  unverified:      ${unverified}`);
  console.log(`  invalid:         ${invalid}`);
  console.log(`  ambiguous:       ${ambiguous}`);
  console.log(`  other (null/?):  ${other}`);
  console.log(`  skip_trace_disabled (any status): ${skipDisabled}`);
  console.log("");
  console.log("Phase plan (only runs with --execute)");
  console.log(
    `  Phase 1 — CASS verify ${unverified} unverified properties via SmartyStreets`,
  );
  console.log(
    `  Phase 2 — Re-skip-trace properties that move to verified (≤${unverified}) via Tracerfy`,
  );
  console.log("");
  console.log("Cost estimate (worst case)");
  console.log(
    `  CASS:     ${unverified} × ${fmtUsd(CASS_COST_PER_LOOKUP_USD)} = ${fmtUsd(cassCost)}`,
  );
  console.log(
    `  Tracerfy: ${unverified} × ${fmtUsd(TRACERFY_COST_PER_LOOKUP_USD)} = ${fmtUsd(tracerfyCostMax)}`,
  );
  console.log(`  Total:    ${fmtUsd(totalMax)}`);
  console.log("");

  const printGroup = (label: string, items: PropertyRow[]) => {
    if (items.length === 0) return;
    console.log(`Property IDs — ${label} (${items.length})`);
    for (const p of items) console.log(`  ${p.id}`);
    console.log("");
  };
  printGroup("unverified (Phase 1 target)", groups.unverified);
  printGroup("verified (already-recovered, skipped)", groups.verified);
  if (invalid > 0) printGroup("invalid", groups.invalid);
  if (ambiguous > 0) printGroup("ambiguous", groups.ambiguous);
  if (other > 0) printGroup("other", groups.other);

  return {
    unverifiedIds: groups.unverified.map((r) => r.id),
    verifiedIds: groups.verified.map((r) => r.id),
  };
}

async function lookupAdminUserId(
  supabase: ReturnType<typeof createAdminClient>,
): Promise<string | null> {
  // Service-role unlocks auth.admin.listUsers. We could query auth.users
  // directly, but auth schema isn't in the Database type — admin API is
  // the typed path.
  const { data, error } = await supabase.auth.admin.listUsers({ perPage: 200 });
  if (error) {
    throw new Error(`auth.admin.listUsers failed: ${error.message}`);
  }
  const adminEmail = requiredEnv(ADMIN_EMAIL_ENV);
  const match = data.users.find(
    (u) => (u.email ?? "").toLowerCase() === adminEmail.toLowerCase(),
  );
  return match?.id ?? null;
}

async function runPhase1(
  supabase: ReturnType<typeof createAdminClient>,
  unverifiedIds: string[],
  adminUserId: string | null,
  orgId: string,
): Promise<{ jobId: string }> {
  console.log("=== PHASE 1 — CASS verify ===");
  console.log(`  property count: ${unverifiedIds.length}`);
  // No parent CSV import — this is a recovery operation. Pass the new
  // job's own id back as parent so createCassChildJob's NOT NULL
  // constraint on parent_job_id is satisfied (it's nullable, but the
  // existing helper expects a uuid). We seed parentJobId with a fresh
  // uuid by inserting a placeholder, then... actually no, parent_job_id
  // IS nullable. Pass null.
  //
  // createCassChildJob signature requires `parentJobId: string`, but
  // we want null. Sidestep the helper for this case and insert
  // directly.
  const { data: created, error: createErr } = await supabase
    .from("jobs")
    .insert({
      type: "cass_dsf2_ncoa",
      org_id: orgId,
      status: "queued",
      provider: "smartystreets",
      created_by: adminUserId,
      total_items: unverifiedIds.length,
      title: `CASS verify ${unverifiedIds.length} recovery properties (2026-04-29)`,
      description:
        "One-off recovery: verify addresses for skip-trace recovery list properties whose first run failed pre-SmartyStreets-paid-plan.",
      input_params: { property_ids: unverifiedIds },
    })
    .select("id")
    .single();

  if (createErr || !created) {
    throw new Error(
      `failed to create CASS recovery job: ${createErr?.message ?? "unknown"}`,
    );
  }
  console.log(`  created CASS job: ${created.id}`);

  const summary = await runCassEnrichment(supabase, {
    jobId: created.id,
    propertyIds: unverifiedIds,
  });

  console.log(`  CASS outcomes:`);
  console.log(`    verified:     ${summary.verified}`);
  console.log(`    invalid:      ${summary.invalid}`);
  console.log(`    ambiguous:    ${summary.ambiguous}`);
  console.log(`    failed:       ${summary.failed}`);
  console.log(`    cache hits:   ${summary.cacheHits}`);
  console.log(`    provider off: ${summary.providerOff}`);
  return { jobId: created.id };
}

async function runPhase2(
  supabase: ReturnType<typeof createAdminClient>,
  preUnverifiedIds: string[],
  adminUserId: string | null,
  orgId: string,
): Promise<{ jobId: string | null; eligibleCount: number }> {
  console.log("");
  console.log("=== PHASE 2 — Re-skip-trace ===");

  // Re-query just the previously-unverified ones; whichever now read
  // 'verified' are eligible.
  const { data: rows, error } = await supabase
    .from("properties")
    .select("id, cass_status, skip_trace_disabled")
    .eq("org_id", orgId)
    .in("id", preUnverifiedIds);

  if (error) {
    throw new Error(`re-query after Phase 1 failed: ${error.message}`);
  }

  const eligible = (rows ?? []).filter(
    (r) => r.cass_status === "verified" && r.skip_trace_disabled !== true,
  );
  const eligibleIds = eligible.map((r) => r.id);
  console.log(
    `  newly verified + skip-trace-eligible: ${eligibleIds.length} of ${preUnverifiedIds.length}`,
  );

  if (eligibleIds.length === 0) {
    console.log("  nothing to skip-trace; Phase 2 skipped.");
    return { jobId: null, eligibleCount: 0 };
  }

  const { data: job, error: insertErr } = await supabase
    .from("jobs")
    .insert({
      type: "skip_trace",
      org_id: orgId,
      provider: "tracerfy",
      status: "queued",
      created_by: adminUserId,
      total_items: eligibleIds.length,
      title: `Skip trace ${eligibleIds.length} recovery properties (2026-04-29)`,
      description:
        "One-off recovery: re-skip-trace post-CASS for list 3241368b-0631-45d1-908b-0322660b387f.",
      input_params: { property_ids: eligibleIds },
    })
    .select("id")
    .single();

  if (insertErr || !job) {
    throw new Error(
      `failed to create skip-trace recovery job: ${insertErr?.message ?? "unknown"}`,
    );
  }
  console.log(`  created skip-trace job: ${job.id}`);

  const run = await start(skipTraceSubmitWorkflow, [{ jobId: job.id, orgId }]);
  console.log(`  durable skip-trace workflow run: ${run.runId}`);
  console.log("  Watch /jobs/<id> for provider/finalization progress.");

  return { jobId: job.id, eligibleCount: eligibleIds.length };
}

async function main() {
  const execute = process.argv.includes("--execute");

  const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL ?? "";
  console.log(`Supabase project URL: ${supabaseUrl || "(missing)"}`);
  if (!supabaseUrl) {
    throw new Error(
      "NEXT_PUBLIC_SUPABASE_URL not set; refusing to run without an explicit project.",
    );
  }

  const supabase = createAdminClient();

  // Phase 0 — dry run report (always)
  const rows = await loadRecoveryProperties(supabase);
  const { unverifiedIds } = printDryRun(rows);
  const orgIds = [...new Set(rows.map((row) => row.org_id))];
  if (orgIds.length !== 1) {
    throw new Error(
      `Recovery list must belong to exactly one organization; found ${orgIds.length}.`,
    );
  }
  const orgId = orgIds[0];

  if (!execute) {
    console.log("Dry-run only. Re-run with --execute to perform Phases 1 + 2.");
    return;
  }

  if (unverifiedIds.length === 0) {
    console.log("No unverified properties found — nothing to execute.");
    return;
  }

  // Pre-flight required env for Phase 1 + 2.
  const need = [
    "SUPABASE_SERVICE_ROLE_KEY",
    "ADDRESS_VERIFIER_PROVIDER",
    "SMARTY_AUTH_ID",
    "SMARTY_AUTH_TOKEN",
    "SKIP_TRACE_PROVIDER",
    "TRACERFY_API_KEY",
    ADMIN_EMAIL_ENV,
  ];
  const missing = need.filter((k) => !process.env[k]);
  if (missing.length > 0) {
    throw new Error(`Missing env vars for execute mode: ${missing.join(", ")}`);
  }

  const adminUserId = await lookupAdminUserId(supabase);
  if (!adminUserId) {
    throw new Error(
      `${ADMIN_EMAIL_ENV} user not found in this project's auth.users — cannot set created_by.`,
    );
  }
  console.log(`Admin user_id for created_by: ${adminUserId}`);

  await runPhase1(supabase, unverifiedIds, adminUserId, orgId);
  await runPhase2(supabase, unverifiedIds, adminUserId, orgId);
  console.log("");
  console.log("Recovery driver done.");
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});
