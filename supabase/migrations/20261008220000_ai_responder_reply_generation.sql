-- 20261008220000_ai_responder_reply_generation.sql
-- "Jev only" mode. ai_responder_configs.reply_generation:
--   'llm' (default, today's behaviour): the legacy Claude responder may draft replies.
--   'off': the legacy generator is never called. Jev still classifies and applies
--          outcomes; where the generator would have run, the conversation is held
--          for a human with reason `needs_reply`.
-- Setting `active=false` is NOT a substitute: it also stops Jev.
--
-- Written only through fn_set_ai_reply_generation (active org OWNER; org resolved
-- from the config row, never caller-supplied). The last change is stamped on the
-- row (who/when) as the audit trail.

begin;

set local lock_timeout = '5s';
set local statement_timeout = '60s';

alter table public.ai_responder_configs
  add column if not exists reply_generation text not null default 'llm',
  add column if not exists reply_generation_changed_by uuid,
  add column if not exists reply_generation_changed_at timestamptz;

do $$
begin
  if not exists (
    select 1 from pg_constraint where conname = 'ai_responder_configs_reply_generation_check'
  ) then
    alter table public.ai_responder_configs
      add constraint ai_responder_configs_reply_generation_check
      check (reply_generation in ('llm', 'off'));
  end if;
end $$;

comment on column public.ai_responder_configs.reply_generation is
  'llm (default) or off (Jev-only: never call the legacy generator; hold the conversation as needs_reply). Owner-only via fn_set_ai_reply_generation.';

create or replace function public.fn_set_ai_reply_generation(
  p_config_id uuid,
  p_mode text
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
  if p_config_id is null or p_mode is null or p_mode not in ('llm', 'off') then
    raise exception 'INVALID_REQUEST' using errcode = '22023';
  end if;

  select org_id into v_org_id
  from public.ai_responder_configs
  where id = p_config_id;
  if not found then
    -- Same error as an authorization failure: ids cannot be probed.
    raise exception 'FORBIDDEN' using errcode = '42501';
  end if;

  if not exists (
    select 1
    from public.memberships m
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
  set reply_generation = p_mode,
      reply_generation_changed_by = v_actor,
      reply_generation_changed_at = statement_timestamp(),
      updated_at = now()
  where id = p_config_id and org_id = v_org_id
  returning * into v_row;
  if not found then
    raise exception 'FORBIDDEN' using errcode = '42501';
  end if;

  return jsonb_build_object('id', v_row.id, 'replyGeneration', v_row.reply_generation);
end;
$$;

revoke all on function public.fn_set_ai_reply_generation(uuid, text)
  from public, anon, authenticated;
grant execute on function public.fn_set_ai_reply_generation(uuid, text)
  to authenticated;

commit;
