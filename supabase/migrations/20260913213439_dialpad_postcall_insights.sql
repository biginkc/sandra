-- Post-call data only. Never invent call activity or live-coach evidence.
create table public.dialpad_call_insights (
 org_id uuid not null references public.organizations(id),
 provider_call_id text not null check(provider_call_id ~ '^[0-9]+$'),
 call_activity_id uuid not null references public.call_activities(id) on delete cascade,
 transcript_status text not null default 'pending' check(transcript_status in ('pending','available','none')),
 transcript_text text,
 transcript_lines jsonb,
 transcript_event_ms bigint not null default 0,
 summary_status text not null default 'pending' check(summary_status in ('pending','available','none')),
 summary_text text,
 summary_event_ms bigint not null default 0,
 updated_at timestamptz not null default now(),
 primary key(org_id,provider_call_id),
 check(transcript_status <> 'available' or length(transcript_text)>0),
 check(summary_status <> 'available' or length(summary_text)>0)
);
alter table public.dialpad_call_insights enable row level security;
revoke all on public.dialpad_call_insights from public,anon,authenticated;
grant select,insert,update on public.dialpad_call_insights to service_role;
create or replace function public.fn_store_dialpad_insight(
 p_org_id uuid,p_call_id text,p_kind text,p_event_ms bigint,p_text text,p_lines jsonb default null
) returns boolean language plpgsql security invoker set search_path=public,pg_temp as $$
declare v_activity uuid;
begin
 if p_kind not in ('transcript','summary') or p_event_ms<0 or p_text is null or length(p_text)>4000000 then raise exception 'INVALID_INSIGHT'; end if;
 if p_kind='transcript' and (p_lines is null or jsonb_typeof(p_lines)<>'array') then raise exception 'INVALID_INSIGHT'; end if;
 select id into v_activity from public.call_activities where org_id=p_org_id and provider='dialpad' and provider_call_id=p_call_id;
 if v_activity is null then return false; end if;
 insert into public.dialpad_call_insights(org_id,provider_call_id,call_activity_id) values(p_org_id,p_call_id,v_activity) on conflict do nothing;
 if p_kind='transcript' then
  update public.dialpad_call_insights set transcript_status=case when length(btrim(p_text))>0 then 'available' else 'none' end,
   transcript_text=nullif(p_text,''),transcript_lines=p_lines,transcript_event_ms=p_event_ms,updated_at=now()
  where org_id=p_org_id and provider_call_id=p_call_id and transcript_event_ms<=p_event_ms
   and not(transcript_status='available' and length(btrim(p_text))=0);
 else
  update public.dialpad_call_insights set summary_status=case when length(btrim(p_text))>0 then 'available' else 'none' end,
   summary_text=nullif(p_text,''),summary_event_ms=p_event_ms,updated_at=now()
  where org_id=p_org_id and provider_call_id=p_call_id and summary_event_ms<=p_event_ms
   and not(summary_status='available' and length(btrim(p_text))=0);
 end if;
 return true;
end $$;
revoke all on function public.fn_store_dialpad_insight(uuid,text,text,bigint,text,jsonb) from public,anon,authenticated;
grant execute on function public.fn_store_dialpad_insight(uuid,text,text,bigint,text,jsonb) to service_role;
