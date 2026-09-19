# Sequence recovery rollout prerequisites

This is preparation only. No production migration, deployment, campaign activation or real SMS is authorized or executed by this task. The candidate remains unready while required tests or review findings are open.

## Before release

1. Pin the independently reviewed application commit and migration hashes. All mandatory disposable database, browser, mutation and repository checks must pass on that candidate. Record production engine/isolation/provider and deployed cron cadence via read-only inspection; unknown values prevent equivalence claims.
2. Inventory legacy claims at each active/paused enrollment's current step. Preserve `unknown` for legacy rows: neither `run_at`, `skipped_reason=provider_failed`, nor a missing external ID proves that no SMS was accepted. Report expected reconciliation volume before choosing a release window.
3. Quiesce sequence cron execution and drain already-running old workers. Old workers lack final authorization and provider-intent recording; a rolling overlap cannot meet the new boundary contract. Record how quiescence was established and when the final old worker exited.
4. Apply the reviewed migration through the repository's established migration workflow before activating new application code. Confirm the primary key is intact, the intended partial enrollment/step unique index exists, the old unconditional pair index is absent, and effective RPC grants match the expected roles. Measure index/table locking against representative data before production.
5. Start only the reviewed new application workers. Verify no old writer remains. Keep real-provider canary allowance zero until separate owned-recipient and spending authorization is recorded.

## Read-only legacy inventory

```sql
select e.status, e.pause_reason, r.skipped_reason,
       (r.message_id is not null) as has_message_link,
       (r.run_at is null) as lacks_run_receipt,
       count(*) as current_step_claims
from public.sequence_enrollments e
join public.sequence_steps s
  on s.sequence_id = e.sequence_id and s.step_index = e.current_step_index
join public.sequence_step_runs r
  on r.enrollment_id = e.id and r.step_id = s.id
where e.status in ('active', 'paused')
group by 1,2,3,4,5
order by 1,2,3,4,5;
```

Do not print recipient data, provider credentials, message bodies or generated local keys in release logs.

## Rollback constraints

Pause processing first. Preserve new audit columns and historical attempts; do not delete rows to recreate the former full unique index. Once explicit retries retain multiple rows per enrollment/step, that former index cannot be restored without discarding audit history. A schema downgrade is therefore not an ordinary rollback. Keep a tested compatible application artifact and review its behavior against the retained schema before resuming any workers. Old code lacks the new send-boundary guarantee.

## Operator behavior

Unknown delivery is an explicit reconciliation state and must never offer blind resend. Cancel is the safe terminal action. A definitive no-send can be explicitly retried with retained audit evidence. Archiving/deactivating a sequence currently stops new enrollments while existing enrollments continue; cancel/pause is the stop control. Multiple sequences targeting one handset remain characterization-only behavior, not a new cooldown policy.
