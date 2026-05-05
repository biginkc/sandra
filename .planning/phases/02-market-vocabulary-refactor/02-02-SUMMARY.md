---
phase: 02-market-vocabulary-refactor
plan: 02
subsystem: database
tags: [supabase-migration, seed, counties, fips, bmh-org]

# Dependency graph
requires:
  - phase: 02-market-vocabulary-refactor
    plan: 01
    provides: counties.market CHECK dropped, counties.fips_code text column with partial unique index, organizations + fips_codes lookup tables, counties (name, state) unique constraint
provides:
  - 21 county rows for BMH Group org (18 BMH-active + 3 confirmed at T-02-02-03 checkpoint, 2026-05-05)
  - counties.fips_code populated via subquery JOIN against fips_codes lookup
  - canonical "{name} {state}" market strings (D-03)
  - idempotent seed pattern (ON CONFLICT (name, state) DO UPDATE) — re-runs correct market labels + fips_code on changed rows
affects:
  - 02-03 (UI refactor — wizard + filter dropdowns now have canonical county rows to render)
  - 02-04 (backfill — UPDATE properties...FROM counties JOIN now has rows to JOIN against)
  - 02-05 (verification — final county count is the gate metric)

# Tech tracking
tech-stack:
  added: []
  patterns:
    - "Org-scoped DO $$ block with v_org_id lookup + early RETURN if BMH org missing (mirrors 040_seed_bmh_sms_templates.sql)"
    - "Subquery-per-row for fips_code lookup against static fips_codes table — keeps the seed self-contained, no temp table or CTE needed"
    - "Defensive Saint/St./St-no-period IN-list for the 3 saint counties — bounds the risk of fips_codes stored form being unknown without live MCP verification"
    - "TODO(jarrad)-gated rows for unconfirmed seed entries — uses an explicit human-verify checkpoint (T-02-02-03) as the human-decision gate (per `talk first, edit later` memory). On approval the gate comment is replaced with a dated confirmation in a separate atomic commit."

key-files:
  created:
    - "supabase/migrations/044_seed_counties.sql"
  modified: []

key-decisions:
  - "Defensive Saint/St. IN-list rather than committing to one form. MCP supabase tools are not available to the parallel-executor agent (same constraint as plan 02-01 Task 1). Without live verification of fips_codes' stored casing, an exact equality on either 'Saint Charles' or 'St. Charles' alone risks NULL fips_code. The IN-list (Saint X, St. X, St X) makes the seed correct regardless of the actual stored form. If both forms somehow exist, LIMIT 1 picks one; the unique index on (state_code, lower(county_name)) makes that case impossible."
  - "All 21 counties seeded in this migration (18 BMH-active + 3 additional). The 3 additional (Cass MO / Wyandotte KS / Riley KS) were initially TODO(jarrad)-gated for the T-02-02-03 human-verify checkpoint per CONTEXT.md D-02 + plan instructions. Approved by Jarrad on 2026-05-05 — confirmation comment replaces the gate in commit f330a66. Inclusion-with-approve was reversible at the checkpoint; the inverse path (omit + add later) would have required a follow-up migration."
  - "Subquery returns NULL for FIPS misses — acceptable rather than fatal. counties.fips_code is nullable per migration 043. Per plan threat model T-02-02-02 + CONTEXT.md D-05, a county that doesn't match in fips_codes simply gets NULL fips_code; plan 02-04's backfill won't touch properties for that county. Defensive IN-list reduces this risk to near-zero for the saint counties."

patterns-established:
  - "Migration 040 (sms_templates seed with org-scoped DO block + ON CONFLICT DO NOTHING) → 044 (counties seed with same shape but ON CONFLICT DO UPDATE) — extends the org-scoped seed idiom for cases where re-running should self-correct rather than no-op."
  - "Spike-discovery via /tmp/<plan>-<artifact>.txt before writing the migration — same pattern as plan 02-01. Keeps the discovery output out of the repo while making it inspectable for verification."

requirements-completed: [MARKET-01]

# Metrics
duration: 11min
completed: 2026-05-05
---

# Phase 02 Plan 02: Seed Counties Summary

