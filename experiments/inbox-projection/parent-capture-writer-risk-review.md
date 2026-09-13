# Canonical message writers: capture rollout risks

Read-only source review, 2026-09-13. Source HEAD at report persistence:
`ab1bbca6b4a38bbd63781ed610f44f886e181e8b`.
Paths and lines below are relative to this repository. No database was accessed,
no runtime failure was injected, and no production traffic was examined. Source
presence establishes a possible execution path, not deployed configuration,
frequency, observed failure, or actual provider retry behavior.

## Conclusion

The inspected messaging/message runtime modules contain no explicit `40P01`
(deadlock) or `40001` (serialization) retry handling. Existing provider retry,
webhook redelivery and Workflow step mechanisms do not establish safe database
transaction retries. This is an existing limitation. New capture triggers add
transactional locks/work and therefore another possible source of aborts; this
review does not establish that they cause an existing production failure or
quantify the increase.

The highest-consequence boundary is provider acceptance followed by database
receipt persistence. A database abort there must not replay the provider send.
The Inbox rollout must preserve Outbox behavior because both write the canonical
messages table, even though Outbox UI changes are out of scope.

## Prioritized risks and narrow remedies

1. **High: successful provider send followed by failed receipt persistence.**
   `src/lib/messaging/send.ts:450` invokes the provider, then `:465–469` updates
   the pending message and returns `db_error` on failure. The queued equivalent
   invokes the provider at `:1030`, then updates at `:1035–1058`. No SQLSTATE
   retry exists at either boundary. A capture-trigger abort can leave an accepted
   SMS without its stored external ID/status. Retrying the whole send is unsafe.
   Add bounded retries around only the receipt database transaction for definite
   `40P01`/`40001` aborts, retaining message ID and the same provider response.
   Preserve conditional status transitions and reconcile a zero-row result;
   never overwrite a newer terminal delivery state. A process crash or ambiguous
   database response still needs durable attempt/receipt reconciliation, not a
   provider resend. These are shared-boundary corrections, not an Outbox refactor.

2. **High: queue database errors become normal Workflow results.**
   `queueSmsBatch`, `src/lib/messaging/bulk-queue.ts:473–483`, calls queue-only
   sending; `:497–504` records an error in `state.failed`. Its caller,
   `src/workflows/bulk-sms.ts:388–428`, returns that state normally. Workflow
   retries therefore cannot be assumed to repair a deadlocked queue insert.
   Retry the narrowly failed database insert/transaction on definite aborts,
   preserving the intended recipient/request identity. Do not treat a lookup
   before insert as sufficient protection against ambiguous-response duplicates.

3. **Medium: SQLSTATE information is discarded or write errors are ignored.**
   `src/lib/messaging/status-events.ts:61–72` and
   `src/lib/messaging/inbound-state.ts:58–71` throw generic errors. Queue failure
   marking at `src/lib/messaging/send.ts:1675–1684`, cron deferral at
   `src/app/api/cron/sequence-tick/route.ts:198–204`, and AI metadata stamping at
   `src/lib/ai-responder/dispatch.ts:795–803` ignore returned write errors.
   Preserve structured codes at the database boundary and record exhausted
   retries. Re-read and merge metadata when retrying a read/modify/write unit;
   do not replay an obsolete metadata payload over concurrent changes.

4. **Medium: broad or multistep Inbox mutations are not blanket-retry safe.**
   Unknown matching/creation/restamping span separate writes. A repeated broad
   read marker or dismissal can include new messages that were absent from the
   original request. Retry the aborted transaction with its original captured
   IDs/read boundary, or rebuild under the operation's concurrency contract.
   Do not repeat previously committed contact/property creation as part of a
   generic retry wrapper.

## Source inventory

