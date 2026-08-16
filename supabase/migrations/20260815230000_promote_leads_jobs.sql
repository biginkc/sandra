-- Durable, replay-safe Prospects -> Leads promotion.
--
-- This migration deliberately treats ONLY properties.is_dnc_locked as the
-- permanent DNC boundary. Channel-specific suppression and dispositions are
-- separate concepts and do not prevent an otherwise eligible prospect from
-- entering the Leads pipeline.

begin;

alter table public.jobs drop constraint if exists jobs_type_check;
alter table public.jobs add constraint jobs_type_check check (type = any (array[
  'csv_import'::text,
  'csv_update'::text,
  'cass_dsf2_ncoa'::text,
  'cass_refresh'::text,
  'ncoa_refresh'::text,
  'agent_lookup'::text,
  'regrid_lookup'::text,
  'skip_trace'::text,
  'direct_mail_campaign'::text,
  'bulk_sms'::text,
  'data_export'::text,
  'property_merge'::text,
  'sweeper'::text,
  'send_sms'::text,
  'send_email'::text,
  'promote_leads'::text
]));

alter table public.jobs
  add column if not exists idempotency_key uuid;

alter table public.jobs
  add column if not exists workflow_claim_token uuid;

drop index if exists public.idx_jobs_org_type_idempotency_key;
create unique index idx_jobs_org_type_idempotency_key
  on public.jobs (org_id, type, idempotency_key)
  where idempotency_key is not null;

alter table public.job_items
  add column if not exists item_key text;

-- Promotion history must survive property removal. The original schema used
-- ON DELETE CASCADE, which could erase a durable outcome before the worker
-- recorded it.
alter table public.job_items
  drop constraint if exists job_items_property_id_fkey;
alter table public.job_items
  add constraint job_items_property_id_fkey
  foreign key (property_id) references public.properties(id) on delete set null;

drop index if exists public.idx_job_items_job_item_key;
create unique index idx_job_items_job_item_key
  on public.job_items (job_id, item_key)
  where item_key is not null;

drop index if exists public.idx_promote_leads_active_child;
create unique index idx_promote_leads_active_child
  on public.jobs (parent_job_id)
  where type = 'promote_leads'
    and parent_job_id is not null
    and status in ('queued', 'running');

create or replace function public.promote_leads_recompute_job(p_job uuid)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_counts record;
  v_status text;
  v_summary jsonb;
begin
  select
    count(*)::integer as total,
    count(*) filter (where ji.status <> 'pending')::integer as processed,
    count(*) filter (where ji.output_payload->>'outcome' = 'promoted')::integer as promoted,
    count(*) filter (where ji.output_payload->>'outcome' = 'already_lead')::integer as already_lead,
    count(*) filter (where ji.output_payload->>'outcome' = 'dnc_locked')::integer as dnc_locked,
    count(*) filter (where ji.output_payload->>'outcome' = 'missing')::integer as missing,
    count(*) filter (where ji.status = 'error')::integer as failed,
    count(*) filter (where ji.status = 'pending')::integer as pending
  into v_counts
  from public.job_items ji
  where ji.job_id = p_job;

  v_summary := jsonb_build_object(
    'promoted', v_counts.promoted,
    'already_lead', v_counts.already_lead,
    'dnc_locked', v_counts.dnc_locked,
    'missing', v_counts.missing,
    'failed', v_counts.failed,
    'pending', v_counts.pending
  );

  if v_counts.pending > 0 then
    select j.status into v_status from public.jobs j where j.id = p_job;
  elsif v_counts.failed = 0 then
    v_status := 'completed';
  elsif v_counts.processed > v_counts.failed then
    v_status := 'partially_completed';
  else
    v_status := 'failed';
  end if;

  update public.jobs j
  set total_items = v_counts.total,
      processed_items = v_counts.processed,
      succeeded_items = v_counts.promoted,
      failed_items = v_counts.failed,
      result_summary = v_summary,
      status = v_status,
      worker_heartbeat_at = now(),
      completed_at = case when v_counts.pending = 0 then coalesce(j.completed_at, now()) else null end
  where j.id = p_job
    and j.type = 'promote_leads';

  return v_summary || jsonb_build_object('status', v_status);
