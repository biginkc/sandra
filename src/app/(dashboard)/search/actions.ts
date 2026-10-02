"use server";

/**
 * The ONLY server entry points the Search page UI may call (enforced by an ESLint
 * no-restricted-imports rule). Every action here:
 *   - takes one object `{ selection: {kind:'ids',ids} | {kind:'filters',filters}, ... }`,
 *     validated strictly (unknown keys rejected; there is no origin/mode/cap field);
 *   - resolves the selection with Search semantics (all statuses, training hidden,
 *     include_messages derived server-side and fail-closed) and requires an active membership;
 *   - rejects more than SEARCH_SELECT_ALL_CAP rows for BOTH selection kinds (no partial selection);
 *   - partitions into {prospects, skippedLeads, DNC-locked prospects} and acts on live,
 *     non-DNC PROSPECTS only, via the legacy worker functions (which are never modified).
 * The legacy Prospects actions stay byte-for-byte as on main; nothing here changes them.
 */

import { getCallerMemberships } from "@/lib/auth/memberships";
import { requireOrgMembership } from "@/lib/auth/require-org-membership";
import { errFromUnknown, ok, type Result } from "@/lib/errors/result";
import { reportError } from "@/lib/errors/report";
import { resolveProspectEligibility } from "@/lib/prospects/eligibility";
import type { BlockStack } from "@/lib/prospects/filter-schema";
import { filterSelectFragment } from "@/lib/prospects/filter-to-supabase";
import { partitionSearchIds } from "@/lib/prospects/search-partition";
import {
  SEARCH_SELECT_ALL_CAP,
  buildScopedQuery,
  mapSearchError,
  resolveIncludeMessages,
  runWithSearchFallback,
} from "@/lib/prospects/search-scope";
import {
  SearchInputError,
  assertKeys,
  parseFilters,
  parseInput,
  parseSelection,
  type SearchSelection,
} from "@/lib/prospects/search-selection-input";
import { isSelectionTokenShape, mintSelectionToken, readSelectionToken } from "@/lib/prospects/selection-token";
import { selectAllSearch, type SelectionFilters } from "@/lib/prospects/select-all";
import {
  preflightSkipTrace as preflightSkipTraceWorker,
  requestSkipTrace as requestSkipTraceWorker,
  type SkipTraceOutcome,
  type SkipTracePreflight,
} from "@/lib/skip-trace/actions";
import { createClient } from "@/lib/supabase/server";

import { listDeliveryOptions, refreshDeliveryCatalog } from "../campaigns/actions";
import {
  addPropertiesToListBulk as addToListWorker,
  applyTagBulk as applyTagWorker,
  assignLeadsBulk as assignWorker,
  createAndApplyCustomTagBulk as customTagWorker,
  deletePropertiesBulk as deleteWorker,
  removePropertiesFromListBulk as removeFromListWorker,
  verifyPropertiesBulk as verifyWorker,
  type BulkOutcome,
  type BulkTagRow,
} from "../leads/actions";
import { createPromoteLeadsJob } from "../properties/promote-leads-actions";
import {
  assessBulkSmsAudience,
  bulkQueueSms,
  countAlreadyContacted,
  createDialerBatchFromPropertyIds,
  listSmsTemplateCategories,
  previewBatchEligibilityAction,
  type BulkSmsOutcome,
} from "../properties/actions";
import type { BulkSmsQueueOpts } from "@/lib/messaging/bulk-queue";
import { SEARCH_SYNC_BULK_SMS_LIMIT, queueSearchSmsDeferred } from "@/lib/messaging/search-bulk-sms";

const DNC_LOCK_MESSAGE = "Prospect is locked Do Not Contact and cannot be changed in bulk.";

export type SearchBulkOutcome = BulkOutcome & { skippedLeads?: number };
type Resolved = {
  prospectIds: string[];
  skippedLeads: number;
  dncLockedIds: string[];
  /** Filters: every row the page lists. Ids: the number of DISTINCT ids submitted (after dedupe). */
  matchedCount: number;
  kind: SearchSelection["kind"];
};

