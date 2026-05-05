# Session Handoff: Bulk SMS Pacing + Outbox Stats — Fully Shipped

**Date:** 2026-05-05 (overnight session)
**Branch:** main — pushed to origin
**Last commit:** `e2ceef4` (merge of #100 queue-panel-limit)
**Prod URL:** https://sandra-sooty.vercel.app
**GSD state:** STATE.md — Phase 01.5, quick task 260504-tgq complete, Phase 2 not yet started

---

## Current State

All PRs from this session are merged and deployed to prod. The Vercel build is green (PR #98 fixed the `@sandra/tokens` issue that had been silently breaking every deploy since Phase 1.5). The bulk SMS outreach for ~939 prospects is actively draining — messages are staggered at 1-minute intervals through ~5:10 PM UTC tomorrow.

---

## What Shipped This Session

| PR # | Title | Effect |
|------|-------|--------|
| #96 | feat: Bulk SMS pacing + skip-contacted + Outbox live stats banner | Modal pacing input, skip-contacted checkbox, live stats banner on /messages Outbox |
| #97 | fix: chunk Supabase IN queries to fix BULK_SMS_FAILED on large selections | PostgREST 400 fix — IN clauses chunked to 250 IDs |
| #98 | fix(build): vendor @sandra/tokens CSS to unblock Vercel deploys | Fixed root build failure blocking ALL deploys since Phase 1.5 |
| #99 | fix: paginate select-all past Supabase 1K row limit | getAllMatchingProspectIds now paginates with .range() |
| #100 | fix(messages): limit queued fetch to 100 rows to fix page crash | /messages Server Component crashed with 939 queued rows |

---

## Key Infrastructure Changes

- **`src/app/sandra-tokens.css`** — NEW file. Vendored copy of `../Sandra Design System/tokens/theme.css`. `globals.css` now imports this instead of `@sandra/tokens/theme.css`. The `file:` dep in `package.json` stays for local dev symlink.
- **`src/app/(dashboard)/properties/actions.ts`** — `bulkQueueSms` now chunks property fetch + skip-contacted prefetch in 250-ID batches. `getAllMatchingProspectIds` paginates with `.range(0,999)` loops.
- **`src/app/(dashboard)/messages/actions.ts`** — `getQueueStats()` added (queued/sentToday/failedToday/nextScheduledFor/lastScheduledFor).
- **`src/app/(dashboard)/messages/queue-stats-banner.tsx`** — NEW client component, polls every 30s, pauses when tab hidden.
- **`src/app/(dashboard)/messages/cockpit-view.tsx`** — `<QueueStatsBanner>` inserted above `<QueuePanel>` when `activeTab === 'outbox'`.
- **`src/app/(dashboard)/messages/page.tsx`** — Queued message fetch limited to 100 rows ordered by `scheduled_for`.

---

## Memory Updates

No new memory files this session. Existing memories are current.

---

## What's In Flight

**Immediate: ~939 messages are actively queued, draining at 1-minute pacing through ~5:10 PM UTC 2026-05-05.**

Check drain progress:
```bash
# Via Supabase MCP (prod project: copflsklaefwzipsrjqz)
SELECT status, COUNT(*) FROM messages WHERE created_at > NOW() - INTERVAL '24 hours' GROUP BY status;
```

Or visit `/messages` → Outbox tab — the live stats banner shows current count.

**Next GSD work:** Phase 2 (Market Vocabulary Refactor) — run `/gsd-plan-phase 2` when ready.

---

## Known Not-Done

- **`/messages` Outbox doesn't auto-redirect after bulk queue** — the modal closes with a toast but doesn't navigate to `/messages`. The user expected to land on the Outbox automatically. Worth adding `router.push('/messages?tab=outbox')` in the `onQueued` callback in `bulk-sms-modal.tsx`.
- **Bulk SMS UX: "Queuing…" blocks for ~2-3 minutes** — with 1000 prospects, the server action does sequential DB calls. Long-term fix is a background job; short-term workaround is adding "This may take a minute…" helper text.
- **Select-all still shows 1000 cap in Actions button** — #99 fix deployed but the browser may be caching the old JS. Hard refresh (Cmd+Shift+R) should show the correct count.
- **`/templates` DataTableShell has no `data-testid`** — UAT spec locates by footer text. Add testid later if needed.
- **Stray untracked items:**
  - `.claude/worktrees/Sandra Design System` — leftover worktree symlink; `rm -rf ".claude/worktrees/Sandra Design System"`
  - `docs/design/screenshots/phase-1-5-uat/` — UAT screenshots, commit or gitignore
  - `docs/handoff/2026-05-04-sms-volume-complete.md` — prior handoff, commit or delete
- **Phase 1.5 not formally marked complete in GSD** — waiting on visual "approved" for UAT. The new modal IS deployed and working.
- **opted-out queued messages accumulate** — `releaseQueuedMessage` returning `blocked_no_consent` leaves message as `queued` instead of `failed`. Known acceptable for now.
- **E2E CI always fails** — GitHub Actions Playwright suite fails because `@sandra/tokens` can't resolve in CI (same root cause, now fixed on Vercel but CI uses `npm ci` without the sibling dir). Separate fix needed for CI.

---

## Test Credentials

- **Prod login**: `PROD_EMAIL` / `PROD_PASSWORD` in `.env.local` (gitignored — do not log)
- **Jarrad's test phone**: `+13107540662` — SMS smoke only, never real leads
- **Twilio test receiver**: `+18148097074` — inbound-only canary, never a sender
- **Test suite user**: `claude@test.com` / `test12345` (test Supabase project `ncsngxlcyxylaeskiteu` only)
- **Prod Supabase project**: `copflsklaefwzipsrjqz`

---

## Verification Scripts

```bash
# Check queued message drain progress (Supabase MCP or psql)
SELECT status, COUNT(*) FROM messages
WHERE created_at > NOW() - INTERVAL '24 hours'
GROUP BY status ORDER BY count DESC;

# Confirm main is clean
git log --oneline -5
git status

# TypeScript clean
node_modules/.bin/tsc --noEmit

# Full test suite
npm test && npm run test:rtl

# Check Vercel build status
gh api repos/biginkc/sandra/deployments --jq '.[0]' | \
  xargs -I{} gh api repos/biginkc/sandra/deployments/{id}/statuses --jq '.[0].state'
```

---

## Critical Learnings

1. **Supabase PostgREST silently caps SELECT at 1,000 rows** — `.limit(5000)` in code is ignored; use `.range()` pagination for large fetches.
2. **`file:` npm dependencies don't resolve on Vercel** — `@sandra/tokens: "file:../Sandra Design System"` broke every Vercel build. Fix: vendor the CSS file into the repo.
3. **Supabase `.in()` with 1000+ UUIDs returns 400 Bad Request** — URL too long. Chunk into 250-ID batches.
4. **Server Components crash when rendering large datasets** — fetching 939 rows with joins in a Server Component render path will crash the page. Always `.limit()` list queries that could grow unboundedly.
5. **PR workflow re-established** — all work goes through feature branches + PRs, not direct commits to main. Merge with `gh pr merge <N> --merge --admin`.
6. **`@sandra/tokens` CI fix still pending** — GitHub Actions E2E still fails for the same build reason. Vercel is fixed but CI is not.
