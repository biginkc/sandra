"use server";

import { after } from "next/server";
import { start } from "workflow/api";

import { createClient } from "@/lib/supabase/server";
import { errFromUnknown, ok, type Result } from "@/lib/errors/result";
import { reportError } from "@/lib/errors/report";
import {
  applyBulkUpdate,
  previewBulkUpdate,
  type UpdatePreview,
} from "@/lib/csv/update-bulk";
import type { SubOperationId } from "@/lib/csv/update-operations";
import type { Mapping } from "@/lib/csv/validate";
import { csvImportWorkflow } from "@/workflows/csv-import";

import type { WizardMarket, WizardSource } from "./wizard";

export type CreateImportJobParams = {
  filename: string;
  source: WizardSource;
  market: WizardMarket;
  /** Optional list name. Lookup-or-create within the importer's org. */
  listName: string | null;
  mapping: Mapping;
  /** Path within the csv-imports Storage bucket — uploaded by the wizard
   *  before this action runs. The workflow downloads it server-side to
   *  parse and ingest. */
  storagePath: string;
  /** Total row count from the client-side parse, stamped onto the jobs
   *  row immediately so the wizard's progress UI has a denominator
   *  before the workflow's first heartbeat. */
  totalRows: number;
  /** When true, the workflow bulk-records opt_in_marketing_written for every
   *  homeowner contact after ingest (operator attestation at import time). */
  smsConsent: boolean;
  /** When set, auto-enroll every imported property into this sequence after ingest. */
  sequenceId?: string | null;
};

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
        total_rows: params.totalRows,
        storage_path: params.storagePath,
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
        total_items: params.totalRows,
        related_import_id: importRow.id,
        created_by: userId,
        title: `Import ${params.filename}`,
        description: `${params.source} → ${params.market}: ${params.totalRows} rows`,
        input_params: {
          filename: params.filename,
          source: params.source,
          market: params.market,
          mapping: params.mapping as Record<string, string | null>,
          storagePath: params.storagePath,
          smsConsent: params.smsConsent,
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

    // Kick off the workflow runner. start() returns immediately — the
    // workflow's first step picks up where we leave off here. Wrapped in
    // `after()` so the action's HTTP response goes out before the start
    // call's network I/O completes; if `start()` itself throws, we still
    // surface the jobId to the wizard (the workflow can be re-triggered
    // from /jobs in the worst case).
    after(async () => {
      try {
        await start(csvImportWorkflow, [
          {
            jobId: jobRow.id,
            csvImportId: importRow.id,
            storagePath: params.storagePath,
            source: params.source,
            market: params.market,
            mapping: params.mapping,
            listId,
            userId,
            smsConsent: params.smsConsent,
            sequenceId: params.sequenceId ?? null,
          },
        ]);
      } catch (e) {
        reportError(e, {
          tags: { surface: "create_import_job_workflow_start" },
          extra: { jobId: jobRow.id },
        });
        await supabase
          .from("jobs")
          .update({
            status: "failed",
            error_class: "configuration",
            error_message:
              "Workflow runner failed to start. " +
              (e instanceof Error ? e.message : String(e)),
            completed_at: new Date().toISOString(),
          })
          .eq("id", jobRow.id);
      }
    });

    return ok({ jobId: jobRow.id });
  } catch (e) {
    reportError(e, { tags: { surface: "create_import_job" } });
    return errFromUnknown(e, "CREATE_IMPORT_JOB_FAILED");
  }
}

// ---------------------------------------------------------------------------
// Update mode
// ---------------------------------------------------------------------------

export type RunUpdatePreviewParams = {
  subOperationId: SubOperationId;
  rows: Record<string, string>[];
};

export async function runUpdatePreviewAction(
  params: RunUpdatePreviewParams,
): Promise<Result<UpdatePreview>> {
  try {
    const supabase = await createClient();
    const preview = await previewBulkUpdate(supabase, {
      subOperationId: params.subOperationId,
      rows: params.rows,
    });
    return ok(preview);
  } catch (e) {
    reportError(e, { tags: { surface: "run_update_preview" } });
    return errFromUnknown(e, "RUN_UPDATE_PREVIEW_FAILED");
  }
}

export type RunBulkUpdateJobParams = {
  subOperationId: SubOperationId;
  rows: Record<string, string>[];
  filename: string;
};

export type RunBulkUpdateJobResult = { jobId: string };

export async function runBulkUpdateJob(
  params: RunBulkUpdateJobParams,
): Promise<Result<RunBulkUpdateJobResult>> {
  try {
    const supabase = await createClient();
    const { data: userData } = await supabase.auth.getUser();
    const userId = userData.user?.id ?? null;

    const { data: jobRow, error: jobError } = await supabase
      .from("jobs")
      .insert({
        type: "csv_update",
        status: "queued",
        total_items: params.rows.length,
        created_by: userId,
        title: `Update ${params.filename}`,
        description: `${params.subOperationId}: ${params.rows.length} rows`,
        input_params: {
          subOperationId: params.subOperationId,
          filename: params.filename,
          rowCount: params.rows.length,
        },
      })
      .select("id")
      .single();

    if (jobError) {
      return {
        ok: false,
        error: { code: "JOB_INSERT_FAILED", message: jobError.message },
      };
    }

    after(async () => {
      try {
        await applyBulkUpdate(supabase, {
          subOperationId: params.subOperationId,
          rows: params.rows,
          userId,
          jobId: jobRow.id,
        });
      } catch (e) {
        reportError(e, {
          tags: { surface: "run_bulk_update_job_after" },
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
      }
    });

    return ok({ jobId: jobRow.id });
  } catch (e) {
    reportError(e, { tags: { surface: "run_bulk_update_job" } });
    return errFromUnknown(e, "RUN_BULK_UPDATE_JOB_FAILED");
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