const bad = (e: unknown) =>
  e instanceof SearchInputError
    ? ({ ok: false, error: { code: "INVALID_REQUEST", message: e.message } } as const)
    : null;

async function requireUser(): Promise<string> {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) throw new SearchInputError("Sign in required.");
  const memberships = await getCallerMemberships();
  if (memberships.length === 0) throw new SearchInputError("No active membership.");
  return user.id;
}

/**
 * The one resolver every selection-taking action goes through. Search scope for filters;
 * explicit ids are re-read under RLS. >20,000 is rejected for both kinds.
 */
async function resolveSearchSelection(selection: SearchSelection): Promise<Result<Resolved>> {
  if (selection.kind === "ids") {
    const ids = [...new Set(selection.ids)];
    if (ids.length > SEARCH_SELECT_ALL_CAP) {
      return {
        ok: false,
        error: {
          code: "SELECT_ALL_TOO_LARGE",
          message: `More than ${SEARCH_SELECT_ALL_CAP.toLocaleString()} rows selected. Narrow the selection.`,
        },
      };
    }
    const part = await partitionSearchIds(await createClient(), ids);
    return ok({ ...part, matchedCount: ids.length, kind: "ids" });
  }
  const all = await selectAllSearch(selection.filters);
  if (!all.ok) return all;
  return ok({
    prospectIds: all.data.eligibleIds,
    skippedLeads: all.data.skippedLeads,
    dncLockedIds: all.data.dncLockedIds,
    matchedCount: all.data.matchedCount,
    kind: "filters",
  });
}

/** Why nothing is actionable, as an error a UI can tell apart: leads vs DNC-locked vs plain empty. */
function nothingEligible(r: Resolved) {
  if (r.dncLockedIds.length > 0 && r.prospectIds.length === 0) {
    return { ok: false as const, error: { code: "DNC_LOCKED", message: DNC_LOCK_MESSAGE } };
  }
  if (r.skippedLeads > 0) {
    return {
      ok: false as const,
      error: {
        code: "ONLY_LEADS_SELECTED",
        message: "The selected rows are leads, not prospects. This action applies to prospects only.",
      },
    };
  }
  return { ok: false as const, error: { code: "NO_ELIGIBLE_PROSPECTS", message: "No eligible prospects in the selection." } };
}

async function resolve(selection: SearchSelection): Promise<Result<Resolved>> {
  await requireUser();
  return resolveSearchSelection(selection);
}

function report(r: Resolved, outcome: BulkOutcome): SearchBulkOutcome {
  return {
    ...outcome,
    failed: [
      ...outcome.failed,
      ...r.dncLockedIds.map((propertyId) => ({ propertyId, message: DNC_LOCK_MESSAGE })),
    ],
    ...(r.skippedLeads > 0 ? { skippedLeads: r.skippedLeads } : {}),
  };
}

async function runBulk(
  input: unknown,
  extraKeys: readonly string[],
  surface: string,
  act: (prospectIds: string[], rest: Record<string, unknown>) => Promise<Result<BulkOutcome>>,
): Promise<Result<SearchBulkOutcome>> {
  try {
    const { selection, rest } = parseInput(input, extraKeys);
    const r = await resolve(selection);
    if (!r.ok) return r;
    if (r.data.prospectIds.length === 0) {
      return ok(report(r.data, { succeeded: 0, skipped: 0, failed: [] }));
    }
    const out = await act(r.data.prospectIds, rest);
    return out.ok ? ok(report(r.data, out.data)) : out;
  } catch (e) {
    const b = bad(e);
    if (b) return b;
    reportError(e, { tags: { surface } });
    return errFromUnknown(e, "SEARCH_ACTION_FAILED");
  }
}

const str = (v: unknown, name: string): string => {
  if (typeof v !== "string" || v.length === 0 || v.length > 200) throw new SearchInputError(`${name} must be a non-empty string.`);
  return v;
};

// ---------------------------------------------------------------------------
// Counts and select-all
// ---------------------------------------------------------------------------

