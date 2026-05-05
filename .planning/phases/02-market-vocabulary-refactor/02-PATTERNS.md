# Phase 02: Market Vocabulary Refactor — Pattern Map

**Mapped:** 2026-05-05
**Files analyzed:** 11 (4 migrations, 1 type/const, 4 UI/action, 2 test classes)
**Analogs found:** 11 / 11

---

## File Classification

| New/Modified File | Role | Data Flow | Closest Analog | Match Quality |
|-------------------|------|-----------|----------------|---------------|
| `supabase/migrations/043_counties_add_fips_and_drop_market_check.sql` | migration (DDL) | schema | `supabase/migrations/030_source_enum_unification.sql` | exact (CHECK swap) |
| `supabase/migrations/044_seed_counties.sql` | migration (seed) | bulk insert | `supabase/migrations/040_seed_bmh_sms_templates.sql` | exact (DO $$ + org lookup + ON CONFLICT) |
| `supabase/migrations/045_backfill_property_county_id_from_fips.sql` | migration (backfill) | UPDATE...FROM JOIN | `supabase/migrations/036_backfill_contact_name_casing.sql` (idempotent UPDATE) + `030_source_enum_unification.sql` (txn wrap) | role-match |
| `src/app/(dashboard)/properties/prospects-query.ts` (modify) | types/const + parser | server-side | own file lines 76-90 (replace `KNOWN_MARKETS` const + `KnownMarket` type + `isKnownMarket`) | self (eliminate) |
| `src/app/(dashboard)/import/wizard.tsx` (modify) | client component (state machine) | props-in | `src/app/(dashboard)/lists/page.tsx` server-fetch → `src/app/(dashboard)/lists/lists-table.tsx` client receiver | role-match (server→client list pass) |
| `src/app/(dashboard)/import/page.tsx` (modify) | RSC page | server fetch | `src/app/(dashboard)/lists/page.tsx` lines 44-70 | exact (RSC supabase fetch + pass to client) |
| `src/app/(dashboard)/import/steps/step-upload.tsx` (modify) | client component (form step) | props-in | own file lines 39-55 (`SOURCES` array — already prop-mapped pattern) | self (replace `MARKETS` literal with prop) |
| `src/app/(dashboard)/import/actions.ts` (modify) | server action | RPC | own file lines 18-63 (replace `WizardMarket` with `string` + add `county_id`) | self (type swap) |
| `src/app/(dashboard)/properties/prospects-table.tsx` (modify) | client component (filter pill) | props-in | own file lines 1020-1048 (replace `KNOWN_MARKETS.map` with `markets` prop) | self (prop injection) |
| `src/app/(dashboard)/leads/new/page.tsx` (modify) | RSC page (form) | server fetch | own file lines 26-31 (replace `MARKETS` literal with supabase fetch via existing `createClient`) | self (literal→fetch) |
| `src/app/(dashboard)/properties/prospects-query.test.ts` + `leads/filter.test.ts` + `lists.integration.test.ts` + `tags.integration.test.ts` (modify) | unit/integration tests | fixture | `src/app/(dashboard)/properties/prospects-query.test.ts` lines 216-223 (replace `KNOWN_MARKETS` assertion + Kansas City fixtures) | exact |

---

## Pattern Assignments

### `supabase/migrations/043_counties_add_fips_and_drop_market_check.sql` (DDL — drop CHECK + add column)

**Analog:** `supabase/migrations/030_source_enum_unification.sql`

**Why this analog:** The existing `counties` table has a CHECK constraint locking `market` to the four old city-shaped values (`001_initial.sql:30`):
```sql
market text not null check (market in ('Kansas City','St. Louis','Dayton','Lake of the Ozarks')),
```
That constraint **will reject every county insert in 044** (`Buchanan County MO`, `Johnson County KS`, etc.) unless dropped first. Migration 030 is the canonical analog for "drop CHECK, replace with new vocabulary, wrap in BEGIN/COMMIT."

