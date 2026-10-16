import { describe, expect, it, vi } from "vitest";
import type { SupabaseClient } from "@supabase/supabase-js";

import type { Database } from "@/lib/supabase/types";

import {
  bindNormaCallId,
  checkNormaEligibility,
  claimNormaDispatch,
  completeNormaCall,
  createNormaRequest,
  isNormaHoldActive,
  markNormaDispatchRejected,
  markNormaDispatchUnknown,
  markNormaNeedsReview,
  presendNormaFence,
  releaseNormaPauses,
  sweepResumeCallInProgress,
  upgradeNormaHoldPauses,
} from "./rpc";

function client(result: { data?: unknown; error?: { message: string; code?: string } | null }) {
  const rpc = vi.fn().mockResolvedValue({ data: result.data ?? null, error: result.error ?? null });
  return { rpc, client: { rpc } as unknown as SupabaseClient<Database> };
}

const eligibilityParams = { propertyId: "p", contactId: "c", phoneE164: "+18165550100" };

describe("norma rpc wrappers", () => {
  it("eligibility passes the exact arguments and returns eligible only on an explicit true", async () => {
    const ok = client({ data: [{ eligible: true, block_reason: null }] });
    await expect(checkNormaEligibility(ok.client, eligibilityParams)).resolves.toEqual({ eligible: true });
    expect(ok.rpc).toHaveBeenCalledWith("fn_norma_eligibility", {
      p_property_id: "p",
      p_contact_id: "c",
      p_phone_e164: "+18165550100",
    });
  });

  it("eligibility fails closed on an RPC error, an empty result or a malformed row", async () => {
    for (const bad of [
      client({ error: { message: "timeout" } }),
      client({ data: [] }),
      client({ data: null }),
      client({ data: [{ block_reason: null }] }),
      client({ data: [{ eligible: "true" }] }),
    ]) {
      await expect(checkNormaEligibility(bad.client, eligibilityParams)).resolves.toEqual({
        eligible: false,
        reason: "eligibility_check_failed",
      });
    }
    const blocked = client({ data: [{ eligible: false, block_reason: "global_dnc_registry" }] });
    await expect(checkNormaEligibility(blocked.client, eligibilityParams)).resolves.toEqual({
      eligible: false,
      reason: "global_dnc_registry",
    });
  });

  it("createNormaRequest maps created / already_open / blocked and throws on an RPC error", async () => {
    const params = {
      propertyId: "p", contactId: "c", phoneE164: "+18165550100",
      requestedBy: "u", repContext: null, callbackAssigneeId: "a",
    };
    await expect(
      createNormaRequest(client({ data: [{ outcome: "created", request_id: "r", idempotency_key: "k", block_reason: null }] }).client, params),
    ).resolves.toEqual({ status: "created", requestId: "r", idempotencyKey: "k" });
    await expect(
      createNormaRequest(client({ data: [{ outcome: "already_open", request_id: "r0", idempotency_key: null, block_reason: null }] }).client, params),
    ).resolves.toEqual({ status: "already_open", requestId: "r0" });
    await expect(
      createNormaRequest(client({ data: [{ outcome: "blocked", request_id: null, idempotency_key: null, block_reason: "not_interested" }] }).client, params),
    ).resolves.toEqual({ status: "blocked", reason: "not_interested" });
    // a "created" row without ids is never trusted
    await expect(
      createNormaRequest(client({ data: [{ outcome: "created", request_id: null, idempotency_key: null, block_reason: null }] }).client, params),
    ).resolves.toMatchObject({ status: "blocked" });
    await expect(createNormaRequest(client({ error: { message: "boom" } }).client, params)).rejects.toThrow("fn_norma_create_request: boom");
    await expect(createNormaRequest(client({ data: [] }).client, params)).rejects.toThrow("empty result");
  });

  it("dispatch claim, bind and hold helpers pass through and throw on errors", async () => {
    await expect(claimNormaDispatch(client({ data: true }).client, "r")).resolves.toBe(true);
    await expect(claimNormaDispatch(client({ data: false }).client, "r")).resolves.toBe(false);
    await expect(claimNormaDispatch(client({ error: { message: "x" } }).client, "r")).rejects.toThrow();
    await expect(bindNormaCallId(client({ data: "already_completed" }).client, "r", "c")).resolves.toBe("already_completed");
    await expect(isNormaHoldActive(client({ data: true }).client, "p")).resolves.toBe(true);
    await expect(isNormaHoldActive(client({ data: null }).client, "p")).resolves.toBe(false);
    await expect(isNormaHoldActive(client({ error: { message: "x" } }).client, "p")).rejects.toThrow();
    await expect(releaseNormaPauses(client({ data: 2 }).client, "r")).resolves.toBe(2);
  });

  it("presend fence includes an attempt when supplied and preserves the legacy omission", async () => {
    const legacy = client({ data: true });
    await expect(presendNormaFence(legacy.client, "r")).resolves.toBe(true);
    expect(legacy.rpc).toHaveBeenCalledWith("fn_norma_presend_fence", { p_request_id: "r" });

    const fenced = client({ data: true });
    await expect(presendNormaFence(fenced.client, "r", 2)).resolves.toBe(true);
    expect(fenced.rpc).toHaveBeenCalledWith("fn_norma_presend_fence", { p_request_id: "r", p_expected_attempt: 2 });

    await expect(presendNormaFence(client({ data: "true" }).client, "r", 1)).resolves.toBe(false);
    await expect(presendNormaFence(client({ error: { message: "timeout" } }).client, "r", 1)).rejects.toThrow("fn_norma_presend_fence: timeout");
  });

  it("fenced mutators and bind include an attempt only when supplied, preserving legacy calls", async () => {
    const legacy = client({ data: "dispatch_rejected" });
    await expect(markNormaDispatchRejected(legacy.client, "r", "why", "requested")).resolves.toBe("dispatch_rejected");
    expect(legacy.rpc).toHaveBeenCalledWith("fn_norma_mark_dispatch_rejected", {
      p_request_id: "r", p_reason: "why", p_expected_status: "requested",
    });

    const fenced = client({ data: "dispatch_unknown" });
    await expect(markNormaDispatchUnknown(fenced.client, "r", "timeout", 2)).resolves.toBe("dispatch_unknown");
    expect(fenced.rpc).toHaveBeenCalledWith("fn_norma_mark_dispatch_unknown", {
      p_request_id: "r", p_reason: "timeout", p_expected_attempt: 2,
    });

    const review = client({ data: "needs_review" });
    await expect(markNormaNeedsReview(review.client, "r", "stuck", 2)).resolves.toBe("needs_review");
    expect(review.rpc).toHaveBeenCalledWith("fn_norma_mark_needs_review", {
      p_request_id: "r", p_reason: "stuck", p_expected_attempt: 2,
    });

    const bind = client({ data: "bound" });
    await expect(bindNormaCallId(bind.client, "r", "c", 2)).resolves.toBe("bound");
    expect(bind.rpc).toHaveBeenCalledWith("fn_norma_bind_call_id", {
      p_request_id: "r", p_call_id: "c", p_expected_attempt: 2,
    });
  });

  it("completeNormaCall sends the payload and normalises task_id", async () => {
    const c = client({ data: { result: "applied", status: "completed", outcome: "callback_requested", task_id: "t" } });
    await expect(
      completeNormaCall(c.client, { requestId: "r", callId: "c", outcome: "callback_requested", payload: { summary: "s" } }),
    ).resolves.toMatchObject({ result: "applied", taskId: "t" });
    expect(c.rpc).toHaveBeenCalledWith("fn_norma_complete_call", {
      p_request_id: "r", p_call_id: "c", p_outcome: "callback_requested", p_payload: { summary: "s" },
    });
    const replay = client({ data: { result: "replayed", status: "completed", outcome: "no_answer" } });
    await expect(completeNormaCall(replay.client, { requestId: "r", callId: "c", outcome: "no_answer" })).resolves.toMatchObject({ result: "replayed" });
    expect(replay.rpc).toHaveBeenCalledWith("fn_norma_complete_call", expect.objectContaining({ p_payload: {} }));
    await expect(
      completeNormaCall(client({ error: { message: "db down" } }).client, { requestId: "r", callId: "c", outcome: "no_answer" }),
    ).rejects.toThrow("fn_norma_complete_call: db down");
  });

  it("the reply upgrade tolerates a missing function (deployed before the migration) but not other errors", async () => {
    const params = { propertyId: "p", reason: "inbound_reply" as const };
    await expect(upgradeNormaHoldPauses(client({ data: 1 }).client, params)).resolves.toBe(1);
    await expect(upgradeNormaHoldPauses(client({ error: { message: "not found", code: "PGRST202" } }).client, params)).resolves.toBe(0);
    await expect(upgradeNormaHoldPauses(client({ error: { message: "nope", code: "42883" } }).client, params)).resolves.toBe(0);
    await expect(upgradeNormaHoldPauses(client({ error: { message: "permission denied", code: "42501" } }).client, params)).rejects.toThrow("permission denied");
  });

  it("the stale sweep activation passes ids and time", async () => {
    const c = client({ data: 3 });
    await expect(sweepResumeCallInProgress(c.client, { enrollmentIds: ["a", "b"], resumeAt: "2026-10-02T00:00:00Z" })).resolves.toBe(3);
    expect(c.rpc).toHaveBeenCalledWith("sweep_resume_call_in_progress", {
      p_enrollment_ids: ["a", "b"], p_resume_at: "2026-10-02T00:00:00Z",
    });
  });
});