/** Live count for the filter drawer (rows the page would show). */
export async function searchCount(input: {
  orgId: string;
  blocks: BlockStack;
  search?: string | null;
  imported?: "today" | null;
}): Promise<Result<{ count: number }>> {
  try {
    const raw = input as unknown as Record<string, unknown>;
    assertKeys(raw, ["orgId", "blocks", "search", "imported"], "request");
    const filters = parseFilters({ search: raw.search ?? null, blockStack: raw.blocks, imported: raw.imported ?? null });
    await requireOrgMembership(str(raw.orgId, "orgId"));
    const sb = await createClient();
    let includeMessages = false;
    try {
      includeMessages = await resolveIncludeMessages();
    } catch {
      return { ok: false, error: { code: "SEARCH_ACCESS_UNAVAILABLE", message: "Membership access could not be verified. Please retry." } };
    }
    const select = ["id", filterSelectFragment(filters.blockStack)].filter(Boolean).join(", ");
    const { result } = await runWithSearchFallback(async (opts) => {
      const { builder } = await buildScopedQuery(sb, {
        select,
        selectOpts: { count: "exact", head: true },
        search: filters.search,
        blockStack: filters.blockStack,
        imported: filters.imported ?? null,
        includeMessages,
        addressFallback: opts.addressFallback,
      });
      return (await builder) as { count: number | null; error: { code?: string | null; message?: string } | null };
    });
    if (result.error) {
      const mapped = mapSearchError(result.error);
      return { ok: false, error: { code: "COUNT_FILTER_FAILED", message: mapped?.message ?? result.error.message ?? "Count failed" } };
    }
    return ok({ count: result.count ?? 0 });
  } catch (e) {
    const b = bad(e);
    if (b) return b;
    reportError(e, { tags: { surface: "search_count" } });
    return errFromUnknown(e, "COUNT_FILTER_FAILED");
  }
}

export type SearchSelectionCounts = {
  matchedCount: number;
  eligibleCount: number;
  dncLockedCount: number;
  skippedLeads: number;
};

/** Counts for "select all matching" (no id list is returned): matched vs actionable prospects. */
export async function searchSelectAllCount(input: { selection: SearchSelection }): Promise<Result<SearchSelectionCounts>> {
  try {
    const { selection } = parseInput(input, []);
    const r = await resolve(selection);
    if (!r.ok) return r;
    return ok({
      matchedCount: r.data.matchedCount,
      eligibleCount: r.data.prospectIds.length,
      dncLockedCount: r.data.dncLockedIds.length,
      skippedLeads: r.data.skippedLeads,
    });
  } catch (e) {
    const b = bad(e);
    if (b) return b;
    reportError(e, { tags: { surface: "search_select_all_count" } });
    return errFromUnknown(e, "SELECT_ALL_FAILED");
  }
}

// ---------------------------------------------------------------------------
// DNC-safe bulk actions (prospects only)
// ---------------------------------------------------------------------------

export async function searchAssign(input: { selection: SearchSelection; userId: string | null }) {
  return runBulk(input, ["userId"], "search_assign", (ids, rest) => {
    if (rest.userId !== null && typeof rest.userId !== "string") throw new SearchInputError("userId must be a string or null.");
    return assignWorker(ids, rest.userId as string | null);
  });
}

export async function searchListAdd(input: { selection: SearchSelection; listId: string }) {
  return runBulk(input, ["listId"], "search_list_add", (ids, rest) => addToListWorker(ids, str(rest.listId, "listId")));
}

export async function searchListRemove(input: { selection: SearchSelection; listId: string }) {
  return runBulk(input, ["listId"], "search_list_remove", (ids, rest) => removeFromListWorker(ids, str(rest.listId, "listId")));
}

export async function searchTag(input: { selection: SearchSelection; tagId: string }) {
  return runBulk(input, ["tagId"], "search_tag", (ids, rest) => applyTagWorker(ids, str(rest.tagId, "tagId")));
}

export async function searchDelete(input: { selection: SearchSelection }) {
  return runBulk(input, [], "search_delete", (ids) => deleteWorker(ids));
}

