begin;
-- Service-only read used after the route has authorized the parent via session RLS.
-- Reuse the KPI predicate; do not create a second interpretation of completeness.
create function public.fn_dialpad_recording_complete(p_org_id uuid,p_call_id text)
returns boolean language sql stable security definer set search_path='' as $$
  select public.dialpad_has_complete_owned_recording(p_org_id,p_call_id);
$$;
revoke all on function public.fn_dialpad_recording_complete(uuid,text) from public,anon,authenticated;
grant execute on function public.fn_dialpad_recording_complete(uuid,text) to service_role;
commit;
