"use server";

import { revalidatePath } from "next/cache";
import { after } from "next/server";
import { start } from "workflow/api";

import { isAdminEmail } from "@/lib/auth/allowlist";
import { getCallerMemberships } from "@/lib/auth/memberships";
import {
  claimAuthorizedCassJobStart,
  createCassChildJob,
  failAuthorizedCassJobStart,
  selectCassEligibleProperties,
} from "@/lib/enrichment/cass-job";
import { cassBulkWorkflow } from "@/workflows/cass-bulk";
import { errFromUnknown, ok, type Result } from "@/lib/errors/result";
import { reportError } from "@/lib/errors/report";
import { LEAD_EVENT_TYPES, recordLeadEvents } from "@/lib/events";
import { createAdminClient } from "@/lib/supabase/admin";
import { createClient } from "@/lib/supabase/server";
import { preflightSkipTrace } from "@/lib/skip-trace/actions";
import { resolveProspectEligibility } from "@/lib/prospects/eligibility";
import type { Json } from "@/lib/supabase/types";
import { skipTraceSubmitWorkflow } from "@/workflows/skip-trace-submit";

const JOB_ITEM_PAGE_SIZE = 500;
const EXACT_COHORT_JOB_TYPES = new Set(["skip_trace"]);
const EXACT_COHORT_TERMINAL_STATUSES = new Set([
  "completed",
  "partial",
  "partially_completed",
]);
const EXACT_COHORT_LIST_MARKER_PREFIX = "Sandra exact cohort source job: ";
const EXACT_COHORT_WRITE_CHUNK = 500;

export type CreateExactCohortListInput = {
  jobId: string;
  name: string;
};

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

/** Create the missing CASS child for one completed import's exact ledger. */
export async function recoverCassForImport(
  importJobId: string,
): Promise<Result<{ total: number; childJobId: string }>> {
  try {
    const supabase = await createClient();
    const { data: { user } } = await supabase.auth.getUser();
    if (!isAdminEmail(user?.email)) {
      return { ok: false, error: { code: "FORBIDDEN", message: "Admin access is required." } };
    }
    const { data: parent, error } = await supabase
      .from("jobs")
      .select("id, org_id, type, status, related_import_id, created_by")
      .eq("id", importJobId)
      .maybeSingle();
    if (error || !parent) {
      return { ok: false, error: { code: "JOB_NOT_FOUND", message: error?.message ?? "Import job not found." } };
    }
    if (parent.type !== "csv_import" || !["completed", "partial"].includes(parent.status)) {
      return { ok: false, error: { code: "IMPORT_NOT_TERMINAL", message: "CASS recovery requires a completed CSV import." } };
    }
    const propertyIds = await selectCassEligibleProperties(supabase, parent.id, parent.org_id);
    if (propertyIds.length === 0) {
      return { ok: false, error: { code: "NO_CASS_ELIGIBLE_PROPERTIES", message: "No unverified properties remain in this import." } };
    }
    const child = await createCassChildJob(supabase, {
      parentJobId: parent.id,
      relatedImportId: parent.related_import_id,
      createdBy: parent.created_by,
      orgId: parent.org_id,
      propertyIds,
      autoStart: false,
      blockedReason: "Import recovery awaiting CASS cost approval",
      // The authorization receipt accepts UUID request keys. Reusing the
      // parent import ID makes double-clicks idempotent and matches the
      // normal CSV-import CASS child path.
      requestKey: parent.id,
    });
    if (!child.created && !["queued", "running"].includes(child.status)) {
      return {
        ok: false,
        error: {
          code: "CASS_RECOVERY_ALREADY_TERMINAL",
          message: `The existing CASS recovery job is ${child.status}. Open it from Linked jobs and use its explicit retry or review path.`,
        },
      };
    }
    return ok({ total: propertyIds.length, childJobId: child.jobId });
  } catch (e) {
    reportError(e, { tags: { surface: "recover_cass_for_import" }, extra: { importJobId } });
    return errFromUnknown(e, "RECOVER_CASS_FOR_IMPORT_FAILED");
  }
}

/**
 * Materialize the exact property cohort recorded by a completed enrichment
 * skip-trace job into a reusable list. The list is deliberately job-scoped: reusing a
 * user-created list with unrelated memberships would turn an exact cohort
 * into a broad audience, so a name collision is rejected unless the existing
 * row carries this action's source-job marker.
 *
 * This action only writes list metadata and property memberships. It never
 * queues skip trace, builds campaign recipients, or sends messages.
 */
