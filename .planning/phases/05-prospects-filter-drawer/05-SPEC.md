# Phase 05: Prospects Filter Drawer — Specification

**Created:** 2026-05-07
**Ambiguity score:** 0.14 (gate: ≤ 0.20)
**Requirements:** 9 locked

## Goal

Replace the 5 fixed chip filters on `/properties` with a right-side filter drawer (REISift-style block-stack architecture) plus a per-user **Quick Filters** chip bar above the table, exposing 19 filter blocks the existing schema can power today, with persisted user-saved presets.

## Background

Today `/properties` (the Prospects page, ~1,462 rows) renders 5 fixed chip filters: Vacant · Verified · Contacted · Market · Assignee — wired in `src/app/(dashboard)/properties/page.tsx` (lines 30-289) and `src/app/(dashboard)/properties/prospects-table.tsx` (lines 1033-1154). The query layer in `prospects-query.ts` parses 5 search params and applies the corresponding predicates.

That surface is too coarse for the user's daily workflow. He cannot:
- Combine "vacant + on multiple lists + replied within 30 days"
- Filter to AI-escalated leads (`needs_human_attention`)
- See prospects with overdue follow-up tasks (the `tasks` table exists but isn't a filter source)
- Slice by `motivation_level` (column + index exist; never surfaced)
- See unread inbound (`idx_messages_unread_inbound` exists; never surfaced)
- Filter by stack count (`property_stack_counts` view exists; never surfaced)

Pain compounds with every CSV import he runs. The competitor research surfaced REISift's "Filter Blocks" architecture as the right IA — block-stack drawer that scales from 5 to 50+ filters cleanly. The existing `Sheet` primitive at `src/components/ui/sheet.tsx` already provides the right-side drawer shell.

A separate Claude session is running Phase 04 (Tasks Integrations — Slack + Calendar) in parallel in a different worktree; the two phases are independent (different surfaces, different DB objects, different migration numbers).

## Requirements

1. **Drawer shell + Add-Block picker**: A right-side pop-out filter drawer replaces the existing inline filter chips as the primary filtering surface.
   - Current: `/properties` renders 5 fixed chips inline above the table (`prospects-table.tsx:1033-1154`); no drawer exists; no way to add filters beyond the 5
   - Target: A **Filters** button next to the table opens a right-side `Sheet` (440 px wide, `side="right"`) containing a vertical stack of configured filter blocks plus a `+ Add Filter Block` button. Clicking that button opens an Add-Block picker (overlay or stacked panel) with a search input ("Search filters…", autofocus) and the 19 blocks grouped by category (General · Property · Owner · Value & Equity · Status & Engagement). Typing in the search input filters the picker live by block name.
   - Acceptance: Clicking the **Filters** button opens the drawer. Clicking `+ Add Filter Block` opens the picker with the search input focused. Typing "vacant" filters the picker to blocks whose label contains "vacant" (case-insensitive). Selecting a block adds a configured row to the drawer body and closes the picker.

2. **Filter-block library (19 blocks)**: Each block is a self-contained, repeatable, removable component with a typed configuration.
   - Current: No filter-block components exist. The 5 existing chips are hardcoded boolean / single-value toggles.
   - Target: 19 block components shipped under `src/app/(dashboard)/properties/_components/blocks/`, one file per block:
     - **General** — List · Tag · List Count · Vacancy · CASS · Outreach Disposition · Source
     - **Property** — Beds · Baths · Year Built · State · Market
     - **Owner** — Absentee
     - **Value & Equity** — Estimated Value · Equity %
     - **Status & Engagement** — Pipeline Status · Engagement (4 buckets) · Assignee · Created Date
     - **Schema-audit additions** — Has Unread Inbound · Needs Human Attention · Has Open Tasks · Motivation Level
   - Acceptance: Each of the 19 block components renders without error in isolation, accepts a configuration object, emits onChange events, and produces a SQL predicate via `src/lib/prospects/filter-to-supabase.ts` that returns the expected row count when run against a seeded fixture. The same block can be added more than once (e.g., two Lists blocks with different combinator settings) without state collisions.

3. **Combination semantics**: Filter logic across and within blocks is deterministic and matches the locked spec.
   - Current: Existing 5 chips are AND-only with no combinator UI.
   - Target: **Across blocks**: AND only. **Within a multi-select block** (Lists, Tags, Pipeline Status, Outreach Disposition, Engagement, Source, Property Type, State, Market, Assignee): tri-state combinator chosen first — `All` (AND across selected) · `Any` (OR across selected) · `Do Not Include` (NOT IN). **Tri-state booleans** (Vacancy, Absentee, Has Unread Inbound, Needs Human Attention): `Any` (no predicate) · `Yes` · `No` (where `No` = `is false OR null`). **Numeric blocks** (List Count, Beds, Baths, Year Built, Estimated Value, Equity %): min / max / range. **Date blocks** (Created Date, Owner Moved): Fixed range / Since / Prior (rolling — re-evaluates on preset reload).
   - Acceptance: A SQL test fixture proves that `Lists = Exclusively [A, B]` returns only properties on BOTH lists A and B, `Lists = Any [A, B]` returns properties on either, `Lists = Do Not Include [A]` returns properties NOT on A. `Vacancy = No` returns rows where `is_vacant = false OR is_vacant IS NULL`. List Count `min=2 max=∞` returns properties on ≥ 2 lists.

4. **Live result-count CTA + Active filters chip bar**: User sees the result count update as they configure filters, and applied filters are visible above the table even when the drawer is closed.
   - Current: No live count exists; filter state is scattered across URL params with no cumulative display.
   - Target: The drawer footer shows a primary button "**Show N prospects**" where N updates within 250 ms (debounced) as blocks are configured. Above the table (always visible — even when drawer closed) renders an Active Filters chip row: one chip per configured block with a × to remove individually, plus a "Clear all" button. Clicking × on a chip removes the block from the drawer and recomputes the count.
   - Acceptance: With the drawer closed, configuring a Vacancy = Yes block via Quick Filters renders a chip "Vacancy: Yes ×" above the table. Clicking × removes the chip and recomputes the count. Inside the drawer, toggling Vacancy from Yes to No causes the "Show N prospects" button to update its number within 500 ms.

5. **Quick Filters chip bar replaces existing 5 chips**: Per-user pinned saved presets render as chips above the table.
   - Current: 5 hardcoded chips render above the table from `prospects-table.tsx`. No way to pin custom filters.
   - Target: The 5 existing chips are removed. Above the table renders a per-user Quick Filters chip bar populated from `saved_filters WHERE starred = true AND user_id = current_user`. Clicking a chip activates that preset (rehydrates the drawer, applies the filters, updates the URL). Clicking the active chip again deactivates it. The 5 base presets seeded by migration default to starred for every user, so the bar is non-empty on first render.
   - Acceptance: After login on a clean account, the Quick Filters bar shows 5 chips: **Stacked** · **Vacant** · **Engaged** · **Cold** · **High Equity**. Clicking **Vacant** filters the table to vacant-only and updates the URL. Clicking again clears it. The old `?vacant=1`, `?cass=verified`, `?engagement=contacted`, `?market=…`, `?assignee=…` URL params no longer drive any chip in the page (they may be silently honored as a back-compat translation in v1; no UI exposes them).

6. **Saved Presets persistence**: Users can save their current filter stack as a named preset, recall it later, and pin it to the Quick Filters bar.
   - Current: No preset persistence exists.
   - Target: A `saved_filters` table (created in this phase's migration) stores `(id, org_id, user_id, name, filters_json, starred, is_base, last_run_at, last_count, created_at, updated_at)`. The drawer footer has an inline "Save as new preset…" checkbox that, when checked, reveals a name input. Clicking "Show N prospects" with the checkbox active creates the preset. Saved presets appear in a "Preset" dropdown at the top of the drawer (grouped: ─ Base ─ then ─ Mine ─). Selecting a preset rehydrates the drawer with that block stack. Each preset has a star toggle to pin/unpin to the Quick Filters bar.
   - Acceptance: Configuring 3 blocks, checking "Save as new preset…", entering "KC Out-of-State", and clicking Show prospects creates a row in `saved_filters` with the block stack serialized in `filters_json`. Refreshing the page shows "KC Out-of-State" in the Preset dropdown. Starring it adds it as a chip in the Quick Filters bar. Unstarring removes it.

7. **Migration: `saved_filters` table + 5 base presets seed (idempotent)**: The drawer's persistence layer is created via a CI-applied migration.
   - Current: No `saved_filters` table exists. `supabase/migrations/` contains 053 as the highest-numbered file.
   - Target: A new migration file `supabase/migrations/0NN_saved_filters.sql` (NN = next available; the parallel Phase 04 may take 054 + 055, so this phase takes 056 — exact number determined at write-time by listing the migrations directory). Creates `saved_filters` table with the schema above plus an index on `(user_id, starred desc, name)` and another on `(org_id, is_base) WHERE is_base = true`. Seeds 5 idempotent base preset rows per organization for the BMH Group org (with `is_base = true`, `user_id = NULL`). Per memory `feedback_migrations_only_via_ci.md`: the .sql commits to `supabase/migrations/`; CI workflow `db-migrate.yml` applies to prod + test. No local `apply_migration` MCP call.
   - Acceptance: After `db-migrate.yml` runs in CI, `select count(*) from saved_filters where is_base = true and org_id = '00000000-0000-0000-0000-000000000bbb'` returns 5. The seed is idempotent — re-running the migration does not duplicate rows. `\d saved_filters` shows the columns + indexes.

8. **URL state synchronization**: Filter state is reflected in a single URL param so deep links, browser back, and link-sharing work.
   - Current: 5 hardcoded URL params drive the existing chips.
   - Target: A single `?filters=<base64-encoded-or-url-encoded-json>` param holds the full block stack. The page renders from the URL on initial load (server-side); the drawer reads from the URL on mount; user changes update the URL via `router.replace` followed by `router.refresh` (per memory `feedback_no_usestate_mirror_of_server_props.md`). Old `?vacant=1`, `?cass=`, `?engagement=`, `?market=`, `?assignee=` params continue to render correct results in v1 via a small back-compat translator in `prospects-query.ts` (delete-able in v1.1).
   - Acceptance: Pasting a URL with a configured `?filters=` payload into a fresh tab renders the filtered results without flicker or empty state. Browser back returns to the previous filter state. Pasting an old-format URL like `/properties?vacant=1&cass=verified` still filters correctly (back-compat).

9. **Existing bulk actions remain wired to the filtered selection**: Add-to-list / Apply-tag / Assign / Skip-trace / Start-sequence operate on the filtered set, not the whole table.
   - Current: Bulk actions in `prospects-table.tsx:185-230` operate on the user's row selection within the current view. Behavior under the new filter drawer must match.
   - Target: All five bulk actions continue to work. When the user "selects all matching" rather than just visible rows, the action operates on the full filtered set (across pages). Export CSV (if not already wired in v1) is added.
   - Acceptance: Configuring a filter (e.g., Vacancy = Yes), selecting all matching, and clicking "Add to list" applies the list to all matching rows across pagination. The action panel shows the matching count, not just the page count. No regression vs. the current behavior on the pre-drawer code path.

## Boundaries

**In scope:**
- Right-side drawer (`Sheet`-based) on `/properties` only
- Add-Block picker overlay with search input + categorized list
- 19 filter-block components (listed in Requirement 2)
- AND-across / tri-state-within combination semantics
- Live result-count CTA + Active filters chip bar
- Per-user Quick Filters chip bar replacing the existing 5 fixed chips
- Saved Presets persistence with 5 idempotent base presets
- One migration: `saved_filters` table + base preset seed
- URL state synchronization with back-compat translator for old chip URL params
- Bulk-action regression check (already-wired actions continue to operate on filtered set)
- Playwright smoke test verifying drawer flow + screenshot evidence

**Out of scope:**
- Last-Message Age, Tag Count, Mortgage Balance, Equity $, LTV %, Estimated Wholesale Value, filter-by-csv-import-job, Sequence Enrollment, Last Message Direction, Tag Category filter, Skip-Trace Status detail — **deferred to v1.1** (correlated subqueries, denorm needs, vendor-data prep, or low-leverage)
- Distress section (Foreclosure / Lien / Tax-delinquent / Bankruptcy / Divorce / Probate / Code Violations / Eviction) — **deferred to v2** (vendor enrichment data not yet ingested)
- Owner LLC/Trust, In/Out-of-State Owner, Length of Ownership, Multi-Property Owner — **deferred to v2** (vendor data)
- Last-Updated Field compound filter (REISift's diagnostic block), Phone Status compound — **deferred to v1.1** (need audit-log infra + per-phone status persistence)
- Draw-on-map polygon / radius filter — **deferred to v2** (geo work)
- AI motivation score filter — **deferred to v2** (waiting on responder data accumulation)
- Folder-scoped preset ACL with per-user/per-role visibility — **deferred indefinitely** (overkill for current team size; lite cut)
- Auto-refresh / Smart Lists / scheduled alerts on saved presets — **deferred to v1.1** (REsimpli's Auto List Builder pattern)
- Drip-on-preset-membership-change trigger — **deferred to v1.1**
- Source filter by specific `csv_imports` job — **deferred to v1.1** (needs new column / junction); v1 source filter uses the `properties.source` enum only
- Pipeline Status block on `/properties` opens to non-prospect statuses — **partially deferred**; v1 ships the block but pre-sets it to `prospect` (user can broaden if they want cross-status filtering)
- Performance denormalization (`last_inbound_at`, `last_outbound_at`, `equity_pct_cached`) — **deferred until pain emerges** at ~10k prospects (current scale 1,462)

**Adjacent work running in parallel (separate worktree):**
- Phase 04 (Tasks Integrations V2 — Slack + Google Calendar) is being executed in `/Users/jarradhenry/Sites/Sandra-20260507-171324-04-tasks-integrations` on branch `claude/20260507-171324-04-tasks-integrations`. No file overlap with Phase 05. Migration numbers and `types.ts` regeneration coordinate via CI landing order.

## Constraints

- **Migrations are CI-only** (memory `feedback_migrations_only_via_ci.md`): the .sql file commits to `supabase/migrations/`; `db-migrate.yml` applies to prod + test. Never call `apply_migration` MCP locally against prod.
- **URL state pattern** (memory `feedback_no_usestate_mirror_of_server_props.md`): render from props (URL is a prop), use `router.replace` + `router.refresh` after URL updates, key children by URL params; do not mirror server props in `useState`.
- **Vendor abstraction** (memory `feedback_vendor_abstraction.md`): although this phase doesn't touch external vendors directly, any new query layer must keep the schema vendor-agnostic — predicates work on the existing `properties` columns, not on vendor-specific shapes.
- **Cost-bearing actions need explicit opt-in** (memory `feedback_explicit_opt_in_for_paid_actions.md`): no filter on its own triggers paid vendor calls (skip-trace, etc.) — these stay behind explicit user clicks in the bulk-action menu.
- **Existing UI primitives reused, no new dependencies**: `Sheet`, `DropdownMenu`, `Dialog`, `Checkbox`, `RadioGroup`, `Slider`, `Input`, `Badge` — all in `src/components/ui/`. No shadcn install.
- **Performance**: at 1,462 prospects, correlated subqueries (Engagement 4-bucket, Equity %) are acceptable. Document the denorm strategy in code comments for ~10k-prospect future scale; do not implement now.
- **Worktree isolation** (memory `feedback_per_agent_worktrees.md`): all file work for this phase happens in `/Users/jarradhenry/Sites/Sandra-20260507-155817-prospects-filter-panel`. Phase 04 work happens in a separate worktree.
- **Tag filter scope**: only `tags.category = 'custom'` is filterable by users (per Feature 3 rule); system-managed tag categories (source / marketing / skip_trace / phone / journey) are read-only and excluded from the Tag block's value picker.
- **Soft-delete**: every filter respects `properties.deleted_at IS NULL` implicitly (already enforced by the partial index `idx_properties_active`). No filter exposes archived/deleted records in v1.

## Acceptance Criteria

- [ ] **Filters** button on `/properties` opens a right-side `Sheet` drawer (440 px wide).
- [ ] `+ Add Filter Block` opens a picker with a focused search input and the 19 blocks grouped by category.
- [ ] Typing "vacant" in the picker filters the visible blocks to those whose label contains "vacant".
- [ ] All 19 block components render without error and produce correct row counts against a seeded fixture.
- [ ] Adding a block twice (two `Lists` blocks with different combinators) works without state collisions.
- [ ] **Across blocks** AND semantics, **within multi-select block** tri-state combinator (All / Any / Do Not Include) verified by SQL fixture test.
- [ ] **Tri-state boolean** semantics (`No` = `false OR NULL`) verified.
- [ ] **List Count** slider (min/max) returns the expected stack-count subset.
- [ ] Drawer footer shows "Show N prospects" button; N updates within 500 ms of a block configuration change.
- [ ] Active Filters chip bar above the table renders one chip per configured block, with × removal.
- [ ] Quick Filters chip bar above the table renders 5 base preset chips on a clean account: Stacked · Vacant · Engaged · Cold · High Equity.
- [ ] Clicking a Quick Filter chip rehydrates the drawer + filters the table + updates the URL; clicking again deactivates.
- [ ] Saved Preset save flow: configure 3 blocks → check "Save as new preset…" → name → Show prospects → preset exists in the dropdown after page refresh.
- [ ] Starring a saved preset adds it to the Quick Filters bar; unstarring removes it.
- [ ] Migration `0NN_saved_filters.sql` lands in CI; `select count(*) from saved_filters where is_base = true and org_id = '00000000-0000-0000-0000-000000000bbb'` returns 5; re-running the migration does not duplicate base preset rows.
- [ ] URL `?filters=<encoded-json>` deep-links work: pasting a URL into a fresh tab renders the filtered table without flicker.
- [ ] Old chip URL params (`?vacant=1`, `?cass=verified`, `?engagement=contacted`, `?market=…`, `?assignee=…`) continue to filter correctly via the back-compat translator.
- [ ] Bulk actions (Add-to-list / Apply-tag / Assign / Skip-trace / Start-sequence) operate on the filtered set, including across pagination when "select all matching" is chosen.
- [ ] Existing 5 hardcoded chips are removed from `prospects-table.tsx`.
- [ ] Tag block's value picker shows only `tags.category = 'custom'` rows.
- [ ] All filters honor `deleted_at IS NULL`.
- [ ] CI is green: typecheck + unit + RTL + Playwright golden paths.
- [ ] Playwright smoke verifies: open `/properties` → apply Vacancy=Yes + List Count ≥ 2 → screenshot the result → row count matches a direct DB query. Screenshot saved to `docs/design/screenshots/2026-05-07-phase-05-prospects-filter-v1/`.
- [ ] Drawer + Quick Filters bar opened in Chrome at native viewport for visual review (per global memory rule on UI verification).

## Ambiguity Report

| Dimension          | Score | Min  | Status | Notes                                                              |
|--------------------|-------|------|--------|--------------------------------------------------------------------|
| Goal Clarity       | 0.92  | 0.75 | ✓      | Approved plan + 5 research files + schema audit ground every block |
| Boundary Clarity   | 0.88  | 0.70 | ✓      | v1/v1.1/v2 phasing locked; deferred items individually named       |
| Constraint Clarity | 0.78  | 0.65 | ✓      | Migration discipline, URL state, perf flags all called out         |
| Acceptance Criteria| 0.82  | 0.70 | ✓      | 24 pass/fail checkboxes, all falsifiable                           |
| **Ambiguity**      | 0.14  | ≤0.20| ✓      |                                                                    |

## Interview Log

| Round | Perspective    | Question summary                                          | Decision locked                                                                                  |
|-------|----------------|----------------------------------------------------------|--------------------------------------------------------------------------------------------------|
| —     | Plan-mode      | Filter Blocks (REISift) vs Fixed Accordion (PropStream)? | **Filter Blocks lite** — block-stack IA, 19 blocks, 5 base presets, no folder ACL                |
| —     | Plan-mode      | Quick Filters bar shape — replace 5 chips, or add to?    | **Replace** — every chip is a preset; cleanest mental model                                      |
| —     | Plan-mode      | Engagement multi-select buckets?                         | **4 buckets** — Never contacted · Attempted · Replied · Opted out                                |
| —     | Plan-mode      | Is REISift's full apparatus overkill for Sandra?         | **Yes — cut to lite** — keep the IA, drop folders/ACL/preset-count limits/auto-refresh/60 blocks |
| —     | Schema audit   | What other filters can the schema power that we missed?  | **Add 4 v1 blocks** — Unread Inbound · Needs Human Attention · Has Open Tasks · Motivation Level |
| —     | Viability check| Source filter — enum vs csv_imports junction?            | v1: **enum only**; v1.1: filter by import job (needs migration)                                  |
| —     | Viability check| Performance: denorm `last_inbound_at` now or defer?      | **Defer** — fine at 1,462 prospects; denorm at ~10k                                              |

(Spec-phase interview was skipped — gate passed on initial scoring against the approved plan from `~/.claude/plans/also-please-look-at-cozy-lobster.md`. Decisions locked above came from the chat-driven gray-area work in plan mode.)

---

*Phase: 05-prospects-filter-drawer*
*Spec created: 2026-05-07*
*Next step: /gsd-discuss-phase 05 — implementation decisions (URL encoding shape, block component dispatcher pattern, save-preset auto-revalidation, etc.)*
