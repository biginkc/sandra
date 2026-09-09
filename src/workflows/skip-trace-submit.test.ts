import { createClient } from "@supabase/supabase-js";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Database } from "@/lib/supabase/types";

const mocks = vi.hoisted(() => ({ admin: vi.fn(), provider: vi.fn(), report: vi.fn() }));
vi.mock("@/lib/errors/report", () => ({ reportError: mocks.report }));
vi.mock("@/lib/supabase/admin", () => ({ createAdminClient: mocks.admin }));
vi.mock("@/lib/skip-trace/registry", () => ({ getSkipTraceProvider: mocks.provider }));
vi.mock("@/lib/skip-trace/eligibility", async (original) => ({
  ...await original<typeof import("@/lib/skip-trace/eligibility")>(),
  resolveSkipTraceEligibility: vi.fn(async (_client, params) => ({ eligibleIds: params.propertyIds, exclusions: [] })),
}));
import { skipTraceSubmitWorkflow } from "./skip-trace-submit";

// Real runner and PostgREST serialization; only the transport and eligibility
// inputs are simulated. Never contacts Supabase or a paid provider.
function fixture(count: number, failRead = false, fault?: "claim" | "persist" | "PGRST202" | "42883") {
  const ids = Array.from({ length: count }, () => crypto.randomUUID());
  const job: {
    id: string; org_id: string; status: string;
    input_params: Record<string, unknown>; result_summary: Record<string, unknown>;
    error_message?: string; [key: string]: unknown;
  } = { id: crypto.randomUUID(), org_id: crypto.randomUUID(), type: "skip_trace", created_at: new Date().toISOString(), status: "queued", total_items: count, input_params: { property_ids: ids }, provider_run_id: null, worker_heartbeat_at: null, result_summary: {} };
  let maxUrl = 0;
  const transport = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(String(input));
    maxUrl = Math.max(maxUrl, url.href.length);
    const reply = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
    // A generous 32 KiB gateway limit still rejects the 3,206-ID CAS URL.
    if (url.href.length > 32768) return reply({ message: "414 Request-URI Too Large" }, 414);
    if (init?.method === "POST" && url.pathname.endsWith("/rpc/claim_skip_trace_submission")) {
      if (fault === "PGRST202" || fault === "42883") return reply({ code: fault, message: "function claim_skip_trace_submission does not exist" }, 404);
      if (fault === "claim") return reply({ code: "42501", message: "injected claim failure" }, 403);
      const p = JSON.parse(String(init.body));
      Object.assign(job, { status: "running", started_at: p.p_claim_time, total_items: p.p_property_ids.length, input_params: p.p_input_params, worker_heartbeat_at: p.p_claim_time });
      return reply([{ id: job.id, title: null, description: null }]);
    }
    if (init?.method === "PATCH") {
      const patch = JSON.parse(String(init.body));
      if (fault === "persist" && patch.status === "failed") return reply({ message: "injected failure-write error" }, 400);
      const matches = [...url.searchParams].every(([key, value]) => {
        if (value.startsWith("eq.")) return String(job[key]) === value.slice(3);
        if (value === "is.null") return job[key] == null;
        return true;
      });
      if (matches) Object.assign(job, patch);
      return reply(matches ? [{ id: job.id, title: null, description: null }] : []);
    }
    if (failRead && job.result_summary.submit_phase === "prepared") return reply({ message: "injected authorization read failure" }, 400);
    return reply(job);
  });
  mocks.admin.mockReturnValue(createClient<Database>("https://local.invalid", "test-key", { global: { fetch: transport }, auth: { persistSession: false } }));
  // Stop after the real inner claim, before any provider work.
  mocks.provider.mockReturnValue(null);
  return { job, transport, maxUrl: () => maxUrl };
}

