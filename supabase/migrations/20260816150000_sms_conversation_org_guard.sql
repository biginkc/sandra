begin;

-- Resolve the tenant for a public conversation UUID before any detail read or
-- mutation. Conversation ids are not globally unique, so guessing from the
-- newest row would allow a shared member to cross organization boundaries.
create or replace function public.resolve_sms_conversation_org(
  p_conversation_id uuid
)
returns uuid
language plpgsql
stable
security invoker
set search_path = ''
as $$
declare
  visible_org_ids uuid[];
begin
  select array_agg(distinct m.org_id order by m.org_id)
    into visible_org_ids
  from public.messages m
  where m.channel = 'sms'
    and m.conversation_id = p_conversation_id
    and (
      current_user in ('service_role', 'postgres')
      or (
        current_user = 'authenticated'
        and exists (
          select 1
          from public.memberships membership
          where membership.user_id = auth.uid()
            and membership.org_id = m.org_id
            and membership.access_status = 'active'
            and membership.deletion_prepared_at is null
            and (
              membership.access_expires_at is null
              or membership.access_expires_at > statement_timestamp()
            )
        )
      )
    );

  if coalesce(cardinality(visible_org_ids), 0) = 0 then
    return null;
  end if;

  if cardinality(visible_org_ids) > 1 then
    raise exception using
      errcode = 'P0001',
      message = 'SMS_CONVERSATION_ORG_AMBIGUOUS';
  end if;

  return visible_org_ids[1];
end;
$$;

revoke all on function public.resolve_sms_conversation_org(uuid) from public;
revoke all on function public.resolve_sms_conversation_org(uuid) from anon;
grant execute on function public.resolve_sms_conversation_org(uuid) to authenticated;
grant execute on function public.resolve_sms_conversation_org(uuid) to service_role;

comment on function public.resolve_sms_conversation_org(uuid) is
  'Returns the one active-membership-visible organization for every SMS row carrying a conversation UUID; raises when that UUID spans visible organizations.';

commit;
