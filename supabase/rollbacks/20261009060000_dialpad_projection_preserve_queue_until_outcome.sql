-- Restore prior automatic queue behavior without reverting other projection changes.
begin;
do $projection$
declare
  sig constant text := 'public.dialpad_cti_project_intent(uuid)';
  anchor constant text := $a$    -- Queue advancement belongs to accepted rep outcome logging, never provider projection.$a$;
  replacement constant text := $r$    if v_attempt_created and v_episode.ended_at is null and v_episode.assignee_user_id = v_property.assigned_user_id
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
    end if;$r$;
  body text;
begin
  body := pg_get_functiondef(sig::regprocedure);
  if (length(body)-length(replace(body,anchor,'')))/length(anchor) <> 1 then
    raise exception 'Dialpad projection queue patch: expected exactly one anchor';
  end if;
  execute replace(body,anchor,replacement);
end $projection$;
do $patch$
declare
  sig constant text := 'public.fn_finalize_acquisition_attempt_without_sms_obligation(jsonb)';
  anchor constant text := '  perform public.dialpad_advance_queue_after_outcome(v_attempt.id);';
  body text;
begin
  body := pg_get_functiondef(sig::regprocedure);
  if (length(body)-length(replace(body,anchor,'')))/length(anchor) <> 1 then
    raise exception 'Dialpad outcome rollback: expected exactly one helper call';
  end if;
  execute replace(body,anchor,'');
end $patch$;
drop function public.dialpad_advance_queue_after_outcome(uuid);
commit;
