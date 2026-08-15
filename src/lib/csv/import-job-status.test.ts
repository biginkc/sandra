import { describe, expect, it } from "vitest";

import { importTerminalStatus } from "./import-job-status";

describe("CSV import terminal truthfulness", () => {
  it("does not call an import completed while list assignment failed or remains pending", () => {
    for (const status of ["failed", "pending"] as const) {
      expect(importTerminalStatus({
        totalRows: 10,
        processedRows: 10,
        succeeded: 10,
        failed: 0,
        sideEffects: { listAssignment: { status } },
      })).toBe("partially_completed");
    }
  });

  it("allows completed only after rows and every requested side effect complete", () => {
    expect(importTerminalStatus({
      totalRows: 10,
      processedRows: 10,
      succeeded: 10,
      failed: 0,
      sideEffects: {
        listAssignment: { status: "completed" },
        cass: { status: "completed" },
        skipTrace: { status: "not_requested" },
      },
    })).toBe("completed");
  });

  it("refuses completed while any source rows are still unprocessed", () => {
    expect(importTerminalStatus({
      totalRows: 10,
      processedRows: 9,
      succeeded: 9,
      failed: 0,
      sideEffects: { listAssignment: { status: "completed" } },
    })).toBe("partially_completed");
  });
});
