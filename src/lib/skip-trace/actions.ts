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

    // Resolve org_id once — every property in the selection should belong
    // to the same org. We use the first property's org as the job's org.
    const { data: orgProbe } = await supabase
      .from("properties")
      .select("org_id")
      .eq("id", propertyIds[0])
      .maybeSingle();
    if (!orgProbe) {
      return {
        ok: false,
        error: { code: "NOT_FOUND", message: "Property not found." },
      };
    }

    const isAdmin = isAdminEmail(user.email);
    const initialStatus: "pending_approval" | "queued" = isAdmin
      ? "queued"
      : "pending_approval";

    const { data: jobRow, error: insertErr } = await supabase
      .from("jobs")
      .insert({
        type: "skip_trace",
        provider: "tracerfy",
        status: initialStatus,
        org_id: orgProbe.org_id,
        created_by: user.id,
        total_items: propertyIds.length,
        title: `Skip trace ${propertyIds.length} propert${propertyIds.length === 1 ? "y" : "ies"}`,
        description: isAdmin
          ? "Admin-initiated; running immediately"
          : `Awaiting admin approval (requested by ${user.email ?? "VA"})`,
        input_params: { property_ids: propertyIds },
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
          propertyIds,
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
        propertyCount: propertyIds.length,
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
