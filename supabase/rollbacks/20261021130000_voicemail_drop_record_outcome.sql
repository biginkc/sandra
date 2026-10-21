-- Roll back 20261021130000_voicemail_drop_record_outcome.
-- The worker code that calls these functions must be reverted first.
begin;

do $$
begin
  -- Later voicemail drop migrations must be rolled back first:
  -- 20261021140000_voicemail_drop_resolve_outcome uses the settle helper.
  if exists (
    select 1 from pg_proc p join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'public' and p.proname = 'resolve_voicemail_drop_outcome'
  ) then
    raise exception 'roll back 20261021140000_voicemail_drop_resolve_outcome first';
  end if;
end;
$$;

drop function if exists public.record_voicemail_drop_unknown(uuid, uuid, text, jsonb);
drop function if exists public.record_voicemail_drop_accepted(uuid, uuid, jsonb);
drop function if exists public.voicemail_drop_settle_enrollment(uuid, integer, boolean, text);

commit;
