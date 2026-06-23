"use server";

import { bulkQueueSms, getAllMatchingProspectIds } from "@/app/(dashboard)/properties/actions";
import { getCallerMemberships } from "@/lib/auth/memberships";
import { computeConsentState } from "@/lib/messaging/consent";
import { errFromUnknown, ok, type Result } from "@/lib/errors/result";
import { reportError } from "@/lib/errors/report";
import {
  CONTACTED_MESSAGE_STATUSES,
  type BulkSmsQueueBaseOpts,
} from "@/lib/messaging/bulk-queue";
import {
  EMPTY_AUDIENCE_VALIDATION_MESSAGE,
  hasEffectiveAudience,
} from "@/lib/prospects/effective-audience";
import { decodeFilters, type FilterBlock } from "@/lib/prospects/filter-schema";
import { createClient } from "@/lib/supabase/server";
import type { Database, Json } from "@/lib/supabase/types";

const PROPERTY_CHUNK = 250;
const RECIPIENT_PAGE = 1000;
const UPSERT_CHUNK = 500;

type CampaignRow = Pick<
  Database["public"]["Tables"]["campaigns"]["Row"],
  | "id"
  | "audience_snapshot"
  | "body"
  | "pace_seconds"
  | "skip_if_contacted"
  | "status"
  | "template_category"
>;

type CampaignRecipientSeedRow = {
  propertyId: string;
  contactId: string | null;
};

type LaunchCampaignOpts = BulkSmsQueueBaseOpts;

export type CreateCampaignInput = {
  name: string;
  body?: string | null;
  templateCategory?: string | null;
  paceSeconds?: number | null;
  skipIfContacted?: boolean;
  audience: {
    search?: string | null;
    blockStack: FilterBlock[];
  };
};

export type LaunchCampaignResult = {
  recipientCount: number;
  succeeded: number;
  skipped: number;
  failed: { propertyId: string; message: string }[];
  deferred?: { jobId: string; total: number };
  alreadyLaunched: boolean;
};

export type CampaignLaunchPreview = {
  recipientCount: number;
  estimatedQueueableCount: number;
  skipIfContacted: boolean;
  successfulPriorContactCount: number;
  priorFailedAttemptCount: number;
  missingContactCount: number;
  landlineCount: number;
  unknownLineTypeCount: number;
  optedOutCount: number;
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function normalizeAudienceSnapshot(
  audience: CreateCampaignInput["audience"],
): Result<{
  search: string | null;
  blockStack: FilterBlock[];
  audienceSnapshot: Json;
}> {
  if (!isRecord(audience) || !Array.isArray(audience.blockStack)) {
    return {
      ok: false,
      error: {
        code: "VALIDATION",
        message: "Campaign audience must include a filter block stack.",
      },
    };
  }

  const search =
    typeof audience.search === "string" && audience.search.trim().length > 0
      ? audience.search.trim()
      : null;

  const decoded = decodeFilters(
    encodeURIComponent(
      JSON.stringify({
        v: 1,
        blocks: audience.blockStack,
      }),
    ),
  );

  if (decoded.blocks.length === 0 && !search) {
    return {
      ok: false,
      error: {
        code: "VALIDATION",
        message:
          "Campaign audience is required. Add a search term or at least one filter block.",
      },
    };
  }

  if (audience.blockStack.length > 0 && decoded.blocks.length === 0) {
    return {
      ok: false,
      error: {
        code: "VALIDATION",
        message: "Campaign audience contains invalid filter blocks.",
      },
    };
  }

  if (!hasEffectiveAudience({ search, blockStack: decoded.blocks })) {
    return {
      ok: false,
      error: {
        code: "VALIDATION",
        message: EMPTY_AUDIENCE_VALIDATION_MESSAGE,
      },
    };
  }

  const audienceSnapshot = {
    search,
    blockStack: decoded.blocks,
  } satisfies {
    search: string | null;
    blockStack: FilterBlock[];
  };

  return ok({
    search,
    blockStack: decoded.blocks,
    audienceSnapshot: audienceSnapshot as Json,
  });
}

function normalizePaceSeconds(
  value: CreateCampaignInput["paceSeconds"],
): Result<number | null> {
  if (value == null) return ok(null);

  if (!Number.isInteger(value) || value < 10 || value > 600) {
    return {
      ok: false,
      error: {
        code: "VALIDATION",
        message: "Pacing must be between 10 seconds and 10 minutes.",
      },
    };
  }

  return ok(value);
}

function parseAudienceSnapshot(
  snapshot: Json | null,
): Result<{
  search: string | null;
  blockStack: FilterBlock[];
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
  });
}

