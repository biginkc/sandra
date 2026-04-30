"use server";

import { after } from "next/server";

import { isAdminEmail } from "@/lib/auth/allowlist";
import { runCassEnrichment } from "@/lib/enrichment/cass-job";
import { createAdminClient } from "@/lib/supabase/admin";
import { createClient } from "@/lib/supabase/server";
import { errFromUnknown, ok, type Result } from "@/lib/errors/result";
import { reportError } from "@/lib/errors/report";
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
import { dispatchPropertyAssigned } from "@/lib/notifications/dispatch";
import type { Database } from "@/lib/supabase/types";
import { loadTemplateVars } from "@/lib/sequences/template-vars";
import type { TemplateVars } from "@/lib/templates/render";

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

type ContactRow = Database["public"]["Tables"]["contacts"]["Row"];
type HomeownerDetailsRow =
  Database["public"]["Tables"]["homeowner_details"]["Row"];
type AgentDetailsRow = Database["public"]["Tables"]["agent_details"]["Row"];
type PropertyRow = Database["public"]["Tables"]["properties"]["Row"];

export type DetailedLead = PropertyRow & {
  homeowner: (ContactRow & { homeowner_details: HomeownerDetailsRow | null }) | null;
  agent: (ContactRow & { agent_details: AgentDetailsRow | null }) | null;
};

