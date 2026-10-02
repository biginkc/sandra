/**
 * Pure translator: FilterBlock[] → Supabase predicate chain. The CORRECTNESS
 * CORE of the prospects filter drawer — every block's SQL semantic is
 * encoded here.
 *
 * Contract (D-08, D-09, D-10):
 *  - applyFilters(builder, blocks, sb) returns the builder with predicates
 *    layered on top, in stack order. Across blocks AND. Within multi-select
 *    blocks the combinator is honored: any = .in / all = .in (single-column
 *    collapse, see comment) / not = .not("col","in",...) by default, with
 *    PER-COLUMN null-safe negation (or(col.is.null,col.not.in...)) for
 *    outreach_dispo + source — see applyMultiSelect's nullSafeNot.
 *  - applyBlock(builder, block, sb) is one switch case per kind.
 *  - Soft-delete (.is('deleted_at', null)) is the CALLER's responsibility,
 *    not this function's.
 *  - NO side queries and NO embedded-resource filters. Every block that
 *    depends on child rows (list, tag, list_count, engagement,
 *    has_unread_inbound, has_open_tasks) filters a trigger-maintained
 *    denormalised column on `properties` (migration 20261002110000):
 *    has_inbound_message, has_outbound_message, has_unread_inbound,
 *    has_open_tasks, filter_list_ids, filter_tag_ids, filter_list_count.
 *    Plain columns work identically on `from('properties')` and on a
 *    `setof properties` rpc builder (embedded-resource filters do not work
 *    on rpc builders), never push id lists into the URL, and never read
 *    unbounded row sets (the old pre-fetches were truncated at the
 *    PostgREST row cap). Computed-field functions were tried first and
 *    measured 10x-460x over the legacy baseline at 50k rows.
 *  - The RLS layer is what enforces org-scoping. The cache only counts child
 *    rows in the property's own org.
 *  - `sb` is accepted for API compatibility and is unused.
 *
 * Legacy quirks are PINNED, not corrected (plan §6): engagement `all` with
 * non-sentinel multi-values is the UNION; `all` containing never_contacted
 * or {attempted, replied} matches nothing; NULL outreach_dispo is not
 * opted-out; list_count with a min excludes zero-list properties.
 *
 * Known difference: list_count now counts only property_lists rows in the
 * property's own org (the cache refresh matches org_id). The old
 * property_stack_counts view counted every row regardless of org.
 */

import type { SupabaseClient } from "@supabase/supabase-js";
import { isEffectiveBlock } from "./effective-audience";
import type { FilterBlock, BlockStack, NumRange, TriBool, Combinator } from "./filter-schema";
import type { Database } from "@/lib/supabase/types";

// The translator is intentionally loose on the builder's exact generic
// parameters — the chain shape (eq / in / not / or / gte / lte / is) is
// what's contract-relevant, not the row type. PostgREST builders from
// @supabase/postgrest-js work at runtime; we accept anything with those
// methods.
type ProspectsBuilder = any; // eslint-disable-line @typescript-eslint/no-explicit-any
type SbClient = SupabaseClient<Database>;

// ---------------------------------------------------------------------------
// applyFilters / applyBlock
// ---------------------------------------------------------------------------

// IMPORTANT — Supabase v2 query builders are PromiseLike (`.then` triggers
// query execution). When an async function returns `Promise<Builder>`, JS
// unwraps the inner thenable on `await`, executing the query and replacing
// the builder with its query result. Every async function in this file that
// produces a builder therefore returns `Promise<{ builder }>` (a plain
// non-thenable wrapper). Callers destructure `(await fn(...)).builder`.

type BuilderResult = { builder: ProspectsBuilder };

export async function applyFilters(
  builder: ProspectsBuilder,
  blocks: BlockStack,
  sb: SbClient,
): Promise<BuilderResult> {
  let b: ProspectsBuilder = builder;
  for (const block of blocks) {
    const r = await applyBlock(b, block, sb);
    b = r.builder;
  }
  return { builder: b };
}

