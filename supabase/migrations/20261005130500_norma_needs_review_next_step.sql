-- My Leads one-call close, P1a-writers (1a.9): fn_norma_mark_needs_review creates its review
-- task through fn_create_next_step (kind 'task'). Verbatim copy of the 20261002120500 body except
-- the task block; an existing task for the request is left untouched, as before. Signature and
-- grants unchanged.
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
  -- Same contract as before: an existing task for this request is left exactly as it is (a
  -- review task a human already closed is not reopened by a repeated escalation).
  if not exists (select 1 from public.tasks t where t.org_id = r.org_id and t.source_key = 'norma_call:' || r.id::text) then
    begin
      v_task := (public.fn_create_next_step(
        p_org := r.org_id,
        p_actor := coalesce((select m.user_id from public.memberships m
                              where m.user_id = r.requested_by and m.org_id = r.org_id
                                and m.access_status = 'active' and m.deletion_prepared_at is null
                                and (m.access_expires_at is null or m.access_expires_at > now())),
                            r.callback_assignee_id),
        p_assignee := r.callback_assignee_id,
        p_kind := 'task', p_title := 'Norma call needs review: outcome unknown', p_due_at := now(),
        p_property := r.property_id, p_contact := r.contact_id,
        p_description := 'Norma may have called this seller but Sandra could not confirm the result. Check Bland and the lead before calling again.',
        p_source_key := 'norma_call:' || r.id::text, p_origin := 'norma') ->> 'task_id')::uuid;
    exception when others then
      if not (sqlstate = 'P0001' and split_part(sqlerrm, ':', 1) = 'DNC_LOCKED') then raise; end if;
      v_task := null;
    end;
  end if;
  return 'needs_review';
end;
$$;

commit;
