# Handoff — 2026-05-01 — Phase 1 Shipped, Phase 1.5 Planning Ready

## 1. Current state

- **Branch:** `main` (Phase 1 merged; working tree clean except untracked .claude/ docs/ scripts/)
- **Working tree:** No uncommitted changes to tracked files
- **Prod URL:** https://sandra-sooty.vercel.app
- **STATE.md:** Phase 01 shipped (PR #89 merged). Next action: `/gsd-plan-phase 1.5 --skip-research`

## 2. What shipped this session

| PR # | Title | Effect |
|------|-------|--------|
| #89 | Phase 1: Cross-Table UX Consistency | All 4 CRM index pages (/properties, /lists, /jobs, /templates) now share TableToolbar + SortableHeader + URL-state machine. 6 plans, 34 commits, 478+104 tests green. |

Phase 1 work was on branch `gsd/phase-01-cross-table-ux` — now merged to main.

## 3. Key infrastructure changes

- **New primitives** (src/components/table/):
  - `use-table-url-state.ts` — URL-state hook (mode: ssr | client)
  - `use-table-url-state.helpers.ts` — pure helpers (server-importable, no 'use client')
  - `table-toolbar.tsx` — TableToolbar, TableToolbarSearch, TableToolbarFilterPill
  - `sortable-header.tsx` — SortableHeader<TColumn>
- **Migrated pages:** /properties, /lists, /jobs, /templates — all on the new primitives
- **Test files added:** 7 RTL tests each for lists, jobs, templates (+ existing prospects)

## 4. Memory updates

No new memory files this session. Relevant existing ones:
- `project_bmh_crm_architecture.md` — main arch memory
- `feedback_proactive_model_recommendation.md` — use Sonnet not Opus for routine GSD work

## 5. What's in flight

**Phase 1.5: Sandra Design System Retrofit** — ready to plan, all research done inline.

All reconnaissance completed — do NOT re-research. Jump straight to:
```
/gsd-plan-phase 1.5 --skip-research
```

### Inline research findings (paste into planner context):

**@sandra/tokens location:**
- Path: `../Sandra Design System/` (sibling repo)
- Package name: `@sandra/tokens`, version `0.1.0`
- Exports: `./theme.css` → `tokens/theme.css`
- Add to package.json: `"@sandra/tokens": "file:../Sandra Design System"`

**globals.css token block to remove:**
- `:root { ... }` starts at line 70 — the full warm-paper token block
- Replace with: `@import "@sandra/tokens/theme.css";` after line 3 (`@import "shadcn/tailwind.css";`)

**Registry components (copy from `../Sandra Design System/registry/` to `src/components/ui/`):**

1. **SearchInputPill** (`search-input-pill/search-input-pill.tsx` → `src/components/ui/search-input-pill.tsx`)
   - Props: extends `InputHTMLAttributes<HTMLInputElement>` + `wrapperClassName?` + `iconClassName?`
   - Renders: `<div relative w-full>` + `<Search icon absolute left-4>` + `<input pl-12 pr-4 rounded-full bg-secondary>`
   - No built-in X clear button — X must stay in TableToolbarSearch's outer wrapper
   - Usage in TableToolbar: replace `<Input className="...rounded-full...">` + manual `<Search>` icon with `<SearchInputPill ref={inputRef} defaultValue={ctx.search} onChange={...} placeholder={...} aria-label={...} data-testid={...} />`
   - Keep the X button wrapper div in TableToolbarSearch (it stays relative, X sits at absolute right-3)

2. **DataTableShell + DataTableFooter** (`data-table-shell/data-table-shell.tsx` → `src/components/ui/data-table-shell.tsx`)
   - `DataTableShell`: `<div overflow-hidden rounded-2xl border border-border bg-card>`
   - `DataTableFooter`: `<div flex flex-wrap items-center justify-between gap-3 border-t bg-muted/50 px-6 py-4>`
   - Both exported from same file

3. **CircularPagination** (`circular-pagination/circular-pagination.tsx` → `src/components/ui/circular-pagination.tsx`)
   - Props: `currentPage: number`, `totalPages: number`, `onPageChange: (page: number) => void`, `siblingCount?: number`
   - Circular page buttons + chevrons

**Current table state (what to wrap):**
- `/properties` (`prospects-table.tsx`, 1181 lines): Has `total: number` prop already. Has pagination URL state. Wrap table in DataTableShell, add DataTableFooter with count + CircularPagination.
- `/lists` (`lists-table.tsx`, 250 lines): All lists loaded client-side. DataTableShell + DataTableFooter with count text only (pagination decorative — too few lists typically).
- `/jobs` (`jobs-list.tsx`, 618 lines): Realtime 50-row cap — ?page= is decorative (D-08). DataTableShell + DataTableFooter with count text only.
- `/templates` (`templates-list.tsx`, 368 lines): All prefetched client-side. DataTableShell + DataTableFooter with count text only.

**TableToolbarSearch swap detail:**
- Current: bare `<Input>` + manual `<Search>` icon + custom pill styling
- Target: `<SearchInputPill>` inside existing `relative` wrapper div (X clear button stays)
- Call-site signature unchanged (same props: ariaLabel, placeholder, testId, className)

**UI-SPEC gate:** Skip — this is a visual retrofit, not new UI design. Use `--skip-research` which implies the planner has all context.

**Requirements:** DS-01 through DS-05 (all Phase 1.5).

**Phase 1.5 directory:** `.planning/phases/01.5-sandra-design-system-retrofit/` — already created.

**Suggested plan structure:**
- Plan 01.5-01 (Wave 1): Wire @sandra/tokens (package.json + npm install + globals.css import + remove :root block) — DS-01
- Plan 01.5-02 (Wave 1): Copy 3 registry component files into src/components/ui/ — enables DS-02/03/04
- Plan 01.5-03 (Wave 2): Swap TableToolbarSearch inner input → SearchInputPill — DS-02
- Plan 01.5-04 (Wave 2): DataTableShell + DataTableFooter + CircularPagination on /properties — DS-03, DS-04
- Plan 01.5-05 (Wave 2): DataTableShell + DataTableFooter (count-only) on /lists, /jobs, /templates — DS-03
- DS-05 (tests green) is implicit verify criterion across all plans

## 6. Known not-done

- Playwright cockpit-realtime test flaky (pre-existing, unrelated to Phase 1) — don't fix here
- 46-property CASS recovery (operational, outside GSD scope)
- Playwright retries 1→2 (deferred)
- /admin/skip-trace-settings page (deferred)
- Phase 2: Market Vocabulary Refactor (not started)

## 7. Test credentials

- Jarrad's test phone: +13107540662 (SMS smoke — never real leads)
- Twilio test receiver: +18148097074 (inbound-only canary — never a sender)

## 8. Verification scripts

```bash
npm run verify          # typecheck + 478 node tests + 104 RTL tests (~8s)
gh pr checks <PR#>      # CI status after pushing
open https://sandra-sooty.vercel.app  # prod smoke
```

## 9. Critical learnings

- **No dev server locally** — Jarrad's machine crashes when Next.js dev server starts. Use `npm run verify` for code verification. Use Vercel preview deployments for UI verification. Never run `npm run dev` or `next dev`.
- **Sonnet is sufficient for Phase 1.5 planning** — Jarrad explicitly said no Opus. Use `sonnet` model for researcher + planner subagents.
- **UI-SPEC gate: skip for Phase 1.5** — it's a visual retrofit (design tokens + component swap), not new UI. `--skip-research` flag is correct.
- **@sandra/tokens is a sibling repo, not npm** — `file:../Sandra Design System` is the package.json reference. Already confirmed to exist.
- **SearchInputPill has no X button** — the X clear button must stay in TableToolbarSearch's wrapper div, not inside SearchInputPill.
- **`walk` = accept starred recommendation** — Jarrad uses Wispr AI voice dictation; `lock` also works as synonym.