end;
$$;

-- A property can be deleted after a failure checkpoint has marked its item
-- retryable. Repair that audience atomically on the delete side so the item
-- cannot advertise a retry that no longer has a property to process.
create or replace function public.preserve_promote_leads_item_on_property_delete()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_job uuid;
begin
  for v_job in
    select ji.job_id
    from public.job_items ji
    join public.jobs j on j.id = ji.job_id and j.type = 'promote_leads'
    where ji.property_id = old.id
      and (
        ji.status = 'pending'
        or (ji.status = 'error' and coalesce((ji.output_payload->>'retryable')::boolean, false))
      )
    for update of ji
  loop
    update public.job_items ji
    set status = 'skipped',
        error_class = null,
        error_message = null,
        output_payload = jsonb_build_object('outcome', 'missing', 'retryable', false, 'reason', 'property_removed'),
        processed_at = now()
    where ji.job_id = v_job
      and ji.property_id = old.id
      and (
        ji.status = 'pending'
        or (ji.status = 'error' and coalesce((ji.output_payload->>'retryable')::boolean, false))
      );
    perform public.promote_leads_recompute_job(v_job);
  end loop;
  return old;
end;
$$;

drop trigger if exists preserve_promote_leads_item_on_property_delete on public.properties;
create trigger preserve_promote_leads_item_on_property_delete
before delete on public.properties
for each row execute function public.preserve_promote_leads_item_on_property_delete();

create or replace function public.create_promote_leads_job(
  p_org uuid,
  p_property_ids uuid[],
  p_idempotency_key uuid
)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_actor uuid := auth.uid();
  v_property_ids uuid[];
  v_available integer;
  v_inserted integer;
  v_job_id uuid;
  v_existing public.jobs%rowtype;
  v_summary jsonb;
  v_duplicate boolean := false;
