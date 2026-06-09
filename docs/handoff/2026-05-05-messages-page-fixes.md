# Session Handoff: Messages Page Fixes + Queue Reschedule

**Date:** 2026-05-05 (overnight session)
**Branch:** main — pushed to origin
**Last commit:** `224773d` (merge of #103 outbox redirect)
**Prod URL:** https://sandra-sooty.vercel.app
**GSD state:** STATE.md — Phase 01.5, Phase 2 not yet started

---

## Current State

All PRs from this session are merged and deployed to prod. The /messages page was crashing on load; three targeted fixes resolved the crash, the stats banner zero-count bug, and missing Outbox redirect. The 939 bulk-queued messages were rescheduled to drain at 1/min starting 8 AM CDT May 5.

---

## What Shipped This Session

| PR # | Title | Effect |
|------|-------|--------|
| #101 | fix(messages): exclude queued messages from inbox thread list | `listThreads` was fetching all 939 bulk-queued messages, bloating contact IDs past PostgREST `.in()` URL limit → crash. Fixed with `.neq("status", "queued")`. |
| #102 | fix(messages): use admin client in getQueueStats to fix zero-count bug | `getQueueStats()` called `createClient()` (cookie-based) from a `"use server"` action invoked by a Server Component — Next.js doesn't propagate cookie context, so it ran as anon → RLS returned 0. Switched to `createAdminClient()`. |
| #103 | feat(messages): redirect to Outbox after bulk SMS queue completes | After queuing, `router.push('/messages?tab=outbox')` so user lands on Outbox immediately. |

---

## Key Infrastructure Changes

- **`src/lib/messages/list-threads.ts`** — Added `.neq("status", "queued")` to the messages fetch. Queued messages are not conversations and should never appear in the thread list.
- **`src/app/(dashboard)/messages/actions.ts`** — `getQueueStats()` now uses `createAdminClient()` instead of `createClient()`. Import added.
- **`src/app/(dashboard)/properties/bulk-sms-modal.tsx`** — `useRouter` added; `router.push('/messages?tab=outbox')` fires after `onClose()` on success.
- **Prod DB data fix** — 939 `queued` messages rescheduled via direct SQL UPDATE. New `scheduled_for` range: `2026-05-05 13:00:00+00` → `2026-05-06 04:38:00+00` (8 AM CDT May 5 → 11:38 PM CDT May 5). ~159 messages fall after 9 PM CDT quiet hours and will drain 8 AM CDT May 6.

---

## Memory Updates

No new memory files this session. Existing memories are current.

---

## What's In Flight

**Immediate:** 939 messages draining at 1/min from 8 AM CDT May 5.

- First batch: 8:00 AM CDT May 5 (13:00 UTC)
- ~780 messages send through 9 PM CDT May 5
- ~159 messages held overnight by quiet hours, resume 8 AM CDT May 6

Check drain progress via Supabase MCP (prod project: `copflsklaefwzipsrjqz`):
```
SELECT status, COUNT(*) FROM messages WHERE created_at > NOW() - INTERVAL '48 hours' GROUP BY status ORDER BY count DESC;
```

**Next GSD work:** Phase 2 (Market Vocabulary Refactor) — run `/gsd-next` when ready.

---

## Known Not-Done

- **Phase 1.5 not formally marked complete in GSD** — waiting on visual "approved" for UAT.
- **E2E CI still fails** — GitHub Actions Playwright suite fails because `@sandra/tokens` can't resolve in CI. Fix needed separately.
- **Stray untracked items:**
  - `.claude/worktrees/Sandra Design System` — leftover worktree symlink; `rm -rf ".claude/worktrees/Sandra Design System"`
  - `docs/design/screenshots/phase-1-5-uat/` — UAT screenshots, commit or gitignore
  - `docs/handoff/2026-05-04-sms-volume-complete.md` — prior handoff, commit or delete
- **Stats banner shows "next release" as past timestamp** — now that messages are rescheduled this should show correctly after 8 AM CDT. If still wrong, check `getQueueStats` `nextScheduledFor` query.
- **Bulk SMS modal: "Queuing…" blocks for ~2-3 minutes** — server action does sequential DB calls for large batches. Long-term fix is a background job.
- **Opted-out queued messages accumulate** — `releaseQueuedMessage` returning `blocked_no_consent` leaves message as `queued` instead of `failed`. Known acceptable for now.
- **Pacing lost after overnight quiet-hours hold** — when `scheduled_for` falls in the past, the cron drains at 50/5-min instead of 1/min. For the ~159 overflow messages on May 6 morning this means a ~15-minute burst drain (acceptable). Consider adding a "reschedule on quiet-hours block" mechanism if this recurs.

---

## Test Credentials

- **Prod login**: `PROD_EMAIL` / `PROD_PASSWORD` in `.env.local` (gitignored — do not log)
- **Jarrad's test phone**: `+13107540662` — SMS smoke only, never real leads
- **Twilio test receiver**: `+18148097074` — inbound-only canary, never a sender
- **Test suite user**: shared E2E account / `test12345` (test Supabase project `ncsngxlcyxylaeskiteu` only)
- **Prod Supabase project**: `copflsklaefwzipsrjqz`

---

## Verification Scripts

```bash
# Confirm main is clean
git log --oneline -5
git status

# TypeScript clean
node_modules/.bin/tsc --noEmit

# Full test suite
npm test && npm run test:rtl

# Check drain progress (Supabase MCP or psql)
SELECT status, COUNT(*) FROM messages
WHERE created_at > NOW() - INTERVAL '48 hours'
GROUP BY status ORDER BY count DESC;

# Check rescheduled timestamps
SELECT MIN(scheduled_for), MAX(scheduled_for), COUNT(*)
FROM messages WHERE status = 'queued';
```

---

## Critical Learnings

1. **`listThreads` must exclude `status = 'queued'`** — bulk-queued messages are not conversations. Without this filter, a large bulk send floods the contact ID list and breaks the `.in()` PostgREST query.
2. **Server Actions calling `createClient()` from a Server Component context may run as anon** — Next.js doesn't always propagate the cookie store through the "use server" boundary when called inline from a Server Component. For stats/aggregate reads, `createAdminClient()` is the correct fix. For user-scoped queries, pass the session explicitly.
3. **DialPad is the SMS provider, not Twilio** — don't reference Twilio rate limits; apply DialPad's.
4. **Quiet hours block releases but leave `scheduled_for` in the past** — after an overnight hold, all past-due messages burst on the next cron tick. Reschedule via SQL UPDATE when this matters.
5. **Vercel Postgres count with `head: true` returns 0 (not an error) when RLS denies the session** — silent zero is indistinguishable from "no rows". Always check the client type when debugging zero counts.
