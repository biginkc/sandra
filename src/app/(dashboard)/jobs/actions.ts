"use server";

import { after } from "next/server";

import {
  createCassChildJob,
  runCassEnrichment,
} from "@/lib/enrichment/cass-job";
import { errFromUnknown, ok, type Result } from "@/lib/errors/result";
import { reportError } from "@/lib/errors/report";
import { createClient } from "@/lib/supabase/server";

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

    after(async () => {
      try {
        await runCassEnrichment(supabase, { jobId, propertyIds });
      } catch (e) {
        reportError(e, {
          tags: { surface: "start_queued_cass_after" },
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

    after(async () => {
      try {
        await runCassEnrichment(supabase, {
          jobId: childId,
          propertyIds,
        });
      } catch (e) {
        reportError(e, {
          tags: { surface: "retry_failed_cass_after" },
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
