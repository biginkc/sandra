/**
 * Bulk SMS queueing core — the per-property loop shared by the
 * synchronous server-action path (small selections) and the bulk-sms
 * workflow (large selections, chunked across invocations).
 *
 * Extracted verbatim from properties/actions.ts bulkQueueSms on
 * 2026-06-11 so a 9K-row selection no longer runs the whole loop in one
 * serverless invocation (5-minute ceiling — the same failure class fixed
 * for CASS in #240 and skip-trace in #241). Scheduling math, skip rules,
 * and template behavior are unchanged; the integration suite pins them.
 */

import type { SupabaseClient } from "@supabase/supabase-js";

import { getConsentState } from "@/lib/messaging/consent";
import { sendSmsToContact } from "@/lib/messaging/send";
import { pickFromPool } from "@/lib/templates/pool";
import { loadTemplateVars } from "@/lib/sequences/template-vars";
import { renderTemplate } from "@/lib/sequences/render";
import type { Database } from "@/lib/supabase/types";

export type BulkSmsQueueOpts = {
  body?: string;
  templateCategory?: string;
  paceSeconds?: number;
  skipIfContacted?: boolean;
  dailyCap?: number;
  jitterPct?: number;
};

/**
 * Pacing/bucket state threaded across chunks so a workflow-chunked run
 * schedules identically to one long loop. Counters ride along so the
 * job row can report cumulative progress.
 */
export type BulkSmsScheduleState = {
  cumulativeOffsetMs: number;
  dayBucketStartMs: number;
  dayBucketCount: number;
  succeeded: number;
  skipped: number;
  failed: { propertyId: string; message: string }[];
};

export function freshScheduleState(anchorMs: number): BulkSmsScheduleState {
  return {
    cumulativeOffsetMs: 0,
    dayBucketStartMs: anchorMs,
    dayBucketCount: 0,
    succeeded: 0,
    skipped: 0,
    failed: [],
  };
}

/**
 * Anchor a timestamp at "the following PT calendar day's 8 AM, local PT".
 * Used by the daily-cap rollover so overflow lands at the start of the
 * recipient-local sending window (8 AM PT covers all of Jarrad's markets
 * — KC + TX — without jumping earlier than 10 AM CT).
 *
 * Acceptable simplification: the anchor uses a fixed -08:00 PT offset
 * (08:00 PT == 16:00 UTC). During DST (PT = -07:00) the anchor lands at
 * 9 AM PT instead of 8 AM, which is still inside the federal 8 AM – 9 PM
 * window and still inside the recipient-local window for KC/TX. The
 * drift is intentional.
 */
