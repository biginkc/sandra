-- Keep Dialpad provider evidence independent of the rep-owned queue transition.
-- Patch the live body so later ledger-key/native-direction changes are preserved.
-- No existing lead data is rewritten.
begin;

do $projection$
declare
  sig constant text := 'public.dialpad_cti_project_intent(uuid)';
  anchor constant text := $a$    if v_attempt_created and v_episode.ended_at is null and v_episode.assignee_user_id = v_property.assigned_user_id
       and v_started >= coalesce(v_episode.assigned_at, v_episode.initialized_at)
       and v_queue.archived_at is null and v_property.deleted_at is null and not coalesce(v_property.is_dnc_locked, false)
       and v_property.status::text not in ('closed', 'dead', 'dnc')
       and exists (select 1 from public.acquisition_org_settings where org_id = v_intent.org_id and my_leads_enabled) then
      if v_queue.property_id is null then
        insert into public.acquisition_queue_states (property_id, org_id, stage, stage_entered_at, version)
          values (v_intent.property_id, v_intent.org_id, 'contacted', v_started, 1);
      end if;
      if v_property.status::text in ('prospect', 'new_lead') then
        update public.properties set status = 'contacted' where id = v_intent.property_id and org_id = v_intent.org_id;
      end if;
    end if;$a$;
  replacement constant text := $r$    -- Queue advancement belongs to accepted rep outcome logging, never provider projection.$r$;
  body text;
begin
  body := pg_get_functiondef(sig::regprocedure);
  if (length(body)-length(replace(body,anchor,'')))/length(anchor) <> 1 then
    raise exception 'Dialpad projection queue patch: expected exactly one anchor';
  end if;
  execute replace(body,anchor,replacement);
end $projection$;

-- Internal helper, called only after the existing authenticated finalize command
-- accepts the outcome. Preserve newer assignments, archives and advanced stages.
create or replace function public.dialpad_advance_queue_after_outcome(p_attempt_id uuid)
returns void language plpgsql set search_path = '' as $$
declare
  a public.acquisition_attempts%rowtype;
  p public.properties%rowtype;
  q public.acquisition_queue_states%rowtype;
  e public.acquisition_assignment_episodes%rowtype;
begin
  select * into a from public.acquisition_attempts where id = p_attempt_id;
  if a.source is distinct from 'dialpad' or not coalesce(public.dialpad_cti_is_ledger_key(a.provider_attempt_key), false)
     or a.outcome is null then return; end if;
  select * into p from public.properties where id = a.property_id and org_id = a.org_id for update;
  select * into q from public.acquisition_queue_states where property_id = a.property_id and org_id = a.org_id for update;
  select * into e from public.acquisition_assignment_episodes
    where id = a.assignment_episode_id and property_id = a.property_id and org_id = a.org_id for update;
  if e.id is null or e.ended_at is not null or e.assignee_user_id is distinct from p.assigned_user_id
     or e.assignee_user_id is distinct from a.actor_user_id
     or a.occurred_at < coalesce(e.assigned_at, e.initialized_at)
     or q.archived_at is not null or p.deleted_at is not null or coalesce(p.is_dnc_locked, false)
     or p.status::text in ('closed', 'dead', 'dnc') or p.is_training
     or not exists (select 1 from public.acquisition_org_settings where org_id = a.org_id and my_leads_enabled)
     then return; end if;
  if q.property_id is null then
    insert into public.acquisition_queue_states(property_id, org_id, stage, stage_entered_at, version)
      values (a.property_id, a.org_id, 'contacted', statement_timestamp(), 1);
  end if;
  if p.status::text in ('prospect', 'new_lead') then
    update public.properties set status = 'contacted' where id = a.property_id and org_id = a.org_id;
  end if;
end;
$$;
revoke all on function public.dialpad_advance_queue_after_outcome(uuid) from public, anon, authenticated, service_role;

-- Patch only the accepted-outcome path, preserving all current authorization,
-- recording, single-shot and idempotency guards (including later hardening).
do $patch$
declare
  sig constant text := 'public.fn_finalize_acquisition_attempt_without_sms_obligation(jsonb)';
  anchor constant text := $a$  v_result:=jsonb_build_object('ok',true,'duplicate',false,'propertyId',v_attempt.property_id,'attemptId',v_attempt.id);$a$;
  body text;
begin
  body := pg_get_functiondef(sig::regprocedure);
  if (length(body) - length(replace(body, anchor, ''))) / length(anchor) <> 1 then
    raise exception 'Dialpad outcome queue patch: expected exactly one finalize result anchor';
  end if;
  execute replace(body, anchor, '  perform public.dialpad_advance_queue_after_outcome(v_attempt.id);' || chr(10) || anchor);
end $patch$;

commit;