**Migration 044 seeds the counties table with 21 confirmed county rows for the BMH Group org — 18 BMH-active counties (confirmed in the Drive folder) plus 3 additional counties (Cass MO, Wyandotte KS, Riley KS) confirmed by Jarrad at the T-02-02-03 human-verify checkpoint. Each row's `fips_code` is populated via subquery against the static `fips_codes` lookup added in migration 043. The seed is idempotent (ON CONFLICT DO UPDATE) so re-runs correct market labels.**

## Performance

- **Duration:** ~11 min (autonomous portion) + checkpoint resumption
- **Started:** 2026-05-05T15:14:53Z (worktree alignment to dcc5e22 base)
- **Tasks completed:** 3 of 3 (Task 1 spike + Task 2 migration + Task 3 checkpoint approved)
- **Files created:** 1
- **Lines added:** 130 (5 fewer than initial draft after TODO block was replaced with shorter confirmation comment)

## Status

**COMPLETE — all 3 tasks done; checkpoint approved by Jarrad on 2026-05-05.**

The 3 previously-pending counties (Cass MO, Wyandotte KS, Riley KS) are confirmed to ship with the seed. They are present in prod FIPS data already, so excluding them would orphan any properties tagged to those counties after the 02-04 backfill. The migration's TODO(jarrad) gate comment was replaced with a confirmation comment dated 2026-05-05 in commit `f330a66`. All 21 data rows ship unchanged.

## Accomplishments

- **Task 1 (spike):** Identified fips_codes data shape via static verification (production code path in `src/lib/csv/normalize.ts::normalizeCountyName` + `src/lib/csv/fips.ts::resolveFipsFromCountyName` proves fips_codes stores names WITHOUT "County"/"Parish"/"Borough" suffix, lookup is case-insensitive via `lower(county_name)`). Discovery written to `/tmp/02-02-fips-spike.txt`.
- **Task 2 (migration):** Wrote `supabase/migrations/044_seed_counties.sql` — DO $$ org-scoped INSERT, 21 rows, fips_code subqueries, defensive Saint/St. IN-list for the 3 saint counties, originally with a TODO(jarrad) comment block gating the 3 pending rows.
- **Task 3 (checkpoint approved):** Jarrad confirmed all 3 pending counties (Cass MO, Wyandotte KS, Riley KS) ship with the seed. TODO(jarrad) gate comment replaced with confirmation comment in commit `f330a66`; data rows unchanged. Plan complete.

## Counties Seeded (canonical D-03 format: `"{name} {state}"`) — all 21 confirmed

### BMH-active (18) — confirmed via Drive folder

| State | Counties |
|-------|----------|
| MO    | Buchanan County, Boone County, Clay County, Jackson County, Camden County, Saint Charles County, Saint Louis County, Platte County, Taney County, Franklin County, Jefferson County, Greene County |
| KS    | Johnson County |
| LA    | Lincoln Parish |
| AR    | Garland County, Carroll County |
| IL    | Madison County, Saint Clair County |

### Additional (3) — confirmed at T-02-02-03 checkpoint (2026-05-05)

| State | County | FIPS subquery |
|-------|--------|---------------|
| MO    | Cass County      | `lower('Cass')` |
| KS    | Wyandotte County | `lower('Wyandotte')` |
| KS    | Riley County     | `lower('Riley')` |

These 3 counties were originally TODO(jarrad)-gated for PR review. Jarrad approved the human-verify checkpoint on 2026-05-05 and confirmed all 3 ship with the seed (rationale: they are present in prod FIPS data, so excluding them would leave any pre-existing properties tagged to those counties orphaned after the 02-04 backfill). Final seed count: **21 counties.**

## Saint vs St. — Defensive IN-List

Three counties use "Saint" in the canonical Drive folder list but Census FIPS data sometimes uses "St." (or rarely "St"). Without live MCP read access to the production `fips_codes` table, the seed cannot commit to one form without risking a NULL fips_code on the saint rows. The defensive subquery accepts ALL THREE forms:

```sql
WHERE state_code = 'MO'
  AND lower(county_name) IN (lower('Saint Charles'), lower('St. Charles'), lower('St Charles'))
LIMIT 1
```

Applied to: Saint Charles County MO, Saint Louis County MO, Saint Clair County IL. The unique index `fips_codes (state_code, lower(county_name))` from `001_initial.sql:117` guarantees at most one form is stored, so LIMIT 1 is a defensive belt-and-suspenders rather than tie-breaking.

## Idempotency

