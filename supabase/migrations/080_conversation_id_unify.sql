-- 080: Unify SMS thread identity on conversation_id.
--
-- Before this migration three thread-id formats coexisted: conversation
-- UUIDs, `legacy:<contact>:<property>` keys (rows with null
-- conversation_id), and bare contact ids in old URLs. The only rows that
-- could not get a conversation id were property-less threads, because
-- ensure_sms_conversation_id() requires a property for org scoping and
-- message_threads.property_id was NOT NULL.
--
-- This migration:
--   1. allows property-less rows in the message_threads registry,
--   2. extracts an internal minting helper (no auth checks) shared by the
--      public RPC and a new fill trigger,
--   3. extends ensure_sms_conversation_id() to accept a null property,
--   4. installs a BEFORE INSERT/UPDATE trigger on messages that fills
--      conversation_id for any contact-bearing SMS row — closing both
--      faucets (property-less inbounds, and Triage matching an unknown
--      sender to a contact via UPDATE),
--   5. backfills all existing contact-bearing rows with null
--      conversation_id, and
--   6. asserts the invariant holds.
--
-- After this, application code keys threads purely on conversation_id;
-- legacy formats survive only as a URL-compat shim at the page boundary.

-- 1. Registry: permit property-less threads. The existing triplet unique
--    constraint treats NULLs as distinct, so property-less rows need their
--    own partial unique index for ON CONFLICT to bite.
alter table public.message_threads alter column property_id drop not null;

create unique index if not exists uq_message_threads_contact_only
  on public.message_threads (channel, contact_id)
  where property_id is null;

-- 2. Internal minting helper. No auth checks — callable only from the
--    security-definer RPC, the fill trigger, and migrations. Reuses any
--    conversation id already present on messages for the thread key so
--    pre-registry threads keep their historical ids.
create or replace function public.sms_conversation_id_mint(
  p_org_id uuid,
  p_contact_id uuid,
  p_property_id uuid
)
returns uuid
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_existing_conversation_id uuid;
  v_conversation_id uuid;
begin
  select m.conversation_id
  into v_existing_conversation_id
  from public.messages m
  where m.channel = 'sms'
    and m.contact_id = p_contact_id
    and m.property_id is not distinct from p_property_id
    and m.conversation_id is not null
  order by m.created_at asc, m.id asc
  limit 1;

  if p_property_id is null then
    insert into public.message_threads (
      org_id, channel, contact_id, property_id, conversation_id
    )
    values (
      p_org_id, 'sms', p_contact_id, null,
      coalesce(v_existing_conversation_id, gen_random_uuid())
    )
    on conflict (channel, contact_id) where property_id is null
    do update set updated_at = public.message_threads.updated_at
    returning conversation_id into v_conversation_id;
  else
    insert into public.message_threads (
      org_id, channel, contact_id, property_id, conversation_id
    )
    values (
      p_org_id, 'sms', p_contact_id, p_property_id,
      coalesce(v_existing_conversation_id, gen_random_uuid())
    )
    on conflict (channel, contact_id, property_id)
    do update set updated_at = public.message_threads.updated_at
    returning conversation_id into v_conversation_id;
  end if;

  return v_conversation_id;
end;
$$;

revoke execute on function public.sms_conversation_id_mint(uuid, uuid, uuid) from public;
revoke execute on function public.sms_conversation_id_mint(uuid, uuid, uuid) from authenticated;

-- 3. Public RPC now accepts a null property (contact-level threads).
--    Org scope comes from the contact when no property is given.
create or replace function public.ensure_sms_conversation_id(
  p_contact_id uuid,
  p_property_id uuid
)
returns uuid
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_org_id uuid;
  v_conversation_id uuid;
begin
  if p_property_id is null then
    select c.org_id
    into v_org_id
    from public.contacts c
    where c.id = p_contact_id;
  else
    select p.org_id
    into v_org_id
    from public.properties p
    join public.contacts c
      on c.id = p_contact_id
     and c.org_id = p.org_id
    where p.id = p_property_id;
  end if;

  if v_org_id is null then
    raise exception 'contact/property thread scope not found'
      using errcode = '42501';
  end if;

  if coalesce(auth.role(), '') <> 'service_role'
    and not exists (
      select 1
      from public.memberships m
      where m.user_id = auth.uid()
        and m.org_id = v_org_id
    )
  then
    raise exception 'not authorized for contact/property thread'
      using errcode = '42501';
  end if;

  v_conversation_id := public.sms_conversation_id_mint(
    v_org_id, p_contact_id, p_property_id
  );

  update public.messages m
  set conversation_id = v_conversation_id
  where m.channel = 'sms'
    and m.contact_id = p_contact_id
    and m.property_id is not distinct from p_property_id
    and m.conversation_id is null;

  return v_conversation_id;
end;
$$;

-- 4. Fill trigger — the DB-level guarantee that no contact-bearing SMS row
--    can exist without a conversation id. Fills rather than rejects, so
--    older application code (or mid-deploy races) degrade gracefully
--    instead of dropping inbound messages. Covers INSERT and the Triage
--    flow that attaches a contact to an unknown-sender row via UPDATE.
create or replace function public.messages_fill_sms_conversation_id()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_org_id uuid;
begin
  if new.channel = 'sms'
    and new.contact_id is not null
    and new.conversation_id is null
  then
    if new.property_id is null then
      select c.org_id into v_org_id
      from public.contacts c
      where c.id = new.contact_id;
    else
      select p.org_id into v_org_id
      from public.properties p
      where p.id = new.property_id;
    end if;

    if v_org_id is not null then
      new.conversation_id := public.sms_conversation_id_mint(
        v_org_id, new.contact_id, new.property_id
      );
    end if;
  end if;
  return new;
end;
$$;

drop trigger if exists trg_messages_fill_sms_conversation_id on public.messages;
create trigger trg_messages_fill_sms_conversation_id
  before insert or update of contact_id on public.messages
  for each row
  execute function public.messages_fill_sms_conversation_id();

-- 5. Backfill every existing contact-bearing SMS row that lacks a
--    conversation id. Inline (not via the RPC) because migrations run
--    without an auth context. Idempotent: re-running finds nothing.
do $$
declare
  r record;
  v_org_id uuid;
begin
  for r in
    select distinct contact_id, property_id
    from public.messages
    where channel = 'sms'
      and conversation_id is null
      and contact_id is not null
  loop
    if r.property_id is null then
      select c.org_id into v_org_id
      from public.contacts c
      where c.id = r.contact_id;
    else
      select p.org_id into v_org_id
      from public.properties p
      where p.id = r.property_id;
    end if;

    if v_org_id is null then
      raise warning 'conversation backfill: no org scope for contact % / property %',
        r.contact_id, r.property_id;
      continue;
    end if;

    update public.messages m
    set conversation_id = public.sms_conversation_id_mint(
      v_org_id, r.contact_id, r.property_id
    )
    where m.channel = 'sms'
      and m.contact_id = r.contact_id
      and m.property_id is not distinct from r.property_id
      and m.conversation_id is null;
  end loop;
end;
$$;

-- 6. Assert the invariant. Fails the migration loudly rather than leaving
--    a partially unified dataset behind.
do $$
declare
  v_remaining bigint;
begin
  select count(*) into v_remaining
  from public.messages
  where channel = 'sms'
    and contact_id is not null
    and conversation_id is null;

  if v_remaining > 0 then
    raise exception 'conversation_id unification incomplete: % rows remain', v_remaining;
  end if;
end;
$$;
