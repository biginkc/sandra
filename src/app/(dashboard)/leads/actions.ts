"use server";

import { randomUUID } from "node:crypto";
import { revalidatePath } from "next/cache";
import { after } from "next/server";
import { start } from "workflow/api";

import { isAdminEmail } from "@/lib/auth/allowlist";
import { cassBulkWorkflow } from "@/workflows/cass-bulk";
import {
  parseThreadId,
  resolveSmsConversationOrg,
} from "@/lib/messages/threading";
import { createAdminClient } from "@/lib/supabase/admin";
import { createClient } from "@/lib/supabase/server";
import { errFromUnknown, ok, type Result } from "@/lib/errors/result";
import {
  assertPropertyDncUnlocked,
  DNC_LOCKED_MESSAGE,
  partitionPropertyDncLocks,
} from "@/lib/dnc/property-lock";
import { reportError } from "@/lib/errors/report";
import {
  LEAD_EVENT_TYPES,
  recordLeadEvent,
  recordLeadEvents,
} from "@/lib/events";
import {
  createStandaloneCassJob,
  failAuthorizedCassJobStart,
} from "@/lib/enrichment/cass-job";
import { verifyPropertyAddress } from "@/lib/enrichment/verify-property";
import type { CassStatus } from "@/lib/enrichment/types";
import { qualifyProperty } from "@/lib/leads/qualify";
import {
  recordConsentEvent,
  type ConsentChannel,
  type ConsentEventType,
} from "@/lib/messaging/consent";
import { getMessagingProvider } from "@/lib/messaging/registry";
import {
  releaseQueuedMessage,
  sendSmsToContact,
  type SendSmsOutcome,
} from "@/lib/messaging/send";
import type { DialpadFromOption } from "@/lib/messaging/types";
import { dispatchTaskCalendarEvent } from "@/lib/integrations/google/dispatch";
import { loadIntegrationPrefs } from "@/lib/integrations/prefs";
import { dispatchTaskAssignedSlack } from "@/lib/integrations/slack/dispatch";
import {
  dispatchPropertyAssigned,
  dispatchTaskAssigned,
} from "@/lib/notifications/dispatch";
import {
  applyFilters,
  filterSelectFragment,
} from "@/lib/prospects/filter-to-supabase";
import type { FilterBlock } from "@/lib/prospects/filter-schema";
import type { Database } from "@/lib/supabase/types";
import { loadTemplateVars } from "@/lib/sequences/template-vars";
import type { TemplateVars } from "@/lib/templates/render";
import { createTask, type Task, type TaskType } from "@/lib/tasks";
import { validateActiveAssigneeForProperties } from "./assignment-safety";

export type PropertyStatus =
  | "prospect"
  | "new_lead"
  | "contacted"
  | "interested"
  | "offer_sent"
  | "offer_declined"
  | "under_contract"
  | "closed"
  | "dead";

const VALID_STATUSES: readonly PropertyStatus[] = [
  "prospect",
  "new_lead",
  "contacted",
  "interested",
  "offer_sent",
  "offer_declined",
  "under_contract",
  "closed",
  "dead",
];

async function getLeadEventActor(
  supabase: Awaited<ReturnType<typeof createClient>>,
) {
  try {
    const {
      data: { user },
    } = await supabase.auth.getUser();
    return user?.id
      ? ({ actorType: "user", actorId: user.id } as const)
      : ({ actorType: "system" } as const);
  } catch {
    return { actorType: "system" } as const;
  }
}

type ContactRow = Database["public"]["Tables"]["contacts"]["Row"];
type HomeownerDetailsRow =
  Database["public"]["Tables"]["homeowner_details"]["Row"];
type AgentDetailsRow = Database["public"]["Tables"]["agent_details"]["Row"];
type PropertyRow = Database["public"]["Tables"]["properties"]["Row"];

export type DetailedLead = PropertyRow & {
  homeowner:
    (ContactRow & { homeowner_details: HomeownerDetailsRow | null }) | null;
  agent: (ContactRow & { agent_details: AgentDetailsRow | null }) | null;
};

async function getLeadDetail(
  propertyId: string,
): Promise<Result<DetailedLead | null>> {
  try {
    const supabase = await createClient();
    const { data, error } = await supabase
      .from("properties")
      .select(
        `*,
         homeowner:contacts!properties_homeowner_contact_id_fkey(
           *,
           homeowner_details!homeowner_details_contact_org_fkey(*)
         ),
         agent:contacts!properties_agent_contact_id_fkey(
           *,
           agent_details!agent_details_contact_org_fkey(*)
         )`,
      )
      .eq("id", propertyId)
      .maybeSingle();

    if (error) {
      return {
        ok: false,
        error: { code: "LEAD_FETCH_FAILED", message: error.message },
      };
    }
    return ok(data as DetailedLead | null);
  } catch (e) {
    reportError(e, {
      tags: { surface: "get_lead_detail" },
      extra: { propertyId },
    });
    return errFromUnknown(e, "LEAD_FETCH_FAILED");
  }
}

export type VerifyResult = {
  cassStatus: CassStatus;
  standardized: string;
  isVacant: boolean | null;
  cacheHit: boolean;
};

export async function verifyLeadAddress(
  propertyId: string,
): Promise<Result<VerifyResult>> {
  try {
    const supabase = await createClient();
    let userId: string;
    try {
      const {
        data: { user },
        error: authError,
      } = await supabase.auth.getUser();
      if (authError || !user) {
        return {
          ok: false,
          error: {
            code: "AUTH_REQUIRED",
            message: "Sign in to verify this address.",
          },
        };
      }
      userId = user.id;
    } catch {
      return {
        ok: false,
        error: {
          code: "AUTH_REQUIRED",
          message: "Sign in to verify this address.",
        },
      };
    }
    const unlocked = await assertPropertyDncUnlocked(supabase, propertyId);
    if (!unlocked.ok) return unlocked;
    const { data: property } = await supabase
      .from("properties")
      .select("org_id")
      .eq("id", propertyId)
      .maybeSingle();
    if (!property) {
      return {
        ok: false,
        error: { code: "LEAD_NOT_FOUND", message: "Lead not found." },
      };
    }
    const outcome = await verifyPropertyAddress(
      supabase,
      propertyId,
      property.org_id,
    );

    switch (outcome.status) {
      case "verified":
      case "stored_with_status": {
        await recordLeadEvent({
          propertyId,
          actorType: "user",
          actorId: userId,
          eventType: LEAD_EVENT_TYPES.ADDRESS_VERIFIED,
          payload: {
            cass_status: outcome.verified.cassStatus,
            cache_hit: outcome.cacheHit,
          },
        });
        return ok({
          cassStatus: outcome.verified.cassStatus,
          standardized: outcome.verified.standardized,
          isVacant: outcome.verified.isVacant ?? null,
          cacheHit: outcome.cacheHit,
        });
      }
      case "provider_off":
        return {
          ok: false,
          error: {
            code: "PROVIDER_NOT_CONFIGURED",
            message:
              "Address verification is off. Set ADDRESS_VERIFIER_PROVIDER in .env.local to enable it.",
          },
        };
      case "not_found":
        return {
          ok: false,
          error: { code: "LEAD_NOT_FOUND", message: "Lead not found." },
        };
      case "no_result":
        return {
          ok: false,
          error: {
            code: "VERIFICATION_FAILED",
            message: "Provider returned no result.",
          },
        };
      case "dnc_skipped":
        return {
          ok: false,
          error: { code: "DNC_LOCKED", message: DNC_LOCKED_MESSAGE },
        };
      case "submission_unknown":
      case "provider_rejected":
      case "provider_persist_failed":
      case "failed":
        return {
          ok: false,
          error: {
            code: "VERIFICATION_FAILED",
            message: outcome.error,
          },
        };
    }
  } catch (e) {
    reportError(e, {
      tags: { surface: "verify_lead_address" },
      extra: { propertyId },
    });
    return errFromUnknown(e, "VERIFICATION_FAILED");
  }
}

export type MotivationLevel = "hot" | "warm" | "cold";

const VALID_MOTIVATION_LEVELS: readonly MotivationLevel[] = [
  "hot",
  "warm",
  "cold",
];

/**
 * Set (or clear) the motivation level on a lead. Lives alongside status
 * as a separate axis — "how hot is the seller" vs "where in the pipeline".
 * `null` clears the temperature (e.g. requalification reset).
 */
export async function updateLeadMotivation(
  propertyId: string,
  level: MotivationLevel | null,
): Promise<Result<null>> {
  if (level !== null && !VALID_MOTIVATION_LEVELS.includes(level)) {
    return {
      ok: false,
      error: {
        code: "INVALID_MOTIVATION",
        message: `Unknown motivation level: ${level}`,
      },
    };
  }

  try {
    const supabase = await createClient();
    const unlocked = await assertPropertyDncUnlocked(supabase, propertyId);
    if (!unlocked.ok) return unlocked;
    const { data: current, error: lookupError } = await supabase
      .from("properties")
      .select("id, motivation_level")
      .eq("id", propertyId)
      .maybeSingle();
    if (lookupError) {
      return {
        ok: false,
        error: {
          code: "MOTIVATION_FETCH_FAILED",
          message: lookupError.message,
        },
      };
    }
    if (!current) {
      return {
        ok: false,
        error: { code: "LEAD_NOT_FOUND", message: "Lead not found." },
      };
    }
    if (current.motivation_level === level) return ok(null);

    let update = supabase
      .from("properties")
      .update({
        motivation_level: level,
        updated_at: new Date().toISOString(),
      })
      .eq("id", propertyId);
    update =
      current.motivation_level === null
        ? update.is("motivation_level", null)
        : update.eq("motivation_level", current.motivation_level);
    const { data: saved, error } = await update
      .select("id, motivation_level")
      .maybeSingle();

    if (error) {
      return {
        ok: false,
        error: { code: "MOTIVATION_UPDATE_FAILED", message: error.message },
      };
    }
    if (!saved) {
      const { data: authoritative, error: reconcileError } = await supabase
        .from("properties")
        .select("motivation_level")
        .eq("id", propertyId)
        .maybeSingle();
      if (!reconcileError && authoritative?.motivation_level === level) {
        return ok(null);
      }
      return {
        ok: false,
        error: {
          code: "MOTIVATION_CONFLICT",
          message: "This lead changed before its motivation was saved.",
        },
      };
    }
    await recordLeadEvent({
      propertyId,
      ...(await getLeadEventActor(supabase)),
      eventType: LEAD_EVENT_TYPES.MOTIVATION_CHANGED,
      payload: { from: current.motivation_level, to: level },
    });
    return ok(null);
  } catch (e) {
    reportError(e, {
      tags: { surface: "update_lead_motivation" },
      extra: { propertyId, level },
    });
    return errFromUnknown(e, "MOTIVATION_UPDATE_FAILED");
  }
}