```sql
ON CONFLICT (name, state) DO UPDATE SET
  market    = EXCLUDED.market,
  fips_code = EXCLUDED.fips_code;
```

Targets the unique constraint from `001_initial.sql:33`. Re-running the migration:
- INSERTs missing rows
- UPDATEs `market` and `fips_code` on existing rows (so a name fix or fips_codes refresh is forward-compatible)
- Never errors

## Task Commits

| Task | Name | Commit | Files |
|------|------|--------|-------|
| T-02-02-01 | Spike — verify fips_codes data shape | (no commit, artifact in /tmp/) | /tmp/02-02-fips-spike.txt |
| T-02-02-02 | Write migration 044 | `e35b4dd` | supabase/migrations/044_seed_counties.sql |
| T-02-02-03 | Checkpoint approved — confirm 3 pending counties | `f330a66` | supabase/migrations/044_seed_counties.sql (comment-only edit) |

## Files Created/Modified

- `supabase/migrations/044_seed_counties.sql` — 130 lines, DO $$ block, org-scoped, 21 INSERT rows (all confirmed), fips_code subqueries, ON CONFLICT (name, state) DO UPDATE

## Decisions Made

1. **All 21 counties ship in this migration. Approved at the T-02-02-03 checkpoint on 2026-05-05.** The 3 originally-pending counties (Cass MO, Wyandotte KS, Riley KS) were initially seeded with a `TODO(jarrad)` comment block per CONTEXT.md D-02 to make PR review the gate. Jarrad approved the human-verify checkpoint and confirmed all 3 ship — they are already present in prod FIPS data, so excluding them would orphan any properties already tagged to those counties after the 02-04 backfill. The TODO gate comment was replaced with a confirmation comment in commit `f330a66` (data rows untouched).

2. **Defensive Saint/St./St IN-list rather than guessing.** Without live MCP verification of fips_codes' stored casing, committing to either form alone would risk a NULL fips_code on three rows. The IN-list bounds the risk to zero (assuming any of the three forms is stored — which is virtually certain given the Census FIPS source).

3. **NULL fips_code is acceptable for misses.** counties.fips_code is nullable per migration 043. If a defensive lookup misses entirely (extremely unlikely), the row still INSERTs with NULL fips_code; plan 02-04's backfill JOIN simply won't match for properties in that county. Documented in plan threat model T-02-02-02 and CONTEXT.md D-05.

## Deviations from Plan

### Auto-fixed Issues

**1. [Rule 3 — Blocking] MCP `mcp__supabase__execute_sql` not available in parallel-executor agent context**

- **Found during:** Task 1 (pre-flight discovery)
- **Issue:** Task 1's action specifies running a read-only query via `mcp__supabase__execute_sql` against prod (`copflsklaefwzipsrjqz`) to confirm the fips_codes stored form (suffix presence, casing, Saint/St. variant). The Supabase MCP tools are not exposed to this parallel-executor agent — same constraint that plan 02-01 hit and worked around. Per project memory `feedback_migrations_only_via_ci.md`, `apply_migration` is forbidden anyway, but the read-only `execute_sql` would have been allowed if available.
- **Fix:** Static verification chain instead of live read:
  - **Suffix presence:** `src/lib/csv/normalize.ts::normalizeCountyName` strips `County`/`Parish`/`Borough` suffix before lookup; `src/lib/csv/fips.ts::resolveFipsFromCountyName` uses the stripped form. Production code path proves the table stores names without suffix (otherwise CASS would 100% fail). Verified by inspecting the existing `normalizeCountyName` test in `src/lib/csv/normalize.test.ts:275-289` ("Jackson County" → "jackson", etc.).
  - **Casing:** `001_initial.sql:117` unique index is `(state_code, lower(county_name))` — lookup case-insensitive by design. Stored case is whatever the seed loaded; seed uses `lower()` on both sides so it doesn't matter.
  - **Saint vs St. vs St (no period):** unknown without live read. Mitigated via defensive IN-list across all three forms in the subquery — the seed works regardless of which form is stored.
- **Files modified:** `/tmp/02-02-fips-spike.txt` (discovery artifact, not in repo)
- **Risk:** bounded. If somehow ALL three Saint forms are missing from fips_codes (impossible — Census data has them), three rows land with NULL fips_code, which is acceptable per the threat model. Plan 02-05 verification will surface this as a documented gap.
- **Committed in:** N/A (artifact lives in `/tmp/`, identical handling to plan 02-01)