begin
  if v_actor is null then
    raise exception 'create_promote_leads_job: no authenticated caller' using errcode = '28000';
  end if;
  if p_idempotency_key is null then
    raise exception 'create_promote_leads_job: idempotency key is required' using errcode = '22023';
  end if;

  select coalesce(array_agg(distinct property_id order by property_id), '{}'::uuid[])
  into v_property_ids
  from unnest(coalesce(p_property_ids, '{}'::uuid[])) as requested(property_id)
  where property_id is not null;

  if cardinality(v_property_ids) = 0 then
    raise exception 'create_promote_leads_job: at least one property is required' using errcode = '22023';
  end if;

  perform 1
  from public.memberships m
  where m.user_id = v_actor
    and m.org_id = p_org
    and m.access_status = 'active'
    and m.deletion_prepared_at is null
    and (m.access_expires_at is null or m.access_expires_at > now())
  for share of m;
  if not found then
    raise exception 'create_promote_leads_job: caller has no active membership in org %', p_org using errcode = 'P0001';
  end if;

  select j.* into v_existing
  from public.jobs j
  where j.org_id = p_org
    and j.type = 'promote_leads'
    and j.idempotency_key = p_idempotency_key;
  if found then
    if coalesce(v_existing.input_params->'property_ids', '[]'::jsonb) is distinct from to_jsonb(v_property_ids) then
      raise exception 'create_promote_leads_job: idempotency key reuse with different properties' using errcode = 'P0001';
    end if;
    return jsonb_build_object(
      'job_id', v_existing.id,
      'duplicate', true,
      'status', v_existing.status,
      'counts', coalesce(v_existing.result_summary, '{}'::jsonb)
    );
  end if;

  perform 1
  from public.properties p
  where p.id = any(v_property_ids)
    and p.org_id = p_org
    and p.deleted_at is null
  order by p.id
  for share of p;
  get diagnostics v_available = row_count;
  if v_available <> cardinality(v_property_ids) then
    raise exception 'create_promote_leads_job: one or more properties are unavailable' using errcode = 'P0001';
  end if;

  insert into public.jobs (
    org_id, created_by, type, status, total_items, provider,
    input_params, title, description, idempotency_key
  ) values (
    p_org, v_actor, 'promote_leads', 'queued', cardinality(v_property_ids), 'internal',
    jsonb_build_object('property_ids', to_jsonb(v_property_ids), 'requested_count', cardinality(v_property_ids)),
    format('Promote %s prospect%s to Leads', cardinality(v_property_ids), case when cardinality(v_property_ids) = 1 then '' else 's' end),
    'Background promotion requested from Prospects.',
    p_idempotency_key
  )
  on conflict do nothing
  returning id into v_job_id;

  if v_job_id is null then
    select j.* into v_existing
    from public.jobs j
    where j.org_id = p_org
      and j.type = 'promote_leads'
      and j.idempotency_key = p_idempotency_key;
    if not found then
      raise exception 'create_promote_leads_job: concurrent request could not be resolved' using errcode = '40001';
    end if;
    if coalesce(v_existing.input_params->'property_ids', '[]'::jsonb) is distinct from to_jsonb(v_property_ids) then
      raise exception 'create_promote_leads_job: idempotency key reuse with different properties' using errcode = 'P0001';
    end if;
    return jsonb_build_object(
      'job_id', v_existing.id,
      'duplicate', true,
      'status', v_existing.status,
      'counts', coalesce(v_existing.result_summary, '{}'::jsonb)
    );
  end if;

  insert into public.job_items (
    job_id, property_id, item_key, status, input_payload, output_payload, processed_at
  )
  select
    v_job_id,
    p.id,
    p.id::text,
    case when p.is_dnc_locked or p.status <> 'prospect' then 'skipped' else 'pending' end,
    jsonb_build_object('status_at_request', p.status, 'is_dnc_locked_at_request', p.is_dnc_locked),
    case
      when p.is_dnc_locked then jsonb_build_object('outcome', 'dnc_locked', 'retryable', false)
      when p.status <> 'prospect' then jsonb_build_object('outcome', 'already_lead', 'retryable', false)
      else null
    end,
    case when p.is_dnc_locked or p.status <> 'prospect' then now() else null end
  from public.properties p
  where p.id = any(v_property_ids)
    and p.org_id = p_org
    and p.deleted_at is null;
  get diagnostics v_inserted = row_count;
  if v_inserted <> cardinality(v_property_ids) then
    raise exception 'create_promote_leads_job: audience changed before durable item creation' using errcode = '40001';
  end if;

  v_summary := public.promote_leads_recompute_job(v_job_id);
  select j.status into v_existing.status from public.jobs j where j.id = v_job_id;

  return jsonb_build_object(
    'job_id', v_job_id,
    'duplicate', v_duplicate,
    'status', v_existing.status,
    'counts', v_summary
  );
end;
$$;

create or replace function public.process_promote_leads_item(
  p_job uuid,
  p_item_key text
)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_item record;
  v_job public.jobs%rowtype;
  v_property public.properties%rowtype;
  v_outcome text;
  v_summary jsonb;
