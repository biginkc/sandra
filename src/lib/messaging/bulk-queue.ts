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
import {
  loadCampaignDeliverySettings,
  normalizeSenderNumber,
} from "@/lib/messaging/delivery";
import { getMessagingProvider } from "@/lib/messaging/registry";
import { sendSmsToContact } from "@/lib/messaging/send";
import { pickFromPool } from "@/lib/templates/pool";
import { loadTemplateVars } from "@/lib/sequences/template-vars";
import { renderTemplate } from "@/lib/sequences/render";
import type { Database } from "@/lib/supabase/types";
import {
  validateSmsPaceSeconds,
  type SmsPacingProfile,
} from "@/lib/messaging/pacing";
import {
  classifySmsPhoneAvailability,
  selectBestSmsPhone,
  type SmsPhoneAvailability,
  type SmsPhoneContact,
} from "@/lib/messaging/sms-phone";
import { shouldSuppressAutomatedSend } from "@/lib/messaging/suppression";
import { normalizePhone } from "@/lib/csv/normalize";
import { loadSuppressedSmsPhoneSet } from "@/lib/messaging/opt-out-phone";

export const CONTACTED_MESSAGE_STATUSES = ["sent", "delivered"] as const;

export type BulkSmsQueueBaseOpts = {
  body?: string;
  templateCategory?: string;
  paceSeconds?: number;
  pacingProfile?: SmsPacingProfile;
  skipIfContacted?: boolean;
  jitterPct?: number;
  /**
   * Delivery setup: E.164 sending number from the synced approved sender
   * catalog. Required when the call creates the campaign (ad-hoc bulk
   * SMS); for an existing campaign it must match the stored sender —
   * queued rows always send from the campaign's locked sender.
   */
  senderNumber?: string;
  /** Optional Delivery metadata: synced provider campaign external id. */
  providerCampaignExternalId?: string | null;
  /**
   * Queue to contacts whose best available SMS phone is 'unknown' (never
   * classified). Default false — bulk SMS targets confirmed mobiles
   * only; the audience-assessment step surfaces the unknown count and
   * lets the operator opt them in. Landlines are always excluded.
   */
  includeUnknown?: boolean;
};

export type BulkSmsQueueOpts =
  | (BulkSmsQueueBaseOpts & {
      campaignId: string;
      campaignName?: never;
    })
  | (BulkSmsQueueBaseOpts & {
      campaignName: string;
      campaignId?: never;
    });

export type ResolvedBulkSmsQueueOpts = BulkSmsQueueBaseOpts & {
  campaignId: string;
  campaignSource?: "ad_hoc_bulk_sms" | "saved_campaign";
};

/**
 * Pacing state threaded across chunks so a workflow-chunked run
 * schedules identically to one long loop. Counters ride along so the
 * job row can report cumulative progress.
 *
 * Field names predate the daily-cap removal: `dayBucketStartMs` is now
 * simply the ramp anchor and `dayBucketCount` the number queued so far.
 * Names kept so legacy serialized state still parses — but the
 * SEMANTICS intentionally change across deploy: a run serialized under
 * the old capped scheduler resumes as an uncapped continuous ramp from
 * its current anchor+offset (no next-day rollover). That is the point
 * of the cap removal; do not re-add rollover for legacy state.
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
 * releaser's privilege level).
 *
 * Mutates nothing outside the DB; returns the updated schedule state so
 * chunked callers thread it into the next call.
 */