/** Create a custom tag and apply it to the selection's prospects. */
export async function searchCustomTag(input: {
  selection: SearchSelection;
  name: string;
  color?: string | null;
}): Promise<Result<{ tag: BulkTagRow | null; outcome: SearchBulkOutcome }>> {
  try {
    const { selection, rest } = parseInput(input, ["name", "color"]);
    const name = str(rest.name, "name");
    const color = rest.color === undefined || rest.color === null ? null : str(rest.color, "color");
    const r = await resolve(selection);
    if (!r.ok) return r;
    // Never create a tag that would apply to nothing.
    if (r.data.prospectIds.length === 0) {
      return ok({ tag: null, outcome: report(r.data, { succeeded: 0, skipped: 0, failed: [] }) });
    }
    const tagged = await customTagWorker({ name, color, propertyIds: r.data.prospectIds });
    if (!tagged.ok) return tagged;
    return ok({ ...tagged.data, outcome: report(r.data, tagged.data.outcome) });
  } catch (e) {
    const b = bad(e);
    if (b) return b;
    reportError(e, { tags: { surface: "search_custom_tag" } });
    return errFromUnknown(e, "APPLY_TAG_FAILED");
  }
}

// ---------------------------------------------------------------------------
// Bulk SMS (ad-hoc only; the freeze contains prospects only)
// ---------------------------------------------------------------------------

export async function searchSmsTemplateCategories() {
  await requireUser();
  return listSmsTemplateCategories();
}
export async function searchDeliveryOptions() {
  await requireUser();
  return listDeliveryOptions();
}
export async function searchRefreshDeliveryCatalog() {
  await requireUser();
  return refreshDeliveryCatalog();
}

/** Audience size + line types + already-contacted count for the selection's prospects. */
export async function searchSmsAudience(input: { selection: SearchSelection }) {
  try {
    const { selection } = parseInput(input, []);
    const r = await resolve(selection);
    if (!r.ok) return r;
    const [assessment, contacted] = await Promise.all([
      assessBulkSmsAudience(r.data.prospectIds),
      countAlreadyContacted(r.data.prospectIds),
    ]);
    if (!assessment.ok) return assessment;
    if (!contacted.ok) return contacted;
    return ok({
      ...assessment.data,
      alreadyContacted: contacted.data,
      skippedLeads: r.data.skippedLeads,
      dncLocked: r.data.dncLockedIds.length,
    });
  } catch (e) {
    const b = bad(e);
    if (b) return b;
    reportError(e, { tags: { surface: "search_sms_audience" } });
    return errFromUnknown(e, "AUDIENCE_ASSESSMENT_FAILED");
  }
}

export async function searchBulkSms(input: { selection: SearchSelection; opts: BulkSmsQueueOpts }): Promise<Result<BulkSmsOutcome & { skippedLeads: number }>> {
  try {
    const { selection, rest } = parseInput(input, ["opts"]);
    const opts = rest.opts as Record<string, unknown>;
    if (typeof opts !== "object" || opts === null || Array.isArray(opts)) throw new SearchInputError("opts must be an object.");
    // Ad-hoc only: saved campaigns send their frozen audience through the campaigns flow.
    if ("campaignId" in opts) throw new SearchInputError("Search bulk SMS is ad-hoc only.");
    if (typeof opts.campaignName !== "string" || opts.campaignName.trim() === "") {
      throw new SearchInputError("A campaign name is required.");
    }
    const r = await resolve(selection);
    if (!r.ok) return r;
    if (r.data.prospectIds.length === 0) {
      return ok({ succeeded: 0, skipped: 0, failed: [], skippedLeads: r.data.skippedLeads });
    }
    const smsOpts = opts as unknown as BulkSmsQueueOpts;
    // Up to 500 prospects queue right now (they were partitioned a moment ago). Larger sends are
    // deferred through the Search-owned workflow, which re-validates every chunk to current prospects.
    const sent =
      r.data.prospectIds.length > SEARCH_SYNC_BULK_SMS_LIMIT
        ? await queueSearchSmsDeferred(await createClient(), r.data.prospectIds, smsOpts as BulkSmsQueueOpts & { campaignName: string })
        : await bulkQueueSms(r.data.prospectIds, smsOpts);
    return sent.ok ? ok({ ...sent.data, skippedLeads: r.data.skippedLeads }) : sent;
  } catch (e) {
    const b = bad(e);
    if (b) return b;
    reportError(e, { tags: { surface: "search_bulk_sms" } });
    return errFromUnknown(e, "BULK_SMS_FAILED");
  }
}

