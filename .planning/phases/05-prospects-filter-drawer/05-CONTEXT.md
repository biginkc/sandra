# Phase 05: Prospects Filter Drawer - Context

**Gathered:** 2026-05-07
**Status:** Ready for planning

<domain>
## Phase Boundary

Replace the 5 fixed chip filters on `/properties` with a right-side filter drawer (REISift-style block-stack architecture) plus a per-user Quick Filters chip bar above the table, exposing 19 filter blocks the existing schema can power, with persisted user-saved presets. v1 lite cut — no folder ACL, no auto-refresh, no vendor-data filters.

</domain>

<spec_lock>
## Requirements (locked via SPEC.md)

**9 requirements are locked.** See `05-SPEC.md` for full requirements, boundaries, and acceptance criteria.

Downstream agents MUST read `05-SPEC.md` before planning or implementing. Requirements are not duplicated here.

**In scope (from SPEC.md):** right-side drawer (Sheet-based) on `/properties`; Add-Block picker overlay with search; 19 filter-block components; AND-across / tri-state-within combination semantics; live result-count CTA + Active filters chip bar; per-user Quick Filters bar replacing existing 5 chips; saved presets persistence with 5 idempotent base presets; one migration (`saved_filters` table + RLS policies + base preset seed); URL state synchronization with back-compat translator for old chip URL params; bulk-action regression check; Playwright smoke test.

**Out of scope (from SPEC.md):** Last-Message Age, Tag Count, Mortgage Balance, Equity $, LTV %, Estimated Wholesale Value, csv-import-job filter, Sequence Enrollment, Last Message Direction, Tag Category, Skip-Trace Status detail (→ v1.1); Distress section (Foreclosure / Lien / Tax-delinquent / Bankruptcy / Divorce / Probate / Code Violations / Eviction) (→ v2); Owner LLC/Trust, In/Out-of-State Owner, Length of Ownership, Multi-Property Owner (→ v2 vendor data); Last-Updated Field compound, Phone Status compound (→ v1.1); Draw-on-map (→ v2); AI motivation score (→ v2); folder-scoped preset ACL (deferred indefinitely); auto-refresh / Smart Lists / scheduled alerts (→ v1.1); drip-on-preset-membership-change (→ v1.1); performance denormalization (deferred until ~10k prospects).

</spec_lock>

<decisions>
## Implementation Decisions

### URL State

- **D-01:** Filter state serializes to a single URL param `?filters=<encoded-json>` where the JSON shape is `{ "v": 1, "blocks": [...] }`. The `v` version field future-proofs schema migrations. Encoding uses `encodeURIComponent(JSON.stringify(state))` (URL-encoded JSON, not base64) — debuggable in DevTools, no obfuscation. Length stays well under URL limits at v1 block counts.
- **D-02:** URL state is the source of truth. The drawer reads from URL on mount; user changes update the URL via `router.replace(newUrl, { scroll: false })` followed by `router.refresh()` (per memory `feedback_no_usestate_mirror_of_server_props.md`). No `useState` mirror of URL state.
- **D-03:** Old chip URL params (`?vacant=1`, `?cass=verified`, `?engagement=contacted`, `?market=…`, `?assignee=…`) get translated by a back-compat shim in `prospects-query.ts`. The shim runs once at read time, builds an equivalent block stack, and proceeds normally. UI does not surface the old params. Shim is delete-able in v1.1 once any saved bookmarks/links have aged out.

### Block Component Architecture

- **D-04:** Block components live under `src/app/(dashboard)/properties/_components/blocks/` with one file per block kind. Names match the kind exactly (`list-block.tsx`, `vacancy-block.tsx`, …). Standard React controlled-component pattern: `props = { config, onChange }`.
- **D-05:** Block kinds are a TypeScript discriminated union in `src/lib/prospects/filter-schema.ts`. The dispatcher is a typed map `{ [kind]: React.LazyExoticComponent }` — code-splits each block; the picker only loads the bundle for blocks the user actually adds.
- **D-06:** Each configured block has a client-generated UUID (`crypto.randomUUID()`) that stays stable across reorders. Used as the React key and for the `× remove` action.
- **D-07:** Same block kind can appear multiple times in the stack (e.g., two Lists blocks with different combinator settings) without state collisions, because keys are UUIDs not kinds.

