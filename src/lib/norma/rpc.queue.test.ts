import type { SupabaseClient } from "@supabase/supabase-js";
import { describe, expect, it, vi } from "vitest";

import type { Database } from "@/lib/supabase/types";

import { claimNormaDispatchV2, markNormaSending, NormaMissingFunctionError } from "./rpc";

// RED (H3): the new wrappers follow #793's optional `expectedAttempt` pattern (see claimNormaDispatch / presendNormaFence in rpc.ts):
// the attempt is sent only when defined, so a legacy-style call omits the argument. Transport / RPC errors throw (fail closed).
// PROPOSED wrapper shapes: claimNormaDispatchV2(client, requestId, { expectedAttempt?, now, queueEnabled, maxConcurrent, dailyCap, capTz }) -> string;
// markNormaSending(client, requestId, { dispatchToken?, expectedAttempt? }) -> string ('sending' | 'refused:<reason>').

function client(result: { data?: unknown; error?: { message: string; code?: string } | null }) {
  const rpc = vi.fn().mockResolvedValue({ data: result.data ?? null, error: result.error ?? null });
  return { rpc, client: { rpc } as unknown as SupabaseClient<Database> };
}

const limits = { now: "2030-01-09T16:00:00.000Z", queueEnabled: true, maxConcurrent: 5, dailyCap: 200, capTz: "America/Chicago" };
const wire = { p_now: limits.now, p_queue_enabled: true, p_max_concurrent: 5, p_daily_cap: 200, p_cap_tz: "America/Chicago" };

describe("claimNormaDispatchV2", () => {
  it("includes the attempt only when supplied", async () => {
    const legacy = client({ data: "claimed" });
    await expect(claimNormaDispatchV2(legacy.client, "r", limits)).resolves.toBe("claimed");
    expect(legacy.rpc).toHaveBeenCalledWith("fn_norma_claim_dispatch_v2", { p_request_id: "r", ...wire });
    expect(legacy.rpc.mock.calls[0][1]).not.toHaveProperty("p_expected_attempt");

    const fenced = client({ data: "claimed" });
    await expect(claimNormaDispatchV2(fenced.client, "r", { ...limits, expectedAttempt: 2 })).resolves.toBe("claimed");
    expect(fenced.rpc).toHaveBeenCalledWith("fn_norma_claim_dispatch_v2", { p_request_id: "r", p_expected_attempt: 2, ...wire });
  });

  it("an attempt of 0 is still sent (defined, not truthy)", async () => {
    const t = client({ data: "not_claimed" });
    await claimNormaDispatchV2(t.client, "r", { ...limits, expectedAttempt: 0 });
    expect(t.rpc.mock.calls[0][1]).toMatchObject({ p_expected_attempt: 0 });
  });

  it.each(["capacity_concurrency", "capacity_daily", "number_busy", "queue_refused:window_closed", "ineligible:dnc_locked", "not_claimed"])("returns the database answer %s verbatim", async (answer) => {
    await expect(claimNormaDispatchV2(client({ data: answer }).client, "r", limits)).resolves.toBe(answer);
  });

  it("throws on an RPC error, and flags a missing function distinctly", async () => {
    await expect(claimNormaDispatchV2(client({ error: { message: "boom" } }).client, "r", limits)).rejects.toThrow("fn_norma_claim_dispatch_v2: boom");
    await expect(claimNormaDispatchV2(client({ error: { message: "nope", code: "PGRST202" } }).client, "r", limits)).rejects.toBeInstanceOf(NormaMissingFunctionError);
  });

  it("a non-string answer is not a claim (fails closed)", async () => {
    await expect(claimNormaDispatchV2(client({ data: true }).client, "r", limits)).rejects.toThrow();
  });
});

describe("markNormaSending", () => {
  it("includes the attempt and the dispatch token only when supplied", async () => {
    const bare = client({ data: "sending" });
    await expect(markNormaSending(bare.client, "r")).resolves.toBe("sending");
    expect(bare.rpc).toHaveBeenCalledWith("fn_norma_mark_sending", { p_request_id: "r" });

    const attempt = client({ data: "sending" });
    await markNormaSending(attempt.client, "r", { expectedAttempt: 2 });
    expect(attempt.rpc).toHaveBeenCalledWith("fn_norma_mark_sending", { p_request_id: "r", p_expected_attempt: 2 });

    const token = client({ data: "sending" });
    await markNormaSending(token.client, "r", { dispatchToken: "tok", expectedAttempt: 1 });
    expect(token.rpc).toHaveBeenCalledWith("fn_norma_mark_sending", { p_request_id: "r", p_dispatch_token: "tok", p_expected_attempt: 1 });
  });

  it("returns a refusal verbatim", async () => {
    await expect(markNormaSending(client({ data: "refused:window_closed" }).client, "r")).resolves.toBe("refused:window_closed");
  });

  it("throws on an RPC error, and flags a missing function distinctly", async () => {
    await expect(markNormaSending(client({ error: { message: "timeout" } }).client, "r", { expectedAttempt: 1 })).rejects.toThrow("fn_norma_mark_sending: timeout");
    await expect(markNormaSending(client({ error: { message: "nope", code: "42883" } }).client, "r")).rejects.toBeInstanceOf(NormaMissingFunctionError);
  });

  it("a non-string answer fails closed", async () => {
    await expect(markNormaSending(client({ data: true }).client, "r")).rejects.toThrow();
  });
});