// ---------------------------------------------------------------------------
// Dialer
// ---------------------------------------------------------------------------

export async function searchDialerPreview(input: { selection: SearchSelection }) {
  try {
    const { selection } = parseInput(input, []);
    const r = await resolve(selection);
    if (!r.ok) return r;
    const preview = await previewBatchEligibilityAction(r.data.prospectIds);
    if (!preview.ok) return preview;
    const counts = { ...preview.data, blocked: { ...preview.data.blocked } };
    if (r.data.dncLockedIds.length > 0) {
      counts.blocked.dnc_locked = (counts.blocked.dnc_locked ?? 0) + r.data.dncLockedIds.length;
    }
    return ok({ ...counts, skippedLeads: r.data.skippedLeads });
  } catch (e) {
    const b = bad(e);
    if (b) return b;
    reportError(e, { tags: { surface: "search_dialer_preview" } });
    return errFromUnknown(e, "PREVIEW_FAILED");
  }
}

export async function searchDialerCreate(input: { selection: SearchSelection; title?: string }) {
  try {
    const { selection, rest } = parseInput(input, ["title"]);
    const title = rest.title === undefined ? undefined : str(rest.title, "title");
    const r = await resolve(selection);
    if (!r.ok) return r;
    const created = await createDialerBatchFromPropertyIds(r.data.prospectIds, {
      title,
      sourceKind: selection.kind === "filters" ? "filters" : "selected_ids",
      ...(selection.kind === "filters"
        ? { sourceMeta: { surface: "search", search: selection.filters.search, blockStack: selection.filters.blockStack, imported: selection.filters.imported ?? null } }
        : {}),
    });
    if (!created.ok) return created;
    const dncLocked = r.data.dncLockedIds.length;
    const counts =
      dncLocked === 0
        ? created.data.counts
        : { ...created.data.counts, blocked: { ...created.data.counts.blocked, dnc_locked: (created.data.counts.blocked.dnc_locked ?? 0) + dncLocked } };
    return ok({ ...created.data, counts, skippedLeads: r.data.skippedLeads });
  } catch (e) {
    const b = bad(e);
    if (b) return b;
    reportError(e, { tags: { surface: "search_dialer_create" } });
    return errFromUnknown(e, "BATCH_CREATE_FAILED");
  }
}

// ---------------------------------------------------------------------------
// Promote to Lead
// ---------------------------------------------------------------------------

export type SearchPromotePreflight = { selected: number; eligible: number; dncLocked: number; staleOrNotProspect: number };

export async function searchPromotePreflight(input: { orgId: string; selection: SearchSelection }): Promise<Result<SearchPromotePreflight>> {
  try {
    const { selection, rest } = parseInput(input, ["orgId"]);
    const orgId = str(rest.orgId, "orgId");
    await requireOrgMembership(orgId);
    const r = await resolve(selection);
    if (!r.ok) return r;
    return ok({
      selected: r.data.matchedCount,
      eligible: r.data.prospectIds.length,
      dncLocked: r.data.dncLockedIds.length,
      staleOrNotProspect: r.data.skippedLeads,
    });
  } catch (e) {
    const b = bad(e);
    if (b) return b;
    reportError(e, { tags: { surface: "search_promote_preflight" } });
    return errFromUnknown(e, "PROMOTION_PREFLIGHT_FAILED");
  }
}

