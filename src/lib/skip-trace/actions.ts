"use server";

import { after } from "next/server";

import { isAdminEmail } from "@/lib/auth/allowlist";
import { listAdminUserIds } from "@/lib/auth/admins";
import { CASS_COST_PER_LOOKUP_USD } from "@/lib/enrichment/cass-job";
import { errFromUnknown, ok, type Result } from "@/lib/errors/result";
import { reportError } from "@/lib/errors/report";
import {
  dispatchJobCompleted,
  dispatchSkipTraceRequested,
} from "@/lib/notifications/dispatch";
import { createClient } from "@/lib/supabase/server";

import { getSkipTraceProvider } from "./registry";
import { runSkipTraceEnrichment } from "./skip-trace-job";

/** Max rows per single Tracefy POST. Their server rejects request
 *  bodies past ~2.5 MB with a generic HTML 400 before any field
 *  validation runs (hit live 2026-06-12 with a 12,282-row batch ≈ 3 MB).
 *  4,000 rows ≈ 0.9 MB keeps comfortable headroom. Selections larger
 *  than this are auto-split into multiple part-jobs — each with its own
 *  Tracefy queue id, so the existing per-job webhook/poll finalization
 *  works unchanged. This is a wire-format constraint, NOT a volume cap.
 */
const PROVIDER_BATCH_MAX = 4_000;

type SupabaseServerClient = Awaited<ReturnType<typeof createClient>>;

export type SkipTraceCreditStatus =
  | "sufficient"
  | "insufficient"
  | "unavailable";

export type SkipTracePreflight = {
  requested: number;
  eligible: number;
  cassVerified: number;
  cassUnverified: number;
  notEligible: number;
  killSwitchSkipped: number;
  tracefyCreditsRequired: number;
  tracefyCreditsAvailable: number | null;
  tracefyCreditStatus: SkipTraceCreditStatus;
  canLaunchSkipTrace: boolean;
  estimatedCassVerificationCostUsd: number;
  cassVerificationPropertyIds: string[];
};

type InternalSkipTracePreflight = SkipTracePreflight & {
  eligiblePropertyIds: string[];
  orgId: string | null;
};

function tracefyCreditsRequired(eligibleCount: number): number {
  if (eligibleCount <= 0) return 0;
  let required = 0;
  for (let i = 0; i < eligibleCount; i += PROVIDER_BATCH_MAX) {
    const partCount = Math.min(PROVIDER_BATCH_MAX, eligibleCount - i);
    required += partCount === 1 ? 5 : partCount;
  }
  return required;
}

async function getTracefyCreditState(required: number): Promise<{
  available: number | null;
  status: SkipTraceCreditStatus;
}> {
  if (required <= 0) {
    return { available: null, status: "sufficient" };
  }

  try {
    const provider = getSkipTraceProvider();
    if (!provider) return { available: null, status: "unavailable" };
    const available = await provider.getBalance();
    return {
      available,
      status: available >= required ? "sufficient" : "insufficient",
    };
  } catch (e) {
    reportError(e, { tags: { surface: "skip_trace_credit_preflight" } });
    return { available: null, status: "unavailable" };
  }
}