// ---------------------------------------------------------------------------
// Select fragments — kept for caller compatibility. Every block now filters
// cache columns, so no block needs an embedded resource and these all
// return null. Callers append a fragment only when non-null.
// ---------------------------------------------------------------------------

export function propertyListsSelectFragment(blocks: BlockStack): string | null {
  void blocks;
  return null;
}

export function propertyTagsSelectFragment(blocks: BlockStack): string | null {
  void blocks;
  return null;
}

export function listCountSelectFragment(blocks: BlockStack): string | null {
  void blocks;
  return null;
}

export function filterSelectFragment(blocks: BlockStack): string | null {
  void blocks;
  return null;
}

export function needsPropertyListsEmbed(blocks: BlockStack): boolean {
  return propertyListsSelectFragment(blocks) !== null;
}

export async function applyBlock(
  builder: ProspectsBuilder,
  block: FilterBlock,
  sb: SbClient,
): Promise<BuilderResult> {
  void sb;
  if (!isEffectiveBlock(block)) return { builder };

  switch (block.kind) {
    case "vacancy":
      return { builder: applyTriBool(builder, "is_vacant", block.tri) };
    case "absentee":
      return { builder: applyTriBool(builder, "absentee_flag", block.tri) };
    case "needs_human_attention":
      return { builder: applyTriBool(builder, "needs_human_attention", block.tri) };

    case "cass":
      return { builder: applyMultiSelect(builder, "cass_status", block.combinator, block.values) };
    case "outreach_dispo":
      return {
        builder: applyMultiSelect(builder, "outreach_dispo", block.combinator, block.values, {
          nullSafeNot: true,
        }),
      };
    case "source":
      return {
        builder: applyMultiSelect(builder, "source", block.combinator, block.values, {
          nullSafeNot: true,
        }),
      };
    case "state":
      return { builder: applyMultiSelect(builder, "state", block.combinator, block.values) };
    case "market":
      return { builder: applyMultiSelect(builder, "market", block.combinator, block.values) };
    case "pipeline_status":
      return { builder: applyMultiSelect(builder, "status", block.combinator, block.values) };
    case "motivation_level":
      return { builder: applyMultiSelect(builder, "motivation_level", block.combinator, block.values) };

    case "beds":
      return { builder: applyNumRange(builder, "beds", block.range) };
    case "baths":
      return { builder: applyNumRange(builder, "baths", block.range) };
    case "year_built":
      return { builder: applyNumRange(builder, "year_built", block.range) };
    case "estimated_value":
      return { builder: applyNumRange(builder, "arv", block.range) };
    case "equity_pct":
      return { builder: applyNumRange(builder, "equity_pct", block.range) };

    case "assignee":
      return { builder: applyAssigneeBlock(builder, block.combinator, block.values) };

    case "created_date":
      return { builder: applyDateMode(builder, "created_at", block.date) };

    // ---------- Cache-column blocks (child-table state) ----------
    case "list":
      return { builder: applyIdSetBlock(builder, "filter_list_ids", block.combinator, block.values) };
    case "tag":
      return { builder: applyIdSetBlock(builder, "filter_tag_ids", block.combinator, block.values) };
    case "list_count":
      return { builder: applyListCountBlock(builder, block.range) };
    case "engagement":
      return { builder: applyEngagementBlock(builder, block) };
    case "has_unread_inbound":
      return { builder: applyTriCache(builder, "has_unread_inbound", block.tri) };
    case "has_open_tasks":
      return { builder: applyTriCache(builder, "has_open_tasks", block.tri) };

    default: {
      const _exhaustive: never = block;
      void _exhaustive;
      return { builder };
    }
  }
}

// ---------------------------------------------------------------------------
// Helpers — pure (no side queries)
// ---------------------------------------------------------------------------

