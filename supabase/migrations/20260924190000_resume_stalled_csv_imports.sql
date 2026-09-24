-- A workflow invocation can disappear after its last durable chunk checkpoint
-- (for example, a deployment/runtime interruption). Let an active member
-- reclaim only a CSV import whose worker heartbeat is genuinely stale; the
-- import's row-level ledger makes replay idempotent.
create or replace function public.claim_csv_import_retry(p_job_id uuid)
returns boolean
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_job public.jobs%rowtype;
  v_stale_running boolean;
begin
  select job.* into v_job
  from public.jobs job
  where job.id = p_job_id
  for update;

  v_stale_running := v_job.status = 'running'
    and (v_job.worker_heartbeat_at is null
      or v_job.worker_heartbeat_at < now() - interval '5 minutes');

  if v_job.id is null
    or v_job.type <> 'csv_import'
    or not exists (
      select 1 from public.memberships membership
      where membership.user_id = auth.uid()
        and membership.org_id = v_job.org_id
        and membership.access_status = 'active'
        and membership.deletion_prepared_at is null
        and (membership.access_expires_at is null or membership.access_expires_at > now())
    )
    or not exists (
      select 1 from public.csv_import_job_provenance provenance
      where provenance.job_id = v_job.id
        and provenance.org_id = v_job.org_id
        and provenance.csv_import_id = v_job.related_import_id
    )
    or (v_job.status not in ('failed', 'partial', 'partially_completed') and not v_stale_running)
    or v_job.error_class in ('validation', 'authorization')
    or v_job.retry_count >= v_job.max_retries
  then
    return false;
  end if;

  update public.jobs job
  set status = 'queued', error_class = null, error_message = null,
      completed_at = null, retry_count = job.retry_count + 1,
      worker_heartbeat_at = now()
  where job.id = v_job.id
    and job.org_id = v_job.org_id
    and job.retry_count < job.max_retries;
  return found;
end;
$$;

revoke all on function public.claim_csv_import_retry(uuid) from public, anon;
grant execute on function public.claim_csv_import_retry(uuid) to authenticated;
