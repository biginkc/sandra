-- Roll back 20261005130500_norma_needs_review_next_step: restore the 20261002120500 body.
begin;

create or replace function public.fn_norma_mark_needs_review(p_request_id uuid, p_reason text)
returns text
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  r public.norma_call_requests%rowtype;
  v_task uuid;
begin
  if coalesce(auth.role(), '') <> 'service_role' then
    raise exception 'service role required' using errcode = '42501';
  end if;
  select * into r from public.norma_call_requests where id = p_request_id for update;
  if r.id is null then return 'not_found'; end if;
  if r.status not in ('dispatching', 'dispatched', 'dispatch_unknown', 'needs_review') then
    return r.status;
  end if;
  if r.status <> 'needs_review' then
    update public.norma_call_requests
       set status = 'needs_review', dispatch_error = coalesce(left(p_reason, 1000), dispatch_error)
     where id = r.id;
  end if;
  perform public.fn_norma_lock_lead(r.property_id, r.contact_id);
  -- A do-not-contact lead is read-only (tasks_reject_dnc_locked_contact), and
  -- nobody should be asked to ring it back anyway. The escalation still
  -- happens; only the review task is skipped. The handler also covers a lock
  -- that lands between this statement and the commit.
  begin
    insert into public.tasks
      (org_id, assignee_id, related_property_id, contact_id, type, title, due_at, created_by, description, source_key)
    values
      (r.org_id, r.callback_assignee_id, r.property_id, r.contact_id, 'custom',
       'Norma call needs review: outcome unknown', now(), coalesce(r.requested_by, r.callback_assignee_id),
       'Norma may have called this seller but Sandra could not confirm the result. Check Bland and the lead before calling again.',
       'norma_call:' || r.id::text)
    on conflict (org_id, source_key) where source_key is not null do nothing
    returning id into v_task;
  exception when others then
    if not (sqlstate = 'P0001' and split_part(sqlerrm, ':', 1) = 'DNC_LOCKED') then raise; end if;
    v_task := null;
  end;
  if v_task is not null then
    insert into public.lead_events (org_id, property_id, actor_type, event_type, payload, source_type, source_id)
    values (r.org_id, r.property_id, 'system', 'task_created',
            jsonb_build_object('task_id', v_task, 'task_type', 'custom', 'due_at', now(),
                               'assignee_id', r.callback_assignee_id),
            'tasks.created', v_task)
    on conflict (source_type, source_id) where source_id is not null do nothing;
  end if;
  return 'needs_review';
end;
$$;

commit;
