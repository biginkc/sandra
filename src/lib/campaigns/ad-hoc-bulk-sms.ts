import type { SupabaseClient } from "@supabase/supabase-js";

import type { Result } from "@/lib/errors/result";
import { ok } from "@/lib/errors/result";
import type { BulkSmsQueueBaseOpts } from "@/lib/messaging/bulk-queue";
import {
  persistCampaignDeliverySettings,
  resolveDeliverySelection,
} from "@/lib/messaging/delivery";
import type { Database, Json } from "@/lib/supabase/types";

const PROPERTY_CHUNK = 250;
const UPSERT_CHUNK = 500;
const CAMPAIGN_NAME_MAX = 80;

type Supabase = SupabaseClient<Database>;

type SelectedPropertyRow = {
  id: string;
  org_id: string | null;
  homeowner_contact_id: string | null;
};

export type AdHocBulkSmsCampaignResolution = {
  campaignId: string;
  propertyIds: string[];
};

export function normalizeAdHocCampaignName(
  value: unknown,
): Result<string> {
  const name = typeof value === "string" ? value.trim() : "";
  if (!name) {
    return {
      ok: false,
      error: { code: "VALIDATION", message: "Campaign name is required." },
    };
  }
  if (name.length > CAMPAIGN_NAME_MAX) {
    return {
      ok: false,
      error: {
        code: "VALIDATION",
        message: `Name is ${name.length} characters — cap is ${CAMPAIGN_NAME_MAX}.`,
      },
    };
  }
  return ok(name);
}

function uniqueIds(ids: string[]): string[] {
  const seen = new Set<string>();
  const result: string[] = [];
  for (const id of ids) {
    if (seen.has(id)) continue;
    seen.add(id);
    result.push(id);
  }
  return result;
}

async function fetchSelectedProperties(
  supabase: Supabase,
  propertyIds: string[],
): Promise<Result<SelectedPropertyRow[]>> {
  const rows: SelectedPropertyRow[] = [];
  for (let i = 0; i < propertyIds.length; i += PROPERTY_CHUNK) {
    const chunk = propertyIds.slice(i, i + PROPERTY_CHUNK);
    const { data, error } = await supabase
      .from("properties")
      .select("id, org_id, homeowner_contact_id")
      .in("id", chunk);
    if (error) {
      return {
        ok: false,
        error: {
          code: "CAMPAIGN_RECIPIENTS_FETCH_FAILED",
          message: error.message,
        },
      };
    }
    rows.push(...((data ?? []) satisfies SelectedPropertyRow[]));
  }
  return ok(rows);
}

async function persistRecipients(
  supabase: Supabase,
  campaignId: string,
  rows: SelectedPropertyRow[],
): Promise<Result<null>> {
  for (let i = 0; i < rows.length; i += UPSERT_CHUNK) {
    const chunk = rows.slice(i, i + UPSERT_CHUNK);
    const { error } = await supabase.from("campaign_recipients").upsert(
      chunk.map((row) => ({
        campaign_id: campaignId,
        property_id: row.id,
        contact_id: row.homeowner_contact_id,
      })),
      {
        onConflict: "campaign_id,property_id",
        ignoreDuplicates: true,
      },
    );
    if (error) {
      return {
        ok: false,
        error: {
          code: "CAMPAIGN_RECIPIENTS_INSERT_FAILED",
          message: error.message,
        },
      };
    }
  }
  return ok(null);
}

function normalizedBody(opts: BulkSmsQueueBaseOpts): string | null {
  return typeof opts.body === "string" && opts.body.trim().length > 0
    ? opts.body.trim()
    : null;
}

function normalizedTemplateCategory(
  opts: BulkSmsQueueBaseOpts,
): string | null {
  return typeof opts.templateCategory === "string" &&
    opts.templateCategory.trim().length > 0
    ? opts.templateCategory.trim()
    : null;
}

function duplicateNameError(name: string): Result<never> {
  return {
    ok: false,
    error: {
      code: "DUPLICATE_NAME",
      message: `A campaign named "${name}" already exists.`,
    },
  };
}

