---
phase: 02-market-vocabulary-refactor
gathered: 2026-05-05
status: ready-for-planning
source: discuss-phase session
---

# Phase 2: Market Vocabulary Refactor — Context

<domain>
## Phase Boundary

Replace the hardcoded city-shaped `KNOWN_MARKETS` enum with a DB-driven county-as-market system. Every county BMH operates in becomes one market value. Market and county are synonymous — picking a market on import is picking a county. No new UI features beyond wiring the county list dynamically.
</domain>

<decisions>
## Implementation Decisions

### D-01 — Collapse KNOWN_MARKETS + counties table into one source of truth
- **`counties` table is the single source of truth** for valid markets. `KNOWN_MARKETS` array in `prospects-query.ts` and `WizardMarket` union type in `wizard.tsx` are both eliminated.
- Import wizard, filter dropdowns, and validation all read from the `counties` table at runtime — no hardcoded list anywhere.
- Adding a new market in the future = one DB insert, no code deploy.

### D-02 — County list (initial seed)
Populate `counties` table with all counties from the BMH Group Drive agent outreach folder plus any counties already present in prod FIPS data. Canonical format: `name` = "Johnson County", `state` = "KS", `market` = "Johnson County KS".

**From Drive folder (confirmed active):**
| name | state | market |
|------|-------|--------|
| Buchanan County | MO | Buchanan County MO |
| Boone County | MO | Boone County MO |
| Clay County | MO | Clay County MO |
| Jackson County | MO | Jackson County MO |
| Camden County | MO | Camden County MO |
| Saint Charles County | MO | Saint Charles County MO |
| Saint Louis County | MO | Saint Louis County MO |
| Platte County | MO | Platte County MO |
| Taney County | MO | Taney County MO |
| Franklin County | MO | Franklin County MO |
| Jefferson County | MO | Jefferson County MO |
| Greene County | MO | Greene County MO |
| Johnson County | KS | Johnson County KS |
| Lincoln Parish | LA | Lincoln Parish LA |
| Garland County | AR | Garland County AR |
| Carroll County | AR | Carroll County AR |
| Madison County | IL | Madison County IL |
| Saint Clair County | IL | Saint Clair County IL |

**Also in prod FIPS data (include, confirm with Jarrad):**
| name | state | market |
|------|-------|--------|
| Cass County | MO | Cass County MO |
| Wyandotte County | KS | Wyandotte County KS |
| Riley County | KS | Riley County KS |

### D-03 — Canonical market string format
`counties.market` = `"{name} {state}"` (e.g., "Johnson County KS", "Lincoln Parish LA"). This is the value stored in `properties.market` and shown in all UI surfaces.

### D-04 — properties.market stays as a synced text cache
`properties.market` is kept as a text column — it stores a copy of `counties.market` for the property's county. It is always derived from `county_id → counties.market`. Both fields are set together at write time (import, wizard, migration). Long-term retirement of `properties.market` in favour of always joining through `county_id` is deferred beyond Phase 2.

### D-05 — Backfill strategy for existing 2,533 properties
- **1,149 properties have `fips_code`**: migration derives `county_id` by joining on FIPS code, then copies `counties.market` → `properties.market`.
- **~26 with CASS response but no fips_code**: migration extracts `county_fips` from `cass_raw_response[0].metadata.county_fips`, then resolves `county_id`.
- **~1,358 with neither**: leave `market = "Kansas City"` and `county_id = NULL` for now — resolved on next CASS verification of each property. Do NOT create a fake "Kansas City" county row.
- FIPS codes for outlier counties outside BMH markets (TX, CA, CO — likely test data) get `county_id = NULL` and `market` unchanged.

### D-06 — Import wizard: county picker replaces market picker
`StepUpload` drops the hardcoded `MARKETS` array. The market/county select is populated from a server-fetched list from the `counties` table (ordered by state then name). `WizardMarket` type is replaced by a runtime county name string. The import action receives the county's `market` string and `county_id` together.

### D-07 — Filter dropdown on /properties
`KNOWN_MARKETS` export from `prospects-query.ts` is replaced by a server-side fetch from `counties` table. The filter pill renders the same `counties.market` strings.

### D-08 — Migration is CI-only via db-migrate.yml
All schema changes and data backfills go through `supabase/migrations/` + the `db-migrate.yml` workflow. No direct SQL against prod via MCP.