/**
 * Promote a prospect to `new_lead`. Stamps qualified_at + qualified_by so
 * we know when and how the lead entered the working pipeline. Idempotent:
 * calling qualifyLead() on an already-qualified lead is a no-op that
 * returns ok.
 *
 * The `qualifier` is either a user id (manual action from /properties) or
 * a system marker like 'system:inbound_reply' (auto-qualify from the
 * Dialpad webhook).
 */
async function qualifyLead(
  propertyId: string,
  qualifier: string | null = null,
): Promise<Result<{ alreadyQualified: boolean }>> {
  try {
    const supabase = await createClient();
    const unlocked = await assertPropertyDncUnlocked(supabase, propertyId);
    if (!unlocked.ok) return unlocked;

    // Resolve the qualifier — explicit arg wins, else use the session user.
    let qualifiedBy = qualifier;
    if (!qualifiedBy) {
      const {
        data: { user },
      } = await supabase.auth.getUser();
      qualifiedBy = user?.id ?? null;
    }

    const outcome = await qualifyProperty(supabase, propertyId, qualifiedBy);
    switch (outcome.status) {
      case "qualified":
        return ok({ alreadyQualified: false });
      case "already_qualified":
        return ok({ alreadyQualified: true });
      case "not_found":
        return {
          ok: false,
          error: { code: "LEAD_NOT_FOUND", message: "Lead not found." },
        };
      case "failed":
        return {
          ok: false,
          error: { code: "QUALIFY_FAILED", message: outcome.message },
        };
    }
  } catch (e) {
    reportError(e, {
      tags: { surface: "qualify_lead" },
      extra: { propertyId, qualifier },
    });
    return errFromUnknown(e, "QUALIFY_FAILED");
  }
}

export type BulkQualifyFailure = { propertyId: string; message: string };

/**
 * Bulk variant — qualify a batch of prospects in one action. Runs the
 * qualify logic per-property serially (volumes here are tens, not
 * thousands — no parallelism needed). A single bad row does NOT abort the
 * batch: the per-row failure is collected into `failed` and we keep
 * going. The UI shows a toast summarizing qualified / already-qualified /
 * failed so the VA knows exactly what landed.
 */
export async function qualifyLeadsBulk(propertyIds: string[]): Promise<
  Result<{
    qualified: number;
    alreadyQualified: number;
    failed: BulkQualifyFailure[];
  }>
> {
  if (propertyIds.length === 0) {
    return ok({ qualified: 0, alreadyQualified: 0, failed: [] });
  }
  let qualified = 0;
  let alreadyQualified = 0;
  const failed: BulkQualifyFailure[] = [];
  try {
    for (const id of propertyIds) {
      const r = await qualifyLead(id);
      if (!r.ok) {
        failed.push({ propertyId: id, message: r.error.message });
        continue;
      }
      if (r.data.alreadyQualified) alreadyQualified++;
      else qualified++;
    }
    return ok({ qualified, alreadyQualified, failed });
  } catch (e) {
    reportError(e, {
      tags: { surface: "qualify_leads_bulk" },
      extra: { count: propertyIds.length },
    });
    return errFromUnknown(e, "QUALIFY_BULK_FAILED");
  }
}

/**
 * Revert an already-qualified lead back to `prospect`. Used for the
 * "I qualified that by mistake" undo on the lead-detail status dropdown.
 * Clears `qualified_at` + `qualified_by` so a future qualify stamps fresh
 * values. No-op if the lead is already a prospect.
 *
 * Intentionally does NOT restore any prior status chain — the VA picks
 * `Prospect` explicitly, and a re-qualify is one click away.
 */
export async function revertToProspect(
  propertyId: string,
): Promise<Result<null>> {
  try {
    const supabase = await createClient();
    const unlocked = await assertPropertyDncUnlocked(supabase, propertyId);
    if (!unlocked.ok) return unlocked;
    const { data: current, error: lookupErr } = await supabase
      .from("properties")
      .select("status")
      .eq("id", propertyId)
      .maybeSingle();
    if (lookupErr) {
      return {
        ok: false,
        error: { code: "LEAD_FETCH_FAILED", message: lookupErr.message },
      };
    }
    if (!current) {
      return {
        ok: false,
        error: { code: "LEAD_NOT_FOUND", message: "Lead not found." },
      };
    }
    if (current.status === "prospect") {
      // Already a prospect — nothing to do.
      return ok(null);
    }

    const nowIso = new Date().toISOString();
    const { data: saved, error } = await supabase
      .from("properties")
      .update({
        status: "prospect",
        qualified_at: null,
        qualified_by: null,
        updated_at: nowIso,
      })
      .eq("id", propertyId)
      .eq("status", current.status)
      .select("id")
      .maybeSingle();
    if (error) {
      return {
        ok: false,
        error: { code: "REVERT_FAILED", message: error.message },
      };
    }
    if (!saved) {
      const { data: authoritative, error: reconcileError } = await supabase
        .from("properties")
        .select("status")
        .eq("id", propertyId)
        .maybeSingle();
      if (!reconcileError && authoritative?.status === "prospect") {
        return ok(null);
      }
      return {
        ok: false,
        error: {
          code: "REVERT_CONFLICT",
          message: "This lead changed before the revert was saved.",
        },
      };
    }
    await recordLeadEvent({
      propertyId,
      ...(await getLeadEventActor(supabase)),
      eventType: LEAD_EVENT_TYPES.REVERTED_TO_PROSPECT,
      payload: { from: current.status, to: "prospect" },
    });
    return ok(null);
  } catch (e) {
    reportError(e, {
      tags: { surface: "revert_to_prospect" },
      extra: { propertyId },
    });
    return errFromUnknown(e, "REVERT_FAILED");
  }
}

// ============================================================================
// Bulk actions for /properties (Feature 4 Actions dropdown)
//
// Every bulk action follows the same shape: return ok with a per-id
// `failed[]` array rather than short-circuiting. That keeps the UX
// truthful — "qualified 47, 3 failed" beats "action errored out and
// I don't know what landed".
// ============================================================================

export type BulkOutcome = {
  succeeded: number;
  skipped: number;
  failed: { propertyId: string; message: string }[];
};

export type BulkTagRow = {
  id: string;
  name: string;
  color: string | null;
  category:
    "source" | "marketing" | "skip_trace" | "phone" | "journey" | "custom";
  system_managed: boolean;
};

const MEMBERSHIP_BULK_CHUNK_SIZE = 250;

type BulkTagProperty = { id: string; org_id: string };
type ResolvedBulkTagRow = BulkTagRow & { org_id: string };
type TagInsertError = { code?: string; message: string };

function validateCustomTagInput(name: string, color?: string | null) {
  const trimmed = name.trim();
  if (!trimmed) {
    return {
      ok: false as const,
      error: { code: "VALIDATION", message: "Tag name is required." },
    };
  }
  if (trimmed.length > 60) {
    return {
      ok: false as const,
      error: {
        code: "VALIDATION",
        message: `Name is ${trimmed.length} characters - cap is 60.`,
      },
    };
  }
  if (color && !/^#[0-9a-f]{6}$/i.test(color)) {
    return {
      ok: false as const,
      error: {
        code: "VALIDATION",
        message: "Color must be a 6-character hex like #3b82f6.",
      },
    };
  }
  return { ok: true as const, trimmed, color: color ?? null };
}

async function fetchCustomTagsForOrg(
  supabase: Awaited<ReturnType<typeof createClient>>,
  orgId: string,
): Promise<Result<ResolvedBulkTagRow[]>> {
  const { data, error } = await supabase
    .from("tags")
    .select("id, name, color, category, system_managed, org_id")
    .eq("org_id", orgId);
  if (error) {
    return {
      ok: false,
      error: { code: "TAG_FETCH_FAILED", message: error.message },
    };
  }
  return ok((data ?? []) as ResolvedBulkTagRow[]);
}

function findTagByNormalizedName(
  tags: ResolvedBulkTagRow[],
  normalizedName: string,
) {
  const matches = tags.filter(
    (tag) => tag.name.toLowerCase() === normalizedName,
  );
  return (
    matches.find((tag) => tag.category === "custom" && !tag.system_managed) ??
    matches[0] ??
    null
  );
}

function requireBulkApplicableCustomTag(
  tag: ResolvedBulkTagRow,
): Result<ResolvedBulkTagRow> {
  if (tag.category !== "custom" || tag.system_managed) {
    return {
      ok: false,
      error: {
        code: "TAG_NOT_APPLICABLE",
        message: "Only custom tags can be bulk-applied.",
      },
    };
  }
  return ok(tag);
}

