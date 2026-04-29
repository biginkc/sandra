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

const MAX_PROPERTIES_PER_JOB = 500;

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

export async function requestSkipTrace(
  propertyIds: string[],
): Promise<Result<{ jobId: string; status: "pending_approval" | "queued" }>> {
  try {
    if (!Array.isArray(propertyIds) || propertyIds.length === 0) {
      return {
        ok: false,
        error: { code: "VALIDATION", message: "Select at least one property." },
      };
    }
    if (propertyIds.length > MAX_PROPERTIES_PER_JOB) {
      return {
        ok: false,
        error: {
          code: "VALIDATION",
          message: `Cannot skip-trace more than ${MAX_PROPERTIES_PER_JOB} properties at once. Split into smaller batches.`,
        },
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
    const { data: eligibleRows, error: eligibleErr } = await supabase
      .from("properties")
      .select("id, org_id, skip_trace_disabled, cass_status")
      .in("id", propertyIds);
    if (eligibleErr) {
      return {
        ok: false,
        error: { code: "QUERY_FAILED", message: eligibleErr.message },
      };
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
      // Surface the most specific reason. Kill-switch wins because
      // it's user-controlled; CASS is the next-most-actionable.
      if (killSwitchSkipped > 0 && cassSkipped === 0) {
        return {
          ok: false,
          error: {
            code: "ALL_PROPERTIES_DISABLED",
            message:
              propertyIds.length === 1
                ? "Skip-trace is disabled on this property. Re-enable it on the lead detail page first."
                : "Every selected property has skip-trace disabled. Re-enable on the lead detail pages first.",
          },
        };
      }
      if (cassSkipped > 0 && killSwitchSkipped === 0) {
        return {
          ok: false,
          error: {
            code: "ALL_PROPERTIES_NEED_CASS",
            message:
              propertyIds.length === 1
                ? "This property's address is not CASS-verified. Run address verification first to avoid a wasted skip-trace credit."
                : "Every selected property needs CASS verification first. Run address verification, then skip-trace will be safe to spend on.",
          },
        };
      }
      return {
        ok: false,
        error: {
          code: "NO_ELIGIBLE_PROPERTIES",
          message: `No properties are eligible — ${killSwitchSkipped} disabled, ${cassSkipped} need CASS verification.`,
        },
      };
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
    const { data: jobRow, error: insertErr } = await supabase
      .from("jobs")
      .insert({
        type: "skip_trace",
        provider: "tracerfy",
        status: initialStatus,
        org_id: orgProbe.org_id,
        created_by: user.id,
        total_items: eligibleIds.length,
        title: `Skip trace ${eligibleIds.length} propert${eligibleIds.length === 1 ? "y" : "ies"}${skippedSuffix}`,
        description: isAdmin
          ? `Admin-initiated; running immediately${skippedSuffix}`
          : `Awaiting admin approval (requested by ${user.email ?? "VA"})${skippedSuffix}`,
        input_params: { property_ids: eligibleIds },
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

    if (isAdmin) {
      // Run immediately. The runner exits early for async batches and
      // the webhook finalizes; for ≤1-miss it completes inline.
      after(async () => {
        const bg = await createClient();
        await runSkipTraceEnrichment(bg, {
          jobId: jobRow.id,
          propertyIds: eligibleIds,
        });
      });
      return ok({ jobId: jobRow.id, status: "queued" });
    }

    // VA path: notify admins.
    try {
      const adminIds = await listAdminUserIds(supabase);
      await dispatchSkipTraceRequested(supabase, {
        jobId: jobRow.id,
        requesterEmail: user.email ?? null,
        propertyCount: eligibleIds.length,
        adminUserIds: adminIds,
      });
    } catch (e) {
      reportError(e, {
        tags: { surface: "skip_trace_request_notify" },
        extra: { jobId: jobRow.id },
      });
    }
    return ok({ jobId: jobRow.id, status: "pending_approval" });
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