/**
 * Tri-state boolean → predicate chain.
 *  - any: caller-visible no-op (no method call emitted).
 *  - yes: .eq(col, true).
 *  - no:  .or(col.eq.false,col.is.null) — NULL counts as false per SPEC R3.
 */
function applyTriBool(
  builder: ProspectsBuilder,
  col: string,
  tri: TriBool,
): ProspectsBuilder {
  if (tri === "any") return builder;
  if (tri === "yes") return builder.eq(col, true);
  // tri === "no"
  return builder.or(`${col}.eq.false,${col}.is.null`);
}

/**
 * Multi-select combinator → predicate chain on a single column.
 *  - empty values: caller-visible no-op.
 *  - any (OR): .in(col, values).
 *  - all (AND): single-column collapses to "any" (a row can only have one
 *    value at a time on a single column). List/tag override this in their
 *    own helpers via property junctions.
 *  - not (NOT IN): .not(col, "in", "(\"v1\",\"v2\")") — Supabase wants the
 *    list as a parenthesized comma-joined literal; quoting handles values
 *    containing commas (e.g., market = "Jackson, MO").
 */
function applyMultiSelect(
  builder: ProspectsBuilder,
  col: string,
  combinator: Combinator,
  values: string[],
  opts?: {
    /** NULL-safe negation: `not` emits or(col.is.null, col.not.in(...))
     *  so "not X" reads "X is false or UNKNOWN" and NULL rows stay
     *  visible. OPT-IN per column because the right semantics differ:
     *  outreach_dispo NULL = never disposed (must stay visible when
     *  excluding DNC — 11,313/11,317 verified rows were NULL on
     *  2026-06-12 and plain NOT IN hid them all); source NULL =
     *  unknown origin (the filter plan documents null-inclusion).
     *  motivation_level NULL = deliberately UNSCORED — "not hot" must
     *  NOT pull in every unscored prospect, so it keeps plain NOT IN. */
    nullSafeNot?: boolean;
  },
): ProspectsBuilder {
  if (values.length === 0) return builder;
  if (combinator === "all" && values.length > 1) {
    return builder.eq(col, "__sandra_no_match__");
  }
  if (combinator === "not") {
    const quoted = values.map((v) => `"${v}"`).join(",");
    if (opts?.nullSafeNot) {
      return builder.or(`${col}.is.null,${col}.not.in.(${quoted})`);
    }
    return builder.not(col, "in", `(${quoted})`);
  }
  // any + single-value all
  return builder.in(col, values);
}

/**
 * Numeric range → predicate chain.
 *  - both null → no-op.
 *  - min only → .gte.
 *  - max only → .lte.
 *  - both → .gte then .lte (chained AND).
 */
function applyNumRange(
  builder: ProspectsBuilder,
  col: string,
  range: NumRange,
): ProspectsBuilder {
  let b: ProspectsBuilder = builder;
  if (range.min != null) b = b.gte(col, range.min);
  if (range.max != null) b = b.lte(col, range.max);
  return b;
}

/**
 * Date-mode → predicate chain on `created_at` (or whichever column is passed).
 *  - fixed:   .gte(col, from) / .lte(col, to) when each is non-null.
 *  - since N: .gte(col, ISO of (now - N days)).
 *  - prior N: .lte(col, ISO of (now - N days)).
 * "since" / "prior" use Date.now() at call time; rolling per SPEC.
 */
function applyDateMode(
  builder: ProspectsBuilder,
  col: string,
  date: Extract<FilterBlock, { kind: "created_date" }>["date"],
): ProspectsBuilder {
  if (date.mode === "fixed") {
    let b: ProspectsBuilder = builder;
    if (date.from != null) b = b.gte(col, date.from);
    if (date.to != null) b = b.lte(col, date.to);
    return b;
  }
  const cutoff = new Date(Date.now() - date.days * 86400000).toISOString();
  if (date.mode === "since") return builder.gte(col, cutoff);
  // mode === "prior"
  return builder.lte(col, cutoff);
}