**CHECK constraint swap pattern** (`030_source_enum_unification.sql:31-66`):
```sql
begin;

-- 1. Move legacy 'other' rows to driving_for_dollars (per operator
--    confirmation: all current 'other' rows are D4D imports).
update properties
set source = 'driving_for_dollars'
where source = 'other';

-- 2. Replace the CHECK constraint with the new vocabulary.
alter table properties
  drop constraint if exists properties_source_check;

alter table properties
  add constraint properties_source_check
  check (
    source is null
    or source = any (array[
      'dealmachine', 'propstream', 'driving_for_dollars',
      'referral', 'cold_call', 'sms', 'web_form', 'direct_mail'
    ])
  );

commit;
```

**Adaptation for 043 (apply this shape):**
- Drop `counties_market_check` (the auto-named CHECK from `001_initial.sql:30`); use `drop constraint if exists` so the migration is idempotent and survives re-runs against either prod or test.
- Do **NOT** re-add a CHECK on `counties.market` — D-01 says counties is the source of truth, so any string a row holds is by definition valid. (A CHECK would re-introduce the hard-coded enum we're trying to delete.)
- Add `fips_code text` column to `counties` (nullable; CASS jsonb backfill in 045 fills it).
- Add a unique index on `counties.fips_code` where not null (so `045`'s UPDATE...FROM JOIN can rely on at-most-one-county-per-fips). Pattern: `001_initial.sql:65-67` — partial unique index where col is not null.

**Add-column pattern** (`013_motivation_level.sql:19-21`):
```sql
alter table properties
  add column motivation_level text
  check (motivation_level is null or motivation_level in ('hot', 'warm', 'cold'));
```
Apply same `alter table … add column …` shape for `counties.fips_code text` (no CHECK).

**Gotchas:**
- **CI-only.** Per project memory `feedback_migrations_only_via_ci.md` and `db-migrate.yml` lines 37-43, the file lands via PR → merge to main → workflow auto-applies to **both** prod (`copflsklaefwzipsrjqz`) and test (`ncsngxlcyxylaeskiteu`). Never run locally with `supabase db push` against prod and never use the MCP `apply_migration` tool.
- **schema_migrations sync.** Per project memory `project_rtl_migration_and_test_db_2026_04_30.md`, prod and test now both track `001`-`042`. Migration 043 will land on both.

---

### `supabase/migrations/044_seed_counties.sql` (seed — bulk INSERT scoped to BMH org)

**Analog:** `supabase/migrations/040_seed_bmh_sms_templates.sql`

**Why this analog:** Same shape as the new file — `INSERT … VALUES (…)` for ~20-23 rows scoped to BMH Group's org_id, idempotent via ON CONFLICT.

**Org-scoped seed pattern** (`040_seed_bmh_sms_templates.sql:4-58`):
```sql
DO $$
DECLARE
  v_org_id uuid;
BEGIN
  SELECT id INTO v_org_id FROM public.organizations WHERE name = 'BMH Group' LIMIT 1;
  IF v_org_id IS NULL THEN
    RAISE NOTICE 'BMH Group org not found — skipping template seed';
    RETURN;
  END IF;

  INSERT INTO public.sms_templates (org_id, name, content, category, system_managed) VALUES
  (v_org_id, 'Owner check (consensus)', 'Are you the owner of {{property_address}}?', 'Outreach - Homeowner', true),
  -- … more rows …
  (v_org_id, 'First-message identification', '...', 'Compliance', true)
  ON CONFLICT (org_id, name) DO NOTHING;
END;
$$;
```

**Adaptation for 044:**
- Replace `sms_templates` with `counties`; columns are `(org_id, name, state, market, fips_code)`.
- The existing `unique (name, state)` constraint on counties (`001_initial.sql:33`) is the natural ON CONFLICT target → use `ON CONFLICT (name, state) DO UPDATE SET market = EXCLUDED.market, fips_code = EXCLUDED.fips_code` so re-running the migration also corrects market labels and fills fips after the column was added by 043.
- Look up `fips_code` per row by joining the static `fips_codes` table (`001_initial.sql:111-117`) on `(state_code, lower(county_name))`. Inline subquery per VALUES row keeps the seed self-contained:
  ```sql
  (v_org_id, 'Buchanan County', 'MO', 'Buchanan County MO',
   (SELECT fips_code FROM fips_codes WHERE state_code='MO' AND lower(county_name) = lower('Buchanan'))),
  ```
- The 18 confirmed counties from CONTEXT.md D-02 go in unconditionally. The 3 "pending Jarrad confirm" counties (Cass MO, Wyandotte KS, Riley KS) should be **omitted from this migration** — Jarrad has not confirmed them in CONTEXT.md and adding them is reversible-with-pain, omission is reversible-easy.

**Gotchas:**
- **Two-letter state casing.** Migration `038_backfill_address_2letter_casing.sql` exists because state codes were inconsistent. Use uppercase 2-letter (`'MO'`, `'KS'`) to match `fips_codes.state_code`.
- **County name format.** `fips_codes.county_name` likely stores names without "County" / "Parish" suffix (e.g., `'Buchanan'`, `'Lincoln'`). The `counties.name` per CONTEXT.md D-02 stores **with** suffix (`'Buchanan County'`, `'Lincoln Parish'`). Strip the suffix when joining `fips_codes`:
  ```sql
  WHERE lower(county_name) = lower(regexp_replace('Lincoln Parish', ' (County|Parish)$', '', 'i'))
  ```
  Planner: spike this against the actual `fips_codes` data shape via MCP **read-only query** before locking the seed file (no `apply_migration`).
- **Idempotent.** ON CONFLICT DO UPDATE means re-running the migration in CI on a re-deploy is safe — fips backfills and market relabels are forward-compatible.

---

### `supabase/migrations/045_backfill_property_county_id_from_fips.sql` (backfill — UPDATE...FROM JOIN)

**Analog:** Hybrid: `supabase/migrations/036_backfill_contact_name_casing.sql` (idempotent re-runnable UPDATE) + `030_source_enum_unification.sql` (BEGIN/COMMIT wrap, ordered numbered steps in comments).

**Why no exact analog:** No prior migration does an UPDATE-with-FROM JOIN backfill on properties — most backfills are single-table self-update (initcap) or simple value-swap (`source='other'` → `'driving_for_dollars'`). The new pattern (join through `counties.fips_code` we just added in 043) is novel. The two analogs above provide the wrapping idiom; the JOIN body is fresh code.

**Idempotent re-run pattern** (`036_backfill_contact_name_casing.sql:1-13`):
```sql
-- Backfill first_name / last_name on contacts to title-case.
-- WHERE clause skips rows that are already correct or NULL so re-running is safe.

UPDATE contacts
SET first_name = initcap(first_name)
WHERE first_name IS NOT NULL
  AND first_name != initcap(first_name);
```
Apply: gate the UPDATE with `WHERE properties.county_id IS NULL` so re-runs no-op on already-backfilled rows. **Critical** because db-migrate.yml's `supabase db push` is idempotent only at the file-application level — within a file, you must make the SQL itself idempotent.

**Numbered-step + transaction wrap pattern** (`030_source_enum_unification.sql:31-66`):
```sql
begin;

-- 1. Move legacy 'other' rows to driving_for_dollars …
update properties set source = 'driving_for_dollars' where source = 'other';

-- 2. Defensive: any row still on a removed value …
update properties set source = 'driving_for_dollars' where source in (...);

commit;
```
Apply same `begin / commit` + numbered comment shape. Suggested step ordering for 045:

1. **fips_code path** (1,149 rows): `UPDATE properties p SET county_id = c.id, market = c.market FROM counties c WHERE c.fips_code = p.fips_code AND p.fips_code IS NOT NULL AND p.county_id IS NULL;`
2. **CASS jsonb fallback path** (~26 rows with no fips_code but a CASS response): extract `cass_raw_response[0]->'metadata'->>'county_fips'` (per CONTEXT.md `<canonical_refs>`) and JOIN `counties` on `fips_code`.
   - Use the `->` and `->>` jsonb operators; reference `src/lib/enrichment/types.ts:42` and `src/lib/enrichment/verify-property.ts:95` for the canonical jsonb shape.
3. **Leave the rest alone.** The ~1,358 rows with neither fips_code nor CASS response keep `market='Kansas City'`, `county_id=NULL` per D-05. **Do not** insert a synthetic "Kansas City" county row.
4. **Outliers** (TX/CA/CO test data): the JOIN naturally leaves these with `county_id=NULL` because no matching counties row exists. No special handling needed.

**Gotchas:**
- **No DB triggers for market sync.** Per D-04, `properties.market` stays as a synced text cache that's set together with `county_id` at write time (in app code: import action, wizard, this migration). Do **not** add a Postgres trigger to keep them in sync — that would be invisible application behavior. The migration sets both columns in one UPDATE; future writes set both in `src/app/(dashboard)/import/actions.ts` and wherever else properties are inserted.
- **Read-only MCP for verification only.** Planner can verify row counts (1149, 26, 1358) via MCP read-only queries before locking the migration. Apply step is CI exclusively.

---

### `src/app/(dashboard)/properties/prospects-query.ts` (modify — eliminate `KNOWN_MARKETS` + `KnownMarket`)

**Analog:** Self. The const + type + parser narrowing all live in this file.

**Current pattern to delete** (lines 76-90):
```typescript
export const KNOWN_MARKETS = [
  "Kansas City", "St. Louis", "Dayton", "Lake of the Ozarks",
] as const;

export type KnownMarket = (typeof KNOWN_MARKETS)[number];

function isKnownMarket(value: unknown): value is KnownMarket {
  return (
    typeof value === "string" &&
    (KNOWN_MARKETS as readonly string[]).includes(value)
  );
}
```

**Also delete** the literal-typed market field on `ParsedProspectsFilters` (lines 60-62):
```typescript
/** ?market=Kansas+City — narrowed to the wizard's known markets so a
 *  bogus value doesn't 500 the query. */
market: "Kansas City" | "St. Louis" | "Dayton" | "Lake of the Ozarks" | null;
```

**Replacement pattern:**
- Loosen `ParsedProspectsFilters.market` to `string | null`. Per D-01, validation moves to a runtime check against the `counties` table — but for URL parsing, accepting any string is safe because the filter just becomes `WHERE market = ?` against whatever the dropdown emitted (dropdown is now also DB-driven, so the pair is consistent).
- Remove `isKnownMarket` and its caller. Replace the `isKnownMarket(value) ? value : null` narrowing in `parseProspectsSearch` with a `value?.trim() || null` shape (mirror how the existing search field is parsed at lines 38-44 of the same file).
- Remove the `export` of `KNOWN_MARKETS` and `KnownMarket`. The only consumers are `prospects-table.tsx` (line 31 import — see below) and `prospects-query.test.ts` (line 9 import — see test section).

**Gotchas:**
- **Backward-compat.** Loosening the literal union to `string` is a breaking change to anything that imports `KnownMarket`. Grep confirms only `prospects-table.tsx` does. Update that import in lockstep.
- **Default JSON-parse strictness.** No new validation lib needed — the existing `pickFirst`/`String(v).trim()` shape in this file is sufficient.

---

### `src/app/(dashboard)/import/page.tsx` (modify — add server-fetch of counties, pass to Wizard)

**Analog:** `src/app/(dashboard)/lists/page.tsx` lines 44-70.

**Current state** (`import/page.tsx:1-21`):
```tsx
import { Page } from "@/components/page";
import { PageHeader } from "@/components/page-header";

import { Wizard } from "./wizard";

export default function ImportPage() {
  return (
    <Page>
      <PageHeader breadcrumb={[{ label: "Workspace" }, { label: "Import" }]} title="Import" … />
      <Wizard />
    </Page>
  );
}
```
**Note:** This is currently a sync server component with no data fetch. Needs to become `async`.

**Server-fetch + pass-to-client pattern** (`lists/page.tsx:44-70`):
```typescript
export default async function ListsPage({
  searchParams,
}: {
  searchParams: Promise<{ … }>;
}) {
  const raw = await searchParams;
  // … parse URL state …
  const supabase = await createClient();

  // Build the base lists query.
  const { data: lists } = await supabase
    .from("lists")
    .select("…")
    .order("name", { ascending: true });
```

**Adaptation:**
- Make `ImportPage` `async`.
- `import { createClient } from "@/lib/supabase/server";` (path proven by 9+ existing usages in the dashboard tree).
- Fetch counties: `const { data: counties } = await supabase.from("counties").select("id, name, state, market").order("state").order("name");`
- Pass to Wizard: `<Wizard counties={counties ?? []} />`

**Page wrapper pattern** (per project memory `project_design_refresh_shipped.md`):
- Keep the existing `<Page>` + `<PageHeader>` shell — every dashboard route has this.

---

### `src/app/(dashboard)/import/wizard.tsx` (modify — accept counties prop, replace `WizardMarket` union)

**Analog:** Self + the `<Wizard>` consumer pattern in `src/app/(dashboard)/lists/page.tsx` → `<ListsTable rows={...}>` server-to-client list pass.

**Current pattern to delete** (lines 101-105):
```typescript
export type WizardMarket =
  | "Kansas City" | "St. Louis" | "Dayton" | "Lake of the Ozarks";
```
And `WizardState.market: WizardMarket | null` (line 169) → `market: string | null`.
And `SET_MARKET` action `market: WizardMarket` (line 237) → `market: string`.

**Current Wizard signature** (line 350):
```typescript
export function Wizard() {
  const [state, dispatch] = useReducer(reducer, initialState);
  …
}
```

**Adaptation:**
```typescript
export type CountyOption = {
  id: string;
  name: string;
  state: string;
  market: string;
};

export function Wizard({ counties }: { counties: CountyOption[] }) {
  const [state, dispatch] = useReducer(reducer, initialState);
  …
}
```
Then pass `counties` down through the StepUpload props (mirror how `state` and `dispatch` are already passed to step components — `step-upload.tsx:64`).

**Also add** `countyId: string | null` to `WizardState` so `actions.ts` can receive both `market` (cache string) and `county_id` (FK) per D-04 + D-06. The `SET_MARKET` action becomes `{ type: "SET_MARKET", market: string, countyId: string }`.

---

### `src/app/(dashboard)/import/steps/step-upload.tsx` (modify — replace `MARKETS` literal with prop)

**Analog:** Self. The existing `SOURCES` array (lines 39-48) is the exact shape we need for markets — a `{ value, label }[]` driving a `<Select>` dropdown.

**Current pattern to replace** (lines 50-55):
```typescript
const MARKETS: { value: WizardMarket; label: string }[] = [
  { value: "Kansas City", label: "Kansas City" },
  { value: "St. Louis", label: "St. Louis" },
  { value: "Dayton", label: "Dayton" },
  { value: "Lake of the Ozarks", label: "Lake of the Ozarks" },
];
```

**Existing dispatch shape** (line 278):
```typescript
dispatch({ type: "SET_MARKET", market: v as WizardMarket })
```

**Replacement:**
- Add `counties: CountyOption[]` to the `Props` type (line 64).
- Delete the local `MARKETS` const.
- In the `<SelectContent>` for the market picker, map over `counties.map(c => <SelectItem key={c.id} value={c.id}>{c.market}</SelectItem>)` — value is the `county_id`, label is the canonical market string.
- Update the dispatch to look up the chosen county and emit both `market` + `countyId`:
  ```typescript
  onValueChange={(id) => {
    const c = counties.find((x) => x.id === id);
    if (c) dispatch({ type: "SET_MARKET", market: c.market, countyId: c.id });
  }}
  ```

**Gotchas:**
- **`WizardMarket` import (line 34) goes away.** Drop it from the import block.
- **Dropdown sort.** Counties are already pre-sorted by state then name in the server fetch, so the dropdown renders in groupable order. Optional follow-up: render a `<SelectGroup>` per state.

---

### `src/app/(dashboard)/import/actions.ts` (modify — replace `WizardMarket` type, accept `county_id`)

**Analog:** Self.

**Current pattern** (lines 18-23, 52-63):
```typescript
import type { WizardMarket, WizardSource } from "./wizard";

export type CreateImportJobParams = {
  filename: string;
  source: WizardSource;
  market: WizardMarket;
  …
};

…
const { data: importRow } = await supabase
  .from("csv_imports")
  .insert({
    filename: params.filename,
    source: params.source,
    market: params.market,
    total_rows: params.totalRows,
    storage_path: params.storagePath,
    user_id: userId,
  })
```

**Replacement:**
- Drop `WizardMarket` from the type import.
- `market: WizardMarket` → `market: string`.
- Add `countyId: string` to `CreateImportJobParams`.
- The `csv_imports` insert keeps `market: params.market` (cache string).
- The downstream property insert (in `csv-import` workflow, find via `grep -rn "from(\"properties\").insert\|from('properties').insert"`) needs to set both `market` AND `county_id` together per D-04. Planner: surface that workflow in plan 02-03 and update it in lockstep.

**Gotchas:**
- **`csv_imports.market` is a free-text column** today (no CHECK constraint per `001_initial.sql` — confirm via grep). If it does have a CHECK constraint matching the old four cities, that constraint also has to be dropped in migration 043. Planner: verify before locking.

---

### `src/app/(dashboard)/properties/prospects-table.tsx` (modify — replace `KNOWN_MARKETS` with prop)

**Analog:** Self lines 1020-1048 (existing pattern for the Market filter pill).

**Current pattern** (lines 31, 1038-1046):
```typescript
import {
  …
  KNOWN_MARKETS,
  …
  type KnownMarket,
  …
} from "./prospects-query";

…

{KNOWN_MARKETS.map((m) => (
  <DropdownMenuItem
    key={m}
    onClick={() => onChange({ market: m as KnownMarket })}
    data-testid={`filter-market-${m.replace(/\s+/g, "-")}`}
  >
    {m}
  </DropdownMenuItem>
))}
```

**Replacement:**
- Drop `KNOWN_MARKETS` and `KnownMarket` from the import.
- Add `markets: string[]` to the table component's props (the parent server component on `/properties/page.tsx` fetches `counties.market` strings and passes them — same shape as the import page's counties fetch but only the `market` field is needed here).
- Replace `KNOWN_MARKETS.map((m) => …)` with `markets.map((m) => …)`.
- Replace `m as KnownMarket` with just `m` (the `ParsedProspectsFilters.market` field is now `string | null`).

**Parent `/properties/page.tsx` updates:**
- Add `const { data: counties } = await supabase.from("counties").select("market").order("market");` to the existing async page.
- Pass `markets={counties?.map(c => c.market) ?? []}` to the table.

**Gotchas:**
- **`data-testid` attribute.** The current pattern uses `m.replace(/\s+/g, "-")` to build a test id. The new market strings have whitespace too (`"Buchanan County MO"` → `"Buchanan-County-MO"`). The transform still works — the existing `prospects-table.test.tsx` may have hard-coded test-ids referencing the old names. Update those in lockstep with the test plan.

---

### `src/app/(dashboard)/leads/new/page.tsx` (modify — replace local `MARKETS` literal with server fetch)

**Analog:** Self lines 26-31 + the `lists/page.tsx` server-fetch idiom.

**Current pattern** (lines 26-31):
```typescript
const MARKETS = [
  "Kansas City", "St. Louis", "Dayton", "Lake of the Ozarks",
];
```

**Replacement:** This file is **already** an async RSC with `createClient()` (line 7, line 41). Add a counties fetch right after the auth check, before the return:

```typescript
const { data: counties } = await supabase
  .from("counties")
  .select("market")
  .order("state")
  .order("name");
const markets = counties?.map((c) => c.market) ?? [];
```

Then in the form (search the file for `MARKETS.map`), render `markets.map(...)` instead.

**Gotchas:**
- **STATES const (line 33).** That's separate — it's a US-states list for the address form, not markets. Leave it alone.

---

### Test updates — `prospects-query.test.ts` + `leads/filter.test.ts` + `lists.integration.test.ts` + `tags.integration.test.ts`

**Analog:** `prospects-query.test.ts:216-223` is the canonical "market enum assertion" pattern — every other test that hard-codes "Kansas City" follows the same shape.

**Pattern to delete** (`prospects-query.test.ts:216-223`):
```typescript
it("KNOWN_MARKETS exposes the four configured markets", () => {
  expect(KNOWN_MARKETS).toEqual([
    "Kansas City", "St. Louis", "Dayton", "Lake of the Ozarks",
  ]);
});
```
Delete this test entirely — `KNOWN_MARKETS` no longer exists. The replacement is the integration-test that lists counties from the test DB (covered by 044's seed running on test).

**Fixture pattern in `leads/filter.test.ts:5-38`:**
```typescript
const leads: SearchableLead[] = [
  { address: "123 Main St", city: "Kansas City", state: "MO", zip: "64108", market: "Kansas City", … },
  { address: "456 Oak Ave", city: "St. Louis", state: "MO", zip: "63101", market: "St. Louis", … },
  { address: "789 Pine Rd", city: "Dayton", state: "OH", zip: "45401", market: "Dayton", … },
  …
];
```
**Update strategy:** swap fixture markets to county-shaped. Keep at least 2 markets in the fixtures so the multi-market filter logic stays exercised (e.g., `"Jackson County MO"` and `"Johnson County KS"`). The asserted behavior (case-insensitive multi-token search) is unchanged — only the strings differ.

**Integration test fixtures** (`lists.integration.test.ts:255`, `tags.integration.test.ts:41,165,173,204,216,233,241,253`):
```typescript
.insert({ filename: "test.csv", source: "dealmachine", market: "Kansas City" })
```
Hard-coded `"Kansas City"` strings on the `csv_imports` insert + properties inserts. Either:
- (a) Replace with `"Jackson County MO"` (the county-shaped equivalent for the same legacy KC area), OR
- (b) Leave as `"Kansas City"` since per D-05 the unresolved 1,358 prod rows also keep that string. Pragmatic choice: leave them (these fixtures don't validate the migration, they validate list/tag behavior on properties), and add **one** new integration test that asserts a property created via the import wizard with a real county_id ends up with both `market = 'Jackson County MO'` and `county_id IS NOT NULL`.

**Recommendation:** option (b) — minimum-fixture-churn keeps the test diff focused on the actual refactor, and the legacy "Kansas City" string is a real production state that will exist for months until CASS catches the unresolved properties.

**Gotchas:**
- **Test DB state.** Migration 044 seeds counties on the **test** DB too (per `db-migrate.yml` parallel jobs). Integration tests can rely on `counties` being populated after the migration ships. Tests that need a county should look it up by `(name, state)` rather than hard-coding a `county_id` UUID.
- **Per project memory `feedback_test_every_fix.md`:** every fix gets a test. The 045 backfill needs a test that proves: (i) properties with fips end up with correct county_id, (ii) properties without fips keep `market='Kansas City'`, county_id=NULL, (iii) re-running the migration is idempotent. Add as `migrations/045.integration.test.ts` or similar.

---

## Shared Patterns

### CI-only migration application

**Source:** `.github/workflows/db-migrate.yml` lines 37-91

**Apply to:** All three migrations (043, 044, 045)

```yaml
on:
  push:
    branches: [main]
    paths:
      - "supabase/migrations/**"
      - ".github/workflows/db-migrate.yml"
  workflow_dispatch: {}

jobs:
  migrate-prod:
    env:
      PROD_PROJECT_REF: copflsklaefwzipsrjqz
    steps:
      - uses: supabase/setup-cli@v1
      - run: supabase link --project-ref "$PROD_PROJECT_REF"
      - run: supabase db push --password "${{ secrets.PROD_SUPABASE_DB_PASSWORD }}"
  migrate-test:
    env:
      TEST_PROJECT_REF: ncsngxlcyxylaeskiteu
    # … same shape …
```

**Implications for plan 02-01 / 02-03:**
- Drop the `.sql` file in `supabase/migrations/` with the next-available number (043, 044, 045 unless other PRs land first — re-number if so).
- Open PR. Merge to `main` triggers the workflow. The migration applies to **prod and test** in parallel.
- **Never** call `mcp__supabase__apply_migration` against prod. Per project memory `feedback_migrations_only_via_ci.md`.
- **Never** run `supabase db push` locally against prod. Test DB is OK for spike work but the file must still ship through CI for the migration history to record.

### Server fetch → client component prop pass

**Source:** `src/app/(dashboard)/lists/page.tsx:44-70` + `src/app/(dashboard)/leads/new/page.tsx:35-44`

**Apply to:** All four UI surfaces that need the counties dropdown:
- `import/page.tsx` → `<Wizard counties={counties}>`
- `properties/page.tsx` → `<ProspectsTable markets={markets}>`
- `leads/new/page.tsx` → inline render
- (Defer plan 02-02 → 02-03) any future surface

**Pattern:** RSC fetches via `await createClient()` then `.from('counties').select(...).order(...)`, passes the array as a prop. Client component receives a typed prop and renders. **No useState mirror** of the prop (per project memory `feedback_no_usestate_mirror_of_server_props.md`) — render directly from props.

### Page + PageHeader wrapper

**Source:** `src/app/(dashboard)/import/page.tsx:11-20`, `src/app/(dashboard)/leads/new/page.tsx:54-64`

**Apply to:** All modified RSC pages.

```tsx
<Page>
  <PageHeader breadcrumb={[…]} title="…" description="…" />
  <Wizard counties={counties ?? []} />
</Page>
```
Per project memory `project_design_refresh_shipped.md` — every dashboard route uses this shell. Don't refactor it away during this phase.

### Result-style server actions

**Source:** `src/app/(dashboard)/import/actions.ts:44-73`

**Apply to:** Any new server action introduced in this phase.

```typescript
export async function createImportJob(
  params: CreateImportJobParams,
): Promise<Result<CreateImportJobResult>> {
  try {
    const supabase = await createClient();
    …
    if (importError) {
      return {
        ok: false,
        error: { code: "CSV_IMPORT_INSERT_FAILED", message: importError.message },
      };
    }
    return ok({ jobId: importRow.id });
  } catch (e) {
    return errFromUnknown(e);
  }
}
```
Phase 2 may not need new server actions (the existing `createImportJob` and `submitNewLead` are sufficient — they just receive different params). Pattern is documented here in case the planner spots a need.

---

## No Analog Found

| File | Role | Data Flow | Reason / Closest Pattern |
|------|------|-----------|--------------------------|
| `supabase/migrations/045_backfill_property_county_id_from_fips.sql` | backfill (UPDATE...FROM JOIN through new column) | data | Hybrid analog (036 + 030) covered above. The JOIN-from-jsonb fallback step (CASS path) is genuinely new — no migration has previously read `cass_raw_response[0]->'metadata'->>'county_fips'`. Closest cross-reference: `src/lib/enrichment/types.ts:42` + `src/lib/enrichment/verify-property.ts:95` for the canonical jsonb shape. Planner should write the JOIN by hand following Postgres jsonb operator docs. |

Everything else has a strong analog in the existing codebase.

---

## Metadata

**Analog search scope:**
- `supabase/migrations/*.sql` (all 42 existing migrations scanned)
- `.github/workflows/`
- `src/app/(dashboard)/import/`
- `src/app/(dashboard)/properties/`
- `src/app/(dashboard)/leads/`
- `src/app/(dashboard)/lists/`
- `src/lib/supabase/`
- `src/lib/enrichment/`

**Files scanned:** ~30
**Pattern extraction date:** 2026-05-05
