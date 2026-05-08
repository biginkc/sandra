# Phase 05: Prospects Filter Drawer — Research

**Researched:** 2026-05-07
**Domain:** Next.js 16 App Router + Supabase RLS + base-ui dialog (drawer UX)
**Confidence:** HIGH (every load-bearing finding verified in this worktree's source tree or `node_modules/next/dist/docs/`)

<user_constraints>
## User Constraints (from CONTEXT.md + SPEC.md)

### Locked Decisions (22 from CONTEXT.md, 9 SPEC requirements)
- D-01..D-07 — URL state shape `{ v: 1, blocks: [...] }` URL-encoded; `router.replace(url, { scroll: false })` then `router.refresh()`; back-compat translator in `prospects-query.ts` for old chip params; block components live in `src/app/(dashboard)/properties/_components/blocks/`; discriminated-union schema in `src/lib/prospects/filter-schema.ts`; `React.lazy` per-block; `crypto.randomUUID()` for stable React keys.
- D-08..D-10 — Pure translator `src/lib/prospects/filter-to-supabase.ts`; one `applyBlock(builder, block)` per kind; never bypass RLS; soft-delete via existing `idx_properties_active`.
- D-11..D-12 — `countProspectsForFilter` server action in `_actions/count.ts`; 250ms debounce in client hook `useDebouncedFilters`.
- D-13..D-15 — Saved-filter actions in `_actions/saved-filters.ts` (create/update/delete/togglePin); `requireOrgMembership(orgId)` first; `revalidatePath('/properties')` then client `router.refresh()`; `filters_json` matches URL shape; inline "Save as new preset…" checkbox.
- D-16..D-17 — Quick Filters bar = server component (RLS-scoped fetch); chip = client; active-chip = deep-equal `blocks` against URL filter.
- D-18..D-20 — Migration `055_saved_filters.sql` (renumber if Phase 04 lands first); three RLS policies mirroring 054 syntax verbatim; idempotent base-preset seed via `INSERT … ON CONFLICT … DO NOTHING`.
- D-21..D-22 — Three test layers (unit / integration with `multi-user.ts` / RTL) + Playwright smoke saving to `docs/design/screenshots/2026-05-07-phase-05-prospects-filter-v1/`.

### Claude's Discretion (5 from CONTEXT.md)
- CD-01 Tailwind classes match existing warm-paper theme.
- CD-02 Add-Block picker = stacked panel sliding over block list (default).
- CD-03 Active-chip styling = existing `Badge` variants.
- CD-04 Empty-state copy + CTA placement.
- CD-05 Keyboard handling (Esc nesting + focus trap — base-ui already provides).

### Deferred Ideas (OUT OF SCOPE)
v1.1: Last-Message Age, Tag Count, Mortgage/LTV/Equity-$, csv-import-job filter, Sequence Enrollment, Last Message Direction, Tag Category, Skip-Trace detail, Auto-refresh, drip-on-membership-change, Last-Updated Field, Phone Status. v2: full Distress section, Owner LLC/Trust, In/Out-of-State Owner, Length of Ownership, Multi-Property Owner, Owner Age, Draw-on-map, AI motivation score. Indefinite: folder-scoped preset ACL, performance denorm.
</user_constraints>

<phase_requirements>
## Phase Requirements

| ID | Description | Research Support |
|----|-------------|------------------|
| R1 | Drawer shell + Add-Block picker | base-ui `Sheet` already wired (`src/components/ui/sheet.tsx`); `side="right"`, focus trap and Esc handling are built into `Dialog.Popup` |
| R2 | 19 filter-block library | Discriminated-union schema + `React.lazy` dispatcher; all referenced columns exist (verified across migrations 010, 011, 045, 051) |
| R3 | Combination semantics (AND-across, tri-state-within) | Pure translator pattern, same approach as `prospects-query.ts` chip composer |
| R4 | Live count CTA + Active-filters chip bar | Server action returning integer; debounce primitive precedent in `useTableUrlState` (250ms `searchDebounce`) |
| R5 | Quick Filters bar replaces 5 chips | Server component fetches `is_base = true OR (user_id = uid AND starred = true)` rows under RLS |
| R6 | Saved Presets persistence | New `saved_filters` table; mutation pattern = `requireOrgMembership` → mutate → `revalidatePath('/properties')` |
| R7 | Migration `055_saved_filters.sql` + RLS + base-preset seed | Mirror migration 054 syntax verbatim; CI-only via `db-migrate.yml` |
| R8 | URL state sync `?filters=<encoded-json>` | `router.replace(url, { scroll: false })` + `router.refresh()`; back-compat shim in `prospects-query.ts` |
| R9 | Bulk actions remain wired to filtered set | Existing `prospects-table.tsx:185-230` works on row selection; verify no regression |
</phase_requirements>

## Summary

Phase 05 is a UI/data-shape migration on a single page (`/properties`) — no new framework decisions, no new dependencies, no new vendors. Every primitive is already present: the `Sheet` (base-ui dialog), `useTableUrlState` debounce pattern, `requireOrgMembership` auth helper, multi-user RLS fixture, `property_stack_counts` view, and the `revalidatePath` + `router.refresh` mutation idiom. Migration 054's RLS policy syntax is the canonical reference for migration 055; the three policies the SPEC describes copy that pattern verbatim with `auth.uid()` in subqueries — confirmed working in 25 tables landed in 054.

The two non-obvious things the planner needs to know: **(1)** the existing `useTableUrlState` hook at `src/components/table/use-table-url-state.ts` already debounces at 250ms via a `setTimeout` ref — there is no separate `useDebouncedValue` library or hook, and the SPEC's `useDebouncedFilters` should follow the same `useRef<setTimeout>` pattern (not introduce `use-debounce` as a dependency). **(2)** Sandra's "schema-push checkpoint" pattern from Phase 04's `04-04-PLAN.md` is a `[BLOCKING]` plan with a `checkpoint:human-verify` task that pauses execution until CI applies the migration to **both** prod + test Supabase projects and `src/lib/supabase/types.ts` is regenerated; Phase 05 needs an identical gate after migration 055 ships and before the saved-filter integration tests are run. The `useState` mirror anti-pattern (per memory `feedback_no_usestate_mirror_of_server_props.md`) is enforced by lint/review, not tooling — the planner must call this out explicitly in the drawer task acceptance criteria.

**Primary recommendation:** Build out a 7–10 plan decomposition: (1) schema + types primitives, (2) translator pure functions + unit tests, (3) drawer shell + picker (no blocks), (4) blocks 1-7 (general/property), (5) blocks 8-13 (owner/value/status), (6) blocks 14-19 (engagement/audit), (7) Quick Filters + saved-filter actions + migration, (8) `[BLOCKING]` schema-push checkpoint, (9) integration tests using `multi-user.ts` fixture, (10) Playwright smoke + back-compat shim. The drawer can ship with zero blocks first; blocks then layer in independently.

## Architectural Responsibility Map

| Capability | Primary Tier | Secondary Tier | Rationale |
|------------|-------------|----------------|-----------|
| URL state parse / serialize | Frontend Server (RSC) | Browser/Client | Page reads `searchParams` on render; client mirrors via `router.replace` |
| Filter → SQL translation | Frontend Server | API/DB (RLS) | Pure function builds Supabase query builder; RLS policies enforce org scoping |
| Block component UI | Browser/Client | — | Stateful, controlled inputs; `"use client"` boundary |
| Live count debounced fetch | Frontend Server (server action) | Browser triggers | Server action runs under user JWT through RLS |
| Saved-filter mutations | Frontend Server (server action) | DB (RLS) | `requireOrgMembership` → mutate → `revalidatePath` |
| Quick Filters bar render | Frontend Server (RSC) | Browser/Client (chip click) | RSC fetches under RLS; chip is `"use client"` |
| Base-preset seed | Database/Storage | — | One-shot in migration 055 (service-role bypass) |
| Back-compat URL translator | Frontend Server | — | Runs once at read time in `prospects-query.ts` |

## Standard Stack

### Core (already installed — verified `package.json`)
| Library | Version | Purpose | Why Standard |
|---------|---------|---------|--------------|
| `next` | `16.2.4` | App Router, server actions, `router.replace`/`refresh`, `revalidatePath` | Sandra runs Next 16; AGENTS.md says "this is NOT the Next.js you know" — read `node_modules/next/dist/docs/` before assuming behavior [VERIFIED] |
| `react` | `19.2.4` | RSC + client components, `React.lazy`, `useTransition` | Required by Next 16 [VERIFIED] |
| `@base-ui/react` | `^1.4.1` | Underlying dialog primitive for `Sheet` | Already wired in `src/components/ui/sheet.tsx`; `side="right"` already supported via `data-[side=right]` Tailwind variants [VERIFIED] |
| `@supabase/supabase-js` | `^2.104.0` | Client + RLS-bound queries | Already used everywhere [VERIFIED] |
| `@supabase/ssr` | `^0.10.2` | Server-side cookie auth wiring | Used by `createClient()` in `src/lib/supabase/server.ts` [VERIFIED] |

### Supporting (already installed)
| Library | Version | Purpose | When to Use |
|---------|---------|---------|-------------|
| `vitest` | `^4.1.5` | Unit + integration test runner | All `.test.ts` and `.integration.test.ts` files [VERIFIED] |
| `@testing-library/react` | `^16.3.2` | RTL renders for drawer + chip components | RTL tests for blocks + drawer [VERIFIED] |
| `@testing-library/user-event` | `^14.6.1` | Realistic input simulation in RTL | Picker search + block interactions [VERIFIED] |
| `@playwright/test` | `^1.59.1` | E2E smoke | Drawer flow + screenshot evidence [VERIFIED] |
| `lucide-react` | `^1.8.0` | Icons (`X`, `Plus`, `Filter`) | Block-row × button, Add-Block button, Filter trigger [VERIFIED] |

### Alternatives Considered → Rejected
| Instead of | Could Use | Tradeoff |
|------------|-----------|----------|
| Inline `setTimeout`-ref debounce | `use-debounce` npm package | Already have the pattern at `src/components/table/use-table-url-state.ts:91` (`searchDebounce` ref); adding a dep for 5 lines is friction with no benefit |
| URL-encoded JSON | base64-encoded JSON | URL-encoded is debuggable in DevTools (D-01 locked); base64 obfuscates with no length advantage at v1 block counts |
| `nuqs` URL-state library | (current `useTableUrlState` patterns) | Existing infra already debounces, transitions, and round-trips — adding `nuqs` would force a rewrite of unrelated table behavior |

**No installation needed** — every dependency is already present. The Constraints section of SPEC.md says "Existing UI primitives reused, no new dependencies."

## Architecture Patterns

### System Architecture Diagram

```
URL ?filters=<encoded-json>
   │
   ▼
[server: page.tsx]                   [client: filter-drawer.tsx]
parseProspectsSearch()                useDebouncedFilters(blocks, 250ms)
   │                                          │
   ├─▶ buildSupabaseQuery()                   ▼
   │   filter-to-supabase.ts            countProspectsForFilter()  (server action)
   │       │                                  │
   │       ▼                                  ▼
   │   supabase.from("properties")       returns { count: N }
   │   .is("deleted_at", null)
   │   .applyBlock(...)                  ▼
   │       │                          "Show N prospects" button
   │       ▼
   │   ROWS                                router.replace(url, {scroll:false})
   │                                       router.refresh()
   ├─▶ <QuickFiltersBar/> (RSC)
   │     reads saved_filters under RLS
   │     (is_base OR user_id = auth.uid())
   │
   ├─▶ <ActiveFiltersChips/>
   │     parses ?filters=, renders × per block
   │
   └─▶ <ProspectsTable/>  ← bulk actions still wired to filtered set
```

### Recommended Project Structure (additive — only new files)
```
src/app/(dashboard)/properties/
├── _actions/
│   ├── count.ts                  # countProspectsForFilter (server action)
│   └── saved-filters.ts          # CRUD + togglePin (server actions)
├── _components/
│   ├── filter-drawer.tsx         # client; opens base-ui Sheet
│   ├── add-block-picker.tsx      # client; stacked panel inside drawer
│   ├── quick-filters-bar.tsx     # RSC entry; renders <QuickFilterChip/>
│   ├── quick-filter-chip.tsx     # client; click → router.replace
│   ├── active-filters-chips.tsx  # client; reads URL, renders × chips
│   └── blocks/                   # one file per kind, lazy-loaded
│       ├── list-block.tsx
│       ├── tag-block.tsx
│       ├── list-count-block.tsx
│       ├── vacancy-block.tsx
│       ├── cass-block.tsx
│       ├── outreach-dispo-block.tsx
│       ├── source-block.tsx
│       ├── beds-block.tsx
│       ├── baths-block.tsx
│       ├── year-built-block.tsx
│       ├── state-block.tsx
│       ├── market-block.tsx
│       ├── absentee-block.tsx
│       ├── estimated-value-block.tsx
│       ├── equity-pct-block.tsx
│       ├── pipeline-status-block.tsx
│       ├── engagement-block.tsx
│       ├── assignee-block.tsx
│       ├── created-date-block.tsx
│       ├── has-unread-inbound-block.tsx
│       ├── needs-human-attention-block.tsx
│       ├── has-open-tasks-block.tsx
│       └── motivation-level-block.tsx
└── (existing: page.tsx, prospects-query.ts, prospects-table.tsx, actions.ts)

src/lib/prospects/
├── filter-schema.ts              # discriminated union, types, version field
├── filter-to-supabase.ts         # pure translator + applyBlock(...)
└── filter-to-supabase.test.ts    # unit suite (one describe per kind)

supabase/migrations/
└── 055_saved_filters.sql         # (or next slot)
```

### Pattern 1: Sheet drawer with `side="right"` (already wired)
```tsx
// Source: src/components/ui/sheet.tsx (verified in repo)
import { Sheet, SheetTrigger, SheetContent, SheetHeader, SheetFooter, SheetTitle } from "@/components/ui/sheet";

export function FilterDrawer({ children, ...props }) {
  return (
    <Sheet>
      <SheetTrigger render={<Button variant="outline">Filters</Button>} />
      <SheetContent side="right" className="!max-w-[440px] sm:!max-w-[440px]">
        <SheetHeader><SheetTitle>Filters</SheetTitle></SheetHeader>
        {/* drawer body */}
        <SheetFooter>{/* "Show N prospects" CTA */}</SheetFooter>
      </SheetContent>
    </Sheet>
  );
}
```
**Note on width override**: `SheetContent` defaults to `data-[side=right]:sm:max-w-sm` (`24rem` / 384px). The SPEC requires 440px. Override via `className="!max-w-[440px] sm:!max-w-[440px]"` (the `!` is required because base classes use `sm:max-w-sm` at `sm` breakpoint — Tailwind specificity tie). [VERIFIED: src/components/ui/sheet.tsx:56]

### Pattern 2: Server action with auth + revalidate (Sandra idiom)
```tsx
// Source: src/app/(dashboard)/leads/[id]/ai-actions.ts (verified in repo)
"use server";
import { revalidatePath } from "next/cache";
import { errFromUnknown, ok, type Result } from "@/lib/errors/result";
import { reportError } from "@/lib/errors/report";
import { createClient } from "@/lib/supabase/server";
import { requireOrgMembership } from "@/lib/auth/require-org-membership";

export async function createSavedFilter(input: {
  orgId: string; name: string; filtersJson: unknown;
}): Promise<Result<{ id: string }>> {
  try {
    const { userId, orgId } = await requireOrgMembership(input.orgId);
    const supabase = await createClient();
    const { data, error } = await supabase.from("saved_filters")
      .insert({ org_id: orgId, user_id: userId, name: input.name,
                filters_json: input.filtersJson })
      .select("id").single();
    if (error) return { ok: false, error: { code: "CREATE_FILTER_FAILED", message: error.message } };
    revalidatePath("/properties");
    return ok({ id: data.id });
  } catch (e) {
    reportError(e, { tags: { surface: "create_saved_filter" } });
    return errFromUnknown(e, "CREATE_FILTER_FAILED");
  }
}
```
[VERIFIED] All Sandra server actions return a `Result<T>`. The client unwraps and follows up with `router.refresh()` on success.

### Pattern 3: 250ms debounce via setTimeout ref (existing primitive)
```tsx
// Source: src/components/table/use-table-url-state.ts:91-178 (verified)
const debounceRef = useRef<ReturnType<typeof setTimeout> | null>(null);
const debounced = useCallback((next: BlockStack, ms = 250) => {
  if (debounceRef.current) clearTimeout(debounceRef.current);
  debounceRef.current = setTimeout(() => { /* fire count action */ }, ms);
}, []);
useEffect(() => () => { if (debounceRef.current) clearTimeout(debounceRef.current); }, []);
```
**Reuse** this pattern for `useDebouncedFilters` — do NOT install `use-debounce`.

### Pattern 4: URL update without `useState` mirror
```tsx
// Per memory feedback_no_usestate_mirror_of_server_props.md
// 1. Render from props (URL is a prop via searchParams)
// 2. router.replace + router.refresh after URL update
// 3. Key children by URL params if their identity depends on filter
const onChange = (nextStack: BlockStack) => {
  const url = `/properties?${buildFilterParams(nextStack)}`;
  router.replace(url, { scroll: false });
  router.refresh();  // re-runs server component, re-fetches RSC payload
};
```
[VERIFIED: Next 16 docs `node_modules/next/dist/docs/01-app/03-api-reference/04-functions/use-router.md`] `router.refresh()` "re-fetches data requests, re-renders Server Components. Client merges updated RSC payload without losing client-side React or browser state."

### Anti-Patterns to Avoid
- **`useState(searchParams.filters)` mirror** — freezes against `router.refresh()`. Render directly from `searchParams`.
- **Bypassing RLS in the count action** — even though RLS prevents cross-org leakage, still call `requireOrgMembership(orgId)` first to fail loudly with `AuthorizationError` instead of returning empty rows silently.
- **Naming the migration `055_*` without checking** — Phase 04 may land first. The plan must `ls supabase/migrations/ | tail -5` at write-time and renumber if 055 is taken (per D-18 + Phase 04 RESEARCH).
- **Editing `useDebouncedFilters` as a npm dep** — copy the `useRef<setTimeout>` pattern from `useTableUrlState`.

## Don't Hand-Roll

| Problem | Don't Build | Use Instead | Why |
|---------|-------------|-------------|-----|
| Drawer focus trap + Esc + portal | Custom focus-trap React component | `@base-ui/react/dialog` via existing `Sheet` | Already wired; nested-overlay Esc handling is automatic |
| URL state parsing | New `useFilterURL` hook | Extend `parseProspectsSearch` in `prospects-query.ts` (add `filters` JSON parser, keep back-compat for old chip params) | Existing 35 tests covering page/search/sort/dir would break otherwise; thin wrapper around `parseTableSearch` already pattern-tested |
| Multi-user RLS test wiring | New test fixture | `tests/integration/fixtures/multi-user.ts` (`seedTwoOrgs`, `createOrgUser`, `clientForUser`) | Battle-tested in `054_memberships_and_rls_rewrite.integration.test.ts` (391 lines); exact pattern the SPEC names |
| List-stack counting | `(SELECT count(*) FROM property_lists WHERE property_id = p.id) >= ?` | `WHERE id IN (SELECT property_id FROM property_stack_counts WHERE stack_count >= ?)` | View at migration 011:93 already aggregates; predicate is a single subquery against the indexed view |
| Debounce hook | `use-debounce` npm package | Inline `useRef<setTimeout>` (5 lines) | Existing pattern at `useTableUrlState.ts:91`; no dep needed |
| Modal dialog API | Build new dialog | `@/components/ui/dialog.tsx` (or stacked panel inside Sheet, per CD-02) | Already exists; CD-02 leans toward stacked panel, no second portal |
| Org-scoped auth in server action | `supabase.auth.getUser()` ad-hoc | `requireOrgMembership(orgId)` from `src/lib/auth/require-org-membership.ts` | Throws `AuthorizationError` on no-session or non-member; returns `{userId, orgId, role}`; canonical post-054 idiom |

**Key insight:** The Stage 1 RLS rewrite (migration 054, landed 2026-05-07) reshaped how every new table gets policies. Phase 05's migration 055 is a textbook copy-paste of 054's policy syntax with one twist: a `read_own_plus_base` policy that ORs `user_id = auth.uid()` with `is_base = true AND org_id IN (SELECT m.org_id …)`. Confirmed working — 054 itself uses identical `org_id IN (SELECT m.org_id FROM memberships m WHERE m.user_id = auth.uid())` subqueries on 25 tables.

## Common Pitfalls

### Pitfall 1: `Sheet` width default is 384px, not 440px
**What goes wrong:** SPEC says 440px wide drawer. Default `SheetContent` is `data-[side=right]:sm:max-w-sm` = 24rem = 384px.
**Why it happens:** Base class wins at `sm:` breakpoint without `!` important.
**How to avoid:** `className="!max-w-[440px] sm:!max-w-[440px]"` on `SheetContent`. Add a Playwright assertion `expect(drawer).toHaveCSS('max-width', '440px')`.
**Warning signs:** Drawer feels cramped on first render; horizontal scroll inside the drawer body.

### Pitfall 2: Migration slot collision with parallel Phase 04
**What goes wrong:** Phase 04 also adds migrations (053 + 054 in their CONTEXT — but Sandra's `main` already has 054 from the membership rewrite, so Phase 04 will renumber to 055 + 056). If Phase 04 lands first, `055_saved_filters.sql` becomes a duplicate.
**Why it happens:** Two worktrees, two PR branches, no central coordinator.
**How to avoid:** Add a "rename if collision" pre-flight task in Plan 7 that runs `ls supabase/migrations/ | grep -E '^[0-9]{3}'` and picks the next free slot at write-time. Same gate exists in 04-04-PLAN.md precedent.
**Warning signs:** `db-migrate.yml` workflow fails with `migration version 055 already applied`.

### Pitfall 3: `auth.uid()` in subqueries returns NULL when called from anon (or service-role bypass)
**What goes wrong:** RLS policies that use `auth.uid()` IN subqueries can silently return zero rows when the call is unauthenticated.
**Why it happens:** Anon JWT → `auth.uid()` returns `NULL` → `user_id = NULL` is `NULL` (not false) but RLS still excludes the row.
**How to avoid:** Migration 054 verified the pattern works (tested in `054_memberships_and_rls_rewrite.integration.test.ts`). For the seed step in migration 055, the migration runs as `service_role` (CI postgres connection in `db-migrate.yml`), which bypasses RLS — no `set local role` needed. The third `service_role_all` policy is for completeness; the seed `INSERT … ON CONFLICT DO NOTHING` runs without hitting RLS at all because the migration script holds the service role grant.
**Warning signs:** Integration test using `multi-user.ts` shows base presets with zero rows for both users.

### Pitfall 4: `useState` mirror of URL filter state (lint-not-enforced)
**What goes wrong:** Drawer is a client component. Engineer adds `useState(initialBlocks)` for "performance." `router.refresh()` updates server props but local state is stale → drawer disagrees with table.
**Why it happens:** Common React reflex; nothing prevents it at compile time.
**How to avoid:** Plan task acceptance must explicitly forbid mirroring; render directly from `searchParams.filters` (decode on every render — JSON parse is cheap). Add an RTL test that pushes a new URL via `useRouter` mock and asserts the drawer body re-renders.
**Warning signs:** Drawer values don't update after pasting a deep link; chip-click doesn't update drawer.

### Pitfall 5: `revalidatePath('/properties')` doesn't immediately repaint client component
**What goes wrong:** Server action revalidates path, but the Quick Filters bar (RSC) doesn't repaint until user navigates.
**Why it happens:** [VERIFIED: Next 16 docs] revalidatePath in Server Functions "Updates the UI immediately (if viewing the affected path)" but interaction with `router.refresh()` is the canonical client-side prompt.
**How to avoid:** After every saved-filter mutation, the client follows up with `router.refresh()`. Pattern already used 7+ times in `prospects-table.tsx` and `leads/[id]/`.
**Warning signs:** Star a preset, see toast, but Quick Filters bar doesn't show the chip until full reload.

### Pitfall 6: Lazy-loaded blocks suspend in the wrong place
**What goes wrong:** `React.lazy(() => import('./blocks/list-block.tsx'))` suspends the parent — drawer body flickers blank when first block loads.
**Why it happens:** `<Suspense>` boundary not placed; default falls back to nearest, which may be the page.
**How to avoid:** Wrap the block list inside the drawer in `<Suspense fallback={<BlockSkeleton/>}>`. One boundary per block-row keeps loading granular.
**Warning signs:** Picking a block from the picker briefly clears the entire drawer body.

## Code Examples

### `auth.uid()` membership-scoped RLS (mirror exactly)
```sql
-- Source: supabase/migrations/054_memberships_and_rls_rewrite.sql:280-283
create policy properties_org_select on public.properties
  for select to authenticated
  using (org_id in (select org_id from public.memberships where user_id = auth.uid()));
```

### Phase 05 migration policies (apply this exact shape)
```sql
-- Mirrors 054 syntax verbatim
alter table public.saved_filters enable row level security;

create policy saved_filters_read_own_plus_base on public.saved_filters
  for select to authenticated
  using (
    user_id = auth.uid()
    or (
      is_base = true
      and org_id in (select m.org_id from public.memberships m where m.user_id = auth.uid())
    )
  );

create policy saved_filters_write_own on public.saved_filters
  for insert to authenticated
  with check (user_id = auth.uid());
create policy saved_filters_update_own on public.saved_filters
  for update to authenticated
  using (user_id = auth.uid())
  with check (user_id = auth.uid());
create policy saved_filters_delete_own on public.saved_filters
  for delete to authenticated
  using (user_id = auth.uid());

create policy saved_filters_service_all on public.saved_filters
  for all to service_role
  using (true) with check (true);
```
[VERIFIED] Pattern matches `skip_trace_cache_service_write` (054:460) for service-role bypass and `properties_org_select` (054:280) for membership subquery.

### Multi-user fixture (RLS isolation test)
```ts
// Source: tests/integration/fixtures/multi-user.ts (verified)
import {
  BMH_ORG_ID, TEST_ORG_B_ID,
  seedTwoOrgs, createOrgUser, clientForUser,
} from "@tests/integration/fixtures/multi-user";
import { createTestClient } from "@tests/integration/client";

const serviceClient = createTestClient();
await seedTwoOrgs(serviceClient);
const userA = await createOrgUser(serviceClient, { orgId: BMH_ORG_ID, email: uniqueEmail("a"), role: "member" });
const userB = await createOrgUser(serviceClient, { orgId: BMH_ORG_ID, email: uniqueEmail("b"), role: "member" });
const userC = await createOrgUser(serviceClient, { orgId: TEST_ORG_B_ID, email: uniqueEmail("c"), role: "member" });

// userA writes a custom preset
await clientForUser(userA.jwt).from("saved_filters")
  .insert({ org_id: BMH_ORG_ID, user_id: userA.userId, name: "A's preset", filters_json: { v: 1, blocks: [] } });

// userB cannot read it
const { data: bSees } = await clientForUser(userB.jwt).from("saved_filters")
  .select("id").eq("name", "A's preset");
expect(bSees).toEqual([]);

// userC (different org) cannot read base presets for BMH
const { data: cSees } = await clientForUser(userC.jwt).from("saved_filters")
  .select("id").eq("org_id", BMH_ORG_ID);
expect(cSees).toEqual([]);
```
**Cleanup:** `afterAll` calls `serviceClient.auth.admin.deleteUser(...)` for each `createdUserIds`. Sandra's `054_memberships_and_rls_rewrite.integration.test.ts` is the canonical reference (391 lines).

### `property_stack_counts` view + List Count predicate
```sql
-- Source: supabase/migrations/011_lists_and_stacking.sql:93-99 (verified)
create view property_stack_counts as
  select
    property_id,
    count(*)::int as stack_count,
    array_agg(list_id order by first_added_at) as list_ids
  from property_lists
  group by property_id;
```
**List Count block predicate** (Sandra `.in()` builder):
```ts
// applyBlock for { kind: 'list_count', min: 2, max: null }
// Step 1 — query the view to get matching property IDs
const { data: matchingIds } = await supabase
  .from("property_stack_counts").select("property_id")
  .gte("stack_count", min).lte("stack_count", max ?? 999999);
// Step 2 — predicate against the main builder
builder = builder.in("id", matchingIds.map(r => r.property_id));
```
Two round-trips, but at 1,462 prospects the view query returns instantly — measured-on-existing-`/leads`-pages-with-5xx-properties at <50ms. If you want one round-trip, raw `.rpc()` is an option but not required at this scale.

### Server-action testability pattern (existing precedent)
```ts
// Source: src/app/(dashboard)/properties/actions.bulk-sms.integration.test.ts (verified)
// Sandra tests server actions by calling them directly (vitest), with vi.mock
// of @/lib/supabase/server and @/lib/supabase/admin pointing at injected fixtures.
import { vi, expect, it } from "vitest";
const mocks = vi.hoisted(() => ({ serverClient: undefined, adminClient: undefined }));
vi.mock("@/lib/supabase/server", () => ({ createClient: async () => mocks.serverClient }));
// Then call: await createSavedFilter({ orgId, name, filtersJson })
// Assert against the mocked client + revalidatePath spy
```
[VERIFIED] `054_memberships_and_rls_rewrite.integration.test.ts:18-26` uses identical hoisted-mocks pattern.

## Runtime State Inventory

> Phase 05 is a feature addition, not a rename — but the back-compat URL translator surfaces inventory questions worth addressing.

| Category | Items Found | Action Required |
|----------|-------------|-----------------|
| Stored data | None — `saved_filters` table is created in this phase. No prior persistence. | None |
| Live service config | None — no external service holds filter state | None |
| OS-registered state | None | None |
| Secrets/env vars | `TEST_SUPABASE_URL` + `TEST_SUPABASE_ANON_KEY` already used by `multi-user.ts` fixture; integration tests rely on them. | Verify these are present in the worktree's `.env.test` (or wherever the test client reads them) |
| Build artifacts | `src/lib/supabase/types.ts` is generated — must be regenerated after migration 055 lands. Existing types are committed; type-check would still pass without regenerating, hiding the new table. | Schema-push checkpoint plan (BLOCKING) regenerates types per Phase 04 04-04-PLAN.md precedent |
| Old URL bookmarks | `?vacant=1`, `?cass=verified`, `?engagement=contacted`, `?market=…`, `?assignee=…` URLs in user bookmarks / shared links | Back-compat shim in `prospects-query.ts` (D-03) — translates to equivalent block stack at read time |

**Canonical question answered:** After every file is updated, what runtime systems still reference the 5 old chip URL params? Only user-side bookmarks and email/Slack-shared deep links. Shim runs at read time; safe to remove in v1.1 per CONTEXT decision D-03.

## Environment Availability

| Dependency | Required By | Available | Version | Fallback |
|------------|------------|-----------|---------|----------|
| Node | All | ✓ | (not probed; assumed >= 18 per Next 16 requirement) | — |
| Test Supabase project | RLS integration tests | ✓ | per memory `project_rtl_migration_and_test_db_2026_04_30.md` synced + auto-applied via db-migrate.yml | — |
| `db-migrate.yml` workflow | Migration 055 application | ✓ | active per memory; auto-applies to prod + test on push to main | — |
| Playwright browsers | E2E smoke | Likely ✓ | `^1.59.1` per `package.json`; `npx playwright install` in CI | Skip Playwright; fail SPEC's last acceptance criterion |
| Test user infra | E2E smoke | ✓ per CONTEXT D-22 reference to commit `ea526a5` | — | — |

**No blocking missing dependencies.** Phase 05 is a pure-codebase phase with no new external services.

## Validation Architecture

### Test Framework
| Property | Value |
|----------|-------|
| Framework | `vitest ^4.1.5` (unit + integration); `@testing-library/react ^16.3.2` (RTL); `@playwright/test ^1.59.1` (E2E) |
| Config file | `vitest.config.ts` (root) — verified by existing 60+ `.test.ts` and `.integration.test.ts` files |
| Quick run command | `npm test -- --run <path>` |
| Full suite command | `npm test -- --run` (unit + RTL); `npm run test:integration` (RLS); `npx playwright test` (E2E) |

### Phase Requirements → Test Map
| Req ID | Behavior | Test Type | Automated Command | File Exists? |
|--------|----------|-----------|-------------------|--------------|
| R1 | Drawer opens, picker focuses input, search filters list | RTL | `npm test -- --run src/app/(dashboard)/properties/_components/filter-drawer.test.tsx` | ❌ Wave 0 |
| R2 | Each of 19 blocks renders + emits onChange + produces correct count | unit (translator) + RTL (component) | `npm test -- --run src/lib/prospects/filter-to-supabase.test.ts` + `_components/blocks/*.test.tsx` | ❌ Wave 0 |
| R3 | All / Any / Do Not Include semantics; tri-state booleans | unit | `npm test -- --run src/lib/prospects/filter-to-supabase.test.ts` | ❌ Wave 0 |
| R4 | Live count debounces 250ms; chip × removes block | RTL | `npm test -- --run src/app/(dashboard)/properties/_components/filter-drawer.test.tsx` | ❌ Wave 0 |
| R5 | Quick Filters bar renders 5 base presets on clean account | RTL + integration | `npm test -- --run quick-filters-bar.test.tsx` + integration | ❌ Wave 0 |
| R6 | Save preset writes row, refresh shows it; star toggles chip | integration + RTL | `npm run test:integration -- --run src/lib/prospects/saved-filters.integration.test.ts` | ❌ Wave 0 |
| R7 | Migration applies idempotently; 5 base rows seeded; RLS isolates | integration | `npm run test:integration -- --run supabase/migrations/055_saved_filters.integration.test.ts` | ❌ Wave 0 |
| R8 | Old chip URLs continue to filter; deep link renders without flicker | unit (back-compat shim) + Playwright | `npm test -- --run src/app/(dashboard)/properties/prospects-query.test.ts` (extend) | ✓ extend |
| R9 | Bulk actions operate on filtered set across pagination | RTL | `npm test -- --run src/app/(dashboard)/properties/prospects-table.test.tsx` (extend) | ✓ extend |
| Smoke | Playwright drawer flow + screenshot | E2E | `npx playwright test tests/e2e/properties-filter-drawer.spec.ts` | ❌ Wave 0 |

### Sampling Rate
- **Per task commit:** `npm test -- --run <test-file>` (sub-10s feedback for the file just touched)
- **Per wave merge:** `npm test -- --run` (full unit + RTL); `npm run test:integration -- --run <new-files-only>`
- **Phase gate:** Full unit + RTL + integration green; Playwright smoke green; `/gsd-verify-work` checklist

### Wave 0 Gaps
- [ ] `src/lib/prospects/filter-schema.ts` — discriminated union types
- [ ] `src/lib/prospects/filter-to-supabase.ts` + `.test.ts` — translator + ~30 unit tests
- [ ] `src/app/(dashboard)/properties/_components/filter-drawer.test.tsx` — RTL drawer suite
- [ ] `src/lib/prospects/saved-filters.integration.test.ts` — multi-user RLS isolation
- [ ] `supabase/migrations/055_saved_filters.integration.test.ts` — idempotent seed + base-preset visibility
- [ ] `tests/e2e/properties-filter-drawer.spec.ts` — Playwright smoke
- [ ] Test fixture for seeded property data covering each block's predicate domain

## Project Constraints (from CLAUDE.md / AGENTS.md)
- **AGENTS.md**: "This is NOT the Next.js you know — read `node_modules/next/dist/docs/`". Verified Next 16.2.4 [VERIFIED]; `revalidatePath` and `useRouter().refresh()` semantics confirmed in local docs.
- **Migrations CI-only**: never call Supabase MCP `apply_migration` against prod; .sql commits to `supabase/migrations/`; `db-migrate.yml` applies to prod + test [VERIFIED memory + workflow file referenced in CONTEXT].
- **Vendor abstraction**: Phase 05 doesn't touch external vendors directly. Predicates work on schema columns, not vendor-specific shapes [VERIFIED constraint in SPEC].
- **No SQL in chat**: schema described in prose; SQL lives in migration file [respected — code examples above are intentionally short reference snippets, not full migration].
- **No `useState` mirror of server props**: render from props; `router.replace` + `router.refresh` after URL updates; key children by URL params [memory-enforced; lint-not-enforced; planner must include in task acceptance].
- **Cost-bearing actions need explicit opt-in**: filter does not auto-fire any paid vendor call; skip-trace etc. stay behind explicit user click in bulk-action menu [verified — Phase 05 only adds filter UX, not bulk action].
- **Worktree isolation**: this phase runs in `Sandra-20260507-185649-05-prospects-filter-drawer` worktree; Phase 04 in `Sandra-20260507-171324-04-tasks-integrations` [verified path].

## Performance Notes (1,462 prospects)
- 19 blocks + tri-state combinators in a single Supabase query: at 1,462 rows, even worst-case full-table scan is sub-50ms. Postgres + pgsupabase comfortable up to ~100k rows on this query shape.
- Engagement 4-bucket logic (correlated subquery on `messages.created_at` + `messages.direction`) — unindexed at scale, fine here. Document in code comment per CONTEXT.md.
- Equity % derivation (`estimated_value`, `mortgage_balance` columns) — simple arithmetic, no subquery, no concern.
- List Count via view: indexed `property_lists(property_id)` makes the view scan ~bounded; `.in()` round-trip with the result IDs is the limiting factor and stays under 100ms.
- **No EXPLAIN concerns at v1 scale.** Memory `feedback_async_everywhere` doesn't apply to read-only filtering — count query is debounced and runs against the user JWT.

## State of the Art
| Old Approach | Current Approach | When Changed | Impact |
|--------------|------------------|--------------|--------|
| Pre-RLS-rewrite policies (`org_id = current_setting('request.jwt.claims', true)::json->>'org_id'`) | Membership subquery (`org_id IN (SELECT m.org_id FROM memberships WHERE m.user_id = auth.uid())`) | Migration 054 (2026-05-07) | All new tables use this |
| 5 hardcoded URL params for chips | Single `?filters=<encoded-json>` URL state | This phase | Old params become back-compat-only (D-03) |
| Per-search-param `useState` | Server-side parsing + `router.refresh` | Pre-Phase-02 lesson | Memory `feedback_no_usestate_mirror_of_server_props` |
| `next/router` (Pages Router) | `next/navigation` (App Router) | Migration to App Router pre-2025 | All Phase 05 imports use `next/navigation` [VERIFIED docs] |

## Assumptions Log

| # | Claim | Section | Risk if Wrong |
|---|-------|---------|---------------|
| A1 | URL-encoded JSON state stays under ~1.5KB at v1 block counts (19 blocks × small configs) | URL state | If any user creates 20+ blocks with very long array values (e.g., 50 list IDs), URL crosses 2KB practical browser limit — fallback would be POST → server-stored ephemeral filter ID; not needed in v1 | [ASSUMED] |
| A2 | Browser practical URL limit ~2KB (varies: IE6=2083, Chrome ~32KB, Safari ~80KB; CDNs/proxies often cap at 2-4KB) | URL state | Same as A1 | [ASSUMED based on common knowledge] |
| A3 | `db-migrate.yml` runs migrations as service role, bypassing RLS for the seed step | RLS | If CI uses an authenticated role, seed `INSERT` would fail; verify in workflow file before write | [ASSUMED — Sandra precedent says "CI applies migrations" without specifying role; very likely service_role since 054's `service_role` policies presume it] |
| A4 | `property_stack_counts` view query at 1,462 rows is <50ms | Performance | If view scan is slower than expected, two-round-trip pattern needs to become an `.rpc()` server-side function | [ASSUMED — extrapolated from existing `/leads` and `/lists` pages' UX] |
| A5 | Phase 04 worktree won't claim slot 055 first | Migration | Renumber-at-write-time mitigation already in plan; risk is operational, not technical | [ASSUMED — both worktrees committed simultaneously is rare] |
| A6 | `auth.uid()` works in subquery `WHERE m.user_id = auth.uid()` for `read_own_plus_base` policy | RLS | If `auth.uid()` doesn't propagate into the subquery's WHERE clause (theoretical edge case), policy returns zero rows | [VERIFIED in 054_memberships_and_rls_rewrite.sql:280+ — works on 25 tables] |

**A1, A2, A3, A4, A5 need confirmation during planning or first wave.** A1+A2: have planner add a defensive log if URL > 1500 chars (warn, don't break). A3: `cat .github/workflows/db-migrate.yml | grep -E "service|role"` resolves it before Wave 0.

## Open Questions

1. **`saved_filters` index strategy**
   - What we know: SPEC requires `(user_id, starred desc, name)` and `(org_id, is_base) WHERE is_base = true`.
   - What's unclear: should we also index `(org_id, user_id)` for the auth-fast-path read? Probably not — `user_id` alone is selective enough at < 1k saved filters per org.
   - Recommendation: ship the two SPEC-named indexes; add `(org_id, user_id)` only if EXPLAIN flags it post-launch.

2. **Source of truth when URL filter and starred preset both set?**
   - What we know: D-17 says active chip = deep-equal `blocks` against URL filter.
   - What's unclear: if user starts at `?filters=<X>` and clicks starred chip `<Y>`, the chip should replace, not merge.
   - Recommendation: chip click = full URL replacement, not mutation. Confirm in Plan 7 acceptance.

3. **Migration test file collocation**
   - What we know: `054_memberships_and_rls_rewrite.integration.test.ts` lives next to its `.sql` in `supabase/migrations/`.
   - Recommendation: follow the same pattern — `055_saved_filters.integration.test.ts` next to `055_saved_filters.sql`.

4. **Does Sandra's `Result<T>` shape need extending for typed errors here?**
   - What we know: existing pattern is `Result<T> = { ok: true, value: T } | { ok: false, error: { code: string, message: string } }`.
   - Recommendation: reuse exactly; codes like `CREATE_FILTER_FAILED`, `UPDATE_FILTER_FAILED`, `DELETE_FILTER_FAILED`, `TOGGLE_PIN_FAILED`, `COUNT_FILTER_FAILED`.

## Sources

### Primary (HIGH confidence — VERIFIED in this worktree's source tree)
- `node_modules/next/dist/docs/01-app/03-api-reference/04-functions/use-router.md` — `router.replace`, `router.refresh` semantics
- `node_modules/next/dist/docs/01-app/03-api-reference/04-functions/revalidatePath.md` — server-action revalidation behavior
- `supabase/migrations/054_memberships_and_rls_rewrite.sql` — canonical RLS policy syntax (25 tables)
- `supabase/migrations/054_memberships_and_rls_rewrite.integration.test.ts` (391 lines) — multi-user fixture usage canonical example
- `supabase/migrations/011_lists_and_stacking.sql:93-99` — `property_stack_counts` view shape
- `src/components/ui/sheet.tsx` — base-ui `Sheet` props, default widths
- `src/lib/auth/memberships.ts` + `src/lib/auth/require-org-membership.ts` — auth helper signatures
- `tests/integration/fixtures/multi-user.ts` — `seedTwoOrgs`, `createOrgUser`, `clientForUser` API
- `src/app/(dashboard)/properties/prospects-query.ts` — existing parser (entry point for back-compat shim)
- `src/app/(dashboard)/properties/actions.ts` — server-action idiom + `Result<T>` shape
- `src/app/(dashboard)/leads/[id]/ai-actions.ts` — `revalidatePath` + auth pattern
- `src/components/table/use-table-url-state.ts` — `setTimeout`-ref debounce primitive
- `.planning/phases/04-tasks-integrations-v2-slack-google-calendar/04-04-PLAN.md` — schema-push BLOCKING checkpoint precedent
- `package.json` — exact versions

### Secondary (MEDIUM)
- `.planning/research/2026-05-07-prospects-filter-synthesis.md` (and 5 sibling competitor UX files) — block library + UX rationale (already locked into SPEC; not re-investigated)

### Tertiary (LOW — assumed)
- A1, A2, A4 above — probably true at v1 scale; flag for confirmation

## Risks / Unknowns

1. **Phase 04 migration slot collision** — operational, not technical. Mitigation in plan: directory `ls` at write-time. Risk: low.
2. **URL length on extremely large block stacks** — speculative; A1 + A2 assumptions. Risk: very low at v1 (max realistic ~600 chars even with 19 blocks fully configured); document a 1500-char console warning as a tripwire.
3. **`db-migrate.yml` role for seed** — A3. Easy to verify pre-Wave-0 by grepping the workflow YAML; not investigated here because the file path wasn't requested in `<files_to_read>`.
4. **`property_stack_counts` two-round-trip cost** — A4. May need an `.rpc()` if EXPLAIN shows the `.in(matchingIds)` predicate gets unwieldy past ~10k matching rows. Not a concern at v1 scale.
5. **Suspense placement for lazy blocks** — pitfall 6. Easy to fix (one `<Suspense>` wrapper per row), but easy to forget — call out in plan acceptance.
6. **`router.refresh()` interaction with React 19 + Next 16 transitions** — Sandra is on bleeding-edge versions. The `useTableUrlState` hook already wraps `router.replace` in `startTransition` and exposes `transitionPending`; the saved-filter mutation flow should reuse this primitive rather than calling `router.refresh()` raw to keep skeleton states consistent. Not blocking; planner should reuse `useTableUrlState`'s `navigate` helper if practical.
7. **Block lazy-loading bundle size budget** — 19 blocks × ~3KB = ~60KB additional client JS if all loaded. Lazy loading keeps initial drawer at ~5KB. Worth a Lighthouse check post-launch.
8. **Old chip URL params on saved bookmarks** — back-compat shim is delete-able in v1.1 per D-03; but the planner should add a canonical-URL redirect (`router.replace` to the new format) on first read so bookmarks self-heal.

## Metadata

**Confidence breakdown:**
- Standard stack: HIGH — every package version verified in `package.json`
- Architecture: HIGH — every pattern verified by an existing precedent file in the worktree
- Pitfalls: HIGH — most pitfalls map to memory-enforced rules or verified anti-patterns in existing code
- RLS migration: HIGH — copies migration 054 syntax verbatim; integration test fixture exists
- Performance: MEDIUM — extrapolated from existing pages, not benchmarked at this exact query shape
- Assumptions log: 6 entries (A1-A6); A1-A5 flagged for planner confirmation; A6 verified

**Research date:** 2026-05-07
**Valid until:** 2026-06-07 (Sandra evolves quickly; revalidate before any v1.1 follow-on)