begin
  if auth.role() <> 'service_role' then
    raise exception 'process_promote_leads_item: service role required' using errcode = '42501';
  end if;

  select ji.id as item_id, ji.property_id, ji.status as item_status, ji.output_payload
  into v_item
  from public.job_items ji
  where ji.job_id = p_job
    and ji.item_key = p_item_key
  for update of ji;
  if not found then
    raise exception 'process_promote_leads_item: job item not found' using errcode = 'P0002';
  end if;

  select j.* into v_job
  from public.jobs j
  where j.id = p_job
    and j.type = 'promote_leads';
  if not found then
    raise exception 'process_promote_leads_item: promotion job not found' using errcode = 'P0002';
  end if;

  if v_item.item_status <> 'pending' then
    return coalesce(v_item.output_payload, '{}'::jsonb) || jsonb_build_object('duplicate', true);
  end if;
  if v_job.status not in ('queued', 'running') then
    raise exception 'process_promote_leads_item: job is not runnable' using errcode = 'P0001';
  end if;

  perform 1
  from public.memberships m
  where m.user_id = v_job.created_by
    and m.org_id = v_job.org_id
    and m.access_status = 'active'
    and m.deletion_prepared_at is null
    and (m.access_expires_at is null or m.access_expires_at > now())
  for share of m;
  if not found then
    update public.job_items
    set status = 'error',
        error_class = 'authorization',
        error_message = 'Promotion requester no longer has active organization access.',
        output_payload = jsonb_build_object('outcome', 'failed', 'retryable', false, 'reason', 'membership_inactive'),
        processed_at = now()
    where id = v_item.item_id;
    v_summary := public.promote_leads_recompute_job(p_job);
    return jsonb_build_object('outcome', 'failed', 'reason', 'membership_inactive', 'counts', v_summary);
  end if;

  if v_item.property_id is not null then
    select p.* into v_property
    from public.properties p
    where p.id = v_item.property_id
      and p.org_id = v_job.org_id
      and p.deleted_at is null
    for update of p;
  end if;

  if not found or v_item.property_id is null then
    v_outcome := 'missing';
    update public.job_items
    set status = 'skipped',
        output_payload = jsonb_build_object('outcome', v_outcome, 'retryable', false),
        processed_at = now(), error_message = null, error_class = null
    where id = v_item.item_id;
  elsif v_property.is_dnc_locked then
    v_outcome := 'dnc_locked';
    update public.job_items
    set status = 'skipped',
        output_payload = jsonb_build_object('outcome', v_outcome, 'retryable', false),
        processed_at = now(), error_message = null, error_class = null
    where id = v_item.item_id;
  elsif v_property.status <> 'prospect' then
    v_outcome := 'already_lead';
    update public.job_items
    set status = 'skipped',
        output_payload = jsonb_build_object('outcome', v_outcome, 'retryable', false),
        processed_at = now(), error_message = null, error_class = null
    where id = v_item.item_id;
  else
    -- The property row remains locked from the authoritative recheck through
    -- this guarded write, so a concurrent permanent-DNC ratchet cannot slip
    -- between eligibility and promotion.
    update public.properties p
    set status = 'new_lead',
        qualified_at = now(),
        qualified_by = v_job.created_by::text,
        updated_at = now()
    where p.id = v_property.id
      and p.org_id = v_job.org_id
      and p.status = 'prospect'
      and p.is_dnc_locked = false;

    if not found then
      raise exception 'process_promote_leads_item: guarded promotion write lost ownership' using errcode = '40001';
    end if;
    v_outcome := 'promoted';
    update public.job_items
    set status = 'success',
        output_payload = jsonb_build_object('outcome', v_outcome, 'retryable', false),
        processed_at = now(), error_message = null, error_class = null
    where id = v_item.item_id;
  end if;

  v_summary := public.promote_leads_recompute_job(p_job);
  return jsonb_build_object('outcome', v_outcome, 'counts', v_summary);
end;
$$;

create or replace function public.fail_promote_leads_item(
  p_job uuid,
  p_item_key text,
  p_error text
)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_summary jsonb;
begin
  if auth.role() <> 'service_role' then
    raise exception 'fail_promote_leads_item: service role required' using errcode = '42501';
  end if;
  update public.job_items ji
  set status = 'skipped', error_class = null, error_message = null,
      output_payload = jsonb_build_object('outcome', 'missing', 'retryable', false), processed_at = now()
  from public.jobs j
  where ji.job_id = p_job and ji.item_key = p_item_key and ji.status = 'pending'
    and ji.property_id is null
    and j.id = ji.job_id and j.type = 'promote_leads';
  update public.job_items ji
  set status = 'error', error_class = 'database', error_message = left(coalesce(p_error, 'Unknown promotion failure'), 1000),
      output_payload = jsonb_build_object('outcome', 'failed', 'retryable', true), processed_at = now()
  from public.jobs j
  where ji.job_id = p_job and ji.item_key = p_item_key and ji.status = 'pending'
    and ji.property_id is not null
    and j.id = ji.job_id and j.type = 'promote_leads';
  v_summary := public.promote_leads_recompute_job(p_job);
  return v_summary;