describe("skip-trace submit claim gap", () => {
  beforeEach(() => { vi.clearAllMocks(); });
  afterEach(() => { vi.restoreAllMocks(); });
  it("writes the inner submission token for 3,206 IDs without an oversized URL", async () => {
    const { job, maxUrl } = fixture(3206);
    await skipTraceSubmitWorkflow({ jobId: job.id, orgId: job.org_id });
    expect(job.input_params.submission_attempt_token).toEqual(expect.any(String));
    expect(maxUrl()).toBeLessThan(32768);
  });
  it("persists an authorization-read failure instead of leaving the prepared job queued", async () => {
    const { job } = fixture(2, true);
    await skipTraceSubmitWorkflow({ jobId: job.id, orgId: job.org_id }).catch(() => undefined);
    expect(job.status).toBe("failed");
    expect(job.error_message).toContain("injected authorization read failure");
  });
  it("marks a throw before the inner claim failed with its error text", async () => {
    const { job } = fixture(2);
    vi.spyOn(crypto, "randomUUID").mockImplementationOnce(() => { throw new Error("injected token failure"); });
    await skipTraceSubmitWorkflow({ jobId: job.id, orgId: job.org_id }).catch(() => undefined);
    expect(job.status).toBe("failed");
    expect(job.error_message).toContain("injected token failure");
  });
  it.each(["PGRST202", "42883"] as const)("defers missing-function %s without failing the queued job", async (code) => {
    const { job, transport } = fixture(2, false, code);
    job.created_at = new Date(Date.now() - 14 * 60 * 1000).toISOString();
    await expect(skipTraceSubmitWorkflow({ jobId: job.id, orgId: job.org_id })).resolves.toEqual({ status: "claim_lost", jobId: job.id });
    expect(job.status).toBe("queued");
    expect(job.error_message).toBeUndefined();
    expect(job.input_params.submission_attempt_token).toBeUndefined();
    expect(mocks.provider).not.toHaveBeenCalled();
    expect(mocks.report).toHaveBeenCalledWith(expect.objectContaining({ message: expect.stringContaining(`missing function claim_skip_trace_submission (${code})`) }), expect.objectContaining({ tags: { surface: "skip_trace_claim_rpc_missing", deferred: true } }));
    expect(transport.mock.calls.some(([, init]) => init?.method === "PATCH" && JSON.parse(String(init.body)).status === "failed")).toBe(false);
  });
  it.each(["PGRST202", "42883"] as const)("fails missing-function %s beyond the defer bound", async (code) => {
    const { job, transport } = fixture(2, false, code);
    job.created_at = new Date(Date.now() - 16 * 60 * 1000).toISOString();
    const message = `missing function claim_skip_trace_submission (${code}): function claim_skip_trace_submission does not exist`;
    await expect(skipTraceSubmitWorkflow({ jobId: job.id, orgId: job.org_id })).rejects.toThrow(message);
    expect(job.status).toBe("failed");
    expect(job.error_message).toContain(message);
    expect(job.error_message).toContain("15-minute defer window");
    expect(mocks.provider).not.toHaveBeenCalled();
    expect(mocks.report).toHaveBeenCalledWith(expect.any(Error), expect.objectContaining({ tags: { surface: "skip_trace_claim_rpc_missing", deferred: false } }));
    const failureWrites = transport.mock.calls.filter(([, init]) => init?.method === "PATCH" && JSON.parse(String(init.body)).status === "failed");
    expect(failureWrites).toHaveLength(1);
    expect(new URL(String(failureWrites[0][0])).searchParams.get("worker_heartbeat_at")).toBe(`eq.${job.worker_heartbeat_at}`);
  });
  it("surfaces an RPC error as failed, while retaining its message", async () => {
    const { job } = fixture(3206, false, "claim");
    await expect(skipTraceSubmitWorkflow({ jobId: job.id, orgId: job.org_id })).rejects.toThrow("injected claim failure");
    expect(job.status).toBe("failed");
    expect(job.error_message).toContain("injected claim failure");
    expect(job.input_params.submission_attempt_token).toBeUndefined();
  });
  it("does not overwrite a newer prepared owner on a stale step failure", async () => {
    const { job, transport } = fixture(2);
    vi.spyOn(crypto, "randomUUID").mockImplementationOnce(() => {
      job.worker_heartbeat_at = "2099-01-01T00:00:00.000Z";
      throw new Error("stale step failure");
    });
    await expect(skipTraceSubmitWorkflow({ jobId: job.id, orgId: job.org_id })).rejects.toThrow("stale step failure");
    // Prove the failure handler ran: old code that simply rethrows must not pass.
    const failureWrites = transport.mock.calls.filter(([, init]) => init?.method === "PATCH" && JSON.parse(String(init.body)).status === "failed");
    expect(failureWrites).toHaveLength(1);
    expect(job.status).toBe("queued");
    expect(job.worker_heartbeat_at).toBe("2099-01-01T00:00:00.000Z");
    expect(job.error_message).toBeUndefined();
  });
  it("throws both errors if persisting the failure also fails", async () => {
    const { job } = fixture(2, true, "persist");
    await expect(skipTraceSubmitWorkflow({ jobId: job.id, orgId: job.org_id })).rejects.toThrow(
      /injected authorization read failure; failed to persist job failure: injected failure-write error/,
    );
  });
});
