import { beforeEach, describe, expect, it } from "vitest";

import { createTestClient } from "@tests/integration/client";
import { resetTenantTables } from "@tests/integration/reset";

const supabase = createTestClient();

type RpcClient = {
  rpc: (
    name: string,
    args: Record<string, unknown>,
  ) => Promise<{
    data: unknown;
    error: { message: string } | null;
  }>;
};

async function rpc(name: string, args: Record<string, unknown>) {
  return (supabase as unknown as RpcClient).rpc(name, args);
}

async function seedLineTypeJob(): Promise<{ jobId: string; orgId: string }> {
  const { data: org } = await supabase
    .from("organizations")
    .select("id")
    .limit(1)
    .single();
  const { data: county } = await supabase
    .from("counties")
    .select("id, market")
    .limit(1)
    .single();
  if (!org || !county) throw new Error("tenant seed is missing");

  const { data: csvImport, error: importError } = await supabase
    .from("csv_imports")
    .insert({
      org_id: org.id,
      filename: "line-type-ledger.csv",
      source: "generic",
      market: county.market,
      county_id: county.id,
      storage_path: `${org.id}/line-type-ledger.csv`,
      dataset_sha256: "a".repeat(64),
      dataset_version: 2,
      dnc_rows: 0,
      total_rows: 1,
    })
    .select("id")
    .single();
  if (importError || !csvImport) throw importError ?? new Error("import seed failed");

  const { data: job, error: jobError } = await supabase
    .from("jobs")
    .insert({
      org_id: org.id,
      type: "csv_import",
      status: "running",
      related_import_id: csvImport.id,
      retry_count: 0,
      max_retries: 3,
      total_items: 1,
    })
    .select("id")
    .single();
  if (jobError || !job) throw jobError ?? new Error("job seed failed");

  const { error: provenanceError } = await supabase
    .from("csv_import_job_provenance")
    .insert({
      job_id: job.id,
      org_id: org.id,
      csv_import_id: csvImport.id,
      storage_path: `${org.id}/line-type-ledger.csv`,
      source: "generic",
      market: county.market,
      county_id: county.id,
      mapping: { address: "Address" },
      classify_line_types: true,
      dataset_sha256: "a".repeat(64),
      review_contract_sha256: "b".repeat(64),
      dataset_version: 2,
      expected_total_rows: 1,
      expected_dnc_rows: 0,
    });
  if (provenanceError) throw provenanceError;
  return { jobId: job.id, orgId: org.id };
}

describe("CSV import line-type outcome ledger", () => {
  beforeEach(async () => {
    await resetTenantTables(supabase);
  });

  it("allows one paid claim and reuses its terminal classification", async () => {
    const { jobId, orgId } = await seedLineTypeJob();
    const phone = "+18165550001";
    const [first, concurrentReplay] = await Promise.all([
      rpc("claim_csv_import_line_type_lookup", {
        p_job_id: jobId,
        p_org_id: orgId,
        p_phone_e164: phone,
      }),
      rpc("claim_csv_import_line_type_lookup", {
        p_job_id: jobId,
        p_org_id: orgId,
        p_phone_e164: phone,
      }),
    ]);
    expect(first.error).toBeNull();
    expect(concurrentReplay.error).toBeNull();
    const actions = [first.data, concurrentReplay.data]
      .flat()
      .map((row) => (row as { action: string }).action)
      .sort();
    expect(actions).toEqual(["ambiguous", "claimed"]);

    const completed = await rpc("complete_csv_import_line_type_lookup", {
      p_job_id: jobId,
      p_org_id: orgId,
      p_phone_e164: phone,
      p_state: "completed",
      p_line_type: "mobile",
      p_outcome: "classified",
      p_provider_http_status: 200,
      p_last_error: null,
    });
    expect(completed.error).toBeNull();

    const replay = await rpc("claim_csv_import_line_type_lookup", {
      p_job_id: jobId,
      p_org_id: orgId,
      p_phone_e164: phone,
    });
    expect(replay.error).toBeNull();
    expect(replay.data).toEqual([
      { action: "reused", line_type: "mobile", outcome: "classified" },
    ]);
  });

  it("requires a later persisted job retry before re-claiming a rejected lookup", async () => {
    const { jobId, orgId } = await seedLineTypeJob();
    const phone = "+18165550002";
    await rpc("claim_csv_import_line_type_lookup", {
      p_job_id: jobId,
      p_org_id: orgId,
      p_phone_e164: phone,
    });
    const checkpoint = await rpc("complete_csv_import_line_type_lookup", {
      p_job_id: jobId,
      p_org_id: orgId,
      p_phone_e164: phone,
      p_state: "retryable",
      p_line_type: "unknown",
      p_outcome: "provider_rejected",
      p_provider_http_status: 503,
      p_last_error: "explicit provider rejection",
    });
    expect(checkpoint.error).toBeNull();

    const sameAttempt = await rpc("claim_csv_import_line_type_lookup", {
      p_job_id: jobId,
      p_org_id: orgId,
      p_phone_e164: phone,
    });
    expect(sameAttempt.data).toEqual([
      {
        action: "retry_blocked",
        line_type: "unknown",
        outcome: "provider_rejected",
      },
    ]);

    await supabase
      .from("jobs")
      .update({ retry_count: 1 })
      .eq("id", jobId)
      .eq("org_id", orgId);
    const nextJobRetry = await rpc("claim_csv_import_line_type_lookup", {
      p_job_id: jobId,
      p_org_id: orgId,
      p_phone_e164: phone,
    });
    expect(nextJobRetry.data).toEqual([
      { action: "claimed", line_type: null, outcome: null },
    ]);
  });
});