end;
$$;

create or replace function public.fail_promote_leads_workflow_start(
  p_job uuid,
  p_error text
)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_summary jsonb;
  v_changed integer;
  v_missing_changed integer;
  v_job_status text;
begin
  if auth.role() <> 'service_role' then
    raise exception 'fail_promote_leads_workflow_start: service role required' using errcode = '42501';
  end if;
  select j.status
  into v_job_status
  from public.jobs j
  where j.id = p_job and j.type = 'promote_leads'
  for update of j;
  if not found then
    return '{}'::jsonb;
  end if;
  if v_job_status <> 'queued' then
    select coalesce(j.result_summary, '{}'::jsonb) || jsonb_build_object('status', j.status)
    into v_summary
    from public.jobs j
    where j.id = p_job and j.type = 'promote_leads';
    return coalesce(v_summary, '{}'::jsonb);
  end if;

  update public.job_items
  set status = 'skipped', error_class = null, error_message = null,
      output_payload = jsonb_build_object('outcome', 'missing', 'retryable', false, 'reason', 'property_removed'), processed_at = now()
  where job_id = p_job and status = 'pending' and property_id is null;
  get diagnostics v_missing_changed = row_count;

  update public.job_items
  set status = 'error', error_class = 'database', error_message = left(coalesce(p_error, 'Workflow could not start'), 1000),
      output_payload = jsonb_build_object('outcome', 'failed', 'retryable', true, 'reason', 'workflow_start_failed'), processed_at = now()
  where job_id = p_job and status = 'pending' and property_id is not null;
  get diagnostics v_changed = row_count;
  if v_changed + v_missing_changed = 0 then
    select coalesce(j.result_summary, '{}'::jsonb) || jsonb_build_object('status', j.status)
    into v_summary
    from public.jobs j
    where j.id = p_job and j.type = 'promote_leads';
    return coalesce(v_summary, '{}'::jsonb);
  end if;
  v_summary := public.promote_leads_recompute_job(p_job);
  update public.jobs
  set error_class = 'database', error_message = left(coalesce(p_error, 'Workflow could not start'), 1000)
  where id = p_job and type = 'promote_leads' and status = 'failed';
  return v_summary;
end;
$$;

create or replace function public.fail_promote_leads_workflow(
  p_job uuid,
  p_claim_token uuid,
  p_error text
)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_job public.jobs%rowtype;
  v_summary jsonb;
begin
  if auth.role() <> 'service_role' then
    raise exception 'fail_promote_leads_workflow: service role required' using errcode = '42501';
  end if;
  if p_claim_token is null then
    raise exception 'fail_promote_leads_workflow: claim token is required' using errcode = '22023';
  end if;

  select j.* into v_job
  from public.jobs j
  where j.id = p_job and j.type = 'promote_leads'
  for update of j;
  if not found then
    return jsonb_build_object('status', 'missing', 'checkpointed', false);
  end if;
  if v_job.status not in ('queued', 'running') then
    return coalesce(v_job.result_summary, '{}'::jsonb)
      || jsonb_build_object('status', v_job.status, 'checkpointed', false);
  end if;
  if v_job.workflow_claim_token is not null
     and v_job.workflow_claim_token is distinct from p_claim_token then
    return coalesce(v_job.result_summary, '{}'::jsonb)
      || jsonb_build_object('status', v_job.status, 'checkpointed', false, 'claim_lost', true);
  end if;

  update public.jobs
  set workflow_claim_token = p_claim_token
  where id = p_job and type = 'promote_leads';

  update public.job_items
  set status = 'skipped',
      error_class = null,
      error_message = null,
      output_payload = jsonb_build_object('outcome', 'missing', 'retryable', false, 'reason', 'property_removed'),
      processed_at = now()
  where job_id = p_job and status = 'pending' and property_id is null;

  update public.job_items
  set status = 'error',
      error_class = 'database',
      error_message = left(coalesce(p_error, 'Promotion workflow failed'), 1000),
      output_payload = jsonb_build_object('outcome', 'failed', 'retryable', true, 'reason', 'workflow_failed'),
      processed_at = now()
  where job_id = p_job and status = 'pending' and property_id is not null;

  v_summary := public.promote_leads_recompute_job(p_job);
  update public.jobs
  set error_class = 'database', error_message = left(coalesce(p_error, 'Promotion workflow failed'), 1000)
  where id = p_job
    and type = 'promote_leads'
    and workflow_claim_token = p_claim_token
    and status in ('failed', 'partially_completed');
  return v_summary || jsonb_build_object('checkpointed', true);
