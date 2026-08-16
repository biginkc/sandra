import type { SupabaseClient } from "@supabase/supabase-js";

import { normalizePhone } from "@/lib/csv/normalize";
import { evaluateSuppression } from "@/lib/messaging/suppression";
import type { Database } from "@/lib/supabase/types";

const LOOKUP_CHUNK = 500;

export type SkipTraceExclusionReason =
  "dnc" | "skip_trace_disabled" | "cass_unverified" | "not_found_or_wrong_org";

export type SkipTraceEligibilityExclusion = {
  propertyId: string;
  reason: SkipTraceExclusionReason;
};

export type SkipTraceEligibilityResult = {
  eligibleIds: string[];
  exclusions: SkipTraceEligibilityExclusion[];
};

export type SkipTraceEligibilityAudit = {
  checked_at: string;
  requested: number;
  eligible: number;
  total: number;
  by_reason: Record<SkipTraceExclusionReason, number>;
};

type PropertyRow = {
  id: string;
  org_id: string;
  homeowner_contact_id: string | null;
  outreach_dispo: string | null;
  skip_trace_disabled: boolean;
  cass_status: string;
};

type ContactRow = {
  id: string;
  org_id: string;
  phone_1: string | null;
  phone_2: string | null;
  phone_3: string | null;
  do_not_contact: boolean;
  sms_opted_out: boolean;
};

function chunks<T>(values: readonly T[], size: number): T[][] {
  const result: T[][] = [];
  for (let offset = 0; offset < values.length; offset += size) {
    result.push(values.slice(offset, offset + size) as T[]);
  }
  return result;
}

/**
 * Authoritative, tenant-scoped eligibility check used immediately before a
 * skip-trace job is approved and again immediately before its durable worker
 * claims the paid provider boundary.
 */
export async function resolveSkipTraceEligibility(
  supabase: SupabaseClient<Database>,
  params: { orgId: string; propertyIds: readonly string[] },
): Promise<SkipTraceEligibilityResult> {
  const uniqueIds = [...new Set(params.propertyIds)];
  if (uniqueIds.length === 0) return { eligibleIds: [], exclusions: [] };

  const properties: PropertyRow[] = [];
  for (const ids of chunks(uniqueIds, LOOKUP_CHUNK)) {
    const { data, error } = await supabase
      .from("properties")
      .select(
        "id, org_id, homeowner_contact_id, outreach_dispo, skip_trace_disabled, cass_status",
      )
      .eq("org_id", params.orgId)
      .is("deleted_at", null)
      .in("id", ids);
    if (error) {
      throw new Error(
        `Skip-trace property eligibility failed: ${error.message}`,
      );
    }
    properties.push(...((data ?? []) as PropertyRow[]));
  }

  const contactIds = [
    ...new Set(
      properties
        .map((property) => property.homeowner_contact_id)
        .filter((id): id is string => !!id),
    ),
  ];
  const contacts: ContactRow[] = [];
  for (const ids of chunks(contactIds, LOOKUP_CHUNK)) {
    const { data, error } = await supabase
      .from("contacts")
      .select(
        "id, org_id, phone_1, phone_2, phone_3, do_not_contact, sms_opted_out",
      )
      .eq("org_id", params.orgId)
      .in("id", ids);
    if (error) {
      throw new Error(
        `Skip-trace contact eligibility failed: ${error.message}`,
      );
    }
    contacts.push(...((data ?? []) as ContactRow[]));
  }

  const phones = [
    ...new Set(
      contacts.flatMap((contact) =>
        [contact.phone_1, contact.phone_2, contact.phone_3]
          .map((phone) => normalizePhone(phone))
          .filter((phone): phone is string => !!phone),
      ),
    ),
  ];
  const suppressedPhones = new Set<string>();
  for (const phoneChunk of chunks(phones, LOOKUP_CHUNK)) {
    const { data, error } = await supabase
      .from("sms_phone_suppressions")
      .select("phone_e164")
      .eq("org_id", params.orgId)
      .eq("channel", "sms")
      .in("phone_e164", phoneChunk);
    if (error) {
      throw new Error(
        `Skip-trace phone suppression check failed: ${error.message}`,
      );
    }
    for (const row of data ?? []) suppressedPhones.add(row.phone_e164);
  }

  const propertyById = new Map(properties.map((row) => [row.id, row]));
  const contactById = new Map(contacts.map((row) => [row.id, row]));
  const eligibleIds: string[] = [];
  const exclusions: SkipTraceEligibilityExclusion[] = [];

  for (const propertyId of uniqueIds) {
    const property = propertyById.get(propertyId);
    if (!property) {
      exclusions.push({ propertyId, reason: "not_found_or_wrong_org" });
      continue;
    }
    const homeowner = property.homeowner_contact_id
      ? (contactById.get(property.homeowner_contact_id) ?? null)
      : null;
    if (property.homeowner_contact_id && !homeowner) {
      exclusions.push({ propertyId, reason: "not_found_or_wrong_org" });
      continue;
    }
    const durablePhoneSuppression = homeowner
      ? [homeowner.phone_1, homeowner.phone_2, homeowner.phone_3]
          .map((phone) => normalizePhone(phone))
          .some((phone) => !!phone && suppressedPhones.has(phone))
      : false;
    const suppression = evaluateSuppression({
      outreachDispo: property.outreach_dispo,
      doNotContact: homeowner?.do_not_contact,
      smsOptedOut: homeowner?.sms_opted_out,
    });
    if (durablePhoneSuppression || suppression.suppressed) {
      exclusions.push({ propertyId, reason: "dnc" });
      continue;
    }
    if (property.skip_trace_disabled) {
      exclusions.push({ propertyId, reason: "skip_trace_disabled" });
      continue;
    }
    if (property.cass_status !== "verified") {
      exclusions.push({ propertyId, reason: "cass_unverified" });
      continue;
    }
    eligibleIds.push(propertyId);
  }

  return { eligibleIds, exclusions };
}