export async function resolveAdHocBulkSmsCampaign(
  supabase: Supabase,
  args: {
    campaignName: string;
    createdByUserId: string | null;
    opts: BulkSmsQueueBaseOpts;
    propertyIds: string[];
  },
): Promise<Result<AdHocBulkSmsCampaignResolution>> {
  const nameResult = normalizeAdHocCampaignName(args.campaignName);
  if (!nameResult.ok) return nameResult;
  const name = nameResult.data;

  const requestedIds = uniqueIds(args.propertyIds);
  const selectedResult = await fetchSelectedProperties(supabase, requestedIds);
  if (!selectedResult.ok) return selectedResult;
  const selectedById = new Map(
    selectedResult.data.map((row) => [row.id, row]),
  );
  const selectedRows = requestedIds
    .map((id) => selectedById.get(id))
    .filter((row): row is SelectedPropertyRow => Boolean(row));

  if (selectedRows.length === 0) {
    return {
      ok: false,
      error: {
        code: "NO_RECIPIENTS",
        message: "Bulk SMS selection resolved to zero readable prospects.",
      },
    };
  }

  const orgIds = new Set(
    selectedRows
      .map((row) => row.org_id)
      .filter((value): value is string => typeof value === "string"),
  );
  if (orgIds.size !== 1) {
    return {
      ok: false,
      error: {
        code: "CAMPAIGN_ORG_RESOLUTION_FAILED",
        message: "Bulk SMS selection must resolve to one organization.",
      },
    };
  }
  const orgId = Array.from(orgIds)[0];

  const { data: activeCandidates, error: lookupError } = await supabase
    .from("campaigns")
    .select("id")
    .eq("org_id", orgId)
    .eq("name", name)
    .is("archived_at", null)
    .limit(1);
  if (lookupError) {
    return {
      ok: false,
      error: {
        code: "CAMPAIGN_LOOKUP_FAILED",
        message: lookupError.message,
      },
    };
  }
  if ((activeCandidates ?? []).length > 0) {
    return duplicateNameError(name);
  }

  // Delivery setup is required before any campaign can queue — ad-hoc
  // bulk SMS creates the campaign here, so the sender is validated and
  // snapshotted here, through the same resolver as saved campaigns.
  if (!args.opts.senderNumber) {
    return {
      ok: false,
      error: {
        code: "SENDER_REQUIRED",
        message: "Choose a sending number before queueing bulk SMS.",
      },
    };
  }
  const deliveryResult = await resolveDeliverySelection(
    supabase,
    orgId,
    args.opts.senderNumber,
    args.opts.providerCampaignExternalId,
  );
  if (!deliveryResult.ok) return deliveryResult;
  const delivery = deliveryResult.data;

  const now = new Date().toISOString();
  const { data: campaign, error: insertError } = await supabase
    .from("campaigns")
    .insert({
      org_id: orgId,
      name,
      channel: "sms",
      status: "launching",
      audience_snapshot: {
        source: "bulk_sms_modal",
        selection: { count: selectedRows.length },
      } as Json,
      body: normalizedBody(args.opts),
      template_category: normalizedTemplateCategory(args.opts),
      pace_seconds: Number.isInteger(args.opts.paceSeconds)
        ? args.opts.paceSeconds
        : null,
      skip_if_contacted: args.opts.skipIfContacted ?? false,
      sender_provider: delivery.senderProvider,
      sender_number: delivery.senderNumber,
      provider_campaign_external_id: delivery.providerCampaignExternalId,
      provider_campaign_name: delivery.providerCampaignName,
      created_by: args.createdByUserId,
      created_at: now,
      updated_at: now,
    })
    .select("id")
    .single();

  if (insertError || !campaign?.id) {
    const message = insertError?.message ?? "Campaign creation failed";
    if (
      insertError?.code === "23505" ||
      message.includes("idx_campaigns_org_lower_name_unique")
    ) {
      return duplicateNameError(name);
    }
    return {
      ok: false,
      error: { code: "CAMPAIGN_CREATE_FAILED", message },
    };
  }

  const deliveryPersistResult = await persistCampaignDeliverySettings(supabase, {
    campaignId: campaign.id,
    orgId,
    delivery,
  });
  if (!deliveryPersistResult.ok) {
    await settleAdHocCampaignAfterQueueFailure(supabase, campaign.id);
    return deliveryPersistResult;
  }

  const recipientsResult = await persistRecipients(
    supabase,
    campaign.id,
    selectedRows,
  );
  if (!recipientsResult.ok) {
    await settleAdHocCampaignAfterQueueFailure(supabase, campaign.id);
    return recipientsResult;
  }

  return ok({
    campaignId: campaign.id,
    propertyIds: selectedRows.map((row) => row.id),
  });
}

export async function completeLaunchingCampaign(
  supabase: Supabase,
  campaignId: string,
): Promise<Result<null>> {
  const { data, error } = await supabase
    .from("campaigns")
    .update({
      status: "completed",
      updated_at: new Date().toISOString(),
    })
    .eq("id", campaignId)
    .eq("status", "launching")
    .select("id")
    .maybeSingle();
  if (error) {
    return {
      ok: false,
      error: {
        code: "CAMPAIGN_STATUS_UPDATE_FAILED",
        message: error.message,
      },
    };
  }
  if (!data) {
    return {
      ok: false,
      error: {
        code: "CAMPAIGN_STATUS_UPDATE_FAILED",
        message: "Campaign is no longer launching.",
      },
    };
  }
  return ok(null);
}

export async function settleAdHocCampaignAfterQueueFailure(
  supabase: Supabase,
  campaignId: string,
): Promise<void> {
  const { count } = await supabase
    .from("messages")
    .select("*", { count: "exact", head: true })
    .eq("campaign_id", campaignId);
  const now = new Date().toISOString();
  if ((count ?? 0) === 0) {
    await supabase
      .from("campaigns")
      .update({
        status: "archived",
        archived_at: now,
        updated_at: now,
      })
      .eq("id", campaignId)
      .eq("status", "launching");
    return;
  }
  await supabase
    .from("campaigns")
    .update({
      status: "completed",
      updated_at: now,
    })
    .eq("id", campaignId)
    .eq("status", "launching");
}