| Writer | Source evidence | Relevant behavior |
| --- | --- | --- |
| Inbound insert | `src/lib/messaging/inbound.ts:1043–1063`, duplicate handling `:1080–1104`, failure response `:640–655` | Provider/external-ID lookup and duplicate recovery exist; insert failure returns HTTP 500. Actual provider redelivery is unverified. |
| Inbound metadata | `src/lib/messaging/inbound-state.ts:41–71` | Separate read/merge/update; no SQLSTATE-specific retry. |
| Status receipt application | `src/lib/messaging/status-events.ts:61–72`; `src/app/api/webhooks/sendillo/status/route.ts:112–133` | Conditional message update; webhook records error and returns 500. |
| Immediate outbound | `src/lib/messaging/send.ts:368–395`, `:450–469` | Pending insert, external send, separate receipt update. |
| Queued/paused insertion | `src/lib/messaging/send.ts:635–672` | Direct Outbox creation; no SQLSTATE retry. |
| Queued release | `src/lib/messaging/send.ts:909–929`, `:1030–1058` | Queued-to-pending compare-and-set precedes external send; receipt boundary remains separate. Direct Outbox path. |
| Queue maintenance | `src/lib/messaging/send.ts:1202–1217`, `:1675–1684`, `:1695–1713` | Pause/fail/defer updates; direct Outbox paths. |
| Bulk queue workflow | `src/lib/messaging/bulk-queue.ts:473–504`; `src/workflows/bulk-sms.ts:388–428` | Database error may become a recorded recipient failure without throwing the step. Creates Outbox rows. |
| Conversation stamping | `src/lib/messages/threading.ts:183–202`, fallback `:274–288` | RPC or compatibility backfill; fallback can stamp queued SMS too. No concurrency retry. |
| Unknown matching/creation/merge | `src/lib/messages/triage.ts:94`, `:197`, `:321` | Message backfills follow other identity writes; whole-operation replay needs care. |
| Unknown dismissal/restoration | `src/lib/messages/triage.ts:426–455` | Broad raw-sender updates; retries must preserve intended membership. |
| Resolution/restamping | `src/lib/messages/resolve.ts:624–636`; compensation `:432–436` | Restamp excludes queued/paused at `:633`; compensation ignores returned errors. |
| Read markers | `src/app/(dashboard)/leads/actions.ts:2374–2384`, `:2452–2463` | Broad inbound predicates; repeated execution can include newly arrived messages. |
| Queued edit/delete | `src/app/(dashboard)/messages/actions.ts:92–103`, `:143–154` | Status-guarded database operations; explicit Outbox UI actions. |
| Cron recovery | `src/app/api/cron/sequence-tick/route.ts:198–204`, `:260–289` | Deferral and stale pending failure; pending recovery deliberately avoids resending. |
| Campaign queue RPCs | `src/app/(dashboard)/campaigns/actions.ts:644`, `:773`, `:828` | Cadence, pause and resume can mutate Outbox queues. No SQLSTATE-specific retry found. |
| Existing AI metadata | `src/lib/ai-responder/dispatch.ts:795–803` | Post-send metadata update ignores result; existing writer remains in capture coverage, without adding AI features. |

Direct message mutations found in scripts were fixture/rehearsal or explicitly
named smoke scripts, including `scripts/smoke-sendillo-webhook-prod.ts:298` and
`scripts/smoke-ai-responder-happy-prod.ts:110`, with cleanup deletes. The scan
found no additional direct message mutation in non-smoke/non-rehearsal operational
scripts. This does not exclude dynamic SQL, indirect RPC writers, triggers, or
external writers. Those require the separate deployed writer inventory.

## Capture rollout gates

- Inject definite deadlock/serialization aborts at pending/queued insert, queued
  claim, receipt persistence, inbound insertion, status application and canonical
  multirow updates. Confirm bounded retry and visible exhaustion. Do not infer
  this evidence from compilation or provider-error retry tests.
- With an owned fake provider, force the database receipt update to abort after
  provider acceptance. Prove one provider call, eventual correct receipt, and no
  regression of a concurrently recorded terminal delivery status. Separately
  prove recovery after loss of the process/response; a local retry alone is not
  durable recovery.
- Compare Outbox edit/delete, release, pause/resume/cadence, queue drain and stale
  pending recovery with capture enabled. Preserve status guards, scheduling and
  the existing no-resend treatment of ambiguous accepted attempts.
- Exercise concurrent canonical multirow writers and measure transaction latency,
  lock waits, abort rate, retry count/exhaustion and queue lag at representative
  volume. Agree numerical gates before a production pilot; none are invented or
  claimed measured by this source review.
- Verify live writer/schema coverage and source-transaction rollback of capture
  state. Keep capture disablement and accepted-job/receipt recovery explicit in
  the release procedure; do not make a UI rollback imply cancellation or replay
  of an accepted SMS.

No new provider retry policy, sequence feature, or broad Outbox redesign is
recommended. This document records narrow shared-write prerequisites for safely
introducing database capture.