### Filter → SQL Translation

- **D-08:** Translation is a pure function in `src/lib/prospects/filter-to-supabase.ts` — takes `(blockStack, supabaseQueryBuilder)` and returns the query builder with predicates applied. Pure = trivially unit-testable, no side effects.
- **D-09:** One `applyBlock(builder, block)` function per block kind, dispatched by `block.kind`. The translator never bypasses RLS — it relies on the table-level RLS policies (per migration 054) to enforce org-scoping. Where RLS isn't sufficient (e.g., the count server action needs an authoritative `org_id`), the helper `src/lib/auth/require-org-membership.ts` is used.
- **D-10:** Soft-delete is honored implicitly via the existing `idx_properties_active` partial index — the base query starts with `.is('deleted_at', null)`. Block predicates layer on top.

### Live Result Count

- **D-11:** Drawer footer shows a "Show N prospects" button where N comes from a server action `countProspectsForFilter(filters)` defined in `src/app/(dashboard)/properties/_actions/count.ts`. Returns just the count integer, not rows.
- **D-12:** Calls debounce 250 ms via a client hook `useDebouncedFilters(filters, 250)`. The action runs through RLS (authenticated user). Loading state shows "Counting…" (preserves the button width to avoid layout shift).

### Saved Presets

- **D-13:** Server actions live in `src/app/(dashboard)/properties/_actions/saved-filters.ts`: `createSavedFilter`, `updateSavedFilter`, `deleteSavedFilter`, `togglePinSavedFilter`. Each calls `requireOrgMembership(orgId)` first per the new auth pattern, then performs the mutation, then `revalidatePath('/properties')`. Client follows up with `router.refresh()` to repaint the Quick Filters bar.
- **D-14:** `filters_json` column stores the same shape as the URL state (`{ v: 1, blocks: [...] }`). Loading a preset = parsing this JSON into the URL via `router.replace`.
- **D-15:** "Save as new preset…" inline checkbox at the drawer bottom. When checked, reveals a name input. Clicking "Show N prospects" with the checkbox active calls `createSavedFilter` with the current block stack. Toast on success; preset appears in the dropdown immediately.

### Quick Filters Bar

- **D-16:** Quick Filters bar is a server component that fetches starred + base presets (RLS-scoped) on the page render, then renders chips. Each chip is a client component that handles click → `router.replace` with the preset's filters. Star/unstar mutations follow the standard server-action + revalidatePath + router.refresh pattern.
- **D-17:** Active chip detection: the page reads the current `?filters=` URL param and compares it (deep equality on `blocks`) against each preset's `filters_json`. Match → chip rendered with active styling. Click on active chip = clear URL filter (= deactivate).

### Migration & Seeding