export async function createExactCohortList(
  input: CreateExactCohortListInput,
): Promise<
  Result<{
    listId: string;
    name: string;
    memberCount: number;
    dncExcludedCount: number;
    traceExcludedCount: number;
    sourceJobId: string;
  }>
> {
  const name = input.name.trim();
  if (!name) {
    return {
      ok: false,
      error: { code: "VALIDATION", message: "List name is required." },
    };
  }
  if (name.length > 80) {
    return {
      ok: false,
      error: {
        code: "VALIDATION",
        message: `Name is ${name.length} characters — cap is 80.`,
      },
    };
  }
  if (!input.jobId.trim()) {
    return {
      ok: false,
      error: { code: "VALIDATION", message: "Source job is required." },
    };
  }

  try {
    const supabase = await createClient();
    const {
      data: { user },
    } = await supabase.auth.getUser();
    if (!user) {
      return {
        ok: false,
        error: { code: "NOT_AUTHENTICATED", message: "Not authenticated." },
      };
    }

    const { data: job, error: jobError } = await supabase
      .from("jobs")
      .select("id, org_id, type, status, input_params, related_import_id")
      .eq("id", input.jobId)
      .maybeSingle();
    if (jobError || !job) {
      return {
        ok: false,
        error: {
          code: "JOB_NOT_FOUND",
          message: jobError?.message ?? "Source job not found.",
        },
      };
    }

    const memberships = await getCallerMemberships();
    if (!memberships.some((membership) => membership.org_id === job.org_id)) {
      return {
        ok: false,
        error: {
          code: "FORBIDDEN",
          message: "You do not have access to the source job's organization.",
        },
      };
    }
    if (!EXACT_COHORT_JOB_TYPES.has(job.type)) {
      return {
        ok: false,
        error: {
          code: "JOB_WRONG_TYPE",
          message: "Only completed skip-trace jobs can create an exact cohort list.",
        },
      };
    }
    if (!EXACT_COHORT_TERMINAL_STATUSES.has(job.status)) {
      return {
        ok: false,
        error: {
          code: "JOB_NOT_TERMINAL",
          message: `The source job is ${job.status}; wait until it is complete before creating a list.`,
        },
      };
    }

    const requestedPropertyIds = readExactCohortPropertyIds(job.input_params);
    if (requestedPropertyIds.length === 0) {
      return {
        ok: false,
        error: {
          code: "JOB_NO_PROPERTIES",
          message: "The source job has no persisted property IDs.",
        },
      };
    }

    // A partial trace must never place provider failures into a campaign list.
    // `success` covers both matched and confirmed no-match trace results; both
    // are completed trace attempts, while `error`/`skipped` require separate
    // recovery rather than silent inclusion.
    const successfulPropertyIds = await readSuccessfulSkipTracePropertyIds(
      supabase,
      job.id,
      new Set(requestedPropertyIds),
    );
    if (successfulPropertyIds.length === 0) {
      return {
        ok: false,
        error: {
          code: "JOB_NO_SUCCESSFUL_PROPERTIES",
          message: "This skip-trace job has no successful property results to place in a campaign list.",
        },
      };
    }

    // Check ownership and soft-deletion before the shared DNC resolver. A
    // forged or stale job payload must not cause memberships to be written
    // across organizations, nor should a partially missing cohort be silently
    // turned into a smaller list.
    const ownedIds = new Set<string>();
    for (
      let offset = 0;
      offset < successfulPropertyIds.length;
      offset += EXACT_COHORT_WRITE_CHUNK
    ) {
      const { data: ownedProperties, error: ownershipError } = await supabase
        .from("properties")
        .select("id")
        .eq("org_id", job.org_id)
        .is("deleted_at", null)
        .in(
          "id",
          successfulPropertyIds.slice(
            offset,
            offset + EXACT_COHORT_WRITE_CHUNK,
          ),
        );
      if (ownershipError) {
        return {
          ok: false,
          error: {
            code: "COHORT_OWNERSHIP_CHECK_FAILED",
            message: ownershipError.message,
          },
        };
      }
      for (const property of ownedProperties ?? []) ownedIds.add(property.id);
    }
    if (ownedIds.size !== successfulPropertyIds.length) {
      return {
        ok: false,
        error: {
          code: "COHORT_OWNERSHIP_FAILED",
          message:
            "The source job no longer resolves to the same live properties in this organization; no list was written.",
        },
      };
    }

    // DNC is evaluated immediately before the list write. The resulting list
    // is safe to reuse as a campaign filter without carrying DNC-locked rows.
    const eligibility = await resolveProspectEligibility(
      supabase,
      successfulPropertyIds,
      "selection",
    );
    const nonProspectExclusions = eligibility.exclusions.filter(
      (exclusion) => exclusion.reason === "not_found_or_not_prospect",
    );
    if (nonProspectExclusions.length > 0) {
      return {
        ok: false,
        error: {
          code: "COHORT_NOT_CURRENT_PROSPECTS",
          message:
            "The successful skip-trace cohort no longer resolves entirely to live prospects; no list was written.",
        },
      };
    }
    if (eligibility.eligibleIds.length === 0) {
      return {
        ok: false,
        error: {
          code: "NO_ELIGIBLE_PROPERTIES",
          message: "No live, non-DNC properties remain in this exact cohort.",
        },
      };
    }

    const marker = `${EXACT_COHORT_LIST_MARKER_PREFIX}${job.id}`;
    const { data: listRows, error: listLookupError } = await supabase
      .from("lists")
      .select("id, name, description, archived_at, system_managed")
      .eq("org_id", job.org_id);
    if (listLookupError) {
      return {
        ok: false,
        error: {
          code: "LIST_LOOKUP_FAILED",
          message: listLookupError.message,
        },
      };
    }
    const existing = (listRows ?? []).find(
      (row) => row.name.trim().toLowerCase() === name.toLowerCase(),
    );
    if (existing?.system_managed) {
      return {
        ok: false,
        error: {
          code: "SYSTEM_MANAGED_LIST",
          message: "System-managed lists cannot be used for an exact cohort.",
        },
      };
    }
    if (existing && existing.description !== marker) {
      return {
        ok: false,
        error: {
          code: "LIST_NAME_COLLISION",
          message:
            `A list named "${name}" already exists for a different cohort. Choose a new exact-cohort name.`,
        },
      };
    }

    // Keep the marker exact so a user-created list cannot accidentally look
    // like an action-owned exact cohort and then be broadened or rewritten.
    const listDescription = marker;
    let listId = existing?.id ?? null;
    if (!listId) {
      const { data: created, error: createError } = await supabase
        .from("lists")
        .insert({
          org_id: job.org_id,
          name,
          description: listDescription,
          created_by: user.id,
        })
        .select("id")
        .single();
      if (createError || !created) {
        return {
          ok: false,
          error: {
            code: "LIST_CREATE_FAILED",
            message: createError?.message ?? "Could not create exact cohort list.",
          },
        };
      }
      listId = created.id;
    } else if (existing && existing.archived_at) {
      const { error: restoreError } = await supabase
        .from("lists")
        .update({ archived_at: null, description: listDescription })
        .eq("id", listId)
        .eq("org_id", job.org_id);
      if (restoreError) {
        return {
          ok: false,
          error: { code: "LIST_UPDATE_FAILED", message: restoreError.message },
        };
      }
    }

    let currentMemberships: string[];
    try {
      currentMemberships = await readListMembershipPropertyIds(
        supabase,
        job.org_id,
        listId,
      );
    } catch (error) {
      return {
        ok: false,
        error: {
          code: "LIST_MEMBERSHIP_LOOKUP_FAILED",
          message: error instanceof Error ? error.message : String(error),
        },
      };
    }

    const eligibleIds = new Set(eligibility.eligibleIds);
    const staleIds = currentMemberships.filter(
      (propertyId) => !eligibleIds.has(propertyId),
    );
    for (let offset = 0; offset < staleIds.length; offset += EXACT_COHORT_WRITE_CHUNK) {
      const { error: deleteError } = await supabase
        .from("property_lists")
        .delete()
        .eq("org_id", job.org_id)
        .eq("list_id", listId)
        .in("property_id", staleIds.slice(offset, offset + EXACT_COHORT_WRITE_CHUNK));
      if (deleteError) {
        return {
          ok: false,
          error: {
            code: "LIST_MEMBERSHIP_WRITE_FAILED",
            message: deleteError.message,
          },
        };
      }
    }

    const now = new Date().toISOString();
    for (
      let offset = 0;
      offset < eligibility.eligibleIds.length;
      offset += EXACT_COHORT_WRITE_CHUNK
    ) {
      const rows = eligibility.eligibleIds
        .slice(offset, offset + EXACT_COHORT_WRITE_CHUNK)
        .map((propertyId) => ({
          org_id: job.org_id,
          property_id: propertyId,
          list_id: listId,
          last_added_at: now,
          last_added_by: user.id,
          ...(job.related_import_id
            ? { last_source_import_id: job.related_import_id }
            : {}),
        }));
      const { error: upsertError } = await supabase
        .from("property_lists")
        .upsert(rows, {
          onConflict: "property_id,list_id",
          ignoreDuplicates: false,
        });
      if (upsertError) {
        return {
          ok: false,
          error: {
            code: "LIST_MEMBERSHIP_WRITE_FAILED",
            message: upsertError.message,
          },
        };
      }
    }

    let verifiedMemberships: string[];
    try {
      verifiedMemberships = await readListMembershipPropertyIds(
        supabase,
        job.org_id,
        listId,
      );
    } catch (error) {
      return {
        ok: false,
        error: {
          code: "LIST_MEMBERSHIP_VERIFY_FAILED",
          message: error instanceof Error ? error.message : String(error),
        },
      };
    }
    const verifiedIds = new Set(verifiedMemberships);
    if (
      verifiedIds.size !== eligibleIds.size ||
      [...eligibleIds].some((propertyId) => !verifiedIds.has(propertyId))
    ) {
      return {
        ok: false,
        error: {
          code: "LIST_MEMBERSHIP_VERIFY_FAILED",
          message: "Exact cohort list membership could not be verified.",
        },
      };
    }

    revalidatePath("/lists");
    revalidatePath("/campaigns");
    revalidatePath(`/jobs/${job.id}`);
    return ok({
      listId,
      name,
      memberCount: eligibleIds.size,
      dncExcludedCount: eligibility.dncLockedCount,
      traceExcludedCount:
        requestedPropertyIds.length - successfulPropertyIds.length,
      sourceJobId: job.id,
    });
  } catch (e) {
    reportError(e, {
      tags: { surface: "create_exact_cohort_list" },
      extra: { jobId: input.jobId },
    });
    return errFromUnknown(e, "CREATE_EXACT_COHORT_LIST_FAILED");
  }
}

