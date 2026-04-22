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

import type { WizardMarket, WizardSource } from "./wizard";

export type CreateImportJobParams = {
  filename: string;
  source: WizardSource;
  market: WizardMarket;
  mapping: Mapping;
  rows: RowData[];
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
        total_rows: params.rows.length,
        user_id: userId,
      })
      .select("id")
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
    });

    return ok({ jobId: jobRow.id });
  } catch (e) {
    reportError(e, { tags: { surface: "create_import_job" } });
    return errFromUnknown(e, "CREATE_IMPORT_JOB_FAILED");
  }
}
