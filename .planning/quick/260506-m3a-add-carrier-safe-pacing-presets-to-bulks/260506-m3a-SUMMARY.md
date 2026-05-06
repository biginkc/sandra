---
quick_id: 260506-m3a
type: summary
status: complete
completed: 2026-05-06
duration_minutes: ~70
commits:
  - 738a645  # feat: add dailyCap + jitterPct to bulkQueueSms
  - d50ee25  # feat: preset selector + drain estimate in BulkSmsModal
  - 2fab22e  # fix: nextDayEightAmPT advance + jitter applied to gap not position
  - f3a3397  # test: preset selector + jitter + daily-cap rollover coverage
files_modified:
  - src/app/(dashboard)/properties/actions.ts
  - src/app/(dashboard)/properties/bulk-sms-modal.tsx
  - src/app/(dashboard)/properties/bulk-sms-modal.test.tsx
  - src/app/(dashboard)/properties/actions.bulk-sms.integration.test.ts
deviations:
  - "[Rule 1 - Bug] nextDayEightAmPT was off-by-one; rollover landed +2 days instead of +1"
  - "[Rule 1 - Bug] Jitter was applied to absolute position; gaps spanned [-2J, +2J] instead of [-J, +J]"
  - "[Rule 3 - Blocking] Pre-commit hook blocks Task 2 unless modal tests are updated together; combined Task 2 modal code with the existing-test compatibility updates (selecting Custom before raw-pace assertions)"
---

# Quick Task 260506-m3a: Carrier-safe pacing presets in BulkSmsModal Summary

Replace BulkSmsModal's raw pacing input with 4 carrier-safe presets (Conservative / Steady ⭐ / Push / Custom) that bundle pace + daily cap + jitter; teach `bulkQueueSms` to honor `dailyCap` (rolling overflow to next day 8 AM PT) and apply ±20% jitter per gap.

## What Shipped

**UI — `bulk-sms-modal.tsx`:**

- 4 radio presets render in a 2-col grid; Steady is default-selected (replaces the previous 18s/no-cap default).
- Each non-Custom preset shows `{cap}/day · {pace}s ±20%` plus a tagline; Push specifically copies *"short-burst sprint, not for sustained use."*
- Custom radio reveals BOTH the existing pace number+unit inputs AND a new `Daily cap` number input. The 3 locked presets hide both.
- New `computeDrain()` helper mirrors the server's bucket math; Drain Estimate panel renders per-day breakdown ("Today 1,000 · Tomorrow 500"), the last-send local timestamp ("Mon 4:48 PM PT"), and an amber "N would land past 9 PM cutoff — released next morning" note when applicable.
- `handleSend` forwards `paceSeconds`, `dailyCap`, and `jitterPct: 0.20` alongside the existing `skipIfContacted` and template/body fields.
- Pacing out-of-range validation only fires in Custom mode (locked presets are always within bounds by definition).

**Server — `actions.ts`:**

