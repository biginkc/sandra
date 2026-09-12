begin;
create unique index acquisition_tasks_id_org_idx on public.tasks(id,org_id);
create table public.acquisition_appointment_attribution (
  task_id uuid primary key,
  org_id uuid not null references public.organizations(id) on delete cascade,
  accountable_user_id uuid not null references auth.users(id),
  captured_at timestamptz not null default statement_timestamp(),
  source text not null default 'booking_insert' check(source='booking_insert'),
  foreign key(task_id,org_id) references public.tasks(id,org_id) on delete cascade
);
alter table public.acquisition_appointment_attribution enable row level security;
revoke all on public.acquisition_appointment_attribution from public,anon,authenticated,service_role;
create or replace function public.capture_acquisition_appointment_attribution()
returns trigger language plpgsql security definer set search_path='' as $$
begin
  if new.type='appointment' and new.related_property_id is not null
    and exists(select 1 from public.acquisition_org_settings where org_id=new.org_id) then
    insert into public.acquisition_appointment_attribution(task_id,org_id,accountable_user_id)
      values(new.id,new.org_id,new.assignee_id);
  end if;
  return new;
end;
$$;
revoke all on function public.capture_acquisition_appointment_attribution() from public,anon,authenticated,service_role;
create trigger trg_acquisition_appointment_attribution after insert on public.tasks
  for each row execute function public.capture_acquisition_appointment_attribution();

create or replace function public.fn_get_acquisition_kpis(p_org_id uuid,p_member_id uuid,p_start timestamptz,p_end timestamptz)
returns jsonb language plpgsql security definer set search_path='' as $$
declare
  v_attempts bigint;v_reached bigint;v_pending bigint;
  v_samples bigint;v_first_pending bigint;v_seconds double precision;
  v_due bigint;v_held bigint;v_unknown bigint;v_offers bigint;v_stale bigint;
begin
  perform public.my_leads_require_read_scope(p_org_id,p_member_id);
  if p_start is null or p_end is null or not isfinite(p_start) or not isfinite(p_end) or p_end<=p_start then
    raise exception 'INVALID_INPUT' using errcode='22023';
  end if;
  select count(*),count(*) filter(where outcome='reached'),count(*) filter(where outcome is null)
    into v_attempts,v_reached,v_pending from public.acquisition_attempts
    where org_id=p_org_id and actor_user_id=p_member_id and occurred_at>=p_start and occurred_at<p_end;
  select count(*) filter(where first_call_started_at is not null),count(*) filter(where first_call_started_at is null),
    avg(extract(epoch from (first_call_started_at-assigned_at))) filter(where first_call_started_at is not null)
    into v_samples,v_first_pending,v_seconds from public.acquisition_assignment_episodes
    where org_id=p_org_id and assignee_user_id=p_member_id and eligible and episode_kind='live'
      and assigned_at>=p_start and assigned_at<p_end;
  select count(*),count(*) filter(where t.outcome='held') into v_due,v_held
    from public.tasks t join public.acquisition_appointment_attribution a on a.task_id=t.id and a.org_id=t.org_id
    where t.org_id=p_org_id and a.accountable_user_id=p_member_id and t.type='appointment' and t.related_property_id is not null
      and t.status<>'cancelled' and t.outcome is distinct from 'rescheduled' and t.due_at>=p_start and t.due_at<p_end;
  -- Unattributed rows cannot honestly be credited to any rep. Report an org-wide
  -- unavailable count separately, never add them to the rep's denominator.
  select count(*) into v_unknown from public.tasks t
    where t.org_id=p_org_id and t.type='appointment' and t.related_property_id is not null and t.status<>'cancelled' and t.outcome is distinct from 'rescheduled'
      and t.due_at>=p_start and t.due_at<p_end
      and not exists(select 1 from public.acquisition_appointment_attribution a where a.task_id=t.id and a.org_id=t.org_id);
  select count(*) into v_offers from public.acquisition_offers
    where org_id=p_org_id and actor_user_id=p_member_id and sent_at>=p_start and sent_at<p_end;
  select count(*) into v_stale from public.my_leads_queue_rows(p_org_id,p_member_id,statement_timestamp()) where warning_rank>0;
  return jsonb_build_object('attempts',v_attempts,'reached',v_reached,'pendingOutcomes',v_pending,
    'firstCallSamples',v_samples,'firstCallPending',v_first_pending,'firstCallElapsedSeconds',v_seconds,
    'appointmentsDue',v_due,'appointmentsHeld',v_held,'orgAppointmentsUnattributed',v_unknown,
    'offersSent',v_offers,'staleLeads',v_stale);
end;
$$;
revoke all on function public.fn_get_acquisition_kpis(uuid,uuid,timestamptz,timestamptz) from public,anon;
grant execute on function public.fn_get_acquisition_kpis(uuid,uuid,timestamptz,timestamptz) to authenticated;

create or replace function public.fn_get_acquisition_badge(p_org_id uuid)
returns bigint language plpgsql security definer set search_path='' as $$
declare v_count bigint;
begin
  perform public.my_leads_require_read_scope(p_org_id,auth.uid());
  select count(*) into v_count from public.my_leads_queue_rows(p_org_id,auth.uid(),statement_timestamp()) where stage='not_contacted';
  return v_count;
end;
$$;
revoke all on function public.fn_get_acquisition_badge(uuid) from public,anon;
grant execute on function public.fn_get_acquisition_badge(uuid) to authenticated;
commit;
