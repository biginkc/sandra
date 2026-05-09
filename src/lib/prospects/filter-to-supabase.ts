/**
 * Pure (modulo pre-fetch side queries) translator: FilterBlock[] → Supabase
 * predicate chain. The CORRECTNESS CORE of Phase 05's prospects filter
 * drawer — every block's SQL semantic is encoded here.
 *
 * Contract (D-08, D-09, D-10):
 *  - applyFilters(builder, blocks, sb) returns the builder with predicates
 *    layered on top, in stack order. Across blocks AND. Within multi-select
 *    blocks the combinator is honored: any = .in / all = .in (single-column
 *    collapse, see comment) / not = .not("col","in",...).
 *  - applyBlock(builder, block, sb) is one switch case per kind.
 *  - Soft-delete (.is('deleted_at', null)) is the CALLER's responsibility,
 *    not this function's. The base query in page.tsx adds it before the
 *    translator runs.
 *  - Pre-fetch helpers (list, list_count, engagement, has_unread_inbound,
 *    has_open_tasks, tag) issue a side query through the supabase client
 *    `sb`, then layer .in("id", ids) on the main builder. When the pre-fetch
 *    yields zero IDs, the helper short-circuits with an impossible-but-valid
 *    UUID so the page renders 0 rows instead of erroring on an empty .in()
 *    list or sending an invalid UUID to PostgREST.
 *  - The RLS layer (migration 054) is what enforces org-scoping; this file
 *    never bypasses it. The supabase client passed in is the user-bound
 *    client from src/lib/supabase/server.ts.
 *
 * Performance notes:
 *  - Engagement 4-bucket logic uses two messages reads + JS set arithmetic.
 *    v1 perf-acceptable at 1,462 prospects; denorm at 10k.
 *  - List Count uses the indexed `property_stack_counts` view (not a
 *    correlated subquery). Two round-trips, single-digit ms each at v1.
 *  - equity_pct relies on the stored generated column from migration 057;
 *    the partial index `idx_properties_equity_pct` makes the .gte/.lte
 *    bounded — no JS post-fetch, no broken counts.
 */

import type { SupabaseClient } from "@supabase/supabase-js";
import type { FilterBlock, BlockStack, NumRange, TriBool, Combinator } from "./filter-schema";
import type { Database } from "@/lib/supabase/types";

// The translator is intentionally loose on the builder's exact generic
// parameters — the chain shape (eq / in / not / or / gte / lte / is) is
// what's contract-relevant, not the row type. PostgrestFilterBuilder<...>
// from @supabase/postgrest-js works at runtime; we accept anything with
// those methods.
type ProspectsBuilder = any; // eslint-disable-line @typescript-eslint/no-explicit-any
type SbClient = SupabaseClient<Database>;

// ---------------------------------------------------------------------------
// applyFilters / applyBlock
// ---------------------------------------------------------------------------

// IMPORTANT — Supabase v2 query builders are PromiseLike (`.then` triggers
// query execution). When an async function returns `Promise<Builder>`, JS
// unwraps the inner thenable on `await`, executing the query and replacing
// the builder with its query result. This breaks any subsequent chain like
// `.order().range()` on the caller side.
//
// Workaround: every async function in this file that produces a builder
// returns `Promise<{ builder }>` (a plain non-thenable wrapper). Callers
// destructure `(await fn(...)).builder` to retrieve the chainable builder
// without triggering the thenable. Sync helpers can return the builder
// directly because no Promise is involved.

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

export function propertyListsSelectFragment(blocks: BlockStack): string | null {
  const needsPositiveListJoin = blocks.some(
    (block) =>
      block.kind === "list" &&
      block.values.length > 0 &&
      (block.combinator === "any" ||
        (block.combinator === "all" && block.values.length === 1)),
  );
  const needsAntiListJoin = blocks.some(
    (block) =>
      block.kind === "list" &&
      block.values.length > 0 &&
      block.combinator === "not",
  );

  const fragments: string[] = [];
  if (needsPositiveListJoin) {
    fragments.push("list_filter:property_lists!inner(list_id)");
  }
  if (needsAntiListJoin) {
    fragments.push("list_exclusion:property_lists(list_id)");
  }
  return fragments.length > 0 ? fragments.join(", ") : null;
}