- `bulkQueueSms` `opts` extended with `dailyCap?: number` (undefined = no cap) and `jitterPct?: number` (defaults to 0; existing callers unchanged).
- New private helper `nextDayEightAmPT(afterMs)` advances exactly one PT calendar day from input, anchors at 08:00 PT (16:00 UTC at fixed -08:00 offset; DST drift to 9 AM PT is intentional & still inside the federal sending window).
- Per-message scheduling loop tracks `cumulativeOffsetMs`, `dayBucketStartMs`, `dayBucketCount`. When `dayBucketCount >= dailyCap`, advances `dayBucketStartMs` to next-day-8 AM-PT and resets count + offset.
- First message of each bucket anchors deterministically at the bucket start. Subsequent messages compute a candidate jittered gap (`pace*1000 ± jitterPct of pace*1000`), only commit it on a successful queue (so a downstream skip doesn't burn a slot and stretch the next gap past the bound).

**Tests:**

- 7 new modal tests cover: preset radios + Steady default, Push tagline copy, drain-estimate updates on preset switch, Custom reveals raw inputs, Steady forwards (8/1000/0.20), Push forwards (4/1800), Custom no-cap → undefined.
- 3 new integration tests cover: jitter spread (gaps in [8000ms, 12000ms] AND not all equal), dailyCap rollover (3 today + 2 next-day-8 AM-PT), dailyCap undefined preserves existing deterministic ramp.
- 5 existing 260504-tgq modal tests updated to click Custom before touching raw pace inputs (the new design's intended behavior). 1 existing test removed (`Helper text reflects current resolved pace seconds`) — the per-second helper text was deleted in favor of the drain estimate.

## Verification

- `npm run test:integration src/app/(dashboard)/properties/actions.bulk-sms.integration.test.ts` — **16/16 green** (13 existing + 3 new).
- `npm run test:rtl src/app/(dashboard)/properties/bulk-sms-modal.test.tsx` — **15/15 green** (8 retained + 7 new).
- `npx tsc --noEmit` — **0 errors** across the repo.
- Full pre-commit `npm run typecheck && npm run test && npm run test:rtl` ran on each of the 4 commits — **548 unit + 137 RTL all green** at HEAD.
- `npx eslint 'src/app/(dashboard)/properties/' --quiet` — 1 pre-existing error in `prospects-table.tsx` and 2 pre-existing unused-disable warnings on files I touched; logged to `deferred-items.md` (out of scope per SCOPE BOUNDARY).

## Deviations from Plan

### Auto-fixed Issues

**1. [Rule 1 - Bug] nextDayEightAmPT off-by-one**

- **Found during:** Task 3 integration test (`dailyCap=3 with 5 leads`)
- **Issue:** Rollover landed at 2026-04-25 instead of 2026-04-24. The plan's helper had `+ (ptHour >= 8 ? 1 : 0)`, and the call site passed `bucketStart + 24h`, so the helper saw "ptHour=11 next day" and advanced one MORE day → +2 days from the bucket start.
- **Fix:** Helper now always advances exactly one PT calendar day from the input's PT date and anchors at 08:00 PT. Call site passes the bare bucket start.
- **Files:** `src/app/(dashboard)/properties/actions.ts`
- **Commit:** `2fab22e`

**2. [Rule 1 - Bug] Jitter applied to absolute position, not gap**

- **Found during:** Task 3 integration test (`jitterPct=0.20 produces gaps in [8000, 12000]`)
- **Issue:** Original implementation set `scheduledFor = anchor + N*pace + jitter[N]` where each `jitter[N]` was a fresh `±J` roll. Gap between consecutive messages = `pace + (jitter[N+1] - jitter[N])`, which spans `[-2J, +2J]` — a 10s nominal gap could be as low as 6s or as high as 14s, well outside the plan's "±jitterPct of pace" bound. Test caught a gap of 6794ms.
- **Fix:** Jitter is now applied per-gap. `cumulativeOffsetMs` advances by `pace*1000 + jitterMs` only on successful queue, so each gap is `pace * (1 ± jitterPct)`. First message of each bucket still anchors at the bucket start (no jitter, deterministic).
- **Files:** `src/app/(dashboard)/properties/actions.ts`
- **Commit:** `2fab22e`

**3. [Rule 3 - Blocking] Pre-commit hook would block Task 2's modal commit**

- **Found during:** Task 2 (committing modal changes)
- **Issue:** The plan order is server → modal → tests, but the project's pre-commit hook runs `typecheck && test && test:rtl`. The existing 260504-tgq modal tests assumed `getByLabelText(/^Pacing$/i)` finds the raw pace input on modal open — true for the old design, false for the new preset-first design. Without updating those tests, Task 2 cannot commit.
- **Fix:** Combined Task 2's modal code with the existing-test updates from Task 3 (selecting Custom before each raw-pace assertion). The new preset *describe* block was deferred to Task 3's commit. This preserves atomicity per task while satisfying the hook.
- **Files:** `src/app/(dashboard)/properties/bulk-sms-modal.test.tsx`
- **Commit:** `d50ee25`

## Commits

| # | Commit | Type | Subject |
|---|--------|------|---------|
| 1 | `738a645` | feat | add dailyCap + jitterPct to bulkQueueSms |
| 2 | `d50ee25` | feat | preset selector + drain estimate in BulkSmsModal |
| 3 | `2fab22e` | fix  | correct nextDayEightAmPT advance + jitter applied to gap not position |
| 4 | `f3a3397` | test | preset selector + jitter + daily-cap rollover coverage |

## Threat Flags

None. The change extends an existing authenticated server action's options surface; no new endpoints, auth paths, or trust-boundary changes.

## Known Stubs

None. All UI affordances flow real data: presets read from a typed const map, drain estimate computes from real selection size + active preset, server schedules use real consent + body resolution paths.

## TDD Gate Compliance

This plan's frontmatter does not declare `type: tdd`, so plan-level RED→GREEN→REFACTOR gating doesn't apply. Per-task TDD discipline was observed via the test-suite-driven follow-up commit (`2fab22e`): the new tests in Task 3 caught two real bugs in Task 1's server implementation, and the fix landed before declaring the plan complete.

## Self-Check: PASSED

- File `src/app/(dashboard)/properties/actions.ts` — modified, present.
- File `src/app/(dashboard)/properties/bulk-sms-modal.tsx` — modified, present.
- File `src/app/(dashboard)/properties/bulk-sms-modal.test.tsx` — modified, present.
- File `src/app/(dashboard)/properties/actions.bulk-sms.integration.test.ts` — modified, present.
- Commits `738a645`, `d50ee25`, `2fab22e`, `f3a3397` — all present in `git log` on the active branch.
