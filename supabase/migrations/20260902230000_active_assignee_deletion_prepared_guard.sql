-- A Hugo deletion-prepared membership is not assignable even during a
-- transient state where its access_status has not yet changed. Application
-- validation repeats this rule; this trigger closes the validation/write race.

create or replace function public.enforce_active_property_assignee_membership()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
begin
  if new.assigned_user_id is null then
    return new;
  end if;

  if not exists (
    select 1
    from public.memberships membership
    where membership.org_id = new.org_id
      and membership.user_id = new.assigned_user_id
      and membership.access_status = 'active'
      and membership.deletion_prepared_at is null
      and (
        membership.access_expires_at is null
        or membership.access_expires_at > statement_timestamp()
      )
  ) then
    raise exception using
      errcode = '23514',
      message = 'INVALID_ASSIGNEE: Assignee must have active access to the property organization';
  end if;

  return new;
end;
$$;

revoke all on function public.enforce_active_property_assignee_membership() from public;

