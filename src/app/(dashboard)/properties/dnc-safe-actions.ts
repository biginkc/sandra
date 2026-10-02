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

import type { QueryOrigin } from "@/lib/prospects/search-scope";
import {
  selectAllMatching,
  selectionFilters,
  type PropertySelection,
} from "@/lib/prospects/select-all";


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
  /** Rows that are not prospects (leads etc.), skipped, never actioned. */
  skippedLeads: number;
}> {
  const supabase = await createClient();
  const resolved = await resolveProspectEligibility(
    supabase,
    propertyIds,
    "selection",
  );
  return {
    eligible: resolved.eligibleIds,
    // Leads are counted BEFORE the DNC split: a locked lead is a skipped
    // lead, only locked prospects are reported as DNC failures.
    locked: resolved.prospectDncLockedIds,
    skippedLeads: resolved.skippedLeadCount,
  };
}

function addLockedFailures(
  outcome: BulkOutcome,
  locked: string[],
  skippedLeads = 0,
): BulkOutcome {
  return {
    ...outcome,
    failed: [
      ...outcome.failed,
      ...locked.map((propertyId) => ({ propertyId, message: DNC_LOCK_MESSAGE })),
    ],
    ...(skippedLeads > 0 ? { skippedLeads } : {}),
  };
}

async function runBulkOutcome(
  selection: PropertySelection,
  action: (eligible: string[]) => Promise<Result<BulkOutcome>>,
): Promise<Result<BulkOutcome>> {
  const filters = selectionFilters(selection);
  if (filters) {
    // Select-all-matching: re-resolved from the filters on the server. The
    // resolver already keeps prospects that are not DNC-locked; leads and
    // locked prospects are reported, never actioned.
    const resolved = await selectAllMatching(filters);
    if (!resolved.ok) return resolved;
    const { eligibleIds, skippedLeads, dncLockedCount } = resolved.data;
    const base: BulkOutcome = {
      succeeded: 0,
      skipped: dncLockedCount,
      failed: [],
    };
    if (eligibleIds.length === 0) {
      return ok({ ...base, ...(skippedLeads > 0 ? { skippedLeads } : {}) });
    }
    const result = await action(eligibleIds);
    if (!result.ok) return result;
    return ok({
      ...result.data,
      skipped: result.data.skipped + dncLockedCount,
      ...(skippedLeads > 0 ? { skippedLeads } : {}),
    });
  }
  const { eligible, locked, skippedLeads } =
    await partitionDncLockedPropertyIds(selection as string[]);
  if (eligible.length === 0) {
    return ok(
      addLockedFailures(
        { succeeded: 0, skipped: 0, failed: [] },
        locked,
        skippedLeads,
      ),
    );
  }
  const result = await action(eligible);
  return result.ok
    ? ok(addLockedFailures(result.data, locked, skippedLeads))
    : result;
}

export async function assignLeadsBulk(
  selection: PropertySelection,
  userId: string | null,
) {
  return await runBulkOutcome(selection, (eligible) =>
    assignLeadsBulkUnsafe(eligible, userId),
  );
}

export async function addPropertiesToListBulk(
  selection: PropertySelection,
  listId: string,
) {
  return await runBulkOutcome(selection, (eligible) =>
    addPropertiesToListBulkUnsafe(eligible, listId),
  );
}

export async function removePropertiesFromListBulk(
  selection: PropertySelection,
  listId: string,
) {
  return await runBulkOutcome(selection, (eligible) =>
    removePropertiesFromListBulkUnsafe(eligible, listId),
  );
}

export async function applyTagBulk(selection: PropertySelection, tagId: string) {
  return await runBulkOutcome(selection, (eligible) =>
    applyTagBulkUnsafe(eligible, tagId),
  );
}

export async function deletePropertiesBulk(selection: PropertySelection) {
  return await runBulkOutcome(selection, deletePropertiesBulkUnsafe);
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
  const { eligible, locked, skippedLeads } = await partitionDncLockedPropertyIds(
    params.propertyIds,
  );
  const result = await createAndApplyCustomTagBulkUnsafe({
    ...params,
    propertyIds: eligible,
  });
  if (!result.ok) return result;
  return ok({
    ...result.data,
    outcome: addLockedFailures(result.data.outcome, locked, skippedLeads),
  });
}

export async function createAndApplyCustomTagBulkFromFilters(params: {
  name: string;
  color?: string | null;
  search: string | null;
  blockStack: FilterBlock[];
  imported?: "today" | null;
  /** Defaults to 'legacy'; the Search page passes 'search_page'. */
  origin?: QueryOrigin;
}) {
  const ids = await selectAllMatching({
    search: params.search,
    blockStack: params.blockStack,
    imported: params.imported ?? null,
    origin: params.origin,
  });
  if (!ids.ok) return ids;
  // Matched leads never reach the tag action; surface them as a skip count.
  const tagged = await createAndApplyCustomTagBulk({
    name: params.name,
    color: params.color ?? null,
    propertyIds: ids.data.eligibleIds,
  });
  if (!tagged.ok || ids.data.skippedLeads === 0) return tagged;
  return ok({
    ...tagged.data,
    outcome: {
      ...tagged.data.outcome,
      skippedLeads:
        (tagged.data.outcome.skippedLeads ?? 0) + ids.data.skippedLeads,
    },
  });
}
