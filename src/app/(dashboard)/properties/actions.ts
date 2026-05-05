"use server";

import { createClient } from "@/lib/supabase/server";
import { errFromUnknown, ok, type Result } from "@/lib/errors/result";
import { reportError } from "@/lib/errors/report";
import { getConsentState } from "@/lib/messaging/consent";
import { sendSmsToContact } from "@/lib/messaging/send";
import { pickFromPool } from "@/lib/templates/pool";
import { loadTemplateVars } from "@/lib/sequences/template-vars";
import { renderTemplate } from "@/lib/sequences/render";

import { SELECT_ALL_HARD_CAP, type ParsedProspectsFilters } from "./prospects-query";

export async function listSmsTemplateCategories(): Promise<
  Result<{ category: string; count: number }[]>
> {
  try {
    const supabase = await createClient();
    const { data, error } = await supabase
      .from("sms_templates")
      .select("category")
      .is("deleted_at", null);
    if (error) {
      return { ok: false, error: { code: "LIST_CATEGORIES_FAILED", message: error.message } };
    }
    const counts = new Map<string, number>();
    for (const row of data ?? []) {
      counts.set(row.category, (counts.get(row.category) ?? 0) + 1);
    }
    return ok(
      Array.from(counts.entries())
        .sort(([a], [b]) => a.localeCompare(b))
        .map(([category, count]) => ({ category, count })),
    );
  } catch (e) {
    reportError(e, { tags: { surface: "list_sms_template_categories" } });
    return errFromUnknown(e, "LIST_CATEGORIES_FAILED");
  }
}

export type BulkSmsOutcome = {
  succeeded: number;
  skipped: number;
  failed: { propertyId: string; message: string }[];
};

/**
 * Queue a paced batch of outbound SMS messages for the given property IDs.
 *
 * Pre-filters opted-out contacts; everything else (quiet hours, phone
 * existence) is delegated to sendSmsToContact with queueOnly=true.
 * Consent + quiet-hours re-checks run at release time (cron drain).
 *
 * Pacing: the nth successfully queued message is scheduled
 * `n * paceSeconds` seconds after now so the cron drain releases them
 * at a controlled rate.
 */
export async function bulkQueueSms(
  propertyIds: string[],
  opts: {
    body?: string;
    templateCategory?: string;
    paceSeconds?: number;
    /**
     * When true, skip any property that already has at least one
     * outbound message — used by the Bulk SMS modal's "Skip prospects
     * already contacted (N)" checkbox so a re-run of an outreach
     * doesn't double-touch leads.
     */
    skipIfContacted?: boolean;
  },
): Promise<Result<BulkSmsOutcome>> {
  if (propertyIds.length === 0) {
    return ok({ succeeded: 0, skipped: 0, failed: [] });
  }

  try {
    const supabase = await createClient();
    const paceSeconds = opts.paceSeconds ?? 18;
    const now = Date.now();

    const { data: properties, error: propError } = await supabase
      .from("properties")
      .select("id, homeowner_contact_id, org_id")
      .in("id", propertyIds);

    if (propError) {
      return {
        ok: false,
        error: { code: "BULK_SMS_FAILED", message: propError.message },
      };
    }

    const propertyMap = new Map(
      (properties ?? []).map((p) => [p.id, p]),
    );

    let succeeded = 0;
    let skipped = 0;
    const failed: BulkSmsOutcome["failed"] = [];
    let queuedCount = 0;

    for (const propertyId of propertyIds) {
      const property = propertyMap.get(propertyId);
      if (!property || !property.homeowner_contact_id) {
        skipped++;
        continue;
      }

      if (opts.skipIfContacted) {
        const { data: prior } = await supabase
          .from("messages")
          .select("id")
          .eq("property_id", propertyId)
          .eq("direction", "outbound")
          .limit(1);
        if (prior && prior.length > 0) {
          skipped++;
          continue;
        }
      }

      const consentState = await getConsentState(
        supabase,
        property.homeowner_contact_id,
        "sms",
      );
      if (consentState === "opted_out") {
        skipped++;
        continue;
      }

      let body: string | null = null;
      if (opts.body) {
        body = opts.body;
      } else if (opts.templateCategory) {
        const template = await pickFromPool(
          supabase,
          property.org_id,
          opts.templateCategory,
          propertyId,
        );
        if (!template) {
          skipped++;
          continue;
        }
        const vars = await loadTemplateVars(supabase, {
          propertyId,
          contactId: property.homeowner_contact_id,
          enrolledByUserId: null,
        });
        body = renderTemplate(template.content, vars);
      }

      if (!body) {
        skipped++;
        continue;
      }

      const scheduledFor = new Date(now + queuedCount * paceSeconds * 1000);
      const outcome = await sendSmsToContact(supabase, {
        contactId: property.homeowner_contact_id,
        propertyId,
        body,
        queueOnly: true,
        scheduledFor,
      });

      if (outcome.status === "queued") {
        succeeded++;
        queuedCount++;
      } else if (
        outcome.status === "blocked_no_phone" ||
        outcome.status === "contact_not_found" ||
        outcome.status === "property_not_found" ||
        outcome.status === "blocked_no_consent"
      ) {
        skipped++;
      } else {
        const msg =
          "error" in outcome
            ? outcome.error
            : "reason" in outcome
              ? outcome.reason
              : outcome.status;
        failed.push({ propertyId, message: msg });
      }
    }

    return ok({ succeeded, skipped, failed });
  } catch (e) {
    reportError(e, { tags: { surface: "bulk_queue_sms" } });
    return errFromUnknown(e, "BULK_SMS_FAILED");
  }
}

