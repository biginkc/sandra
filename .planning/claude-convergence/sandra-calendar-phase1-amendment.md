# Sandra Calendar Phase 1 amendment

## Goal

Implement the 2026-08-17 Calendar amendment from `Design package delivery.zip` against `biginkc/sandra@main`.

## Plan sources

- User-provided `Prompt — Calendar update (Sandra Daily Operations, Phase 1 amendment)`
- `handoff/CALENDAR-UPDATE-PROMPT.md`
- `handoff/CODEX-HANDOFF.md`
- `handoff/Sandra Daily Operations.dc.html` (visual reference only)

## Baseline

- `origin/main`: `d0b5df5820ef96a778205219872117f3066fab22`
- Branch: `codex/sandra-calendar-phase1-amendment`
- Worktree: `/Users/jarradhenry/Sites/BMH apps/_codex_worktrees/sandra-calendar-phase1-amendment`
- Authority: production-aware; existing Phase 1 merge/deploy authorization applies after all gates pass.

## Acceptance gates

- [x] Week is the 8 AM-6 PM timeline with a 52px gutter, seven lanes, 44px hour rows, today tint, absolute event geometry, and existing tones.
- [x] Month remains a fixed 42-cell Sunday-start rounded-card grid with real date math and DST/February tests.
- [x] Agenda remains functionally unchanged; narrow Week/Month continue to use Agenda.
- [x] Prev/Today/Next are functional 44px buttons with the new selector/ARIA contract and retained legacy selectors.
- [x] Week/Agenda and Month retain independent URL-backed positions; Today resets both.
- [x] Empty queried ranges render the full grid and a truthful one-line notice; today marker appears only in the actual current period.
- [x] Range title is promoted to the right side of the page header with the required typography and selector.
- [x] Existing Calendar actions, scope behavior, timezone truth, DNC locks, links, and selectors remain intact unless the amendment explicitly replaces the Week card controls.
- [x] Focused unit/RTL, full typecheck/test/RTL, build, and E2E pass.
- [x] Exhaustive manual review is clean at the final uncommitted candidate.
- [ ] Claude Fable returns `DONE` with high confidence at the final reviewed head.
- [ ] Preview and production Chrome acceptance pass at 1440x900 and 390x844.

## Exclusions

- No prototype code is copied into Sandra.
- No Phase 2 workflows.
- No Jitter work.
- No outbound SMS/calls/email or paid-provider activity.

## Preflight

- ZIP found and inspected locally; amendment matches the user prompt.
- Current main fetched and verified.
- Dirty user checkout left untouched; isolated worktree created.
- Chrome and Claude transport will be reverified before their respective gates.

## Iterations

### Iteration 0 — audit

- Current Week is the rejected seven-card layout, not a time grid.
- Current Month uses joined hairline cells, not individually rounded cards.
- Current navigation overloads `week` for both views, so offsets are not independent.
- Current range title is absent from the page header.

### Iteration 1 — implementation and adversarial review

- Replaced desktop Week cards with the approved fixed-height timeline.
- Preserved every appointment by adding a day-aligned outside-hours rail for events that cannot fit inside 8 AM-6 PM.
- Added rendered-geometry overlap columns, including back-to-back 15-minute events whose 36px minimum blocks collide visually.
- Restored the approved rounded Month-card composition while preserving real 42-day, timezone-safe ranges.
- Added independent URL-backed Week and Month anchors, functional navigation, active Today affordance, promoted header range, and fail-closed empty-period copy.
- Fixed false today markers in adjacent-month padding and added full-date accessible labels.
- Independent logic, UI, and test reviewers returned `BLOCKING=0` and approved the corrected slice. A proposed Week lifecycle-control finding was rejected after reconciling the exact amendment with the handoff: Week blocks contain time/title/assignee and status tones; Agenda remains the lifecycle surface.

## Local evidence

- Focused Calendar node tests: 60/60 passed.
- Focused Calendar RTL after final overlap fix: 57/57 passed.
- Full `npm run verify`: 2,264 node tests and 760 RTL tests passed; typecheck passed.
- Production build: passed.
- Calendar amendment Playwright: 2/2 passed in Chromium, including authenticated Month prev/next/Today behavior.
- Calendar changed-file ESLint and `git diff --check`: passed.
- No configuration, migration, provider, prototype, or Jitter files changed.

## Remaining release gates

- Claude Fable convergence at the committed candidate.
- Candidate PR, exact-head CI, and preview deployment.
- Fresh desktop and mobile Chrome acceptance, then merge/deploy/production acceptance if all gates remain clean.