async function buildSkipTracePreflight(
  supabase: SupabaseServerClient,
  propertyIds: string[],
): Promise<InternalSkipTracePreflight> {
  const rows: Array<{
    id: string;
    org_id: string | null;
    skip_trace_disabled: boolean;
    cass_status: string;
  }> = [];

  for (let i = 0; i < propertyIds.length; i += 500) {
    const { data, error } = await supabase
      .from("properties")
      .select("id, org_id, skip_trace_disabled, cass_status")
      .in("id", propertyIds.slice(i, i + 500));
    if (error) {
      throw new Error(error.message);
    }
    if (data) rows.push(...data);
  }

  const allowed = rows.filter(
    (p) => !p.skip_trace_disabled && p.cass_status === "verified",
  );
  const cassVerified = rows.filter((p) => p.cass_status === "verified");
  const cassUnverified = rows.filter((p) => p.cass_status !== "verified");
  const cassVerificationCandidates = cassUnverified.filter(
    (p) => !p.skip_trace_disabled && p.cass_status !== "verified",
  );
  const killSwitched = rows.filter((p) => p.skip_trace_disabled);
  const required = tracefyCreditsRequired(allowed.length);
  const creditState = await getTracefyCreditState(required);

  return {
    requested: propertyIds.length,
    eligible: allowed.length,
    cassVerified: cassVerified.length,
    cassUnverified: cassUnverified.length,
    notEligible: propertyIds.length - allowed.length,
    killSwitchSkipped: killSwitched.length,
    tracefyCreditsRequired: required,
    tracefyCreditsAvailable: creditState.available,
    tracefyCreditStatus: creditState.status,
    canLaunchSkipTrace: allowed.length > 0 && creditState.status === "sufficient",
    estimatedCassVerificationCostUsd:
      cassVerificationCandidates.length * CASS_COST_PER_LOOKUP_USD,
    cassVerificationPropertyIds: cassVerificationCandidates.map((p) => p.id),
    eligiblePropertyIds: allowed.map((p) => p.id),
    orgId: allowed[0]?.org_id ?? rows[0]?.org_id ?? null,
  };
}

function publicPreflight(
  preflight: InternalSkipTracePreflight,
): SkipTracePreflight {
  return {
    requested: preflight.requested,
    eligible: preflight.eligible,
    cassVerified: preflight.cassVerified,
    cassUnverified: preflight.cassUnverified,
    notEligible: preflight.notEligible,
    killSwitchSkipped: preflight.killSwitchSkipped,
    tracefyCreditsRequired: preflight.tracefyCreditsRequired,
    tracefyCreditsAvailable: preflight.tracefyCreditsAvailable,
    tracefyCreditStatus: preflight.tracefyCreditStatus,
    canLaunchSkipTrace: preflight.canLaunchSkipTrace,
    estimatedCassVerificationCostUsd:
      preflight.estimatedCassVerificationCostUsd,
    cassVerificationPropertyIds: preflight.cassVerificationPropertyIds,
  };
}

async function requireTracefyCredits(
  preflight: InternalSkipTracePreflight,
): Promise<Result<null>> {
  if (preflight.eligible === 0) return ok(null);
  if (preflight.tracefyCreditStatus === "sufficient") return ok(null);

  if (preflight.tracefyCreditStatus === "insufficient") {
    return {
      ok: false,
      error: {
        code: "INSUFFICIENT_CREDITS",
        message: `Tracefy has ${preflight.tracefyCreditsAvailable ?? 0} credits; this skip trace needs ${preflight.tracefyCreditsRequired}. Top up before launching.`,
      },
    };
  }

  return {
    ok: false,
    error: {
      code: "TRACEFY_CREDITS_UNAVAILABLE",
      message:
        "Could not confirm Tracefy credits. Retry before launching skip trace.",
    },
  };
}

/** Cap removed entirely (Jarrad, 2026-06-11): credit balance is the
 *  operator's intentional throttle — he loads a fixed amount at a time
 *  and tops up deliberately. The runner submits ONE async batch to
 *  Tracefy and exits, so job size is not a function-lifetime concern;
 *  Tracefy refuses spend past the balance. Same policy as the
 *  select-all cap removal (#238). */

/**
 * Server actions for the primary skip-trace UI surfaces:
 *   - bulk from /properties (Surface A)
 *   - single from /leads/[id] (Surface B)
 *   - pending approval from /jobs
 *
 * Request surfaces call `requestSkipTrace` with a list of property ids. The
 * approval gate is enforced server-side: if the caller isn't an admin,
 * the job lands in `pending_approval` and admins get a notification;
 * if the caller IS an admin, the job queues + runs immediately.
 */

