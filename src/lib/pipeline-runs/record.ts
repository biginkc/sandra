import type { SupabaseClient } from "@supabase/supabase-js";

import { reportError } from "@/lib/errors/report";
import type { Database, Json } from "@/lib/supabase/types";

import type {
  MaybeRunContext,
  PipelineRunContext,
  RunMode,
  RunStatus,
  StepKind,
  StepResult,
} from "./types";

type Admin = SupabaseClient<Database>;

const PREVIEW_MAX = 160;
// Keys that could carry seller text or contact data. Evidence rows hold small
// enums, numbers and ids only.
const FORBIDDEN_DETAIL_KEY =
  /^(body|text|content|preview|phone|phones|phone_number|from|to|message_body|message_text|inbound_body|inbound_text|reply_body|reply_text)$/i;
const PHONE_LIKE = /(?:\+?\d[\d\s().-]{8,}\d)/;

// UUIDs and ISO-8601 dates/timestamps are digit-heavy but harmless ids/times.
const SAFE_TOKENS =
  /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}|\d{4}-\d{2}-\d{2}(?:[T ]\d{2}:\d{2}(?::\d{2}(?:\.\d+)?)?(?:Z|[+-]\d{2}:?\d{2})?)?/gi;

function looksLikePhone(value: string): boolean {
  return PHONE_LIKE.test(value.replace(SAFE_TOKENS, " "));
}

/**
 * Kill switch: PIPELINE_RUNS_ENABLED=0 turns every recorder into a no-op:
 * startRun/resumeRun return null and recordStep/updateRun/finishRun write
 * nothing, even for a context created before the switch flipped. Default on.
 */
export function pipelineRunsEnabled(): boolean {
  return (process.env.PIPELINE_RUNS_ENABLED ?? "1").trim() !== "0";
}

function report(stage: string, error: unknown): void {
  const err =
    error instanceof Error
      ? error
      : new Error(
          typeof error === "object" && error && "message" in error
            ? String((error as { message: unknown }).message)
            : "Unknown pipeline run error",
        );
  reportError(err, { tags: { surface: "pipeline_runs", stage } });
}

function sanitizeValue(value: unknown): unknown {
  if (typeof value === "string") {
    return looksLikePhone(value) ? undefined : value;
  }
  if (Array.isArray(value)) {
    return value.map(sanitizeValue).filter((v) => v !== undefined);
  }
  if (value && typeof value === "object") {
    return sanitizeStepDetail(value as Record<string, unknown>);
  }
  return value;
}

/** Defensive scrub: drops body/phone-ish keys and phone-like strings. */
export function sanitizeStepDetail(
  detail: Record<string, unknown>,
): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(detail)) {
    if (FORBIDDEN_DETAIL_KEY.test(key)) continue;
    const clean = sanitizeValue(value);
    if (clean !== undefined) out[key] = clean;
  }
  return out;
}

export type StartRunInput = {
  orgId: string;
  inboundMessageId: string;
  propertyId?: string | null;
  contactId?: string | null;
  conversationId?: string | null;
  mode?: RunMode;
  inboundPreview?: string | null;
};

/**
 * Resume an existing run (delayed workflow, webhook retry): loads the org and
 * continues the seq counter from the stored maximum.
 */
export async function resumeRun(
  admin: Admin,
  runId: string | null | undefined,
): Promise<PipelineRunContext | null> {
  if (!runId || !pipelineRunsEnabled()) return null;
  try {
    const { data: run, error } = await admin
      .from("pipeline_runs")
      .select("id, org_id")
      .eq("id", runId)
      .maybeSingle();
    if (error || !run) {
      if (error) report("resume_lookup", error);
      return null;
    }
    return await withMaxSeq(admin, run.id, run.org_id);
  } catch (error) {
    report("resume", error);
    return null;
  }
}

async function withMaxSeq(
  admin: Admin,
  runId: string,
  orgId: string,
): Promise<PipelineRunContext> {
  const { data } = await admin
    .from("pipeline_run_steps")
    .select("seq")
    .eq("run_id", runId)
    .order("seq", { ascending: false })
    .limit(1)
    .maybeSingle();
  const { data: heldRow } = await admin
    .from("pipeline_run_steps")
    .select("seq")
    .eq("run_id", runId)
    .eq("kind", "action")
    .eq("result", "held")
    .limit(1)
    .maybeSingle();
  return { runId, orgId, seq: data?.seq ?? 0, ...(heldRow ? { held: true } : {}) };
}

/** One run per inbound message. Returns null (never throws) on failure. */
export async function startRun(
  admin: Admin,
  input: StartRunInput,
): Promise<PipelineRunContext | null> {
  if (!pipelineRunsEnabled()) return null;
  try {
    const { data, error } = await admin
      .from("pipeline_runs")
      .insert({
        org_id: input.orgId,
        inbound_message_id: input.inboundMessageId,
        property_id: input.propertyId ?? null,
        contact_id: input.contactId ?? null,
        conversation_id: input.conversationId ?? null,
        mode: input.mode ?? "legacy",
        inbound_preview: input.inboundPreview
          ? input.inboundPreview.slice(0, PREVIEW_MAX)
          : null,
      })
      .select("id, org_id")
      .single();
    if (error) {
      if ((error as { code?: string }).code === "23505") {
        // Webhook retry: keep the original run instead of resetting it.
        const { data: existing } = await admin
          .from("pipeline_runs")
          .select("id, org_id")
          .eq("inbound_message_id", input.inboundMessageId)
          .maybeSingle();
        return existing
          ? await withMaxSeq(admin, existing.id, existing.org_id)
          : null;
      }
      report("start", error);
      return null;
    }
    return { runId: data.id, orgId: data.org_id, seq: 0 };
  } catch (error) {
    report("start", error);
    return null;
  }
}

