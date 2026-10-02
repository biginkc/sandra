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
  resolveSelection,
  selectAllMatching,
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
async function partitionDncLockedPropertyIds(
  propertyIds: string[],
  origin: QueryOrigin = "legacy",
): Promise<{
  eligible: string[];
  locked: string[];
  /** Search page only: rows that are not prospects (leads etc.), skipped, never actioned. */
  skippedLeads: number;
}> {
  const supabase = await createClient();
  const resolved = await resolveProspectEligibility(
    supabase,
    propertyIds,
    "selection",
  );
  if (origin === "search_page") {
    return {
      eligible: resolved.eligibleIds,
      // Search page: leads are counted BEFORE the DNC split, so a locked lead is
      // a skipped lead and only locked prospects are reported as DNC failures.
      locked: resolved.prospectDncLockedIds,
      skippedLeads: resolved.skippedLeadCount,
    };
  }
  // Legacy callers: every DNC-locked row (any status) is reported as locked and
  // no lead count exists. Byte-for-byte the pre-Search behavior.
  return {
    eligible: resolved.eligibleIds,
    locked: resolved.exclusions
      .filter((item) => item.reason === "dnc")
      .map((item) => item.propertyId),
    skippedLeads: 0,
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
  const resolved = await resolveSelection(selection);
  if (!resolved.ok) return resolved;
  if (resolved.data.fromFilters) {
    // Select-all-matching: re-resolved from the filters on the server. The
    // resolver already keeps prospects that are not DNC-locked; locked
    // prospects are reported like the checkbox path and leads as a skip count.
    const { ids, skippedLeads, dncLockedIds } = resolved.data;
    if (ids.length === 0) {
      return ok(
        addLockedFailures({ succeeded: 0, skipped: 0, failed: [] }, dncLockedIds, skippedLeads),
      );
    }
    const result = await action(ids);
    return result.ok
      ? ok(addLockedFailures(result.data, dncLockedIds, skippedLeads))
      : result;
  }
  const { eligible, locked, skippedLeads } = await partitionDncLockedPropertyIds(
    resolved.data.ids,
    resolved.data.origin,
  );
  if (eligible.length === 0) {
    return ok(
      addLockedFailures({ succeeded: 0, skipped: 0, failed: [] }, locked, skippedLeads),
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

export async function verifyPropertiesBulk(
  selection: PropertySelection | string[],
  requestKey: string,
) {
  const resolved = await resolveSelection(selection);
  if (!resolved.ok) return resolved;
  let eligible: string[];
  let lockedCount: number;
  let skippedLeads = 0;
  if (resolved.data.fromFilters) {
    eligible = resolved.data.ids;
    lockedCount = resolved.data.dncLockedCount;
    skippedLeads = resolved.data.skippedLeads;
  } else {
    const part = await partitionDncLockedPropertyIds(resolved.data.ids, resolved.data.origin);
    eligible = part.eligible;
    lockedCount = part.locked.length;
    skippedLeads = part.skippedLeads;
  }
  if (eligible.length === 0) {
    return {
      ok: false as const,
      error: { code: "DNC_LOCKED", message: DNC_LOCK_MESSAGE },
    };
  }
  const result = await verifyPropertiesBulkUnsafe(eligible, requestKey);
  return result.ok
    ? ok({
        ...result.data,
        eligibleCount: eligible.length,
        lockedCount,
        ...(skippedLeads > 0 ? { skippedLeads } : {}),
      })
    : result;
}

export type ProspectSkipTracePreflight = SkipTracePreflight & {
  dncLockedSkipped: number;
};

export async function preflightProspectSkipTrace(
  selection: PropertySelection,
): Promise<Result<ProspectSkipTracePreflight>> {
  const sel = await resolveSelection(selection);
  if (!sel.ok) return sel;
  const propertyIds = sel.data.ids;
  // Filter selections: requested counts every matched row; matched leads and
  // locked prospects are reported through notEligible / dncLockedSkipped.
  const requested = sel.data.fromFilters ? sel.data.matchedCount : new Set(propertyIds).size;
  const extraDnc = sel.data.dncLockedCount;
  const extraNotEligible = sel.data.skippedLeads + sel.data.dncLockedCount;
  const supabase = await createClient();
  const resolved = await resolveProspectEligibility(
    supabase,
    propertyIds,
    "skip_trace",
  );
  if (resolved.eligibleIds.length === 0) {
    return ok({
      requested,
      eligible: 0,
      cassVerified: 0,
      cassUnverified: 0,
      notEligible: requested,
      killSwitchSkipped: resolved.skipTraceDisabledCount,
      dncLockedSkipped: resolved.dncLockedCount + extraDnc,
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
    requested,
    notEligible: result.data.notEligible + resolved.exclusions.length + extraNotEligible,
    killSwitchSkipped:
      result.data.killSwitchSkipped + resolved.skipTraceDisabledCount,
    dncLockedSkipped: resolved.dncLockedCount + extraDnc,
  });
}

export type ProspectSkipTraceOutcome = SkipTraceOutcome & {
  dncLockedSkipped: number;
};

export async function requestProspectSkipTrace(
  selection: PropertySelection,
): Promise<Result<ProspectSkipTraceOutcome>> {
  const sel = await resolveSelection(selection);
  if (!sel.ok) return sel;
  const propertyIds = sel.data.ids;
  const requested = sel.data.fromFilters ? sel.data.matchedCount : new Set(propertyIds).size;
  const extraDnc = sel.data.dncLockedCount;
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
      requested,
      eligible: 0,
      cassSkipped: 0,
      killSwitchSkipped: resolved.skipTraceDisabledCount,
      dncLockedSkipped: resolved.dncLockedCount + extraDnc,
    });
  }
  const result = await requestSkipTraceUnsafe(resolved.eligibleIds);
  if (!result.ok) return result;
  return ok({
    ...result.data,
    requested,
    killSwitchSkipped:
      result.data.killSwitchSkipped + resolved.skipTraceDisabledCount,
    dncLockedSkipped: resolved.dncLockedCount + extraDnc,
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
  const ids = await selectAllMatching(
    {
      search: params.search,
      blockStack: params.blockStack,
      imported: params.imported ?? null,
      origin: params.origin,
    },
    { enforceCap: true },
  );
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