export async function searchPromoteCreate(input: { orgId: string; selection: SearchSelection; idempotencyKey: string }) {
  try {
    const { selection, rest } = parseInput(input, ["orgId", "idempotencyKey"]);
    const orgId = str(rest.orgId, "orgId");
    const idempotencyKey = str(rest.idempotencyKey, "idempotencyKey");
    await requireOrgMembership(orgId);
    const r = await resolve(selection);
    if (!r.ok) return r;
    const job = await createPromoteLeadsJob({ orgId, propertyIds: r.data.prospectIds, idempotencyKey });
    return job.ok ? ok({ ...job.data, skippedLeads: r.data.skippedLeads, dncLocked: r.data.dncLockedIds.length }) : job;
  } catch (e) {
    const b = bad(e);
    if (b) return b;
    reportError(e, { tags: { surface: "search_promote_create" } });
    return errFromUnknown(e, "PROMOTION_CREATE_FAILED");
  }
}

// ---------------------------------------------------------------------------
// Skip trace and CASS
// ---------------------------------------------------------------------------

export type SearchSkipTracePreflight = SkipTracePreflight & {
  dncLockedSkipped: number;
  /** Addresses a CASS run would verify (the id list itself never leaves the server). */
  cassVerificationCount: number;
  /** Signed server-held handle (filters only, user-bound, 10 min) used to launch CASS for a select-all. */
  selectionToken?: string;
};

export async function searchSkipTracePreflight(input: { selection: SearchSelection }): Promise<Result<SearchSkipTracePreflight>> {
  try {
    const { selection } = parseInput(input, []);
    const userId = await requireUser();
    const r = await resolveSearchSelection(selection);
    if (!r.ok) return r;
    const requested = r.data.matchedCount;
    const extraDnc = r.data.dncLockedIds.length;
    const extraNotEligible = r.data.skippedLeads + extraDnc;
    const supabase = await createClient();
    const el = await resolveProspectEligibility(supabase, r.data.prospectIds, "skip_trace");
    const token = selection.kind === "filters" ? mintSelectionToken({ userId, filters: selection.filters }) : undefined;
    if (el.eligibleIds.length === 0) {
      return ok({
        requested,
        eligible: 0,
        cassVerified: 0,
        cassUnverified: 0,
        notEligible: requested,
        killSwitchSkipped: el.skipTraceDisabledCount,
        dncLockedSkipped: el.dncLockedCount + extraDnc,
        tracefyCreditsRequired: 0,
        tracefyCreditsAvailable: null,
        tracefyCreditStatus: "sufficient",
        canLaunchSkipTrace: false,
        estimatedCassVerificationCostUsd: 0,
        cassVerificationPropertyIds: [],
        cassVerificationCount: 0,
        selectionToken: token,
      });
    }
    const pre = await preflightSkipTraceWorker(el.eligibleIds);
    if (!pre.ok) return pre;
    return ok({
      ...pre.data,
      requested,
      notEligible: pre.data.notEligible + el.exclusions.length + extraNotEligible,
      killSwitchSkipped: pre.data.killSwitchSkipped + el.skipTraceDisabledCount,
      dncLockedSkipped: el.dncLockedCount + extraDnc,
      // The id list the dialog would round-trip is withheld; CASS is launched by token/selection.
      cassVerificationPropertyIds: [],
      cassVerificationCount: pre.data.cassVerificationPropertyIds.length,
      selectionToken: token,
    });
  } catch (e) {
    const b = bad(e);
    if (b) return b;
    reportError(e, { tags: { surface: "search_skip_trace_preflight" } });
    return errFromUnknown(e, "PREFLIGHT_FAILED");
  }
}

export type SearchSkipTraceOutcome = SkipTraceOutcome & { dncLockedSkipped: number };