function parseLaunchOpts(campaign: CampaignRow): Result<LaunchCampaignOpts> {
  const body =
    typeof campaign.body === "string" && campaign.body.trim().length > 0
      ? campaign.body.trim()
      : undefined;
  const templateCategory =
    typeof campaign.template_category === "string" &&
    campaign.template_category.trim().length > 0
      ? campaign.template_category.trim()
      : undefined;

  if (!body && !templateCategory) {
    return {
      ok: false,
      error: {
        code: "CAMPAIGN_LAUNCH_CONFIG_MISSING",
        message:
          "Campaign launch needs campaigns.body or campaigns.template_category.",
      },
    };
  }

  const opts: LaunchCampaignOpts = {};
  if (body) opts.body = body;
  if (templateCategory) opts.templateCategory = templateCategory;
  if (
    typeof campaign.pace_seconds === "number" &&
    Number.isFinite(campaign.pace_seconds)
  ) {
    opts.paceSeconds = campaign.pace_seconds;
  }
  opts.skipIfContacted = campaign.skip_if_contacted;

  return ok(opts);
}

function invalidAudienceResult(): Result<never> {
  return {
    ok: false,
    error: {
      code: "VALIDATION",
      message: EMPTY_AUDIENCE_VALIDATION_MESSAGE,
    },
  };
}

function stateConflictResult(
  message: string,
): Result<never> {
  return {
    ok: false,
    error: {
      code: "CAMPAIGN_STATE_CONFLICT",
      message,
    },
  };
}

async function campaignExists(
  campaignId: string,
  supabase: Awaited<ReturnType<typeof createClient>>,
): Promise<Result<boolean>> {
  const { data, error } = await supabase
    .from("campaigns")
    .select("id")
    .eq("id", campaignId)
    .maybeSingle();

  if (error) {
    return {
      ok: false,
      error: { code: "CAMPAIGN_LOOKUP_FAILED", message: error.message },
    };
  }

  return ok(Boolean(data?.id));
}

