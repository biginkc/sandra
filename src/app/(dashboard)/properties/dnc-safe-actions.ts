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

import {
  resolveSelection,
  selectAllMatching,
  type PropertySelection,
  type SelectionFilters,
} from "@/lib/prospects/select-all";

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

// ===========================================================================
// Search page entry points.
//
// Everything above this line is the legacy Prospects behavior and is untouched.
// The `searchPage*` actions below ALWAYS apply Search semantics (leads are
// counted before the DNC split and reported as `skippedLeads`; select-all
// selections are resolved on the server with Search semantics and the cap).
// There is no origin/cap option: the client cannot choose, and the legacy
// actions never gain Search behavior.
// ===========================================================================

async function searchPartition(propertyIds: string[]): Promise<{
  eligible: string[];
  locked: string[];
  skippedLeads: number;
}> {
  const supabase = await createClient();
  const resolved = await resolveProspectEligibility(supabase, propertyIds, "selection");
  return {
    eligible: resolved.eligibleIds,
    // Leads are counted BEFORE the DNC split: a locked lead is a skipped lead and
    // only locked prospects are reported as DNC failures.
    locked: resolved.prospectDncLockedIds,
    skippedLeads: resolved.skippedLeadCount,
  };
}

function withLeadReport(
  outcome: BulkOutcome,
  locked: string[],
  skippedLeads: number,
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

async function runSearchBulkOutcome(
  selection: PropertySelection,
  action: (eligible: string[]) => Promise<Result<BulkOutcome>>,
): Promise<Result<BulkOutcome>> {
  const resolved = await resolveSelection(selection, "search");
  if (!resolved.ok) return resolved;
  let eligible: string[];
  let locked: string[];
  let skippedLeads: number;
  if (resolved.data.fromFilters) {
    ({ ids: eligible, dncLockedIds: locked, skippedLeads } = resolved.data);
  } else {
    ({ eligible, locked, skippedLeads } = await searchPartition(resolved.data.ids));
  }
  if (eligible.length === 0) {
    return ok(withLeadReport({ succeeded: 0, skipped: 0, failed: [] }, locked, skippedLeads));
  }
  const result = await action(eligible);
  return result.ok ? ok(withLeadReport(result.data, locked, skippedLeads)) : result;
}

export async function searchPageAssignLeadsBulk(selection: PropertySelection, userId: string | null) {
  return await runSearchBulkOutcome(selection, (eligible) => assignLeadsBulkUnsafe(eligible, userId));
}

export async function searchPageAddPropertiesToListBulk(selection: PropertySelection, listId: string) {
  return await runSearchBulkOutcome(selection, (eligible) => addPropertiesToListBulkUnsafe(eligible, listId));
}

export async function searchPageRemovePropertiesFromListBulk(selection: PropertySelection, listId: string) {
  return await runSearchBulkOutcome(selection, (eligible) => removePropertiesFromListBulkUnsafe(eligible, listId));
}

export async function searchPageApplyTagBulk(selection: PropertySelection, tagId: string) {
  return await runSearchBulkOutcome(selection, (eligible) => applyTagBulkUnsafe(eligible, tagId));
}

export async function searchPageDeletePropertiesBulk(selection: PropertySelection) {
  return await runSearchBulkOutcome(selection, deletePropertiesBulkUnsafe);
}

/** Checkbox custom-tag create+apply from Search: Search partitioning, leads reported. */
export async function searchPageCreateAndApplyCustomTagBulk(params: {
  name: string;
  color?: string | null;
  propertyIds: string[];
}) {
  const { eligible, locked, skippedLeads } = await searchPartition(params.propertyIds);
  const result = await createAndApplyCustomTagBulkUnsafe({ ...params, propertyIds: eligible });
  if (!result.ok) return result;
  return ok({ ...result.data, outcome: withLeadReport(result.data.outcome, locked, skippedLeads) });
}

/** Select-all custom-tag create+apply from Search: server-resolved, capped, leads reported. */
export async function searchPageCreateAndApplyCustomTagBulkFromFilters(params: {
  name: string;
  color?: string | null;
  filters: SelectionFilters;
}) {
  const resolved = await selectAllMatching(params.filters, "search");
  if (!resolved.ok) return resolved;
  const tagged = await createAndApplyCustomTagBulkUnsafe({
    name: params.name,
    color: params.color ?? null,
    propertyIds: resolved.data.eligibleIds,
  });
  if (!tagged.ok) return tagged;
  return ok({
    ...tagged.data,
    outcome: withLeadReport(
      tagged.data.outcome,
      resolved.data.dncLockedIds ?? [],
      resolved.data.skippedLeads,
    ),
  });
}

export async function searchPageVerifyPropertiesBulk(selection: PropertySelection, requestKey: string) {
  const resolved = await resolveSelection(selection, "search");
  if (!resolved.ok) return resolved;
  let eligible: string[];
  let lockedCount: number;
  let skippedLeads: number;
  if (resolved.data.fromFilters) {
    eligible = resolved.data.ids;
    lockedCount = resolved.data.dncLockedCount;
    skippedLeads = resolved.data.skippedLeads;
  } else {
    const part = await searchPartition(resolved.data.ids);
    eligible = part.eligible;
    lockedCount = part.locked.length;
    skippedLeads = part.skippedLeads;
  }
  if (eligible.length === 0) {
    return { ok: false as const, error: { code: "DNC_LOCKED", message: DNC_LOCK_MESSAGE } };
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

/**
 * CASS verification launched from the skip-trace dialog. For a select-all the
 * CASS-unverified subset is recomputed HERE from the filters (Search semantics,
 * capped); the client's cached id list is never used. Explicit ids are re-checked.
 */
export async function searchPageStartCassVerificationForSkipTrace(
  selection: PropertySelection,
  requestKey: string,
) {
  const resolved = await resolveSelection(selection, "search");
  if (!resolved.ok) return resolved;
  const supabase = await createClient();
  const eligibility = await resolveProspectEligibility(supabase, resolved.data.ids, "skip_trace");
  if (eligibility.eligibleIds.length === 0) {
    return { ok: false as const, error: { code: "DNC_LOCKED", message: DNC_LOCK_MESSAGE } };
  }
  const preflight = await preflightSkipTraceUnsafe(eligibility.eligibleIds);
  if (!preflight.ok) return preflight;
  const toVerify = preflight.data.cassVerificationPropertyIds;
  if (toVerify.length === 0) {
    return { ok: false as const, error: { code: "NOTHING_TO_VERIFY", message: "No addresses need verification." } };
  }
  const result = await verifyPropertiesBulkUnsafe(toVerify, requestKey);
  return result.ok ? ok({ ...result.data, eligibleCount: toVerify.length, lockedCount: eligibility.dncLockedCount }) : result;
}

export async function searchPagePreflightProspectSkipTrace(
  selection: PropertySelection,
): Promise<Result<ProspectSkipTracePreflight>> {
  const sel = await resolveSelection(selection, "search");
  if (!sel.ok) return sel;
  const propertyIds = sel.data.ids;
  // Filter selections: requested counts every matched row; matched leads and locked
  // prospects are reported through notEligible / dncLockedSkipped.
  const requested = sel.data.fromFilters ? sel.data.matchedCount : new Set(propertyIds).size;
  const extraDnc = sel.data.dncLockedCount;
  const extraNotEligible = sel.data.skippedLeads + sel.data.dncLockedCount;
  const supabase = await createClient();
  const resolved = await resolveProspectEligibility(supabase, propertyIds, "skip_trace");
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
    killSwitchSkipped: result.data.killSwitchSkipped + resolved.skipTraceDisabledCount,
    dncLockedSkipped: resolved.dncLockedCount + extraDnc,
  });
}

export async function searchPageRequestProspectSkipTrace(
  selection: PropertySelection,
): Promise<Result<ProspectSkipTraceOutcome>> {
  const sel = await resolveSelection(selection, "search");
  if (!sel.ok) return sel;
  const propertyIds = sel.data.ids;
  const requested = sel.data.fromFilters ? sel.data.matchedCount : new Set(propertyIds).size;
  const extraDnc = sel.data.dncLockedCount;
  const supabase = await createClient();
  const resolved = await resolveProspectEligibility(supabase, propertyIds, "skip_trace");
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
    killSwitchSkipped: result.data.killSwitchSkipped + resolved.skipTraceDisabledCount,
    dncLockedSkipped: resolved.dncLockedCount + extraDnc,
  });
}
