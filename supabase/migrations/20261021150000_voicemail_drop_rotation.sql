-- Voicemail drop PR 6: script rotation (.planning/voicemail-drop-step-plan.md).
-- A drop step can rotate among saved voicemail scripts: the worker picks one
-- per enrollment, the same way send_sms steps pick from a template_category
-- pool.
--
-- 1. voicemail_templates: saved voicemail scripts, kept in their own table so
--    they can never show up in SMS pickers (sms_templates is read by SMS
--    sends, campaigns and the AI responder) and SMS templates can never be
--    read aloud.
-- 2. sequence_steps.vm_template_category: the third drop source. A drop step
--    needs exactly one of vm_media_id / vm_tts_body / vm_template_category.
-- 3. sequence_replace_steps / sequence_copy_steps accept and copy it.
-- Rollback: supabase/rollbacks/20261021150000_voicemail_drop_rotation.sql.

begin;

set local lock_timeout = '5s';
set local statement_timeout = '60s';

-- ---------------------------------------------------------------------------
-- 1. voicemail_templates
-- ---------------------------------------------------------------------------
create table if not exists public.voicemail_templates (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references public.organizations(id) on delete cascade,
  name text not null check (length(btrim(name)) > 0 and length(name) <= 120),
  -- Drop Cowboy reads at most 1,200 characters (reason code 3021).
  content text not null check (length(btrim(content)) > 0 and length(content) <= 1200),
  category text not null check (length(btrim(category)) > 0 and length(category) <= 120),
  created_by uuid references auth.users(id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  deleted_at timestamptz
);

create index if not exists idx_voicemail_templates_org_category
  on public.voicemail_templates (org_id, category) where deleted_at is null;

drop trigger if exists trg_voicemail_templates_updated_at on public.voicemail_templates;
create trigger trg_voicemail_templates_updated_at
  before update on public.voicemail_templates
  for each row execute function public.set_updated_at();

alter table public.voicemail_templates enable row level security;
drop policy if exists voicemail_templates_org_select on public.voicemail_templates;
create policy voicemail_templates_org_select on public.voicemail_templates
  for select to authenticated using (public.hugo_has_active_org_access(org_id));
drop policy if exists voicemail_templates_org_insert on public.voicemail_templates;
create policy voicemail_templates_org_insert on public.voicemail_templates
  for insert to authenticated with check (public.hugo_has_active_org_access(org_id));
drop policy if exists voicemail_templates_org_update on public.voicemail_templates;
create policy voicemail_templates_org_update on public.voicemail_templates
  for update to authenticated
  using (public.hugo_has_active_org_access(org_id))
  with check (public.hugo_has_active_org_access(org_id));

-- Soft delete only (deleted_at): no delete grant for members.
revoke all on public.voicemail_templates from public, anon, authenticated;
grant select, insert, update on public.voicemail_templates to authenticated;
grant select, insert, update, delete on public.voicemail_templates to service_role;

-- ---------------------------------------------------------------------------
-- 2. Third drop source + body constraint
-- ---------------------------------------------------------------------------
alter table public.sequence_steps
  add column if not exists vm_template_category text;

alter table public.sequence_steps
  drop constraint if exists sequence_steps_voicemail_drop_body_xor;
alter table public.sequence_steps
  add constraint sequence_steps_voicemail_drop_body_xor
  check (
    case when action_type = 'send_voicemail_drop' then
      num_nonnulls(
        nullif(btrim(vm_media_id), ''),
        nullif(btrim(vm_tts_body), ''),
        nullif(btrim(vm_template_category), '')
      ) = 1
      and num_nonnulls(vm_media_id, vm_tts_body, vm_template_category) = 1
      and template_body is null
      and template_id is null
      and template_category is null
      and target_status is null
    else
      num_nonnulls(vm_media_id, vm_tts_body, vm_voice_id, vm_phone_line_id, vm_template_category) = 0
    end
  );

-- ---------------------------------------------------------------------------
-- 3. Step RPCs (redefinitions of 20261020140000)
-- ---------------------------------------------------------------------------
create or replace function public.sequence_replace_steps(
  p_sequence uuid, p_steps jsonb, p_name text, p_description text
) returns jsonb
language plpgsql security definer set search_path = '' set statement_timeout = '5s'
as $$
declare
  v_org uuid;
  v_step jsonb;
  v_index integer := 0;
  v_id uuid;
  v_ids uuid[] := '{}';
  v_action text;
  v_body text;
  v_template uuid;
  v_category text;
  v_status text;
  v_media text;
  v_tts text;
  v_voice text;
  v_line text;
  v_vmcat text;
  v_delay integer;
  v_offset integer;
  v_saved jsonb := '[]'::jsonb;
  v_enrolled boolean;
begin
  select s.org_id into v_org from public.sequences s where s.id = p_sequence for update;
  if v_org is null or auth.uid() is null or not exists (
    select 1 from public.memberships m where m.org_id = v_org and m.user_id = auth.uid()
      and m.access_status = 'active' and m.deletion_prepared_at is null
      and (m.access_expires_at is null or m.access_expires_at > statement_timestamp())
  ) then raise exception 'FORBIDDEN' using errcode = '42501'; end if;
  if p_name is null or length(btrim(p_name)) = 0 or length(btrim(p_name)) > 120 then
    raise exception 'Invalid drip name' using errcode = '22023';
  end if;
  if p_steps is null or jsonb_typeof(p_steps) <> 'array' then
    raise exception 'Invalid steps array' using errcode = '22023';
  end if;
  if jsonb_array_length(p_steps) > 100 then
    raise exception 'Invalid steps array' using errcode = '22023';
  end if;
  select exists (select 1 from public.sequence_enrollments e
    where e.org_id = v_org and e.sequence_id = p_sequence and e.status in ('active', 'paused'))
    into v_enrolled;

  -- Validate the entire payload before touching any row. Existing IDs must
  -- belong to this drip; duplicates and gaps are rejected.
  for v_step in select value from jsonb_array_elements(p_steps) loop
    if jsonb_typeof(v_step) <> 'object' or (v_step ->> 'step_index') is distinct from v_index::text then
      raise exception 'Step indexes must be contiguous from zero' using errcode = '22023';
    end if;
    if v_step ? 'id' and nullif(v_step ->> 'id', '') is not null then
      v_id := (v_step ->> 'id')::uuid;
      if v_id = any(v_ids) or not exists (select 1 from public.sequence_steps where id = v_id and sequence_id = p_sequence) then
        raise exception 'Step ID is duplicated or does not belong to drip' using errcode = '22023';
      end if;
      if v_enrolled and exists (select 1 from public.sequence_steps
        where id = v_id and sequence_id = p_sequence and step_index <> v_index) then
        raise exception 'Cannot reorder steps while leads are enrolled' using errcode = '22023';
      end if;
      v_ids := array_append(v_ids, v_id);
    end if;
    v_action := v_step ->> 'action_type';
    v_body := nullif(btrim(v_step ->> 'template_body'), '');
    v_template := nullif(v_step ->> 'template_id', '')::uuid;
    v_category := v_step ->> 'template_category';
    v_status := nullif(btrim(v_step ->> 'target_status'), '');
    v_media := nullif(btrim(v_step ->> 'vm_media_id'), '');
    v_tts := nullif(btrim(v_step ->> 'vm_tts_body'), '');
    v_voice := nullif(btrim(v_step ->> 'vm_voice_id'), '');
    v_line := nullif(btrim(v_step ->> 'vm_phone_line_id'), '');
    v_vmcat := nullif(btrim(v_step ->> 'vm_template_category'), '');
    v_delay := (v_step ->> 'delay_after_previous_minutes')::integer;
    if v_delay is null or v_delay < 0 or
      (v_action = 'send_sms' and (num_nonnulls(v_body, v_template, v_category) <> 1 or
        (v_category is not null and length(btrim(v_category)) = 0) or v_status is not null or
        num_nonnulls(v_media, v_tts, v_voice, v_line, v_vmcat) <> 0)) or
      (v_action = 'change_status' and (v_status is null or num_nonnulls(v_body, v_template, v_category) <> 0 or
        num_nonnulls(v_media, v_tts, v_voice, v_line, v_vmcat) <> 0)) or
      (v_action = 'send_voicemail_drop' and (num_nonnulls(v_media, v_tts, v_vmcat) <> 1 or
        num_nonnulls(v_body, v_template, v_category, v_status) <> 0)) or
      v_action not in ('send_sms', 'change_status', 'send_voicemail_drop') or v_action is null then
      raise exception 'Invalid step body, template, status, or delay' using errcode = '22023';
    end if;
    v_index := v_index + 1;
  end loop;

  if v_enrolled and exists (select 1 from public.sequence_steps s
    where s.sequence_id = p_sequence and not (s.id = any(v_ids))) then
    raise exception 'Cannot remove steps while leads are enrolled' using errcode = '22023';
  end if;

  if exists (
    select 1 from public.sequence_steps s
    join public.sequence_step_runs r on r.step_id = s.id
    where s.sequence_id = p_sequence and not (s.id = any(v_ids))
  ) then raise exception 'A step with execution history cannot be removed' using errcode = '23503'; end if;

  -- Move existing indexes above both old and new ranges before rearranging.
  select greatest(coalesce(max(step_index), 0), jsonb_array_length(p_steps)) + 1
    into v_offset from public.sequence_steps where sequence_id = p_sequence;
  update public.sequence_steps set step_index = step_index + v_offset
    where sequence_id = p_sequence;
  delete from public.sequence_steps where sequence_id = p_sequence and not (id = any(v_ids));
  v_index := 0;
  for v_step in select value from jsonb_array_elements(p_steps) loop
    v_id := nullif(v_step ->> 'id', '')::uuid;
    v_action := v_step ->> 'action_type';
    v_body := nullif(btrim(v_step ->> 'template_body'), '');
    v_template := nullif(v_step ->> 'template_id', '')::uuid;
    v_category := v_step ->> 'template_category';
    v_status := nullif(btrim(v_step ->> 'target_status'), '');
    v_media := nullif(btrim(v_step ->> 'vm_media_id'), '');
    v_tts := nullif(btrim(v_step ->> 'vm_tts_body'), '');
    v_voice := nullif(btrim(v_step ->> 'vm_voice_id'), '');
    v_line := nullif(btrim(v_step ->> 'vm_phone_line_id'), '');
    v_vmcat := nullif(btrim(v_step ->> 'vm_template_category'), '');
    v_delay := (v_step ->> 'delay_after_previous_minutes')::integer;
    if v_id is null then
      insert into public.sequence_steps (sequence_id, step_index, delay_after_previous_minutes,
        action_type, template_body, template_id, template_category, target_status,
        vm_media_id, vm_tts_body, vm_voice_id, vm_phone_line_id, vm_template_category)
      values (p_sequence, v_index, v_delay, v_action, v_body, v_template, v_category, v_status,
        v_media, v_tts, v_voice, v_line, v_vmcat)
      returning id into v_id;
    else
      update public.sequence_steps set step_index = v_index,
        delay_after_previous_minutes = v_delay, action_type = v_action,
        template_body = v_body, template_id = v_template,
        template_category = v_category, target_status = v_status,
        vm_media_id = v_media, vm_tts_body = v_tts, vm_voice_id = v_voice,
        vm_phone_line_id = v_line, vm_template_category = v_vmcat
      where id = v_id and sequence_id = p_sequence;
    end if;
    v_saved := v_saved || to_jsonb(v_id::text);
    v_index := v_index + 1;
  end loop;
  update public.sequences set name = btrim(p_name), description = p_description,
    append_opt_out = true, updated_at = now() where id = p_sequence and org_id = v_org;
  return v_saved;
end;
$$;
revoke all on function public.sequence_replace_steps(uuid, jsonb, text, text) from public, anon, service_role;
grant execute on function public.sequence_replace_steps(uuid, jsonb, text, text) to authenticated;

-- Preserve each step source when copying, including voicemail drop columns.
create or replace function public.sequence_copy_steps(p_target uuid, p_source uuid)
returns integer
language plpgsql security definer set search_path = '' set statement_timeout = '5s'
as $$
declare
  target_org uuid;
  copied integer;
begin
  if p_target is null or p_source is null or p_target = p_source or auth.uid() is null
  then raise exception 'INVALID_SEQUENCE' using errcode = '22023'; end if;
  -- The target row lock serializes concurrent copy attempts.
  select s.org_id into target_org from public.sequences s where s.id = p_target for update;
  if target_org is null or not exists (
    select 1 from public.memberships m where m.org_id = target_org and m.user_id = auth.uid()
      and m.access_status = 'active' and m.deletion_prepared_at is null
      and (m.access_expires_at is null or m.access_expires_at > statement_timestamp())
  ) then raise exception 'FORBIDDEN' using errcode = '42501'; end if;
  if not exists (select 1 from public.sequences s where s.id = p_source and s.org_id = target_org)
  then raise exception 'SOURCE_NOT_FOUND' using errcode = 'P0002'; end if;
  if exists (
    select 1 from public.sequence_steps where sequence_id = p_target
  ) then raise exception 'TARGET_NOT_EMPTY' using errcode = '23514'; end if;
  if not exists (select 1 from public.sequence_steps where sequence_id = p_source)
  then raise exception 'SOURCE_EMPTY' using errcode = '23514'; end if;

  insert into public.sequence_steps (sequence_id, step_index, delay_after_previous_minutes,
    action_type, template_body, template_id, template_category, target_status,
    vm_media_id, vm_tts_body, vm_voice_id, vm_phone_line_id, vm_template_category)
  select p_target, st.step_index, st.delay_after_previous_minutes,
    st.action_type, st.template_body, st.template_id, st.template_category, st.target_status,
    st.vm_media_id, st.vm_tts_body, st.vm_voice_id, st.vm_phone_line_id, st.vm_template_category
  from public.sequence_steps st where st.sequence_id = p_source order by st.step_index;
  get diagnostics copied = row_count;
  return copied;
end;
$$;
revoke all on function public.sequence_copy_steps(uuid, uuid) from public, anon, service_role;
grant execute on function public.sequence_copy_steps(uuid, uuid) to authenticated;

commit;
