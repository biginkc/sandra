"use server";

import { after } from "next/server";
import { start } from "workflow/api";

import { isAdminEmail } from "@/lib/auth/allowlist";
import { createCassChildJob } from "@/lib/enrichment/cass-job";
import { cassBulkWorkflow } from "@/workflows/cass-bulk";
import { errFromUnknown, ok, type Result } from "@/lib/errors/result";
import { reportError } from "@/lib/errors/report";
import { createClient } from "@/lib/supabase/server";
import { skipTraceSubmitWorkflow } from "@/workflows/skip-trace-submit";

/**
 * Start a CASS child job that the import autotrigger deliberately parked in
 * `queued` state because the property count exceeded
 * `CASS_AUTOTRIGGER_MAX_ITEMS`. Reuses the same worker path as the inline
 * autotrigger — only the initiation differs.
 *
 * Idempotent against double-clicks: guarded on current status so a queued
 * row is the only thing we'll try to start. A row already `running` or
 * terminal returns a structured error.
 */
export async function startQueuedCassJob(
  jobId: string,
): Promise<Result<{ total: number }>> {
  try {
    const supabase = await createClient();

    const { data: job, error: fetchError } = await supabase
      .from("jobs")
      .select("id, type, status, input_params, total_items")
      .eq("id", jobId)
      .maybeSingle();

    if (fetchError) {
      return {
        ok: false,
        error: { code: "JOB_FETCH_FAILED", message: fetchError.message },
      };
    }
    if (!job) {
      return {
        ok: false,
        error: { code: "JOB_NOT_FOUND", message: "Job not found." },
      };
    }
    if (job.type !== "cass_dsf2_ncoa") {
      return {
        ok: false,
        error: {
          code: "JOB_WRONG_TYPE",
          message: `This action only starts CASS jobs; got type="${job.type}".`,
        },
      };
    }
    if (job.status !== "queued") {
      return {
        ok: false,
        error: {
          code: "JOB_NOT_QUEUED",
          message: `Job is ${job.status}, not queued.`,
        },
      };
    }

    const propertyIdsRaw =
      (job.input_params as { property_ids?: unknown } | null)?.property_ids ??
      null;
    const propertyIds = Array.isArray(propertyIdsRaw)
      ? propertyIdsRaw.filter(
          (x): x is string => typeof x === "string" && x.length > 0,
        )
      : [];
    if (propertyIds.length === 0) {
      return {
        ok: false,
        error: {
          code: "JOB_NO_PROPERTIES",
          message:
            "Queued CASS job has no property IDs in input_params. Delete it and re-run the import.",
        },
      };
    }

    // Flip to running BEFORE scheduling the worker so the UI's Realtime
    // subscription shows the transition immediately — avoids a stale
    // "queued" flash while after() spins up.
    const { error: flipError } = await supabase
      .from("jobs")
      .update({
        status: "running",
        started_at: new Date().toISOString(),
        worker_heartbeat_at: new Date().toISOString(),
        // Clear the awaiting_manual_start flag so the UI stops offering a
        // Start button — matches the semantic "it's running now".
        result_summary: null,
      })
      .eq("id", jobId)
      .eq("status", "queued");
    if (flipError) {
      return {
        ok: false,
        error: {
          code: "JOB_STATUS_FLIP_FAILED",
          message: flipError.message,
        },
      };
    }

    // Chunked workflow, NOT inline enrichment — parked jobs exist
    // precisely because they exceeded the autotrigger cap, so they are
    // exactly the size class that dies at the 5-minute function ceiling.
    after(async () => {
      try {
        await start(cassBulkWorkflow, [{ jobId }]);
      } catch (e) {
        reportError(e, {
          tags: { surface: "start_queued_cass_workflow_start" },
          extra: { jobId },
        });
        await supabase
          .from("jobs")
          .update({
            status: "failed",
            error_class: "database",
            error_message: e instanceof Error ? e.message : String(e),
            completed_at: new Date().toISOString(),
          })
          .eq("id", jobId);
      }
    });

    return ok({ total: propertyIds.length });
  } catch (e) {
    reportError(e, { tags: { surface: "start_queued_cass" }, extra: { jobId } });
    return errFromUnknown(e, "START_QUEUED_CASS_FAILED");
  }
}

/**
 * Retry CASS verification for the property_ids whose prior CASS run
 * landed in `error` status. Creates a fresh `cass_dsf2_ncoa` child job
 * linked to the same import and runs it via the existing cache-through
 * verifier (so previously-cached responses cost zero new SmartyStreets
 * calls).
 *
 * Concretely the recovery path for the 2026-04-29 incident: 374 D4D
 * properties had their CASS update fail because corrupt
 * scientific-notation APNs (Excel auto-formatting) created
 * unique-constraint collisions on (fips_code, apn_normalized). After
 * the corrupt APNs were nulled out, those properties' verified
 * SmartyStreets responses are still in cass_cache; this action just
 * replays the DB write step.
 *
 * Idempotent: clicking twice creates two retry jobs but the second
 * walks already-verified rows that no longer have an error item, so
 * the input set is empty → no-op safely.
 */
