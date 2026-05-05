---
phase: 260504-tgq
plan: 01
subsystem: bulk-sms-cockpit
tags: [bulk-sms, pacing, skip-contacted, outbox, live-stats]
requires: []
provides:
  - bulk-sms-pacing-input
  - bulk-sms-skip-contacted-checkbox
  - bulk-sms-skipIfContacted-server-opt
  - countAlreadyContacted-server-action
  - getQueueStats-server-action
  - QueueStatsBanner-client-component
affects:
  - properties/bulk-sms-modal
  - properties/actions.bulkQueueSms
  - messages/cockpit-view-outbox-tab
  - messages/page-promise-all
key-files:
  created:
    - src/app/(dashboard)/messages/actions.queue-stats.test.ts
    - src/app/(dashboard)/messages/queue-stats-banner.tsx
    - src/app/(dashboard)/messages/queue-stats-banner.test.tsx
    - src/app/(dashboard)/properties/bulk-sms-modal.test.tsx
  modified:
    - src/app/(dashboard)/properties/actions.ts
    - src/app/(dashboard)/properties/actions.bulk-sms.integration.test.ts
    - src/app/(dashboard)/properties/bulk-sms-modal.tsx
    - src/app/(dashboard)/messages/actions.ts
    - src/app/(dashboard)/messages/page.tsx
    - src/app/(dashboard)/messages/cockpit-view.tsx
    - src/app/(dashboard)/messages/cockpit-view.test.tsx
    - src/app/(dashboard)/messages/cockpit-shell.test.tsx
    - src/app/(dashboard)/messages/inbox-filters.test.tsx
decisions:
  - "Per-task atomic commits (one per task) instead of plan-prescribed RED-then-GREEN pairs — the project pre-commit hook runs `verify` (tsc + tests) and rejects intentional RED commits. RED was confirmed before each implementation; only the commit boundary changed."
  - "UTC midnight as the today-boundary in getQueueStats — banner is a global operator surface, not per-viewer; stable boundary preferred over per-timezone."
  - "QueueStatsBanner renders a graceful all-zero fallback when the first-paint server fetch fails, then the 30s client poll retries — no broken page if the page-load query errors."
  - "Skip-contacted default uses a render-path key check (skipContactedKey shadows propertyIdsKey) instead of synchronous setState-in-effect — required to satisfy the project's react-hooks/set-state-in-effect lint rule."
metrics:
  duration: ~22 min
  completed: 2026-05-04
  tasks: 3
  commits: 3
  unit_tests_added: 6
  rtl_tests_added: 17
  integration_tests_added: 4
  total_test_count_after:
    unit: 512
    rtl: 123
---

# Quick Task 260504-tgq: Bulk SMS Pacing + Skip-Contacted + Outbox Live Stats Summary

Three durable improvements to the Bulk SMS workflow so Jarrad can queue ~2,509 first-touch BMH Group prospects with operator-controlled pacing, prior-contact exclusion, and live progress visibility — turning a one-off shell-script outreach into a repeatable in-app workflow.

## Commits

| # | Hash | Subject |
|---|------|---------|
| 1 | `a0ad755` | `feat(260504-tgq): server actions — skipIfContacted + countAlreadyContacted + getQueueStats` |
| 2 | `3453f0f` | `feat(260504-tgq): bulk SMS modal pacing input + skip-contacted checkbox` |
| 3 | `b0312c0` | `feat(260504-tgq): live queue stats banner on Outbox tab` |

## What shipped

### Task 1 — Server actions (`a0ad755`)

- **`bulkQueueSms(propertyIds, opts)`** gains optional `skipIfContacted?: boolean`. When true, an extra `messages` query (filtered to `direction='outbound'`) runs per-prospect *before* the existing consent check; rows with priors increment `skipped` and `continue`. When omitted/false, behavior is identical to before — no extra query, no scope reduction. All consent / phone / template-pool / pacing semantics preserved.
- **`countAlreadyContacted(propertyIds): Promise<Result<number>>`** (NEW) — returns the distinct count of properties (in input set) with at least one outbound message. Empty input short-circuits to `ok(0)` without a DB call. Surfaces `COUNT_CONTACTED_FAILED` on supabase error.
- **`getQueueStats(): Promise<Result<QueueStats>>`** (NEW) — five sequential reads on `messages` returning `{ queued, sentToday, failedToday, nextScheduledFor, lastScheduledFor }`. Today-boundary is UTC midnight (`setUTCHours(0,0,0,0)`); `count` queries use `select('*', { count: 'exact', head: true })`; min/max use `.order(...).limit(1)`. Surfaces `QUEUE_STATS_FAILED` on any sub-query error.
- **`QueueStats` type** exported from `messages/actions.ts` so the client banner prop and the server-side fallback share one shape.

