import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const source = readFileSync(new URL("./actions.ts", import.meta.url), "utf8");

describe("CSV import durable retry contract", () => {
  it("claims a retry with compare-and-set before starting another workflow", () => {
    const retry = source.slice(
      source.indexOf("export async function retryCsvImportJob"),
    );
    expect(retry).toContain(
      '["failed", "partial", "partially_completed"].includes(job.status)',
    );
    expect(retry.indexOf('rpc(\n      "claim_csv_import_retry"')).toBeLessThan(
      retry.indexOf("await start(csvImportWorkflow"),
    );
    expect(retry).toContain('code: "JOB_ALREADY_CLAIMED"');
  });

  it("does not rebuild a retry from member-editable job metadata", () => {
    const retry = source.slice(
      source.indexOf("export async function retryCsvImportJob"),
    );
    expect(retry).toContain('job.type !== "csv_import"');
    expect(retry).toContain('from("csv_import_job_provenance")');
    expect(retry).toContain('.eq("org_id", job.org_id)');
    expect(retry).toContain('from("csv_imports")');
    expect(retry).not.toContain("const input = (job.input_params");
  });

  it("validates storage, list, and sequence ownership before retry", () => {
    const retry = source.slice(
      source.indexOf("export async function retryCsvImportJob"),
    );
    expect(retry).toContain(
      "importRow.storage_path?.startsWith(`${job.org_id}/`)",
    );
    expect(retry).toContain('from("lists")');
    expect(retry).toContain('from("sequences")');
    expect(retry).toContain('"claim_csv_import_retry"');
  });

  it("uses sealed list provenance and verifies every property's tenant", () => {
    const listRetry = source.slice(
      source.indexOf("export async function retryImportListAssignment"),
      source.indexOf("export async function retryCsvImportJob"),
    );
    expect(listRetry).toContain('job.type !== "csv_import"');
    expect(listRetry).toContain('from("csv_import_job_provenance")');
    expect(listRetry).not.toContain("job.input_params");
    expect(listRetry).toContain('from("properties")');
    expect(listRetry).toContain('eq("org_id", job.org_id)');
    expect(listRetry).toContain("verifiedMemberships");
  });

  it("checkpoints start failures only while a job is still queued", () => {
    const checkpoint = source.slice(
      source.indexOf("async function checkpointWorkflowStartFailure"),
      source.indexOf("export async function createImportJob"),
    );
    expect(checkpoint).toContain('.eq("status", "queued")');
    expect(checkpoint).toContain('.select("id")');
    expect(checkpoint).toContain("queued job was not updated");
  });
});
