-- Rollback for 20261009040000_auto_reply_templates_wrong_number_hostile.
-- Restores the Phase 4 allow-list (nurture, not_interested only). Mappings for
-- wrong_number / hostile cannot exist under the restored constraint, so they
-- are deleted (the feature that reads them is rolled back with the code).
begin;

set local lock_timeout = '5s';
set local statement_timeout = '60s';

delete from public.auto_reply_templates where outcome in ('wrong_number', 'hostile');

alter table public.auto_reply_templates drop constraint if exists auto_reply_templates_outcome_check;
alter table public.auto_reply_templates
  add constraint auto_reply_templates_outcome_check
  check (outcome in ('nurture', 'not_interested'));

comment on table public.auto_reply_templates is
  'Which approved template answers a Jev outcome (optionally narrowed by reply_intent). Writable only via fn_set_auto_reply_template (owner). A mapping to a template that is not approved is inert.';

create or replace function public.fn_set_auto_reply_template(
  p_org_id uuid,
  p_outcome text,
  p_reply_intent text,
  p_template_id uuid,
  p_priority integer default 100,
  p_active boolean default true,
  p_mapping_id uuid default null,
  p_delete boolean default false
)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_actor uuid := auth.uid();
  v_id uuid;
begin
  if v_actor is null then
    raise exception 'AUTHENTICATION_REQUIRED' using errcode = '42501';
  end if;
  if p_org_id is null then
    raise exception 'INVALID_REQUEST' using errcode = '22023';
  end if;

  if not exists (
    select 1 from public.memberships m
    where m.user_id = v_actor
      and m.org_id = p_org_id
      and m.role = 'owner'
      and m.access_status = 'active'
      and m.deletion_prepared_at is null
      and (m.access_expires_at is null or m.access_expires_at > statement_timestamp())
  ) then
    raise exception 'FORBIDDEN' using errcode = '42501';
  end if;

  if p_delete then
    if p_mapping_id is null then
      raise exception 'INVALID_REQUEST' using errcode = '22023';
    end if;
    delete from public.auto_reply_templates
    where id = p_mapping_id and org_id = p_org_id
    returning id into v_id;
    if v_id is null then
      raise exception 'MAPPING_NOT_FOUND' using errcode = 'P0002';
    end if;
    return jsonb_build_object('ok', true, 'mappingId', v_id, 'deleted', true);
  end if;

  if p_outcome is null or p_outcome not in ('nurture', 'not_interested') then
    raise exception 'INVALID_OUTCOME' using errcode = '22023';
  end if;
  if p_reply_intent is not null and p_reply_intent not in ('positive', 'negative', 'neutral') then
    raise exception 'INVALID_REPLY_INTENT' using errcode = '22023';
  end if;
  if p_priority is null or p_priority < 0 or p_priority > 10000 or p_active is null then
    raise exception 'INVALID_REQUEST' using errcode = '22023';
  end if;
  if p_template_id is null or not exists (
    select 1 from public.sms_templates t
    where t.id = p_template_id and t.org_id = p_org_id and t.deleted_at is null
  ) then
    raise exception 'TEMPLATE_NOT_FOUND' using errcode = 'P0002';
  end if;

  if p_mapping_id is null then
    insert into public.auto_reply_templates (
      org_id, outcome, reply_intent, template_id, priority, active, created_by, updated_by
    ) values (
      p_org_id, p_outcome, p_reply_intent, p_template_id, p_priority, p_active, v_actor, v_actor
    )
    on conflict (org_id, outcome, coalesce(reply_intent, ''), template_id) do update
      set priority = excluded.priority,
          active = excluded.active,
          updated_by = v_actor
    returning id into v_id;
  else
    update public.auto_reply_templates
    set outcome = p_outcome,
        reply_intent = p_reply_intent,
        template_id = p_template_id,
        priority = p_priority,
        active = p_active,
        updated_by = v_actor
    where id = p_mapping_id and org_id = p_org_id
    returning id into v_id;
    if v_id is null then
      raise exception 'MAPPING_NOT_FOUND' using errcode = 'P0002';
    end if;
  end if;
  return jsonb_build_object('ok', true, 'mappingId', v_id, 'deleted', false);
end;
$$;

revoke all on function public.fn_set_auto_reply_template(uuid, text, text, uuid, integer, boolean, uuid, boolean)
  from public, anon, service_role;
grant execute on function public.fn_set_auto_reply_template(uuid, text, text, uuid, integer, boolean, uuid, boolean)
  to authenticated;

commit;