export async function retryFailedCassItems(
  failedJobId: string,
): Promise<Result<{ total: number; childJobId: string }>> {
  try {
    const supabase = await createClient();

    const { data: parent, error: parentErr } = await supabase
      .from("jobs")
      .select("id, type, parent_job_id, related_import_id, created_by")
      .eq("id", failedJobId)
      .maybeSingle();

    if (parentErr) {
      return {
        ok: false,
        error: { code: "JOB_FETCH_FAILED", message: parentErr.message },
      };
    }
    if (!parent) {
      return {
        ok: false,
        error: { code: "JOB_NOT_FOUND", message: "Job not found." },
      };
    }
    if (parent.type !== "cass_dsf2_ncoa") {
      return {
        ok: false,
        error: {
          code: "JOB_WRONG_TYPE",
          message: `This action retries CASS jobs; got type="${parent.type}".`,
        },
      };
    }

    const { data: failedItems, error: itemsErr } = await supabase
      .from("job_items")
      .select("property_id")
      .eq("job_id", failedJobId)
      .eq("status", "error")
      .not("property_id", "is", null);

    if (itemsErr) {
      return {
        ok: false,
        error: { code: "JOB_ITEMS_FETCH_FAILED", message: itemsErr.message },
      };
    }

    const propertyIds = Array.from(
      new Set(
        (failedItems ?? [])
          .map((r) => r.property_id)
          .filter((id): id is string => typeof id === "string"),
      ),
    );

    if (propertyIds.length === 0) {
      return {
        ok: false,
        error: {
          code: "NO_FAILED_ITEMS",
          message: "No failed property items found on this CASS job.",
        },
      };
    }

    const childId = await createCassChildJob(supabase, {
      // Chain the retry off whichever parent the failed job had — that
      // keeps the import thread visible end-to-end on /jobs.
      parentJobId: parent.parent_job_id ?? failedJobId,
      relatedImportId: parent.related_import_id,
      createdBy: parent.created_by,
      propertyIds,
      autoStart: true,
    });

    // Chunked workflow — retry sets after a mass failure can be as large
    // as the original job, so the inline path's 5-minute ceiling applies.
    after(async () => {
      try {
        await start(cassBulkWorkflow, [{ jobId: childId }]);
      } catch (e) {
        reportError(e, {
          tags: { surface: "retry_failed_cass_workflow_start" },
          extra: { childId, propertyCount: propertyIds.length },
        });
        await supabase
          .from("jobs")
          .update({
            status: "failed",
            error_class: "database",
            error_message: e instanceof Error ? e.message : String(e),
            completed_at: new Date().toISOString(),
          })
          .eq("id", childId);
      }
    });

    return ok({ total: propertyIds.length, childJobId: childId });
  } catch (e) {
    reportError(e, {
      tags: { surface: "retry_failed_cass" },
      extra: { failedJobId },
    });
    return errFromUnknown(e, "RETRY_FAILED_CASS_FAILED");
  }
}

/**
 * Retry a failed or partial skip-trace job by creating a fresh
 * `skip_trace` child linked via `parent_job_id` and queueing it through
 * the standard runner. Two property-ID resolution paths:
 *
 *   1. **Errored job_items first.** The standard partial-failure case —
 *      some lookups errored, retry only those.
 *   2. **`input_params.property_ids` fallback.** Pre-#59 jobs landed with
 *      zero `job_items` rows because the old code couldn't fan Tracerfy
 *      results back to per-property items. The original property list is
 *      still in `input_params`; treat the whole batch as failed.
 *
 * Admin-only — costs Tracerfy credits per
 * `feedback_explicit_opt_in_for_paid_actions`. Concurrency-guarded:
 * refuses if a child of this job is already queued or running.
 */
