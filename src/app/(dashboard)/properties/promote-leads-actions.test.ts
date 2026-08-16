import { beforeEach, describe, expect, it, vi } from "vitest";

const { sessionRpc, sessionFrom, adminRpc, startWorkflow, revalidatePath, getCallerMemberships } = vi.hoisted(() => ({
  sessionRpc: vi.fn(),
  sessionFrom: vi.fn(),
  adminRpc: vi.fn(),
  startWorkflow: vi.fn(),
  revalidatePath: vi.fn(),
  getCallerMemberships: vi.fn(),
}));

vi.mock("@/lib/supabase/server", () => ({
  createClient: vi.fn(async () => ({ rpc: sessionRpc, from: sessionFrom })),
}));
vi.mock("@/lib/auth/memberships", () => ({ getCallerMemberships }));
vi.mock("@/lib/supabase/admin", () => ({
  createAdminClient: vi.fn(() => ({ rpc: adminRpc })),
}));
vi.mock("workflow/api", () => ({ start: startWorkflow }));
vi.mock("next/cache", () => ({ revalidatePath }));
vi.mock("@/lib/errors/report", () => ({ reportError: vi.fn() }));

import {
  createPromoteLeadsJob,
  preflightPromoteLeads,
  retryPromoteLeadsJob,
} from "./promote-leads-actions";

const request = {
  orgId: "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa",
  propertyIds: ["10000000-0000-0000-0000-000000000001"],
  idempotencyKey: "30000000-0000-0000-0000-000000000001",
};

beforeEach(() => {
  sessionRpc.mockReset();
  sessionFrom.mockReset();
  adminRpc.mockReset();
  startWorkflow.mockReset();
  revalidatePath.mockReset();
  getCallerMemberships.mockReset();
  getCallerMemberships.mockResolvedValue([{ org_id: request.orgId }]);
  startWorkflow.mockResolvedValue({ runId: "run-1" });
  adminRpc.mockResolvedValue({ data: { failed: 1, status: "failed" }, error: null });
});

describe("promotion server actions", () => {
  it("counts an unbounded cross-page selection in bounded database chunks", async () => {
    const propertyIds = Array.from(
      { length: 1_201 },
      (_, index) => `10000000-0000-0000-0000-${String(index + 1).padStart(12, "0")}`,
    );
    const queriedChunks: string[][] = [];
    sessionFrom.mockImplementation(() => ({
      select: () => ({
        eq: () => ({
          in: (_column: string, ids: string[]) => {
            queriedChunks.push(ids);
            return {
              is: async () => ({
                data: ids.map((id) => ({ id, status: "prospect", is_dnc_locked: false })),
                error: null,
              }),
            };
          },
        }),
      }),
    }));

    const result = await preflightPromoteLeads({ orgId: request.orgId, propertyIds });

    expect(result).toEqual({
      ok: true,
      data: { selected: 1_201, eligible: 1_201, dncLocked: 0, staleOrNotProspect: 0 },
    });
    expect(queriedChunks.map((chunk) => chunk.length)).toEqual([500, 500, 201]);
  });

  it("creates the durable transaction and starts a jobId-only workflow", async () => {
    sessionRpc.mockResolvedValue({
      data: { job_id: "job-1", duplicate: false, status: "queued", counts: { pending: 1 } },
      error: null,
    });

    const result = await createPromoteLeadsJob(request);

    expect(result).toEqual({
      ok: true,
      data: expect.objectContaining({ jobId: "job-1", status: "queued", workflowRunId: "run-1" }),
    });
    expect(startWorkflow).toHaveBeenCalledWith(expect.any(Function), [{ jobId: "job-1" }]);
    expect(JSON.stringify(startWorkflow.mock.calls)).not.toContain("propertyIds");
  });

  it("durably checkpoints workflow-start failure and reports that the job did not start", async () => {
    sessionRpc.mockResolvedValue({
      data: { job_id: "job-2", duplicate: false, status: "queued", counts: { pending: 1 } },
      error: null,
    });
    startWorkflow.mockRejectedValue(new Error("workflow unavailable"));

    const result = await createPromoteLeadsJob(request);

    expect(adminRpc).toHaveBeenCalledWith("fail_promote_leads_workflow_start", {
      p_job: "job-2",
      p_error: "workflow unavailable",
    });
    expect(result).toEqual({
      ok: true,
      data: expect.objectContaining({ jobId: "job-2", status: "failed_to_start" }),
    });
  });

  it("surfaces a checkpoint failure rather than claiming a safely failed job", async () => {
    sessionRpc.mockResolvedValue({
      data: { job_id: "job-3", duplicate: false, status: "queued", counts: {} },
      error: null,
    });
    startWorkflow.mockRejectedValue(new Error("workflow unavailable"));
    adminRpc.mockResolvedValue({ data: null, error: { message: "checkpoint unavailable" } });

    const result = await createPromoteLeadsJob(request);
    expect(result).toEqual({
      ok: false,
      error: expect.objectContaining({ code: "PROMOTION_START_CHECKPOINT_FAILED" }),
    });
  });

  it("reports the durable job state when workflow start throws after the job already began", async () => {
    sessionRpc.mockResolvedValue({
      data: { job_id: "job-race", duplicate: false, status: "queued", counts: { pending: 1 } },
      error: null,
    });
    startWorkflow.mockRejectedValue(new Error("response lost after enqueue"));
    adminRpc.mockResolvedValue({ data: { pending: 1, status: "running" }, error: null });

    const result = await createPromoteLeadsJob(request);

    expect(result).toEqual({
      ok: true,
      data: expect.objectContaining({ jobId: "job-race", status: "running" }),
    });
  });

  it("does not restart a terminal replay", async () => {
    sessionRpc.mockResolvedValue({
      data: { job_id: "job-4", duplicate: true, status: "completed", counts: { promoted: 1 } },
      error: null,
    });
    const result = await createPromoteLeadsJob(request);
    expect(result.ok).toBe(true);
    expect(startWorkflow).not.toHaveBeenCalled();
  });

  it("rejects malformed property IDs instead of silently dropping forged input", async () => {
    const result = await createPromoteLeadsJob({
      ...request,
      propertyIds: [...request.propertyIds, "not-a-property-id"],
    });

    expect(result).toEqual({
      ok: false,
      error: expect.objectContaining({ code: "PROMOTION_INVALID_REQUEST" }),
    });
    expect(sessionRpc).not.toHaveBeenCalled();
    expect(startWorkflow).not.toHaveBeenCalled();
  });

  it("retries through the retry RPC and starts only the returned child job", async () => {
    sessionRpc.mockResolvedValue({
      data: { job_id: "child-1", duplicate: false, status: "queued", counts: { pending: 1 } },
      error: null,
    });
    const result = await retryPromoteLeadsJob({
      parentJobId: "parent-1",
      idempotencyKey: request.idempotencyKey,
    });
    expect(result.ok).toBe(true);
    expect(sessionRpc).toHaveBeenCalledWith("retry_promote_leads_job", {
      p_parent_job: "parent-1",
      p_idempotency_key: request.idempotencyKey,
    });
    expect(startWorkflow).toHaveBeenCalledWith(expect.any(Function), [{ jobId: "child-1" }]);
  });
});
