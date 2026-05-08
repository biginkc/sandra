---
phase: 05-prospects-filter-drawer
plan: 04
subsystem: prospects-filter-translator
tags: [translator, sql, tdd, back-compat, equity-pct, migration]
requires: [05-01, 05-03]
provides: [filter-to-supabase, back-compat-url-translator, equity_pct-column]
affects: [supabase/migrations, src/lib/prospects]
tech-stack:
  added: []
  patterns:
    - mockBuilder Proxy pattern for predicate-chain assertion
    - "__no_match__" sentinel for empty pre-fetch results
    - vi.useFakeTimers for deterministic since/prior date predicates
key-files:
  created:
    - supabase/migrations/057_equity_pct_cached.sql
    - src/lib/prospects/filter-to-supabase.ts
    - src/lib/prospects/filter-to-supabase.test.ts
    - src/lib/prospects/back-compat-url-translator.ts
    - src/lib/prospects/back-compat-url-translator.test.ts
  modified: []
decisions:
  - "Cascade A1 → A2: equity_pct lands in new migration 057 (055 already merged + applied; 056 slot taken by membership-recursion fix)"
  - "estimated_value block targets properties.arv (canonical estimated value column) — confirmed against types.ts"
  - "absentee block targets properties.absentee_flag (the actual boolean column; SPEC's `is_absentee` was a placeholder)"
  - "engagement opted_out bucket reads properties.outreach_dispo IN ('opted_out', 'dnc') per migration 045 enum (no separate opt_outs column)"
  - "has_open_tasks queries tasks.related_property_id where status='open' (verified migration 051 enum)"
  - "Tasks 1+2 and Tasks 3+4 each committed as a single RED→GREEN unit (pre-commit tsc --noEmit blocks any persisted RED commit referencing a missing module)"
metrics:
  duration_minutes: 10
  completed_date: 2026-05-08
---

# Phase 05 Plan 04: Filter Translator Summary

Pure (modulo pre-fetch) `FilterBlock[] → Supabase predicate chain` translator covering all 23 SPEC block kinds, plus the back-compat URL shim that turns the 5 legacy chip params into an equivalent block stack — with the equity_pct column landing in a new follow-up migration (057) because Plan 02's 055 + the membership-recursion fix at 056 had already merged.

## What Shipped

| Artifact | Purpose | Tests |
|----------|---------|-------|
| `supabase/migrations/057_equity_pct_cached.sql` | Stored generated column on `properties.equity_pct` + partial index `idx_properties_equity_pct` | (CI integration; n/a unit) |
| `src/lib/prospects/filter-to-supabase.ts` | `applyFilters` / `applyBlock` — switch on kind, 23 cases, exhaustiveness guard | 58 in `filter-to-supabase.test.ts` |
| `src/lib/prospects/back-compat-url-translator.ts` | `translateLegacyChipParams(raw): FilterBlock[]` — 5 legacy params → block stack | 13 in `back-compat-url-translator.test.ts` |

**Test deltas:** unit suite 727 → 798 (+71), RTL suite stable at 159, typecheck clean throughout.

## equity_pct Migration Cascade (Task 0)

