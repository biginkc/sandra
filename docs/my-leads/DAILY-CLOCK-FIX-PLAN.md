# Daily call activity clock fix

Date: 2026-09-13. Baseline: 1390a8e6. Scope: fix and deploy My Leads last-attempt timer.

## Verified cause

The KPI RPC in 20260913100000 selects the latest acquisition attempt across all history, including manual outreach. Both metrics.tsx and sticky-metrics.tsx continuously add elapsed time, and existing tests explicitly expect yesterday's counter to continue. The existing acquisition calendar is Monday–Friday 09:00–17:00 America/Chicago (time.ts and acquisition_time_helpers SQL).

## Behavior

- Outside that existing work window, show “Outside work hours” without a running duration.
- During work hours, show “No calls today” until the selected rep has an actual call attempt on the current Central calendar day.
- Only attempt_kind='call' qualifies: authenticated logged external calls or existing provider-backed seller dial evidence. Manual outreach, opening the page, operator setup, and an owner's login do not start/reset it.
- First qualifying call starts the timer; later calls reset it. A same-day pre-shift call qualifies at opening, but elapsed work time starts no earlier than 09:00.
- At 17:00 stop displaying a duration; at the next workday require that day's call. Never carry yesterday's value into today. Both expanded/sticky displays use one component.
- Retain authenticated page/RPC access. Do not equate persistent auth tokens with attendance or add a daily forced login. There is no shift/presence tracker; a same-day authenticated actual call is the available evidence that this rep started working. This does not implement pause-on-tab-close or presence monitoring.

## Provider and platform documentation

- Supabase sessions: https://supabase.com/docs/guides/auth/sessions — sessions persist by default; a session is not a daily attendance record. Preserve current getUser and RPC scope checks.
- Supabase database functions: https://supabase.com/docs/guides/database/functions — preserve the existing restricted security-definer function, empty search_path, and grants; change only the selected clock evidence. No direct table grants.
- React useEffect: https://react.dev/reference/react/useEffect — timers are external systems; clean up intervals when inputs change/unmount. Stop scheduling ticks once inactive and share logic between presentations.
- Intl.DateTimeFormat: https://developer.mozilla.org/en-US/docs/Web/JavaScript/Reference/Global_Objects/Intl/DateTimeFormat — use an explicit IANA zone, not browser local date or fixed UTC offset. Reuse existing timezone helpers for DST.
- Vercel Git deployments: https://vercel.com/docs/git — verify the production deployment for the merged commit and the live URL; a branch preview is insufficient.
- Installed Next.js guide: node_modules/next/dist/docs/01-app/03-api-reference/01-directives/use-client.md — keep the ticking component within the existing client boundary and pass serializable timestamps.

Supabase changelog was checked (markdown endpoint failed; HTML fallback read). No auth or SDK behavior change is needed.

## Implementation and verification

1. Add a forward migration replacing only the KPI RPC. Scope lastAttemptAt to today's call attempts using statement_timestamp() and Central day bounds, independently of reporting filters. Preserve authorization and other metrics.
2. Add a shared clock state helper/component using the established work window and the server snapshot plus monotonic elapsed time. Both displays consume it. Guard invalid/future/legacy data and fresh snapshots; stop at the work boundary.
3. Test Sunday/Saturday, before first call, prior-day calls, non-call outreach, actor isolation, opening/closing boundaries, new evidence, Central-vs-UTC date, DST, stale snapshots, and expanded/sticky parity. Rehearse real PostgreSQL query semantics with bounded local fixtures; run repository verification and required CI.
4. Independent review, fix findings, create scoped PR, wait for required checks, merge owned green PR.
5. Use the repository's test-to-production migration workflow, then verify production migration and Vercel deployment. Verify live response/UI without calling real leads. If the repository environment gate requires an explicit approval, report that exact concrete gate after other work is complete.

## Rollback

Record pre-merge main and deployed commit. Revert the scoped UI change through Git if necessary. Restore the prior KPI function via a new forward migration through the same migration workflow; never edit historical migrations. No business records are changed by this fix.
