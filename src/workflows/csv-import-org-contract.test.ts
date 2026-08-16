import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const source = readFileSync(
  new URL("./csv-import.ts", import.meta.url),
  "utf8",
);

describe("CSV import service-role tenant contract", () => {
  it("records consent through the tenant-scoped idempotent database boundary", () => {
    const consent = source.slice(
      source.indexOf("async function recordConsentStep"),
      source.indexOf("async function selectNonDncPropertyIds"),
    );
    expect(consent).toContain("orgId: string");
    expect(consent).toMatch(/\.rpc\(\s*"record_csv_import_consents"/);
    expect(consent).toContain("p_org_id: args.orgId");
    expect(source).toContain(
      "recordConsentStep({ jobId: params.jobId, orgId: params.orgId })",
    );
  });

  it("scopes durable phone suppressions to the import organization and SMS channel", () => {
    const selector = source.slice(
      source.indexOf("async function selectNonDncPropertyIds"),
      source.indexOf("async function excludeComplianceLockedJobProperties"),
    );
    expect(selector).toContain("orgId: string");
    expect(selector).toContain('.eq("org_id", orgId)');
    expect(selector).toContain('.eq("channel", "sms")');
  });

  it("keeps legacy county recovery in a durable step and validates job/import tenant identity", () => {
    const workflow = source.slice(
      source.indexOf("export async function csvImportWorkflow"),
    );
    expect(source).toContain("async function recoverCountyStep");
    expect(
      source.slice(
        source.indexOf("async function recoverCountyStep"),
        source.indexOf("async function loadCsvFromStorage"),
      ),
    ).toContain('"use step"');
    expect(workflow).toContain("await recoverCountyStep");
    expect(workflow).not.toContain("createAdminClient()");
  });

  it("durably checkpoints exhausted workflow failures from authoritative item counts", () => {
    expect(source).toContain("async function failCsvImportWorkflowStep");
    expect(source).toContain('rpc("fail_csv_import_workflow"');
    const workflow = source.slice(
      source.indexOf("export async function csvImportWorkflow"),
    );
    expect(workflow).toContain("catch (error)");
    expect(workflow).toContain("await failCsvImportWorkflowStep");
  });
});
