import { readFileSync } from "node:fs";

import { describe, expect, it } from "vitest";

describe("2026-04-29 recovery workflow contract", () => {
  it("enqueues skip trace through durable workflow start", () => {
    const source = readFileSync(
      new URL("../../scripts/run-recovery-2026-04-29.ts", import.meta.url),
      "utf8",
    );

    expect(source).toContain('import { start } from "workflow/api"');
    expect(source).toContain(
      "await start(skipTraceSubmitWorkflow, [{ jobId: job.id, orgId }])",
    );
    expect(source).not.toContain(
      "await skipTraceSubmitWorkflow({ jobId: job.id, orgId })",
    );
    expect(source).toContain("run.runId");
  });
});
