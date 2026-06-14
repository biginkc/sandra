"use server";

import { bulkQueueSms, getAllMatchingProspectIds } from "@/app/(dashboard)/properties/actions";
import { errFromUnknown, ok, type Result } from "@/lib/errors/result";
import { reportError } from "@/lib/errors/report";
import type { BulkSmsQueueOpts } from "@/lib/messaging/bulk-queue";
import { decodeFilters, type FilterBlock } from "@/lib/prospects/filter-schema";
import { createClient } from "@/lib/supabase/server";
import type { Database, Json } from "@/lib/supabase/types";

const PROPERTY_CHUNK = 250;
const RECIPIENT_PAGE = 1000;
const UPSERT_CHUNK = 500;

type CampaignRow = Pick<
  Database["public"]["Tables"]["campaigns"]["Row"],
  "id" | "audience_snapshot" | "status"
>;

type CampaignRecipientSeedRow = {
  propertyId: string;
  contactId: string | null;
};

type LaunchCampaignOpts = Omit<BulkSmsQueueOpts, "campaignId">;

export type LaunchCampaignResult = {
  recipientCount: number;
  succeeded: number;
  skipped: number;
  failed: { propertyId: string; message: string }[];
  deferred?: { jobId: string; total: number };
  alreadyLaunched: boolean;
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function parseAudienceSnapshot(
  snapshot: Json | null,
): Result<{
  search: string | null;
  blockStack: FilterBlock[];
  rawLaunch: unknown;
}> {
  if (!isRecord(snapshot)) {
    return {
      ok: false,
      error: {
        code: "INVALID_AUDIENCE_SNAPSHOT",
        message: "Campaign audience_snapshot must be an object.",
      },
    };
  }

  const filterSource = isRecord(snapshot.filters) ? snapshot.filters : snapshot;
  const rawBlockStack = filterSource.blockStack;
  if (!Array.isArray(rawBlockStack)) {
    return {
      ok: false,
      error: {
        code: "INVALID_AUDIENCE_SNAPSHOT",
        message: "Campaign audience_snapshot is missing blockStack.",
      },
    };
  }

  const decoded = decodeFilters(
    encodeURIComponent(
      JSON.stringify({
        v: 1,
        blocks: rawBlockStack,
      }),
    ),
  );

  const rawSearch = filterSource.search;
  const search =
    typeof rawSearch === "string" && rawSearch.trim().length > 0
      ? rawSearch.trim()
      : null;

  return ok({
    search,
    blockStack: decoded.blocks,
    rawLaunch: snapshot.launch,
  });
}

function parseLaunchOpts(raw: unknown): Result<LaunchCampaignOpts> {
  if (!isRecord(raw)) {
    return {
      ok: false,
      error: {
        code: "CAMPAIGN_LAUNCH_CONFIG_MISSING",
        message:
          "Campaign launch needs audience_snapshot.launch with a body or templateCategory.",
      },
    };
  }

  const body =
    typeof raw.body === "string" && raw.body.trim().length > 0
      ? raw.body.trim()
      : undefined;
  const templateCategory =
    typeof raw.templateCategory === "string" &&
    raw.templateCategory.trim().length > 0
      ? raw.templateCategory.trim()
      : undefined;

  if (!body && !templateCategory) {
    return {
      ok: false,
      error: {
        code: "CAMPAIGN_LAUNCH_CONFIG_MISSING",
        message:
          "Campaign launch needs audience_snapshot.launch.body or .templateCategory.",
      },
    };
  }

  const opts: LaunchCampaignOpts = {};
  if (body) opts.body = body;
  if (templateCategory) opts.templateCategory = templateCategory;
  if (typeof raw.paceSeconds === "number" && Number.isFinite(raw.paceSeconds)) {
    opts.paceSeconds = raw.paceSeconds;
  }
  if (typeof raw.skipIfContacted === "boolean") {
    opts.skipIfContacted = raw.skipIfContacted;
  }
  if (typeof raw.jitterPct === "number" && Number.isFinite(raw.jitterPct)) {
    opts.jitterPct = raw.jitterPct;
  }
  if (typeof raw.includeUnknown === "boolean") {
    opts.includeUnknown = raw.includeUnknown;
  }

  return ok(opts);
}

async function loadCampaign(
  campaignId: string,
): Promise<Result<CampaignRow>> {
  const supabase = await createClient();
  const { data, error } = await supabase
    .from("campaigns")
    .select("id, audience_snapshot, status")
    .eq("id", campaignId)
    .maybeSingle();

  if (error) {
    return {
      ok: false,
      error: { code: "CAMPAIGN_LOOKUP_FAILED", message: error.message },
    };
  }
  if (!data) {
    return {
      ok: false,
      error: { code: "CAMPAIGN_NOT_FOUND", message: "Campaign not found." },
    };
  }

  return ok(data);
}

async function listFrozenRecipientPropertyIds(
  campaignId: string,
): Promise<Result<string[]>> {
  const supabase = await createClient();
  const propertyIds: string[] = [];

  for (let from = 0; ; from += RECIPIENT_PAGE) {
    const { data, error } = await supabase
      .from("campaign_recipients")
      .select("property_id")
      .eq("campaign_id", campaignId)
      .range(from, from + RECIPIENT_PAGE - 1);

    if (error) {
      return {
        ok: false,
        error: {
          code: "CAMPAIGN_RECIPIENTS_LOOKUP_FAILED",
          message: error.message,
        },
      };
    }

    const page = (data ?? [])
      .map((row) => row.property_id)
      .filter((value): value is string => typeof value === "string");

    propertyIds.push(...page);
    if (page.length < RECIPIENT_PAGE) break;
  }

  return ok(propertyIds);
}

async function fetchRecipientSeedRows(
  propertyIds: string[],
): Promise<Result<CampaignRecipientSeedRow[]>> {
  const supabase = await createClient();
  const rows: CampaignRecipientSeedRow[] = [];

  for (let i = 0; i < propertyIds.length; i += PROPERTY_CHUNK) {
    const chunk = propertyIds.slice(i, i + PROPERTY_CHUNK);
    const { data, error } = await supabase
      .from("properties")
      .select("id, homeowner_contact_id")
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

    rows.push(
      ...((data ?? []).map((row) => ({
        propertyId: row.id,
        contactId: row.homeowner_contact_id ?? null,
      })) satisfies CampaignRecipientSeedRow[]),
    );
  }

  return ok(rows);
}

async function persistFrozenRecipients(
  campaignId: string,
  rows: CampaignRecipientSeedRow[],
): Promise<Result<null>> {
  const supabase = await createClient();

  for (let i = 0; i < rows.length; i += UPSERT_CHUNK) {
    const chunk = rows.slice(i, i + UPSERT_CHUNK);
    const { error } = await supabase.from("campaign_recipients").upsert(
      chunk.map((row) => ({
        campaign_id: campaignId,
        property_id: row.propertyId,
        contact_id: row.contactId,
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

async function countCampaignMessages(campaignId: string): Promise<Result<number>> {
  const supabase = await createClient();
  const { count, error } = await supabase
    .from("messages")
    .select("*", { count: "exact", head: true })
    .eq("campaign_id", campaignId);

  if (error) {
    return {
      ok: false,
      error: { code: "CAMPAIGN_MESSAGES_COUNT_FAILED", message: error.message },
    };
  }

  return ok(count ?? 0);
}

async function markCampaignCompleted(campaignId: string): Promise<Result<null>> {
  const supabase = await createClient();
  const { error } = await supabase
    .from("campaigns")
    .update({
      status: "completed",
      updated_at: new Date().toISOString(),
    })
    .eq("id", campaignId);

  if (error) {
    return {
      ok: false,
      error: { code: "CAMPAIGN_STATUS_UPDATE_FAILED", message: error.message },
    };
  }

  return ok(null);
}

export async function launchCampaign(
  campaignId: string,
): Promise<Result<LaunchCampaignResult>> {
  try {
    const supabase = await createClient();
    const {
      data: { user },
    } = await supabase.auth.getUser();
    if (!user) {
      return {
        ok: false,
        error: { code: "UNAUTH", message: "Sign in required." },
      };
    }

    const campaignResult = await loadCampaign(campaignId);
    if (!campaignResult.ok) return campaignResult;
    const campaign = campaignResult.data;

    if (campaign.status === "archived") {
      return {
        ok: false,
        error: {
          code: "CAMPAIGN_ARCHIVED",
          message: "Archived campaigns cannot be launched.",
        },
      };
    }

    const frozenResult = await listFrozenRecipientPropertyIds(campaignId);
    if (!frozenResult.ok) return frozenResult;

    let propertyIds = frozenResult.data;
    const messageCountResult = await countCampaignMessages(campaignId);
    if (!messageCountResult.ok) return messageCountResult;

    if (campaign.status === "completed" || messageCountResult.data > 0) {
      if (propertyIds.length === 0) {
        return {
          ok: false,
          error: {
            code: "CAMPAIGN_RECIPIENTS_MISSING",
            message:
              "Campaign already has stamped messages but no frozen recipient set.",
          },
        };
      }

      if (campaign.status !== "completed") {
        const markCompletedResult = await markCampaignCompleted(campaignId);
        if (!markCompletedResult.ok) return markCompletedResult;
      }

      return ok({
        recipientCount: propertyIds.length,
        succeeded: 0,
        skipped: 0,
        failed: [],
        alreadyLaunched: true,
      });
    }

    if (propertyIds.length === 0) {
      const snapshotResult = parseAudienceSnapshot(campaign.audience_snapshot);
      if (!snapshotResult.ok) return snapshotResult;

      const idsResult = await getAllMatchingProspectIds({
        search: snapshotResult.data.search,
        blockStack: snapshotResult.data.blockStack,
      });
      if (!idsResult.ok) return idsResult;

      propertyIds = Array.from(new Set(idsResult.data));
      if (propertyIds.length === 0) {
        return {
          ok: false,
          error: {
            code: "NO_RECIPIENTS",
            message: "Campaign audience resolved to zero prospects.",
          },
        };
      }

      const recipientsResult = await fetchRecipientSeedRows(propertyIds);
      if (!recipientsResult.ok) return recipientsResult;
      if (recipientsResult.data.length === 0) {
        return {
          ok: false,
          error: {
            code: "NO_RECIPIENTS",
            message: "Campaign audience resolved to zero readable prospects.",
          },
        };
      }

      const insertResult = await persistFrozenRecipients(
        campaignId,
        recipientsResult.data,
      );
      if (!insertResult.ok) return insertResult;

      propertyIds = recipientsResult.data.map((row) => row.propertyId);
    }

    const snapshotResult = parseAudienceSnapshot(campaign.audience_snapshot);
    if (!snapshotResult.ok) return snapshotResult;

    const launchOptsResult = parseLaunchOpts(snapshotResult.data.rawLaunch);
    if (!launchOptsResult.ok) return launchOptsResult;

    const queueResult = await bulkQueueSms(propertyIds, {
      ...launchOptsResult.data,
      campaignId,
    });
    if (!queueResult.ok) {
      return {
        ok: false,
        error: {
          code: "CAMPAIGN_LAUNCH_FAILED",
          message: queueResult.error.message,
          details: queueResult.error.details,
        },
      };
    }

    const markCompletedResult = await markCampaignCompleted(campaignId);
    if (!markCompletedResult.ok) return markCompletedResult;

    return ok({
      recipientCount: propertyIds.length,
      ...queueResult.data,
      alreadyLaunched: false,
    });
  } catch (e) {
    reportError(e, { tags: { surface: "launch_campaign" }, extra: { campaignId } });
    return errFromUnknown(e, "CAMPAIGN_LAUNCH_FAILED");
  }
}
