"use server";

import { after } from "next/server";
import { start } from "workflow/api";

import { isAdminEmail } from "@/lib/auth/allowlist";
import {
  claimAuthorizedCassJobStart,
  createCassChildJob,
  failAuthorizedCassJobStart,
} from "@/lib/enrichment/cass-job";
import { cassBulkWorkflow } from "@/workflows/cass-bulk";
import { errFromUnknown, ok, type Result } from "@/lib/errors/result";
import { reportError } from "@/lib/errors/report";
import { LEAD_EVENT_TYPES, recordLeadEvents } from "@/lib/events";
import { createAdminClient } from "@/lib/supabase/admin";
import { createClient } from "@/lib/supabase/server";
import { preflightSkipTrace } from "@/lib/skip-trace/actions";
import { skipTraceSubmitWorkflow } from "@/workflows/skip-trace-submit";

const JOB_ITEM_PAGE_SIZE = 500;

async function readFailedJobItems(
  supabase: Awaited<ReturnType<typeof createClient>>,
  jobId: string,
): Promise<
  Array<{ id: string; property_id: string | null; error_class: string | null }>
> {
  const rows: Array<{
    id: string;
    property_id: string | null;
    error_class: string | null;
  }> = [];
  let lastId: string | null = null;
  for (;;) {
    let query = supabase
      .from("job_items")
      .select("id, property_id, error_class")
      .eq("job_id", jobId)
      .eq("status", "error")
      .not("property_id", "is", null)
      .order("id", { ascending: true })
      .limit(JOB_ITEM_PAGE_SIZE);
    if (lastId) query = query.gt("id", lastId);
    const { data, error } = await query;
    if (error)
      throw new Error(`job item recovery read failed: ${error.message}`);
    rows.push(...(data ?? []));
    if (!data || data.length < JOB_ITEM_PAGE_SIZE) break;
    lastId = data.at(-1)?.id ?? null;
    if (!lastId) throw new Error("job item recovery page had no cursor");
  }
  return rows;
}

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
      .select("id, org_id, type, status, input_params, total_items")
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

    let claimToken: string;
    try {
      claimToken = await claimAuthorizedCassJobStart(supabase, {
        jobId,
        orgId: job.org_id,
      });
    } catch (claimError) {
      return {
        ok: false,
        error: {
          code: "JOB_STATUS_FLIP_FAILED",
          message:
            claimError instanceof Error
              ? claimError.message
              : String(claimError),
        },
      };
    }

    // Chunked workflow, NOT inline enrichment — parked jobs exist
    // precisely because they exceeded the autotrigger cap, so they are
    // exactly the size class that dies at the 5-minute function ceiling.
    after(async () => {
      try {
        await start(cassBulkWorkflow, [{ jobId, claimToken }]);
      } catch (e) {
        reportError(e, {
          tags: { surface: "start_queued_cass_workflow_start" },
          extra: { jobId },
        });
        await failAuthorizedCassJobStart(supabase, {
          jobId,
          orgId: job.org_id,
          claimToken,
          error: e,
        });
      }
    });

    return ok({ total: propertyIds.length });
  } catch (e) {
    reportError(e, {
      tags: { surface: "start_queued_cass" },
      extra: { jobId },
    });
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
      .select("id, org_id, type, parent_job_id, related_import_id, created_by")
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

    const failedItems = await readFailedJobItems(supabase, failedJobId);

    const propertyIds = Array.from(
      new Set(
        failedItems
          .filter((row) => row.error_class !== "submission_unknown")
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

    const child = await createCassChildJob(supabase, {
      // Chain the retry off whichever parent the failed job had — that
      // keeps the import thread visible end-to-end on /jobs.
      parentJobId: parent.parent_job_id ?? failedJobId,
      relatedImportId: parent.related_import_id,
      createdBy: parent.created_by,
      orgId: parent.org_id,
      propertyIds,
      autoStart: true,
      sourceJobId: failedJobId,
      requestKey: failedJobId,
    });
    const childId = child.jobId;
    const claimToken = child.claimToken;
    if (!claimToken || child.status !== "running") {
      return ok({ total: propertyIds.length, childJobId: childId });
    }

    // Chunked workflow — retry sets after a mass failure can be as large
    // as the original job, so the inline path's 5-minute ceiling applies.
    after(async () => {
      try {
        await start(cassBulkWorkflow, [{ jobId: childId, claimToken }]);
      } catch (e) {
        reportError(e, {
          tags: { surface: "retry_failed_cass_workflow_start" },
          extra: { childId, propertyCount: propertyIds.length },
        });
        await failAuthorizedCassJobStart(supabase, {
          jobId: childId,
          orgId: parent.org_id,
          claimToken,
          error: e,
        });
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
      .select(
        "id, type, status, org_id, created_by, input_params, result_summary, provider_run_id, error_class",
      )
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
    const erroredItems = await readFailedJobItems(supabase, failedJobId);

    const allErroredIds = new Set(
      erroredItems
        .map((r) => r.property_id)
        .filter((id): id is string => typeof id === "string"),
    );
    const retryableIds = new Set(
      erroredItems
        .filter(
          (r) =>
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
      const inputParams =
        (parent.input_params as Record<string, unknown> | null) ?? {};
      const resultSummary =
        (parent.result_summary as Record<string, unknown> | null) ?? {};
      const hasModernSubmissionProvenance =
        typeof inputParams.submission_attempt_token === "string" ||
        typeof resultSummary.submit_phase === "string" ||
        typeof parent.provider_run_id === "string" ||
        parent.error_class === "submission_unknown";
      if (hasModernSubmissionProvenance) {
        return {
          ok: false,
          error: {
            code: "MANUAL_RECONCILIATION_REQUIRED",
            message:
              "This provider submission has modern recovery markers but no item ledger. Review the provider outcome manually; retry was not started.",
          },
        };
      }
      const fallback = (
        parent.input_params as { property_ids?: unknown } | null
      )?.property_ids;
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

    const preflight = await preflightSkipTrace(propertyIds);
    if (!preflight.ok) return preflight;
    if (!preflight.data.canLaunchSkipTrace) {
      return {
        ok: false,
        error: {
          code: "SKIP_TRACE_PREFLIGHT_BLOCKED",
          message:
            preflight.data.eligible === 0
              ? "No retryable property is currently eligible for skip tracing."
              : "Tracefy credits could not be confirmed for this retry. Run preflight again before retrying.",
        },
      };
    }

    const adminClient = createAdminClient();
    const { data: childRows, error: insertErr } = await adminClient.rpc(
      "create_skip_trace_retry_job",
      { p_parent_job_id: failedJobId, p_property_ids: propertyIds },
    );
    const childRow = childRows?.[0];
    if (insertErr || !childRow) {
      return {
        ok: false,
        error: {
          code: "JOB_CREATE_FAILED",
          message: insertErr?.message ?? "Failed to create child job",
        },
      };
    }

    if (childRow.created) {
      const { data: authorizedChild, error: authorizationError } =
        await adminClient
          .from("jobs")
          .update({
            input_params: {
              property_ids: propertyIds,
              authorized_max_credits: preflight.data.tracefyCreditsRequired,
              provider_pricing_version: "tracerfy-2026-08",
            },
          })
          .eq("id", childRow.job_id)
          .eq("org_id", parent.org_id)
          .eq("type", "skip_trace")
          .eq("status", "queued")
          .is("provider_run_id", null)
          .select("id")
          .maybeSingle();
      if (authorizationError || !authorizedChild) {
        await adminClient
          .from("jobs")
          .update({
            status: "failed",
            error_class: "validation",
            error_message:
              "Retry could not persist its approved credit ceiling. Run preflight again before retrying.",
            completed_at: new Date().toISOString(),
          })
          .eq("id", childRow.job_id)
          .eq("org_id", parent.org_id)
          .eq("status", "queued")
          .is("provider_run_id", null);
        return {
          ok: false,
          error: {
            code: "SKIP_TRACE_AUTHORIZATION_FAILED",
            message:
              authorizationError?.message ??
              "Retry job changed before its approved credit ceiling was saved.",
          },
        };
      }

      await recordLeadEvents(
        propertyIds.map((propertyId) => ({
          propertyId,
          eventType: LEAD_EVENT_TYPES.SKIP_TRACE_REQUESTED,
          actorType: "user" as const,
          actorId: user!.id,
          payload: {
            job_id: childRow.job_id,
            retry_of_job_id: failedJobId,
            batch_id: childRow.job_id,
            batch_count: propertyIds.length,
          },
        })),
      );
      try {
        await start(skipTraceSubmitWorkflow, [
          { jobId: childRow.job_id, orgId: parent.org_id },
        ]);
      } catch (e) {
        reportError(e, {
          tags: { surface: "retry_skip_trace_workflow_start" },
          extra: {
            childId: childRow.job_id,
            propertyCount: propertyIds.length,
          },
        });
      }
    }

    return ok({ total: propertyIds.length, childJobId: childRow.job_id });
  } catch (e) {
    reportError(e, {
      tags: { surface: "retry_skip_trace" },
      extra: { failedJobId },
    });
    return errFromUnknown(e, "RETRY_SKIP_TRACE_FAILED");
  }
}
