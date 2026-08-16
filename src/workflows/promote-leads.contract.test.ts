import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const source = readFileSync(new URL("./promote-leads.ts", import.meta.url), "utf8");

describe("promote-leads workflow contract", () => {
  it("accepts only a durable job id and loads its audience from the database", () => {
    expect(source).toMatch(/type PromoteLeadsWorkflowParams = \{\s*jobId: string;\s*\}/);
    expect(source).not.toMatch(/PromoteLeadsWorkflowParams[\s\S]{0,120}propertyIds/);
    expect(source).toContain('.eq("type", "promote_leads")');
    expect(source).toContain('.eq("status", "queued")');
    expect(source).toContain('.eq("job_id", jobId)');
    expect(source).toContain('job.status !== "running" || job.workflow_claim_token !== claimToken');
    expect(source).toMatch(/Object\.assign\(claimPromotionJob, \{ maxRetries: [1-9]\d* \}\)/);
    expect(source).toContain("createPromotionClaimToken");
    expect(source).toContain("workflow_claim_token: claimToken");
    expect(source).toContain('.is("workflow_claim_token", null)');
  });

  it("uses fixed chunks and ledger recomputation rather than a request-bound serial action", () => {
    expect(source).toMatch(/const CHUNK_SIZE = \d+/);
    expect(source).toContain("while (true)");
    expect(source).toContain("loadPendingPromotionChunk");
    expect(source).toContain(".limit(CHUNK_SIZE)");
    expect(source).toContain("runPromoteLeadsChunk");
    expect(source).toContain('"promote_leads_recompute_job"');
    expect(source).toContain('"fail_promote_leads_workflow"');
    expect(source).toMatch(/catch \(error\)[\s\S]+checkpointPromotionWorkflowFailure/);
    expect(source).toContain('"use workflow"');
    expect(source).toContain('"use step"');
  });
});