export type SkipTraceOutcome = {
  /** Job id for the queued/pending work; null when nothing was eligible. */
  jobId: string | null;
  /**
   * `queued`/`pending_approval` → a job was created. `none_eligible` is a
   * NORMAL, actionable outcome (everything needs CASS or is kill-switched),
   * NOT an error — callers render it as info, never a red failure toast.
   */
  status: "pending_approval" | "queued" | "none_eligible";
  /** Total ids the caller selected. */
  requested: number;
  /** Ids actually sent to the provider. */
  eligible: number;
  /** Skipped because the address isn't CASS-verified. */
  cassSkipped: number;
  /** Skipped because the per-property skip-trace kill switch is on. */
  killSwitchSkipped: number;
};

export async function preflightSkipTrace(
  propertyIds: string[],
): Promise<Result<SkipTracePreflight>> {
  try {
    if (!Array.isArray(propertyIds) || propertyIds.length === 0) {
      return {
        ok: false,
        error: { code: "VALIDATION", message: "Select at least one property." },
      };
    }

    const supabase = await createClient();
    const {
      data: { user },
    } = await supabase.auth.getUser();
    if (!user) {
      return {
        ok: false,
        error: { code: "AUTH", message: "Sign in required." },
      };
    }

    return ok(publicPreflight(await buildSkipTracePreflight(supabase, propertyIds)));
  } catch (e) {
    reportError(e, { tags: { surface: "preflight_skip_trace" } });
    return errFromUnknown(e, "PREFLIGHT_SKIP_TRACE_FAILED");
  }
}