async function resolveCustomTagForBulk(
  supabase: Awaited<ReturnType<typeof createClient>>,
  orgId: string,
  name: string,
  color?: string | null,
): Promise<Result<ResolvedBulkTagRow>> {
  const validation = validateCustomTagInput(name, color);
  if (!validation.ok) return validation;

  const normalizedName = validation.trimmed.toLowerCase();
  const visibleTags = await fetchCustomTagsForOrg(supabase, orgId);
  if (!visibleTags.ok) return visibleTags;
  const existing = findTagByNormalizedName(visibleTags.data, normalizedName);
  if (existing) {
    return requireBulkApplicableCustomTag(existing);
  }

  const { data: inserted, error: insertErr } = await supabase
    .from("tags")
    .insert({
      org_id: orgId,
      name: validation.trimmed,
      category: "custom",
      color: validation.color,
    })
    .select("id, name, color, category, system_managed, org_id")
    .single();
  if (insertErr) {
    if ((insertErr as TagInsertError).code === "23505") {
      const racedTags = await fetchCustomTagsForOrg(supabase, orgId);
      if (!racedTags.ok) return racedTags;
      const raced = findTagByNormalizedName(racedTags.data, normalizedName);
      if (raced) {
        return requireBulkApplicableCustomTag(raced);
      }
    }
    return {
      ok: false,
      error: { code: "TAG_CREATE_FAILED", message: insertErr.message },
    };
  }

  return ok(inserted as ResolvedBulkTagRow);
}

async function fetchBulkTagProperties(
  supabase: Awaited<ReturnType<typeof createClient>>,
  propertyIds: string[],
): Promise<
  Result<{ props: BulkTagProperty[]; failed: BulkOutcome["failed"] }>
> {
  const props: BulkTagProperty[] = [];
  for (let i = 0; i < propertyIds.length; i += MEMBERSHIP_BULK_CHUNK_SIZE) {
    const chunk = propertyIds.slice(i, i + MEMBERSHIP_BULK_CHUNK_SIZE);
    const { data, error: lookupErr } = await supabase
      .from("properties")
      .select("id, org_id")
      .in("id", chunk);
    if (lookupErr) {
      return {
        ok: false,
        error: { code: "APPLY_TAG_FAILED", message: lookupErr.message },
      };
    }
    props.push(...((data ?? []) as BulkTagProperty[]));
  }

  const foundIds = new Set(props.map((p) => p.id));
  const failed: BulkOutcome["failed"] = propertyIds
    .filter((id) => !foundIds.has(id))
    .map((id) => ({ propertyId: id, message: "Property not found" }));

  return ok({ props, failed });
}

async function applyResolvedCustomTagBulkWithClient(
  supabase: Awaited<ReturnType<typeof createClient>>,
  props: BulkTagProperty[],
  initialFailed: BulkOutcome["failed"],
  tag: Pick<ResolvedBulkTagRow, "id" | "name" | "org_id">,
): Promise<Result<BulkOutcome>> {
  const failed: BulkOutcome["failed"] = [...initialFailed];
  const sameOrgProps: BulkTagProperty[] = [];
  for (const prop of props) {
    if (prop.org_id === tag.org_id) {
      sameOrgProps.push(prop);
    } else {
      failed.push({
        propertyId: prop.id,
        message: "Tag does not belong to this property's organization",
      });
    }
  }

  const {
    data: { user },
  } = await supabase.auth.getUser();
  const existingPropertyIds = new Set<string>();
  for (let i = 0; i < sameOrgProps.length; i += MEMBERSHIP_BULK_CHUNK_SIZE) {
    const ids = sameOrgProps
      .slice(i, i + MEMBERSHIP_BULK_CHUNK_SIZE)
      .map((property) => property.id);
    const { data: existing, error: existingError } = await supabase
      .from("property_tags")
      .select("property_id")
      .eq("tag_id", tag.id)
      .in("property_id", ids);
    if (existingError) {
      return {
        ok: false,
        error: { code: "TAG_FETCH_FAILED", message: existingError.message },
      };
    }
    for (const row of existing ?? []) existingPropertyIds.add(row.property_id);
  }

  const rows = sameOrgProps
    .filter((property) => !existingPropertyIds.has(property.id))
    .map((p) => ({
      org_id: p.org_id,
      property_id: p.id,
      tag_id: tag.id,
      applied_by: user?.id ?? null,
      source: "manual",
    }));

  const succeededIds: string[] = [];
  let processedCandidateCount = 0;
  for (let i = 0; i < rows.length; i += MEMBERSHIP_BULK_CHUNK_SIZE) {
    const chunk = rows.slice(i, i + MEMBERSHIP_BULK_CHUNK_SIZE);
    const { data: saved, error } = await supabase
      .from("property_tags")
      .upsert(chunk, {
        onConflict: "property_id,tag_id",
        ignoreDuplicates: true,
      })
      .select("property_id");
    if (error) {
      failed.push(
        ...rows.slice(i).map((row) => ({
          propertyId: row.property_id,
          message: error.message,
        })),
      );
      break;
    }
    processedCandidateCount += chunk.length;
    succeededIds.push(...(saved ?? []).map((row) => row.property_id));
  }

  if (succeededIds.length > 0) {
    const batchId = randomUUID();
    const actor = user?.id
      ? ({ actorType: "user", actorId: user.id } as const)
      : ({ actorType: "system" } as const);
    await recordLeadEvents(
      succeededIds.map((propertyId) => ({
        propertyId,
        ...actor,
        eventType: LEAD_EVENT_TYPES.TAG_APPLIED,
        payload: {
          tag_id: tag.id,
          label: tag.name,
          batch_id: batchId,
          batch_count: succeededIds.length,
        },
      })),
    );
  }

  return ok({
    succeeded: succeededIds.length,
    skipped:
      existingPropertyIds.size +
      Math.max(0, processedCandidateCount - succeededIds.length),
    failed,
  });
}

async function applyCustomTagBulkWithClient(
  supabase: Awaited<ReturnType<typeof createClient>>,
  propertyIds: string[],
  tagId: string,
): Promise<Result<BulkOutcome>> {
  if (propertyIds.length === 0) {
    return ok({ succeeded: 0, skipped: 0, failed: [] });
  }

  const { data: tag, error: tagErr } = await supabase
    .from("tags")
    .select("id, name, category, system_managed, org_id")
    .eq("id", tagId)
    .maybeSingle();
  if (tagErr) {
    return {
      ok: false,
      error: { code: "TAG_FETCH_FAILED", message: tagErr.message },
    };
  }
  if (!tag) {
    return {
      ok: false,
      error: { code: "TAG_NOT_FOUND", message: "Tag not found." },
    };
  }
  // Strict journey-marker model: only custom tags can be applied by
  // users. Auto tags (source:*, uploaded:*, skip-trace etc.) are
  // system_managed and must not be hand-applied.
  if (tag.category !== "custom" || tag.system_managed) {
    return {
      ok: false,
      error: {
        code: "TAG_NOT_APPLICABLE",
        message: "Only custom tags can be bulk-applied.",
      },
    };
  }

  const propsResult = await fetchBulkTagProperties(supabase, propertyIds);
  if (!propsResult.ok) return propsResult;

  return applyResolvedCustomTagBulkWithClient(
    supabase,
    propsResult.data.props,
    propsResult.data.failed,
    tag as Pick<ResolvedBulkTagRow, "id" | "name" | "org_id">,
  );
}

