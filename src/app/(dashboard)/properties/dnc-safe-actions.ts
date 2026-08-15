"use server";

import {
  addPropertiesToListBulk as addPropertiesToListBulkUnsafe,
  applyTagBulk as applyTagBulkUnsafe,
  assignLeadsBulk as assignLeadsBulkUnsafe,
  createAndApplyCustomTagBulk as createAndApplyCustomTagBulkUnsafe,
  deletePropertiesBulk as deletePropertiesBulkUnsafe,
  qualifyLeadsBulk as qualifyLeadsBulkUnsafe,
  removePropertiesFromListBulk as removePropertiesFromListBulkUnsafe,
  verifyPropertiesBulk as verifyPropertiesBulkUnsafe,
  type BulkOutcome,
} from "../leads/actions";
import { ok, type Result } from "@/lib/errors/result";
import { evaluateSuppression } from "@/lib/messaging/suppression";
import type { FilterBlock } from "@/lib/prospects/filter-schema";
import { createClient } from "@/lib/supabase/server";

import { getAllMatchingProspectIds } from "./actions";

export type { BulkOutcome } from "../leads/actions";

const DNC_LOCK_MESSAGE =
  "Prospect is locked Do Not Contact and cannot be changed in bulk.";
const LOOKUP_CHUNK = 500;

/**
 * Re-resolve suppression on the server immediately before a Prospects bulk
 * mutation. The missing checkbox is only the visual affordance; this is the
 * enforcement boundary for forged or stale client selections.
 */
async function partitionDncLockedPropertyIds(propertyIds: string[]): Promise<{
  eligible: string[];
  locked: string[];
}> {
  const uniqueIds = [...new Set(propertyIds)];
  if (uniqueIds.length === 0) return { eligible: [], locked: [] };

  const supabase = await createClient();
  const rows: Array<{
    id: string;
    outreach_dispo: string | null;
    homeowner: Array<{
      phone_1: string | null;
      phone_2: string | null;
      phone_3: string | null;
      do_not_contact: boolean;
      sms_opted_out: boolean;
    }> | null;
  }> = [];

  for (let offset = 0; offset < uniqueIds.length; offset += LOOKUP_CHUNK) {
    const { data, error } = await supabase
      .from("properties")
      .select(
        "id, outreach_dispo, homeowner:contacts!properties_homeowner_contact_id_fkey(phone_1, phone_2, phone_3, do_not_contact, sms_opted_out)",
      )
      .in("id", uniqueIds.slice(offset, offset + LOOKUP_CHUNK));
    if (error) throw new Error(`DNC eligibility check failed: ${error.message}`);
    rows.push(...((data ?? []) as unknown as typeof rows));
  }

  const phones = rows.flatMap((row) => {
    const homeowner = Array.isArray(row.homeowner) ? row.homeowner[0] : row.homeowner;
    return homeowner
      ? [homeowner.phone_1, homeowner.phone_2, homeowner.phone_3].filter(
          (phone): phone is string => !!phone,
        )
      : [];
  });
  const suppressedPhones = new Set<string>();
  for (let offset = 0; offset < phones.length; offset += LOOKUP_CHUNK) {
    const { data, error } = await supabase
      .from("sms_phone_suppressions")
      .select("phone_e164")
      .in("phone_e164", phones.slice(offset, offset + LOOKUP_CHUNK));
    if (error) throw new Error(`DNC suppression check failed: ${error.message}`);
    for (const row of data ?? []) suppressedPhones.add(row.phone_e164);
  }

  const rowById = new Map(rows.map((row) => [row.id, row]));
  const eligible: string[] = [];
  const locked: string[] = [];
  for (const id of uniqueIds) {
    const row = rowById.get(id);
    if (!row) continue; // RLS-invisible/not-found IDs never reach the mutation.
    const homeowner = Array.isArray(row.homeowner) ? row.homeowner[0] : row.homeowner;
    const durableSuppression = [
      homeowner?.phone_1,
      homeowner?.phone_2,
      homeowner?.phone_3,
    ].some((phone) => !!phone && suppressedPhones.has(phone));
    const suppressed =
      durableSuppression ||
      evaluateSuppression({
        outreachDispo: row.outreach_dispo,
        doNotContact: homeowner?.do_not_contact,
        smsOptedOut: homeowner?.sms_opted_out,
      }).suppressed;
    (suppressed ? locked : eligible).push(id);
  }
  return { eligible, locked };
}

