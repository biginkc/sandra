/**
 * Prospects Filter Schema — single source of truth for the 23 filter-block kinds
 * used by the right-side filter drawer on `/properties` (see
 * `.planning/phases/05-prospects-filter-drawer/`).
 *
 * URL state shape (D-01): `?filters=<encodeURIComponent(JSON.stringify(state))>`.
 * The JSON is deliberately readable in DevTools — no base64, no obfuscation.
 *
 * Block ids (D-06): each configured block carries a client-generated v4 UUID.
 * Same kind can repeat in the stack (D-07) — keys are UUIDs, not kinds.
 *
 * Version-bump policy: `v` is part of the URL JSON. Bumping it is a breaking
 * change for any deep link that pre-dated the bump — old URLs decode to
 * `EMPTY_FILTER_STATE` (fail-closed) and the back-compat shim in
 * `prospects-query.ts` re-translates from the legacy chip params
 * (`?vacant=1`, `?cass=`, `?engagement=`, `?market=`, `?assignee=`).
 *
 * Fail-closed behavior of `decodeFilters` (per the gotchas in 05-01-PLAN.md):
 *   - null / undefined / empty input → `EMPTY_FILTER_STATE`
 *   - non-JSON payload                → `EMPTY_FILTER_STATE`
 *   - `parsed.v !== 1`                → `EMPTY_FILTER_STATE`
 *   - unknown `kind`                  → that block silently dropped
 *   - unknown combinator              → coerced to `"all"`
 *   - unknown tri-bool                → coerced to `"any"`
 *   - non-numeric range fields        → coerced to `null`
 *   - unknown date.mode               → block dropped
 *
 * Never throws to the page.
 */

// 23 block kinds — names match SPEC.md §41-46 verbatim.
export const BLOCK_KINDS = [
  // General (7)
  "list",
  "tag",
  "list_count",
  "vacancy",
  "cass",
  "outreach_dispo",
  "source",
  // Property (5)
  "beds",
  "baths",
  "year_built",
  "state",
  "market",
  // Owner (1)
  "absentee",
  // Value & Equity (2)
  "estimated_value",
  "equity_pct",
  // Status & Engagement (4)
  "pipeline_status",
  "engagement",
  "assignee",
  "created_date",
  // Schema-audit additions (4)
  "has_unread_inbound",
  "needs_human_attention",
  "has_open_tasks",
  "motivation_level",
] as const;

export type BlockKind = (typeof BLOCK_KINDS)[number];

const BLOCK_KIND_SET = new Set<string>(BLOCK_KINDS);

// Tri-state combinator for multi-select blocks: "all" = AND, "any" = OR,
// "not" = NOT IN (null-safe per column for outreach_dispo + source — see
// filter-to-supabase applyMultiSelect)
export type Combinator = "all" | "any" | "not";
const COMBINATOR_VALUES: ReadonlySet<Combinator> = new Set(["all", "any", "not"]);

// Tri-state boolean: "any" = no predicate; "no" = false OR null
export type TriBool = "any" | "yes" | "no";
const TRIBOOL_VALUES: ReadonlySet<TriBool> = new Set(["any", "yes", "no"]);

// Date mode for the Created Date block
export type DateMode =
  | { mode: "fixed"; from: string | null; to: string | null }
  | { mode: "since"; days: number }
  | { mode: "prior"; days: number };

const DATE_MODES: ReadonlySet<DateMode["mode"]> = new Set(["fixed", "since", "prior"]);

// Numeric range for slider/min-max blocks
export type NumRange = { min: number | null; max: number | null };