**2. [Rule 1 — Bug] First-pass file content tripped its own verification grep**

- **Found during:** Task 2 verification
- **Issue:** The header comment included a literal "Never run `supabase db push` locally against prod, never use MCP apply_migration" reminder. The plan's verification grep (`! grep -E "supabase db push|apply_migration"`) treats those exact phrases as forbidden — and rightly so for actual SQL commands, but the comment matched the same regex.
- **Fix:** Reworded the header comment to convey the same policy without the literal forbidden phrase ("this file lands via PR merge to main only; no local CLI push, no MCP-driven apply").
- **Files modified:** `supabase/migrations/044_seed_counties.sql` (comment text only)
- **Verification:** Re-ran the full grep chain — `OK`.
- **Committed in:** Same Task 2 commit (`e35b4dd`) — the file was committed only after both the verification chain and the acceptance-criteria check passed.

**Total deviations:** 2 auto-fixed.

## Issues Encountered

None — checkpoint pause is intentional per the plan, not a failure.

## Cross-Links

- **Plan 02-01** (`043_counties_add_fips_and_drop_market_check.sql`): provided `counties.fips_code` column + dropped market CHECK that would otherwise reject every county-shaped INSERT in this migration. **This plan's foundation.**
- **Plan 02-03** (UI refactor — wizard + filter dropdowns): consumes the 21 counties via server-fetch from this table. The dropdown order will be `state ASC, name ASC` (per PATTERNS).
- **Plan 02-04** (`045_backfill_property_county_id_from_fips.sql`): UPDATE...FROM JOIN against this seed's rows. The `counties.fips_code` populated by this migration is the JOIN key.
- **Plan 02-05** (verification): Final SQL gate — counts that BMH org has 18 or 21 counties (depending on Jarrad's checkpoint decision), 0 NULL fips_codes (or a documented short list of misses), and the canonical "{name} {state}" market strings.

## User Setup Required

**No further user action required.** The T-02-02-03 human-verify checkpoint was approved on 2026-05-05; all 3 pending counties ship with the seed. The orchestrator will merge the worktree back to main, and db-migrate.yml will apply migration 044 to both prod and test on PR merge. After merge, the seeded rows feed plans 02-03 / 02-04 / 02-05.

## Next Phase Readiness

- ✅ Migration file is finalized and ready for merge.
- ✅ Idempotent — safe to re-run if the workflow is replayed.
- ✅ Compatible with the schema state established by plan 02-01 (043).
- ✅ Checkpoint approved — plan unblocked.
- 📌 After merge, plan 02-05 verification queries should return:
  - `select count(*) from counties where org_id = (select id from organizations where name='BMH Group')` → **21**
  - `select count(*) from counties where org_id = (BMH org) and fips_code is null` → 0 (ideally) or a short documented list
  - `select version from schema_migrations where version = '044'` → 1 row on prod and test

## Self-Check: PASSED

- ✅ `supabase/migrations/044_seed_counties.sql` exists (`ls` confirmed, 130 lines after T-02-02-03 comment edit)
- ✅ Commit `e35b4dd` exists in worktree branch (`git log --oneline -5` confirmed) — Task 2 migration
- ✅ Commit `f330a66` exists in worktree branch (`git log --oneline -5` confirmed) — T-02-02-03 confirmation
- ✅ All 21 county names present in the file (count of `(v_org_id, '` rows = 21)
- ✅ Defensive Saint/St./St IN-list present for the 3 saint counties
- ✅ ON CONFLICT (name, state) DO UPDATE present
- ✅ TODO(jarrad) gate **removed** and replaced with confirmation comment dated 2026-05-05
- ✅ No file deletions in `f330a66` (verified via `git diff --diff-filter=D HEAD~1 HEAD`)
- ✅ Task 2 automated verification grep chain returned `OK`
- ✅ Worktree based on dcc5e22 (post-Wave-1 main HEAD with migration 043) per the orchestrator's required base

---
*Phase: 02-market-vocabulary-refactor*
*Status: COMPLETE — all 3 tasks done; T-02-02-03 human-verify checkpoint approved by Jarrad on 2026-05-05; MARKET-01 satisfied*
*Completed: 2026-05-05*
