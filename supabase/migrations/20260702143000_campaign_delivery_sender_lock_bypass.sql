begin;

create or replace function public.reject_locked_campaign_delivery_sender_update()
returns trigger
language plpgsql
set search_path = public, pg_temp
as $$
begin
  if (
    old.campaign_id is distinct from new.campaign_id or
    old.provider is distinct from new.provider or
    old.sender_number is distinct from new.sender_number or
    old.from_address is distinct from new.from_address
  ) and exists (
    select 1
    from public.messages m
    where m.campaign_id = old.campaign_id
      and m.direction = 'outbound'
    limit 1
  ) then
    raise exception
      'campaign delivery sender is locked after outbound messages exist'
      using errcode = '23514';
  end if;

  if old.campaign_id is distinct from new.campaign_id
    and exists (
      select 1
      from public.messages m
      where m.campaign_id = new.campaign_id
        and m.direction = 'outbound'
        and (
          m.from_address is null or
          new.from_address is distinct from m.from_address or
          new.sender_number is distinct from m.from_address
        )
      limit 1
    ) then
    raise exception
      'campaign delivery sender is locked after outbound messages exist'
      using errcode = '23514';
  end if;

  new.updated_at := now();
  return new;
end;
$$;

create or replace function public.reject_locked_campaign_delivery_sender_insert()
returns trigger
language plpgsql
set search_path = public, pg_temp
as $$
begin
  if exists (
    select 1
    from public.messages m
    where m.campaign_id = new.campaign_id
      and m.direction = 'outbound'
      and (
        m.from_address is null or
        new.from_address is distinct from m.from_address or
        new.sender_number is distinct from m.from_address
      )
    limit 1
  ) then
    raise exception
      'campaign delivery sender is locked after outbound messages exist'
      using errcode = '23514';
  end if;

  return new;
end;
$$;

drop trigger if exists campaign_delivery_settings_insert_sender_lock
  on public.campaign_delivery_settings;

create trigger campaign_delivery_settings_insert_sender_lock
before insert on public.campaign_delivery_settings
for each row
execute function public.reject_locked_campaign_delivery_sender_insert();

commit;
