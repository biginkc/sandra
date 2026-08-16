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
import type { FilterBlock } from "@/lib/prospects/filter-schema";
import { resolveProspectEligibility } from "@/lib/prospects/eligibility";
import {
  preflightSkipTrace as preflightSkipTraceUnsafe,
  requestSkipTrace as requestSkipTraceUnsafe,
  type SkipTraceOutcome,
  type SkipTracePreflight,
} from "@/lib/skip-trace/actions";
import { createClient } from "@/lib/supabase/server";

import { getAllMatchingProspectIds } from "./actions";

export type { BulkOutcome } from "../leads/actions";

const DNC_LOCK_MESSAGE =
  "Prospect is locked Do Not Contact and cannot be changed in bulk.";
/**
 * Re-resolve suppression on the server immediately before a Prospects bulk
 * mutation. The missing checkbox is only the visual affordance; this is the
 * enforcement boundary for forged or stale client selections.
 */
async function partitionDncLockedPropertyIds(propertyIds: string[]): Promise<{
  eligible: string[];
  locked: string[];
}> {
  const supabase = await createClient();
  const resolved = await resolveProspectEligibility(
    supabase,
    propertyIds,
    "selection",
  );
  return {
    eligible: resolved.eligibleIds,
    locked: resolved.exclusions
      .filter((item) => item.reason === "dnc")
      .map((item) => item.propertyId),
  };
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

export async function verifyPropertiesBulk(propertyIds: string[], requestKey: string) {
  const { eligible, locked } = await partitionDncLockedPropertyIds(propertyIds);
  if (eligible.length === 0) {
    return {
      ok: false as const,
      error: { code: "DNC_LOCKED", message: DNC_LOCK_MESSAGE },
    };
  }
  const result = await verifyPropertiesBulkUnsafe(eligible, requestKey);
  return result.ok
    ? ok({ ...result.data, eligibleCount: eligible.length, lockedCount: locked.length })
    : result;
}

export type ProspectSkipTracePreflight = SkipTracePreflight & {
  dncLockedSkipped: number;
};

export async function preflightProspectSkipTrace(
  propertyIds: string[],
): Promise<Result<ProspectSkipTracePreflight>> {
  const supabase = await createClient();
  const resolved = await resolveProspectEligibility(
    supabase,
    propertyIds,
    "skip_trace",
  );
  if (resolved.eligibleIds.length === 0) {
    return ok({
      requested: new Set(propertyIds).size,
      eligible: 0,
      cassVerified: 0,
      cassUnverified: 0,
      notEligible: new Set(propertyIds).size,
      killSwitchSkipped: resolved.skipTraceDisabledCount,
      dncLockedSkipped: resolved.dncLockedCount,
      tracefyCreditsRequired: 0,
      tracefyCreditsAvailable: null,
      tracefyCreditStatus: "sufficient",
      canLaunchSkipTrace: false,
      estimatedCassVerificationCostUsd: 0,
      cassVerificationPropertyIds: [],
    });
  }
  const result = await preflightSkipTraceUnsafe(resolved.eligibleIds);
  if (!result.ok) return result;
  return ok({
    ...result.data,
    requested: new Set(propertyIds).size,
    notEligible: result.data.notEligible + resolved.exclusions.length,
    killSwitchSkipped:
      result.data.killSwitchSkipped + resolved.skipTraceDisabledCount,
    dncLockedSkipped: resolved.dncLockedCount,
  });
}

export type ProspectSkipTraceOutcome = SkipTraceOutcome & {
  dncLockedSkipped: number;
};

export async function requestProspectSkipTrace(
  propertyIds: string[],
): Promise<Result<ProspectSkipTraceOutcome>> {
  const supabase = await createClient();
  const resolved = await resolveProspectEligibility(
    supabase,
    propertyIds,
    "skip_trace",
  );
  if (resolved.eligibleIds.length === 0) {
    return ok({
      jobId: null,
      status: "none_eligible",
      requested: new Set(propertyIds).size,
      eligible: 0,
      cassSkipped: 0,
      killSwitchSkipped: resolved.skipTraceDisabledCount,
      dncLockedSkipped: resolved.dncLockedCount,
    });
  }
  const result = await requestSkipTraceUnsafe(resolved.eligibleIds);
  if (!result.ok) return result;
  return ok({
    ...result.data,
    requested: new Set(propertyIds).size,
    killSwitchSkipped:
      result.data.killSwitchSkipped + resolved.skipTraceDisabledCount,
    dncLockedSkipped: resolved.dncLockedCount,
  });
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
