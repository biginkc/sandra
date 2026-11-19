-- Voicemail drop eligibility needs the "reached" acquisition attempts for a
-- property. acquisition_attempts intentionally has no service-role table
-- grant (20260912090200), so a direct read fails with "permission denied".
-- Expose only the two facts eligibility uses (call_activity_id, occurred_at),
-- with the org/property/deleted scoping inside the definer-owned query, the
-- same pattern as get_slack_preview_attempt_facts (20261003130001).
-- Same filter, order and limit as the old direct read: org + property,
-- outcome 'reached', call_activity_id present, newest first, 20 rows.
create or replace function public.get_voicemail_drop_reached_attempt_facts(
  p_org_id uuid, p_property_id uuid
) returns table(call_activity_id uuid, occurred_at timestamptz)
language sql stable security definer set search_path = public, pg_temp as $$
  select a.call_activity_id, a.occurred_at
    from public.acquisition_attempts a
   where a.org_id = p_org_id
     and a.property_id = p_property_id
     and a.outcome = 'reached'
     and a.call_activity_id is not null
     and exists (
       select 1
         from public.properties p
        where p.id = p_property_id
          and p.org_id = p_org_id
          and p.deleted_at is null
     )
   order by a.occurred_at desc
   limit 20;
$$;

revoke all on function public.get_voicemail_drop_reached_attempt_facts(uuid, uuid) from public, anon, authenticated;
grant execute on function public.get_voicemail_drop_reached_attempt_facts(uuid, uuid) to service_role;