function addLockedFailures(outcome: BulkOutcome, locked: string[]): BulkOutcome {
  return {
    ...outcome,
    failed: [
      ...outcome.failed,
      ...locked.map((propertyId) => ({ propertyId, message: DNC_LOCK_MESSAGE })),
    ],
  };
}

async function runBulkOutcome(
  propertyIds: string[],
  action: (eligible: string[]) => Promise<Result<BulkOutcome>>,
): Promise<Result<BulkOutcome>> {
  const { eligible, locked } = await partitionDncLockedPropertyIds(propertyIds);
  if (eligible.length === 0) {
    return ok(addLockedFailures({ succeeded: 0, skipped: 0, failed: [] }, locked));
  }
  const result = await action(eligible);
  return result.ok ? ok(addLockedFailures(result.data, locked)) : result;
}

export async function assignLeadsBulk(propertyIds: string[], userId: string | null) {
  return await runBulkOutcome(propertyIds, (eligible) =>
    assignLeadsBulkUnsafe(eligible, userId),
  );
}

export async function addPropertiesToListBulk(propertyIds: string[], listId: string) {
  return await runBulkOutcome(propertyIds, (eligible) =>
    addPropertiesToListBulkUnsafe(eligible, listId),
  );
}

export async function removePropertiesFromListBulk(
  propertyIds: string[],
  listId: string,
) {
  return await runBulkOutcome(propertyIds, (eligible) =>
    removePropertiesFromListBulkUnsafe(eligible, listId),
  );
}

export async function applyTagBulk(propertyIds: string[], tagId: string) {
  return await runBulkOutcome(propertyIds, (eligible) =>
    applyTagBulkUnsafe(eligible, tagId),
  );
}

export async function deletePropertiesBulk(propertyIds: string[]) {
  return await runBulkOutcome(propertyIds, deletePropertiesBulkUnsafe);
}

export async function qualifyLeadsBulk(propertyIds: string[]) {
  const { eligible, locked } = await partitionDncLockedPropertyIds(propertyIds);
  const result = await qualifyLeadsBulkUnsafe(eligible);
  if (!result.ok) return result;
  return ok({
    ...result.data,
    failed: [
      ...result.data.failed,
      ...locked.map((propertyId) => ({ propertyId, message: DNC_LOCK_MESSAGE })),
    ],
  });
}

export async function verifyPropertiesBulk(propertyIds: string[]) {
  const { eligible, locked } = await partitionDncLockedPropertyIds(propertyIds);
  if (eligible.length === 0) {
    return {
      ok: false as const,
      error: { code: "DNC_LOCKED", message: DNC_LOCK_MESSAGE },
    };
  }
  const result = await verifyPropertiesBulkUnsafe(eligible);
  return result.ok
    ? ok({ ...result.data, eligibleCount: eligible.length, lockedCount: locked.length })
    : result;
}

export async function createAndApplyCustomTagBulk(params: {
  name: string;
  color?: string | null;
  propertyIds: string[];
}) {
  const { eligible, locked } = await partitionDncLockedPropertyIds(
    params.propertyIds,
  );
  const result = await createAndApplyCustomTagBulkUnsafe({
    ...params,
    propertyIds: eligible,
  });
  if (!result.ok) return result;
  return ok({
    ...result.data,
    outcome: addLockedFailures(result.data.outcome, locked),
  });
}

export async function createAndApplyCustomTagBulkFromFilters(params: {
  name: string;
  color?: string | null;
  search: string | null;
  blockStack: FilterBlock[];
  imported?: "today" | null;
}) {
  const ids = await getAllMatchingProspectIds({
    search: params.search,
    blockStack: params.blockStack,
    imported: params.imported ?? null,
  });
  if (!ids.ok) return ids;
  return createAndApplyCustomTagBulk({
    name: params.name,
    color: params.color ?? null,
    propertyIds: ids.data,
  });
}
