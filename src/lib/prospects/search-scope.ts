/**
 * One query context for every list / count / selection path that reads the
 * Prospects (now "Search") page set.
 *
 * `QueryOrigin`:
 *  - `'legacy'` (DEFAULT) is byte-for-byte what the Prospects page, saved
 *    campaign audiences and Leads-side bulk tag did before the Search page:
 *    `status = prospect OR is_dnc_locked` unless a pipeline_status block is
 *    present, an UNESCAPED `ilike('address', %search%)`, no training filter,
 *    uncapped keyset select-all. Do not "improve" it: campaign audience
 *    snapshots and DNC-safe callers depend on the exact predicates.
 *  - `'search_page'`: every status (D2), training rows hidden (D4), a search of
 *    3+ characters goes through `public.search_properties` (names, phones,
 *    emails, address parts, SMS text), 1-2 characters fall back to an ESCAPED
 *    address ilike, empty means plain `from('properties')`.
 *
 * Origin is client-supplied but only chooses matching semantics. It can never
 * widen access (RLS and the server-derived `include_messages` are unchanged),
 * and campaign creation/launch always passes `'legacy'` explicitly.
 *
 * `search_properties` must run under the caller's JWT. `auth.uid()` is null
 * for the admin/service client and the function then returns zero rows, so it
 * is never called through `createAdminClient` (a grep test pins this).
 */
import type { SupabaseClient } from "@supabase/supabase-js";

import { getCallerMembershipsOrThrow } from "@/lib/auth/memberships";
import { canAccessMessagesAndLeadsBoard } from "@/lib/auth/surface-access";
import type { Database } from "@/lib/supabase/types";
import { getDayBoundsInZone } from "@/lib/time/zoned";

import type { BlockStack } from "./filter-schema";
import { applyFilters } from "./filter-to-supabase";

export type QueryOrigin = "legacy" | "search_page";

export const SEARCH_RPC_NAME = "search_properties";

/** Searches shorter than this never call the RPC (it returns nothing under 3). */
export const SEARCH_MIN_CHARS = 3;

/**
 * Maximum rows a Search-origin select-all may resolve. Each 1,000-row keyset
 * page is one `search_properties` evaluation, and the ids travel back to the
 * server in a Server Action body (1 MB limit), so this is deliberately
 * conservative. Over the cap is an error with NO partial selection.
 * TODO(volume-tuning): set from the local volume run (stress #9) before release.
 */
export const SEARCH_SELECT_ALL_CAP = 10_000;

export const SEARCH_TOO_BROAD_MESSAGE =
  "Search too broad — try a more specific name, phone or address";
export const SEARCH_DEGRADED_NOTICE =
  "Full search is temporarily unavailable — showing address matches only.";

export function parseQueryOrigin(value: unknown): QueryOrigin {
  return value === "search_page" ? "search_page" : "legacy";
}

/** Escape ILIKE metacharacters (`\\`, `%`, `_`) so input is matched literally. */
export function escapeLikePattern(value: string): string {
  return value.replace(/[\\%_]/g, (ch) => `\\${ch}`);
}

/** The RPC trims and collapses whitespace before its own 3-char check; mirror it. */
export function normalizeSearchTerm(value: string | null | undefined): string {
  return (value ?? "").replace(/\s+/g, " ").trim();
}

export type SearchMode = "none" | "address_short" | "rpc";

export function searchModeFor(
  origin: QueryOrigin,
  search: string | null | undefined,
): SearchMode {
  if (origin === "legacy") return search ? "address_short" : "none";
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
  origin: QueryOrigin;
  select: string;
  selectOpts?: SelectOpts;
  search: string | null;
  blockStack: BlockStack;
  imported?: "today" | null;
  /** Only read for origin 'search_page' + 3+ char search. */
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
 * Build the filtered properties query for an origin. Returns a plain object
 * (not the builder) so `await` never unwraps the thenable builder.
 */
export async function buildScopedQuery(
  supabase: SupabaseClient<Database>,
  args: ScopedQueryArgs,
): Promise<{ builder: Builder; mode: SearchMode }> {
  const hasPipelineStatusBlock = args.blockStack.some(
    (b) => b.kind === "pipeline_status",
  );

  if (args.origin === "legacy") {
    // Byte-for-byte the pre-Search predicates (order included).
    let query: Builder = supabase
      .from("properties")
      .select(args.select, args.selectOpts)
      .is("deleted_at", null);
    if (!hasPipelineStatusBlock) {
      query = query.or("status.eq.prospect,is_dnc_locked.eq.true");
    }
    if (args.search) {
      query = query.ilike("address", `%${args.search}%`);
    }
    query = applyImported(query, args.imported);
    query = (await applyFilters(query, args.blockStack, supabase)).builder;
    return { builder: query, mode: args.search ? "address_short" : "none" };
  }

  let mode = searchModeFor("search_page", args.search);
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
 * Run a search-origin query; when the RPC is missing (PGRST202, e.g. the
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