export function filterSelectFragment(blocks: BlockStack): string | null {
  const fragments = new Set<string>();
  const listFragment = propertyListsSelectFragment(blocks);
  if (listFragment) fragments.add(listFragment);

  for (const block of blocks) {
    if (block.kind !== "engagement" || block.combinator !== "any") continue;

    if (isEngagedContactedBlock(block)) {
      fragments.add("contacted_messages:messages!inner(direction)");
      continue;
    }

    if (block.values.length !== 1) continue;
    const bucket = block.values[0];
    if (bucket === "never_contacted") {
      fragments.add("contact_messages:messages()");
    } else if (bucket === "replied") {
      fragments.add("replied_messages:messages!inner(direction)");
    } else if (bucket === "attempted") {
      fragments.add("attempted_outbound:messages!inner(direction)");
      fragments.add("attempted_inbound:messages(direction)");
    }
  }

  return fragments.size > 0 ? Array.from(fragments).join(", ") : null;
}

export function needsPropertyListsEmbed(blocks: BlockStack): boolean {
  return propertyListsSelectFragment(blocks) !== null;
}

function isEngagedContactedBlock(
  block: Extract<FilterBlock, { kind: "engagement" }>,
): boolean {
  return (
    block.values.length === 2 &&
    block.values.includes("attempted") &&
    block.values.includes("replied")
  );
}

