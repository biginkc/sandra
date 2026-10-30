import type { SupabaseClient } from "@supabase/supabase-js";

import { sellerTimezoneForState } from "@/lib/norma/callback-time";
import type { Database } from "@/lib/supabase/types";

import { hasSlotToken, isSlotWindow, planSlot } from "./slot-time";

/**
 * sequence-tick hook for routing v2 drips (PR-C). Legacy sequences (routing_v2_key is null)
 * get `{ kind: "legacy" }` and the tick runs exactly as before. For a v2 sequence it runs the
 * send-time re-check (flags + eligibility + takeover + suppression, under the per-property lock)
 * and, for booking steps, computes the dynamic slot time or the time to wait until.
 */
export type RoutingV2TickGate =
  | { kind: "legacy" }
  /** The SQL check refused (and wrote its own enrollment change, if any). */
  | { kind: "blocked"; reason: string }
  /** The check could not run (RPC/read error): nothing was written. */
  | { kind: "error"; message: string }
  | { kind: "wait"; nextRunAt: Date }
  | { kind: "send"; slotLabel: string | null };

// New columns / RPCs are not in the generated types yet; keep the untyped access here.
type Loose = {
  from: (t: string) => any; // eslint-disable-line @typescript-eslint/no-explicit-any
  rpc: (fn: string, args: Record<string, unknown>) => any; // eslint-disable-line @typescript-eslint/no-explicit-any
};
const loose = (c: SupabaseClient<Database>) => c as unknown as Loose;

export async function loadRoutingV2Key(
  client: SupabaseClient<Database>,
  sequenceId: string,
): Promise<string | null> {
  const { data, error } = await loose(client)
    .from("sequences")
    .select("routing_v2_key")
    .eq("id", sequenceId)
    .maybeSingle();
  if (error) {
    // Before the migration the column does not exist: everything is legacy.
    if (/routing_v2_key/.test(error.message ?? "")) return null;
    throw new Error(`routing v2 sequence read failed: ${error.message}`);
  }
  return (data as { routing_v2_key?: string | null } | null)?.routing_v2_key ?? null;
}

export async function routingV2TickGate(
  client: SupabaseClient<Database>,
  input: {
    enrollmentId: string;
    sequenceId: string;
    stepId: string;
    actionType: string;
    templateBody: string | null;
    propertyState: string | null;
    now?: Date;
  },
): Promise<RoutingV2TickGate> {
  const key = await loadRoutingV2Key(client, input.sequenceId);
  if (!key) return { kind: "legacy" };

  const { data: check, error } = await loose(client).rpc("routing_v2_enrollment_send_check", {
    p_enrollment_id: input.enrollmentId,
  });
  if (error) return { kind: "error", message: `routing_v2_send_check_failed: ${error.message}` };
  if (check !== "ok") return { kind: "blocked", reason: String(check) };

  if (input.actionType !== "send_sms" || !input.templateBody || !hasSlotToken(input.templateBody)) {
    return { kind: "send", slotLabel: null };
  }
  const { data: stepRow, error: stepErr } = await loose(client)
    .from("sequence_steps")
    .select("slot_window")
    .eq("id", input.stepId)
    .maybeSingle();
  if (stepErr) return { kind: "error", message: `routing_v2_slot_window_read_failed: ${stepErr.message}` };
  const raw = (stepRow as { slot_window?: unknown } | null)?.slot_window;
  const window = isSlotWindow(raw) ? raw : "any";
  const plan = planSlot(input.now ?? new Date(), sellerTimezoneForState(input.propertyState), window);
  if (plan.kind === "wait") return { kind: "wait", nextRunAt: plan.sendAt };
  return { kind: "send", slotLabel: plan.label };
}

/**
 * Atomic check-and-claim right before the provider call (v2 only). Under the property lock it
 * re-runs the send check and records an open claim for this step run; a reply transition that
 * lands afterwards cancels the claim and retires the enrollment, so the provider fence
 * (authorize_sequence_provider_attempt) refuses. Returns "ok" or the refusal reason.
 */
export async function routingV2ClaimDripSend(
  client: SupabaseClient<Database>,
  enrollmentId: string,
  stepRunId: string,
): Promise<{ ok: true } | { ok: false; reason: string; error: boolean }> {
  const { data, error } = await loose(client).rpc("routing_v2_claim_drip_send", {
    p_enrollment_id: enrollmentId,
    p_step_run_id: stepRunId,
  });
  if (error) return { ok: false, reason: `routing_v2_claim_failed: ${error.message}`, error: true };
  if (data === "ok") return { ok: true };
  return { ok: false, reason: String(data), error: false };
}

/**
 * After the provider call: close the v2 claim with the real outcome ("sent" = accepted,
 * "unknown" = may have sent). Returns an error message instead of swallowing it, so the tick
 * can hold the enrollment for reconciliation.
 */
export async function routingV2MarkDripClaimSent(
  client: SupabaseClient<Database>,
  stepRunId: string,
  outcome: "sent" | "unknown" = "sent",
): Promise<string | null> {
  try {
    const { error } = await loose(client).rpc("routing_v2_mark_drip_claim_sent", {
      p_step_run_id: stepRunId,
      p_outcome: outcome,
    });
    return error ? `routing v2 claim close failed: ${error.message}` : null;
  } catch (err) {
    return `routing v2 claim close failed: ${err instanceof Error ? err.message : String(err)}`;
  }
}

/** End of a v2 drip: chain into the next drip when the sequence names one (Said they'd call). */
export async function routingV2ChainAfterCompletion(
  client: SupabaseClient<Database>,
  enrollmentId: string,
): Promise<string | null> {
  const { data, error } = await loose(client).rpc("routing_v2_chain_after_completion", {
    p_enrollment_id: enrollmentId,
  });
  if (error) throw new Error(`routing v2 chain failed: ${error.message}`);
  return (data as string | null) ?? null;
}
