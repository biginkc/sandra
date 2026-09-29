-- Save drip details and the complete ordered step set in one transaction.
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
    v_delay := (v_step ->> 'delay_after_previous_minutes')::integer;
    if v_delay is null or v_delay < 0 or
      (v_action = 'send_sms' and (num_nonnulls(v_body, v_template, v_category) <> 1 or
        (v_category is not null and length(btrim(v_category)) = 0) or v_status is not null)) or
      (v_action = 'change_status' and (v_status is null or num_nonnulls(v_body, v_template, v_category) <> 0)) or
      v_action not in ('send_sms', 'change_status') or v_action is null then
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
    v_delay := (v_step ->> 'delay_after_previous_minutes')::integer;
    if v_id is null then
      insert into public.sequence_steps (sequence_id, step_index, delay_after_previous_minutes,
        action_type, template_body, template_id, template_category, target_status)
      values (p_sequence, v_index, v_delay, v_action, v_body, v_template, v_category, v_status)
      returning id into v_id;
    else
      update public.sequence_steps set step_index = v_index,
        delay_after_previous_minutes = v_delay, action_type = v_action,
        template_body = v_body, template_id = v_template,
        template_category = v_category, target_status = v_status
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