export async function getLeadDetail(
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
           homeowner_details(*)
         ),
         agent:contacts!properties_agent_contact_id_fkey(
           *,
           agent_details(*)
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
    const outcome = await verifyPropertyAddress(supabase, propertyId);

    switch (outcome.status) {
      case "verified":
      case "stored_with_status":
        return ok({
          cassStatus: outcome.verified.cassStatus,
          standardized: outcome.verified.standardized,
          isVacant: outcome.verified.isVacant ?? null,
          cacheHit: outcome.cacheHit,
        });
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
    const { error } = await supabase
      .from("properties")
      .update({
        motivation_level: level,
        updated_at: new Date().toISOString(),
      })
      .eq("id", propertyId);

    if (error) {
      return {
        ok: false,
        error: { code: "MOTIVATION_UPDATE_FAILED", message: error.message },
      };
    }
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
export async function qualifyLead(
  propertyId: string,
  qualifier: string | null = null,
): Promise<Result<{ alreadyQualified: boolean }>> {
  try {
    const supabase = await createClient();

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
export async function qualifyLeadsBulk(
  propertyIds: string[],
): Promise<
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
    const { error } = await supabase
      .from("properties")
      .update({
        status: "prospect",
        qualified_at: null,
        qualified_by: null,
        updated_at: nowIso,
      })
      .eq("id", propertyId);
    if (error) {
      return {
        ok: false,
        error: { code: "REVERT_FAILED", message: error.message },
      };
    }
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

export async function assignLeadsBulk(
  propertyIds: string[],
  userId: string | null,
): Promise<Result<BulkOutcome>> {
  if (propertyIds.length === 0) {
    return ok({ succeeded: 0, skipped: 0, failed: [] });
  }
  try {
    const supabase = await createClient();
    const {
      data: { user },
    } = await supabase.auth.getUser();
    const { error } = await supabase
      .from("properties")
      .update({
        assigned_user_id: userId,
        updated_at: new Date().toISOString(),
      })
      .in("id", propertyIds);
    if (error) {
      return {
        ok: false,
        error: { code: "ASSIGN_BULK_FAILED", message: error.message },
      };
    }

    // Feature 7 — fire property_assigned notifications. Best-effort:
    // dispatch swallows errors internally, and we catch anything that
    // bubbles so a notification hiccup never fails the assignment.
    try {
      await dispatchPropertyAssigned(supabase, {
        propertyIds,
        newAssigneeId: userId,
        actorId: user?.id ?? null,
        assignerName: user?.email?.split("@")[0] ?? null,
      });
    } catch (e) {
      reportError(e, {
        tags: { surface: "assign_leads_bulk_notification_dispatch" },
        extra: { count: propertyIds.length },
      });
    }

    return ok({ succeeded: propertyIds.length, skipped: 0, failed: [] });
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
    // Look up org_ids so we satisfy property_lists.org_id NOT NULL. Every
    // property has an org; the query scopes to the ids we got, so RLS
    // already filtered out cross-org rows if any.
    const { data: props, error: lookupErr } = await supabase
      .from("properties")
      .select("id, org_id")
      .in("id", propertyIds);
    if (lookupErr) {
      return {
        ok: false,
        error: { code: "ADD_TO_LIST_FAILED", message: lookupErr.message },
      };
    }
    const foundIds = new Set((props ?? []).map((p) => p.id));
    const failed: BulkOutcome["failed"] = [];
    for (const id of propertyIds) {
      if (!foundIds.has(id)) {
        failed.push({ propertyId: id, message: "Property not found" });
      }
    }

    const {
      data: { user },
    } = await supabase.auth.getUser();
    const nowIso = new Date().toISOString();
    const rows = (props ?? []).map((p) => ({
      org_id: p.org_id,
      property_id: p.id,
      list_id: listId,
      last_added_at: nowIso,
      last_added_by: user?.id ?? null,
    }));
    if (rows.length > 0) {
      const { error } = await supabase
        .from("property_lists")
        .upsert(rows, {
          onConflict: "property_id,list_id",
          ignoreDuplicates: false,
        });
      if (error) {
        return {
          ok: false,
          error: { code: "ADD_TO_LIST_FAILED", message: error.message },
        };
      }
    }
    return ok({
      succeeded: rows.length,
      skipped: 0,
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
    const { error, count } = await supabase
      .from("property_lists")
      .delete({ count: "exact" })
      .eq("list_id", listId)
      .in("property_id", propertyIds);
    if (error) {
      return {
        ok: false,
        error: { code: "REMOVE_FROM_LIST_FAILED", message: error.message },
      };
    }
    const succeeded = count ?? 0;
    return ok({
      succeeded,
      skipped: propertyIds.length - succeeded,
      failed: [],
    });
  } catch (e) {
    reportError(e, {
      tags: { surface: "remove_properties_from_list_bulk" },
      extra: { count: propertyIds.length, listId },
    });
    return errFromUnknown(e, "REMOVE_FROM_LIST_FAILED");
  }
}

export async function applyTagBulk(
  propertyIds: string[],
  tagId: string,
): Promise<Result<BulkOutcome>> {
  if (propertyIds.length === 0) {
    return ok({ succeeded: 0, skipped: 0, failed: [] });
  }
  try {
    const supabase = await createClient();
    const { data: tag, error: tagErr } = await supabase
      .from("tags")
      .select("category, system_managed")
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

    const { data: props, error: lookupErr } = await supabase
      .from("properties")
      .select("id, org_id")
      .in("id", propertyIds);
    if (lookupErr) {
      return {
        ok: false,
        error: { code: "APPLY_TAG_FAILED", message: lookupErr.message },
      };
    }
    const foundIds = new Set((props ?? []).map((p) => p.id));
    const failed: BulkOutcome["failed"] = propertyIds
      .filter((id) => !foundIds.has(id))
      .map((id) => ({ propertyId: id, message: "Property not found" }));

    const {
      data: { user },
    } = await supabase.auth.getUser();
    const rows = (props ?? []).map((p) => ({
      org_id: p.org_id,
      property_id: p.id,
      tag_id: tagId,
      applied_by: user?.id ?? null,
      source: "manual",
    }));
    if (rows.length > 0) {
      const { error } = await supabase.from("property_tags").upsert(rows, {
        onConflict: "property_id,tag_id",
        ignoreDuplicates: true,
      });
      if (error) {
        return {
          ok: false,
          error: { code: "APPLY_TAG_FAILED", message: error.message },
        };
      }
    }
    return ok({ succeeded: rows.length, skipped: 0, failed });
  } catch (e) {
    reportError(e, {
      tags: { surface: "apply_tag_bulk" },
      extra: { count: propertyIds.length, tagId },
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
      .in("id", propertyIds)
      .is("deleted_at", null);
    if (error) {
      return {
        ok: false,
        error: { code: "DELETE_FAILED", message: error.message },
      };
    }
    return ok({ succeeded: propertyIds.length, skipped: 0, failed: [] });
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
    const {
      data: { user },
    } = await supabase.auth.getUser();

    const { data: job, error } = await supabase
      .from("jobs")
      .insert({
        type: "cass_dsf2_ncoa",
        status: "queued",
        created_by: user?.id ?? null,
        total_items: propertyIds.length,
        title: `CASS verify ${propertyIds.length} propert${propertyIds.length === 1 ? "y" : "ies"}`,
        description: "Bulk verify from /properties",
        provider: "smartystreets",
        input_params: { property_ids: propertyIds },
      })
      .select("id")
      .single();
    if (error || !job) {
      return {
        ok: false,
        error: {
          code: "VERIFY_JOB_CREATE_FAILED",
          message: error?.message ?? "Job creation failed",
        },
      };
    }

    after(async () => {
      try {
        // Re-create a fresh server client inside `after()` — the outer
        // request's connection may already be closed by the time the
        // background callback runs.
        const bgClient = await createClient();
        await runCassEnrichment(bgClient, {
          jobId: job.id,
          propertyIds,
        });
      } catch (e) {
        reportError(e, {
          tags: { surface: "verify_properties_bulk_background" },
          extra: { jobId: job.id, count: propertyIds.length },
        });
      }
    });

    return ok({ jobId: job.id });
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
): Promise<Result<null>> {
  if (!VALID_STATUSES.includes(status)) {
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
    const { error } = await supabase
      .from("properties")
      .update({ status, updated_at: new Date().toISOString() })
      .eq("id", propertyId);

    if (error) {
      return {
        ok: false,
        error: {
          code: "STATUS_UPDATE_FAILED",
          message: error.message,
        },
      };
    }

    return ok(null);
  } catch (e) {
    reportError(e, {
      tags: { surface: "update_property_status" },
      extra: { propertyId, status },
    });
    return errFromUnknown(e, "STATUS_UPDATE_FAILED");
  }
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
      contactId: property.homeowner_contact_id,
      propertyId,
      body: trimmed,
      from: from ?? undefined,
      queueOnly: queueOnly ?? false,
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
export async function captureConsent(params: {
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
    const admin = createAdminClient();
    const { data, error } = await admin.auth.admin.listUsers({ perPage: 200 });
    if (error) {
      return {
        ok: false,
        error: { code: "TEAM_FETCH_FAILED", message: error.message },
      };
    }
    const members: TeamMember[] = (data?.users ?? [])
      .filter((u) => !!u.email)
      .map((u) => ({ id: u.id, email: u.email as string }))
      .sort((a, b) => a.email.localeCompare(b.email));
    return ok(members);
  } catch (e) {
    reportError(e, { tags: { surface: "list_org_users" } });
    return errFromUnknown(e, "TEAM_FETCH_FAILED");
  }
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
    const { error } = await supabase
      .from("properties")
      .update({
        assigned_user_id: userId,
        updated_at: new Date().toISOString(),
      })
      .eq("id", propertyId);
    if (error) {
      return {
        ok: false,
        error: { code: "ASSIGNEE_UPDATE_FAILED", message: error.message },
      };
    }
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
 * "enrolled by" user (which populates `{{my_first_name}}`) is the
 * current session user rather than a sequence enrollment author.
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

    // 2. Resolve the current user for {{my_first_name}}.
    const {
      data: { user },
    } = await supabase.auth.getUser();

    // 3. Delegate to the shared loader. Property / contact / organization
    //    reads run on the session client (RLS-scoped); the admin client is
    //    only handed to the user-id → first-name resolver, which needs
    //    `auth.admin.getUserById`. This narrows the service-role surface
    //    so a future RLS tightening on `properties` / `contacts` /
    //    `organizations` is not silently bypassed here (WR-02).
    const adminClient = createAdminClient();
    const vars = await loadTemplateVars(
      supabase,
      {
        propertyId,
        contactId: property.homeowner_contact_id,
        enrolledByUserId: user?.id ?? null,
      },
      adminClient,
    );

    return ok(vars);
  } catch (e) {
    reportError(e, {
      tags: { surface: "load_lead_vars" },
      extra: { propertyId },
    });
    return errFromUnknown(e, "LOAD_LEAD_VARS_FAILED");
  }
}