// Per-kind config (one variant per kind in the discriminated union — order matches BLOCK_KINDS)
export type FilterBlock =
  | { id: string; kind: "list";                  combinator: Combinator; values: string[] }
  | { id: string; kind: "tag";                   combinator: Combinator; values: string[] }
  | { id: string; kind: "list_count";            range: NumRange }
  | { id: string; kind: "vacancy";               tri: TriBool }
  | { id: string; kind: "cass";                  combinator: Combinator; values: string[] }
  | { id: string; kind: "outreach_dispo";        combinator: Combinator; values: string[] }
  | { id: string; kind: "source";                combinator: Combinator; values: string[] }
  | { id: string; kind: "beds";                  range: NumRange }
  | { id: string; kind: "baths";                 range: NumRange }
  | { id: string; kind: "year_built";            range: NumRange }
  | { id: string; kind: "state";                 combinator: Combinator; values: string[] }
  | { id: string; kind: "market";                combinator: Combinator; values: string[] }
  | { id: string; kind: "absentee";              tri: TriBool }
  | { id: string; kind: "estimated_value";       range: NumRange }
  | { id: string; kind: "equity_pct";            range: NumRange }
  | { id: string; kind: "pipeline_status";       combinator: Combinator; values: string[] }
  | { id: string; kind: "engagement";            combinator: Combinator; values: ("never_contacted" | "attempted" | "replied" | "opted_out")[] }
  | { id: string; kind: "assignee";              combinator: Combinator; values: string[] }
  | { id: string; kind: "created_date";          date: DateMode }
  | { id: string; kind: "has_unread_inbound";    tri: TriBool }
  | { id: string; kind: "needs_human_attention"; tri: TriBool }
  | { id: string; kind: "has_open_tasks";        tri: TriBool }
  | { id: string; kind: "motivation_level";      combinator: Combinator; values: string[] };

export type BlockStack = FilterBlock[];

export type FilterState = { v: 1; blocks: BlockStack };

export const EMPTY_FILTER_STATE: FilterState = { v: 1, blocks: [] };

// Compile-time exhaustiveness guard: every BLOCK_KINDS entry must be a FilterBlock['kind'].
// If a new kind is added to BLOCK_KINDS without a matching FilterBlock variant (or vice
// versa), this satisfies clause stops compiling.
const _exhaustivenessCheck: ReadonlyArray<FilterBlock["kind"]> = BLOCK_KINDS;
void _exhaustivenessCheck;

// ---------------------------------------------------------------------------
// newBlockId — wraps crypto.randomUUID for stable React keys + remove targets
// ---------------------------------------------------------------------------

export function newBlockId(): string {
  return crypto.randomUUID();
}

// ---------------------------------------------------------------------------
// encodeFilters — JSON.stringify → encodeURIComponent
// ---------------------------------------------------------------------------

export function encodeFilters(s: FilterState): string {
  const encoded = encodeURIComponent(JSON.stringify(s));
  if (encoded.length > 1500) {
    // Defensive — RESEARCH §A1/A2 budget. Doesn't throw; the URL still works,
    // but the user has stacked enough blocks that they're approaching the
    // common 2KB URL-length ceiling. Surface so we notice in DevTools.
    // eslint-disable-next-line no-console
    console.warn(
      "[filter-schema] encoded URL filter payload exceeds 1500 chars; consider splitting block stack"
    );
  }
  return encoded;
}

// ---------------------------------------------------------------------------
// decodeFilters — fail-closed parse + per-kind narrowing
// ---------------------------------------------------------------------------

export function decodeFilters(raw: string | null | undefined): FilterState {
  if (raw == null || raw === "") return EMPTY_FILTER_STATE;

  let parsed: unknown;
  try {
    parsed = JSON.parse(decodeURIComponent(raw));
  } catch {
    return EMPTY_FILTER_STATE;
  }

  if (!isObject(parsed)) return EMPTY_FILTER_STATE;
  if (parsed.v !== 1) return EMPTY_FILTER_STATE;
  if (!Array.isArray(parsed.blocks)) return EMPTY_FILTER_STATE;

  const blocks: FilterBlock[] = [];
  for (const raw of parsed.blocks) {
    const narrowed = narrowBlock(raw);
    if (narrowed) blocks.push(narrowed);
  }
  return { v: 1, blocks };
}

// ---------------------------------------------------------------------------
// Internal helpers — narrowing + coercion (kept private to this module)
// ---------------------------------------------------------------------------

function isObject(x: unknown): x is Record<string, unknown> {
  return typeof x === "object" && x !== null && !Array.isArray(x);
}

function coerceCombinator(v: unknown): Combinator {
  return typeof v === "string" && COMBINATOR_VALUES.has(v as Combinator) ? (v as Combinator) : "all";
}