/**
 * Assignee block — `assigned_user_id` plus the "unassigned" sentinel which
 * maps to .is(assigned_user_id, null).
 *  - empty: no-op.
 *  - mixed (UUIDs + "unassigned"): .or(assigned_user_id.is.null,assigned_user_id.in.(...)).
 *  - "unassigned" only: .is(assigned_user_id, null).
 *  - UUIDs only:        .in(assigned_user_id, [...]).
 *  - not + UUIDs:       .not(assigned_user_id, in, "(...)").
 */
function applyAssigneeBlock(
  builder: ProspectsBuilder,
  combinator: Combinator,
  values: string[],
): ProspectsBuilder {
  if (values.length === 0) return builder;
  const hasUnassigned = values.includes("unassigned");
  const uuids = values.filter((v) => v !== "unassigned");

  if (combinator === "not") {
    let b = builder;
    if (hasUnassigned) {
      b = b.not("assigned_user_id", "is", null);
    }
    if (uuids.length > 0) {
      b = b.not(
        "assigned_user_id",
        "in",
        `(${uuids.map((v) => `"${v}"`).join(",")})`,
      );
    }
    return b;
  }

  if (hasUnassigned && uuids.length === 0) {
    return builder.is("assigned_user_id", null);
  }
  if (hasUnassigned && uuids.length > 0) {
    return builder.or(
      `assigned_user_id.is.null,assigned_user_id.in.(${uuids.join(",")})`,
    );
  }
  // UUIDs only
  return builder.in("assigned_user_id", uuids);
}

// ---------------------------------------------------------------------------
// Cache-column blocks. The columns are trigger-maintained denormalisations on
// public.properties (migration 20261002110000_properties_filter_cache_
// columns.sql); they are never NULL, so plain eq / not / overlaps are safe.
// ---------------------------------------------------------------------------

// `properties.id` is a uuid column. A fake string sentinel makes PostgREST
// return 400 before the query can evaluate, so use a valid UUID that is
// outside the generated-id space and therefore matches no real row.
const NO_MATCH_SENTINEL = ["00000000-0000-0000-0000-000000000000"];

/** Tri-state over a never-null boolean cache column: yes = true, no = false. */
function applyTriCache(
  builder: ProspectsBuilder,
  column: "has_unread_inbound" | "has_open_tasks",
  tri: TriBool,
): ProspectsBuilder {
  if (tri === "any") return builder;
  return builder.eq(column, tri === "yes");
}

/**
 * List / tag blocks over a uuid[] cache column (filter_list_ids /
 * filter_tag_ids; '{}' when none, never NULL).
 *  - any:                 overlaps
 *  - all, single value:   overlaps (same as contains)
 *  - all, multiple:       contains — must carry every value
 *  - not:                 NOT overlaps — none of the values
 */
function applyIdSetBlock(
  builder: ProspectsBuilder,
  column: "filter_list_ids" | "filter_tag_ids",
  combinator: Combinator,
  values: string[],
): ProspectsBuilder {
  if (values.length === 0) return builder;
  // supabase-js formats an array value as the `{a,b}` literal PostgREST wants.
  if (combinator === "not") return builder.not(column, "ov", `{${values.join(",")}}`);
  if (combinator === "all" && values.length > 1) return builder.contains(column, values);
  return builder.overlaps(column, values);
}

/**
 * List Count block over filter_list_count. Legacy semantics, pinned:
 *  - min set: the old `!inner` join on property_stack_counts only has rows
 *    for properties on ≥1 list, so zero-list properties never match even
 *    when min is 0 → effective lower bound is max(min, 1).
 *  - max only: zero-list properties DO match (count ≤ max).
 */
