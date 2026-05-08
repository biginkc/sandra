"use server";

import { createClient } from "@/lib/supabase/server";
import { createAdminClient } from "@/lib/supabase/admin";
import { errFromUnknown, ok, type Result } from "@/lib/errors/result";
import { reportError } from "@/lib/errors/report";
import { getConsentState } from "@/lib/messaging/consent";
import { sendSmsToContact } from "@/lib/messaging/send";
import { pickFromPool } from "@/lib/templates/pool";
import { loadTemplateVars } from "@/lib/sequences/template-vars";
import { renderTemplate } from "@/lib/sequences/render";

import { applyFilters } from "@/lib/prospects/filter-to-supabase";
import type { FilterBlock } from "@/lib/prospects/filter-schema";

import { SELECT_ALL_HARD_CAP } from "./prospects-query";

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
 * Anchor a timestamp at "the following PT calendar day's 8 AM, local PT".
 * Used by bulkQueueSms's daily-cap rollover so overflow lands at the
 * start of the recipient-local sending window (8 AM PT covers all of
 * Jarrad's markets — KC + TX — without jumping earlier than 10 AM CT).
 *
 * Always advances exactly one PT calendar day from the input's PT date,
 * then anchors at 08:00 PT. Caller passes the current bucket start;
 * helper returns the next bucket start.
 *
 * Acceptable simplification: the anchor uses a fixed -08:00 PT offset
 * (08:00 PT == 16:00 UTC). During DST (PT = -07:00) the anchor lands at
 * 9 AM PT instead of 8 AM, which is still inside the federal 8 AM – 9 PM
 * window and still inside the recipient-local window for KC/TX. The
 * drift is intentional.
 */
function nextDayEightAmPT(afterMs: number): number {
  const fmt = new Intl.DateTimeFormat("en-US", {
    timeZone: "America/Los_Angeles",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  });
  const parts = fmt.formatToParts(new Date(afterMs));
  const get = (t: string) => parts.find((p) => p.type === t)!.value;
  const ptYear = Number(get("year"));
  const ptMonth = Number(get("month"));
  const ptDay = Number(get("day"));
  // Next PT calendar day 08:00 PT == 16:00 UTC at -08:00 offset.
  const tomorrow = new Date(
    Date.UTC(ptYear, ptMonth - 1, ptDay + 1, 16, 0, 0),
  );
  return tomorrow.getTime();
}

/**
 * Queue a paced batch of outbound SMS messages for the given property IDs.
 *
 * Pre-filters opted-out contacts; everything else (quiet hours, phone
 * existence) is delegated to sendSmsToContact with queueOnly=true.
 * Consent + quiet-hours re-checks run at release time (cron drain).
 *
 * Pacing: each successfully queued message is scheduled
 * `paceSeconds` seconds after the previous one (with optional jitter)
 * so the cron drain releases them at a controlled rate.
 *
 * Daily cap: if `dailyCap` is set, only that many messages schedule
 * within a single 24h bucket; messages 1,001+ (etc.) defer to the start
 * of the next day's recipient-local sending window — 8 AM PT, which
 * covers all of Jarrad's markets (KC + TX) without going earlier than
 * 10 AM CT. When `dailyCap` is undefined, behavior is unchanged from
 * the original spec (no rollover, single deterministic ramp).
 *
 * Jitter: when `jitterPct > 0` (modal default 0.20), each gap between
 * consecutive scheduled_for values is multiplied by `1 + (rand*2-1)*jitterPct`
 * so mechanical-looking send patterns don't trip carrier spam-detection.
 * The first message of each daily bucket is unjittered (anchor at bucket
 * start) to keep tests + observability deterministic.
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
    /**
     * Max messages scheduled within a single 24h bucket per send. When
     * the cap is hit, subsequent messages roll over to next day 8 AM PT.
     * Undefined = no cap (original behavior).
     */
    dailyCap?: number;
    /**
     * 0..1; defaults to 0 so existing deterministic-spacing callers
     * (and the test suite) stay byte-for-byte compatible. The modal
     * passes 0.20 for all four presets.
     */
    jitterPct?: number;
  },
): Promise<Result<BulkSmsOutcome>> {
  if (propertyIds.length === 0) {
    return ok({ succeeded: 0, skipped: 0, failed: [] });
  }

  try {
    const supabase = await createClient();
    const paceSeconds = opts.paceSeconds ?? 18;
    const jitterPct = opts.jitterPct ?? 0;
    const dailyCap = opts.dailyCap;
    const now = Date.now();

    // Resolve the current session user once so {{my_first_name}} renders
    // for every property in the batch. Without this, templates referencing
    // the sender token produced bodies like "Andrew,  here." (canceled in
    // prod 2026-05-05). Admin client is needed by the resolver to call
    // auth.admin.getUserById on the lookup; the WR-02 split keeps the
    // RLS-scoped reads on the session client.
    const {
      data: { user },
    } = await supabase.auth.getUser();
    const enrolledByUserId = user?.id ?? null;
    const adminClient = createAdminClient();

    // Fetch properties in chunks — Supabase PostgREST rejects large IN clauses
    // (URL length limit, ~8 KB) so we split into batches of 250.
    const CHUNK = 250;
    const allProperties: { id: string; homeowner_contact_id: string | null; org_id: string | null }[] = [];
    for (let i = 0; i < propertyIds.length; i += CHUNK) {
      const chunk = propertyIds.slice(i, i + CHUNK);
      const { data, error: propError } = await supabase
        .from("properties")
        .select("id, homeowner_contact_id, org_id")
        .in("id", chunk);
      if (propError) {
        return {
          ok: false,
          error: { code: "BULK_SMS_FAILED", message: propError.message },
        };
      }
      if (data) allProperties.push(...data);
    }

    const propertyMap = new Map(
      allProperties.map((p) => [p.id, p]),
    );

    // Prefetch all already-contacted property IDs in one batched query so the
    // per-property loop doesn't fire N individual round-trips.
    const contactedSet = new Set<string>();
    if (opts.skipIfContacted) {
      for (let i = 0; i < propertyIds.length; i += CHUNK) {
        const chunk = propertyIds.slice(i, i + CHUNK);
        const { data } = await supabase
          .from("messages")
          .select("property_id")
          .in("property_id", chunk)
          .eq("direction", "outbound");
        data?.forEach((r) => { if (r.property_id) contactedSet.add(r.property_id); });
      }
    }

    let succeeded = 0;
    let skipped = 0;
    const failed: BulkSmsOutcome["failed"] = [];
    // Daily-cap bucket state. The first queued message of each bucket
    // anchors at `dayBucketStartMs` (no jitter). Each subsequent queue
    // adds `paceSeconds * 1000` to `cumulativeOffsetMs` and rolls a
    // ±jitterPct multiplier on the gap.
    let cumulativeOffsetMs = 0;
    let dayBucketStartMs = now;
    let dayBucketCount = 0;

    for (const propertyId of propertyIds) {
      const property = propertyMap.get(propertyId);
      if (!property || !property.homeowner_contact_id) {
        skipped++;
        continue;
      }

      if (opts.skipIfContacted && contactedSet.has(propertyId)) {
        skipped++;
        continue;
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
        if (!property.org_id) { skipped++; continue; }
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
        const vars = await loadTemplateVars(
          supabase,
          {
            propertyId,
            contactId: property.homeowner_contact_id,
            enrolledByUserId,
          },
          adminClient,
        );
        body = renderTemplate(template.content, vars);
      }

      if (!body) {
        skipped++;
        continue;
      }

      // Roll over to next day's 8 AM PT bucket if we've hit the daily cap.
      if (dailyCap !== undefined && dayBucketCount >= dailyCap) {
        dayBucketStartMs = nextDayEightAmPT(dayBucketStartMs);
        dayBucketCount = 0;
        cumulativeOffsetMs = 0;
      }
      // Compute the candidate next-offset so we can write `scheduledFor`,
      // but only COMMIT the advance (and jitter) on a successful queue.
      // This way a downstream skip (no_phone, blocked_no_consent re-check)
      // doesn't burn a slot and stretch the next message's gap past the
      // ±jitterPct bound.
      //
      // The first message of each bucket anchors at the bucket start
      // exactly (no jitter) so observability is clean and tests are
      // deterministic; subsequent messages jitter the GAP between
      // consecutive scheduled_for values within ±jitterPct of pace.
      let nextOffsetMs = cumulativeOffsetMs;
      if (dayBucketCount > 0) {
        const jitterMs =
          (Math.random() * 2 - 1) * paceSeconds * 1000 * jitterPct;
        nextOffsetMs = cumulativeOffsetMs + paceSeconds * 1000 + jitterMs;
      }
      const scheduledFor = new Date(dayBucketStartMs + nextOffsetMs);
      const outcome = await sendSmsToContact(supabase, {
        contactId: property.homeowner_contact_id,
        propertyId,
        body,
        queueOnly: true,
        scheduledFor,
      });

      if (outcome.status === "queued") {
        succeeded++;
        cumulativeOffsetMs = nextOffsetMs;
        dayBucketCount += 1;
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
 * affordance (R9) — the table fetches the full ID set once, expands its
 * client-side selection Set, and existing bulk actions (which already
 * accept arrays of IDs) work unchanged.
 *
 * Plan 09: signature migrated to accept the v1 block stack instead of the
 * legacy 5-chip ParsedProspectsFilters. Filter chain mirrors page.tsx:
 *   - .is("deleted_at", null)                            (always)
 *   - .eq("status", "prospect") UNLESS the stack contains a
 *     pipeline_status block (in which case that block's values fully
 *     define the active status set — same rule as page.tsx)
 *   - search → ILIKE on address
 *   - applyFilters(query, blockStack, supabase)          (Plan 04 translator)
 *
 * Result is capped at SELECT_ALL_HARD_CAP rows so a runaway "select-all 50K"
 * can't accidentally torch skip-trace credits via a downstream bulk action.
 */
export async function getAllMatchingProspectIds(args: {
  search: string | null;
  blockStack: FilterBlock[];
}): Promise<Result<string[]>> {
  try {
    const supabase = await createClient();

    const hasPipelineStatusBlock = args.blockStack.some(
      (b) => b.kind === "pipeline_status",
    );

    let query = supabase
      .from("properties")
      .select("id")
      .is("deleted_at", null);
    if (!hasPipelineStatusBlock) {
      query = query.eq("status", "prospect");
    }

    if (args.search) {
      query = query.ilike("address", `%${args.search}%`);
    }

    // Plan 04 translator — same SQL chain the page renders against. Any
    // engagement / vacancy / cass / market / assignee / list / tag /
    // motivation_level / equity_pct / etc. is applied here, not duplicated.
    query = await applyFilters(query, args.blockStack, supabase);

    // PostgREST silently caps results at 1 000 rows (db-max-rows default).
    // Paginate with .range() until a page comes back short to collect all IDs.
    const PAGE = 1000;
    const allIds: string[] = [];
    for (let from = 0; from < SELECT_ALL_HARD_CAP; from += PAGE) {
      const { data, error } = await query.range(from, from + PAGE - 1);
      if (error) {
        return {
          ok: false,
          error: { code: "SELECT_ALL_FAILED", message: error.message },
        };
      }
      const page = (data ?? []).map((r) => r.id);
      allIds.push(...page);
      if (page.length < PAGE) break;
    }

    return ok(allIds);
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
    const CHUNK = 250;
    const distinct = new Set<string>();
    for (let i = 0; i < propertyIds.length; i += CHUNK) {
      const chunk = propertyIds.slice(i, i + CHUNK);
      const { data, error } = await supabase
        .from("messages")
        .select("property_id")
        .in("property_id", chunk)
        .eq("direction", "outbound");
      if (error) {
        return {
          ok: false,
          error: { code: "COUNT_CONTACTED_FAILED", message: error.message },
        };
      }
      (data ?? [])
        .map((r) => r.property_id)
        .filter((v): v is string => typeof v === "string")
        .forEach((v) => distinct.add(v));
    }
    return ok(distinct.size);
  } catch (e) {
    reportError(e, { tags: { surface: "count_already_contacted" } });
    return errFromUnknown(e, "COUNT_CONTACTED_FAILED");
  }
}
