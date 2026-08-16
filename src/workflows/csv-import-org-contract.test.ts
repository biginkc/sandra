import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const source = readFileSync(new URL("./csv-import.ts", import.meta.url), "utf8");

describe("CSV import service-role tenant contract", () => {
  it("threads org identity into consent lookups and writes", () => {
    const consent = source.slice(
      source.indexOf("async function recordConsentStep"),
      source.indexOf("async function selectNonDncPropertyIds"),
    );
    expect(consent).toContain("orgId: string");
    expect(consent).toContain('.eq("org_id", args.orgId)');
    expect(consent).toContain("org_id: args.orgId");
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
});
