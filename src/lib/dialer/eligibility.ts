import { checkQuietHours } from "@/lib/messaging/quiet-hours";

import { buildSnapshotsForProperty } from "./snapshot-identity";

export type BatchEligibilityCounts = {
  callable: number;
  blocked: Record<string, number>;
  missing: number;
};

export type ClassifyInput = {
  property: {
    id: string;
    state: string | null | undefined;
    // Durable, permanent compliance signals (true DNC lock migration
    // 20260815190000). Optional so existing callers that don't carry
    // these fields keep compiling; undefined/null is treated as "not
    // locked". A permanently DNC-locked property blocks every phone —
    // checked BEFORE quiet hours because this is a durable block, not a
    // time-of-day one (contract §1.3.3: only durable blocks map to
    // Jitter-side permanent suppression).
    is_dnc_locked?: boolean | null;
    outreach_dispo?: string | null;
  };
  contact: {
    id: string;
    phone_1: string | null;
    phone_2: string | null;
    phone_3: string | null;
    do_not_contact: boolean;
    sms_opted_out: boolean;
  } | null;
};

export type ItemClassification = "callable" | "missing" | { blocked: string };

/**
 * Classify per-(prospect, phone) items for the batch preview.
 *
 * D-15: this is a current preview only. Dial-time API reads re-resolve
 * eligibility again from Sandra, so batch items store identity, not compliance.
 */
export function classifyItem(
  input: ClassifyInput,
  now?: Date,
): ItemClassification[] {
  if (!input.contact) return [{ blocked: "no_contact" }];

  const snapshots = buildSnapshotsForProperty(input.property, input.contact);
  if (snapshots.length === 0) return ["missing"];

  if (input.contact.do_not_contact) {
    return snapshots.map(() => ({ blocked: "do_not_contact" }));
  }

  // True DNC lock (permanent, property-level) — checked before quiet
  // hours because it's a durable block. A quiet-hours block is
  // time-of-day and must never map to permanent suppression; this one
  // does (Jitter's callable=false is one-way).
  if (input.property.is_dnc_locked === true || input.property.outreach_dispo === "dnc") {
    return snapshots.map(() => ({ blocked: "do_not_call" }));
  }

  const window = checkQuietHours(input.property.state, now);
  if (!window.ok) {
    return snapshots.map(() => ({ blocked: window.reason }));
  }

  // sms_opted_out is intentionally not a voice-channel block.
  return snapshots.map(() => "callable");
}

export function previewBatchEligibility(
  items: ClassifyInput[],
  now?: Date,
): BatchEligibilityCounts {
  const counts: BatchEligibilityCounts = {
    callable: 0,
    blocked: {},
    missing: 0,
  };

  for (const item of items) {
    for (const classification of classifyItem(item, now)) {
      if (classification === "callable") {
        counts.callable += 1;
      } else if (classification === "missing") {
        counts.missing += 1;
      } else {
        counts.blocked[classification.blocked] =
          (counts.blocked[classification.blocked] ?? 0) + 1;
      }
    }
  }

  return counts;
}