### D-09 — Old market values: no aliases, clean cutover
Since the only prod market value is "Kansas City" (St. Louis, Dayton, Lake of the Ozarks never had data), there is no need for aliases or backwards-compat shims. The migration sets correct county values in one pass.

### Claude's Discretion
- Exact migration file numbering (next after current highest)
- Whether to add a FIPS-to-county join helper function or inline the JOIN in the migration
- RLS policies on the `counties` table (read-only for org members, insert/update for service role)
- Whether `counties` needs a unique constraint on `(fips_code, org_id)` — add if sensible
- Test fixture strategy for county-dependent tests

</decisions>

<canonical_refs>
## Canonical References

**Downstream agents MUST read these before planning or implementing.**

### Market/county definitions in code (targets for replacement)
- `src/app/(dashboard)/properties/prospects-query.ts:76` — `KNOWN_MARKETS` const + `KnownMarket` type (eliminate)
- `src/app/(dashboard)/import/wizard.tsx:101` — `WizardMarket` union type (eliminate)
- `src/app/(dashboard)/import/steps/step-upload.tsx:50` — hardcoded `MARKETS` array (replace with DB fetch)
- `src/app/(dashboard)/leads/new/page.tsx:27` — hardcoded market array in new lead form (replace)

### UI surfaces that render market labels
- `src/app/(dashboard)/properties/prospects-table.tsx:1038` — market filter pill uses `KNOWN_MARKETS`
- `src/app/(dashboard)/leads/kanban.tsx` — market references
- `src/app/(dashboard)/leads/filter.ts` — market filter logic

### DB schema
- `supabase/migrations/` — CI-only, check highest migration number before adding new ones
- `properties.county_id` — FK to `counties.id` (currently all NULL)
- `properties.fips_code` — text, populated for 1,149 of 2,533 rows; drives backfill
- `properties.cass_raw_response` — jsonb array; `[0].metadata.county_fips` + `[0].metadata.county_name` available for ~1,175 rows
- `counties` table — `id, name, state, market, org_id, created_at`; currently empty

### Tests referencing market values (need updating)
- `src/app/(dashboard)/properties/prospects-query.test.ts` — `KNOWN_MARKETS` import + market assertions
- `src/app/(dashboard)/leads/filter.test.ts` — "Kansas City", "St. Louis", "Dayton" hardcoded
- `src/app/(dashboard)/lists/lists.integration.test.ts` — "Kansas City" hardcoded in fixtures
- `src/app/(dashboard)/leads/tags.integration.test.ts` — "Kansas City" hardcoded in fixtures
</canonical_refs>

<specifics>
## Specific Notes

**Suggested plan breakdown:**
- Plan 02-01: Seed `counties` table (migration) + RLS; fetch helper for server components
- Plan 02-02: Replace `KNOWN_MARKETS` + `WizardMarket` with DB-driven county list in import wizard and filter dropdown
- Plan 02-03: Backfill migration — set `county_id` + `market` on existing properties from `fips_code` / CASS response
- Plan 02-04: Update all tests; CI green

**CASS backfill SQL shape (for planner reference):**
```sql
UPDATE properties p
SET county_id = c.id,
    market = c.market
FROM counties c
WHERE c.fips_code = p.fips_code  -- add fips_code to counties table if not present
  AND p.fips_code IS NOT NULL;
```
Note: `counties` table doesn't currently have a `fips_code` column — planner must add it in migration 02-01 or decide to join on (name, state) instead. Adding `fips_code` to `counties` is strongly recommended for the backfill JOIN to work cleanly.

**Properties with no FIPS (1,358 rows):** Leave `county_id = NULL`, `market = 'Kansas City'` — these resolve naturally as each property goes through CASS re-verification on the next import/update.

**No "Kansas City" county row:** Do not seed a catch-all "Kansas City" county. The ~1,358 unresolved properties retain the legacy string until CASS catches them.
</specifics>

<deferred>
## Deferred Ideas

- Retiring `properties.market` text column entirely in favour of `county_id` join (Phase 3+)
- UI to manage the counties list from within Sandra (add/remove counties without a migration)
- County-level sequence targeting (send to all properties in a county)
- Confirm Cass County MO, Wyandotte County KS, Riley County KS as active markets before including in seed

</deferred>

---
*Phase: 02-market-vocabulary-refactor*
*Context gathered: 2026-05-05 — discuss-phase session*
