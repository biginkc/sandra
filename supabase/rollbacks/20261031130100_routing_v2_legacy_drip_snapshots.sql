-- Disable flags first. Preserve any snapshot once it has been used or superseded.
begin;
set local lock_timeout = '5s';
set local routing_v2.allow_drip_edit = 'on';
lock table public.sequences in share row exclusive mode;
lock table public.sequence_enrollments in share row exclusive mode;
do $$ begin
  if exists (select 1 from public.sequences s where s.routing_v2_key in
    ('maybe_later','not_interested','asked_who','confirmed_owner') and
    (s.routing_v2_version<>1 or exists(select 1 from public.sequence_enrollments e where e.sequence_id=s.id))) then
    raise exception 'Routing-v2 snapshots have been used or superseded; retain snapshots and disable flags instead';
  end if;
end $$;
delete from public.sequence_steps where sequence_id in
  (select id from public.sequences where routing_v2_key in ('maybe_later','not_interested','asked_who','confirmed_owner'));
delete from public.sequences where routing_v2_key in ('maybe_later','not_interested','asked_who','confirmed_owner');
alter table public.sequences drop constraint sequences_routing_v2_key_check;
alter table public.sequences add constraint sequences_routing_v2_key_check check (
  (routing_v2_key is null and routing_v2_version is null and routing_v2_then_key is null)
  or (routing_v2_key in ('price_too_high','said_theyd_call','vacant_land','book_appointment','listed_not_selling')
    and routing_v2_version is not null and routing_v2_version >= 1
    and (routing_v2_then_key is null or routing_v2_then_key in
      ('price_too_high','said_theyd_call','vacant_land','book_appointment','listed_not_selling')))
);
commit;
