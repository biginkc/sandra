-- 075: add 'finalizing' to jobs.status
--
-- Batch skip-trace finalization at 4K rows takes minutes while the sweep
-- cron fires every minute and the provider webhook can land concurrently.
-- On 2026-06-12 four overlapping finalizers each processed the same job
-- (status stayed 'running' the whole time), writing 16,000 job_items on a
-- 4,000-row job and clobbering each other's summaries.
--
-- 'finalizing' is the claim state: finalizeSkipTraceFromBatch flips
-- running→finalizing atomically (UPDATE ... WHERE status='running') so
-- exactly one worker owns result application. Terminal transition to
-- completed/partial/failed is unchanged; a crashed finalizer is rescued
-- by the sweep cron (stale heartbeat → back to 'running').

alter table jobs drop constraint jobs_status_check;
alter table jobs add constraint jobs_status_check check (status = any (array[
  'pending_approval'::text,
  'queued'::text,
  'running'::text,
  'finalizing'::text,
  'completed'::text,
  'failed'::text,
  'partial'::text,
  'canceled'::text,
  'denied'::text
]));