export async function retryFailedSkipTraceItems(
  failedJobId: string,
): Promise<Result<{ total: number; childJobId: string }>> {
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
          message: "Only admins can retry skip-trace jobs.",
        },
      };
    }

    const { data: parent, error: parentErr } = await supabase
      .from("jobs")
      .select("id, type, status, org_id, created_by, input_params")
      .eq("id", failedJobId)
      .maybeSingle();
    if (parentErr) {
      return {
        ok: false,
        error: { code: "JOB_FETCH_FAILED", message: parentErr.message },
      };
    }
    if (!parent) {
      return {
        ok: false,
        error: { code: "JOB_NOT_FOUND", message: "Job not found." },
      };
    }
    if (parent.type !== "skip_trace") {
      return {
        ok: false,
        error: {
          code: "JOB_WRONG_TYPE",
          message: `This action retries skip_trace jobs; got type="${parent.type}".`,
        },
      };
    }
    if (parent.status !== "failed" && parent.status !== "partial") {
      return {
        ok: false,
        error: {
          code: "JOB_WRONG_STATUS",
          message: `Job is "${parent.status}", not "failed" or "partial".`,
        },
      };
    }

    // Concurrency guard — refuse if a child of this job is already
    // queued or running. Prevents accidental double-charges from
    // multi-tab clicks or stale dialogs.
    const { data: inFlight, error: inFlightErr } = await supabase
      .from("jobs")
      .select("id")
      .eq("parent_job_id", failedJobId)
      .in("status", ["queued", "running"])
      .limit(1)
      .maybeSingle();
    if (inFlightErr) {
      return {
        ok: false,
        error: {
          code: "JOB_FETCH_FAILED",
          message: inFlightErr.message,
        },
      };
    }
    if (inFlight) {
      return {
        ok: false,
        error: {
          code: "RETRY_IN_FLIGHT",
          message: "A retry is already running for this job.",
        },
      };
    }

    // Resolution: retryable errored job_items first, then input_params
    // fallback. "Retryable" = error_class that could plausibly succeed
    // on a fresh provider call. `provider_no_data` is terminal (verified
    // address, vendor empty); `address_unverified` needs CASS first
    // before re-running. Both are excluded so the user doesn't waste
    // vendor credits learning the same answer twice.
    const RETRYABLE_ERROR_CLASSES = [
      "provider_transient",
      "provider_unknown",
      // Legacy values written before classification existed — treat
      // as retryable by default so existing partial jobs don't get
      // stranded.
      "provider",
      "database",
      "internal",
      "transient",
    ];
    const { data: erroredItems, error: itemsErr } = await supabase
      .from("job_items")
      .select("property_id, error_class")
      .eq("job_id", failedJobId)
      .eq("status", "error")
      .not("property_id", "is", null);
    if (itemsErr) {
      return {
        ok: false,
        error: { code: "JOB_ITEMS_FETCH_FAILED", message: itemsErr.message },
      };
    }

    const allErroredIds = new Set(
      (erroredItems ?? [])
        .map((r) => r.property_id)
        .filter((id): id is string => typeof id === "string"),
    );
    const retryableIds = new Set(
      (erroredItems ?? [])
        .filter((r) =>
          r.error_class === null ||
          RETRYABLE_ERROR_CLASSES.includes(r.error_class as string),
        )
        .map((r) => r.property_id)
        .filter((id): id is string => typeof id === "string"),
    );

    let propertyIds: string[];
    if (allErroredIds.size > 0) {
      // Items exist — filter by retryability.
      propertyIds = Array.from(retryableIds);
      if (propertyIds.length === 0) {
        return {
          ok: false,
          error: {
            code: "NO_RETRYABLE_ITEMS",
            message:
              "All errored items are terminal (no provider data or address-unverified) — retry would waste vendor credits.",
          },
        };
      }
    } else {
      // No items at all — pre-#59 fallback. Use input_params.
      const fallback = (parent.input_params as { property_ids?: unknown } | null)
        ?.property_ids;
      propertyIds = Array.isArray(fallback)
        ? Array.from(
            new Set(
              fallback.filter(
                (x): x is string => typeof x === "string" && x.length > 0,
              ),
            ),
          )
        : [];
      if (propertyIds.length === 0) {
        return {
          ok: false,
          error: {
            code: "NO_PROPERTY_IDS",
            message:
              "This job has no errored items and no fallback property_ids — nothing to retry.",
          },
        };
      }
    }

    const { data: childRow, error: insertErr } = await supabase
      .from("jobs")
      .insert({
        type: "skip_trace",
        provider: "tracerfy",
        status: "queued",
        org_id: parent.org_id,
        parent_job_id: failedJobId,
        created_by: user?.id ?? parent.created_by,
        total_items: propertyIds.length,
        title: `Retry skip-trace ${propertyIds.length} propert${propertyIds.length === 1 ? "y" : "ies"}`,
        description: `Retry of ${failedJobId.slice(0, 8)} by ${user?.email ?? "admin"}`,
        input_params: { property_ids: propertyIds },
      })
      .select("id")
      .single();
    if (insertErr || !childRow) {
      return {
        ok: false,
        error: {
          code: "JOB_CREATE_FAILED",
          message: insertErr?.message ?? "Failed to create child job",
        },
      };
    }

    try {
      await start(skipTraceSubmitWorkflow, [
        { jobId: childRow.id, orgId: parent.org_id },
      ]);
    } catch (e) {
      reportError(e, {
        tags: { surface: "retry_skip_trace_workflow_start" },
        extra: { childId: childRow.id, propertyCount: propertyIds.length },
      });
    }

    return ok({ total: propertyIds.length, childJobId: childRow.id });
  } catch (e) {
    reportError(e, {
      tags: { surface: "retry_skip_trace" },
      extra: { failedJobId },
    });
    return errFromUnknown(e, "RETRY_SKIP_TRACE_FAILED");
  }
}