export async function requestSkipTrace(
  propertyIds: string[],
): Promise<Result<SkipTraceOutcome>> {
  try {
    if (!Array.isArray(propertyIds) || propertyIds.length === 0) {
      return {
        ok: false,
        error: { code: "VALIDATION", message: "Select at least one property." },
      };
    }

    const supabase = await createClient();
    const {
      data: { user },
    } = await supabase.auth.getUser();
    if (!user) {
      return {
        ok: false,
        error: { code: "AUTH", message: "Sign in required." },
      };
    }

    const preflight = await buildSkipTracePreflight(supabase, propertyIds);
    const killSwitchSkipped = preflight.killSwitchSkipped;
    const cassSkipped = preflight.cassVerificationPropertyIds.length;
    if (preflight.eligible === 0) {
      // Nothing eligible — but this is NOT an error. Every selected
      // property either needs CASS verification or has skip-trace
      // disabled, both of which the operator can act on. Returning a
      // success outcome (rather than an error Result) is what stops the
      // UI from painting a normal "verify the addresses first" state as
      // a red failure alert. The caller decides the copy from the counts.
      return ok({
        jobId: null,
        status: "none_eligible",
        requested: propertyIds.length,
        eligible: 0,
        cassSkipped,
        killSwitchSkipped,
      });
    }

    const creditGate = await requireTracefyCredits(preflight);
    if (!creditGate.ok) return creditGate;

    // Use the filtered list from here on — the job only operates on
    // properties that survived BOTH gates.
    const eligibleIds = preflight.eligiblePropertyIds;
    if (!preflight.orgId) {
      return {
        ok: false,
        error: {
          code: "QUERY_FAILED",
          message: "No organization found for selected properties.",
        },
      };
    }
    const orgProbe = { org_id: preflight.orgId };

    const isAdmin = isAdminEmail(user.email);
    const initialStatus: "pending_approval" | "queued" = isAdmin
      ? "queued"
      : "pending_approval";

    // Build a human-readable suffix listing each filter's drop count
    // so the job title and notification copy stay truthful about what
    // actually went to the vendor.
    const skipReasons: string[] = [];
    if (killSwitchSkipped > 0) {
      skipReasons.push(
        `${killSwitchSkipped} kill-switched`,
      );
    }
    if (cassSkipped > 0) {
      skipReasons.push(
        `${cassSkipped} need${cassSkipped === 1 ? "s" : ""} CASS verification`,
      );
    }
    const skippedSuffix =
      skipReasons.length > 0 ? ` (${skipReasons.join(", ")} skipped)` : "";
    // Auto-split selections that exceed the provider's per-request wire
    // limit into part-jobs. One part = the common case; each part keeps
    // its own Tracefy queue id so per-job finalization is unchanged.
    const parts: string[][] = [];
    for (let i = 0; i < eligibleIds.length; i += PROVIDER_BATCH_MAX) {
      parts.push(eligibleIds.slice(i, i + PROVIDER_BATCH_MAX));
    }

    const jobIds: string[] = [];
    for (let p = 0; p < parts.length; p++) {
      const partIds = parts[p];
      const partLabel =
        parts.length > 1 ? ` (part ${p + 1}/${parts.length})` : "";
      const partSkippedSuffix = p === 0 ? skippedSuffix : "";
      const { data: jobRow, error: insertErr } = await supabase
        .from("jobs")
        .insert({
          type: "skip_trace",
          provider: "tracerfy",
          status: initialStatus,
          org_id: orgProbe.org_id,
          created_by: user.id,
          total_items: partIds.length,
          title: `Skip trace ${partIds.length} propert${partIds.length === 1 ? "y" : "ies"}${partLabel}${partSkippedSuffix}`,
          description: isAdmin
            ? `Admin-initiated; running immediately${partSkippedSuffix}`
            : `Awaiting admin approval (requested by ${user.email ?? "VA"})${partSkippedSuffix}`,
          input_params: { property_ids: partIds },
        })
        .select("id")
        .single();

      if (insertErr || !jobRow) {
        return {
          ok: false,
          error: {
            code: "JOB_CREATE_FAILED",
            message: insertErr?.message ?? "Failed to create job",
          },
        };
      }
      jobIds.push(jobRow.id);
    }

    if (isAdmin) {
      // Run immediately. The runner exits early for async batches and
      // the webhook finalizes; for ≤1-miss it completes inline. Parts
      // submit sequentially — each is a fast cache-check + one POST,
      // and Tracefy allows 10 batch submissions per 5 minutes.
      after(async () => {
        const bg = await createClient();
        for (let p = 0; p < jobIds.length; p++) {
          await runSkipTraceEnrichment(bg, {
            jobId: jobIds[p],
            propertyIds: parts[p],
          });
        }
      });
      return ok({
        jobId: jobIds[0],
        status: "queued",
        requested: propertyIds.length,
        eligible: eligibleIds.length,
        cassSkipped,
        killSwitchSkipped,
      });
    }

    // VA path: notify admins once for the whole request.
    try {
      const adminIds = await listAdminUserIds(supabase);
      await dispatchSkipTraceRequested(supabase, {
        jobId: jobIds[0],
        requesterEmail: user.email ?? null,
        propertyCount: eligibleIds.length,
        adminUserIds: adminIds,
      });
    } catch (e) {
      reportError(e, {
        tags: { surface: "skip_trace_request_notify" },
        extra: { jobId: jobIds[0] },
      });
    }
    return ok({
      jobId: jobIds[0],
      status: "pending_approval",
      requested: propertyIds.length,
      eligible: eligibleIds.length,
      cassSkipped,
      killSwitchSkipped,
    });
  } catch (e) {
    reportError(e, { tags: { surface: "request_skip_trace" } });
    return errFromUnknown(e, "REQUEST_SKIP_TRACE_FAILED");
  }
}

/**
 * Admin-only: approve a pending skip-trace job. Pre-flight checks the
 * provider's credit balance to refuse if the account would go negative.
 */