export function nextDayEightAmPT(afterMs: number): number {
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
 * Queue one batch of property IDs. `client` is the caller's Supabase
 * client — the session client on the synchronous action path (RLS
 * applies), the admin client on the workflow path (matches the cron
 * releaser's privilege level). `adminClient` is always the admin client
 * (template-var resolution needs auth.admin lookups).
 *
 * Mutates nothing outside the DB; returns the updated schedule state so
 * chunked callers thread it into the next call.
 */
export async function queueSmsBatch(
  client: SupabaseClient<Database>,
  adminClient: SupabaseClient<Database>,
  args: {
    propertyIds: string[];
    opts: BulkSmsQueueOpts;
    enrolledByUserId: string | null;
    state: BulkSmsScheduleState;
  },
): Promise<BulkSmsScheduleState> {
  const { opts, state } = args;
  const paceSeconds = opts.paceSeconds ?? 18;
  const jitterPct = opts.jitterPct ?? 0;
  const dailyCap = opts.dailyCap;

  // Fetch properties in chunks — Supabase PostgREST rejects large IN
  // clauses (URL length limit, ~8 KB) so we split into batches of 250.
  const CHUNK = 250;
  const allProperties: {
    id: string;
    homeowner_contact_id: string | null;
    org_id: string | null;
  }[] = [];
  for (let i = 0; i < args.propertyIds.length; i += CHUNK) {
    const chunk = args.propertyIds.slice(i, i + CHUNK);
    const { data, error: propError } = await client
      .from("properties")
      .select("id, homeowner_contact_id, org_id")
      .in("id", chunk);
    if (propError) {
      throw new Error(`bulk sms property fetch: ${propError.message}`);
    }
    if (data) allProperties.push(...data);
  }

  const propertyMap = new Map(allProperties.map((p) => [p.id, p]));

  // Prefetch already-contacted property IDs in batched queries so the
  // per-property loop doesn't fire N individual round-trips.
  const contactedSet = new Set<string>();
  if (opts.skipIfContacted) {
    for (let i = 0; i < args.propertyIds.length; i += CHUNK) {
      const chunk = args.propertyIds.slice(i, i + CHUNK);
      const { data } = await client
        .from("messages")
        .select("property_id")
        .in("property_id", chunk)
        .eq("direction", "outbound");
      data?.forEach((r) => {
        if (r.property_id) contactedSet.add(r.property_id);
      });
    }
  }

  for (const propertyId of args.propertyIds) {
    const property = propertyMap.get(propertyId);
    if (!property || !property.homeowner_contact_id) {
      state.skipped++;
      continue;
    }

    if (opts.skipIfContacted && contactedSet.has(propertyId)) {
      state.skipped++;
      continue;
    }

    const consentState = await getConsentState(
      client,
      property.homeowner_contact_id,
      "sms",
    );
    if (consentState === "opted_out") {
      state.skipped++;
      continue;
    }

    let body: string | null = null;
    if (opts.body) {
      body = opts.body;
    } else if (opts.templateCategory) {
      if (!property.org_id) {
        state.skipped++;
        continue;
      }
      const template = await pickFromPool(
        client,
        property.org_id,
        opts.templateCategory,
        propertyId,
      );
      if (!template) {
        state.skipped++;
        continue;
      }
      const vars = await loadTemplateVars(
        client,
        {
          propertyId,
          contactId: property.homeowner_contact_id,
          enrolledByUserId: args.enrolledByUserId,
        },
        adminClient,
      );
      body = renderTemplate(template.content, vars);
    }

    if (!body) {
      state.skipped++;
      continue;
    }

    // Roll over to next day's 8 AM PT bucket if we've hit the daily cap.
    if (dailyCap !== undefined && state.dayBucketCount >= dailyCap) {
      state.dayBucketStartMs = nextDayEightAmPT(state.dayBucketStartMs);
      state.dayBucketCount = 0;
      state.cumulativeOffsetMs = 0;
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
    let nextOffsetMs = state.cumulativeOffsetMs;
    if (state.dayBucketCount > 0) {
      const jitterMs =
        (Math.random() * 2 - 1) * paceSeconds * 1000 * jitterPct;
      nextOffsetMs = state.cumulativeOffsetMs + paceSeconds * 1000 + jitterMs;
    }
    const scheduledFor = new Date(state.dayBucketStartMs + nextOffsetMs);
    const outcome = await sendSmsToContact(client, {
      contactId: property.homeowner_contact_id,
      propertyId,
      body,
      queueOnly: true,
      scheduledFor,
    });

    if (outcome.status === "queued") {
      state.succeeded++;
      state.cumulativeOffsetMs = nextOffsetMs;
      state.dayBucketCount += 1;
    } else if (
      outcome.status === "blocked_no_phone" ||
      outcome.status === "contact_not_found" ||
      outcome.status === "property_not_found" ||
      outcome.status === "blocked_no_consent"
    ) {
      state.skipped++;
    } else {
      const msg =
        "error" in outcome
          ? outcome.error
          : "reason" in outcome
            ? outcome.reason
            : outcome.status;
      state.failed.push({ propertyId, message: msg });
    }
  }

  return state;
}