/**
 * Return every property_id matching the current filter set on the
 * prospects page. Used by the "Select all N prospects across all pages"
 * affordance — the table fetches the full ID set once, expands its
 * client-side selection Set, and existing bulk actions (which already
 * accept arrays of IDs) work unchanged.
 *
 * Filter chain mirrors page.tsx:
 *   - status='prospect', deleted_at IS NULL  (always)
 *   - search → ILIKE on address
 *   - vacant=true → is_vacant=true
 *   - cass='verified' → cass_status='verified'
 *   - market → exact match
 *   - assignee → 'unassigned' sentinel OR uuid match
 *   - engagement='contacted' → property_ids whose latest message direction
 *     is 'outbound' (one extra messages roundtrip; same logic as page.tsx)
 *
 * Result is capped at SELECT_ALL_HARD_CAP rows so a runaway "select-all 50K"
 * can't accidentally torch skip-trace credits via a downstream bulk action.
 */
export async function getAllMatchingProspectIds(args: {
  search: string | null;
  filters: ParsedProspectsFilters;
}): Promise<Result<string[]>> {
  try {
    const supabase = await createClient();

    let engagementFilteredIds: string[] | null = null;
    if (args.filters.engagement === "contacted") {
      const { data: msgRows } = await supabase
        .from("messages")
        .select("property_id, direction, created_at")
        .not("property_id", "is", null)
        .order("created_at", { ascending: false });
      const seen = new Set<string>();
      const matched = new Set<string>();
      for (const m of msgRows ?? []) {
        if (!m.property_id || seen.has(m.property_id)) continue;
        seen.add(m.property_id);
        if (m.direction === "outbound") matched.add(m.property_id);
      }
      engagementFilteredIds =
        matched.size === 0 ? ["__no_match__"] : Array.from(matched);
    }

    let query = supabase
      .from("properties")
      .select("id")
      .eq("status", "prospect")
      .is("deleted_at", null);

    if (args.search) {
      query = query.ilike("address", `%${args.search}%`);
    }
    if (args.filters.vacant) {
      query = query.eq("is_vacant", true);
    }
    if (args.filters.cass === "verified") {
      query = query.eq("cass_status", "verified");
    }
    if (args.filters.market) {
      query = query.eq("market", args.filters.market);
    }
    if (args.filters.assignee === "unassigned") {
      query = query.is("assigned_user_id", null);
    } else if (args.filters.assignee) {
      query = query.eq("assigned_user_id", args.filters.assignee);
    }
    if (engagementFilteredIds) {
      query = query.in("id", engagementFilteredIds);
    }

    const { data, error } = await query.limit(SELECT_ALL_HARD_CAP);

    if (error) {
      return {
        ok: false,
        error: { code: "SELECT_ALL_FAILED", message: error.message },
      };
    }

    return ok((data ?? []).map((r) => r.id));
  } catch (e) {
    reportError(e, { tags: { surface: "get_all_matching_prospect_ids" } });
    return errFromUnknown(e, "SELECT_ALL_FAILED");
  }
}

/**
 * Count distinct properties (in `propertyIds`) that already have at least
 * one outbound message — fuels the Bulk SMS modal's
 * "Skip prospects already contacted (N)" checkbox label so the operator
 * sees how many leads will be excluded before they queue.
 *
 * Empty input short-circuits to ok(0) without a DB roundtrip.
 */
export async function countAlreadyContacted(
  propertyIds: string[],
): Promise<Result<number>> {
  if (propertyIds.length === 0) return ok(0);
  try {
    const supabase = await createClient();
    const { data, error } = await supabase
      .from("messages")
      .select("property_id")
      .in("property_id", propertyIds)
      .eq("direction", "outbound");
    if (error) {
      return {
        ok: false,
        error: { code: "COUNT_CONTACTED_FAILED", message: error.message },
      };
    }
    const distinct = new Set(
      (data ?? [])
        .map((r) => r.property_id)
        .filter((v): v is string => typeof v === "string"),
    );
    return ok(distinct.size);
  } catch (e) {
    reportError(e, { tags: { surface: "count_already_contacted" } });
    return errFromUnknown(e, "COUNT_CONTACTED_FAILED");
  }
}