export async function queueSmsBatch(
  client: SupabaseClient<Database>,
  args: {
    propertyIds: string[];
    opts: ResolvedBulkSmsQueueOpts;
    state: BulkSmsScheduleState;
  },
): Promise<BulkSmsScheduleState> {
  const { opts, state } = args;
  const paceResult = validateSmsPaceSeconds(opts.paceSeconds, {
    mode: opts.campaignSource === "saved_campaign" ? "saved_campaign" : "bulk",
    pacingProfile: opts.pacingProfile,
  });
  if (!paceResult.ok) {
    throw new Error(paceResult.message);
  }
  const paceSeconds = paceResult.paceSeconds;
  const jitterPct = opts.jitterPct ?? 0;

  // Shared sender-stamping path: every campaign queue entry point
  // (campaign launch, bulk SMS sync path, chunked workflow) funnels
  // through here, so the campaign's Delivery sender is resolved once and
  // stamped onto every queued row. A campaign with no sender cannot
  // queue — Delivery setup is required before launch.
  const delivery = await loadCampaignDeliverySettings(client, opts.campaignId);
  if (!delivery.senderNumber) {
    throw new Error(
      "Campaign has no sending number. Set Delivery (sending number) before queueing SMS.",
    );
  }
  // The provider is part of the campaign's Delivery snapshot. If the
  // configured provider has changed since the campaign was set up, fail
  // closed instead of stamping the old sender under the new provider —
  // release would either fail those rows or send through the wrong
  // adapter.
  const currentProvider = getMessagingProvider();
  if (
    delivery.senderProvider &&
    delivery.senderProvider !== currentProvider?.providerId
  ) {
    throw new Error(
      `Campaign Delivery is configured for provider ${delivery.senderProvider}, ` +
        `but the active messaging provider is ${currentProvider?.providerId ?? "off"}. ` +
        "Re-create the campaign under the active provider before queueing.",
    );
  }
  const senderNumber = normalizeSenderNumber(
    delivery.fromAddress ?? delivery.senderNumber,
  );

  // Fetch properties in chunks — Supabase PostgREST rejects large IN
  // clauses (URL length limit, ~8 KB) so we split into batches of 250.
  const CHUNK = 250;
  const allProperties: {
    id: string;
    homeowner_contact_id: string | null;
    org_id: string | null;
    outreach_dispo: string | null;
    homeowner: SmsPhoneContact | null;
  }[] = [];
  for (let i = 0; i < args.propertyIds.length; i += CHUNK) {
    const chunk = args.propertyIds.slice(i, i + CHUNK);
    const { data, error: propError } = await client
      .from("properties")
      .select(
        `id, homeowner_contact_id, org_id, outreach_dispo,
         homeowner:contacts!properties_homeowner_contact_id_fkey(
           phone_1, phone_1_type, phone_2, phone_2_type, phone_3, phone_3_type
         )`,
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
    > & { homeowner: SmsPhoneContact | SmsPhoneContact[] | null })[]) {
      allProperties.push({
        ...row,
        homeowner: Array.isArray(row.homeowner)
          ? (row.homeowner[0] ?? null)
          : row.homeowner,
      });
    }
  }

  const propertyMap = new Map(allProperties.map((p) => [p.id, p]));

  const frozenContactByProperty = new Map<string, string | null>();
  for (let i = 0; i < args.propertyIds.length; i += CHUNK) {
    const chunk = args.propertyIds.slice(i, i + CHUNK);
    const { data, error } = await client
      .from("campaign_recipients")
      .select("property_id, contact_id")
      .eq("campaign_id", opts.campaignId)
      .in("property_id", chunk);
    if (error) {
      throw new Error(`bulk sms campaign recipients fetch: ${error.message}`);
    }
    data?.forEach((row) => {
      if (row.property_id) {
        frozenContactByProperty.set(row.property_id, row.contact_id ?? null);
      }
    });
  }

  const frozenContactAvailability = new Map<string, SmsPhoneAvailability>();
  const frozenContactDestinationPhone = new Map<string, string>();
  const frozenContactDoNotContact = new Map<string, boolean>();
  const frozenContactSmsOptedOut = new Map<string, boolean>();
  const frozenContactIds = Array.from(
    new Set(
      Array.from(frozenContactByProperty.values()).filter(
        (value): value is string => typeof value === "string",
      ),
    ),
  );
  for (let i = 0; i < frozenContactIds.length; i += CHUNK) {
    const chunk = frozenContactIds.slice(i, i + CHUNK);
    const { data, error } = await client
      .from("contacts")
      .select("id, phone_1, phone_1_type, phone_2, phone_2_type, phone_3, phone_3_type, do_not_contact, sms_opted_out")
      .in("id", chunk);
    if (error) {
      throw new Error(`bulk sms frozen contacts fetch: ${error.message}`);
    }
    data?.forEach((row) => {
      if (row.id) {
        frozenContactDoNotContact.set(row.id, row.do_not_contact);
        frozenContactSmsOptedOut.set(row.id, row.sms_opted_out);
        const destination = selectBestSmsPhone(row);
        const destinationPhone = normalizePhone(destination?.phone ?? "");
        if (destinationPhone) {
          frozenContactDestinationPhone.set(row.id, destinationPhone);
        }
        frozenContactAvailability.set(
          row.id,
          classifySmsPhoneAvailability(row),
        );
      }
    });
  }
  const destinationPhonesByOrg = new Map<string, string[]>();
  for (const property of allProperties) {
    if (!property.org_id) continue;
    const contactId = frozenContactByProperty.get(property.id);
    if (!contactId) continue;
    const destinationPhone = frozenContactDestinationPhone.get(contactId);
    if (!destinationPhone) continue;
    const phones = destinationPhonesByOrg.get(property.org_id) ?? [];
    phones.push(destinationPhone);
    destinationPhonesByOrg.set(property.org_id, phones);
  }
  const suppressedFrozenPhonesByOrg = new Map<string, Set<string>>();
  for (const [orgId, phones] of destinationPhonesByOrg) {
    suppressedFrozenPhonesByOrg.set(
      orgId,
      await loadSuppressedSmsPhoneSet(client, phones, orgId),
    );
  }

  const alreadyQueuedForCampaign = new Set<string>();
  for (let i = 0; i < args.propertyIds.length; i += CHUNK) {
    const chunk = args.propertyIds.slice(i, i + CHUNK);
    const { data, error } = await client
      .from("messages")
      .select("property_id")
      .eq("campaign_id", opts.campaignId)
      .eq("direction", "outbound")
      .in("property_id", chunk);
    if (error) {
      throw new Error(`bulk sms campaign duplicate check: ${error.message}`);
    }
    data?.forEach((row) => {
      if (row.property_id) alreadyQueuedForCampaign.add(row.property_id);
    });
  }

  // Prefetch successfully contacted property IDs in batched queries so
  // the per-property loop doesn't fire N individual round-trips. Failed
  // prior attempts are not real contacts; they should not suppress a
  // future campaign launch.
  const contactedSet = new Set<string>();
  if (opts.skipIfContacted) {
    for (let i = 0; i < args.propertyIds.length; i += CHUNK) {
      const chunk = args.propertyIds.slice(i, i + CHUNK);
      const { data, error } = await client
        .from("messages")
        .select("property_id")
        .in("property_id", chunk)
        .eq("direction", "outbound")
        .in("status", CONTACTED_MESSAGE_STATUSES);
      if (error) {
        throw new Error(`bulk sms prior contact lookup: ${error.message}`);
      }
      data?.forEach((r) => {
        if (r.property_id) contactedSet.add(r.property_id);
      });
    }
  }

  for (const propertyId of args.propertyIds) {
    const property = propertyMap.get(propertyId);
    if (!property) {
      state.skipped++;
      continue;
    }

    const contactId = frozenContactByProperty.get(propertyId);
    if (!contactId) {
      state.skipped++;
      continue;
    }

    if (
      shouldSuppressAutomatedSend({
        outreachDispo: property.outreach_dispo,
        doNotContact: frozenContactDoNotContact.get(contactId) ?? null,
        smsOptedOut: frozenContactSmsOptedOut.get(contactId) ?? null,
      })
    ) {
      state.skipped++;
      continue;
    }
    const destinationPhone = frozenContactDestinationPhone.get(contactId);
    if (
      destinationPhone &&
      property.org_id &&
      suppressedFrozenPhonesByOrg.get(property.org_id)?.has(destinationPhone)
    ) {
      state.skipped++;
      continue;
    }

    if (alreadyQueuedForCampaign.has(propertyId)) {
      let nextOffsetMs = state.cumulativeOffsetMs;
      if (state.dayBucketCount > 0) {
        nextOffsetMs = state.cumulativeOffsetMs + paceSeconds * 1000;
      }
      state.succeeded++;
      state.cumulativeOffsetMs = nextOffsetMs;
      state.dayBucketCount += 1;
      continue;
    }

    if (opts.skipIfContacted && contactedSet.has(propertyId)) {
      state.skipped++;
      continue;
    }

    // Line-type gate: landlines never get queued; unknowns only when the
    // operator opted in at the assessment step. A mobile in any saved
    // phone slot wins over earlier landlines.
    const lineType = frozenContactAvailability.get(contactId) ?? "none";
    if (lineType === "landline") {
      state.skipped++;
      continue;
    }
    if (lineType === "none") {
      state.skipped++;
      continue;
    }
    if (lineType === "unknown" && !opts.includeUnknown) {
      state.skipped++;
      continue;
    }

    const consentState = await getConsentState(
      client,
      contactId,
      "sms",
    );
    if (
      shouldSuppressAutomatedSend({
        outreachDispo: property.outreach_dispo,
        consentState,
        doNotContact: frozenContactDoNotContact.get(contactId) ?? null,
        smsOptedOut: frozenContactSmsOptedOut.get(contactId) ?? null,
      })
    ) {
      state.skipped++;
      continue;
    }
    if (
      destinationPhone &&
      property.org_id &&
      suppressedFrozenPhonesByOrg.get(property.org_id)?.has(destinationPhone)
    ) {
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
          contactId,
        },
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
      origin: "automated",
      contactId,
      propertyId,
      body,
      from: senderNumber,
      campaignId: opts.campaignId,
      queueOnly: true,
      scheduledFor,
    });

    if (outcome.status === "queued" || outcome.status === "paused") {
      state.succeeded++;
      state.cumulativeOffsetMs = nextOffsetMs;
      state.dayBucketCount += 1;
    } else if (
      outcome.status === "blocked_no_phone" ||
      outcome.status === "blocked_landline" ||
      outcome.status === "blocked_terminal_dispo" ||
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