- **D-18:** Migration filename is `055_saved_filters.sql`. If the parallel Phase 04 worktree commits its migrations first and claims 055, this renumbers to the next available slot at write-time (check the migrations directory listing in the commit's pre-flight). Migration follows the Stage 1 RLS pattern from `054_memberships_and_rls_rewrite.sql` exactly — read it as the canonical reference for policy shape.
- **D-19:** Three RLS policies on `saved_filters`:
  - **read_own_plus_base** (SELECT): `user_id = auth.uid() OR (is_base = true AND org_id IN (SELECT m.org_id FROM memberships m WHERE m.user_id = auth.uid()))`
  - **write_own** (INSERT/UPDATE/DELETE): `user_id = auth.uid()` with `with check (user_id = auth.uid())`
  - **service_role_all**: standard service-role bypass for the seed step
- **D-20:** Base preset seed uses `INSERT … ON CONFLICT (org_id, name) WHERE is_base = true DO NOTHING` for idempotency. Five rows: Stacked / Vacant / Engaged / Cold / High Equity. Each `filters_json` constructed inline in the migration, matching the v1 block schema exactly.

### Test Strategy

- **D-21:** Three test layers, each scoped to its concern:
  - **Unit** (`vitest`): `src/lib/prospects/filter-to-supabase.test.ts` — one describe block per filter kind, each verifying the predicate against an in-memory query builder mock or a seeded fixture.
  - **Integration** (`vitest` against test Supabase): `src/lib/prospects/saved-filters.integration.test.ts` — uses `tests/integration/fixtures/multi-user.ts` to verify RLS isolation: user A cannot read user B's custom presets; both see base presets; non-member sees nothing.
  - **RTL** (`@testing-library/react`): `src/app/(dashboard)/properties/_components/filter-drawer.test.tsx` — opens drawer, adds blocks, asserts URL changes, asserts chip bar updates.
- **D-22:** Playwright smoke (`tests/e2e/properties-filter-drawer.spec.ts`): logs in, opens `/properties`, clicks Filters, adds Vacancy = Yes + List Count ≥ 2, captures result count, clicks "Show N prospects", verifies the table updates, screenshots the result. Saves to `docs/design/screenshots/2026-05-07-phase-05-prospects-filter-v1/`. Uses the test-user infra repaired in commit `ea526a5`.

### Claude's Discretion

- **CD-01:** Exact CSS / Tailwind classes for the drawer body — match the existing Sandra design system (warm-paper theme, Inter, shadow + rounded variants from `Page` + `PageHeader` patterns). No new design tokens.
- **CD-02:** Add-Block picker visual treatment (overlay vs stacked panel inside the drawer) — pick whichever feels less jarring to the user; default to a stacked panel that slides in from the right edge of the drawer over the block list, with a back arrow to return.
- **CD-03:** Active-filter chip styling on Quick Filters bar — use the existing `Badge` component variants where possible; introduce new variants only if needed for the active/inactive distinction.
- **CD-04:** Empty state in the drawer when no blocks are configured — short prompt "Add a filter to slice your prospects." with the `+ Add Filter Block` button as the focal action.
- **CD-05:** Keyboard handling inside the drawer — `Esc` closes the picker overlay; `Esc` again closes the drawer. Focus trap inside the drawer when open. Standard a11y for `Sheet` is already provided by base-ui, just don't break it.

</decisions>

<canonical_refs>
## Canonical References

**Downstream agents MUST read these before planning or implementing.**

### Phase artifacts (this phase)
- `.planning/phases/05-prospects-filter-drawer/05-SPEC.md` — Locked requirements (9 requirements, 26 acceptance checkboxes). MUST read before planning.
- `.planning/research/2026-05-07-prospects-filter-synthesis.md` — Unified synthesis of 5 competitor filter UX studies + Sandra schema viability. Source for every block decision.
- `.planning/research/2026-05-07-reisift-filter-ux.md` — Centerpiece reference for filter-block IA, tri-state combinator, Quick Filters bar pattern.
- `.planning/research/2026-05-07-resimpli-filter-ux.md` — Auto List Builder pattern (deferred to v1.1 but informs the saved_filters schema's `last_run_at` / `last_count` columns).
- `.planning/research/2026-05-07-batchleads-filter-ux.md` — List Count slider pattern (the killer feature; trivially powered by existing `property_stack_counts` view).
- `.planning/research/2026-05-07-propstream-filter-ux.md` — 20 named Lead Lists (Sandra already has these as system-managed lists).
- `~/.claude/plans/also-please-look-at-cozy-lobster.md` — Approved implementation plan (Claude Code plan-mode artifact). Provides the architectural backbone the SPEC + this CONTEXT both flow from.

### Foundational migrations (read for context, do not modify)
- `supabase/migrations/054_memberships_and_rls_rewrite.sql` — Stage 1 multi-org RLS regime. The canonical pattern this phase's `055_saved_filters.sql` must mirror.
- `supabase/migrations/051_tasks_table.sql` — `tasks` table powering the "Has Open Tasks" block.
- `supabase/migrations/045_outreach_dispo.sql` — `outreach_dispo` enum powering the "Outreach Disposition" block.
- `supabase/migrations/011_lists_and_stacking.sql` — `property_lists` junction + `property_stack_counts` view powering the List + List Count blocks.
- `supabase/migrations/010_va_polish_seams.sql` — `assigned_user_id`, `messages.read_at`, `lead_notes` table powering Assignee + Has Unread Inbound blocks.

### Reusable code surfaces
- `src/components/ui/sheet.tsx` — Drawer shell. Use `side="right"`. Already wraps base-ui dialog.
- `src/components/ui/dropdown-menu.tsx`, `dialog.tsx`, `checkbox.tsx`, `radio-group.tsx`, `slider.tsx`, `input.tsx`, `badge.tsx` — All shadcn-style primitives ready to compose.
- `src/lib/auth/memberships.ts` (NEW from migration 054) — `getCurrentMemberships()` for queries that need the membership list explicitly.
- `src/lib/auth/require-org-membership.ts` (NEW from migration 054) — Use in server actions for authoritative `org_id` resolution.
- `tests/integration/fixtures/multi-user.ts` (NEW from migration 054) — Multi-user fixture for RLS isolation tests.
- `src/app/(dashboard)/properties/page.tsx` — Page surface to modify. Currently parses 5 search params + renders fixed chips.
- `src/app/(dashboard)/properties/prospects-query.ts` — Server-side filter logic. Major rewrite target.
- `src/app/(dashboard)/properties/prospects-table.tsx` — Existing chip rendering (lines 1033-1154) to remove. Bulk-action wiring (lines 185-230) to preserve and verify against filtered set.

### Project conventions
- `.planning/PROJECT.md` — Sandra CRM project overview.
- `.planning/REQUIREMENTS.md` — Project-level requirements + out-of-scope.
- `.planning/STATE.md` — Current milestone state. Phase 04 + Phase 05 in flight in parallel worktrees.
- `.planning/ROADMAP.md` — v2.1 milestone with Phase 05 entry.
- `AGENTS.md` (project root) — "This is NOT the Next.js you know" — read `node_modules/next/dist/docs/` for the App Router conventions before writing code.

</canonical_refs>

<code_context>
## Existing Code Insights

### Reusable Assets
- **`src/components/ui/sheet.tsx`** — right-side drawer shell, base-ui based, already supports `side="right"`. Drop-in for the Filter Drawer container.
- **`src/components/ui/dropdown-menu.tsx`** — combinator selectors (All / Any / Do Not Include) and multi-select pickers.
- **`src/components/ui/dialog.tsx`** — Add-Block picker overlay if a stacked panel doesn't feel right.
- **`property_stack_counts` view** (migration 011) — already maintained, returns `(property_id, stack_count, list_ids)` per property. The List Count block is essentially free.
- **`tags.category = 'custom'`** filter pattern — already used in `page.tsx` lines 199-209 for the bulk-action tag menu. Reuse for the Tag block's value picker.
- **`counties` table + `properties.market`** — already wired in `page.tsx` lines 174-178 for the existing Market chip dropdown. Reuse the same query for the Market block.
- **`auth.users` admin lookup** — already used in `page.tsx` lines 215-222 for Assignee chip. Reuse for Assignee block.
- **`router.replace` + `router.refresh` pattern** — established in the existing chip filter wiring; reuse for URL state updates.

### Established Patterns
- **Soft-delete via partial index** — `idx_properties_active` is `WHERE deleted_at IS NULL`. Every prospects query starts from this baseline. Filter blocks layer predicates on top, never bypass.
- **Status hardcoded to 'prospect' on `/properties`** — the page is a single-status view today. Pipeline Status block ships, pre-set to `prospect`, allows broadening if user wants cross-status filtering.
- **CHECK-constraint enums (text columns)** — `cass_status`, `outreach_dispo`, `status`, `motivation_level`, `source`. Multi-select blocks use `IN (...)` predicates against the CHECK list.
- **Server actions + `revalidatePath` + client `router.refresh`** — the standard mutation pattern across the app. Saved-filter mutations follow it.
- **Cron-applied migrations via `db-migrate.yml`** — never apply locally. .sql commits to `supabase/migrations/`; CI applies in order.

### Integration Points
- **`prospects-query.ts`** — receives a parsed filter stack from the URL, builds the Supabase query, returns rows + count. Major rewrite target; back-compat translator for old chip URL params lives here.
- **`prospects-table.tsx`** — existing 5 chips removed (lines 1033-1154). Bulk-action wiring (lines 185-230) preserved + verified against filtered set.
- **`page.tsx`** — page-level layout adds `<QuickFiltersBar />` above the table, `<FilterDrawer />` trigger button, `<ActiveFiltersChips />` between the bar and the table.
- **`saved_filters` table** — new persistence target. RLS policies match the Stage 1 pattern from `054_memberships_and_rls_rewrite.sql`.

</code_context>

<specifics>
## Specific Ideas

- **Block-stack IA borrowed from REISift / DataSift** — chosen via plan-mode discussion as the centerpiece reference. See `2026-05-07-reisift-filter-ux.md` §1 for the canonical "Filter Blocks" pattern.
- **Quick Filters chip bar replaces existing 5 chips entirely** — locked decision. Every chip on the page becomes a saved preset under the hood. No hybrid.
- **5 base presets named explicitly:** Stacked · Vacant · Engaged · Cold · High Equity. Names exact (case-sensitive) for the seed; migration uses these literals.
- **Engagement = 4 buckets** (Never contacted · Attempted · Replied · Opted out) — Jarrad's explicit choice.
- **List Count slider is the must-have** — Batchleads' killer feature, free for Sandra via existing `property_stack_counts` view. Block name in the picker uses "List Count" not "Stack Count".

</specifics>

<deferred>
## Deferred Ideas

### To v1.1 (next phase after this one ships)
- **Last-Message Age block** — needs denormalized `last_inbound_at` / `last_outbound_at` columns on `properties` (trigger-maintained from `messages` insert) to avoid correlated subqueries at scale.
- **Tag Count block** — pairs with List Count; same pattern, low marginal value at v1.
- **Mortgage Balance, Equity $, LTV %, Estimated Wholesale Value** — derived metrics; pair with Equity % once Jarrad confirms which derivations he reaches for daily.
- **Filter by specific CSV import job** — needs a new column / junction; defer until the import history grows large enough to warrant it.
- **Sequence Enrollment block** + **Sequence Status** — natural follow-up; uses `sequence_enrollments` table.
- **Last Message Direction block** — refines Engagement; computable from existing data.
- **Tag Category filter** — system vs custom tag separation in the picker.
- **Skip-Trace Status detail** — pending / matched / no-match / expired (vs the simple has-skip / no-skip in v1).
- **Auto-refresh / Smart Lists / scheduled alerts** — REsimpli's Auto List Builder pattern. Cron + diff against `last_count` snapshot. Triggers a notification.
- **Drip-on-preset-membership-change trigger** — REsimpli pattern. When a property newly matches a saved filter, fire a sequence.
- **Last-Updated Field compound block** — REISift's diagnostic killer. Needs lightweight audit-log infra.
- **Phone Status compound block** — needs per-phone status persistence.

### To v2 (vendor-enrichment milestone)
- **Distress section in full** — Foreclosure (NOD / Lis Pendens / NTS / Auction / REO), Tax Delinquent, Lien (mechanic / IRS / state / HOA / judgment), Bankruptcy (Ch 7 / Ch 13), Divorce, Probate / Pre-Probate, Code Violations, Eviction.
- **Owner LLC/Trust** — entity type filter.
- **In-State vs Out-of-State Owner** — needs owner mailing-state vs property-state comparison.
- **Length of Ownership** — needs `last_sale_date` from vendor data.
- **Multi-Property Owner** — needs ownership graph (one owner → multiple properties).
- **Owner Age** — vendor demographic data.
- **Draw-on-map (polygon / radius)** — geo work.
- **AI motivation score filter** — once Sandra's responder data is rich enough.

### Out of scope (deferred indefinitely)
- **Folder-scoped preset ACL with per-user/per-role visibility** — overkill for current team size; revisit only if the team grows past ~5 members or compliance requires it.
- **Performance denormalization** — not needed at 1,462 prospects. Revisit at ~10k.

</deferred>

---

*Phase: 05-prospects-filter-drawer*
*Context gathered: 2026-05-07*
*Next step: /gsd-plan-phase 05 — decompose into executable PLAN.md files*
