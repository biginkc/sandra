import { after } from "next/server";
import { start } from "workflow/api";

import { settleAdHocCampaignAfterQueueFailure, resolveAdHocBulkSmsCampaign } from "@/lib/campaigns/ad-hoc-bulk-sms";
import { errFromUnknown, ok, type Result } from "@/lib/errors/result";
import { reportError } from "@/lib/errors/report";
import type {
  BulkSmsQueueBaseOpts,
  BulkSmsQueueOpts,
  ResolvedBulkSmsQueueOpts,
} from "@/lib/messaging/bulk-queue";
import { validateSmsPaceSeconds, type SmsPacingProfile } from "@/lib/messaging/pacing";
import { createAdminClient } from "@/lib/supabase/admin";
import type { createClient } from "@/lib/supabase/server";
import { SEARCH_SMS_JOB_SURFACE, searchBulkSmsWorkflow } from "@/workflows/search-bulk-sms";

/** Selections up to this size queue synchronously (right after partitioning); larger ones are deferred. */
export const SEARCH_SYNC_BULK_SMS_LIMIT = 500;

function resolveServerOwnedPacingProfile(opts: BulkSmsQueueOpts): SmsPacingProfile | undefined {
  return opts.pacingProfile === "canary" && process.env.SANDRA_SMS_CANARY_PACING_ENABLED === "true"
    ? "canary"
    : undefined;
}

export type SearchDeferredSmsOutcome = {
  succeeded: 0;
  skipped: 0;
  failed: [];
  deferred: { jobId: string; total: number };
};

/**
 * Deferred (>500) ad-hoc bulk SMS for the Search page. Creates the ad-hoc campaign + job exactly
 * like the legacy path but starts the Search-owned workflow, which re-validates every chunk to
 * current prospects. `prospectIds` MUST already be the live, non-DNC prospect partition.
 */
export async function queueSearchSmsDeferred(
  supabase: Awaited<ReturnType<typeof createClient>>,
  prospectIds: string[],
  opts: BulkSmsQueueOpts & { campaignName: string },
): Promise<Result<SearchDeferredSmsOutcome>> {
  try {
    const {
      data: { user },
    } = await supabase.auth.getUser();
    const pacingProfile = resolveServerOwnedPacingProfile(opts);
    const pace = validateSmsPaceSeconds(opts.paceSeconds, { mode: "bulk", pacingProfile });
    if (!pace.ok) return { ok: false, error: { code: "VALIDATION", message: pace.message } };
    const baseOpts: BulkSmsQueueBaseOpts = {
      body: opts.body,
      templateCategory: opts.templateCategory,
      paceSeconds: pace.paceSeconds,
      pacingProfile,
      skipIfContacted: opts.skipIfContacted,
      jitterPct: opts.jitterPct,
      includeUnknown: opts.includeUnknown,
      senderNumber: opts.senderNumber,
      providerCampaignExternalId: opts.providerCampaignExternalId,
    };
    const campaign = await resolveAdHocBulkSmsCampaign(supabase, {
      campaignName: opts.campaignName,
      createdByUserId: user?.id ?? null,
      opts: baseOpts,
      propertyIds: prospectIds,
    });
    if (!campaign.ok) return campaign;
    const frozenIds = campaign.data.propertyIds;
    const resolvedOpts: ResolvedBulkSmsQueueOpts = {
      ...baseOpts,
      campaignId: campaign.data.campaignId,
      campaignSource: "ad_hoc_bulk_sms",
    };

    const settle = () => settleAdHocCampaignAfterQueueFailure(supabase, campaign.data.campaignId);
    const { data: probe } = await supabase.from("properties").select("org_id").eq("id", frozenIds[0]).single();
    if (!probe?.org_id) {
      await settle();
      return { ok: false, error: { code: "BULK_SMS_JOB_CREATE_FAILED", message: "Could not resolve the selection's organization" } };
    }
    const { data: jobRow, error: jobError } = await supabase
      .from("jobs")
      .insert({
        type: "bulk_sms",
        status: "queued",
        org_id: probe.org_id,
        created_by: user?.id ?? null,
        total_items: frozenIds.length,
        title: `Search bulk SMS ${frozenIds.length.toLocaleString()} prospects`,
        description: resolvedOpts.templateCategory ? `Template pool "${resolvedOpts.templateCategory}"` : "Custom message",
        input_params: {
          surface: SEARCH_SMS_JOB_SURFACE,
          property_ids: frozenIds,
          opts: resolvedOpts,
          anchor_ms: Date.now(),
        },
      })
      .select("id")
      .single();
    if (jobError || !jobRow) {
      await settle();
      return { ok: false, error: { code: "BULK_SMS_JOB_CREATE_FAILED", message: jobError?.message ?? "Job creation failed" } };
    }

    after(async () => {
      try {
        await start(searchBulkSmsWorkflow, [{ jobId: jobRow.id }]);
      } catch (e) {
        const admin = createAdminClient();
        await admin
          .from("jobs")
          .update({
            status: "failed",
            failed_items: frozenIds.length,
            completed_at: new Date().toISOString(),
            result_summary: { queued: 0, skipped: 0, failed: frozenIds.length, workflow_start_error: e instanceof Error ? e.message : String(e) },
          })
          .eq("id", jobRow.id);
        await settleAdHocCampaignAfterQueueFailure(admin, campaign.data.campaignId);
        reportError(e, { tags: { surface: "search_bulk_sms_workflow_start" }, extra: { jobId: jobRow.id } });
      }
    });
    return ok({ succeeded: 0, skipped: 0, failed: [], deferred: { jobId: jobRow.id, total: frozenIds.length } });
  } catch (e) {
    reportError(e, { tags: { surface: "search_bulk_sms_deferred" } });
    return errFromUnknown(e, "BULK_SMS_FAILED");
  }
}