export async function assignLeadsBulk(
  propertyIds: string[],
  userId: string | null,
): Promise<Result<BulkOutcome>> {
  if (propertyIds.length === 0) {
    return ok({ succeeded: 0, skipped: 0, failed: [] });
  }
  try {
    const supabase = await createClient();
    const partition = await partitionPropertyDncLocks(supabase, propertyIds);
    if (!partition.ok) return partition;
    if (partition.data.unlocked.length === 0) {
      return {
        ok: false,
        error: { code: "DNC_LOCKED", message: DNC_LOCKED_MESSAGE },
      };
    }
    const assignIds = partition.data.unlocked;
    const assigneeValidation = await validateActiveAssigneeForProperties(
      supabase,
      assignIds,
      userId,
    );
    if (!assigneeValidation.ok) {
      return {
        ok: false,
        error: {
          code: assigneeValidation.code,
          message: assigneeValidation.message,
        },
      };
    }
    const {
      data: { user },
    } = await supabase.auth.getUser();
    const { data: currentAssignments, error: lookupError } = await supabase
      .from("properties")
      .select("id, assigned_user_id")
      .in("id", assignIds);
    if (lookupError) {
      return {
        ok: false,
        error: { code: "ASSIGN_BULK_FAILED", message: lookupError.message },
      };
    }

    const assignmentById = new Map(
      (currentAssignments ?? []).map((row) => [row.id, row.assigned_user_id]),
    );
    const unchangedIds = assignIds.filter(
      (propertyId) => assignmentById.get(propertyId) === userId,
    );
    const candidateIds = assignIds.filter(
      (propertyId) => assignmentById.get(propertyId) !== userId,
    );
    const idsByPrevious = new Map<string | null, string[]>();
    for (const propertyId of candidateIds) {
      const previous = assignmentById.get(propertyId) ?? null;
      const group = idsByPrevious.get(previous) ?? [];
      group.push(propertyId);
      idsByPrevious.set(previous, group);
    }

    const changedIds: string[] = [];
    const failed: BulkOutcome["failed"] = [
      ...partition.data.locked.map((propertyId) => ({
        propertyId,
        message: DNC_LOCKED_MESSAGE,
      })),
      ...partition.data.missing.map((propertyId) => ({
        propertyId,
        message: "Property not found",
      })),
    ];
    const previousByChangedId = new Map<string, string | null>();
    const writeFailedIds = new Set<string>();
    for (const [previous, ids] of idsByPrevious) {
      let update = supabase
        .from("properties")
        .update({
          assigned_user_id: userId,
          updated_at: new Date().toISOString(),
        })
        .in("id", ids);
      update =
        previous === null
          ? update.is("assigned_user_id", null)
          : update.eq("assigned_user_id", previous);
      const { data: saved, error } = await update.select("id");
      if (error) {
        ids.forEach((propertyId) => writeFailedIds.add(propertyId));
        failed.push(
          ...ids.map((propertyId) => ({
            propertyId,
            message: error.message,
          })),
        );
        continue;
      }
      for (const row of saved ?? []) {
        changedIds.push(row.id);
        previousByChangedId.set(row.id, previous);
      }
    }

    const changedIdSet = new Set(changedIds);
    const racedIds = candidateIds.filter(
      (id) => !changedIdSet.has(id) && !writeFailedIds.has(id),
    );
    let concurrentlySatisfied = 0;
    if (racedIds.length > 0) {
      const { data: authoritative, error: reconcileError } = await supabase
        .from("properties")
        .select("id, assigned_user_id")
        .in("id", racedIds);
      if (reconcileError) {
        failed.push(
          ...racedIds.map((propertyId) => ({
            propertyId,
            message: "The current assignment could not be verified.",
          })),
        );
      } else {
        const authoritativeById = new Map(
          (authoritative ?? []).map((row) => [row.id, row.assigned_user_id]),
        );
        for (const propertyId of racedIds) {
          if (authoritativeById.get(propertyId) === userId) {
            concurrentlySatisfied++;
          } else {
            failed.push({
              propertyId,
              message: "This lead changed before the assignment was saved.",
            });
          }
        }
      }
    }

    if (changedIds.length > 0) {
      const batchId = randomUUID();
      const actor = user?.id
        ? ({ actorType: "user", actorId: user.id } as const)
        : ({ actorType: "system" } as const);
      await recordLeadEvents(
        changedIds.map((propertyId) => ({
          propertyId,
          ...actor,
          eventType: LEAD_EVENT_TYPES.ASSIGNED,
          payload: {
            from: previousByChangedId.get(propertyId) ?? null,
            to: userId,
            batch_id: batchId,
            batch_count: changedIds.length,
          },
        })),
      );
    }

    // Feature 7 — fire property_assigned notifications. Best-effort:
    // dispatch swallows errors internally, and we catch anything that
    // bubbles so a notification hiccup never fails the assignment.
    if (changedIds.length > 0) {
      try {
        await dispatchPropertyAssigned(supabase, {
          propertyIds: changedIds,
          newAssigneeId: userId,
          actorId: user?.id ?? null,
          assignerName: user?.email?.split("@")[0] ?? null,
        });
      } catch (e) {
        reportError(e, {
          tags: { surface: "assign_leads_bulk_notification_dispatch" },
          extra: { count: changedIds.length },
        });
      }
    }

    return ok({
      succeeded: changedIds.length,
      skipped: unchangedIds.length + concurrentlySatisfied,
      failed,
    });
  } catch (e) {
    reportError(e, {
      tags: { surface: "assign_leads_bulk" },
      extra: { count: propertyIds.length },
    });
    return errFromUnknown(e, "ASSIGN_BULK_FAILED");
  }
}

export async function addPropertiesToListBulk(
  propertyIds: string[],
  listId: string,
): Promise<Result<BulkOutcome>> {
  if (propertyIds.length === 0) {
    return ok({ succeeded: 0, skipped: 0, failed: [] });
  }
  try {
    const supabase = await createClient();
    const { data: list, error: listError } = await supabase
      .from("lists")
      .select("id, name, org_id")
      .eq("id", listId)
      .maybeSingle();
    if (listError) {
      return {
        ok: false,
        error: { code: "LIST_FETCH_FAILED", message: listError.message },
      };
    }
    if (!list) {
      return {
        ok: false,
        error: { code: "LIST_NOT_FOUND", message: "List not found." },
      };
    }
    // Look up org_ids so we satisfy property_lists.org_id NOT NULL. Every
    // property has an org; the query scopes to the ids we got, so RLS
    // already filtered out cross-org rows if any.
    const uniquePropertyIds = [...new Set(propertyIds)];
    const props: BulkTagProperty[] = [];
    for (
      let i = 0;
      i < uniquePropertyIds.length;
      i += MEMBERSHIP_BULK_CHUNK_SIZE
    ) {
      const chunk = uniquePropertyIds.slice(i, i + MEMBERSHIP_BULK_CHUNK_SIZE);
      const { data, error: lookupError } = await supabase
        .from("properties")
        .select("id, org_id")
        .in("id", chunk);
      if (lookupError) {
        return {
          ok: false,
          error: { code: "ADD_TO_LIST_FAILED", message: lookupError.message },
        };
      }
      props.push(...((data ?? []) as BulkTagProperty[]));
    }
    const foundIds = new Set(props.map((p) => p.id));
    const failed: BulkOutcome["failed"] = [];
    for (const id of uniquePropertyIds) {
      if (!foundIds.has(id)) {
        failed.push({ propertyId: id, message: "Property not found" });
      }
    }
    const sameOrgProps = props.filter((property) => {
      if (property.org_id === list.org_id) return true;
      failed.push({
        propertyId: property.id,
        message: "List does not belong to this property's organization",
      });
      return false;
    });

    const {
      data: { user },
    } = await supabase.auth.getUser();
    const existingPropertyIds = new Set<string>();
    for (let i = 0; i < sameOrgProps.length; i += MEMBERSHIP_BULK_CHUNK_SIZE) {
      const ids = sameOrgProps
        .slice(i, i + MEMBERSHIP_BULK_CHUNK_SIZE)
        .map((property) => property.id);
      const { data: existing, error: existingError } = await supabase
        .from("property_lists")
        .select("property_id")
        .eq("list_id", listId)
        .in("property_id", ids);
      if (existingError) {
        return {
          ok: false,
          error: { code: "ADD_TO_LIST_FAILED", message: existingError.message },
        };
      }
      for (const row of existing ?? [])
        existingPropertyIds.add(row.property_id);
    }

    const nowIso = new Date().toISOString();
    const rows = sameOrgProps
      .filter((property) => !existingPropertyIds.has(property.id))
      .map((p) => ({
        org_id: p.org_id,
        property_id: p.id,
        list_id: listId,
        last_added_at: nowIso,
        last_added_by: user?.id ?? null,
      }));
    const succeededIds: string[] = [];
    let processedCandidateCount = 0;
    for (let i = 0; i < rows.length; i += MEMBERSHIP_BULK_CHUNK_SIZE) {
      const chunk = rows.slice(i, i + MEMBERSHIP_BULK_CHUNK_SIZE);
      const { data: saved, error } = await supabase
        .from("property_lists")
        .upsert(chunk, {
          onConflict: "property_id,list_id",
          ignoreDuplicates: true,
        })
        .select("property_id");
      if (error) {
        failed.push(
          ...rows.slice(i).map((row) => ({
            propertyId: row.property_id,
            message: error.message,
          })),
        );
        break;
      }
      processedCandidateCount += chunk.length;
      succeededIds.push(...(saved ?? []).map((row) => row.property_id));
    }
    if (succeededIds.length > 0) {
      const batchId = randomUUID();
      const actor = user?.id
        ? ({ actorType: "user", actorId: user.id } as const)
        : ({ actorType: "system" } as const);
      await recordLeadEvents(
        succeededIds.map((propertyId) => ({
          propertyId,
          ...actor,
          eventType: LEAD_EVENT_TYPES.LIST_ADDED,
          payload: {
            list_id: listId,
            label: list.name,
            batch_id: batchId,
            batch_count: succeededIds.length,
          },
        })),
      );
    }
    return ok({
      succeeded: succeededIds.length,
      skipped:
        existingPropertyIds.size +
        Math.max(0, processedCandidateCount - succeededIds.length),
      failed,
    });
  } catch (e) {
    reportError(e, {
      tags: { surface: "add_properties_to_list_bulk" },
      extra: { count: propertyIds.length, listId },
    });
    return errFromUnknown(e, "ADD_TO_LIST_FAILED");
  }
}

export async function removePropertiesFromListBulk(
  propertyIds: string[],
  listId: string,
): Promise<Result<BulkOutcome>> {
  if (propertyIds.length === 0) {
    return ok({ succeeded: 0, skipped: 0, failed: [] });
  }
  try {
    const supabase = await createClient();
    const uniquePropertyIds = [...new Set(propertyIds)];
    const { data: list, error: listError } = await supabase
      .from("lists")
      .select("name")
      .eq("id", listId)
      .maybeSingle();
    if (listError) {
      return {
        ok: false,
        error: { code: "LIST_FETCH_FAILED", message: listError.message },
      };
    }
    if (!list) {
      return {
        ok: false,
        error: { code: "LIST_NOT_FOUND", message: "List not found." },
      };
    }
    const {
      data: { user },
    } = await supabase.auth.getUser();
    const removedIds: string[] = [];
    const failed: BulkOutcome["failed"] = [];
    for (
      let i = 0;
      i < uniquePropertyIds.length;
      i += MEMBERSHIP_BULK_CHUNK_SIZE
    ) {
      const chunk = uniquePropertyIds.slice(i, i + MEMBERSHIP_BULK_CHUNK_SIZE);
      const { data: removed, error } = await supabase
        .from("property_lists")
        .delete()
        .eq("list_id", listId)
        .in("property_id", chunk)
        .select("property_id");
      if (error) {
        failed.push(
          ...chunk.map((propertyId) => ({
            propertyId,
            message: error.message,
          })),
        );
        continue;
      }
      removedIds.push(...(removed ?? []).map((row) => row.property_id));
    }
    if (removedIds.length > 0) {
      const batchId = randomUUID();
      const actor = user?.id
        ? ({ actorType: "user", actorId: user.id } as const)
        : ({ actorType: "system" } as const);
      await recordLeadEvents(
        removedIds.map((propertyId) => ({
          propertyId,
          ...actor,
          eventType: LEAD_EVENT_TYPES.LIST_REMOVED,
          payload: {
            list_id: listId,
            label: list.name,
            batch_id: batchId,
            batch_count: removedIds.length,
          },
        })),
      );
    }
    return ok({
      succeeded: removedIds.length,
      skipped: uniquePropertyIds.length - removedIds.length - failed.length,
      failed,
    });
  } catch (e) {
    reportError(e, {
      tags: { surface: "remove_properties_from_list_bulk" },
      extra: { count: propertyIds.length, listId },
    });
    return errFromUnknown(e, "REMOVE_FROM_LIST_FAILED");
  }
}

