-- Messages v2 redesign, PR 4: owner switches on the rules panel.
--
-- Two per-org switches PR 3 left reachable only through the whole nine-question engine:
--   nine_identity_reply      -- answer "who is this?" with the approved identity reply
--   nine_confirmed_owner_drip -- start the "Confirmed owner" drip
-- Both default TRUE so nothing changes for any org until an owner turns one off.
--
-- Writes go through fn_set_ai_rule_switch only (active org OWNER, org resolved from the
-- config row). Every change to these switches, nurture_auto_drip, classifier_engine and
-- reply_generation is logged with who/when in ai_rule_switch_events by a trigger, so the
-- existing RPCs (fn_set_nurture_auto_drip, fn_set_ai_reply_generation) stay unchanged.
--
-- Additive. Rollback: supabase/rollbacks/20261016030000_nine_rule_switches.sql
begin;

set local lock_timeout = '5s';
set local statement_timeout = '60s';

alter table public.ai_responder_configs
  add column if not exists nine_identity_reply boolean not null default true,
  add column if not exists nine_confirmed_owner_drip boolean not null default true;

create table if not exists public.ai_rule_switch_events (
  id bigint generated always as identity primary key,
  org_id uuid not null,
  config_id uuid not null,
  switch_name text not null,
  old_value text,
  new_value text,
  changed_by uuid,
  changed_at timestamptz not null default statement_timestamp()
);
create index if not exists ai_rule_switch_events_org_idx
  on public.ai_rule_switch_events (org_id, changed_at desc);

alter table public.ai_rule_switch_events enable row level security;
revoke all on public.ai_rule_switch_events from public, anon, authenticated;
grant select on public.ai_rule_switch_events to authenticated;
drop policy if exists ai_rule_switch_events_owner_read on public.ai_rule_switch_events;
create policy ai_rule_switch_events_owner_read on public.ai_rule_switch_events
  for select to authenticated
  using (exists (
    select 1 from public.memberships m
    where m.user_id = auth.uid() and m.org_id = ai_rule_switch_events.org_id
      and m.role = 'owner' and m.access_status = 'active'
      and m.deletion_prepared_at is null
      and (m.access_expires_at is null or m.access_expires_at > statement_timestamp())
  ));

create or replace function public.fn_log_ai_rule_switch()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
begin
  insert into public.ai_rule_switch_events (org_id, config_id, switch_name, old_value, new_value, changed_by)
  select new.org_id, new.id, s.name, s.old_v, s.new_v, auth.uid()
  from (values
    ('nine_identity_reply', old.nine_identity_reply::text, new.nine_identity_reply::text),
    ('nine_confirmed_owner_drip', old.nine_confirmed_owner_drip::text, new.nine_confirmed_owner_drip::text),
    ('nurture_auto_drip', old.nurture_auto_drip::text, new.nurture_auto_drip::text),
    ('classifier_engine', old.classifier_engine, new.classifier_engine),
    ('reply_generation', old.reply_generation, new.reply_generation)
  ) as s(name, old_v, new_v)
  where s.old_v is distinct from s.new_v;
  return new;
end;
$$;

drop trigger if exists trg_log_ai_rule_switch on public.ai_responder_configs;
create trigger trg_log_ai_rule_switch
  after update on public.ai_responder_configs
  for each row execute function public.fn_log_ai_rule_switch();

-- Owner-only write path for the two nine-question switches and the engine switch.
create or replace function public.fn_set_ai_rule_switch(
  p_config_id uuid,
  p_switch text,
  p_value text
)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_actor uuid := auth.uid();
  v_org_id uuid;
  v_row public.ai_responder_configs%rowtype;
begin
  if v_actor is null then
    raise exception 'AUTHENTICATION_REQUIRED' using errcode = '42501';
  end if;
  if p_config_id is null or p_switch is null or p_value is null
    or (p_switch in ('nine_identity_reply', 'nine_confirmed_owner_drip') and p_value not in ('true', 'false'))
    or (p_switch = 'classifier_engine' and p_value not in ('outcome_v1', 'nine_questions'))
    or p_switch not in ('nine_identity_reply', 'nine_confirmed_owner_drip', 'classifier_engine')
  then
    raise exception 'INVALID_REQUEST' using errcode = '22023';
  end if;

  select org_id into v_org_id from public.ai_responder_configs where id = p_config_id;
  if not found then
    raise exception 'FORBIDDEN' using errcode = '42501';
  end if;

  if not exists (
    select 1 from public.memberships m
    where m.user_id = v_actor
      and m.org_id = v_org_id
      and m.role = 'owner'
      and m.access_status = 'active'
      and m.deletion_prepared_at is null
      and (m.access_expires_at is null or m.access_expires_at > statement_timestamp())
  ) then
    raise exception 'FORBIDDEN' using errcode = '42501';
  end if;

  update public.ai_responder_configs
  set nine_identity_reply = case when p_switch = 'nine_identity_reply' then p_value::boolean else nine_identity_reply end,
      nine_confirmed_owner_drip = case when p_switch = 'nine_confirmed_owner_drip' then p_value::boolean else nine_confirmed_owner_drip end,
      classifier_engine = case when p_switch = 'classifier_engine' then p_value else classifier_engine end,
      updated_at = now()
  where id = p_config_id and org_id = v_org_id
  returning * into v_row;
  if not found then
    raise exception 'FORBIDDEN' using errcode = '42501';
  end if;

  return jsonb_build_object(
    'id', v_row.id,
    'nineIdentityReply', v_row.nine_identity_reply,
    'nineConfirmedOwnerDrip', v_row.nine_confirmed_owner_drip,
    'classifierEngine', v_row.classifier_engine
  );
end;
$$;

revoke all on function public.fn_set_ai_rule_switch(uuid, text, text) from public, anon, authenticated;
grant execute on function public.fn_set_ai_rule_switch(uuid, text, text) to authenticated;
revoke all on function public.fn_log_ai_rule_switch() from public, anon, authenticated;

commit;
