# Sandra CRM — Living Retrospective

## Milestone: v2.0 — Cross-table UX consistency + market refactor

**Shipped:** 2026-05-06
**Phases:** 3 | **Plans:** 16 | **Tasks:** 37

### What Was Built

- **Cross-table URL state foundation** — `useTableUrlState` hook + `TableUrlStateContext` + `parseTableSearch`/`buildTableHref` helpers (Phase 1)
- **Reusable toolbar primitives** — `<TableToolbar>`, `<TableToolbarSearch>`, `<TableToolbarFilterPill>`, `<SortableHeader>` extracted into `src/components/table/`
- **Four routes retrofitted** — `/properties`, `/lists`, `/jobs`, `/templates` all consume the unified toolbar + URL-state machine
- **Sandra Design System adopted** — `@sandra/tokens` wired via `file:` reference, `<SearchInputPill>`, `<DataTableShell>`, `<CircularPagination>` consumed from registry (Phase 1.5)
- **Market vocabulary refactor** — city-shaped enum (`Kansas City`, `St. Louis`, etc.) replaced with county-shaped vocab; `counties` table + `fips_codes` reference data; 1,096 properties backfilled via FIPS JOIN (Phase 2, migrations 043-047)

### What Worked

- **Wave-based execution** in Phase 02 (data + ingest + reads + backfill as separate waves) made the schema migration cleanly recoverable when migration 044's subqueries returned null due to empty `fips_codes`
- **Per-route smoke after each retrofit** caught regressions early instead of all-at-once
- **Sibling-package design system** (`Sandra Design System` repo + `file:` reference) let visual overhaul ship without bundling new behavior

### What Was Inefficient

- **Phase 01 + Phase 02 missing VERIFICATION.md** — both shipped via PRs but no formal verifier ever ran. Created an audit gap that was acknowledged at close, not fixed
- **Branch-from-local-HEAD incident (PR #106)** — squash merge swept 7 unpushed GSD WIP commits into a single fix commit. Process rule added: branch from `origin/main` only, never from local HEAD
- **`/messages` cockpit UX bugs** (page-scroll, dispo icon size) — discovered AFTER ship, fixed in PR #107. Should have caught these in pre-ship UX review

### Patterns Established

- **`useTableUrlState` is the canonical pattern** for any future CRM index page (sortable + searchable tables)
- **Branch hygiene rule:** all ad-hoc PR branches cut from `origin/main` after `git fetch`, never from local HEAD
- **County-shaped market vocabulary** is now the system's source of truth — `counties.fips_code` + `properties.county_id` are the authoritative joins

### Key Lessons

- Adoption of a sibling design system (`@sandra/tokens` via `file:`) works cleanly but the symlink is ephemeral — `npm install` re-materializes after worktree operations
- `/gsd-pause-work` leaves WIP commits unpushed on `main`, which conflicts with cutting feature branches from local HEAD. The two patterns must be reconciled (rule above)
- Phase verification (VERIFICATION.md) needs to be a hard gate, not optional. Skipping it leaves audit gaps at milestone close

### Cost Observations

- Mostly Sonnet for execution, Opus for diagnosis (this session: Opus 4.7 for the listThreads bug + the cockpit layout root-cause)
- Sessions: many — the milestone unfolded over ~7 days
- Notable: 211 commits across the milestone window, 16 plans, only 1 cross-phase integration check actually run (Phase 01.5)

---

## Cross-Milestone Trends

(populated as more milestones complete)
