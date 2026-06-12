-- 080: hard rule — no phone number is saved without a line type.
--
-- 078 added the per-slot phone_N_type columns and 079 backfilled them
-- from cached skip-trace results, but nothing stopped a NEW unlabeled
-- phone from landing as 'unknown' and re-creating the texting-landlines
-- problem one import at a time. This trigger closes the write path:
-- a phone value that is new (INSERT) or changed (UPDATE) must arrive
-- with a real type, or the write is rejected.
--
-- Deliberately scoped to CHANGED phone values only: legacy rows that
-- still carry unknown-typed phones stay fully updatable (renaming a
-- contact, toggling do_not_contact, etc.) as long as the phone value
-- itself doesn't change. Type-only updates (unknown → mobile) pass —
-- that's the classification path itself.

create or replace function enforce_phone_type_on_write()
returns trigger
language plpgsql
set search_path = public, pg_temp
as $$
begin
  if new.phone_1 is not null
     and (tg_op = 'INSERT' or new.phone_1 is distinct from old.phone_1)
     and new.phone_1_type = 'unknown' then
    raise exception 'phone_1 requires a line type (mobile or landline) — unlabeled phone numbers are not saved';
  end if;

  if new.phone_2 is not null
     and (tg_op = 'INSERT' or new.phone_2 is distinct from old.phone_2)
     and new.phone_2_type = 'unknown' then
    raise exception 'phone_2 requires a line type (mobile or landline) — unlabeled phone numbers are not saved';
  end if;

  if new.phone_3 is not null
     and (tg_op = 'INSERT' or new.phone_3 is distinct from old.phone_3)
     and new.phone_3_type = 'unknown' then
    raise exception 'phone_3 requires a line type (mobile or landline) — unlabeled phone numbers are not saved';
  end if;

  return new;
end;
$$;

drop trigger if exists contacts_phone_type_required on contacts;
create trigger contacts_phone_type_required
  before insert or update on contacts
  for each row
  execute function enforce_phone_type_on_write();
