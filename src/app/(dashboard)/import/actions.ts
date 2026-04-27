"use server";

import { after } from "next/server";

import { createClient } from "@/lib/supabase/server";
import { errFromUnknown, ok, type Result } from "@/lib/errors/result";
import { reportError } from "@/lib/errors/report";
import { runIngestion } from "@/lib/csv/ingest";
import type { Mapping, RowData } from "@/lib/csv/validate";
import {
  createCassChildJob,
  getAutotriggerCap,
  runCassEnrichment,
} from "@/lib/enrichment/cass-job";
import { requestSkipTrace } from "@/lib/skip-trace/actions";

import type { WizardMarket, WizardSource } from "./wizard";

export type CreateImportJobParams = {
  filename: string;
  source: WizardSource;
  market: WizardMarket;
  /** Optional list name. Lookup-or-create within the importer's org. */
  listName: string | null;
  mapping: Mapping;
  rows: RowData[];
  /** Surface C — when true, after CASS auto-trigger, also request a
   *  skip-trace job for the newly imported properties. Goes through
   *  the same approval flow as a manual request. Off by default. */
  requestSkipTrace?: boolean;
};

const SKIP_TRACE_PER_JOB_CAP = 500;

export type CreateImportJobResult = { jobId: string };

export async function createImportJob(
  params: CreateImportJobParams,
): Promise<Result<CreateImportJobResult>> {
  try {
    const supabase = await createClient();
    const { data: userData } = await supabase.auth.getUser();
    const userId = userData.user?.id ?? null;

    const { data: importRow, error: importError } = await supabase
      .from("csv_imports")
      .insert({
        filename: params.filename,
        source: params.source,
        market: params.market,
        total_rows: params.rows.length,
        user_id: userId,
      })
      .select("id, org_id")
      .single();

    if (importError) {
      return {
        ok: false,
        error: {
          code: "CSV_IMPORT_INSERT_FAILED",
          message: importError.message,
        },
      };
    }

    // Resolve the optional list — lookup by (org_id, name); create if missing.
    // Any error here is non-fatal for the import itself; we log and continue
    // without a listId. (The alternative — aborting a 10K-row ingest because
    // the list name had a funny character — is a worse UX.)
    let listId: string | null = null;
    if (params.listName) {
      try {
        listId = await resolveOrCreateList(
          supabase,
          importRow.org_id,
          params.listName,
          userId,
        );
      } catch (e) {
        reportError(e, {
          tags: { surface: "resolve_or_create_list" },
          extra: { listName: params.listName, orgId: importRow.org_id },
        });
        // Proceed without list membership.
      }
    }

    const { data: jobRow, error: jobError } = await supabase
      .from("jobs")
      .insert({
        type: "csv_import",
        status: "queued",
        total_items: params.rows.length,
        related_import_id: importRow.id,
        created_by: userId,
        title: `Import ${params.filename}`,
        description: `${params.source} → ${params.market}: ${params.rows.length} rows`,
        input_params: {
          filename: params.filename,
          source: params.source,
          market: params.market,
          mapping: params.mapping as Record<string, string | null>,
        },
      })
      .select("id")
      .single();

    if (jobError) {
      return {
        ok: false,
        error: {
          code: "JOB_INSERT_FAILED",
          message: jobError.message,
        },
      };
    }

    // Return the jobId immediately; run ingestion in the background so the
    // client can subscribe to `jobs` via Realtime and watch progress fill
    // live. `after()` keeps the Node process alive until the task finishes.
    // The supabase client instance captured above carries its own cookie
    // state, so it stays valid after the response is flushed.
    after(async () => {
      try {
        await runIngestion(supabase, {
          jobId: jobRow.id,
          csvImportId: importRow.id,
          source: params.source,
          market: params.market,
          mapping: params.mapping,
          rows: params.rows,
          listId,
          userId,
        });
      } catch (e) {
        reportError(e, {
          tags: { surface: "create_import_job_after" },
          extra: { jobId: jobRow.id },
        });
        await supabase
          .from("jobs")
          .update({
            status: "failed",
            error_class: "database",
            error_message: e instanceof Error ? e.message : String(e),
            completed_at: new Date().toISOString(),
          })
          .eq("id", jobRow.id);
        return;
      }

      // Auto-trigger CASS enrichment for every property that was newly
      // inserted by this import (duplicates already carry prior CASS state,
      // so we skip them). Failures inside CASS are isolated — they update
      // the child job's status without touching the parent import.
      try {
        const { data: items } = await supabase
          .from("job_items")
          .select("property_id")
          .eq("job_id", jobRow.id)
          .eq("status", "success")
          .not("property_id", "is", null);

        const propertyIds = (items ?? [])
          .map((r) => r.property_id)
          .filter((id): id is string => typeof id === "string");

        if (propertyIds.length === 0) return;

        const cap = getAutotriggerCap();
        const autoStart = propertyIds.length <= cap;
        const childId = await createCassChildJob(supabase, {
          parentJobId: jobRow.id,
          relatedImportId: importRow.id,
          createdBy: userId,
          propertyIds,
          autoStart,
          blockedReason: autoStart
            ? undefined
            : `${propertyIds.length} items exceeds CASS_AUTOTRIGGER_MAX_ITEMS=${cap}`,
        });

        if (autoStart) {
          await runCassEnrichment(supabase, { jobId: childId, propertyIds });
        }
      } catch (e) {
        reportError(e, {
          tags: { surface: "create_import_job_after_cass" },
          extra: { jobId: jobRow.id },
        });
        // Parent import is already completed — don't flip its status.
        // Any CASS-side failures are reflected on the child job row
        // (or just absent if we couldn't create one).
      }

      // Surface C: opt-in skip-trace request after CASS. Only fires when
      // the importer ticked the wizard checkbox. Honors the per-job cap
      // (refuse silently if over — the wizard already disables the
      // checkbox in that case, so this is defense in depth).
      if (params.requestSkipTrace) {
        try {
          const { data: stItems } = await supabase
            .from("job_items")
            .select("property_id")
            .eq("job_id", jobRow.id)
            .eq("status", "success")
            .not("property_id", "is", null);

          const stPropertyIds = (stItems ?? [])
            .map((r) => r.property_id)
            .filter((id): id is string => typeof id === "string")
            .slice(0, SKIP_TRACE_PER_JOB_CAP);

          if (stPropertyIds.length > 0) {
            // requestSkipTrace handles the admin/VA branching and
            // notifications. We don't surface the result back to the
            // wizard — the user gets a separate notification on /jobs.
            await requestSkipTrace(stPropertyIds);
          }
        } catch (e) {
          reportError(e, {
            tags: { surface: "create_import_job_after_skip_trace" },
            extra: { jobId: jobRow.id },
          });
        }
      }
    });

    return ok({ jobId: jobRow.id });
  } catch (e) {
    reportError(e, { tags: { surface: "create_import_job" } });
    return errFromUnknown(e, "CREATE_IMPORT_JOB_FAILED");
  }
}