function readExactCohortPropertyIds(inputParams: Json | null): string[] {
  if (!inputParams || typeof inputParams !== "object" || Array.isArray(inputParams)) {
    return [];
  }
  const raw = (inputParams as Record<string, unknown>).property_ids;
  if (!Array.isArray(raw)) return [];
  return Array.from(
    new Set(
      raw.filter(
        (propertyId): propertyId is string =>
          typeof propertyId === "string" && propertyId.trim().length > 0,
      ),
    ),
  );
}

async function readSuccessfulSkipTracePropertyIds(
  supabase: Awaited<ReturnType<typeof createClient>>,
  jobId: string,
  requestedPropertyIds: Set<string>,
): Promise<string[]> {
  const ids = new Set<string>();
  for (let from = 0; ; from += EXACT_COHORT_WRITE_CHUNK) {
    const { data, error } = await supabase
      .from("job_items")
      .select("property_id")
      .eq("job_id", jobId)
      .eq("status", "success")
      .not("property_id", "is", null)
      .order("id", { ascending: true })
      .range(from, from + EXACT_COHORT_WRITE_CHUNK - 1);
    if (error) throw error;
    for (const row of data ?? []) {
      if (row.property_id && requestedPropertyIds.has(row.property_id)) {
        ids.add(row.property_id);
      }
    }
    if (!data || data.length < EXACT_COHORT_WRITE_CHUNK) break;
  }
  return [...ids];
}

async function readListMembershipPropertyIds(
  supabase: Awaited<ReturnType<typeof createClient>>,
  orgId: string,
  listId: string,
): Promise<string[]> {
  const ids: string[] = [];
  for (let from = 0; ; from += EXACT_COHORT_WRITE_CHUNK) {
    const { data, error } = await supabase
      .from("property_lists")
      .select("property_id")
      .eq("org_id", orgId)
      .eq("list_id", listId)
      .order("property_id", { ascending: true })
      .range(from, from + EXACT_COHORT_WRITE_CHUNK - 1);
    if (error) throw new Error(error.message);
    ids.push(...(data ?? []).map((row) => row.property_id));
    if (!data || data.length < EXACT_COHORT_WRITE_CHUNK) break;
  }
  return ids;
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