async function getMatchingProspectIdsForBulkTag(args: {
  supabase: Awaited<ReturnType<typeof createClient>>;
  search: string | null;
  blockStack: FilterBlock[];
}): Promise<Result<string[]>> {
  const hasPipelineStatusBlock = args.blockStack.some(
    (block) => block.kind === "pipeline_status",
  );
  const filterSelect = filterSelectFragment(args.blockStack);
  const propertiesSelect = ["id", filterSelect].filter(Boolean).join(", ");

  let query = args.supabase
    .from("properties")
    .select(propertiesSelect)
    .is("deleted_at", null);
  if (!hasPipelineStatusBlock) {
    query = query.eq("status", "prospect");
  }
  if (args.search) {
    query = query.ilike("address", `%${args.search}%`);
  }

  query = (await applyFilters(query, args.blockStack, args.supabase)).builder;

  const pageSize = 1000;
  const ids: string[] = [];
  for (let from = 0; ; from += pageSize) {
    const { data, error } = await query.range(from, from + pageSize - 1);
    if (error) {
      return {
        ok: false,
        error: { code: "SELECT_ALL_FAILED", message: error.message },
      };
    }
    const page = ((data ?? []) as unknown as Array<{ id: string }>).map(
      (row) => row.id,
    );
    ids.push(...page);
    if (page.length < pageSize) break;
  }

  return ok(ids);
}

export async function applyTagBulk(
  propertyIds: string[],
  tagId: string,
): Promise<Result<BulkOutcome>> {
  try {
    const supabase = await createClient();
    return await applyCustomTagBulkWithClient(supabase, propertyIds, tagId);
  } catch (e) {
    reportError(e, {
      tags: { surface: "apply_tag_bulk" },
      extra: { count: propertyIds.length, tagId },
    });
    return errFromUnknown(e, "APPLY_TAG_FAILED");
  }
}

export async function createAndApplyCustomTagBulk(params: {
  name: string;
  color?: string | null;
  propertyIds: string[];
}): Promise<Result<{ tag: BulkTagRow; outcome: BulkOutcome }>> {
  try {
    const supabase = await createClient();
    if (params.propertyIds.length === 0) {
      return {
        ok: false,
        error: {
          code: "NO_SELECTED_PROPERTIES",
          message: "Select at least one prospect before applying a tag.",
        },
      };
    }

    const propsResult = await fetchBulkTagProperties(
      supabase,
      params.propertyIds,
    );
    if (!propsResult.ok) return propsResult;

    const visibleOrgIds = Array.from(
      new Set(propsResult.data.props.map((prop) => prop.org_id)),
    );
    if (visibleOrgIds.length === 0) {
      return {
        ok: false,
        error: {
          code: "NO_VISIBLE_PROPERTIES",
          message: "No selected prospects are available for tagging.",
        },
      };
    }
    if (visibleOrgIds.length > 1) {
      return {
        ok: false,
        error: {
          code: "MULTI_ORG_SELECTION",
          message:
            "Create/apply tag only supports prospects from one organization at a time.",
        },
      };
    }

    const tagResult = await resolveCustomTagForBulk(
      supabase,
      visibleOrgIds[0],
      params.name,
      params.color ?? null,
    );
    if (!tagResult.ok) return tagResult;

    const outcomeResult = await applyResolvedCustomTagBulkWithClient(
      supabase,
      propsResult.data.props,
      propsResult.data.failed,
      tagResult.data,
    );
    if (!outcomeResult.ok) return outcomeResult;

    return ok({ tag: tagResult.data, outcome: outcomeResult.data });
  } catch (e) {
    reportError(e, {
      tags: { surface: "create_and_apply_custom_tag_bulk" },
      extra: { count: params.propertyIds.length },
    });
    return errFromUnknown(e, "APPLY_TAG_FAILED");
  }
}

export async function createAndApplyCustomTagBulkFromFilters(params: {
  name: string;
  color?: string | null;
  search: string | null;
  blockStack: FilterBlock[];
}): Promise<Result<{ tag: BulkTagRow; outcome: BulkOutcome }>> {
  try {
    const supabase = await createClient();
    const idsResult = await getMatchingProspectIdsForBulkTag({
      supabase,
      search: params.search,
      blockStack: params.blockStack,
    });
    if (!idsResult.ok) return idsResult;

    const tagResult = await createAndApplyCustomTagBulk({
      name: params.name,
      color: params.color ?? null,
      propertyIds: idsResult.data,
    });
    return tagResult;
  } catch (e) {
    reportError(e, {
      tags: { surface: "create_and_apply_custom_tag_bulk_from_filters" },
      extra: { blockCount: params.blockStack.length },
    });
    return errFromUnknown(e, "APPLY_TAG_FAILED");
  }
}

export async function setMotivationBulk(
  propertyIds: string[],
  level: MotivationLevel | null,
): Promise<Result<BulkOutcome>> {
  if (propertyIds.length === 0) {
    return ok({ succeeded: 0, skipped: 0, failed: [] });
  }
  if (level !== null && !VALID_MOTIVATION_LEVELS.includes(level)) {
    return {
      ok: false,
      error: {
        code: "INVALID_MOTIVATION",
        message: `Unknown motivation level: ${level}`,
      },
    };
  }
  try {
    const supabase = await createClient();
    const { error } = await supabase
      .from("properties")
      .update({
        motivation_level: level,
        updated_at: new Date().toISOString(),
      })
      .in("id", propertyIds);
    if (error) {
      return {
        ok: false,
        error: { code: "SET_MOTIVATION_FAILED", message: error.message },
      };
    }
    return ok({ succeeded: propertyIds.length, skipped: 0, failed: [] });
  } catch (e) {
    reportError(e, {
      tags: { surface: "set_motivation_bulk" },
      extra: { count: propertyIds.length, level },
    });
    return errFromUnknown(e, "SET_MOTIVATION_FAILED");
  }
}

/**
 * Bulk soft-delete. Admin-only — a VA accidentally nuking 500 prospects
 * from the wizard picker is exactly the footgun the soft-delete column
 * was added for, but the admin guard is the first line of defense.
 * Recovery is a single UPDATE (deleted_at = NULL) for an admin with DB
 * access.
 */
export async function deletePropertiesBulk(
  propertyIds: string[],
): Promise<Result<BulkOutcome>> {
  if (propertyIds.length === 0) {
    return ok({ succeeded: 0, skipped: 0, failed: [] });
  }
  try {
    const supabase = await createClient();
    const partition = await partitionPropertyDncLocks(supabase, propertyIds);
    if (!partition.ok) return partition;
    if (partition.data.unlocked.length === 0) {
      return {
        ok: false,
        error: { code: "DNC_LOCKED", message: DNC_LOCKED_MESSAGE },
      };
    }
    const deleteIds = partition.data.unlocked;
    const {
      data: { user },
    } = await supabase.auth.getUser();
    if (!isAdminEmail(user?.email)) {
      return {
        ok: false,
        error: {
          code: "FORBIDDEN",
          message: "Only admins can delete properties.",
        },
      };
    }
    const { error } = await supabase
      .from("properties")
      .update({
        deleted_at: new Date().toISOString(),
        updated_at: new Date().toISOString(),
      })
      .in("id", deleteIds)
      .is("deleted_at", null);
    if (error) {
      return {
        ok: false,
        error: { code: "DELETE_FAILED", message: error.message },
      };
    }
    return ok({
      succeeded: deleteIds.length,
      skipped: 0,
      failed: partition.data.locked.map((propertyId) => ({
        propertyId,
        message: DNC_LOCKED_MESSAGE,
      })),
    });
  } catch (e) {
    reportError(e, {
      tags: { surface: "delete_properties_bulk" },
      extra: { count: propertyIds.length },
    });
    return errFromUnknown(e, "DELETE_FAILED");
  }
}

/**
 * Kick off a bulk CASS verify against the selection. Creates a job
 * and runs the enrichment in the background via `after()` — the UI
 * toast sends the VA to /jobs to watch progress. Mirrors how CSV
 * import spawns its CASS child job, but without a parent_job_id since
 * this is a standalone action.
 */
