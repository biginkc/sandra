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
    /**
     * Durable, permanent compliance lock (`properties.is_dnc_locked`,
     * migration 20260815190000). This is the single canonical "never call
     * again" signal: the DB trigger `properties_true_dnc_lock_guard`
     * already promotes both `outreach_dispo = 'dnc'` and a linked
     * contact's `do_not_contact = true` into this flag, and once true it
     * cannot be cleared. We deliberately check this one field rather than
     * re-deriving durability from `outreach_dispo` here, so there is a
     * single source of truth and no risk of the two drifting apart.
     */
    is_dnc_locked?: boolean;
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
 *
 * Durable vs. temporary blocks (contract §1.3.3): `property_dnc_locked` is a
 * PERMANENT compliance state — once true it can never flip back to callable,
 * so downstream (Jitter) is expected to treat it as a one-way `callable =
 * false` suppression. `outside_window` / `unknown_state` (quiet hours) are
 * TEMPORARY — the same item can be callable again next hour once local time
 * moves back inside the window. These reason strings must stay
 * distinguishable and must NEVER be collapsed into one bucket: a future
 * "let's just treat all blocked reasons the same" refactor would silently
 * teach Jitter to permanently suppress a number that is only quiet-hours
 * blocked right now, or (worse) treat a permanent DNC lock as something
 * that can reopen. classifyItem also never persists/caches its result —
 * every call re-derives eligibility fresh, so a quiet-hours block can never
 * freeze past the request that observed it.
 */
export function classifyItem(
  input: ClassifyInput,
  now?: Date,
): ItemClassification[] {
  if (!input.contact) return [{ blocked: "no_contact" }];

  const snapshots = buildSnapshotsForProperty(input.property, input.contact);
  if (snapshots.length === 0) return ["missing"];

  // Durable property-level lock wins regardless of quiet hours or contact
  // state — checked first so it can never be masked by a temporary block.
  if (input.property.is_dnc_locked) {
    return snapshots.map(() => ({ blocked: "property_dnc_locked" }));
  }

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