### Task 2 — Bulk SMS modal (`3453f0f`)

- **Pacing field** — number input (default `18`) + seconds/minutes dropdown (default `seconds`). `resolvePaceSeconds(value, unit)` is a top-level export. Validation: resolved seconds must be 10–600; out-of-range swaps the helper text for an inline error and the submit handler early-returns with a toast. Helper text is live: `"Messages release at <X>-second intervals. Cron drains the queue honoring quiet hours."`
- **Skip-contacted checkbox** — labeled `"Skip prospects already contacted (N)"` where `N` is fetched from `countAlreadyContacted` on modal open (renders `(…)` while loading). Default: `propertyIds.length > 50` per the locked-plan rule; resets when the selection identity changes.
- **Submit payload** — both modes (`category` and `custom`) now forward `paceSeconds` (resolved) + `skipIfContacted`. Existing template-pool / consent / phone behavior unchanged.

### Task 3 — Outbox live stats banner (`b0312c0`)

- **`<QueueStatsBanner initialStats={...} />`** (NEW client component) — renders top row `"<queued> queued · <sent> sent today · <failed> failed today"` and bottom row `"Next release: <relative> · drain ETA: <humanized>"`. `formatNextRelease()` and `formatDrainEta()` are exported pure helpers (null → `none queued`/`—`; past → `now`/`<1m`; <60s → `in Ns`; <60m → `Nm`; else → `Hh Mm`).
- **Polling** — `setInterval` 30s; tick body checks `document.visibilityState === "visible"` and skips when hidden. `visibilitychange` listener fires one immediate refresh on hidden→visible so a returning operator doesn't wait up to 30s. Cleanup clears the interval, removes the listener, and a `cancelled` flag prevents post-unmount setState.
- **Cockpit wiring** — `cockpit-view.tsx` adds required `queueStats: QueueStats` prop and renders `<QueueStatsBanner>` directly above the existing `<QueuePanel>` in the Outbox `<TabsContent>`. `page.tsx` adds `getQueueStats()` into the existing `Promise.all` and falls back to all-zero stats on failure (banner still mounts, 30s poll retries).

## Test counts (each touched file)

| File | Before | After | Suite |
|------|--------|-------|-------|
| `messages/actions.queue-stats.test.ts` | 0 (NEW) | 6 | unit |
| `properties/actions.bulk-sms.integration.test.ts` | 8 | 12 (+4) | integration |
| `properties/bulk-sms-modal.test.tsx` | 0 (NEW) | 9 | RTL |
| `messages/queue-stats-banner.test.tsx` | 0 (NEW) | 8 | RTL |
| `messages/cockpit-view.test.tsx` | 3 | 3 (fixture+mock updated) | RTL |
| `messages/cockpit-shell.test.tsx` | 3 | 3 (fixture+mock updated) | RTL |
| `messages/inbox-filters.test.tsx` | 3 | 3 (fixture updated) | RTL |

**Repo totals:** unit 506 → 512; RTL 106 → 123. Integration suite extension is not exercised by `npm test` (no `.env.test.local` in this worktree); covered by `npm run test:integration` in CI / on Jarrad's machine.

## Deviations from Plan

### `[Rule 3 - Blocking]` Per-task atomic commits (not RED-then-GREEN pairs)

- **Found during:** Task 1 commit attempt
- **Issue:** Project pre-commit hook runs `npm run verify` (`tsc --noEmit && npm test && npm run test:rtl`). An intentional RED commit (failing tests + missing implementation) is rejected because tsc errors on the missing exports.
- **Fix:** Combined RED + GREEN into one atomic commit per task. RED was confirmed in each task before implementation began (test runs documented in commit body); only the commit boundary changed.
- **Files affected:** all task commits
- **Commits:** `a0ad755`, `3453f0f`, `b0312c0`

### `[Rule 1 - Bug]` Modal helper-text test value adjusted

- **Found during:** Task 2 modal RTL test run
- **Issue:** Plan's listed test case asserted helper text `"5-second intervals"` when `paceValue=5`, but `5s` is below the modal's 10–600s validation range — so the helper text gets replaced by the inline error and the assertion can never pass. The plan example was internally inconsistent with the validation rule.
- **Fix:** Test now uses `12 seconds` for the in-range helper-text assertion (`"12-second intervals"`), then `5 minutes → 300s → "300-second intervals"` for the unit-conversion check. Spirit (helper text reflects current resolved seconds) preserved.
- **Files modified:** `properties/bulk-sms-modal.test.tsx`
- **Commit:** `3453f0f`