export async function verifyPropertiesBulk(
  propertyIds: string[],
  requestKey: string,
): Promise<Result<{ jobId: string }>> {
  if (propertyIds.length === 0) {
    return {
      ok: false,
      error: {
        code: "EMPTY_SELECTION",
        message: "Select at least one property to verify.",
      },
    };
  }
  try {
    const supabase = await createClient();
    const partition = await partitionPropertyDncLocks(supabase, propertyIds);
    if (!partition.ok) return partition;
    if (partition.data.unlocked.length === 0) {
      return {
        ok: false,
        error: { code: "DNC_LOCKED", message: DNC_LOCKED_MESSAGE },
      };
    }
    const verifyIds = partition.data.unlocked;
    const {
      data: { user },
    } = await supabase.auth.getUser();
    if (!user) {
      return {
        ok: false,
        error: {
          code: "AUTH_REQUIRED",
          message: "Sign in to verify properties.",
        },
      };
    }

    const { data: ownedRows, error: ownershipError } = await supabase
      .from("properties")
      .select("id, org_id")
      .in("id", verifyIds);
    if (ownershipError) {
      return {
        ok: false,
        error: { code: "VERIFY_SCOPE_FAILED", message: ownershipError.message },
      };
    }
    const orgIds = new Set((ownedRows ?? []).map((row) => row.org_id));
    if (
      (ownedRows ?? []).length !== new Set(verifyIds).size ||
      orgIds.size !== 1
    ) {
      return {
        ok: false,
        error: {
          code: "VERIFY_SCOPE_FAILED",
          message:
            "Every selected property must belong to the same organization.",
        },
      };
    }
    const orgId = Array.from(orgIds)[0];

    let jobId: string;
    let claimToken: string;
    try {
      const child = await createStandaloneCassJob(supabase, {
        orgId,
        propertyIds: verifyIds,
        createdBy: user.id,
        requestKey,
      });
      jobId = child.jobId;
      if (!child.claimToken) {
        throw new Error("CASS job did not return a start receipt");
      }
      claimToken = child.claimToken;
    } catch (createError) {
      return {
        ok: false,
        error: {
          code: "VERIFY_JOB_CREATE_FAILED",
          message:
            createError instanceof Error
              ? createError.message
              : "Job creation failed",
        },
      };
    }

    // Chunked workflow, NOT inline enrichment: a single function
    // invocation dies at the platform's 5-minute ceiling (~1.8K rows),
    // which is how the 2026-06-11 11,134-row bulk verify stalled. The
    // workflow reads property_ids back off the job row and processes
    // them in capped chunks, one invocation each.
    after(async () => {
      try {
        await start(cassBulkWorkflow, [{ jobId, claimToken }]);
      } catch (e) {
        reportError(e, {
          tags: { surface: "verify_properties_bulk_workflow_start" },
          extra: { jobId, count: verifyIds.length },
        });
        await failAuthorizedCassJobStart(supabase, {
          jobId,
          orgId,
          claimToken,
          error: e,
        });
      }
    });

    return ok({ jobId });
  } catch (e) {
    reportError(e, {
      tags: { surface: "verify_properties_bulk" },
      extra: { count: propertyIds.length },
    });
    return errFromUnknown(e, "VERIFY_JOB_FAILED");
  }
}

export async function updatePropertyStatus(
  propertyId: string,
  status: PropertyStatus,
  expectedPreviousStatus: PropertyStatus,
): Promise<Result<{ propertyId: string; status: PropertyStatus }>> {
  if (
    !VALID_STATUSES.includes(status) ||
    !VALID_STATUSES.includes(expectedPreviousStatus)
  ) {
    return {
      ok: false,
      error: {
        code: "INVALID_STATUS",
        message: `Unknown status: ${status}`,
      },
    };
  }

  try {
    const supabase = await createClient();
    const unlocked = await assertPropertyDncUnlocked(supabase, propertyId);
    if (!unlocked.ok) return unlocked;
    const { data, error } = await supabase
      .from("properties")
      .update({ status, updated_at: new Date().toISOString() })
      .eq("id", propertyId)
      .eq("status", expectedPreviousStatus)
      .select("id, status")
      .maybeSingle();

    if (error) {
      return {
        ok: false,
        error: {
          code: "STATUS_UPDATE_FAILED",
          message: error.message,
        },
      };
    }

    // A zero-row compare-and-set can mean another client already saved this
    // target, or moved the card somewhere else. Read the authoritative row so
    // the caller can distinguish idempotent success from a real conflict and
    // reconcile its local card instead of reverting to stale state.
    if (!data) {
      const { data: current, error: currentError } = await supabase
        .from("properties")
        .select("id, status")
        .eq("id", propertyId)
        .maybeSingle();
      if (currentError) {
        return {
          ok: false,
          error: {
            code: "STATUS_RECONCILIATION_FAILED",
            message:
              "The lead changed, but its current stage could not be loaded.",
          },
        };
      }
      if (current?.status === status) {
        return ok({
          propertyId: current.id,
          status: current.status as PropertyStatus,
        });
      }
      return {
        ok: false,
        error: {
          code: "STATUS_CONFLICT",
          message:
            "This lead changed before your move was saved. Its current stage has been restored.",
          ...(current &&
          VALID_STATUSES.includes(current.status as PropertyStatus)
            ? { details: { currentStatus: current.status } }
            : {}),
        },
      };
    }

    if (data.status !== status) {
      return {
        ok: false,
        error: {
          code: "STATUS_UPDATE_NOT_SAVED",
          message: "The lead did not save in the selected stage.",
        },
      };
    }

    if (expectedPreviousStatus !== status) {
      await recordLeadEvent({
        propertyId,
        ...(await getLeadEventActor(supabase)),
        eventType: LEAD_EVENT_TYPES.STATUS_CHANGED,
        payload: { from: expectedPreviousStatus, to: status },
      });
    }

    return ok({ propertyId: data.id, status: data.status as PropertyStatus });
  } catch (e) {
    reportError(e, {
      tags: { surface: "update_property_status" },
      extra: { propertyId, status },
    });
    return errFromUnknown(e, "STATUS_UPDATE_FAILED");
  }
}

export type LeadTaskKind = Extract<TaskType, "follow_up" | "callback">;

export async function createLeadTaskAction(
  propertyId: string,
  input: {
    type: LeadTaskKind;
    dueAt: string;
    assigneeId: string;
  },
): Promise<Result<Task>> {
  if (input.type !== "follow_up" && input.type !== "callback") {
    return {
      ok: false,
      error: {
        code: "INVALID_TASK_TYPE",
        message: "Choose follow-up or callback.",
      },
    };
  }
  if (!input.dueAt || Number.isNaN(new Date(input.dueAt).getTime())) {
    return {
      ok: false,
      error: {
        code: "INVALID_DUE_AT",
        message: "Choose a valid due date.",
      },
    };
  }
  if (!input.assigneeId) {
    return {
      ok: false,
      error: {
        code: "ASSIGNEE_REQUIRED",
        message: "Choose who owns this task.",
      },
    };
  }

  try {
    const supabase = await createClient();
    const unlocked = await assertPropertyDncUnlocked(supabase, propertyId);
    if (!unlocked.ok) return unlocked;
    const {
      data: { user },
    } = await supabase.auth.getUser();
    if (!user) {
      return {
        ok: false,
        error: { code: "UNAUTHENTICATED", message: "Not signed in" },
      };
    }

    const { data: property, error: propertyErr } = await supabase
      .from("properties")
      .select("id, org_id, address")
      .eq("id", propertyId)
      .maybeSingle();
    if (propertyErr) {
      return {
        ok: false,
        error: { code: "LEAD_FETCH_FAILED", message: propertyErr.message },
      };
    }
    if (!property) {
      return {
        ok: false,
        error: { code: "LEAD_NOT_FOUND", message: "Lead not found." },
      };
    }

    const { data: actorMembership, error: actorMembershipErr } = await supabase
      .from("memberships")
      .select("user_id")
      .eq("org_id", property.org_id)
      .eq("user_id", user.id)
      .maybeSingle();
    if (actorMembershipErr) {
      return {
        ok: false,
        error: {
          code: "MEMBERSHIP_LOOKUP_FAILED",
          message: actorMembershipErr.message,
        },
      };
    }
    if (!actorMembership) {
      return {
        ok: false,
        error: {
          code: "LEAD_FORBIDDEN",
          message: "You do not have access to this lead's org.",
        },
      };
    }

    const admin = createAdminClient();
    const { data: assignee, error: assigneeErr } = await admin
      .from("memberships")
      .select("user_id")
      .eq("org_id", property.org_id)
      .eq("user_id", input.assigneeId)
      .maybeSingle();
    if (assigneeErr) {
      return {
        ok: false,
        error: {
          code: "ASSIGNEE_LOOKUP_FAILED",
          message: assigneeErr.message,
        },
      };
    }
    if (!assignee) {
      return {
        ok: false,
        error: {
          code: "ASSIGNEE_NOT_IN_ORG",
          message: "Choose a team member in this lead's org.",
        },
      };
    }

    const taskTitle =
      input.type === "callback"
        ? `Callback ${property.address}`
        : `Follow up on ${property.address}`;
    const taskResult = await createTask(supabase, {
      orgId: property.org_id,
      assigneeId: input.assigneeId,
      relatedPropertyId: property.id,
      type: input.type,
      title: taskTitle,
      dueAt: input.dueAt,
      createdBy: user.id,
    });

    if (!taskResult.ok) return taskResult;

    if (input.assigneeId !== user.id) {
      // Admin client, not the cookie client: prefs RLS is self-only, so the
      // ASSIGNING user cannot read a teammate's row — the cookie client
      // silently returns defaults (Chicago, all channels enabled), sending
      // the wrong timezone and dispatching to channels the assignee turned
      // off. This single load is the authoritative result threaded into
      // Slack (timezone + slackEnabled) below.
      const prefs = await loadIntegrationPrefs(admin, input.assigneeId);
      const deepLink = buildLeadTaskDeepLink(property.id);
      after(async () => {
        await Promise.allSettled([
          dispatchTaskAssigned(supabase, {
            taskId: taskResult.data.id,
            orgId: property.org_id,
            assigneeId: input.assigneeId,
            taskTitle,
            taskType: input.type,
            dueAt: input.dueAt,
            propertyAddress: property.address,
          }),
          dispatchTaskAssignedSlack({
            taskId: taskResult.data.id,
            assigneeId: input.assigneeId,
            taskTitle,
            taskType: input.type,
            dueAt: input.dueAt,
            propertyAddress: property.address,
            deepLink,
            timezone: prefs.timezone,
            slackEnabled: prefs.slackEnabled,
          }),
          dispatchTaskCalendarEvent({
            taskId: taskResult.data.id,
            assigneeId: input.assigneeId,
            taskTitle,
            propertyAddress: property.address,
            dueAt: input.dueAt,
            // createLeadTaskAction only creates follow_up/callback tasks
            // (guarded above) — never an appointment, so no end_at exists
            // to thread through; the 30-minute default applies.
            endAt: undefined,
            timezone: prefs.timezone,
            deepLink,
            calendarEnabled: prefs.calendarEnabled,
          }),
        ]);
      });
    }

    revalidatePath(`/leads/${propertyId}`);
    revalidatePath("/dashboard");
    return taskResult;
  } catch (e) {
    reportError(e, {
      tags: { surface: "create_lead_task" },
      extra: { propertyId, type: input.type },
    });
    return errFromUnknown(e, "TASK_CREATE_FAILED");
  }
}

