import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const source = readFileSync(new URL("./actions.ts", import.meta.url), "utf8");

describe("CSV import durable retry contract", () => {
  it("claims a retry with compare-and-set before starting another workflow", () => {
    const retry = source.slice(source.indexOf("export async function retryCsvImportJob"));
    expect(retry).toContain('.in("status", ["failed", "partial", "partially_completed"])');
    expect(retry.indexOf('.update({ status: "queued"')).toBeLessThan(
      retry.indexOf("await start(csvImportWorkflow"),
    );
    expect(retry).toContain('code: "JOB_ALREADY_CLAIMED"');
  });

  it("persists recovered list identity before completion can be reported", () => {
    const listRetry = source.slice(
      source.indexOf("export async function retryImportListAssignment"),
      source.indexOf("export async function retryCsvImportJob"),
    );
    expect(listRetry).toContain("verifiedMemberships");
    expect(listRetry).toContain("listResolutionError: null");
    expect(listRetry).toContain("input_params:");
  });
});
