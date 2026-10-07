import type { SupabaseClient } from "@supabase/supabase-js";

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

function report(stage: string, error: unknown): void {
  console.error("[pipeline-runs] record failed", {
    stage,
    message:
      error instanceof Error
        ? error.message
        : typeof error === "object" && error && "message" in error
          ? String((error as { message: unknown }).message)
          : "Unknown pipeline run error",
  });
}

function sanitizeValue(value: unknown): unknown {
  if (typeof value === "string") {
    return PHONE_LIKE.test(value) ? undefined : value;
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
  if (!runId) return null;
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
  return { runId, orgId, seq: data?.seq ?? 0 };
}

/** One run per inbound message. Returns null (never throws) on failure. */
export async function startRun(
  admin: Admin,
  input: StartRunInput,
): Promise<PipelineRunContext | null> {
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
  if (!ctx) return;
  // Issue the seq before any await so concurrent callers stay ordered.
  ctx.seq += 1;
  const seq = ctx.seq;
  try {
    const { error } = await admin.from("pipeline_run_steps").insert({
      run_id: ctx.runId,
      org_id: ctx.orgId,
      seq,
      kind: step.kind,
      name: step.name,
      result: step.result,
      detail: sanitizeStepDetail(step.detail ?? {}) as Json,
    });
    if (error) report("step", error);
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
  if (!ctx) return;
  const columns = patchColumns(patch);
  if (Object.keys(columns).length === 0) return;
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

/** Stamp the terminal state. Never throws. */
export async function finishRun(
  admin: Admin,
  ctx: MaybeRunContext,
  input: FinishRunInput,
): Promise<void> {
  if (!ctx) return;
  try {
    const { error } = await admin
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
      .eq("id", ctx.runId);
    if (error) report("finish", error);
  } catch (error) {
    report("finish", error);
  }
}
