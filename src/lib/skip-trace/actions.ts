"use server";

import { after } from "next/server";

import { isAdminEmail } from "@/lib/auth/allowlist";
import { listAdminUserIds } from "@/lib/auth/admins";
import { errFromUnknown, ok, type Result } from "@/lib/errors/result";
import { reportError } from "@/lib/errors/report";
import {
  dispatchJobCompleted,
  dispatchSkipTraceRequested,
} from "@/lib/notifications/dispatch";
import { createClient } from "@/lib/supabase/server";

import { getSkipTraceProvider } from "./registry";
import { runSkipTraceEnrichment } from "./skip-trace-job";

/** Max rows per single Tracerfy POST. Their server rejects request
 *  bodies past ~2.5 MB with a generic HTML 400 before any field
 *  validation runs (hit live 2026-06-12 with a 12,282-row batch ≈ 3 MB).
 *  4,000 rows ≈ 0.9 MB keeps comfortable headroom. Selections larger
 *  than this are auto-split into multiple part-jobs — each with its own
 *  Tracerfy queue id, so the existing per-job webhook/poll finalization
 *  works unchanged. This is a wire-format constraint, NOT a volume cap.
 */
const PROVIDER_BATCH_MAX = 4_000;

/** Cap removed entirely (Jarrad, 2026-06-11): credit balance is the
 *  operator's intentional throttle — he loads a fixed amount at a time
 *  and tops up deliberately. The runner submits ONE async batch to
 *  Tracerfy and exits, so job size is not a function-lifetime concern;
 *  Tracerfy refuses spend past the balance. Same policy as the
 *  select-all cap removal (#238). */

/**
 * Server actions for the three skip-trace UI surfaces:
 *   - bulk from /properties (Surface A)
 *   - single from /leads/[id] (Surface B)
 *   - opt-in checkbox in CSV import wizard (Surface C)
 *
 * All three call `requestSkipTrace` with a list of property ids. The
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

    // Filter out two classes of property up-front so we never spend
    // vendor credits on guaranteed-fail lookups:
    //   1. `skip_trace_disabled` — the per-property kill switch.
    //   2. `cass_status != 'verified'` — un-CASS'd addresses fail at
    //      Tracerfy because they aren't USPS-normalized. Sending them
    //      anyway pays $0.02/row to learn we should have CASS-verified
    //      first.
    const eligibleRows: Array<{
      id: string;
      org_id: string;
      skip_trace_disabled: boolean;
      cass_status: string;
    }> = [];
    for (let i = 0; i < propertyIds.length; i += 500) {
      const { data, error: eligibleErr } = await supabase
        .from("properties")
        .select("id, org_id, skip_trace_disabled, cass_status")
        .in("id", propertyIds.slice(i, i + 500));
      if (eligibleErr) {
        return {
          ok: false,
          error: { code: "QUERY_FAILED", message: eligibleErr.message },
        };
      }
      if (data) eligibleRows.push(...data);
    }
    const killSwitched = (eligibleRows ?? []).filter(
      (p) => p.skip_trace_disabled,
    );
    const cassUnverified = (eligibleRows ?? []).filter(
      (p) => !p.skip_trace_disabled && p.cass_status !== "verified",
    );
    const allowed = (eligibleRows ?? []).filter(
      (p) => !p.skip_trace_disabled && p.cass_status === "verified",
    );
    const killSwitchSkipped = killSwitched.length;
    const cassSkipped = cassUnverified.length;
    if (allowed.length === 0) {
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

    // Use the filtered list from here on — the job only operates on
    // properties that survived BOTH gates.
    const eligibleIds = allowed.map((p) => p.id);
    const orgProbe = { org_id: allowed[0].org_id };

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
    // its own Tracerfy queue id so per-job finalization is unchanged.
    const parts: string[][] = [];
    for (let i = 0; i < eligibleIds.length; i += PROVIDER_BATCH_MAX) {
      parts.push(eligibleIds.slice(i, i + PROVIDER_BATCH_MAX));
    }

    const jobIds: string[] = [];
    for (let p = 0; p < parts.length; p++) {
      const partIds = parts[p];
      const partLabel =
        parts.length > 1 ? ` (part ${p + 1}/${parts.length})` : "";
      const { data: jobRow, error: insertErr } = await supabase
        .from("jobs")
        .insert({
          type: "skip_trace",
          provider: "tracerfy",
          status: initialStatus,
          org_id: orgProbe.org_id,
          created_by: user.id,
          total_items: partIds.length,
          title: `Skip trace ${partIds.length} propert${partIds.length === 1 ? "y" : "ies"}${partLabel}${skippedSuffix}`,
          description: isAdmin
            ? `Admin-initiated; running immediately${skippedSuffix}`
            : `Awaiting admin approval (requested by ${user.email ?? "VA"})${skippedSuffix}`,
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
      // and Tracerfy allows 10 batch submissions per 5 minutes.
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

    // Pre-flight balance — refuse if balance < estimated worst case.
    // Single lookup = 5 credits; batch = 1 credit per row.
    const provider = getSkipTraceProvider();
    if (provider) {
      try {
        const balance = await provider.getBalance();
        const worstCase = propertyIds.length === 1 ? 5 : propertyIds.length;
        if (balance < worstCase) {
          return {
            ok: false,
            error: {
              code: "INSUFFICIENT_CREDITS",
              message: `Account has ${balance} credits; this job needs at least ${worstCase}. Top up before approving.`,
            },
          };
        }
      } catch (e) {
        reportError(e, { tags: { surface: "skip_trace_balance_check" } });
        // Don't block approval on a balance-check failure; the job will
        // surface a clear provider error if credits actually run out.
      }
    }

    await supabase
      .from("jobs")
      .update({
        status: "queued",
        description: `Approved by ${user?.email ?? "admin"}`,
      })
      .eq("id", jobId);

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
