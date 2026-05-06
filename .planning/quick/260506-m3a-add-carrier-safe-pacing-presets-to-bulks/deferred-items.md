# Deferred items — 260506-m3a

Items discovered during execution that were OUT OF SCOPE for this quick task.
Logged here so they're not forgotten but did NOT block the plan.

## Pre-existing ESLint warnings/errors (not introduced by this plan)

### `src/app/(dashboard)/properties/prospects-table.tsx:203`
- **Error:** `react-hooks/set-state-in-effect` — `setSelectAllMatching(false)` called synchronously inside `useEffect`
- **Status:** Pre-existing, in a file untouched by this plan
- **Recommendation:** `/gsd-fast` later — refactor to derive selection-clearing from URL params instead of `useEffect`

### Two unused `eslint-disable-next-line import/first` directives
- `src/app/(dashboard)/properties/actions.bulk-sms.integration.test.ts:37`
- `src/app/(dashboard)/properties/bulk-sms-modal.test.tsx:30`
- **Status:** Pre-existing, predate this plan
- **Recommendation:** Trivial cleanup — remove the directives. Could be done in any future quick task.

## Notes

The plan's `<verification>` block included `pnpm lint src/app/(dashboard)/properties/` —
the executor ran the equivalent via `npx eslint`. The 1 error + 4 warnings unrelated to
this plan are listed above for visibility but do NOT count against this plan's
success criteria (SCOPE BOUNDARY: don't fix issues directly caused by other tasks).
