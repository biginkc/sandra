/**
 * The Search page query context: every list / count / selection path of the Search page.
 *
 * Search scope: every status, training rows hidden, a search of 3+ characters goes through
 * `public.search_properties` (names, phones, emails, address parts, SMS text), 1-2 characters
 * fall back to an ESCAPED address ilike, empty means plain `from('properties')`.
 *
 * This module is Search-only. The pre-Search Prospects predicates (prospect-or-DNC status,
 * unescaped address ilike, uncapped) live untouched in the legacy actions; there is no
 * origin/mode switch here for a client to flip.
 *
 * `search_properties` must run under the caller's JWT. `auth.uid()` is null for the
 * admin/service client and the function then returns zero rows, so it is never called through
 * `createAdminClient` (a grep test pins this).
 */
import type { SupabaseClient } from "@supabase/supabase-js";

import { getCallerMembershipsOrThrow } from "@/lib/auth/memberships";
import { canAccessMessagesAndLeadsBoard } from "@/lib/auth/surface-access";
import type { Database } from "@/lib/supabase/types";
import { getDayBoundsInZone } from "@/lib/time/zoned";

import type { BlockStack } from "./filter-schema";
import { applyFilters } from "./filter-to-supabase";

export const SEARCH_RPC_NAME = "search_properties";

/** Searches shorter than this never call the RPC (it returns nothing under 3). */
export const SEARCH_MIN_CHARS = 3;

/**
 * Maximum rows any Search selection (select-all or explicit ids) may resolve. Each 1,000-row keyset
 * page is one `search_properties` evaluation. Measured on the local stack at
 * 50k properties / 250k messages (scripts/search-volume): ~110 ms per page in
 * the worst case (every property matches), so 20 pages (20,000 ids) walk in
 * ~2.3 s against the 10 s budget (4x headroom). The ceiling is the Server
 * Action body limit (1 MB), because the id-based actions (promote, CASS,
 * skip-trace) still send explicit ids: 20,000 uuids is about 0.8 MB. Over the
 * cap is an error with NO partial selection.
 */
export const SEARCH_SELECT_ALL_CAP = 20_000;

export const SEARCH_TOO_BROAD_MESSAGE =
  "Search too broad — try a more specific name, phone or address";
export const SEARCH_DEGRADED_NOTICE =
  "Full search is temporarily unavailable — showing address matches only.";

/** Escape ILIKE metacharacters (`\\`, `%`, `_`) so input is matched literally. */
export function escapeLikePattern(value: string): string {
  return value.replace(/[\\%_]/g, (ch) => `\\${ch}`);
}

/** The RPC trims and collapses whitespace before its own 3-char check; mirror it. */
export function normalizeSearchTerm(value: string | null | undefined): string {
  return (value ?? "").replace(/\s+/g, " ").trim();
}

export type SearchMode = "none" | "address_short" | "rpc";

export function searchModeFor(search: string | null | undefined): SearchMode {
  const q = normalizeSearchTerm(search);
  if (q.length === 0) return "none";
  return q.length >= SEARCH_MIN_CHARS ? "rpc" : "address_short";
}

/**
 * Server-derived, fail-closed. Restricted Acquisitions members mirror the
 * top-bar search rule: they find any property, but never match on (or see)
 * message text. A failed membership lookup throws (MembershipLookupError) and
 * the caller surfaces an error: it never degrades to "unrestricted".
 */
export async function resolveIncludeMessages(): Promise<boolean> {
  return canAccessMessagesAndLeadsBoard(await getCallerMembershipsOrThrow());
}

type SelectOpts = { count?: "exact"; head?: boolean };

export type ScopedQueryArgs = {
  select: string;
  selectOpts?: SelectOpts;
  search: string | null;
  blockStack: BlockStack;
  imported?: "today" | null;
  /** Only read for a 3+ char search. */
  includeMessages?: boolean;
  /** Force the address-only fallback (RPC missing: PGRST202). */
  addressFallback?: boolean;
};

// The PostgREST builder generics are intentionally erased here, exactly like
// filter-to-supabase.ts: only the chain shape is contract-relevant.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Builder = any;

function applyImported(query: Builder, imported: "today" | null | undefined): Builder {
  if (imported !== "today") return query;
  const { dayStart, dayEnd } = getDayBoundsInZone(new Date(), "America/Chicago");
  return query
    .not("source_import_id", "is", null)
    .gte("source_imported_at", dayStart.toISOString())
    .lt("source_imported_at", dayEnd.toISOString());
}

/**
 * Build the filtered Search properties query. Returns a plain object
 * (not the builder) so `await` never unwraps the thenable builder.
 */
export async function buildScopedQuery(
  supabase: SupabaseClient<Database>,
  args: ScopedQueryArgs,
): Promise<{ builder: Builder; mode: SearchMode }> {
  let mode = searchModeFor(args.search);
  if (mode === "rpc" && args.addressFallback) mode = "address_short";
  const q = normalizeSearchTerm(args.search);

  let query: Builder;
  if (mode === "rpc") {
    // count/head are the RPC's third argument; `.select()` takes columns only.
    query = supabase
      .rpc(
        SEARCH_RPC_NAME,
        { q, include_messages: args.includeMessages === true },
        args.selectOpts,
      )
      .select(args.select);
  } else {
    query = supabase
      .from("properties")
      .select(args.select, args.selectOpts)
      .is("deleted_at", null);
    if (mode === "address_short") {
      query = query.ilike("address", `%${escapeLikePattern(q)}%`);
    }
  }
  query = query.eq("is_training", false);
  query = applyImported(query, args.imported);
  query = (await applyFilters(query, args.blockStack, supabase)).builder;
  return { builder: query, mode };
}

type PostgrestErrorLike = { code?: string | null; message?: string } | null;

export type MappedSearchError = {
  code: "SEARCH_TOO_BROAD" | "SEARCH_UNAVAILABLE" | "QUERY_FAILED";
  message: string;
};

/** Statement timeout (57014) becomes the friendly "too broad" message. */
export function mapSearchError(error: PostgrestErrorLike): MappedSearchError | null {
  if (!error) return null;
  if (error.code === "57014") {
    return { code: "SEARCH_TOO_BROAD", message: SEARCH_TOO_BROAD_MESSAGE };
  }
  if (error.code === "PGRST202") {
    return {
      code: "SEARCH_UNAVAILABLE",
      message: SEARCH_DEGRADED_NOTICE,
    };
  }
  return { code: "QUERY_FAILED", message: error.message ?? "Query failed" };
}

/**
 * Run a Search query; when the RPC is missing (PGRST202, e.g. the
 * migration has not been applied yet) rerun it once as an address-only search
 * and report `degraded` so the page can show a small notice.
 */
export async function runWithSearchFallback<
  R extends { error: PostgrestErrorLike },
>(
  run: (opts: { addressFallback: boolean }) => PromiseLike<R>,
): Promise<{ result: R; degraded: boolean }> {
  const first = await run({ addressFallback: false });
  if (first.error?.code !== "PGRST202") return { result: first, degraded: false };
  return { result: await run({ addressFallback: true }), degraded: true };
}
