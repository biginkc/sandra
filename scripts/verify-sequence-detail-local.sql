-- Run from the repo root against a disposable local Supabase database:
-- psql "$LOCAL_DB_URL" -v ON_ERROR_STOP=1 -f scripts/verify-sequence-detail-local.sql
-- The transaction always rolls back the migration and fixture rows.
begin;
\i supabase/migrations/20260929237000_sequence_detail.sql

do $$
declare
  v_org uuid;
  v_user uuid;
  v_source uuid;
  v_target uuid;
  v_property uuid;
  v_enrollment uuid;
  v_step uuid;
  v_message uuid;
  v_copied integer;
  v_sent bigint;
  v_replied bigint;
  v_waiting bigint;
begin
  select m.org_id, m.user_id into v_org, v_user from public.memberships m
    where m.access_status = 'active' and m.deletion_prepared_at is null limit 1;
  if v_org is null then raise exception 'NO_LOCAL_MEMBERSHIP'; end if;
  perform set_config('request.jwt.claim.sub', v_user::text, true);

  insert into public.sequences (org_id, name)
    values (v_org, 'pr6-fixture-source-' || gen_random_uuid()) returning id into v_source;
  insert into public.sequences (org_id, name)
    values (v_org, 'pr6-fixture-target-' || gen_random_uuid()) returning id into v_target;
  insert into public.sequence_steps (sequence_id, step_index, delay_after_previous_minutes, action_type, template_body)
    values (v_source, 0, 0, 'send_sms', 'Fixture text'),
      (v_source, 1, 1440, 'send_sms', 'Fixture follow-up');

  select public.sequence_copy_steps(v_target, v_source) into v_copied;
  if v_copied <> 2 or (select count(*) from public.sequence_steps where sequence_id = v_source) <> 2
    then raise exception 'COPY_WRONG_COUNT'; end if;
  begin
    perform public.sequence_copy_steps(v_target, v_source);
    raise exception 'COPY_ACCEPTED_NONEMPTY_TARGET';
  exception when check_violation then
    if sqlerrm <> 'TARGET_NOT_EMPTY' then raise; end if;
  end;

  insert into public.properties (org_id, address, state)
    values (v_org, 'PR6 fixture address', 'MO') returning id into v_property;
  insert into public.sequence_enrollments (org_id, sequence_id, property_id, status, current_step_index)
    values (v_org, v_target, v_property, 'active', 1) returning id into v_enrollment;
  select id into v_step from public.sequence_steps where sequence_id = v_target and step_index = 0;
  insert into public.messages (org_id, property_id, channel, direction, body, status, sent_at)
    values (v_org, v_property, 'sms', 'outbound', 'Fixture text', 'sent', now() - interval '2 hours')
    returning id into v_message;
  insert into public.sequence_step_runs (enrollment_id, step_id, message_id, scheduled_for, run_at)
    values (v_enrollment, v_step, v_message, now() - interval '2 hours', now() - interval '2 hours');
  select sent, replied, waiting into v_sent, v_replied, v_waiting
    from public.sequence_step_stats(v_org, v_target) where step_id = v_step;
  if (v_sent, v_replied, v_waiting) is distinct from (1::bigint, 0::bigint, 1::bigint)
    then raise exception 'WRONG_STEP_STATS %, %, %', v_sent, v_replied, v_waiting; end if;
  insert into public.messages (org_id, property_id, channel, direction, body, status)
    values (v_org, v_property, 'sms', 'inbound', 'Yes', 'received');
  select replied into v_replied from public.sequence_step_stats(v_org, v_target) where step_id = v_step;
  if v_replied <> 1 then raise exception 'REPLY_NOT_COUNTED'; end if;
  raise notice 'PR6 local fixture passed: copy guard, source preservation, sent/replied/waiting';
end $$;
rollback;
