begin;

-- Status callbacks are durable receipts. A malformed or temporarily
-- unmatchable receipt must get a bounded retry schedule so a poison row cannot
-- consume every slot in the five-minute sweep forever. Quarantined rows stay
-- visible for operator repair and are never selected automatically.
alter table public.webhook_events
  add column if not exists reconciliation_attempts integer not null default 0,
  add column if not exists reconciliation_next_attempt_at timestamptz default now(),
  add column if not exists reconciliation_quarantined_at timestamptz;

do $$
begin
  if not exists (
    select 1 from pg_constraint
    where conrelid='public.webhook_events'::regclass
      and conname='webhook_events_reconciliation_attempts_check'
  ) then
    alter table public.webhook_events
      add constraint webhook_events_reconciliation_attempts_check
      check (reconciliation_attempts >= 0);
  end if;
end;
$$;

create index if not exists webhook_events_sendillo_reconciliation_due_idx
  on public.webhook_events(provider,reconciliation_next_attempt_at,received_at)
  where processing_status in ('pending','error')
    and reconciliation_quarantined_at is null;

-- Increment retry state atomically in the database. This is called by the
-- service-role sweep after reconcileStoredStatusEvents has recorded the row's
-- error. The exact provider/event/external identity prevents a failed worker
-- from charging a different receipt's retry budget.
create or replace function public.fn_schedule_webhook_event_reconciliation_retry(
  p_provider text,
  p_event_type text,
  p_external_id text,
  p_error_message text,
  p_max_attempts integer default 12
) returns jsonb
language plpgsql
security definer
set search_path=''
as $$
declare
  v_event public.webhook_events%rowtype;
  v_now timestamptz:=statement_timestamp();
  v_attempts integer;
  v_quarantined boolean;
  v_next timestamptz;
  v_message text:=left(nullif(btrim(p_error_message),''),2000);
begin
  if auth.uid() is not null then
    raise exception 'Webhook reconciliation scheduling is service-only' using errcode='42501';
  end if;
  if nullif(btrim(p_provider),'') is null
    or nullif(btrim(p_event_type),'') is null
    or nullif(btrim(p_external_id),'') is null
    or v_message is null
    or p_max_attempts < 1 then
    raise exception 'INVALID_INPUT' using errcode='22023';
  end if;

  select * into v_event
  from public.webhook_events
  where provider=p_provider and event_type=p_event_type and external_id=p_external_id
  for update;
  if not found then
    return jsonb_build_object('ok',false,'matched',false);
  end if;
  if v_event.processing_status='processed' then
    return jsonb_build_object('ok',true,'matched',true,'processed',true,
      'attempts',v_event.reconciliation_attempts);
  end if;
  if v_event.reconciliation_quarantined_at is not null then
    return jsonb_build_object('ok',true,'matched',true,'processed',false,
      'attempts',v_event.reconciliation_attempts,'quarantined',true);
  end if;

  v_attempts:=coalesce(v_event.reconciliation_attempts,0)+1;
  v_quarantined:=v_attempts>=p_max_attempts;
  v_next:=case
    when v_quarantined then null
    when v_attempts=1 then v_now+interval '1 minute'
    when v_attempts<=3 then v_now+interval '5 minutes'
    when v_attempts<=6 then v_now+interval '15 minutes'
    when v_attempts<=10 then v_now+interval '1 hour'
    else v_now+interval '6 hours'
  end;

  update public.webhook_events
  set processing_status='error',
      processed_at=v_now,
      processing_started_at=null,
      error_message=v_message,
      reconciliation_attempts=v_attempts,
      reconciliation_next_attempt_at=v_next,
      reconciliation_quarantined_at=case when v_quarantined then v_now else null end
  where id=v_event.id;

  return jsonb_build_object('ok',true,'matched',true,'processed',false,
    'attempts',v_attempts,'nextAttemptAt',v_next,
    'quarantined',v_quarantined);
end;
$$;
revoke all on function public.fn_schedule_webhook_event_reconciliation_retry(text,text,text,text,integer)
  from public,anon,authenticated;
grant execute on function public.fn_schedule_webhook_event_reconciliation_retry(text,text,text,text,integer)
  to service_role;

comment on function public.fn_schedule_webhook_event_reconciliation_retry(text,text,text,text,integer) is
  'Atomically advances a failed webhook status receipt through bounded backoff and operator-visible quarantine.';

commit;
