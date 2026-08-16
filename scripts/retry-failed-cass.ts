/**
 * One-off recovery script: retry CASS verification for properties whose
 * prior CASS run failed.
 *
 * Tonight's specific case: the 374 properties whose CASS write-back
 * collided with the partial unique index on (fips_code, apn_normalized).
 * Those properties' addresses were successfully verified by SmartyStreets
 * (the cache has the result); the failure was at the DB UPDATE step. With
 * the corrupted APNs now nulled, the UPDATEs should succeed — and because
 * cass_cache has the verified result, no new SmartyStreets API calls fire.
 *
 * Usage:
 *   npx tsx scripts/retry-failed-cass.ts <failed-job-id>
 *
 * The script:
 *   1. Queries job_items where job_id=<failed-job-id> AND status=error,
 *      collecting distinct property_ids.
 *   2. Creates a fresh cass_dsf2_ncoa job linked to the same import.
 *   3. Runs runCassEnrichment, which uses cache-through verification.
 *   4. Prints final per-status counts.
 */

import { createAdminClient } from "../src/lib/supabase/admin";
import {
  createCassChildJob,
  runCassEnrichment,
} from "../src/lib/enrichment/cass-job";

async function main() {
  const [, , failedJobId] = process.argv;
  if (!failedJobId) {
    console.error("Usage: npx tsx scripts/retry-failed-cass.ts <failed-job-id>");
    process.exit(1);
  }

  const supabase = createAdminClient();

  // Pull the parent's metadata so the new job is linked correctly.
  const { data: parentJob, error: parentErr } = await supabase
    .from("jobs")
    .select("org_id, parent_job_id, related_import_id, created_by")
    .eq("id", failedJobId)
    .single();

  if (parentErr || !parentJob) {
    console.error(`Failed job ${failedJobId} not found:`, parentErr?.message);
    process.exit(1);
  }

  const { data: items, error: itemsErr } = await supabase
    .from("job_items")
    .select("property_id")
    .eq("job_id", failedJobId)
    .eq("status", "error")
    .not("property_id", "is", null);

  if (itemsErr) {
    console.error(`Failed to query job_items:`, itemsErr.message);
    process.exit(1);
  }

  const propertyIds = Array.from(
    new Set(
      (items ?? [])
        .map((r) => r.property_id)
        .filter((id): id is string => typeof id === "string"),
    ),
  );

  if (propertyIds.length === 0) {
    console.log("No failed property IDs found. Nothing to retry.");
    return;
  }

  console.log(
    `→ Retrying ${propertyIds.length} properties from failed job ${failedJobId}`,
  );

  const childId = await createCassChildJob(supabase, {
    parentJobId: parentJob.parent_job_id ?? failedJobId,
    relatedImportId: parentJob.related_import_id,
    createdBy: parentJob.created_by,
    orgId: parentJob.org_id,
    propertyIds,
    autoStart: true,
  });
  console.log(`  created retry job: ${childId}`);

  const summary = await runCassEnrichment(supabase, {
    jobId: childId,
    propertyIds,
    expectedOrgId: parentJob.org_id,
  });

  console.log(`\nFinal counts:`);
  console.log(`  Verified:      ${summary.verified}`);
  console.log(`  Invalid:       ${summary.invalid}`);
  console.log(`  Ambiguous:     ${summary.ambiguous}`);
  console.log(`  Failed:        ${summary.failed}`);
  console.log(`  Cache hits:    ${summary.cacheHits}`);
  console.log(`  Provider off:  ${summary.providerOff}`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