### `[Rule 3 - Blocking]` Modal effect restructured to satisfy `react-hooks/set-state-in-effect`

- **Found during:** Task 3 lint pass
- **Issue:** Project ESLint config flags synchronous `setState()` calls inside `useEffect` bodies as cascading-render risk (`react-hooks/set-state-in-effect`). My initial implementation called `setContactedCount(null)` and `setSkipContacted(propertyIds.length > 50)` synchronously inside the open-time effect.
- **Fix:** Moved the skip-contacted default re-derive into a render-path key-mismatch check (`skipContactedKey` state shadows `propertyIdsKey`; mismatch triggers a fresh default before render). Removed the synchronous `setContactedCount(null)` reset — initial null state + the async fetch's `.then(setContactedCount)` cover the same UX without the lint violation.
- **Files modified:** `properties/bulk-sms-modal.tsx`
- **Commit:** `b0312c0`

### `[Rule 2 - Critical]` Updated existing test mocks for new required prop

- **Found during:** Task 3 RTL run after adding required `queueStats` prop to `<CockpitView>`
- **Issue:** Three existing test files (`cockpit-view.test.tsx`, `cockpit-shell.test.tsx`, `inbox-filters.test.tsx`) constructed `baseProps` without the new required field; tsc errors blocked the suite.
- **Fix:** Added `queueStats` (all-zero default) to the three local `baseProps` fixtures and added a `getQueueStats` stub to the two `./actions` mocks (cockpit-view + cockpit-shell) so the now-mounted `<QueueStatsBanner>` doesn't crash inside the cockpit during those tests.
- **Files modified:** `messages/cockpit-view.test.tsx`, `messages/cockpit-shell.test.tsx`, `messages/inbox-filters.test.tsx`
- **Commit:** `b0312c0`

## Manual verification checklist (before Jarrad runs the 2,509-prospect outreach)

1. `npm run dev` and load `https://localhost:3000/properties` (or the dev URL).
2. Select 1 prospect → Actions → Bulk SMS → confirm:
   - Pacing field renders `[18] [seconds ▾]`.
   - Helper text reads `"Messages release at 18-second intervals. Cron drains the queue honoring quiet hours."`.
   - Skip-contacted checkbox is **unchecked** (≤50 selection) and label shows the live count `(N)` after a moment.
3. Set pacing to `[5] [seconds]` → confirm the inline error `"Pacing must be between 10 seconds and 10 minutes."` appears and the Queue button is no-op (toast on click, no action call).
4. Set pacing to `[60] [seconds]`, check skip-contacted, click Queue → confirm Supabase `messages` row has `scheduled_for ≈ now + 0s` (first row), `status='queued'`, and toast shows correct succeeded/skipped counts.
5. Switch to `/messages?tab=outbox` → confirm:
   - Stats banner renders **above** the queue table.
   - Top row shows `<N> queued · 0 sent today · 0 failed today` (or current values).
   - Bottom row shows `Next release: in <X>s · drain ETA: <Y>m` (or `none queued` / `—` if empty).
6. Wait 30s with the tab visible → DevTools Network → confirm one `getQueueStats` POST/RPC fires.
7. Switch to another tab for ~60s → return → confirm one immediate `getQueueStats` fires on focus.
8. **Then** for the production outreach:
   - Login as `jarrad@bmhgroupkc.com` → `/properties` (no filters) → "Select all 2,533 prospects".
   - Bulk SMS → category `Opener - Homeowner` (15 templates available) → pacing e.g. `[60] [seconds]` (~42h drain) or `[30] [seconds]` (~21h drain) → ☑ skip already contacted (will skip 24).
   - Click `Queue 2,509 messages` → switch to `/messages?tab=outbox` → watch the banner tick down.

## Self-Check: PASSED

**Files created (4) — all present:**
- FOUND: `src/app/(dashboard)/messages/actions.queue-stats.test.ts`
- FOUND: `src/app/(dashboard)/messages/queue-stats-banner.tsx`
- FOUND: `src/app/(dashboard)/messages/queue-stats-banner.test.tsx`
- FOUND: `src/app/(dashboard)/properties/bulk-sms-modal.test.tsx`

**Commits (3) — all present in `git log`:**
- FOUND: `a0ad755`
- FOUND: `3453f0f`
- FOUND: `b0312c0`

**Final test counts:** unit 512 ✓, RTL 123 ✓, tsc clean ✓.