function applyListCountBlock(
  builder: ProspectsBuilder,
  range: NumRange,
): ProspectsBuilder {
  if (range.min == null && range.max == null) return builder;
  let b = builder;
  if (range.min != null) b = b.gte("filter_list_count", Math.max(range.min, 1));
  if (range.max != null) b = b.lte("filter_list_count", range.max);
  return b;
}

/**
 * Engagement block — 4 buckets over the has_inbound_message /
 * has_outbound_message cache booleans plus the outreach_dispo column:
 *   replied         → has_inbound_message
 *   attempted       → has_outbound_message AND NOT has_inbound_message
 *   never_contacted → neither
 *   opted_out       → outreach_dispo IN ('opted_out','dnc')
 *
 * Translation table (plan §6, 45 cases pinned by a committed fixture):
 *  - all + {never_contacted ∈ V, or attempted & replied ⊆ V} → matches nothing.
 *  - all + single value → same as any + single.
 *  - all + other multi  → UNION (legacy quirk, not intersection).
 *  - any → union of the per-value predicates.
 *  - not → rows outside the union: every state is negated and ANDed; opted_out
 *          negates to (outreach_dispo IS NULL OR NOT IN opted set). NULL
 *          dispo is NOT opted-out.
 */
const OPTED_OUT_DISPOS = ["opted_out", "dnc"];

type EngagementBucket = "replied" | "attempted" | "never_contacted";

/** Positive predicate for one state, as a PostgREST logic-tree term. */
const STATE_TERM: Record<EngagementBucket, string> = {
  replied: "has_inbound_message.eq.true",
  attempted: "and(has_outbound_message.eq.true,has_inbound_message.eq.false)",
  never_contacted: "and(has_inbound_message.eq.false,has_outbound_message.eq.false)",
};

/** Negate one state on the builder (a row is outside the state). */
function excludeState(builder: ProspectsBuilder, st: EngagementBucket): ProspectsBuilder {
  switch (st) {
    case "replied":
      return builder.eq("has_inbound_message", false);
    case "attempted":
      return builder.or("has_outbound_message.eq.false,has_inbound_message.eq.true");
    case "never_contacted":
      return builder.or("has_inbound_message.eq.true,has_outbound_message.eq.true");
  }
}

function applyEngagementBlock(
  builder: ProspectsBuilder,
  block: Extract<FilterBlock, { kind: "engagement" }>,
): ProspectsBuilder {
  const values = Array.from(new Set(block.values));
  if (values.length === 0) return builder;

  if (block.combinator === "all") {
    if (
      values.includes("never_contacted") ||
      (values.includes("attempted") && values.includes("replied"))
    ) {
      return builder.in("id", NO_MATCH_SENTINEL);
    }
  }

  const states = values.filter((v) => v !== "opted_out") as EngagementBucket[];
  const hasOptedOut = values.includes("opted_out");
  const optedSet = OPTED_OUT_DISPOS.join(",");

  if (block.combinator === "not") {
    let b = builder;
    for (const st of states) b = excludeState(b, st);
    if (hasOptedOut) {
      b = b.or(`outreach_dispo.is.null,outreach_dispo.not.in.(${optedSet})`);
    }
    return b;
  }

  // any, and all (non-sentinel): union of the per-value predicates.
  if (states.length === 0) {
    return builder.in("outreach_dispo", OPTED_OUT_DISPOS);
  }
  if (!hasOptedOut && states.length === 1) {
    switch (states[0]) {
      case "replied":
        return builder.eq("has_inbound_message", true);
      case "attempted":
        return builder.eq("has_outbound_message", true).eq("has_inbound_message", false);
      case "never_contacted":
        return builder.eq("has_inbound_message", false).eq("has_outbound_message", false);
    }
  }
  const terms = states.map((st) => STATE_TERM[st]);
  if (hasOptedOut) terms.push(`outreach_dispo.in.(${optedSet})`);
  return builder.or(terms.join(","));
}