The plan offered Option A1 (amend Plan 02's 055) vs Option A2 (new follow-up migration). **A1 was unavailable** because 055 was already merged in PR #137 and applied to prod + test by `db-migrate.yml` run #25532269811 before Plan 04 started — the plan's A1 cons explicitly direct that case to fall through to A2.

The plan suggested **056** for A2, but slot 056 was claimed by `056_fix_membership_recursion.sql` (merged 2026-05-07 to fix the recursion latent bug Plan 02's `saved_filters_read_own_plus_base` policy exposed). The follow-up migration therefore lands at **057**.

**Migration 057 contents:**
```sql
alter table public.properties
  add column if not exists equity_pct numeric
    generated always as ((equity_estimate * 100.0) / nullif(arv, 0)) stored;

create index if not exists idx_properties_equity_pct
  on public.properties (equity_pct)
  where deleted_at is null and equity_pct is not null;
```

NULL-safe on zero ARV. Partial index mirrors `idx_properties_active` so prospect-page queries scan only live, populated rows. Once db-migrate.yml lands 057, Plan 02's `High Equity` base preset returns SQL-accurate counts via `.gte("equity_pct", 50)`.

## Block-Kind → SQL Column / Pre-fetch Table Map

| Kind | Column / Table | Strategy |
|------|----------------|----------|
| `vacancy` | `properties.is_vacant` | tri-state: `.eq(true)` / `.or(eq.false,is.null)` |
| `absentee` | `properties.absentee_flag` | tri-state (column verified — SPEC's `is_absentee` was placeholder) |
| `needs_human_attention` | `properties.needs_human_attention` | tri-state |
| `cass` | `properties.cass_status` | combinator: `.in` / `.not(in)` |
| `outreach_dispo` | `properties.outreach_dispo` | combinator |
| `source` | `properties.source` | combinator |
| `state` | `properties.state` | combinator |
| `market` | `properties.market` | combinator |
| `pipeline_status` | `properties.status` | combinator (Plan 09 will tell page.tsx to skip its hardcoded `.eq("status","prospect")` when this block is present) |
| `motivation_level` | `properties.motivation_level` | combinator |
| `beds` | `properties.beds` | range `.gte/.lte` |
| `baths` | `properties.baths` | range |
| `year_built` | `properties.year_built` | range |
| `estimated_value` | `properties.arv` | range (ARV is the canonical estimated-value column) |
| `equity_pct` | `properties.equity_pct` (mig 057) | range (indexed) |
| `assignee` | `properties.assigned_user_id` | combinator + `unassigned` sentinel via `.is(null)` / `.or(...)` |
| `created_date` | `properties.created_at` | fixed `.gte/.lte` / since N days / prior N days |
| `list` | pre-fetch `property_lists` | combinator: all/any/not on intersection |
| `tag` | pre-fetch `property_tags` | same shape as list |
| `list_count` | pre-fetch `property_stack_counts` view | range on `stack_count` → `.in("id", ids)` |
| `engagement` | pre-fetch `messages` (+ `properties.outreach_dispo` for opted_out bucket) | 4 buckets via JS set arithmetic |
| `has_unread_inbound` | pre-fetch `messages` where `direction='inbound' AND read_at IS NULL` | tri-state |
| `has_open_tasks` | pre-fetch `tasks` where `status='open'` | tri-state |

## Column-Name Corrections vs SPEC's Assumed Names

| SPEC said | Actual column | Source |
|-----------|---------------|--------|
| `bedrooms` | `beds` | `types.ts` Row shape |
| `bathrooms` | `baths` | `types.ts` Row shape |
| `is_absentee` | `absentee_flag` | `types.ts` Row shape |
| `estimated_value` | `arv` | `types.ts` Row shape (no column literally named `estimated_value` exists — `arv` is the canonical estimated value) |
| `equity_pct` source: `estimated_value`/`mortgage_balance` | `equity_estimate`/`arv` | Migration 057 derivation: `(equity_estimate * 100.0) / NULLIF(arv, 0)` |
| `tasks.status` enum | `'open'` (also `'snoozed'`, `'completed'`, `'cancelled'`) | Migration 051 line 30 |
| `outreach_dispo` opt-out values | `'opted_out'`, `'dnc'` | Migration 045 line 31-37 |

## __no_match__ Short-Circuit Coverage

Pre-fetch helpers fall back to `.in("id", ["__no_match__"])` on empty results so the page renders 0 rows instead of erroring on an empty `.in()` list. Used by:
- `applyListBlock` (any/all combinators when zero properties match)
- `applyTagBlock` (same)
- `applyListCountBlock` (when zero properties have stack_count in range)
- `applyEngagementBlock` (any single-bucket and multi-bucket inclusion paths)
- `applyHasUnreadInboundBlock` (tri='yes' with empty messages set)
- `applyHasOpenTasksBlock` (tri='yes' with empty tasks set)

Three string occurrences in the file (`grep -c '__no_match__'` = 3, well over the ≥2 acceptance threshold).

The "no" / "not" branches are different — empty negative set means the predicate is omitted entirely (no rows are excluded).

## Engagement Bucket Implementation

Two messages reads (one per direction is logically what's needed; the implementation reads once with `direction` selected and bins in JS) plus an optional `properties` read for the `opted_out` bucket. JS set arithmetic produces:

- `replied` = inbound set
- `attempted` = outbound set MINUS inbound set
- `opted_out` = properties where `outreach_dispo IN ('opted_out','dnc')`
- `never_contacted` = universe MINUS (inbound ∪ outbound)

Single-bucket fast paths skip the universe enumeration. Multi-bucket selections that include `never_contacted` enumerate the universe via a soft-delete-filtered properties read so the union is computable in JS.

In-file comment: `"v1 perf-acceptable at 1,462 prospects; denorm at 10k"` (matches RESEARCH performance section). Two occurrences.

## Deviations from Plan

### Auto-fixed Issues

**1. [Rule 3 — Blocking] Migration slot 056 was already taken**
- **Found during:** Task 0
- **Issue:** Plan listed Option A2 as `056_equity_pct_cached.sql`, but slot 056 was claimed by the membership-recursion fix that landed alongside Plan 02 (PR #138, 2026-05-07).
- **Fix:** Used slot 057 instead. The plan's A2 description is "ship a separate migration with the column + index" — the slot number is operational, not contractual.
- **Files modified:** `supabase/migrations/057_equity_pct_cached.sql`
- **Commit:** 011e8b2

**2. [Rule 2 — Critical] Column-name corrections vs SPEC text**
- **Found during:** Tasks 1 + 2 (translator implementation read of types.ts)
- **Issue:** SPEC §41-46 referenced `bedrooms`, `bathrooms`, `is_absentee`, and `estimated_value` columns that don't exist on `properties`. Translator emitting `.gte("bedrooms",...)` would produce a 400 from PostgREST.
- **Fix:** Mapped to the actual columns (`beds`, `baths`, `absentee_flag`, `arv`). Recorded in this SUMMARY's column-name corrections table for downstream plans (drawer block UI labels can stay as "Bedrooms", "Estimated Value" — the column names are an internal detail).
- **Files modified:** `src/lib/prospects/filter-to-supabase.ts`
- **Commit:** 7feebaa

**3. [Rule 3 — Blocking] TDD RED commits collide with pre-commit tsc**
- **Found during:** Task 1 commit attempt
- **Issue:** Sandra's pre-commit hook runs `tsc --noEmit` before the test step. A standalone RED commit (test file referencing a not-yet-created module) fails typecheck and is rejected. Vitest itself runs the file fine in isolation — tsc is the strict gate.
- **Fix:** Combined Task 1+Task 2 into one commit, and Task 3+Task 4 into another. RED state was verified mid-flight (vitest "Cannot find module" output preserved in this session's transcript) before each implementation file was written; the persisted commits ship GREEN. TDD spirit honored — tests written first, ran red, then implementation made them pass — but the audit trail compresses to two commits instead of four.
- **Files modified:** `src/lib/prospects/filter-to-supabase.{ts,test.ts}` (commit 7feebaa); `src/lib/prospects/back-compat-url-translator.{ts,test.ts}` (commit 935fb5c).
- **Note for future plans:** if TDD RED-as-its-own-commit is required, the pre-commit hook would need a `--no-verify`-equivalent path or the project's tsc config would need to allow module-not-found for `.test.ts` files behind a flag. v1 ships with the combined-commit pattern.

## Self-Check: PASSED

Files exist:
- ✓ `supabase/migrations/057_equity_pct_cached.sql`
- ✓ `src/lib/prospects/filter-to-supabase.ts`
- ✓ `src/lib/prospects/filter-to-supabase.test.ts`
- ✓ `src/lib/prospects/back-compat-url-translator.ts`
- ✓ `src/lib/prospects/back-compat-url-translator.test.ts`

Commits exist:
- ✓ 011e8b2 `feat(05-04): add migration 057 — equity_pct stored generated column`
- ✓ 7feebaa `feat(05-04): filter-to-supabase translator + 58 unit tests (GREEN)`
- ✓ 935fb5c `feat(05-04): back-compat URL translator + 13 unit tests (GREEN)`

Acceptance grep counts (Task 1):
- ✓ `describe("applyBlock:` = 24 (≥23)
- ✓ `describe("applyFilters` = 3 (≥1)
- ✓ `mockBuilder` = 61 (≥5)

Acceptance grep counts (Task 2):
- ✓ `export async function applyBlock` = 1
- ✓ `export async function applyFilters` = 1
- ✓ `case "vacancy"` = 1
- ✓ `case "list_count"` = 1
- ✓ `case "equity_pct"` = 1
- ✓ `case "engagement"` = 1
- ✓ `property_stack_counts` = 3
- ✓ `__no_match__` = 3 (≥2)
- ✓ `denorm at 10k` = 2 (≥1)
- ✓ `_exhaustive: never` = 1

Acceptance grep counts (Task 3):
- ✓ `translateLegacyChipParams` = 21 (≥12)

Acceptance grep counts (Task 4):
- ✓ `export function translateLegacyChipParams` = 1
- ✓ `newBlockId` = 7 (≥5)

Test runs:
- ✓ `npm test -- --run src/lib/prospects/filter-to-supabase.test.ts` → 58/58 GREEN
- ✓ `npm test -- --run src/lib/prospects/back-compat-url-translator.test.ts` → 13/13 GREEN
- ✓ Full pre-commit suite: 798 unit + 159 RTL all GREEN, typecheck clean