export async function searchSkipTraceRequest(input: { selection: SearchSelection }): Promise<Result<SearchSkipTraceOutcome>> {
  try {
    const { selection } = parseInput(input, []);
    const r = await resolve(selection);
    if (!r.ok) return r;
    const supabase = await createClient();
    const el = await resolveProspectEligibility(supabase, r.data.prospectIds, "skip_trace");
    const requested = r.data.matchedCount;
    const extraDnc = r.data.dncLockedIds.length;
    if (el.eligibleIds.length === 0) {
      return ok({ jobId: null, status: "none_eligible", requested, eligible: 0, cassSkipped: 0, killSwitchSkipped: el.skipTraceDisabledCount, dncLockedSkipped: el.dncLockedCount + extraDnc });
    }
    const out = await requestSkipTraceWorker(el.eligibleIds);
    if (!out.ok) return out;
    return ok({ ...out.data, requested, killSwitchSkipped: out.data.killSwitchSkipped + el.skipTraceDisabledCount, dncLockedSkipped: el.dncLockedCount + extraDnc });
  } catch (e) {
    const b = bad(e);
    if (b) return b;
    reportError(e, { tags: { surface: "search_skip_trace_request" } });
    return errFromUnknown(e, "SKIP_TRACE_FAILED");
  }
}

/** "Verify address (CASS)" on a selection: verifies the selection's live, non-DNC prospects. */
export async function searchCass(input: { selection: SearchSelection; requestKey: string }) {
  try {
    const { selection, rest } = parseInput(input, ["requestKey"]);
    const requestKey = str(rest.requestKey, "requestKey");
    const r = await resolve(selection);
    if (!r.ok) return r;
    if (r.data.prospectIds.length === 0) return nothingEligible(r.data);
    const out = await verifyWorker(r.data.prospectIds, requestKey);
    return out.ok
      ? ok({ ...out.data, eligibleCount: r.data.prospectIds.length, lockedCount: r.data.dncLockedIds.length, skippedLeads: r.data.skippedLeads })
      : out;
  } catch (e) {
    const b = bad(e);
    if (b) return b;
    reportError(e, { tags: { surface: "search_cass" } });
    return errFromUnknown(e, "CASS_FAILED");
  }
}

/**
 * CASS launched from the skip-trace dialog. The CASS-unverified subset is recomputed HERE:
 * a select-all is re-resolved from the filters held in the signed token (capped); explicit
 * ids are re-read. The client's cached lists are never used.
 */
export async function searchCassForSkipTrace(input: { selection?: SearchSelection; selectionToken?: string; requestKey: string }) {
  try {
    const raw = input as unknown as Record<string, unknown>;
    assertKeys(raw, ["selection", "selectionToken", "requestKey"], "request");
    const requestKey = str(raw.requestKey, "requestKey");
    if ((raw.selection === undefined) === (raw.selectionToken === undefined)) {
      throw new SearchInputError("Provide exactly one of selection or selectionToken.");
    }
    const userId = await requireUser();
    let selection: SearchSelection;
    if (raw.selectionToken !== undefined) {
      if (typeof raw.selectionToken !== "string") throw new SearchInputError("selectionToken is malformed.");
      const read = readSelectionToken(raw.selectionToken, userId);
      if (!read.ok) throw new SearchInputError("Selection expired. Re-open the skip-trace preflight.");
      selection = { kind: "filters", filters: parseFilters(read.filters) };
    } else {
      selection = parseSelection(raw.selection);
    }
    const r = await resolveSearchSelection(selection);
    if (!r.ok) return r;
    const supabase = await createClient();
    const el = await resolveProspectEligibility(supabase, r.data.prospectIds, "skip_trace");
    if (el.eligibleIds.length === 0) return nothingEligible(r.data);
    const pre = await preflightSkipTraceWorker(el.eligibleIds);
    if (!pre.ok) return pre;
    const toVerify = pre.data.cassVerificationPropertyIds;
    if (toVerify.length === 0) {
      return { ok: false as const, error: { code: "NOTHING_TO_VERIFY", message: "No addresses need verification." } };
    }
    const out = await verifyWorker(toVerify, requestKey);
    return out.ok ? ok({ ...out.data, eligibleCount: toVerify.length, lockedCount: r.data.dncLockedIds.length, skippedLeads: r.data.skippedLeads }) : out;
  } catch (e) {
    const b = bad(e);
    if (b) return b;
    reportError(e, { tags: { surface: "search_cass_for_skip_trace" } });
    return errFromUnknown(e, "CASS_FAILED");
  }
}
