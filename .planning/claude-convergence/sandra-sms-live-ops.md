# Sandra SMS Live Operations

## Goal

Implement Sandra SMS campaign live-operations fixes:

- Messages/Outbox progress is truthful and current.
- Campaign detail pages show campaign-scoped live send progress.
- Active campaign cadence can be previewed and safely rescheduled.

## Acceptance Gates

- Delivered rows still count as sent/handed-off.
- "Today" uses America/Chicago calendar day boundaries.
- Campaign send/queue counts are campaign-scoped and org-scoped where a campaign org is known.
- UI labels do not imply campaign `completed` means all texts are delivered.
- No live cadence/data write happens without explicit operator confirmation.

## Baseline

- Branch: `codex/messages-live-campaign-stats`
- Baseline: `origin/main` at checkout time.
- Worktree: `/Users/jarradhenry/Sites/BMH apps/Sandra/_codex_worktrees/messages-live-campaign-stats`

## Implementation Evidence

- Added shared outbound SMS metrics helper: `src/lib/messages/message-metrics.ts`.
- Rewired Messages queue stats to use session/RLS client and shared metrics.
- Renamed UI contract from `sentToday` to `sentOutToday`.
- Kept Outbox badge polling live while viewing Inbox.
- Added campaign live operations panel on `/campaigns/[id]`.
- Added bulk-SMS job detail panel using the shared SMS metrics helper when a job carries a campaign id.
- Changed campaign status badge from raw `completed` to queue setup language.
- Changed KPI footer from "Sent to" to "Provider attempted".
- Added cadence preview/apply server actions.
- Added cadence UI that enables apply only after preview and calls `window.confirm` before applying.
- Added SQL RPC migration for preview/apply rescheduling of remaining future queued outbound SMS rows only; the apply RPC also requires `p_operator_confirmed = true`.
- Restricted cadence apply to the server action path: the write RPC is service-role only, while the server action checks explicit confirmation and campaign org membership before calling it.
- Tightened handoff metrics so rows sent to the provider still count after later delivery or failure status updates.
- Changed overdue queue drain wording to `draining now` instead of a misleading `<1m` ETA.

## Manual Review

- Spawned three read-only reviewer agents for metrics/Messages, cadence safety, and campaign/job live ops.
- Fixed valid findings:
  - Cadence SQL no longer skips near-term future queued rows inside the five-minute safety window.
  - Cadence apply can no longer be invoked directly by authenticated clients; it is service-role only behind the server action.
  - Campaign live ops no longer displays false zero KPI-backed fields when `campaign_kpis` fails.
  - Drain ETA no longer reports `<1m` for overdue queues.
  - Handoff/sent-out counts no longer drop rows that later fail after provider handoff.
  - Queue stats failures now return `QUEUE_STATS_FAILED`.

## Verification

- `npm run test -- --reporter=verbose src/lib/messages/message-metrics.test.ts src/app/'(dashboard)'/messages/actions.queue-stats.test.ts src/app/'(dashboard)'/campaigns/actions.cadence.test.ts`: pass, 9 tests.
- `npm run test:rtl -- --reporter=verbose src/app/'(dashboard)'/campaigns/'[id]'/campaign-operations-panel.test.tsx src/app/'(dashboard)'/jobs/'[id]'/job-detail.test.tsx src/app/'(dashboard)'/campaigns/'[id]'/campaign-cadence-control.test.tsx`: pass, 7 tests.
- `npm run typecheck`: pass after restoring worktree dependencies with `npm install`.
- `git diff --check`: pass.
- Scoped secret-pattern scan over the changed code, migration, and ledger: no matches.
- `npm run verify`: pass. This ran `tsc --noEmit`, 118 unit test files / 1307 unit tests, and 50 RTL test files / 473 RTL tests.
- `supabase status`: blocked; Docker daemon is not running, so local database lint/reset was not available in this session.
- `supabase link --project-ref <existing Sandra project ref> --yes`: pass; linked the isolated worktree metadata without applying migrations.
- `supabase db push --dry-run --linked`: pass; dry-run connected to the remote database, applied no changes, and reported it would push only `20260630153000_campaign_cadence_reschedule.sql`.
- Chrome local app smoke: `http://localhost:3017/campaigns/1f981d27-49fc-4eae-b258-ac23641d5691` initially failed without env, then loaded with ignored `.env.local` sourced and redirected to `/login?next=...`; authenticated UI proof was not performed because entering credentials into the browser needs explicit operator authorization.

## Hard Gates / Non-Actions

- Did not apply the new Supabase migration to production.
- Did not mutate production campaign/message rows.
- Did not send SMS, call providers, or change provider configuration.

## Residual Review Notes

- SQL migration still needs normal migration review/apply in the intended environment.
- Browser proof on the real Sandra campaign page is still needed before claiming production acceptance.