export async function applyBlock(
  builder: ProspectsBuilder,
  block: FilterBlock,
  sb: SbClient,
): Promise<BuilderResult> {
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
      return { builder: applyMultiSelect(builder, "outreach_dispo", block.combinator, block.values) };
    case "source":
      return { builder: applyMultiSelect(builder, "source", block.combinator, block.values) };
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

    // ---------- Pre-fetch blocks (each returns BuilderResult) ----------
    case "list":
      return await applyListBlock(builder, block, sb);
    case "tag":
      return await applyTagBlock(builder, block, sb);
    case "list_count":
      return await applyListCountBlock(builder, block, sb);
    case "engagement":
      return await applyEngagementBlock(builder, block, sb);
    case "has_unread_inbound":
      return await applyHasUnreadInboundBlock(builder, block.tri, sb);
    case "has_open_tasks":
      return await applyHasOpenTasksBlock(builder, block.tri, sb);

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
): ProspectsBuilder {
  if (values.length === 0) return builder;
  if (combinator === "not") {
    return builder.not(col, "in", `(${values.map((v) => `"${v}"`).join(",")})`);
  }
  // any + all (single-column) both → .in
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
    // "Doesn't include" semantics: NOT IN the UUIDs, AND not unassigned if
    // unassigned was selected. v1 keeps it simple — emit .not on UUIDs only;
    // including "unassigned" in a NOT clause is uncommon and we'd need a
    // compound predicate; revisit if requested.
    if (uuids.length === 0) return builder;
    return builder.not(
      "assigned_user_id",
      "in",
      `(${uuids.map((v) => `"${v}"`).join(",")})`,
    );
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
// Pre-fetch helpers — issue a side query, then .in("id", ids) on the main
// builder. On empty results, short-circuit with a valid UUID that matches no row.
// ---------------------------------------------------------------------------

// `properties.id` is a uuid column. A fake string sentinel makes PostgREST
// return 400 Bad Request before the query can evaluate, so use a valid UUID
// that is outside the generated-id space and therefore matches no real row.
const NO_MATCH_SENTINEL = ["00000000-0000-0000-0000-000000000000"];

/**
 * List block — properties on (any/all/not) the selected lists.
 * Pre-fetches `property_lists` rows for the selected list_ids, then groups
 * by property to compute set membership per `combinator`.
 */
async function applyListBlock(
  builder: ProspectsBuilder,
  block: Extract<FilterBlock, { kind: "list" }>,
  sb: SbClient,
): Promise<BuilderResult> {
  if (block.values.length === 0) return { builder };

  if (block.combinator === "any") {
    return { builder: builder.in("list_filter.list_id", block.values) };
  }

  if (block.combinator === "all" && block.values.length === 1) {
    return { builder: builder.in("list_filter.list_id", block.values) };
  }

  if (block.combinator === "not") {
    return {
      builder: builder
        .in("list_exclusion.list_id", block.values)
        .is("list_exclusion", null),
    };
  }

  const { data } = await sb
    .from("property_lists")
    .select("property_id, list_id")
    .in("list_id", block.values);

  const byProp = new Map<string, Set<string>>();
  for (const r of (data ?? []) as Array<{ property_id: string; list_id: string }>) {
    if (!byProp.has(r.property_id)) byProp.set(r.property_id, new Set());
    byProp.get(r.property_id)!.add(r.list_id);
  }

  const propIds: string[] = [];
  if (block.combinator === "all") {
    for (const [pid, set] of byProp) {
      if (block.values.every((v) => set.has(v))) propIds.push(pid);
    }
    return {
      builder: propIds.length
        ? builder.in("id", propIds)
        : builder.in("id", NO_MATCH_SENTINEL),
    };
  }
  // any
  for (const [pid] of byProp) propIds.push(pid);
  return {
    builder: propIds.length
      ? builder.in("id", propIds)
      : builder.in("id", NO_MATCH_SENTINEL),
  };
}

/**
 * Tag block — same shape as list, on `property_tags`. Custom-only filtering
 * is enforced by the picker (tags.category = 'custom'); not by this fn.
 */
async function applyTagBlock(
  builder: ProspectsBuilder,
  block: Extract<FilterBlock, { kind: "tag" }>,
  sb: SbClient,
): Promise<BuilderResult> {
  if (block.values.length === 0) return { builder };

  const { data } = await sb
    .from("property_tags")
    .select("property_id, tag_id")
    .in("tag_id", block.values);

  const byProp = new Map<string, Set<string>>();
  for (const r of (data ?? []) as Array<{ property_id: string; tag_id: string }>) {
    if (!byProp.has(r.property_id)) byProp.set(r.property_id, new Set());
    byProp.get(r.property_id)!.add(r.tag_id);
  }

  const propIds: string[] = [];
  if (block.combinator === "all") {
    for (const [pid, set] of byProp) {
      if (block.values.every((v) => set.has(v))) propIds.push(pid);
    }
    return {
      builder: propIds.length
        ? builder.in("id", propIds)
        : builder.in("id", NO_MATCH_SENTINEL),
    };
  }
  if (block.combinator === "not") {
    for (const [pid] of byProp) propIds.push(pid);
    return {
      builder: propIds.length
        ? builder.not("id", "in", `(${propIds.map((id) => `"${id}"`).join(",")})`)
        : builder,
    };
  }
  // any
  for (const [pid] of byProp) propIds.push(pid);
  return {
    builder: propIds.length
      ? builder.in("id", propIds)
      : builder.in("id", NO_MATCH_SENTINEL),
  };
}

/**
 * List Count block — uses `property_stack_counts` view (migration 011),
 * indexed on (property_id) since the view aggregates from `property_lists`.
 * Two-step: query the view for matching property_ids, then .in() the main
 * builder. At v1 (1,462 prospects) the view scan is sub-50ms.
 */
async function applyListCountBlock(
  builder: ProspectsBuilder,
  block: Extract<FilterBlock, { kind: "list_count" }>,
  sb: SbClient,
): Promise<BuilderResult> {
  const min = block.range.min ?? 1;
  const max = block.range.max ?? 999999;

  const { data } = await sb
    .from("property_stack_counts")
    .select("property_id")
    .gte("stack_count", min)
    .lte("stack_count", max);

  const ids = ((data ?? []) as Array<{ property_id: string }>).map((r) => r.property_id);
  return {
    builder: ids.length
      ? builder.in("id", ids)
      : builder.in("id", NO_MATCH_SENTINEL),
  };
}

/**
 * Engagement block — 4 buckets:
 *   never_contacted → no inbound + no outbound message rows
 *   attempted       → ≥1 outbound, no inbound
 *   replied         → ≥1 inbound
 *   opted_out       → outreach_dispo IN ('opted_out', 'dnc') (per migration 045)
 *
 * v1 perf-acceptable at 1,462 prospects; denorm at 10k. Implementation
 * fetches all message direction rows, computes set membership in JS,
 * applies .in("id", union) for "any" / .not("id","in",union) for "not".
 *
 * For the opted_out bucket, no messages query is needed — outreach_dispo
 * is on `properties` directly, but mixing column predicates with the .in
 * pattern from other buckets gets messy. v1 simplification: pre-fetch the
 * properties whose outreach_dispo is in the opt-out set and union with the
 * messages-derived sets.
 */
async function applyEngagementBlock(
  builder: ProspectsBuilder,
  block: Extract<FilterBlock, { kind: "engagement" }>,
  sb: SbClient,
): Promise<BuilderResult> {
  if (block.values.length === 0) return { builder };

  if (block.combinator === "any" && block.values.length === 1) {
    const onlyBucket = block.values[0];
    if (onlyBucket === "never_contacted") {
      return { builder: builder.is("contact_messages", null) };
    }
    if (onlyBucket === "replied") {
      return { builder: builder.eq("replied_messages.direction", "inbound") };
    }
    if (onlyBucket === "attempted") {
      return {
        builder: builder
          .eq("attempted_outbound.direction", "outbound")
          .eq("attempted_inbound.direction", "inbound")
          .is("attempted_inbound", null),
      };
    }
    if (onlyBucket === "opted_out") {
      return { builder: builder.in("outreach_dispo", ["opted_out", "dnc"]) };
    }
  }

  if (block.combinator === "any" && isEngagedContactedBlock(block)) {
    return {
      builder: builder.in("contacted_messages.direction", [
        "inbound",
        "outbound",
      ]),
    };
  }

  const wantedBuckets = new Set(block.values);

  // Pre-fetch all messages with a property_id so we can categorize.
  const { data: msgs } = await sb
    .from("messages")
    .select("property_id, direction")
    .not("property_id", "is", null);

  const inboundPids = new Set<string>();
  const outboundPids = new Set<string>();
  for (const m of (msgs ?? []) as Array<{ property_id: string | null; direction: string }>) {
    if (!m.property_id) continue;
    if (m.direction === "inbound") inboundPids.add(m.property_id);
    else if (m.direction === "outbound") outboundPids.add(m.property_id);
  }

  // Pre-fetch opted-out / dnc properties if the bucket is requested.
  let optedPids = new Set<string>();
  if (wantedBuckets.has("opted_out")) {
    const { data: optRows } = await sb
      .from("properties")
      .select("id")
      .in("outreach_dispo", ["opted_out", "dnc"]);
    optedPids = new Set(
      ((optRows ?? []) as Array<{ id: string }>).map((r) => r.id),
    );
  }

  // Compute per-bucket sets.
  const repliedPids = inboundPids;
  const attemptedPids = new Set<string>();
  for (const pid of outboundPids) {
    if (!inboundPids.has(pid)) attemptedPids.add(pid);
  }
  // never_contacted = NOT in inbound AND NOT in outbound. We can't enumerate
  // this set without a properties query; instead, we use the negation
  // strategy: collect the union of contacted-or-replied as the EXCLUDED set,
  // then apply .not("id","in", ...) for the never_contacted bucket alone.
  // For combinator='any' across multiple buckets including never_contacted,
  // we OR in JS by computing the inclusion set per bucket and unioning.
  // never_contacted's inclusion set = "all properties minus contacted union".
  // To avoid a properties enumeration, we represent never_contacted by
  // applying .not("id","in", contactedUnion) directly; if the user combines
  // it with other buckets, we promote to a properties enumeration.

  const contactedUnion = new Set<string>([...inboundPids, ...outboundPids]);

  // Single-bucket fast paths
  if (block.values.length === 1) {
    const onlyBucket = block.values[0];
    if (onlyBucket === "replied") {
      const ids = [...repliedPids];
      return {
        builder: ids.length
          ? (block.combinator === "not"
              ? builder.not("id", "in", `(${ids.map((id) => `"${id}"`).join(",")})`)
              : builder.in("id", ids))
          : (block.combinator === "not"
              ? builder
              : builder.in("id", NO_MATCH_SENTINEL)),
      };
    }
    if (onlyBucket === "attempted") {
      const ids = [...attemptedPids];
      return {
        builder: ids.length
          ? (block.combinator === "not"
              ? builder.not("id", "in", `(${ids.map((id) => `"${id}"`).join(",")})`)
              : builder.in("id", ids))
          : (block.combinator === "not"
              ? builder
              : builder.in("id", NO_MATCH_SENTINEL)),
      };
    }
    if (onlyBucket === "opted_out") {
      const ids = [...optedPids];
      return {
        builder: ids.length
          ? (block.combinator === "not"
              ? builder.not("id", "in", `(${ids.map((id) => `"${id}"`).join(",")})`)
              : builder.in("id", ids))
          : (block.combinator === "not"
              ? builder
              : builder.in("id", NO_MATCH_SENTINEL)),
      };
    }
    // never_contacted only — apply .not on contactedUnion. No need to
    // enumerate the universe.
    if (onlyBucket === "never_contacted") {
      const excluded = [...contactedUnion];
      if (block.combinator === "not") {
        // "not never_contacted" === "contacted in some way" → .in
        return {
          builder: excluded.length
            ? builder.in("id", excluded)
            : builder.in("id", NO_MATCH_SENTINEL),
        };
      }
      return {
        builder: excluded.length
          ? builder.not(
              "id",
              "in",
              `(${excluded.map((id) => `"${id}"`).join(",")})`,
            )
          : builder, // no contacted properties → all rows are never_contacted
      };
    }
  }

  // Multi-bucket case (combinator any/all): compute the inclusion union.
  // For never_contacted in a multi-bucket selection we'd need to enumerate
  // the universe; pre-fetch all property_ids (RLS-scoped, soft-delete
  // filtered) once.
  const includeIds = new Set<string>();
  let needsUniverse = false;
  for (const bucket of block.values) {
    if (bucket === "replied") for (const id of repliedPids) includeIds.add(id);
    else if (bucket === "attempted") for (const id of attemptedPids) includeIds.add(id);
    else if (bucket === "opted_out") for (const id of optedPids) includeIds.add(id);
    else if (bucket === "never_contacted") needsUniverse = true;
  }

  if (needsUniverse) {
    const { data: allRows } = await sb
      .from("properties")
      .select("id")
      .is("deleted_at", null);
    for (const r of (allRows ?? []) as Array<{ id: string }>) {
      if (!contactedUnion.has(r.id)) includeIds.add(r.id);
    }
  }

  const ids = [...includeIds];
  if (block.combinator === "not") {
    return {
      builder: ids.length
        ? builder.not("id", "in", `(${ids.map((id) => `"${id}"`).join(",")})`)
        : builder,
    };
  }
  return {
    builder: ids.length
      ? builder.in("id", ids)
      : builder.in("id", NO_MATCH_SENTINEL),
  };
}

/**
 * Has Unread Inbound block — uses the index `idx_messages_unread_inbound`
 * (per CONTEXT line 21) — direction='inbound' AND read_at IS NULL.
 * tri-state: any = no-op, yes = .in(id, unread_pids), no = .not on the set.
 */
async function applyHasUnreadInboundBlock(
  builder: ProspectsBuilder,
  tri: TriBool,
  sb: SbClient,
): Promise<BuilderResult> {
  if (tri === "any") return { builder };

  const { data } = await sb
    .from("messages")
    .select("property_id")
    .eq("direction", "inbound")
    .is("read_at", null)
    .not("property_id", "is", null);

  const ids = Array.from(
    new Set(
      ((data ?? []) as Array<{ property_id: string | null }>)
        .map((r) => r.property_id)
        .filter((x): x is string => typeof x === "string"),
    ),
  );

  if (tri === "yes") {
    return {
      builder: ids.length
        ? builder.in("id", ids)
        : builder.in("id", NO_MATCH_SENTINEL),
    };
  }
  // tri === "no"
  if (ids.length === 0) return { builder }; // empty negative set → no predicate
  return {
    builder: builder.not("id", "in", `(${ids.map((id) => `"${id}"`).join(",")})`),
  };
}

/**
 * Has Open Tasks block — uses `tasks` (migration 051), indexed by
 * `idx_tasks_assignee_open_due` partial-on-status='open'. We filter by
 * status only; the index covers the predicate.
 */
async function applyHasOpenTasksBlock(
  builder: ProspectsBuilder,
  tri: TriBool,
  sb: SbClient,
): Promise<BuilderResult> {
  if (tri === "any") return { builder };

  const { data } = await sb
    .from("tasks")
    .select("related_property_id")
    .eq("status", "open");

  const ids = Array.from(
    new Set(
      ((data ?? []) as Array<{ related_property_id: string | null }>)
        .map((r) => r.related_property_id)
        .filter((x): x is string => typeof x === "string"),
    ),
  );

  if (tri === "yes") {
    return {
      builder: ids.length
        ? builder.in("id", ids)
        : builder.in("id", NO_MATCH_SENTINEL),
    };
  }
  // tri === "no"
  if (ids.length === 0) return { builder };
  return {
    builder: builder.not("id", "in", `(${ids.map((id) => `"${id}"`).join(",")})`),
  };
}
