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
  jitterPct?: number;
  /**
   * Queue to contacts whose phone_1 line type is 'unknown' (never
   * classified). Default false — bulk SMS targets confirmed mobiles
   * only; the audience-assessment step surfaces the unknown count and
   * lets the operator opt them in. Landlines are always excluded.
   */
  includeUnknown?: boolean;
};

/**
 * Pacing state threaded across chunks so a workflow-chunked run
 * schedules identically to one long loop. Counters ride along so the
 * job row can report cumulative progress.
 *
 * Field names predate the daily-cap removal: `dayBucketStartMs` is now
 * simply the ramp anchor and `dayBucketCount` the number queued so far.
 * Kept as-is so in-flight workflow runs (which serialize this state
 * between invocations) survive a deploy.
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

  // Fetch properties in chunks — Supabase PostgREST rejects large IN
  // clauses (URL length limit, ~8 KB) so we split into batches of 250.
  const CHUNK = 250;
  type HomeownerJoin = { phone_1_type: string };
  const allProperties: {
    id: string;
    homeowner_contact_id: string | null;
    org_id: string | null;
    homeowner: HomeownerJoin | null;
  }[] = [];
  for (let i = 0; i < args.propertyIds.length; i += CHUNK) {
    const chunk = args.propertyIds.slice(i, i + CHUNK);
    const { data, error: propError } = await client
      .from("properties")
      .select(
        `id, homeowner_contact_id, org_id,
         homeowner:contacts!properties_homeowner_contact_id_fkey(phone_1_type)`,
      )
      .in("id", chunk);
    if (propError) {
      throw new Error(`bulk sms property fetch: ${propError.message}`);
    }
    // PostgREST may return the joined contact as an object or a
    // one-element array depending on relationship detection — same
    // normalization as fetchDialerPropertyRows.
    for (const row of (data ?? []) as unknown as (Omit<
      (typeof allProperties)[number],
      "homeowner"
    > & { homeowner: HomeownerJoin | HomeownerJoin[] | null })[]) {
      allProperties.push({
        ...row,
        homeowner: Array.isArray(row.homeowner)
          ? (row.homeowner[0] ?? null)
          : row.homeowner,
      });
    }
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

    // Line-type gate: landlines never get queued; unknowns only when the
    // operator opted in at the assessment step. (sendSmsToContact blocks
    // landlines again at queue time — this early skip just avoids burning
    // template-pool picks and renders on rows that can't send.)
    const lineType = property.homeowner?.phone_1_type ?? "unknown";
    if (lineType === "landline") {
      state.skipped++;
      continue;
    }
    if (lineType === "unknown" && !opts.includeUnknown) {
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

    // No volume caps client-side — credits at the provider are the only
    // cap (Jarrad's standing rule). The queue is one continuous paced
    // ramp from the anchor; quiet hours + consent re-check at release.
    // Compute the candidate next-offset so we can write `scheduledFor`,
    // but only COMMIT the advance (and jitter) on a successful queue.
    // This way a downstream skip (no_phone, blocked_no_consent re-check)
    // doesn't burn a slot and stretch the next message's gap past the
    // ±jitterPct bound.
    //
    // The first message of the ramp anchors at the anchor timestamp
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
      outcome.status === "blocked_landline" ||
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