end;
$$;

create or replace function public.retry_promote_leads_job(
  p_parent_job uuid,
  p_idempotency_key uuid
)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_actor uuid := auth.uid();
  v_parent public.jobs%rowtype;
  v_existing public.jobs%rowtype;
  v_property_ids uuid[];
  v_job_id uuid;
  v_summary jsonb;
begin
  if v_actor is null then
    raise exception 'retry_promote_leads_job: no authenticated caller' using errcode = '28000';
  end if;
  if p_idempotency_key is null then
    raise exception 'retry_promote_leads_job: idempotency key is required' using errcode = '22023';
  end if;

  select j.* into v_parent
  from public.jobs j
  where j.id = p_parent_job and j.type = 'promote_leads'
  for share of j;
  if not found then
    raise exception 'retry_promote_leads_job: parent job not found' using errcode = 'P0002';
  end if;

  perform 1 from public.memberships m
  where m.user_id = v_actor and m.org_id = v_parent.org_id
    and m.access_status = 'active' and m.deletion_prepared_at is null
    and (m.access_expires_at is null or m.access_expires_at > now())
  for share of m;
  if not found then
    raise exception 'retry_promote_leads_job: caller has no active membership in org %', v_parent.org_id using errcode = 'P0001';
  end if;

  select j.* into v_existing from public.jobs j
  where j.org_id = v_parent.org_id and j.type = 'promote_leads' and j.idempotency_key = p_idempotency_key;
  if found then
    if v_existing.parent_job_id is distinct from p_parent_job then
      raise exception 'retry_promote_leads_job: idempotency key reuse with different parent' using errcode = 'P0001';
    end if;
    return jsonb_build_object('job_id', v_existing.id, 'duplicate', true, 'status', v_existing.status, 'counts', coalesce(v_existing.result_summary, '{}'::jsonb));
  end if;

  select j.* into v_existing from public.jobs j
  where j.parent_job_id = p_parent_job and j.type = 'promote_leads' and j.status in ('queued', 'running');
  if found then
    return jsonb_build_object('job_id', v_existing.id, 'duplicate', true, 'status', v_existing.status, 'counts', coalesce(v_existing.result_summary, '{}'::jsonb));
  end if;

  select coalesce(array_agg(ji.property_id order by ji.item_key), '{}'::uuid[])
  into v_property_ids
  from public.job_items ji
  where ji.job_id = p_parent_job and ji.status = 'error'
    and coalesce((ji.output_payload->>'retryable')::boolean, false)
    and ji.property_id is not null;

  if cardinality(v_property_ids) = 0 then
    raise exception 'retry_promote_leads_job: no retryable promotion items' using errcode = 'P0001';
  end if;

  insert into public.jobs (
    org_id, created_by, type, status, total_items, provider, parent_job_id,
    input_params, title, description, idempotency_key
  ) values (
    v_parent.org_id, v_actor, 'promote_leads', 'queued', cardinality(v_property_ids), 'internal', p_parent_job,
    jsonb_build_object('property_ids', to_jsonb(v_property_ids), 'requested_count', cardinality(v_property_ids), 'retry_of', p_parent_job),
    format('Retry promotion of %s prospect%s', cardinality(v_property_ids), case when cardinality(v_property_ids) = 1 then '' else 's' end),
    format('Retry of promotion job %s.', left(p_parent_job::text, 8)),
    p_idempotency_key
  ) on conflict do nothing returning id into v_job_id;

  if v_job_id is null then
    select j.* into v_existing from public.jobs j
    where j.org_id = v_parent.org_id and j.type = 'promote_leads'
      and (j.idempotency_key = p_idempotency_key or (j.parent_job_id = p_parent_job and j.status in ('queued', 'running')))
    order by (j.idempotency_key = p_idempotency_key) desc limit 1;
    if not found then
      raise exception 'retry_promote_leads_job: concurrent retry could not be resolved' using errcode = '40001';
    end if;
    if v_existing.parent_job_id is distinct from p_parent_job then
      raise exception 'retry_promote_leads_job: idempotency key reuse with different parent' using errcode = 'P0001';
    end if;
    return jsonb_build_object('job_id', v_existing.id, 'duplicate', true, 'status', v_existing.status, 'counts', coalesce(v_existing.result_summary, '{}'::jsonb));
  end if;

  insert into public.job_items (job_id, property_id, item_key, status, input_payload, output_payload, processed_at)
  select v_job_id, p.id, requested.property_id::text,
    case when p.id is null or p.is_dnc_locked or p.status <> 'prospect' then 'skipped' else 'pending' end,
    jsonb_build_object('retry_of', p_parent_job, 'original_property_id', requested.property_id),
    case
      when p.id is null then jsonb_build_object('outcome', 'missing', 'retryable', false)
      when p.is_dnc_locked then jsonb_build_object('outcome', 'dnc_locked', 'retryable', false)
      when p.status <> 'prospect' then jsonb_build_object('outcome', 'already_lead', 'retryable', false)
      else null
    end,
    case when p.id is null or p.is_dnc_locked or p.status <> 'prospect' then now() else null end
  from unnest(v_property_ids) as requested(property_id)
  left join public.properties p on p.id = requested.property_id and p.org_id = v_parent.org_id and p.deleted_at is null;

  v_summary := public.promote_leads_recompute_job(v_job_id);
  select j.status into v_existing.status from public.jobs j where j.id = v_job_id;
  return jsonb_build_object('job_id', v_job_id, 'duplicate', false, 'status', v_existing.status, 'counts', v_summary);
