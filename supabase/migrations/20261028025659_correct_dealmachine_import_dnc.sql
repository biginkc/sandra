-- One-time operator-requested correction of vendor flags promoted to a
-- contact-wide lock by the October 27 DealMachine import. Source metadata
-- remains unchanged. Consumer preferences and pre-existing contacts are excluded.
begin;
set local lock_timeout = '5s';
set local statement_timeout = '120s';

create table public.dealmachine_import_dnc_corrections (
  contact_id uuid primary key references public.contacts(id),
  campaign_id uuid not null references public.campaigns(id),
  org_id uuid not null,
  prior_contact jsonb not null,
  correction_reason text not null,
  corrected_at timestamptz not null default now(),
  correction_transaction bigint not null default txid_current()
);
alter table public.dealmachine_import_dnc_corrections enable row level security;
revoke all on public.dealmachine_import_dnc_corrections from public, anon, authenticated, service_role;

do $repair$
declare
  target_campaign uuid;
  target_org uuid;
  original_guard text;
  original_guard_hash text;
  candidate_count integer;
  candidate_hash text;
  changed_count integer;
begin
  select id, org_id into target_campaign, target_org from public.campaigns
  where name = '10.27.26-AbsenteeOwner-Fresh(MO-6-Counties)-SMS-DealMachine';
  if target_campaign is null then return; end if;
  if (select count(*) from public.campaigns where name = '10.27.26-AbsenteeOwner-Fresh(MO-6-Counties)-SMS-DealMachine') <> 1 then
    raise exception 'Ambiguous DealMachine recovery campaign';
  end if;

  -- Serialize with writes while the exact candidate set is checked and fixed.
  -- No trigger is disabled. The normal guard is restored before commit.
  perform pg_advisory_xact_lock(hashtextextended('switchboard-global-dnc-write-barrier-v1',0));
  lock table public.contacts in share row exclusive mode;
  lock table public.consent_events, public.global_phone_dnc_registry,
    public.properties, public.property_contacts, public.campaign_recipients in share mode;

  insert into public.dealmachine_import_dnc_corrections
    (contact_id,campaign_id,org_id,prior_contact,correction_reason)
  select distinct c.id,target_campaign,c.org_id,to_jsonb(c),
    'Operator requested removal of DealMachine vendor DNC columns and correction of import-created contact-wide flags; existing opt-outs and prior contacts excluded.'
  from public.contacts c
  join public.property_contacts pc on pc.contact_id=c.id and pc.org_id=c.org_id
  join public.campaign_recipients cr on cr.contact_id=c.id and cr.property_id=pc.property_id
  where cr.campaign_id=target_campaign and c.org_id=target_org
    and pc.relationship='dealmachine_contact' and pc.created_at=c.created_at
    and c.created_at >= '2026-10-27T23:15:00Z' and c.created_at < '2026-10-28T00:18:00Z'
    and c.do_not_contact and not coalesce(c.sms_opted_out,false)
    and not exists(select 1 from public.consent_events ce where ce.contact_id=c.id and ce.event_type='opt_out')
    and not exists(select 1 from public.properties p where p.homeowner_contact_id=c.id and p.is_dnc_locked)
    and not exists(select 1 from public.global_phone_dnc_registry g where g.org_id=c.org_id and g.phone_e164 in(c.phone_1,c.phone_2,c.phone_3));

  select count(*),md5(string_agg(contact_id::text,',' order by contact_id))
  into candidate_count,candidate_hash from public.dealmachine_import_dnc_corrections;
  if candidate_count <> 9465 or candidate_hash <> 'a677abb5f321c7759d96b5526faf88dd' then
    raise exception 'Recovery cohort changed: % contacts, hash %; no changes committed',candidate_count,candidate_hash;
  end if;
  select pg_get_functiondef('public.contacts_true_dnc_lock_guard()'::regprocedure)
    into original_guard;
  original_guard_hash := md5(original_guard);

  -- This transaction-only guard accepts only the audited, unchanged rows.
  -- Other sessions cannot observe this definition before it is restored.
  execute $guard$
    create or replace function public.contacts_true_dnc_lock_guard()
    returns trigger language plpgsql set search_path=public,pg_temp as $body$
    declare comparison_exclusions text[];
    begin
      if tg_op='UPDATE' and old.do_not_contact and not new.do_not_contact then
        select array['do_not_contact'] || coalesce(array_agg(attname::text),array[]::text[])
          into comparison_exclusions from pg_catalog.pg_attribute
          where attrelid=tg_relid and attgenerated<>'';
        if exists(select 1 from public.dealmachine_import_dnc_corrections a
          where a.contact_id=old.id and a.org_id=old.org_id
            and a.correction_transaction=txid_current()
            and a.prior_contact=to_jsonb(old))
          and (to_jsonb(new)-comparison_exclusions)=(to_jsonb(old)-comparison_exclusions) then
          return new;
        end if;
        raise exception 'DNC_LOCKED: contact do-not-contact cannot be cleared';
      end if;
      return new;
    end;
    $body$;
  $guard$;

  update public.contacts c set do_not_contact=false
  from public.dealmachine_import_dnc_corrections a
  where c.id=a.contact_id and c.org_id=a.org_id and a.correction_transaction=txid_current();
  get diagnostics changed_count=row_count;
  if changed_count <> candidate_count then raise exception 'Recovery update count mismatch'; end if;
  execute original_guard;
  if md5(pg_get_functiondef('public.contacts_true_dnc_lock_guard()'::regprocedure)) <> original_guard_hash then
    raise exception 'Original DNC guard was not restored';
  end if;
  if exists(select 1 from public.contacts c join public.dealmachine_import_dnc_corrections a on a.contact_id=c.id
    where c.do_not_contact or (to_jsonb(c)-'do_not_contact') <> (a.prior_contact-'do_not_contact')) then
    raise exception 'Unexpected contact mutation during correction';
  end if;
end;
$repair$;
commit;
