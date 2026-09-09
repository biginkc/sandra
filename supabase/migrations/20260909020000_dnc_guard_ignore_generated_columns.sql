-- Preserve the current guard; exclude computed columns from the DNC-only comparison.
begin;

CREATE OR REPLACE FUNCTION public.reject_locked_property_contact_mutation()
 RETURNS trigger
 LANGUAGE plpgsql
 SET search_path TO 'public', 'pg_temp'
AS $function$
declare
  linked_is_locked boolean;
  comparison_exclusions text[];
begin
  if tg_op = 'UPDATE'
    and new.do_not_contact is true
    and old.do_not_contact is false
  then
    -- Generated NEW values are not computed yet in this BEFORE trigger.
    select array['do_not_contact', 'updated_at'] ||
      coalesce(array_agg(attname::text), array[]::text[])
    into comparison_exclusions
    from pg_catalog.pg_attribute
    where attrelid = tg_relid and attgenerated <> '';

    if (to_jsonb(new) - comparison_exclusions)
      is distinct from (to_jsonb(old) - comparison_exclusions)
    then
      raise exception using errcode = 'P0001', message = 'DNC_RATCHET_ONLY';
    end if;
    return new;
  end if;

  -- A contact's own DNC bit is authoritative even when it has no homeowner
  -- property. Never allow DELETE to erase that compliance record.
  if tg_op = 'DELETE' and old.do_not_contact then
    raise exception using
      errcode = 'P0001',
      message = 'DNC_LOCKED: permanently locked contacts cannot be deleted';
  end if;

  perform 1 from public.properties property
  where property.homeowner_contact_id = old.id and property.org_id = old.org_id
  order by property.id
  for no key update;
  select exists (
    select 1 from public.properties property
    where property.homeowner_contact_id = old.id
      and property.org_id = old.org_id
      and property.is_dnc_locked
  ) into linked_is_locked;
  if linked_is_locked then
    raise exception using errcode = 'P0001', message = 'DNC_LOCKED: linked contact is read-only';
  end if;
  return case when tg_op = 'DELETE' then old else new end;
end;
$function$;

commit;
