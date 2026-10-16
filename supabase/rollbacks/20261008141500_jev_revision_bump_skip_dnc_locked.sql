-- Rollback for 20261008141500_jev_revision_bump_skip_dnc_locked.
-- Restores the exact prior definition of every function/trigger/view/policy this
-- migration created, replaced or dropped (taken verbatim from the earlier migration
-- that last defined it), and removes everything it newly created. Idempotent.
begin;

-- Functions this migration replaced: restore the prior body (and grants).
-- jev_bump_decision_context_revision_on_message_activity(): restore body from 20261008140900_jev_decision_context_gaps.sql
create or replace function public.jev_bump_decision_context_revision_on_message_activity()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
begin
  if new.channel = 'sms' and new.property_id is not null and new.direction in ('inbound', 'outbound') then
    update public.properties
    set decision_context_revision = decision_context_revision + 1
    where id = new.property_id;
  end if;
  return new;
end;
$$;
-- jev_bump_decision_context_revision_on_appointment(): restore body from 20261008140800_jev_decision_context_revision.sql
create or replace function public.jev_bump_decision_context_revision_on_appointment()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
begin
  if new.type = 'appointment' and new.related_property_id is not null then
    update public.properties
    set decision_context_revision = decision_context_revision + 1
    where id = new.related_property_id;
  end if;
  return new;
end;
$$;

commit;