/**
 * Lookup-or-create a list by (org_id, name). Used by the import wizard
 * to resolve the optional "Add to list" input to a concrete list_id
 * without making the user first go to /lists to create the list.
 * Names are trimmed. Case-insensitive match against existing lists so
 * "Absentee" and "absentee" don't accidentally create two lists.
 */
async function resolveOrCreateList(
  supabase: Awaited<ReturnType<typeof createClient>>,
  orgId: string,
  rawName: string,
  createdBy: string | null,
): Promise<string> {
  const name = rawName.trim();
  if (!name) throw new Error("List name is empty");

  // Case-insensitive match to honor REISift's "one list per data type"
  // guideline — typing "Probate" when a "probate" list exists reuses it.
  const { data: existing, error: lookupErr } = await supabase
    .from("lists")
    .select("id, archived_at")
    .eq("org_id", orgId)
    .ilike("name", name)
    .maybeSingle();
  if (lookupErr) throw new Error(`list lookup: ${lookupErr.message}`);
  if (existing) {
    // Reviving an archived list silently un-archives it. VAs typing a
    // name don't want a surprise "list is archived" error on import.
    if (existing.archived_at) {
      await supabase
        .from("lists")
        .update({ archived_at: null })
        .eq("id", existing.id);
    }
    return existing.id;
  }

  const { data: created, error: createErr } = await supabase
    .from("lists")
    .insert({
      org_id: orgId,
      name,
      created_by: createdBy,
    })
    .select("id")
    .single();
  if (createErr) throw new Error(`list insert: ${createErr.message}`);
  return created.id;
}