export function buildSkipTraceEligibilityAudit(
  result: SkipTraceEligibilityResult,
  requested: number,
  checkedAt = new Date().toISOString(),
): SkipTraceEligibilityAudit {
  const byReason: Record<SkipTraceExclusionReason, number> = {
    dnc: 0,
    skip_trace_disabled: 0,
    cass_unverified: 0,
    not_found_or_wrong_org: 0,
  };
  for (const exclusion of result.exclusions) byReason[exclusion.reason] += 1;
  return {
    checked_at: checkedAt,
    requested,
    eligible: result.eligibleIds.length,
    total: result.exclusions.length,
    by_reason: byReason,
  };
}

function readPriorAudit(value: unknown): SkipTraceEligibilityAudit | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const candidate = value as Partial<SkipTraceEligibilityAudit>;
  if (
    typeof candidate.requested !== "number" ||
    typeof candidate.eligible !== "number" ||
    typeof candidate.total !== "number" ||
    !candidate.by_reason ||
    typeof candidate.by_reason !== "object"
  ) {
    return null;
  }
  return candidate as SkipTraceEligibilityAudit;
}

/** Preserve approval exclusions while adding any newer submit-time ones. */
export function mergeSkipTraceEligibilityAudits(
  previous: unknown,
  current: SkipTraceEligibilityAudit,
): SkipTraceEligibilityAudit {
  const prior = readPriorAudit(previous);
  if (!prior) return current;
  return {
    checked_at: current.checked_at,
    requested: prior.requested,
    eligible: current.eligible,
    total: prior.total + current.total,
    by_reason: {
      dnc: (prior.by_reason.dnc ?? 0) + current.by_reason.dnc,
      skip_trace_disabled:
        (prior.by_reason.skip_trace_disabled ?? 0) +
        current.by_reason.skip_trace_disabled,
      cass_unverified:
        (prior.by_reason.cass_unverified ?? 0) +
        current.by_reason.cass_unverified,
      not_found_or_wrong_org:
        (prior.by_reason.not_found_or_wrong_org ?? 0) +
        current.by_reason.not_found_or_wrong_org,
    },
  };
}

export function skipTraceAudienceTitle(
  originalTitle: string | null,
  eligible: number,
  excluded: number,
): string {
  const countLabel = `Skip trace ${eligible} propert${eligible === 1 ? "y" : "ies"}`;
  const withoutPriorExclusion = (originalTitle ?? countLabel).replace(
    / · \d+ excluded before provider submission$/,
    "",
  );
  const preserved = /^Skip trace \d+ propert(?:y|ies)/.test(
    withoutPriorExclusion,
  )
    ? withoutPriorExclusion.replace(
        /^Skip trace \d+ propert(?:y|ies)/,
        countLabel,
      )
    : `${countLabel} · ${withoutPriorExclusion}`;
  return excluded > 0
    ? `${preserved} · ${excluded} excluded before provider submission`
    : preserved;
}

export function skipTraceAudienceDescription(
  originalDescription: string | null,
  eligible: number,
  excluded: number,
): string {
  const base = (originalDescription ?? "Skip-trace job")
    .replace(
      / Provider audience: \d+ eligible; \d+ excluded before provider submission\.$/,
      "",
    )
    .trim();
  return `${base} Provider audience: ${eligible} eligible; ${excluded} excluded before provider submission.`;
}