function coerceTriBool(v: unknown): TriBool {
  return typeof v === "string" && TRIBOOL_VALUES.has(v as TriBool) ? (v as TriBool) : "any";
}

function coerceRange(v: unknown): NumRange {
  if (!isObject(v)) return { min: null, max: null };
  const min = typeof v.min === "number" && Number.isFinite(v.min) ? v.min : null;
  const max = typeof v.max === "number" && Number.isFinite(v.max) ? v.max : null;
  return { min, max };
}

function coerceStringArray(v: unknown): string[] {
  if (!Array.isArray(v)) return [];
  return v.filter((x): x is string => typeof x === "string");
}

function coerceDateMode(v: unknown): DateMode | null {
  if (!isObject(v)) return null;
  if (!DATE_MODES.has(v.mode as DateMode["mode"])) return null;
  if (v.mode === "fixed") {
    const from = typeof v.from === "string" ? v.from : null;
    const to = typeof v.to === "string" ? v.to : null;
    return { mode: "fixed", from, to };
  }
  if (v.mode === "since" || v.mode === "prior") {
    const days =
      typeof v.days === "number" && Number.isFinite(v.days) && v.days >= 0 ? Math.floor(v.days) : 0;
    return { mode: v.mode, days };
  }
  return null;
}

const ENGAGEMENT_VALUES = new Set<FilterBlock & { kind: "engagement" } extends infer E
  ? E extends { values: infer V }
    ? V extends Array<infer X>
      ? X
      : never
    : never
  : never>(["never_contacted", "attempted", "replied", "opted_out"] as const);

function coerceEngagementValues(
  v: unknown
): ("never_contacted" | "attempted" | "replied" | "opted_out")[] {
  if (!Array.isArray(v)) return [];
  const out: ("never_contacted" | "attempted" | "replied" | "opted_out")[] = [];
  for (const x of v) {
    if (typeof x === "string" && ENGAGEMENT_VALUES.has(x as never)) {
      out.push(x as "never_contacted" | "attempted" | "replied" | "opted_out");
    }
  }
  return out;
}

/**
 * Narrows a single raw payload entry to a typed FilterBlock, or returns null
 * if the entry is so malformed it should be dropped (unknown kind, missing id,
 * unknown date.mode for created_date).
 *
 * Per-kind variants where a coercion makes sense (combinator → "all",
 * tri-bool → "any", range fields → null) coerce silently.
 */
function narrowBlock(raw: unknown): FilterBlock | null {
  if (!isObject(raw)) return null;
  if (typeof raw.id !== "string" || raw.id === "") return null;
  if (typeof raw.kind !== "string" || !BLOCK_KIND_SET.has(raw.kind)) return null;

  const id = raw.id;
  const kind = raw.kind as BlockKind;

  switch (kind) {
    case "list":
    case "tag":
    case "cass":
    case "outreach_dispo":
    case "source":
    case "state":
    case "market":
    case "pipeline_status":
    case "assignee":
    case "motivation_level": {
      return {
        id,
        kind,
        combinator: coerceCombinator(raw.combinator),
        values: coerceStringArray(raw.values),
      };
    }

    case "engagement": {
      return {
        id,
        kind: "engagement",
        combinator: coerceCombinator(raw.combinator),
        values: coerceEngagementValues(raw.values),
      };
    }

    case "list_count":
    case "beds":
    case "baths":
    case "year_built":
    case "estimated_value":
    case "equity_pct": {
      return { id, kind, range: coerceRange(raw.range) };
    }

    case "vacancy":
    case "absentee":
    case "has_unread_inbound":
    case "needs_human_attention":
    case "has_open_tasks": {
      return { id, kind, tri: coerceTriBool(raw.tri) };
    }

    case "created_date": {
      const date = coerceDateMode(raw.date);
      if (!date) return null;
      return { id, kind: "created_date", date };
    }

    default: {
      // Exhaustiveness guard — if a new kind is added without a case here,
      // TypeScript flags `kind` as not assignable to `never`.
      const _never: never = kind;
      void _never;
      return null;
    }
  }
}