function buildLeadTaskDeepLink(propertyId: string): string {
  const baseUrl =
    process.env.NEXT_PUBLIC_APP_URL ??
    process.env.APP_URL ??
    "https://sandra-sooty.vercel.app";
  const normalizedBaseUrl = baseUrl.startsWith("http")
    ? baseUrl
    : `https://${baseUrl}`;
  return `${normalizedBaseUrl}/leads/${propertyId}`;
}

// ============================================================================
// SMS messaging (Phase 1 — Dialpad via MessagingProvider adapter)
// ============================================================================

export type SendSmsPayload = {
  outcome: SendSmsOutcome;
};

/**
 * Pull the list of numbers on the Dialpad account, with owner names
 * resolved, for the composer's "send from" dropdown. Safe to call
 * from any authed user — read-only.
 */
export async function listFromNumbers(): Promise<Result<DialpadFromOption[]>> {
  try {
    const provider = getMessagingProvider();
    if (!provider || !provider.listFromNumbers) {
      return ok([]);
    }
    const numbers = await provider.listFromNumbers();
    return ok(numbers);
  } catch (e) {
    reportError(e, { tags: { surface: "list_from_numbers" } });
    return errFromUnknown(e, "LIST_FROM_NUMBERS_FAILED");
  }
}

export async function sendSmsFromLead(
  propertyId: string,
  body: string,
  from?: string | null,
  queueOnly?: boolean,
  to?: string | null,
): Promise<Result<SendSmsPayload>> {
  const trimmed = body.trim();
  if (!trimmed) {
    return {
      ok: false,
      error: { code: "EMPTY_BODY", message: "Message body is empty." },
    };
  }
  // 1600 is a comfortable hard cap — Dialpad / carriers chunk beyond
  // 160 chars anyway but we prevent runaway copy/paste of novels.
  if (trimmed.length > 1600) {
    return {
      ok: false,
      error: {
        code: "BODY_TOO_LONG",
        message: `Message is ${trimmed.length} characters — cap is 1600.`,
      },
    };
  }

  try {
    const supabase = await createClient();
    const unlocked = await assertPropertyDncUnlocked(supabase, propertyId);
    if (!unlocked.ok) return unlocked;

    const { data: property, error } = await supabase
      .from("properties")
      .select("id, homeowner_contact_id")
      .eq("id", propertyId)
      .maybeSingle();
    if (error) {
      return {
        ok: false,
        error: { code: "LEAD_FETCH_FAILED", message: error.message },
      };
    }
    if (!property) {
      return {
        ok: false,
        error: { code: "LEAD_NOT_FOUND", message: "Lead not found." },
      };
    }
    if (!property.homeowner_contact_id) {
      return {
        ok: false,
        error: {
          code: "NO_HOMEOWNER_CONTACT",
          message: "Lead has no homeowner contact linked — add one first.",
        },
      };
    }

    const outcome = await sendSmsToContact(supabase, {
      origin: "manual",
      contactId: property.homeowner_contact_id,
      propertyId,
      body: trimmed,
      from: from ?? undefined,
      to: to ?? undefined,
      queueOnly: queueOnly ?? false,
      requireStickyFrom: true,
    });
    return ok({ outcome });
  } catch (e) {
    reportError(e, {
      tags: { surface: "send_sms_from_lead" },
      extra: { propertyId },
    });
    return errFromUnknown(e, "SEND_SMS_FAILED");
  }
}

/**
 * Manual consent capture from the lead-detail composer. The operator
 * asserts they have written proof (a signed form or a screenshot of an
 * opt-in form submission) and records an `opt_in_marketing_written`
 * event. UI prompts for the source URL / description.
 */
async function captureConsent(params: {
  contactId: string;
  channel: ConsentChannel;
  eventType: ConsentEventType;
  source: string;
}): Promise<Result<null>> {
  try {
    const supabase = await createClient();
    await recordConsentEvent(supabase, params);
    return ok(null);
  } catch (e) {
    reportError(e, {
      tags: { surface: "capture_consent" },
      extra: { contactId: params.contactId },
    });
    return errFromUnknown(e, "CONSENT_CAPTURE_FAILED");
  }
}

// ============================================================================
// VA polish seams — Feature 1 (migration 010)
// Lead assignment · unread indicator · activity notes
// ============================================================================

export type TeamMember = {
  id: string;
  email: string;
};

/**
 * List authed team members for assignee pickers. Uses the admin client
 * because `auth.admin.listUsers()` requires service role, but we limit
 * the returned shape to {id, email} — no sign-in timestamps or metadata
 * leak through. Middleware already gates `/leads/**` behind auth, so any
 * caller reaching this action is already a trusted org member.
 */
export async function listOrgUsers(): Promise<Result<TeamMember[]>> {
  try {
    const supabase = await createClient();
    const {
      data: { user },
    } = await supabase.auth.getUser();
    if (!user) {
      return {
        ok: false,
        error: { code: "UNAUTHENTICATED", message: "Not signed in" },
      };
    }

    const { data: myMemberships, error: myMembershipsError } = await supabase
      .from("memberships")
      .select("org_id")
      .eq("user_id", user.id);
    if (myMembershipsError) {
      return {
        ok: false,
        error: {
          code: "TEAM_FETCH_FAILED",
          message: myMembershipsError.message,
        },
      };
    }

    const orgIds = Array.from(
      new Set((myMemberships ?? []).map((membership) => membership.org_id)),
    );
    if (orgIds.length === 0) return ok([]);

    const admin = createAdminClient();
    const { data: orgMemberships, error: orgMembershipsError } = await admin
      .from("memberships")
      .select("user_id")
      .in("org_id", orgIds);
    if (orgMembershipsError) {
      return {
        ok: false,
        error: {
          code: "TEAM_FETCH_FAILED",
          message: orgMembershipsError.message,
        },
      };
    }

    const memberIds = new Set(
      (orgMemberships ?? []).map((membership) => membership.user_id),
    );
    if (memberIds.size === 0) return ok([]);

    const users = await listAllAuthUsers(admin);
    if (!users.ok) return users;
    const members: TeamMember[] = users.data
      .filter((u) => memberIds.has(u.id) && !!u.email)
      .map((u) => ({ id: u.id, email: u.email as string }))
      .sort((a, b) => a.email.localeCompare(b.email));
    return ok(members);
  } catch (e) {
    reportError(e, { tags: { surface: "list_org_users" } });
    return errFromUnknown(e, "TEAM_FETCH_FAILED");
  }
}

type AuthUserPageUser = { id: string; email?: string | null };

async function listAllAuthUsers(
  admin: ReturnType<typeof createAdminClient>,
): Promise<Result<AuthUserPageUser[]>> {
  const users: AuthUserPageUser[] = [];
  let page = 1;
  const perPage = 200;

  while (true) {
    const { data, error } = await admin.auth.admin.listUsers({
      page,
      perPage,
    });
    if (error) {
      return {
        ok: false,
        error: { code: "TEAM_FETCH_FAILED", message: error.message },
      };
    }

    users.push(...((data?.users ?? []) as AuthUserPageUser[]));
    if (!data?.nextPage || data.users.length === 0) break;
    page = data.nextPage;
  }

  return ok(users);
}

/**
 * Assign (or unassign) a lead to a team member. `userId = null` clears
 * the assignment. Returns `{ ok: true }` on success regardless of
 * whether the value actually changed.
 */
export async function updateLeadAssignee(
  propertyId: string,
  userId: string | null,
): Promise<Result<null>> {
  try {
    const supabase = await createClient();
    const unlocked = await assertPropertyDncUnlocked(supabase, propertyId);
    if (!unlocked.ok) return unlocked;
    const assigneeValidation = await validateActiveAssigneeForProperties(
      supabase,
      [propertyId],
      userId,
    );
    if (!assigneeValidation.ok) {
      return {
        ok: false,
        error: {
          code: assigneeValidation.code,
          message: assigneeValidation.message,
        },
      };
    }
    const { data: current, error: lookupError } = await supabase
      .from("properties")
      .select("id, assigned_user_id")
      .eq("id", propertyId)
      .maybeSingle();
    if (lookupError) {
      return {
        ok: false,
        error: { code: "ASSIGNEE_FETCH_FAILED", message: lookupError.message },
      };
    }
    if (!current) {
      return {
        ok: false,
        error: { code: "LEAD_NOT_FOUND", message: "Lead not found." },
      };
    }
    if (current.assigned_user_id === userId) return ok(null);

    let update = supabase
      .from("properties")
      .update({
        assigned_user_id: userId,
        updated_at: new Date().toISOString(),
      })
      .eq("id", propertyId);
    update =
      current.assigned_user_id === null
        ? update.is("assigned_user_id", null)
        : update.eq("assigned_user_id", current.assigned_user_id);
    const { data: saved, error } = await update
      .select("id, assigned_user_id")
      .maybeSingle();
    if (error) {
      return {
        ok: false,
        error: { code: "ASSIGNEE_UPDATE_FAILED", message: error.message },
      };
    }
    if (!saved) {
      const { data: authoritative, error: reconcileError } = await supabase
        .from("properties")
        .select("assigned_user_id")
        .eq("id", propertyId)
        .maybeSingle();
      if (!reconcileError && authoritative?.assigned_user_id === userId) {
        return ok(null);
      }
      return {
        ok: false,
        error: {
          code: "ASSIGNEE_CONFLICT",
          message: "This lead changed before the assignment was saved.",
        },
      };
    }
    await recordLeadEvent({
      propertyId,
      ...(await getLeadEventActor(supabase)),
      eventType: LEAD_EVENT_TYPES.ASSIGNED,
      payload: { from: current.assigned_user_id, to: userId },
    });
    return ok(null);
  } catch (e) {
    reportError(e, {
      tags: { surface: "update_lead_assignee" },
      extra: { propertyId, userId },
    });
    return errFromUnknown(e, "ASSIGNEE_UPDATE_FAILED");
  }
}