end;
$$;

revoke all on function public.promote_leads_recompute_job(uuid) from public, anon, authenticated;
revoke all on function public.preserve_promote_leads_item_on_property_delete() from public, anon, authenticated;
revoke all on function public.create_promote_leads_job(uuid, uuid[], uuid) from public, anon;
revoke all on function public.process_promote_leads_item(uuid, text) from public, anon, authenticated;
revoke all on function public.fail_promote_leads_item(uuid, text, text) from public, anon, authenticated;
revoke all on function public.fail_promote_leads_workflow_start(uuid, text) from public, anon, authenticated;
revoke all on function public.fail_promote_leads_workflow(uuid, uuid, text) from public, anon, authenticated;
revoke all on function public.retry_promote_leads_job(uuid, uuid) from public, anon;

grant execute on function public.create_promote_leads_job(uuid, uuid[], uuid) to authenticated;
grant execute on function public.retry_promote_leads_job(uuid, uuid) to authenticated;
grant execute on function public.promote_leads_recompute_job(uuid) to service_role;
grant execute on function public.process_promote_leads_item(uuid, text) to service_role;
grant execute on function public.fail_promote_leads_item(uuid, text, text) to service_role;
grant execute on function public.fail_promote_leads_workflow_start(uuid, text) to service_role;
grant execute on function public.fail_promote_leads_workflow(uuid, uuid, text) to service_role;

comment on function public.create_promote_leads_job(uuid, uuid[], uuid) is
  'Creates one transactionally complete, replay-safe Prospects-to-Leads job for the authenticated active org member. Unknown, deleted, or mixed-tenant IDs fail closed.';
comment on function public.process_promote_leads_item(uuid, text) is
  'Service-role-only atomic item transition. Rechecks job org, requester membership, property existence/status, and ONLY properties.is_dnc_locked immediately before prospect -> new_lead.';

commit;