export async function approveSkipTraceJob(
  jobId: string,
): Promise<Result<{ jobId: string }>> {
  try {
    const supabase = await createClient();
    const {
      data: { user },
    } = await supabase.auth.getUser();
    if (!isAdminEmail(user?.email)) {
      return {
        ok: false,
        error: {
          code: "FORBIDDEN",
          message: "Only admins can approve skip-trace jobs.",
        },
      };
    }

    const { data: job } = await supabase
      .from("jobs")
      .select("id, status, total_items, input_params")
      .eq("id", jobId)
      .maybeSingle();
    if (!job) {
      return { ok: false, error: { code: "NOT_FOUND", message: "Job not found." } };
    }
    if (job.status !== "pending_approval") {
      return {
        ok: false,
        error: {
          code: "VALIDATION",
          message: `Job is in '${job.status}', not 'pending_approval'.`,
        },
      };
    }

    const propertyIds = (job.input_params as { property_ids?: string[] } | null)
      ?.property_ids;
    if (!Array.isArray(propertyIds) || propertyIds.length === 0) {
      return {
        ok: false,
        error: { code: "VALIDATION", message: "Job has no property ids." },
      };
    }

    const preflight = await buildSkipTracePreflight(supabase, propertyIds);
    if (preflight.eligible !== propertyIds.length) {
      return {
        ok: false,
        error: {
          code: "SKIP_TRACE_PREFLIGHT_CHANGED",
          message:
            "This job no longer matches the current CASS/skip-trace eligibility. Re-run preflight before approving.",
        },
      };
    }
    const creditGate = await requireTracefyCredits(preflight);
    if (!creditGate.ok) return creditGate;

    const { data: claimedJob, error: claimErr } = await supabase
      .from("jobs")
      .update({
        status: "queued",
        description: `Approved by ${user?.email ?? "admin"}`,
      })
      .eq("id", jobId)
      .eq("status", "pending_approval")
      .select("id")
      .maybeSingle();
    if (claimErr) {
      return {
        ok: false,
        error: {
          code: "APPROVE_SKIP_TRACE_FAILED",
          message: claimErr.message,
        },
      };
    }
    if (!claimedJob) {
      return {
        ok: false,
        error: {
          code: "APPROVAL_ALREADY_CLAIMED",
          message: "This skip-trace job was already approved or is no longer pending.",
        },
      };
    }

    after(async () => {
      const bg = await createClient();
      await runSkipTraceEnrichment(bg, { jobId, propertyIds });
    });

    return ok({ jobId });
  } catch (e) {
    reportError(e, { tags: { surface: "approve_skip_trace_job" } });
    return errFromUnknown(e, "APPROVE_SKIP_TRACE_FAILED");
  }
}

/**
 * Admin-only: deny a pending skip-trace job. Stashes the optional
 * reason in error_message and notifies the requester via job-completed
 * dispatch (reuses the existing notification pipeline).
 */
export async function denySkipTraceJob(
  jobId: string,
  reason?: string,
): Promise<Result<{ jobId: string }>> {
  try {
    const supabase = await createClient();
    const {
      data: { user },
    } = await supabase.auth.getUser();
    if (!isAdminEmail(user?.email)) {
      return {
        ok: false,
        error: {
          code: "FORBIDDEN",
          message: "Only admins can deny skip-trace jobs.",
        },
      };
    }

    const { data: job } = await supabase
      .from("jobs")
      .select("status")
      .eq("id", jobId)
      .maybeSingle();
    if (!job) {
      return { ok: false, error: { code: "NOT_FOUND", message: "Job not found." } };
    }
    if (job.status !== "pending_approval") {
      return {
        ok: false,
        error: {
          code: "VALIDATION",
          message: `Job is in '${job.status}', not 'pending_approval'.`,
        },
      };
    }

    await supabase
      .from("jobs")
      .update({
        status: "denied",
        completed_at: new Date().toISOString(),
        error_message: reason ?? `Denied by ${user?.email ?? "admin"}`,
      })
      .eq("id", jobId);

    // Reuse job-completed dispatch to notify the requester.
    try {
      await dispatchJobCompleted(supabase, { jobId });
    } catch (e) {
      reportError(e, { tags: { surface: "skip_trace_deny_notify" } });
    }
    return ok({ jobId });
  } catch (e) {
    reportError(e, { tags: { surface: "deny_skip_trace_job" } });
    return errFromUnknown(e, "DENY_SKIP_TRACE_FAILED");
  }
}