/**
 * Mark all unread inbound messages for a property as read. Called from
 * the lead-detail server component on every page load so opening a lead
 * acknowledges the thread. Uses the partial index on
 * `(property_id, created_at desc) where direction='inbound' and read_at is null`.
 */
export async function markMessagesReadForProperty(
  propertyId: string,
): Promise<Result<null>> {
  try {
    const supabase = await createClient();
    const unlocked = await assertPropertyDncUnlocked(supabase, propertyId);
    if (!unlocked.ok) return unlocked;
    const { error } = await supabase
      .from("messages")
      .update({ read_at: new Date().toISOString() })
      .eq("property_id", propertyId)
      .eq("direction", "inbound")
      .is("read_at", null);
    if (error) {
      return {
        ok: false,
        error: { code: "MARK_READ_FAILED", message: error.message },
      };
    }
    return ok(null);
  } catch (e) {
    reportError(e, {
      tags: { surface: "mark_messages_read" },
      extra: { propertyId },
    });
    return errFromUnknown(e, "MARK_READ_FAILED");
  }
}

export async function markMessagesReadForThread(
  threadId: string,
): Promise<Result<null>> {
  try {
    // Thread identity is the conversation UUID since migration 081 —
    // callers pass canonical ids only (the page boundary translates any
    // stale URL format before this runs).
    const parsed = parseThreadId(threadId);
    if (parsed.kind !== "conversation") {
      return {
        ok: false,
        error: {
          code: "MARK_READ_FAILED",
          message: "mark-read requires a canonical conversation id.",
        },
      };
    }

    const supabase = await createClient();
    const conversationOrgId = await resolveSmsConversationOrg(
      supabase,
      parsed.conversationId,
    );
    if (!conversationOrgId) {
      return {
        ok: false,
        error: {
          code: "MARK_READ_FAILED",
          message: "Conversation was not found in an active organization.",
        },
      };
    }
    const { data: threadProperties, error: threadLookupError } = await supabase
      .from("messages")
      .select("property_id")
      .eq("channel", "sms")
      .eq("conversation_id", parsed.conversationId)
      .eq("org_id", conversationOrgId)
      .not("property_id", "is", null);
    if (threadLookupError) {
      return {
        ok: false,
        error: { code: "MARK_READ_FAILED", message: threadLookupError.message },
      };
    }
    const propertyIds = [
      ...new Set(
        (threadProperties ?? [])
          .map((message) => message.property_id)
          .filter((propertyId): propertyId is string => Boolean(propertyId)),
      ),
    ];
    for (const propertyId of propertyIds) {
      const unlocked = await assertPropertyDncUnlocked(supabase, propertyId);
      if (!unlocked.ok) return unlocked;
    }
    const { error } = await supabase
      .from("messages")
      .update({ read_at: new Date().toISOString() })
      .eq("channel", "sms")
      .eq("direction", "inbound")
      .is("read_at", null)
      .eq("conversation_id", parsed.conversationId)
      .eq("org_id", conversationOrgId);
    if (error) {
      return {
        ok: false,
        error: { code: "MARK_READ_FAILED", message: error.message },
      };
    }
    return ok(null);
  } catch (e) {
    reportError(e, {
      tags: { surface: "mark_messages_read_thread" },
      extra: { threadId },
    });
    return {
      ok: false,
      error: {
        code: "MARK_READ_FAILED",
        message: e instanceof Error ? e.message : "Unable to mark thread read.",
      },
    };
  }
}

/**
 * Append an activity note to a lead. Notes are authored by the current
 * session user; an unauthenticated call is rejected rather than producing
 * an orphan note. Realtime subscribers on `lead_notes` get the INSERT.
 */
export async function createLeadNote(
  propertyId: string,
  body: string,
): Promise<Result<{ id: string }>> {
  const trimmed = body.trim();
  if (!trimmed) {
    return {
      ok: false,
      error: { code: "EMPTY_BODY", message: "Note body is empty." },
    };
  }
  if (trimmed.length > 5000) {
    return {
      ok: false,
      error: {
        code: "BODY_TOO_LONG",
        message: `Note is ${trimmed.length} characters — cap is 5000.`,
      },
    };
  }

  try {
    const supabase = await createClient();
    const unlocked = await assertPropertyDncUnlocked(supabase, propertyId);
    if (!unlocked.ok) return unlocked;
    const {
      data: { user },
    } = await supabase.auth.getUser();
    if (!user) {
      return {
        ok: false,
        error: { code: "UNAUTHENTICATED", message: "Not signed in." },
      };
    }

    // Look up the property's org to stamp the note correctly. Every property
    // has an org_id (NOT NULL in schema) so this is never missing in practice.
    const { data: property, error: lookupErr } = await supabase
      .from("properties")
      .select("org_id")
      .eq("id", propertyId)
      .maybeSingle();
    if (lookupErr) {
      return {
        ok: false,
        error: { code: "LEAD_FETCH_FAILED", message: lookupErr.message },
      };
    }
    if (!property) {
      return {
        ok: false,
        error: { code: "LEAD_NOT_FOUND", message: "Lead not found." },
      };
    }

    const { data: inserted, error } = await supabase
      .from("lead_notes")
      .insert({
        org_id: property.org_id,
        property_id: propertyId,
        author_user_id: user.id,
        body: trimmed,
      })
      .select("id")
      .single();

    if (error) {
      return {
        ok: false,
        error: { code: "NOTE_CREATE_FAILED", message: error.message },
      };
    }
    return ok({ id: inserted.id });
  } catch (e) {
    reportError(e, {
      tags: { surface: "create_lead_note" },
      extra: { propertyId },
    });
    return errFromUnknown(e, "NOTE_CREATE_FAILED");
  }
}

// ============================================================================
// Template variable loading for the inline reply composer
// ============================================================================

/**
 * Load the template variable map for a lead so the inline reply composer
 * can render `{{first_name}}`, `{{property_address}}`, etc. into a
 * selected SMS template before the VA sends it.
 *
 * Wraps the shared `loadTemplateVars` from sequences — same variable
 * whitelist, same resolution logic. The only difference is that the
 * outbound sender persona is fixed rather than derived from the
 * current session user.
 */
export async function loadLeadVars(
  propertyId: string,
): Promise<Result<TemplateVars>> {
  try {
    const supabase = await createClient();

    // 1. Get the homeowner contact id from the property.
    const { data: property, error: propErr } = await supabase
      .from("properties")
      .select("homeowner_contact_id")
      .eq("id", propertyId)
      .maybeSingle();
    if (propErr) {
      return {
        ok: false,
        error: { code: "LEAD_FETCH_FAILED", message: propErr.message },
      };
    }
    if (!property) {
      return {
        ok: false,
        error: { code: "LEAD_NOT_FOUND", message: "Lead not found." },
      };
    }

    // 2. Delegate to the shared loader. Property / contact / organization
    //    reads run on the session client (RLS-scoped).
    const vars = await loadTemplateVars(supabase, {
      propertyId,
      contactId: property.homeowner_contact_id,
    });

    return ok(vars);
  } catch (e) {
    reportError(e, {
      tags: { surface: "load_lead_vars" },
      extra: { propertyId },
    });
    return errFromUnknown(e, "LOAD_LEAD_VARS_FAILED");
  }
}

export async function getPropertyNeighbors(
  propertyId: string,
  mode: "prospect" | "lead",
): Promise<{ prevId: string | null; nextId: string | null }> {
  const supabase = await createClient();

  const { data: current } = await supabase
    .from("properties")
    .select("created_at")
    .eq("id", propertyId)
    .is("deleted_at", null)
    .single();

  if (!current) return { prevId: null, nextId: null };

  let previousQuery = supabase
    .from("properties")
    .select("id")
    .is("deleted_at", null)
    .gt("created_at", current.created_at);
  let nextQuery = supabase
    .from("properties")
    .select("id")
    .is("deleted_at", null)
    .lt("created_at", current.created_at);
  if (mode === "prospect") {
    // Permanent DNC preserves the record's historical pipeline stage; it
    // does not move every locked record into Prospects. Keep neighbor
    // navigation inside the same historical collection as the current row.
    previousQuery = previousQuery.eq("status", "prospect");
    nextQuery = nextQuery.eq("status", "prospect");
  } else {
    previousQuery = previousQuery.neq("status", "prospect");
    nextQuery = nextQuery.neq("status", "prospect");
  }

  const [{ data: prevData }, { data: nextData }] = await Promise.all([
    previousQuery
      .order("created_at", { ascending: true })
      .limit(1)
      .maybeSingle(),
    nextQuery.order("created_at", { ascending: false }).limit(1).maybeSingle(),
  ]);

  return {
    prevId: prevData?.id ?? null,
    nextId: nextData?.id ?? null,
  };
}
