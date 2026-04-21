"use server";

import { after } from "next/server";

import { createClient } from "@/lib/supabase/server";
import { errFromUnknown, ok, type Result } from "@/lib/errors/result";
import { reportError } from "@/lib/errors/report";
import { runIngestion } from "@/lib/csv/ingest";
import type { Mapping, RowData } from "@/lib/csv/validate";

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
      }
    });

    return ok({ jobId: jobRow.id });
  } catch (e) {
    reportError(e, { tags: { surface: "create_import_job" } });
    return errFromUnknown(e, "CREATE_IMPORT_JOB_FAILED");
  }
}