export async function createCampaign(
  input: CreateCampaignInput,
): Promise<Result<{ id: string }>> {
  const name = input.name.trim();
  if (!name) {
    return {
      ok: false,
      error: { code: "VALIDATION", message: "Campaign name is required." },
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

  const body =
    typeof input.body === "string" && input.body.trim().length > 0
      ? input.body.trim()
      : null;
  const templateCategory =
    typeof input.templateCategory === "string" &&
    input.templateCategory.trim().length > 0
      ? input.templateCategory.trim()
      : null;
  if (!body && !templateCategory) {
    return {
      ok: false,
      error: {
        code: "VALIDATION",
        message: "Write a message or choose a template pool before saving.",
      },
    };
  }

  const paceResult = normalizePaceSeconds(input.paceSeconds ?? null);
  if (!paceResult.ok) return paceResult;

  const audienceResult = normalizeAudienceSnapshot(input.audience);
  if (!audienceResult.ok) return audienceResult;

  try {
    const supabase = await createClient();
    const {
      data: { user },
    } = await supabase.auth.getUser();
    const memberships = await getCallerMemberships();
    const orgId = memberships[0]?.org_id ?? null;
    if (!orgId) {
      return {
        ok: false,
        error: {
          code: "CAMPAIGN_CREATE_FAILED",
          message: "No organization membership found for this user.",
        },
      };
    }

    const { data: activeCandidates, error: activeLookupError } = await supabase
      .from("campaigns")
      .select("id")
      .eq("org_id", orgId)
      .ilike("name", name)
      .is("archived_at", null)
      .limit(1);
    if (activeLookupError) {
      return {
        ok: false,
        error: {
          code: "CAMPAIGN_LOOKUP_FAILED",
          message: activeLookupError.message,
        },
      };
    }

    if ((activeCandidates ?? []).length > 0) {
      return {
        ok: false,
        error: {
          code: "DUPLICATE_NAME",
          message: `A campaign named "${name}" already exists.`,
        },
      };
    }

    const { data: archivedCandidates, error: archivedLookupError } =
      await supabase
        .from("campaigns")
        .select("id, archived_at")
        .eq("org_id", orgId)
        .ilike("name", name)
        .not("archived_at", "is", null)
        .order("archived_at", { ascending: false })
        .limit(1);
    if (archivedLookupError) {
      return {
        ok: false,
        error: {
          code: "CAMPAIGN_LOOKUP_FAILED",
          message: archivedLookupError.message,
        },
      };
    }

    const archivedCandidate = archivedCandidates?.[0] ?? null;
    if (archivedCandidate) {
      const now = new Date().toISOString();
      const { data: revivedRow, error } = await supabase
        .from("campaigns")
        .update({
          archived_at: null,
          status: "active",
          channel: "sms",
          audience_snapshot: audienceResult.data.audienceSnapshot,
          body,
          template_category: templateCategory,
          pace_seconds: paceResult.data,
          skip_if_contacted: input.skipIfContacted ?? false,
          updated_at: now,
        })
        .eq("id", archivedCandidate.id)
        .not("archived_at", "is", null)
        .select("id")
        .maybeSingle();
      if (error) {
        return {
          ok: false,
          error: { code: "CAMPAIGN_UPDATE_FAILED", message: error.message },
        };
      }
      if (!revivedRow?.id) {
        return stateConflictResult(
          "Campaign state changed before the archived draft could be restored.",
        );
      }

      return ok({ id: revivedRow.id });
    }

    const { data: inserted, error } = await supabase
      .from("campaigns")
      .insert({
        org_id: orgId,
        name,
        channel: "sms",
        audience_snapshot: audienceResult.data.audienceSnapshot,
        body,
        template_category: templateCategory,
        pace_seconds: paceResult.data,
        skip_if_contacted: input.skipIfContacted ?? false,
        created_by: user?.id ?? null,
      })
      .select("id")
      .single();
    if (error) {
      return {
        ok: false,
        error: { code: "CAMPAIGN_CREATE_FAILED", message: error.message },
      };
    }

    return ok({ id: inserted.id });
  } catch (e) {
    reportError(e, { tags: { surface: "create_campaign" } });
    return errFromUnknown(e, "CAMPAIGN_CREATE_FAILED");
  }
}

async function loadCampaign(
  campaignId: string,
): Promise<Result<CampaignRow>> {
  const supabase = await createClient();
  const { data, error } = await supabase
    .from("campaigns")
    .select(
      "id, audience_snapshot, body, pace_seconds, skip_if_contacted, status, template_category",
    )
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
      .order("property_id", { ascending: true })
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

async function listFrozenRecipientSeedRows(
  campaignId: string,
): Promise<Result<CampaignRecipientSeedRow[]>> {
  const supabase = await createClient();
  const rows: CampaignRecipientSeedRow[] = [];

  for (let from = 0; ; from += RECIPIENT_PAGE) {
    const { data, error } = await supabase
      .from("campaign_recipients")
      .select("property_id, contact_id")
      .eq("campaign_id", campaignId)
      .order("property_id", { ascending: true })
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
      .map((row) => ({
        propertyId: row.property_id,
        contactId: row.contact_id ?? null,
      }))
      .filter((row): row is CampaignRecipientSeedRow =>
        typeof row.propertyId === "string",
      );

    rows.push(...page);
    if (page.length < RECIPIENT_PAGE) break;
  }

  return ok(rows);
}

async function resolvePreviewRecipientRows(
  campaignId: string,
  campaign: CampaignRow,
): Promise<Result<CampaignRecipientSeedRow[]>> {
  const frozenResult = await listFrozenRecipientSeedRows(campaignId);
  if (!frozenResult.ok) return frozenResult;
  if (frozenResult.data.length > 0) return frozenResult;

  const snapshotResult = parseAudienceSnapshot(campaign.audience_snapshot);
  if (!snapshotResult.ok) return snapshotResult;
  if (!hasEffectiveAudience(snapshotResult.data)) return invalidAudienceResult();

  const idsResult = await getAllMatchingProspectIds({
    search: snapshotResult.data.search,
    blockStack: snapshotResult.data.blockStack,
  });
  if (!idsResult.ok) return idsResult;

  return fetchRecipientSeedRows(Array.from(new Set(idsResult.data)));
}

async function fetchContactsForPreview(
  contactIds: string[],
): Promise<Result<Map<string, { phone_1: string | null; phone_1_type: string | null }>>> {
  const supabase = await createClient();
  const contacts = new Map<string, { phone_1: string | null; phone_1_type: string | null }>();

  for (let i = 0; i < contactIds.length; i += PROPERTY_CHUNK) {
    const chunk = contactIds.slice(i, i + PROPERTY_CHUNK);
    const { data, error } = await supabase
      .from("contacts")
      .select("id, phone_1, phone_1_type")
      .in("id", chunk);

    if (error) {
      return {
        ok: false,
        error: { code: "CAMPAIGN_CONTACT_LOOKUP_FAILED", message: error.message },
      };
    }
    for (const row of data ?? []) {
      contacts.set(row.id, {
        phone_1: row.phone_1 ?? null,
        phone_1_type: row.phone_1_type ?? null,
      });
    }
  }

  return ok(contacts);
}

async function fetchPriorOutboundPropertySet(
  propertyIds: string[],
  statuses: readonly string[],
): Promise<Result<Set<string>>> {
  const supabase = await createClient();
  const result = new Set<string>();

  for (let i = 0; i < propertyIds.length; i += PROPERTY_CHUNK) {
    const chunk = propertyIds.slice(i, i + PROPERTY_CHUNK);
    const { data, error } = await supabase
      .from("messages")
      .select("property_id")
      .in("property_id", chunk)
      .eq("direction", "outbound")
      .in("status", statuses);

    if (error) {
      return {
        ok: false,
        error: { code: "CAMPAIGN_PRIOR_MESSAGE_LOOKUP_FAILED", message: error.message },
      };
    }
    for (const row of data ?? []) {
      if (row.property_id) result.add(row.property_id);
    }
  }

  return ok(result);
}

async function fetchOptedOutContactSet(
  contactIds: string[],
): Promise<Result<Set<string>>> {
  const supabase = await createClient();
  const eventsByContact = new Map<string, { event_type: string; occurred_at: string }[]>();

  for (let i = 0; i < contactIds.length; i += PROPERTY_CHUNK) {
    const chunk = contactIds.slice(i, i + PROPERTY_CHUNK);
    const { data, error } = await supabase
      .from("consent_events")
      .select("contact_id, event_type, occurred_at")
      .in("contact_id", chunk)
      .eq("channel", "sms");

    if (error) {
      return {
        ok: false,
        error: { code: "CAMPAIGN_CONSENT_LOOKUP_FAILED", message: error.message },
      };
    }
    for (const row of data ?? []) {
      if (!row.contact_id) continue;
      const events = eventsByContact.get(row.contact_id) ?? [];
      events.push({
        event_type: row.event_type,
        occurred_at: row.occurred_at,
      });
      eventsByContact.set(row.contact_id, events);
    }
  }

  const optedOut = new Set<string>();
  for (const [contactId, events] of eventsByContact) {
    if (computeConsentState(events) === "opted_out") {
      optedOut.add(contactId);
    }
  }

  return ok(optedOut);
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

export async function archiveCampaign(id: string): Promise<Result<null>> {
  try {
    const supabase = await createClient();
    const now = new Date().toISOString();
    const { data, error } = await supabase
      .from("campaigns")
      .update({
        archived_at: now,
        status: "archived",
        updated_at: now,
      })
      .eq("id", id)
      .is("archived_at", null)
      .in("status", ["active", "paused", "completed"])
      .select("id")
      .maybeSingle();
    if (error) {
      return {
        ok: false,
        error: { code: "CAMPAIGN_ARCHIVE_FAILED", message: error.message },
      };
    }
    if (!data?.id) {
      const existsResult = await campaignExists(id, supabase);
      if (!existsResult.ok) return existsResult;
      if (!existsResult.data) {
        return {
          ok: false,
          error: {
            code: "CAMPAIGN_NOT_FOUND",
            message: "Campaign does not exist.",
          },
        };
      }
      return stateConflictResult(
        "Wait for the launch to finish before archiving this campaign.",
      );
    }
    return ok(null);
  } catch (e) {
    reportError(e, { tags: { surface: "archive_campaign" }, extra: { id } });
    return errFromUnknown(e, "CAMPAIGN_ARCHIVE_FAILED");
  }
}

export async function unarchiveCampaign(id: string): Promise<Result<null>> {
  try {
    const supabase = await createClient();
    const messageCountResult = await countCampaignMessages(id);
    if (!messageCountResult.ok) return messageCountResult;

    const nextStatus: CampaignRow["status"] =
      messageCountResult.data > 0 ? "completed" : "active";
    const now = new Date().toISOString();
    const { data, error } = await supabase
      .from("campaigns")
      .update({
        archived_at: null,
        status: nextStatus,
        updated_at: now,
      })
      .eq("id", id)
      .eq("status", "archived")
      .not("archived_at", "is", null)
      .select("id")
      .maybeSingle();
    if (error) {
      return {
        ok: false,
        error: {
          code: "CAMPAIGN_UNARCHIVE_FAILED",
          message: error.message,
        },
      };
    }
    if (!data?.id) {
      const existsResult = await campaignExists(id, supabase);
      if (!existsResult.ok) return existsResult;
      if (!existsResult.data) {
        return {
          ok: false,
          error: {
            code: "CAMPAIGN_NOT_FOUND",
            message: "Campaign does not exist.",
          },
        };
      }
      return stateConflictResult(
        "Campaign state changed before it could be restored.",
      );
    }
    return ok(null);
  } catch (e) {
    reportError(e, { tags: { surface: "unarchive_campaign" }, extra: { id } });
    return errFromUnknown(e, "CAMPAIGN_UNARCHIVE_FAILED");
  }
}

async function markCampaignCompleted(campaignId: string): Promise<Result<null>> {
  const supabase = await createClient();
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
      error: { code: "CAMPAIGN_STATUS_UPDATE_FAILED", message: error.message },
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

async function claimCampaignLaunch(
  campaignId: string,
  allowedStatuses: CampaignRow["status"][],
): Promise<Result<boolean>> {
  const supabase = await createClient();
  const { data, error } = await supabase
    .from("campaigns")
    .update({
      status: "launching",
      updated_at: new Date().toISOString(),
    })
    .eq("id", campaignId)
    .in("status", allowedStatuses)
    .select("id")
    .maybeSingle();

  if (error) {
    return {
      ok: false,
      error: { code: "CAMPAIGN_STATUS_UPDATE_FAILED", message: error.message },
    };
  }

  return ok(Boolean(data?.id));
}

async function buildAlreadyLaunchedResult(
  campaignId: string,
  messageCount: number,
): Promise<Result<LaunchCampaignResult>> {
  const frozenResult = await listFrozenRecipientPropertyIds(campaignId);
  if (!frozenResult.ok) return frozenResult;

  if (messageCount > 0 && frozenResult.data.length === 0) {
    return {
      ok: false,
      error: {
        code: "CAMPAIGN_RECIPIENTS_MISSING",
        message:
          "Campaign already has stamped messages but no frozen recipient set.",
      },
    };
  }

  return ok({
    recipientCount: frozenResult.data.length,
    succeeded: 0,
    skipped: 0,
    failed: [],
    alreadyLaunched: true,
  });
}

export async function previewCampaignLaunch(
  campaignId: string,
): Promise<Result<CampaignLaunchPreview>> {
  try {
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

    const rowsResult = await resolvePreviewRecipientRows(campaignId, campaign);
    if (!rowsResult.ok) return rowsResult;
    const rows = rowsResult.data;
    const propertyIds = rows.map((row) => row.propertyId);
    const contactIds = Array.from(
      new Set(
        rows
          .map((row) => row.contactId)
          .filter((value): value is string => typeof value === "string"),
      ),
    );

    const [
      contactsResult,
      priorSuccessfulResult,
      priorFailedResult,
      optedOutResult,
    ] = await Promise.all([
      fetchContactsForPreview(contactIds),
      fetchPriorOutboundPropertySet(propertyIds, CONTACTED_MESSAGE_STATUSES),
      fetchPriorOutboundPropertySet(propertyIds, ["failed"]),
      fetchOptedOutContactSet(contactIds),
    ]);
    if (!contactsResult.ok) return contactsResult;
    if (!priorSuccessfulResult.ok) return priorSuccessfulResult;
    if (!priorFailedResult.ok) return priorFailedResult;
    if (!optedOutResult.ok) return optedOutResult;

    const contacts = contactsResult.data;
    const successfulPriorContacts = priorSuccessfulResult.data;
    const priorFailedAttempts = priorFailedResult.data;
    const priorFailedWithoutSuccessCount = Array.from(priorFailedAttempts).filter(
      (propertyId) => !successfulPriorContacts.has(propertyId),
    ).length;
    const optedOutContacts = optedOutResult.data;

    let estimatedQueueableCount = 0;
    let successfulPriorContactCount = 0;
    let missingContactCount = 0;
    let landlineCount = 0;
    let unknownLineTypeCount = 0;
    let optedOutCount = 0;

    for (const row of rows) {
      if (campaign.skip_if_contacted && successfulPriorContacts.has(row.propertyId)) {
        successfulPriorContactCount += 1;
        continue;
      }

      const contact = row.contactId ? contacts.get(row.contactId) : null;
      if (!row.contactId || !contact || !contact.phone_1) {
        missingContactCount += 1;
        continue;
      }

      const lineType = contact.phone_1_type ?? "unknown";
      if (lineType === "landline") {
        landlineCount += 1;
        continue;
      }
      if (lineType === "unknown") {
        unknownLineTypeCount += 1;
        continue;
      }

      if (optedOutContacts.has(row.contactId)) {
        optedOutCount += 1;
        continue;
      }

      estimatedQueueableCount += 1;
    }

    return ok({
      recipientCount: rows.length,
      estimatedQueueableCount,
      skipIfContacted: campaign.skip_if_contacted,
      successfulPriorContactCount,
      priorFailedAttemptCount: priorFailedWithoutSuccessCount,
      missingContactCount,
      landlineCount,
      unknownLineTypeCount,
      optedOutCount,
    });
  } catch (e) {
    reportError(e, {
      tags: { surface: "preview_campaign_launch" },
      extra: { campaignId },
    });
    return errFromUnknown(e, "CAMPAIGN_LAUNCH_PREVIEW_FAILED");
  }
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
    const messageCountResult = await countCampaignMessages(campaignId);
    if (!messageCountResult.ok) return messageCountResult;
    const messageCount = messageCountResult.data;

    if (campaign.status === "archived") {
      return {
        ok: false,
        error: {
          code: "CAMPAIGN_ARCHIVED",
          message: "Archived campaigns cannot be launched.",
        },
      };
    }

    const recoverableLaunching =
      campaign.status === "launching" && messageCount === 0;
    const launchClaimStatuses: CampaignRow["status"][] = [];
    if (campaign.status === "active") launchClaimStatuses.push("active");
    if (recoverableLaunching) launchClaimStatuses.push("launching");

    if (campaign.status === "completed" || messageCount > 0) {
      return buildAlreadyLaunchedResult(campaignId, messageCount);
    }
    if (launchClaimStatuses.length === 0) {
      return buildAlreadyLaunchedResult(campaignId, messageCount);
    }

    const snapshotResult = parseAudienceSnapshot(campaign.audience_snapshot);
    if (!snapshotResult.ok) return snapshotResult;
    if (!hasEffectiveAudience(snapshotResult.data)) {
      return invalidAudienceResult();
    }

    const claimResult = await claimCampaignLaunch(campaignId, launchClaimStatuses);
    if (!claimResult.ok) return claimResult;
    if (!claimResult.data) {
      return buildAlreadyLaunchedResult(campaignId, messageCount);
    }

    const frozenResult = await listFrozenRecipientPropertyIds(campaignId);
    if (!frozenResult.ok) return frozenResult;

    let propertyIds = frozenResult.data;
    if (propertyIds.length === 0) {
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

    const launchOptsResult = parseLaunchOpts(campaign);
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

    if (!queueResult.data.deferred) {
      const markCompletedResult = await markCampaignCompleted(campaignId);
      if (!markCompletedResult.ok) return markCompletedResult;
    }

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