export type RecordStepInput = {
  kind: StepKind;
  name: string;
  result: StepResult;
  detail?: Record<string, unknown>;
};

/** Append one ordered step. No-op for a null/undefined ctx; never throws. */
export async function recordStep(
  admin: Admin,
  ctx: MaybeRunContext,
  step: RecordStepInput,
): Promise<void> {
  if (!ctx || !pipelineRunsEnabled()) return;
  // Issue the seq before any await so concurrent callers stay ordered.
  ctx.seq += 1;
  const seq = ctx.seq;
  // A deferred disposition (applied later by a human) makes the final run
  // status "held" rather than "closed"; see runStatusForOutcome.
  if (step.kind === "action" && step.result === "held") ctx.held = true;
  try {
    // Another process (a resumed delay workflow, a webhook retry) may have
    // taken this seq from the same run since we read the max. On a unique
    // violation re-read the stored max and retry, up to 3 more times.
    let attemptSeq = seq;
    for (let attempt = 0; attempt < 4; attempt += 1) {
      const { error } = await admin.from("pipeline_run_steps").insert({
        run_id: ctx.runId,
        org_id: ctx.orgId,
        seq: attemptSeq,
        kind: step.kind,
        name: step.name,
        result: step.result,
        detail: sanitizeStepDetail(step.detail ?? {}) as Json,
      });
      if (!error) return;
      const isSeqCollision =
        (error as { code?: string }).code === "23505" && attempt < 3;
      if (!isSeqCollision) {
        report("step", error);
        return;
      }
      const { data: latest } = await admin
        .from("pipeline_run_steps")
        .select("seq")
        .eq("run_id", ctx.runId)
        .order("seq", { ascending: false })
        .limit(1)
        .maybeSingle();
      attemptSeq = Math.max(latest?.seq ?? 0, ctx.seq, attemptSeq) + 1;
      ctx.seq = attemptSeq;
    }
  } catch (error) {
    report("step", error);
  }
}

export type RunPatch = {
  mode?: RunMode;
  claimId?: string | null;
  classificationRunId?: string | null;
  outboundMessageId?: string | null;
};

function patchColumns(
  patch: RunPatch,
): Database["public"]["Tables"]["pipeline_runs"]["Update"] {
  const out: Database["public"]["Tables"]["pipeline_runs"]["Update"] = {};
  if (patch.mode !== undefined) out.mode = patch.mode;
  if (patch.claimId !== undefined) out.claim_id = patch.claimId;
  if (patch.classificationRunId !== undefined) {
    out.classification_run_id = patch.classificationRunId;
  }
  if (patch.outboundMessageId !== undefined) {
    out.outbound_message_id = patch.outboundMessageId;
  }
  return out;
}

/** Patch non-terminal fields (mode, claim id, ...). Never throws. */
export async function updateRun(
  admin: Admin,
  ctx: MaybeRunContext,
  patch: RunPatch,
): Promise<void> {
  if (!ctx || !pipelineRunsEnabled()) return;
  const columns = patchColumns(patch);
  if (Object.keys(columns).length === 0) return;
  // Remember the claim this process won so its own terminal write can
  // present it (see finishRun).
  if (patch.claimId !== undefined) ctx.claimId = patch.claimId;
  try {
    const { error } = await admin
      .from("pipeline_runs")
      .update(columns)
      .eq("id", ctx.runId);
    if (error) report("update", error);
  } catch (error) {
    report("update", error);
  }
}

export type FinishRunInput = RunPatch & {
  status: RunStatus;
  finalOutcome?: string | null;
  reason?: string | null;
};

/**
 * Stamp the terminal state. Never throws. Only a run still `running` can
 * transition: a second terminal write (a late workflow after the webhook
 * already stamped the run, or after the stale sweep) never overwrites the
 * first. The rejected attempt is recorded as a `terminal_conflict` step.
 *
 * Terminal ownership: once a run has a claim_id, only the caller presenting
 * that claim (input.claimId, else the claim this context won) may write a
 * terminal status. A context that lost the claim (`duplicate`) never
 * finalises the shared run; it records a `duplicate_dispatch` step instead
 * and leaves the status to the claim holder.
 */
export async function finishRun(
  admin: Admin,
  ctx: MaybeRunContext,
  input: FinishRunInput,
): Promise<void> {
  if (!ctx || !pipelineRunsEnabled()) return;
  const presentedClaim = input.claimId ?? ctx.claimId ?? null;
  if (ctx.duplicate && !input.claimId) {
    await recordStep(admin, ctx, {
      kind: "gate",
      name: "duplicate_dispatch",
      result: "skipped",
      detail: { attempted_status: input.status },
    });
    return;
  }
  try {
    let query = admin
      .from("pipeline_runs")
      .update({
        ...patchColumns(input),
        status: input.status,
        ...(input.finalOutcome !== undefined
          ? { final_outcome: input.finalOutcome }
          : {}),
        ...(input.reason !== undefined ? { reason: input.reason } : {}),
        completed_at: new Date().toISOString(),
      })
      .eq("id", ctx.runId)
      .eq("status", "running");
    query = presentedClaim
      ? query.or(`claim_id.is.null,claim_id.eq.${presentedClaim}`)
      : query.is("claim_id", null);
    const { data, error } = await query.select("id");
    if (error) {
      report("finish", error);
      return;
    }
    if (!data || data.length === 0) {
      await recordStep(admin, ctx, {
        kind: "gate",
        name: "terminal_conflict",
        result: "block",
        detail: { attempted_status: input.status },
      });
    }
  } catch (error) {
    report("finish", error);
  }
}
