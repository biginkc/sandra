# Session Handoff — 2026-05-05 — outreach-dispo

## Current State

- **Branch:** `main` (all changes uncommitted — see git status below)
- **Working tree:** 9 modified files + 3 new untracked files — nothing committed yet
- **Deployed URL:** https://sandra-sooty.vercel.app (does NOT have this feature yet)
- **Dev server:** Running on port 3000 (Playwright E2E tests use port 3456)

## What Shipped This Session

Nothing merged/deployed yet — full feature coded, TypeScript clean, not committed.

## Key Infrastructure Changes

### New migration (NOT yet applied to prod or test DB)
`supabase/migrations/045_outreach_dispo.sql`
- Adds `outreach_dispo text` (nullable, enum check) to `properties`
- Adds `follow_up_at timestamptz` (nullable) to `properties`
- Adds sparse index `idx_properties_outreach_dispo`
- Values: `wrong_number | bad_number | not_interested | opted_out | dnc | nurture | callback_requested`

### New/modified code files (all uncommitted)
| File | Change |
|---|---|
| `supabase/migrations/045_outreach_dispo.sql` | NEW — migration |
| `src/lib/supabase/types.ts` | outreach_dispo + follow_up_at added to Row/Insert/Update |
| `src/app/api/webhooks/dialpad/sms/route.ts` | DNC_KEYWORDS + WRONG_NUMBER_KEYWORDS auto-detection |
| `src/app/(dashboard)/messages/dispo-actions.ts` | NEW — `setOutreachDispo` server action |
| `src/app/(dashboard)/messages/inbox-detail-data.ts` | Fetches outreach_dispo + status from properties |
| `src/app/(dashboard)/messages/inbox-detail.tsx` | DispoBar component with 4 action buttons |
| `src/app/(dashboard)/properties/page.tsx` | outreach_dispo in query + ProspectRow mapping |
| `src/app/(dashboard)/properties/prospects-table.tsx` | DispoPill + outreach_dispo in ProspectRow type |
| `src/lib/sequences/tick.ts` | Dispo-based pause check (wrong_number/bad_number/dnc/opted_out) |
| `e2e/check-dispo.spec.ts` | Temporary Playwright check — DELETE before PR |
| Test fixtures | cockpit-view.test.tsx, inbox-detail.test.tsx, prospects-table.test.tsx updated |

## Memory Updates

No memory files modified this session (feature was new work, no corrections to existing preferences).

## What's In Flight

**PRIMARY: Commit + PR for outreach_dispo feature**

Steps:
1. Delete `e2e/check-dispo.spec.ts` (temporary debug file, do not commit)
2. Stage and commit all 9 modified + 2 new source files (leave `scripts/run-recovery-2026-05-05-broken-token.ts` and `docs/design/screenshots/` out)
3. Create PR — migration will apply to prod + test via `db-migrate.yml` on merge
4. Verify: after migration applies, open a conversation in `/messages` — the DispoBar (4 icon buttons below the thread) should appear
5. Smoke: click "Wrong number" → confirm `outreach_dispo = 'wrong_number'` in DB

**WHY BUTTONS AREN'T SHOWING YET:**
The feature is not committed or deployed. The user is likely looking at the production URL (https://sandra-sooty.vercel.app) which has the old code. The local dev server on port 3000 should show the buttons, but even locally, the migration hasn't been applied so the property query may silently fail (outreach_dispo column missing). The DispoBar still renders because `propertyId` is sourced from messages, not the property query — but the property query error may cause subtle issues. Apply migration locally first to verify cleanly.

## Known Not-Done

- `e2e/check-dispo.spec.ts` — DELETE before PR (temporary debug file left on disk)
- GSD phases 02-04 and 02-05 still need execution (separate from this feature — outreach_dispo is outside the GSD milestone scope)
- Follow-up queue / notifications when `follow_up_at` arrives — out of scope, not built
- Phone-level status tracking (phone_1_status etc.) — out of scope, not built
- AI auto-detection of "not interested" — out of scope, not built
- Cockpit dispo bar on lead detail page (not just /messages cockpit) — out of scope

## Test Credentials

- Jarrad's test phone: +13107540662 (SMS smoke, never real leads)
- Twilio test receiver: +18148097074 (inbound-only canary, never a sender)

## Verification Scripts

```bash
# After migration applies — confirm column exists
# (run in Supabase SQL editor or via MCP)
# SELECT column_name FROM information_schema.columns WHERE table_name='properties' AND column_name='outreach_dispo';

# TypeScript check (should be zero errors)
npx tsc --noEmit

# E2E — run cockpit tests to confirm no regression
npx playwright test --project=chromium e2e/cockpit-reply.spec.ts e2e/cockpit-thread-panel.spec.ts
```

## Critical Learnings

1. **base-ui vs Radix UI** — This project uses `@base-ui/react` for Tooltip and Popover, NOT Radix. Key differences:
   - `TooltipProvider` uses `delay` prop, not `delayDuration`
   - `TooltipTrigger` and `PopoverTrigger` render AS buttons — no `asChild` needed. Put icon children directly inside the trigger.
   - Nesting TooltipTrigger inside PopoverTrigger doesn't work; use `title` attribute on PopoverTrigger for accessibility instead.

2. **Migration not applied = property query silently fails** — Selecting `outreach_dispo` before the migration is applied returns a Supabase error. `p` becomes null. `propertyId` is still set (from messages), so DispoBar renders, but `outreachDispo` and `propertyStatus` will be null. Functionally OK until migration lands.

3. **GSD phase 02 still executing** — Plans 02-04 and 02-05 exist with no SUMMARY. The outreach_dispo feature was worked outside GSD tracking. Don't let `/gsd-next` confuse the two.
