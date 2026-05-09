import { checkQuietHours } from "@/lib/messaging/quiet-hours";

import { buildSnapshotsForProperty } from "./snapshot-identity";

export type BatchEligibilityCounts = {
  callable: number;
  blocked: Record<string, number>;
  missing: number;
};

export type ClassifyInput = {
  property: { id: string; state: string | null | undefined };
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
  now: Date = new Date(),
): ItemClassification[] {
  if (!input.contact) return [{ blocked: "no_contact" }];

  const snapshots = buildSnapshotsForProperty(input.property, input.contact);
  if (snapshots.length === 0) return ["missing"];

  if (input.contact.do_not_contact) {
    return snapshots.map(() => ({ blocked: "do_not_contact" }));
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
  now: Date = new Date(),
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
