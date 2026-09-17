begin;

-- The sender assignment relation predates the rep-SMS rollout. Keep its
-- browser-facing name for compatibility, but make the grant identity
-- provider-aware and revocable. Existing rows are only metadata defaults;
-- this migration deliberately creates no SMS obligations for old attempts.
alter table public.rep_sms_sender_assignments
  drop constraint if exists rep_sms_sender_assignments_provider_check;

alter table public.rep_sms_sender_assignments
  add column if not exists provider_account_id text,
  add column if not exists provider_sender_id text,
  add column if not exists composition_policy_version integer not null default 1,
  add column if not exists grant_status text not null default 'active',
  add column if not exists granted_at timestamptz not null default now(),
  add column if not exists revoked_at timestamptz,
  add column if not exists revoked_by uuid references auth.users(id);

do $$
begin
  if not exists (
    select 1 from pg_constraint
    where conrelid = 'public.rep_sms_sender_assignments'::regclass
      and conname = 'rep_sms_sender_assignments_provider_nonblank_check'
  ) then
    alter table public.rep_sms_sender_assignments
      add constraint rep_sms_sender_assignments_provider_nonblank_check
      check (provider ~ '^[a-z][a-z0-9_:-]{1,63}$');
  end if;
  if not exists (
    select 1 from pg_constraint
    where conrelid = 'public.rep_sms_sender_assignments'::regclass
      and conname = 'rep_sms_sender_assignments_grant_status_check'
  ) then
    alter table public.rep_sms_sender_assignments
      add constraint rep_sms_sender_assignments_grant_status_check
      check (grant_status in ('active','revoked'));
  end if;
  if not exists (
    select 1 from pg_constraint
    where conrelid = 'public.rep_sms_sender_assignments'::regclass
      and conname = 'rep_sms_sender_assignments_composition_policy_check'
  ) then
    alter table public.rep_sms_sender_assignments
      add constraint rep_sms_sender_assignments_composition_policy_check
      check (composition_policy_version > 0);
  end if;
  if not exists (
    select 1 from pg_constraint
    where conrelid = 'public.rep_sms_sender_assignments'::regclass
      and conname = 'rep_sms_sender_assignments_grant_lifecycle_check'
  ) then
    alter table public.rep_sms_sender_assignments
      add constraint rep_sms_sender_assignments_grant_lifecycle_check
      check ((grant_status = 'active' and revoked_at is null)
        or (grant_status = 'revoked' and revoked_at is not null));
  end if;
end;
$$;

create index if not exists rep_sms_sender_assignments_active_grant_idx
  on public.rep_sms_sender_assignments(org_id,user_id,provider,is_default desc,label,id)
  where active and grant_status='active' and revoked_at is null;
drop policy if exists rep_sms_read on public.rep_sms_sender_assignments;
create policy rep_sms_read on public.rep_sms_sender_assignments for select to authenticated using (
  active and grant_status='active' and revoked_at is null and
  exists(select 1 from public.memberships m where m.org_id=rep_sms_sender_assignments.org_id
    and m.user_id=auth.uid() and m.access_status='active' and m.deletion_prepared_at is null
    and (m.access_expires_at is null or m.access_expires_at>statement_timestamp())
    and (m.role='owner' or rep_sms_sender_assignments.user_id=auth.uid()))
);

-- Enrollment is an explicit, DB-readable rollout decision. It is empty on
-- install; no existing rep is enrolled by this migration. The owner grant
-- RPC below enrolls a rep only when an owner actively assigns a sender.
create table if not exists public.rep_sms_rollout_enrollments (
  org_id uuid not null references public.organizations(id) on delete cascade,
  user_id uuid not null references auth.users(id) on delete cascade,
  enabled boolean not null default false,
  enrolled_at timestamptz,
  enrolled_by uuid references auth.users(id),
  updated_at timestamptz not null default now(),
  updated_by uuid references auth.users(id),
  primary key (org_id,user_id),
  constraint rep_sms_rollout_enrollments_lifecycle_check check (
    (enabled and enrolled_at is not null and enrolled_by is not null)
    or (not enabled)
  )
);
alter table public.rep_sms_rollout_enrollments enable row level security;
revoke all on public.rep_sms_rollout_enrollments from public,anon,authenticated,service_role;
grant select on public.rep_sms_rollout_enrollments to authenticated;
grant select on public.rep_sms_rollout_enrollments to service_role;
drop policy if exists rep_sms_rollout_enrollments_select on public.rep_sms_rollout_enrollments;
create policy rep_sms_rollout_enrollments_select
  on public.rep_sms_rollout_enrollments for select to authenticated
  using (exists (
    select 1 from public.memberships m
    where m.org_id=rep_sms_rollout_enrollments.org_id
      and m.user_id=auth.uid()
      and m.access_status='active'
      and m.deletion_prepared_at is null
      and (m.access_expires_at is null or m.access_expires_at>statement_timestamp())
      and (m.role='owner' or m.user_id=rep_sms_rollout_enrollments.user_id)
  ));

-- Durable obligation state is separate from the messages transport ledger:
-- this row represents work that must be accounted for after a no-answer.
-- `state` is the provider/business outcome; `claim_state` and `claim_token`
-- are the worker lease fence. A worker may only write while holding the
-- exact unexpired token it was issued by fn_claim_authorize_rep_sms_obligation.
-- acquisition_attempts exposes id as its canonical key. Add the tenant
-- companion key before creating this table so the obligation FK enforces both
-- the attempt identity and its organization on the real schema.
create unique index if not exists acquisition_attempts_id_org_idx
  on public.acquisition_attempts(id,org_id);

create table if not exists public.rep_sms_obligations (
  id uuid primary key default extensions.gen_random_uuid(),
  org_id uuid not null references public.organizations(id) on delete cascade,
  property_id uuid not null,
  assignment_episode_id uuid,
  attempt_id uuid not null,
  actor_user_id uuid not null references auth.users(id) on delete restrict,
  obligation_kind text not null default 'no_answer_sms'
    check (obligation_kind='no_answer_sms'),
  provider text,
  provider_account_id text,
  sender_assignment_id uuid references public.rep_sms_sender_assignments(id) on delete set null,
  from_number text,
  to_number text,
  message_body text,
  state text not null default 'required'
    check (state in ('required','draft','claimed','sending','accepted','delivered','failed_not_dispatched','unknown','blocked','delivery_failed','voided','exception_closed')),
  blocked_reason text,
  provider_message_id text,
  provider_status text,
  provider_error text,
  composition jsonb not null default '{}'::jsonb,
  authorized_at timestamptz,
  claim_state text not null default 'unclaimed'
    check (claim_state in ('unclaimed','claimed','complete')),
  claim_token uuid,
  claim_generation bigint not null default 0 check (claim_generation >= 0),
  claimed_by uuid,
  claimed_at timestamptz,
  lease_expires_at timestamptz,
  next_attempt_at timestamptz not null default now(),
  accepted_at timestamptz,
  delivered_at timestamptz,
  resolved_at timestamptz,
  last_error text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint rep_sms_obligations_property_org_fkey
    foreign key (property_id,org_id) references public.properties(id,org_id) on delete cascade,
  constraint rep_sms_obligations_episode_property_fkey
    foreign key (assignment_episode_id,property_id,org_id)
    references public.acquisition_assignment_episodes(id,property_id,org_id),
  constraint rep_sms_obligations_attempt_org_fkey
    foreign key (attempt_id,org_id)
    references public.acquisition_attempts(id,org_id) on delete cascade,
  constraint rep_sms_obligations_provider_callback_identity_check check (
    provider_message_id is null or provider_account_id is not null
  ),
  constraint rep_sms_obligations_phone_check check (
    to_number is null or to_number ~ '^\+[1-9][0-9]{7,14}$'
  ),
  constraint rep_sms_obligations_claim_lifecycle_check check (
    (claim_state='unclaimed' and state in ('required','draft','failed_not_dispatched','unknown','delivery_failed','blocked')
      and claim_token is null and claimed_by is null
      and claimed_at is null and lease_expires_at is null)
    or (claim_state='claimed' and state in ('claimed','sending') and claim_token is not null and claimed_by is not null
      and claimed_at is not null and lease_expires_at is not null)
    or (claim_state='complete' and state in ('accepted','delivered','voided','exception_closed') and claim_token is not null)
  ),
  constraint rep_sms_obligations_terminal_check check (
    (state in ('delivered','voided','exception_closed') and claim_state='complete')
    or state not in ('delivered','voided','exception_closed')
  ),
  constraint rep_sms_obligations_authorization_check check (
    (state in ('sending','accepted','delivered','unknown','delivery_failed')
      and authorized_at is not null)
    or state in ('required','draft','claimed','failed_not_dispatched','blocked','voided','exception_closed')
  )
);
alter table public.rep_sms_obligations
  add constraint rep_sms_obligations_composition_object_check
  check (jsonb_typeof(composition) = 'object');
create unique index if not exists rep_sms_obligations_attempt_kind_idx
  on public.rep_sms_obligations(org_id,attempt_id,obligation_kind);
create unique index if not exists rep_sms_obligations_provider_callback_idx
  on public.rep_sms_obligations(provider,provider_account_id,provider_message_id)
  where provider_message_id is not null and provider_account_id is not null;
create index if not exists rep_sms_obligations_claim_idx
  on public.rep_sms_obligations(org_id,state,claim_state,next_attempt_at,lease_expires_at);
create index if not exists rep_sms_obligations_actor_idx
  on public.rep_sms_obligations(org_id,actor_user_id,created_at desc);
alter table public.rep_sms_obligations enable row level security;
revoke all on public.rep_sms_obligations from public,anon,authenticated,service_role;
grant select on public.rep_sms_obligations to authenticated;
grant select on public.rep_sms_obligations to service_role;
drop policy if exists rep_sms_obligations_select on public.rep_sms_obligations;
create policy rep_sms_obligations_select
  on public.rep_sms_obligations for select to authenticated
  using (exists (
    select 1 from public.memberships m
    where m.org_id=rep_sms_obligations.org_id
      and m.user_id=auth.uid()
      and m.access_status='active'
      and m.deletion_prepared_at is null
      and (m.access_expires_at is null or m.access_expires_at>statement_timestamp())
      and (m.role='owner' or m.user_id=rep_sms_obligations.actor_user_id
        or exists(select 1 from public.properties p where p.id=rep_sms_obligations.property_id
          and p.org_id=rep_sms_obligations.org_id and p.assigned_user_id=auth.uid()))
  ));

create table if not exists public.rep_sms_obligation_audit (
  id uuid primary key default extensions.gen_random_uuid(),
  org_id uuid not null references public.organizations(id) on delete cascade,
  obligation_id uuid not null references public.rep_sms_obligations(id) on delete cascade,
  actor_kind text not null check (actor_kind in ('user','service','system')),
  actor_user_id uuid references auth.users(id) on delete set null,
  action text not null,
  from_state text,
  to_state text,
  reason text,
  metadata jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now()
);
create index if not exists rep_sms_obligation_audit_lookup_idx
  on public.rep_sms_obligation_audit(org_id,obligation_id,created_at);
alter table public.rep_sms_obligation_audit enable row level security;
revoke all on public.rep_sms_obligation_audit from public,anon,authenticated,service_role;
grant select on public.rep_sms_obligation_audit to authenticated;
grant select on public.rep_sms_obligation_audit to service_role;
drop policy if exists rep_sms_obligation_audit_select on public.rep_sms_obligation_audit;
create policy rep_sms_obligation_audit_select
  on public.rep_sms_obligation_audit for select to authenticated
  using (exists (
    select 1 from public.memberships m
    join public.rep_sms_obligations o on o.org_id=m.org_id and o.id=rep_sms_obligation_audit.obligation_id
    where m.org_id=rep_sms_obligation_audit.org_id
      and m.user_id=auth.uid()
      and m.access_status='active'
      and m.deletion_prepared_at is null
      and (m.access_expires_at is null or m.access_expires_at>statement_timestamp())
      and (m.role='owner' or o.actor_user_id=auth.uid()
        or exists(select 1 from public.properties p where p.id=o.property_id and p.org_id=o.org_id
          and p.assigned_user_id=auth.uid()))
  ));

-- State transitions are deliberately narrow. SECURITY DEFINER RPCs below
-- remain the only write path for browser and worker roles.
create or replace function public.rep_sms_obligation_transition_guard()
returns trigger language plpgsql set search_path='' as $$
begin
  if new.state is distinct from old.state then
    if not (
      (old.state='required' and new.state in ('draft','claimed','sending','blocked','voided','exception_closed'))
      or (old.state='draft' and new.state in ('claimed','sending','blocked','voided','exception_closed'))
      or (old.state='claimed' and new.state in ('sending','failed_not_dispatched','unknown','blocked','voided','exception_closed'))
      or (old.state='sending' and new.state in ('accepted','delivered','delivery_failed','failed_not_dispatched','unknown','blocked','voided','exception_closed'))
      or (old.state='accepted' and new.state in ('delivered','delivery_failed','unknown','voided','exception_closed'))
      or (old.state='failed_not_dispatched' and new.state in ('claimed','sending','voided','exception_closed'))
      -- A timeout leaves the request ambiguous. Only an authenticated
      -- provider callback may settle it later as delivered or failed.
      or (old.state='unknown' and new.state in ('delivered','delivery_failed','blocked','voided','exception_closed'))
      or (old.state='blocked' and new.state in ('draft','required','voided','exception_closed'))
      or (old.state='delivery_failed' and new.state in ('voided','exception_closed'))
      or (old.state='delivered' and new.state='delivered')
      or (old.state='voided' and new.state='voided')
      or (old.state='exception_closed' and new.state='exception_closed')
    ) then
      raise exception 'INVALID_OBLIGATION_TRANSITION' using errcode='40001';
    end if;
  end if;
  new.updated_at:=statement_timestamp();
  return new;
end;
$$;
revoke all on function public.rep_sms_obligation_transition_guard() from public,anon,authenticated,service_role;
drop trigger if exists rep_sms_obligation_transition_guard on public.rep_sms_obligations;
create trigger rep_sms_obligation_transition_guard
  before update on public.rep_sms_obligations
  for each row execute function public.rep_sms_obligation_transition_guard();

create or replace function public.fn_set_rep_sms_enrollment(
  p_org_id uuid,p_user_id uuid,p_enabled boolean
) returns boolean language plpgsql security definer set search_path='' as $$
declare v_actor uuid:=auth.uid(); v_owner boolean;
begin
  select exists(select 1 from public.memberships m where m.org_id=p_org_id and m.user_id=v_actor
    and m.role='owner' and m.access_status='active' and m.deletion_prepared_at is null
    and (m.access_expires_at is null or m.access_expires_at>statement_timestamp())) into v_owner;
  if not v_owner then raise exception 'Only an active owner can change SMS rollout enrollment' using errcode='42501'; end if;
  if not exists(select 1 from public.memberships m where m.org_id=p_org_id and m.user_id=p_user_id
    and m.access_status='active' and m.deletion_prepared_at is null
    and (m.access_expires_at is null or m.access_expires_at>statement_timestamp())) then
    raise exception 'Choose an active member of this organization' using errcode='42501';
  end if;
  insert into public.rep_sms_rollout_enrollments(org_id,user_id,enabled,enrolled_at,enrolled_by,updated_by)
    values(p_org_id,p_user_id,p_enabled,case when p_enabled then statement_timestamp() end,
      case when p_enabled then v_actor end,v_actor)
  on conflict(org_id,user_id) do update set enabled=excluded.enabled,
    -- Every enable is a new rollout enrollment event. Preserve history in
    -- updated_at/updated_by while stamping the actor that re-enabled access.
    enrolled_at=case when excluded.enabled then excluded.enrolled_at else null end,
    enrolled_by=case when excluded.enabled then excluded.enrolled_by else null end,
    updated_at=statement_timestamp(),updated_by=excluded.updated_by;
  return p_enabled;
end;
$$;
revoke all on function public.fn_set_rep_sms_enrollment(uuid,uuid,boolean) from public,anon,service_role;
grant execute on function public.fn_set_rep_sms_enrollment(uuid,uuid,boolean) to authenticated;

-- Provider-aware overload. The six argument function from 080000 remains a
-- compatibility entry point and delegates to this one for Dialpad.
create or replace function public.fn_set_rep_sms_sender(
  p_org_id uuid,p_user_id uuid,p_provider text,p_phone text,p_provider_account_id text,
  p_provider_sender_id text,p_label text,p_default boolean,p_active boolean
) returns uuid language plpgsql security definer set search_path='' as $$
declare v_actor uuid:=auth.uid(); v_id uuid;
begin
  if v_actor is null or not exists(select 1 from public.memberships m where m.org_id=p_org_id and m.user_id=v_actor
    and m.role='owner' and m.access_status='active' and m.deletion_prepared_at is null
    and (m.access_expires_at is null or m.access_expires_at>statement_timestamp())) then
    raise exception 'Only an active owner can assign texting numbers' using errcode='42501';
  end if;
  if p_provider is null or p_provider !~ '^[a-z][a-z0-9_:-]{1,63}$'
    or p_phone is null or p_phone !~ '^\+[1-9][0-9]{7,14}$'
    or p_label is null or length(btrim(p_label)) not between 1 and 120 then
    raise exception 'INVALID_INPUT' using errcode='22023';
  end if;
  -- Sendillo grants must be bound to the stable account identity returned by
  -- its authoritative sender catalog. A number without that identity cannot
  -- be fenced safely against a cross-account callback or provider resync.
  if p_active and p_provider='sendillo' and nullif(btrim(p_provider_account_id),'') is null then
    raise exception 'SENDILLO_PROVIDER_ACCOUNT_REQUIRED' using errcode='22023';
  end if;
  if p_active and not exists(select 1 from public.memberships m where m.org_id=p_org_id and m.user_id=p_user_id
    and m.access_status='active' and m.deletion_prepared_at is null
    and (m.access_expires_at is null or m.access_expires_at>statement_timestamp())) then
    raise exception 'Choose an active member of this organization' using errcode='42501';
  end if;
  perform pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended(p_org_id::text||p_user_id::text,0));
  if p_default and p_active then
    update public.rep_sms_sender_assignments set is_default=false,updated_at=statement_timestamp(),updated_by=v_actor
      where org_id=p_org_id and user_id=p_user_id and is_default and id is distinct from v_id;
  end if;
  insert into public.rep_sms_sender_assignments(org_id,user_id,provider,phone_e164,label,is_default,active,
      updated_by,provider_account_id,provider_sender_id,grant_status,granted_at,revoked_at,revoked_by)
    values(p_org_id,p_user_id,p_provider,p_phone,btrim(p_label),p_default and p_active,p_active,v_actor,
      nullif(btrim(p_provider_account_id),''),nullif(btrim(p_provider_sender_id),''),
      case when p_active then 'active' else 'revoked' end,statement_timestamp(),
      case when p_active then null else statement_timestamp() end,
      case when p_active then null else v_actor end)
    on conflict(org_id,user_id,provider,phone_e164) do update set label=excluded.label,
      is_default=excluded.is_default,active=excluded.active,updated_by=excluded.updated_by,updated_at=statement_timestamp(),
      provider_account_id=coalesce(excluded.provider_account_id,rep_sms_sender_assignments.provider_account_id),
      provider_sender_id=coalesce(excluded.provider_sender_id,rep_sms_sender_assignments.provider_sender_id),
      grant_status=excluded.grant_status,granted_at=case when excluded.grant_status='active' then statement_timestamp() else rep_sms_sender_assignments.granted_at end,
      revoked_at=case when excluded.grant_status='active' then null else statement_timestamp() end,
      revoked_by=case when excluded.grant_status='active' then null else excluded.revoked_by end
    returning id into v_id;
  if p_active then
    insert into public.rep_sms_rollout_enrollments(org_id,user_id,enabled,enrolled_at,enrolled_by,updated_by)
      values(p_org_id,p_user_id,true,statement_timestamp(),v_actor,v_actor)
    on conflict(org_id,user_id) do update set enabled=true,enrolled_at=statement_timestamp(),enrolled_by=v_actor,
      updated_at=statement_timestamp(),updated_by=v_actor;
  end if;
  return v_id;
end;
$$;
revoke all on function public.fn_set_rep_sms_sender(uuid,uuid,text,text,text,text,text,boolean,boolean) from public,anon,service_role;
grant execute on function public.fn_set_rep_sms_sender(uuid,uuid,text,text,text,text,text,boolean,boolean) to authenticated;

create or replace function public.fn_set_rep_sms_sender(
  p_org_id uuid,p_user_id uuid,p_phone text,p_label text,p_default boolean,p_active boolean
) returns uuid language plpgsql security definer set search_path='' as $$
begin
  return public.fn_set_rep_sms_sender(p_org_id,p_user_id,'dialpad',p_phone,null,null,p_label,p_default,p_active);
end;
$$;
revoke all on function public.fn_set_rep_sms_sender(uuid,uuid,text,text,boolean,boolean) from public,anon,service_role;
grant execute on function public.fn_set_rep_sms_sender(uuid,uuid,text,text,boolean,boolean) to authenticated;

-- Called by the two acquisition attempt RPCs and the explicit no-answer
-- attempt trigger. Provider transport telemetry never chooses an outcome.
-- There is no data backfill: old attempts remain old history, while each
-- newly selected no-answer becomes durable at the attempt boundary.
create or replace function public.fn_ensure_rep_sms_no_answer_obligation(
  p_org_id uuid,p_property_id uuid,p_episode_id uuid,p_attempt_id uuid,p_actor_id uuid,
  p_occurred_at timestamptz,p_input jsonb
) returns uuid language plpgsql security definer set search_path='' as $$
declare v_enrolled boolean; v_sender public.rep_sms_sender_assignments%rowtype;
  v_contact uuid; v_to text; v_state text; v_reason text; v_id uuid;
begin
  if p_actor_id is null or p_attempt_id is null then return null; end if;
  select e.enabled into v_enrolled from public.rep_sms_rollout_enrollments e
    where e.org_id=p_org_id and e.user_id=p_actor_id;
  if coalesce(v_enrolled,false) is not true then return null; end if;
  select s.* into v_sender from public.rep_sms_sender_assignments s
    where s.org_id=p_org_id and s.user_id=p_actor_id and s.active
      and s.grant_status='active' and s.revoked_at is null
      and (s.provider<>'sendillo' or s.provider_account_id is not null)
    order by s.is_default desc,s.label,s.id limit 1;
  select p.homeowner_contact_id into v_contact from public.properties p
    where p.id=p_property_id and p.org_id=p_org_id;
  select coalesce(c.phone_1,c.phone_2,c.phone_3) into v_to from public.contacts c
    where c.id=v_contact and c.org_id=p_org_id;
  if v_sender.id is null then v_state:='blocked'; v_reason:='sender_grant_missing';
  elsif v_to is null or v_to !~ '^\+[1-9][0-9]{7,14}$' then v_state:='blocked'; v_reason:='recipient_missing';
  else v_state:='required'; v_reason:=null;
  end if;
  insert into public.rep_sms_obligations(
  org_id,property_id,assignment_episode_id,attempt_id,actor_user_id,provider,provider_account_id,sender_assignment_id,
    from_number,to_number,message_body,composition,state,blocked_reason,next_attempt_at
  ) values(
    p_org_id,p_property_id,p_episode_id,p_attempt_id,p_actor_id,v_sender.provider,v_sender.provider_account_id,v_sender.id,
    v_sender.phone_e164,v_to,nullif(btrim(p_input->>'smsBody'),''),
    case when jsonb_typeof(p_input->'followUp')='object' then p_input->'followUp' else '{}'::jsonb end,
    v_state,v_reason,statement_timestamp()
  ) on conflict(org_id,attempt_id,obligation_kind) do nothing returning id into v_id;
  return v_id;
end;
$$;
revoke all on function public.fn_ensure_rep_sms_no_answer_obligation(uuid,uuid,uuid,uuid,uuid,timestamptz,jsonb) from public,anon,authenticated,service_role;

-- A browser submission names one exact obligation. Claiming a batch here would
-- allow a racing submission to send a different rep's work, so this RPC locks
-- only the requested row and binds/authorizes it in the same transaction.
-- The former batch-claim and separate authorize RPCs are intentionally not
-- part of the public contract. They could claim a row without the complete
-- lead/grant validation performed below, and no application caller uses them.
drop function if exists public.fn_claim_rep_sms_obligations(uuid,integer,uuid);
drop function if exists public.fn_authorize_rep_sms_obligation(uuid,uuid);

create or replace function public.fn_claim_authorize_rep_sms_obligation(
  p_org_id uuid,p_obligation_id uuid,p_actor_id uuid,p_composition jsonb
) returns jsonb language plpgsql security definer set search_path='' as $$
declare
  v_o public.rep_sms_obligations%rowtype;
  v_property public.properties%rowtype;
  v_contact uuid;
  v_now timestamptz:=statement_timestamp();
  v_reason text;
  v_token uuid;
begin
  if auth.uid() is not null then
    raise exception 'Worker authorization is service-only' using errcode='42501';
  end if;
  if p_org_id is null or p_obligation_id is null or p_actor_id is null
    or p_composition is null or jsonb_typeof(p_composition)<>'object' then
    raise exception 'INVALID_INPUT' using errcode='22023';
  end if;
  if nullif(btrim(p_composition->>'body'),'') is null
    or nullif(btrim(p_composition->>'introId'),'') is null
    or nullif(btrim(p_composition->>'templateId'),'') is null then
    raise exception 'INVALID_INPUT' using errcode='22023';
  end if;
  select * into v_o from public.rep_sms_obligations
    where id=p_obligation_id and org_id=p_org_id for update;
  if not found then raise exception 'FORBIDDEN' using errcode='42501'; end if;
  if v_o.actor_user_id is distinct from p_actor_id then
    raise exception 'FORBIDDEN' using errcode='42501';
  end if;
  if not exists(select 1 from public.memberships m where m.org_id=p_org_id and m.user_id=p_actor_id
    and m.access_status='active' and m.deletion_prepared_at is null
    and (m.access_expires_at is null or m.access_expires_at>v_now)) then
    raise exception 'FORBIDDEN' using errcode='42501';
  end if;

  -- Expiry is fenced before any new claim. A lease that reached sending is
  -- ambiguous because the provider may have received the request; a lease
  -- still in claimed is proven to have no provider request yet.
  if v_o.claim_state='claimed' and v_o.lease_expires_at<=v_now then
    update public.rep_sms_obligations set state=case when v_o.state='sending' then 'unknown' else 'failed_not_dispatched' end,
      claim_state='unclaimed',claim_token=null,claimed_by=null,claimed_at=null,lease_expires_at=null,
      last_error='obligation claim lease expired',next_attempt_at=v_now where id=v_o.id;
    insert into public.rep_sms_obligation_audit(org_id,obligation_id,actor_kind,action,from_state,to_state,reason)
      values(v_o.org_id,v_o.id,'system','lease_expired',v_o.state,
        case when v_o.state='sending' then 'unknown' else 'failed_not_dispatched' end,'worker lease expired');
    return jsonb_build_object('ok',false,'obligationId',v_o.id,
      'state',case when v_o.state='sending' then 'unknown' else 'failed_not_dispatched' end,
      'reason','lease_expired');
  end if;

  -- A completed or explicitly blocked obligation is returned as-is so a
  -- duplicate form submission never dispatches a second provider request.
  if v_o.state in ('accepted','delivered','blocked','unknown','delivery_failed','voided','exception_closed') then
    return jsonb_build_object('ok',false,'obligationId',v_o.id,'state',v_o.state,
      'reason',coalesce(v_o.blocked_reason,v_o.last_error));
  end if;
  if v_o.claim_state='claimed' or v_o.state='sending' then
    return jsonb_build_object('ok',false,'obligationId',v_o.id,'state',v_o.state,
      'reason','already_in_progress');
  end if;
  if v_o.state not in ('required','draft','failed_not_dispatched') then
    return jsonb_build_object('ok',false,'obligationId',v_o.id,'state',v_o.state,
      'reason','not_claimable');
  end if;

  select * into v_property from public.properties p
    where p.id=v_o.property_id and p.org_id=p_org_id for update;
  if not found or v_property.deleted_at is not null or v_property.is_dnc_locked
    or v_property.assigned_user_id is distinct from p_actor_id then
    v_reason:='current_assignment_changed';
  elsif not exists(select 1 from public.acquisition_assignment_episodes e
    where e.id=v_o.assignment_episode_id and e.org_id=p_org_id and e.property_id=v_o.property_id
      and e.assignee_user_id=p_actor_id and e.ended_at is null) then
    v_reason:='current_assignment_changed';
  elsif not exists(select 1 from public.rep_sms_rollout_enrollments e
    where e.org_id=p_org_id and e.user_id=p_actor_id and e.enabled) then
    v_reason:='rollout_not_enabled';
  elsif not exists(select 1 from public.rep_sms_sender_assignments s
    where s.id=v_o.sender_assignment_id and s.org_id=p_org_id and s.user_id=p_actor_id
      and s.active and s.grant_status='active' and s.revoked_at is null
      and s.provider=v_o.provider and s.provider_account_id is not null
      and s.provider_account_id=v_o.provider_account_id) then
    v_reason:='sender_grant_missing';
  else
    select p.homeowner_contact_id into v_contact from public.properties p
      where p.id=v_o.property_id and p.org_id=p_org_id;
    if v_contact is null or not exists(select 1 from public.contacts c
      cross join lateral unnest(array[c.phone_1,c.phone_2,c.phone_3]) as phone(phone_e164)
      where c.id=v_contact and c.org_id=p_org_id
        and phone.phone_e164 is not null and phone.phone_e164=v_o.to_number) then
      v_reason:='recipient_changed';
    end if;
  end if;
  if v_reason is not null then
    update public.rep_sms_obligations set state='blocked',blocked_reason=v_reason,
      claim_state='unclaimed',claim_token=null,claimed_by=null,claimed_at=null,lease_expires_at=null,
      next_attempt_at=v_now where id=v_o.id;
    insert into public.rep_sms_obligation_audit(org_id,obligation_id,actor_kind,action,from_state,to_state,reason)
      values(v_o.org_id,v_o.id,'service','claim_authorize_block',v_o.state,'blocked',v_reason);
    return jsonb_build_object('ok',false,'obligationId',v_o.id,'state','blocked','reason',v_reason);
  end if;

  v_token:=extensions.gen_random_uuid();
  update public.rep_sms_obligations set message_body=nullif(btrim(p_composition->>'body'),''),
    composition=p_composition,state='sending',claim_state='claimed',claim_token=v_token,
    claim_generation=claim_generation+1,claimed_by=p_actor_id,claimed_at=v_now,
    lease_expires_at=v_now+interval '5 minutes',authorized_at=v_now,next_attempt_at=v_now
    where id=v_o.id;
  insert into public.rep_sms_obligation_audit(org_id,obligation_id,actor_kind,actor_user_id,action,from_state,to_state,reason,metadata)
    values(v_o.org_id,v_o.id,'service',p_actor_id,'claim_authorize',v_o.state,'sending',null,p_composition);
  return jsonb_build_object('ok',true,'obligationId',v_o.id,'state','sending','claimToken',v_token,
    'claimGeneration',v_o.claim_generation+1,'assignmentId',v_o.sender_assignment_id,
    'provider',v_o.provider,'providerAccountId',v_o.provider_account_id,
    'fromNumber',v_o.from_number,'toNumber',v_o.to_number,'body',p_composition->>'body',
    'composition',p_composition);
end;
$$;
revoke all on function public.fn_claim_authorize_rep_sms_obligation(uuid,uuid,uuid,jsonb)
  from public,anon,authenticated;
grant execute on function public.fn_claim_authorize_rep_sms_obligation(uuid,uuid,uuid,jsonb)
  to service_role;

-- This is the last database-side fence before the provider request. The
-- caller must prove it still owns the exact sending claim it authorized, and
-- the lead, assignment, grant and provider identity must all still match.
-- Returning success also leaves an immutable audit breadcrumb so an operator
-- can distinguish a send that crossed this fence from a pre-fence block.
create or replace function public.fn_assert_rep_sms_obligation_dispatch(
  p_obligation_id uuid,p_claim_token uuid,p_claim_generation bigint,p_actor_id uuid
) returns jsonb language plpgsql security definer set search_path='' as $$
declare
  v_o public.rep_sms_obligations%rowtype;
  v_property public.properties%rowtype;
  v_sender public.rep_sms_sender_assignments%rowtype;
  v_contact public.contacts%rowtype;
  v_now timestamptz:=statement_timestamp();
  v_reason text;
  v_audit_id uuid;
begin
  if auth.uid() is not null then
    raise exception 'Worker dispatch fences are service-only' using errcode='42501';
  end if;
  if p_obligation_id is null or p_claim_token is null or p_claim_generation is null or p_actor_id is null then
    raise exception 'INVALID_INPUT' using errcode='22023';
  end if;

  select * into v_o from public.rep_sms_obligations
    where id=p_obligation_id for update;
  if not found or v_o.state<>'sending' or v_o.claim_state<>'claimed'
    or v_o.claim_token is distinct from p_claim_token
    or v_o.claim_generation is distinct from p_claim_generation
    or v_o.claimed_by is distinct from p_actor_id
    or v_o.lease_expires_at is null or v_o.lease_expires_at<=v_now then
    raise exception 'STALE_CLAIM' using errcode='40001';
  end if;
  if v_o.actor_user_id is distinct from p_actor_id then
    raise exception 'FORBIDDEN' using errcode='42501';
  end if;

  select * into v_property from public.properties p
    where p.id=v_o.property_id and p.org_id=v_o.org_id for update;
  if not found or v_property.deleted_at is not null or v_property.is_dnc_locked
    or v_property.assigned_user_id is distinct from p_actor_id then
    v_reason:='current_assignment_changed';
  elsif not exists(select 1 from public.memberships m
    where m.org_id=v_o.org_id and m.user_id=p_actor_id
      and m.access_status='active' and m.deletion_prepared_at is null
      and (m.access_expires_at is null or m.access_expires_at>v_now)
      and coalesce(m.acquisitions_enabled,false)) then
    v_reason:='membership_or_acquisitions_disabled';
  elsif not exists(select 1 from public.rep_sms_rollout_enrollments e
    where e.org_id=v_o.org_id and e.user_id=p_actor_id and e.enabled) then
    v_reason:='rollout_not_enabled';
  elsif not exists(select 1 from public.acquisition_assignment_episodes e
    where e.id=v_o.assignment_episode_id and e.org_id=v_o.org_id and e.property_id=v_o.property_id
      and e.assignee_user_id=p_actor_id and e.ended_at is null) then
    v_reason:='current_assignment_changed';
  elsif not exists(select 1 from public.rep_sms_sender_assignments s
    where s.id=v_o.sender_assignment_id and s.org_id=v_o.org_id and s.user_id=p_actor_id
      and s.active and s.grant_status='active' and s.revoked_at is null
      and s.provider=v_o.provider and s.provider_account_id=v_o.provider_account_id
      and s.phone_e164=v_o.from_number) then
    v_reason:='sender_grant_missing';
  elsif v_o.provider is null or v_o.provider_account_id is null
    or v_o.from_number is null or v_o.to_number is null then
    v_reason:='provider_identity_missing';
  else
    select * into v_contact from public.contacts c
      where c.id=v_property.homeowner_contact_id and c.org_id=v_o.org_id;
    if not found or not exists(
      select 1
      from unnest(array[v_contact.phone_1,v_contact.phone_2,v_contact.phone_3]) as phone(phone_e164)
      where phone.phone_e164 is not null and phone.phone_e164=v_o.to_number
    )
      or v_o.to_number !~ '^\+[1-9][0-9]{7,14}$' then
      v_reason:='recipient_changed';
    end if;
  end if;
  if v_reason is not null then
    raise exception 'DISPATCH_FENCE_REJECTED: %',v_reason using errcode='42501';
  end if;

  insert into public.rep_sms_obligation_audit(
    org_id,obligation_id,actor_kind,actor_user_id,action,from_state,to_state,reason,metadata
  ) values(
    v_o.org_id,v_o.id,'service',p_actor_id,'dispatch_fence','sending','sending',null,
    jsonb_build_object('claimGeneration',p_claim_generation,'provider',v_o.provider,
      'providerAccountId',v_o.provider_account_id,'senderAssignmentId',v_o.sender_assignment_id,
      'fromNumber',v_o.from_number,'toNumber',v_o.to_number)
  ) returning id into v_audit_id;
  return jsonb_build_object('ok',true,'obligationId',v_o.id,'state','sending','claimToken',v_o.claim_token,
    'claimGeneration',v_o.claim_generation,'actorId',p_actor_id,'provider',v_o.provider,
    'providerAccountId',v_o.provider_account_id,'assignmentId',v_o.sender_assignment_id,
    'fromNumber',v_o.from_number,'toNumber',v_o.to_number,'body',v_o.message_body,
    'auditId',v_audit_id);
end;
$$;
revoke all on function public.fn_assert_rep_sms_obligation_dispatch(uuid,uuid,bigint,uuid)
  from public,anon,authenticated;
grant execute on function public.fn_assert_rep_sms_obligation_dispatch(uuid,uuid,bigint,uuid)
  to service_role;

create or replace function public.fn_record_rep_sms_obligation_result(
  p_obligation_id uuid,p_claim_token uuid,p_state text,p_provider_message_id text default null,
  p_provider_status text default null,p_provider_error text default null,p_retry_at timestamptz default null,
  p_metadata jsonb default '{}'::jsonb
) returns jsonb language plpgsql security definer set search_path='' as $$
declare v_o public.rep_sms_obligations%rowtype; v_now timestamptz:=statement_timestamp(); v_id text;
  v_claim_state text; v_accepted timestamptz; v_delivered timestamptz; v_resolved timestamptz;
begin
  if auth.uid() is not null then raise exception 'Worker results are service-only' using errcode='42501'; end if;
  if p_state not in ('accepted','blocked','failed_not_dispatched','unknown','delivery_failed') then
    raise exception 'INVALID_INPUT' using errcode='22023';
  end if;
  select * into v_o from public.rep_sms_obligations where id=p_obligation_id for update;
  if not found then
    raise exception 'STALE_CLAIM' using errcode='40001';
  end if;
  -- A provider callback may win the race and settle the row before the send
  -- worker records its accepted response. Treat that exact accepted result as
  -- an idempotent acknowledgement; never regress the already-settled state.
  if v_o.state in ('delivered','delivery_failed') and p_state='accepted'
    and v_o.claim_token is not distinct from p_claim_token
    and nullif(btrim(p_provider_message_id),'') is not null
    and v_o.provider_message_id is not distinct from nullif(btrim(p_provider_message_id),'') then
    return jsonb_build_object('ok',true,'obligationId',v_o.id,'state',v_o.state,'duplicate',true,
      'claimGeneration',v_o.claim_generation);
  end if;
  if v_o.state<>'sending' or v_o.claim_state<>'claimed' or v_o.claim_token is distinct from p_claim_token
    or v_o.lease_expires_at<=v_now then
    raise exception 'STALE_CLAIM' using errcode='40001';
  end if;
  if p_state='accepted' and nullif(btrim(p_provider_message_id),'') is null then
    raise exception 'ACCEPTED_REQUIRES_PROVIDER_ID' using errcode='22023';
  end if;
  if p_state='accepted' and v_o.provider_account_id is null then
    raise exception 'ACCEPTED_REQUIRES_PROVIDER_ACCOUNT' using errcode='22023';
  end if;
  if p_state in ('blocked','failed_not_dispatched','delivery_failed') and nullif(btrim(coalesce(p_provider_error,'')),'') is null then
    raise exception 'FAILURE_REQUIRES_REASON' using errcode='22023';
  end if;
  v_id:=nullif(btrim(coalesce(p_provider_message_id,v_o.provider_message_id,'')),'');
  -- Provider message ids are global within a provider account. Return a
  -- deterministic collision result before the unique index can abort the
  -- worker transaction and leave callback reconciliation ambiguous.
  if p_state='accepted' and exists(
    select 1 from public.rep_sms_obligations other
    where other.provider is not distinct from v_o.provider
      and other.provider_account_id=v_o.provider_account_id
      and other.provider_message_id=v_id
      and other.id is distinct from v_o.id
  ) then
    return jsonb_build_object('ok',false,'obligationId',v_o.id,'state',v_o.state,
      'reason','provider_message_id_already_bound','providerMessageIdAlreadyBound',true);
  end if;
  v_claim_state:=case when p_state='accepted' then 'complete' else 'unclaimed' end;
  v_accepted:=case when p_state='accepted' then v_now else v_o.accepted_at end;
  v_delivered:=v_o.delivered_at;
  v_resolved:=case when p_state='accepted' then v_now else v_o.resolved_at end;
  update public.rep_sms_obligations set state=p_state,provider_message_id=v_id,
    provider_status=coalesce(nullif(btrim(p_provider_status),''),provider_status),
    provider_error=coalesce(nullif(btrim(p_provider_error),''),provider_error),
    last_error=coalesce(nullif(btrim(p_provider_error),''),last_error),
    claim_state=v_claim_state,claimed_by=case when v_claim_state='complete' then claimed_by else null end,
    claimed_at=case when v_claim_state='complete' then claimed_at else null end,
    lease_expires_at=case when v_claim_state='complete' then lease_expires_at else null end,
    claim_token=case when v_claim_state='complete' then claim_token else null end,
    accepted_at=v_accepted,delivered_at=v_delivered,resolved_at=v_resolved,
    next_attempt_at=case when v_claim_state='unclaimed' then coalesce(p_retry_at,v_now+interval '5 minutes') else next_attempt_at end
    where id=v_o.id;
  insert into public.rep_sms_obligation_audit(org_id,obligation_id,actor_kind,action,from_state,to_state,reason,metadata)
    values(v_o.org_id,v_o.id,'service','provider_result',v_o.state,p_state,p_provider_error,coalesce(p_metadata,'{}'::jsonb));
  return jsonb_build_object('ok',true,'obligationId',v_o.id,'state',p_state,'claimGeneration',v_o.claim_generation);
end;
$$;
revoke all on function public.fn_record_rep_sms_obligation_result(uuid,uuid,text,text,text,text,timestamptz,jsonb) from public,anon,authenticated;
grant execute on function public.fn_record_rep_sms_obligation_result(uuid,uuid,text,text,text,text,timestamptz,jsonb) to service_role;

-- Delivery callbacks normally find the obligation by the provider's external
-- id. A provider can, however, deliver the callback between the send request
-- returning and fn_record_rep_sms_obligation_result persisting that id. The
-- extended service-only overload accepts the exact fenced obligation and
-- tenant in that window, verifies provider/account identity, binds the
-- external id once, and then applies the same idempotent terminal transition.
-- Keep one PostgREST-visible function signature. An old seven-argument
-- overload would be ambiguous whenever the provider callback omits the two
-- optional exact-identity arguments.
drop function if exists public.fn_record_rep_sms_delivery(text,text,text,text,text,text,jsonb);
create or replace function public.fn_record_rep_sms_delivery(
  p_provider text,p_provider_account_id text,p_provider_message_id text,p_state text,p_provider_status text default null,
  p_provider_error text default null,p_metadata jsonb default '{}'::jsonb,
  p_org_id uuid default null,p_obligation_id uuid default null
) returns jsonb language plpgsql security definer set search_path='' as $$
declare
  v_o public.rep_sms_obligations%rowtype;
  v_now timestamptz:=statement_timestamp();
  v_provider text:=nullif(btrim(p_provider),'');
  v_provider_account_id text:=nullif(btrim(p_provider_account_id),'');
  v_provider_message_id text:=nullif(btrim(p_provider_message_id),'');
  v_message_org_id text:=nullif(btrim(coalesce(p_metadata,'{}'::jsonb)->>'messageOrgId'),'');
  v_exact boolean:=p_org_id is not null or p_obligation_id is not null;
begin
  if auth.uid() is not null then
    raise exception 'Provider callbacks are service-only' using errcode='42501';
  end if;
  if v_provider is null or v_provider_account_id is null or v_provider_message_id is null
    or p_state not in ('delivered','delivery_failed','unknown') then
    raise exception 'INVALID_INPUT' using errcode='22023';
  end if;
  if v_exact and (p_org_id is null or p_obligation_id is null) then
    raise exception 'EXACT_OBLIGATION_REQUIRES_ORG' using errcode='22023';
  end if;

  if v_exact then
    select * into v_o from public.rep_sms_obligations
      where id=p_obligation_id and org_id=p_org_id for update;
    if not found then
      return jsonb_build_object('ok',false,'matched',false,'reason','obligation_not_found');
    end if;
    if lower(v_o.provider) is distinct from lower(v_provider)
      or v_o.provider_account_id is distinct from v_provider_account_id then
      return jsonb_build_object('ok',false,'matched',false,'identityMismatch',true);
    end if;
    if v_message_org_id is not null and v_message_org_id<>p_org_id::text then
      return jsonb_build_object('ok',false,'matched',false,'tenantMismatch',true);
    end if;
    if v_o.provider_message_id is not null
      and v_o.provider_message_id is distinct from v_provider_message_id then
      return jsonb_build_object('ok',false,'matched',false,'messageIdMismatch',true);
    end if;
    if exists(
      select 1 from public.rep_sms_obligations other
      where other.org_id=p_org_id and other.provider=v_o.provider
        and other.provider_account_id=v_provider_account_id
        and other.provider_message_id=v_provider_message_id
        and other.id is distinct from v_o.id
    ) then
      return jsonb_build_object('ok',false,'matched',false,'messageIdAlreadyBound',true);
    end if;
    if v_o.provider_message_id is null then
      update public.rep_sms_obligations
        set provider_message_id=v_provider_message_id
        where id=v_o.id;
      v_o.provider_message_id:=v_provider_message_id;
    end if;
  else
    select * into v_o from public.rep_sms_obligations
      where provider=v_provider and provider_account_id=v_provider_account_id
        and provider_message_id=v_provider_message_id for update;
    if not found then return jsonb_build_object('ok',false,'matched',false); end if;
    -- The webhook handler obtains messageOrgId from the stored outbound row.
    -- Keep this tenant check for the legacy external-id lookup as well.
    if v_message_org_id is not null and v_message_org_id<>v_o.org_id::text then
      return jsonb_build_object('ok',false,'matched',false,'tenantMismatch',true);
    end if;
  end if;

  -- Replays after a terminal provider callback are successful no-ops. A
  -- callback must never regress delivered or delivery_failed.
  if v_o.state in ('delivered','delivery_failed') then
    return jsonb_build_object('ok',true,'matched',true,'state',v_o.state,'duplicate',true);
  end if;
  -- Only a provider-accepted, ambiguous, or in-flight send can be settled by
  -- a delivery callback. A blocked/proven-non-dispatched row indicates a
  -- mismatched callback and stays retryable for operator inspection.
  if v_o.state not in ('sending','accepted','unknown') then
    return jsonb_build_object('ok',false,'matched',true,'state',v_o.state,'reason','callback_state_not_settleable');
  end if;
  if p_state='delivery_failed' and nullif(btrim(p_provider_error),'') is null then
    raise exception 'FAILURE_REQUIRES_REASON' using errcode='22023';
  end if;
  update public.rep_sms_obligations set state=p_state,
    provider_message_id=v_provider_message_id,
    provider_status=coalesce(nullif(btrim(p_provider_status),''),provider_status),
    provider_error=coalesce(nullif(btrim(p_provider_error),''),provider_error),
    last_error=coalesce(nullif(btrim(p_provider_error),''),last_error),
    claim_state=case when p_state='delivered' then 'complete' else 'unclaimed' end,
    claim_token=case when p_state='delivered' then coalesce(claim_token,extensions.gen_random_uuid()) else null end,
    claimed_by=case when p_state='delivered' then claimed_by else null end,
    claimed_at=case when p_state='delivered' then claimed_at else null end,
    lease_expires_at=case when p_state='delivered' then lease_expires_at else null end,
    accepted_at=case when p_state='delivered' then coalesce(accepted_at,v_now) else accepted_at end,
    delivered_at=case when p_state='delivered' then v_now else delivered_at end,
    resolved_at=case when p_state='delivered' then v_now else null end,
    next_attempt_at=case when p_state='delivered' then next_attempt_at else v_now+interval '5 minutes' end
    where id=v_o.id;
  insert into public.rep_sms_obligation_audit(org_id,obligation_id,actor_kind,action,from_state,to_state,reason,metadata)
    values(v_o.org_id,v_o.id,'service','provider_delivery',v_o.state,p_state,p_provider_error,
      jsonb_build_object('exactObligationLookup',v_exact)||coalesce(p_metadata,'{}'::jsonb));
  return jsonb_build_object('ok',true,'matched',true,'state',p_state,'obligationId',v_o.id);
end;
$$;
revoke all on function public.fn_record_rep_sms_delivery(text,text,text,text,text,text,jsonb,uuid,uuid)
  from public,anon,authenticated;
grant execute on function public.fn_record_rep_sms_delivery(text,text,text,text,text,text,jsonb,uuid,uuid)
  to service_role;

create or replace function public.fn_owner_correct_rep_sms_obligation(
  p_obligation_id uuid,p_action text,p_reason text
) returns jsonb language plpgsql security definer set search_path='' as $$
declare v_actor uuid:=auth.uid(); v_o public.rep_sms_obligations%rowtype; v_state text; v_enabled boolean; v_has_grant boolean;
begin
  if v_actor is null or p_reason is null or length(btrim(p_reason))<3 then
    raise exception 'INVALID_INPUT' using errcode='22023';
  end if;
  select * into v_o from public.rep_sms_obligations where id=p_obligation_id for update;
  if not found or not exists(select 1 from public.memberships m where m.org_id=v_o.org_id and m.user_id=v_actor
    and m.role='owner' and m.access_status='active' and m.deletion_prepared_at is null
    and (m.access_expires_at is null or m.access_expires_at>statement_timestamp())) then
    raise exception 'FORBIDDEN' using errcode='42501';
  end if;
  if p_action not in ('void','retry','unblock','exception') then raise exception 'INVALID_INPUT' using errcode='22023'; end if;
  if p_action='retry' and v_o.state not in ('failed_not_dispatched','blocked','draft','required') then
    raise exception 'INVALID_OBLIGATION_TRANSITION' using errcode='40001';
  end if;
  if p_action='void' then v_state:='voided';
  elsif p_action='exception' then v_state:='exception_closed';
  elsif p_action='retry' then v_state:='draft';
  else
    if v_o.state<>'blocked' then
      raise exception 'INVALID_OBLIGATION_TRANSITION' using errcode='40001';
    end if;
    select exists(select 1 from public.rep_sms_rollout_enrollments e where e.org_id=v_o.org_id and e.user_id=v_o.actor_user_id and e.enabled),
      exists(select 1 from public.rep_sms_sender_assignments s where s.id=v_o.sender_assignment_id and s.org_id=v_o.org_id
        and s.user_id=v_o.actor_user_id and s.active and s.grant_status='active' and s.revoked_at is null
        and (s.provider<>'sendillo' or s.provider_account_id is not null))
      into v_enabled,v_has_grant;
    if not v_enabled or not v_has_grant then raise exception 'SENDER_GRANT_MISSING' using errcode='42501'; end if;
    v_state:='draft';
  end if;
  update public.rep_sms_obligations set state=v_state,claim_state=case when v_state in ('voided','exception_closed') then 'complete' else 'unclaimed' end,
    claim_token=case when v_state in ('voided','exception_closed') then coalesce(claim_token,extensions.gen_random_uuid()) else null end,
    claimed_by=case when v_state in ('voided','exception_closed') then claimed_by else null end,
    claimed_at=case when v_state in ('voided','exception_closed') then claimed_at else null end,
    lease_expires_at=case when v_state in ('voided','exception_closed') then lease_expires_at else null end,
    blocked_reason=case when v_state='draft' then null else blocked_reason end,
    next_attempt_at=statement_timestamp(),resolved_at=case when v_state in ('voided','exception_closed') then statement_timestamp() else null end
    where id=v_o.id;
  insert into public.rep_sms_obligation_audit(org_id,obligation_id,actor_kind,actor_user_id,action,from_state,to_state,reason)
    values(v_o.org_id,v_o.id,'user',v_actor,'owner_correction',v_o.state,v_state,btrim(p_reason));
  return jsonb_build_object('ok',true,'obligationId',v_o.id,'state',v_state);
end;
$$;
revoke all on function public.fn_owner_correct_rep_sms_obligation(uuid,text,text) from public,anon,service_role;
grant execute on function public.fn_owner_correct_rep_sms_obligation(uuid,text,text) to authenticated;

-- Read context through the same DB enrollment and grant predicates used by
-- obligation creation. This replaces the 080000 function after that file is
-- applied and remains compatible with its existing JSON keys.
create or replace function public.fn_get_rep_sms_context(p_property_id uuid)
returns jsonb language plpgsql security definer set search_path='' as $$
declare v_org uuid; v_contact uuid; v_enrolled boolean:=false; v_senders jsonb;
begin
  select p.org_id,p.homeowner_contact_id into v_org,v_contact from public.properties p where p.id=p_property_id;
  if v_org is null or auth.uid() is null then raise exception 'Lead unavailable' using errcode='42501'; end if;
  perform public.my_leads_require_read_scope(v_org,auth.uid());
  if not exists(select 1 from public.memberships m where m.org_id=v_org and m.user_id=auth.uid()
    and (m.acquisitions_enabled or m.role='owner')) then raise exception 'Acquisitions access required' using errcode='42501'; end if;
  if not exists(select 1 from public.my_leads_queue_rows(v_org,auth.uid(),statement_timestamp()) q where q.property_id=p_property_id) then
    raise exception 'You can text only leads currently in your queue' using errcode='42501';
  end if;
  select coalesce(e.enabled,false) into v_enrolled from public.rep_sms_rollout_enrollments e where e.org_id=v_org and e.user_id=auth.uid();
  select coalesce(jsonb_agg(jsonb_build_object('id',s.id,'number',s.phone_e164,'label',s.label,'isDefault',s.is_default,
    'provider',s.provider,'providerAccountId',s.provider_account_id,'providerSenderId',s.provider_sender_id,
    'compositionPolicyVersion',s.composition_policy_version,'grantStatus',s.grant_status,
    'grantedAt',s.granted_at,'revokedAt',s.revoked_at)
    order by s.is_default desc,s.label,s.id),'[]'::jsonb) into v_senders
    from public.rep_sms_sender_assignments s where v_enrolled and s.org_id=v_org and s.user_id=auth.uid()
      and s.active and s.grant_status='active' and s.revoked_at is null;
  return jsonb_build_object('orgId',v_org,'actorId',auth.uid(),'contactId',v_contact,'enrolled',v_enrolled,'senders',v_senders);
end;
$$;
revoke all on function public.fn_get_rep_sms_context(uuid) from public,anon;
grant execute on function public.fn_get_rep_sms_context(uuid) to authenticated;

-- Preserve the already deployed acquisition validation and idempotency logic
-- behind private compatibility names, then add the obligation write at the
-- same authenticated RPC boundary. A duplicate receipt from before this
-- migration is returned untouched, so this is not a historical backfill.
alter function public.fn_log_acquisition_attempt(jsonb)
  rename to fn_log_acquisition_attempt_without_sms_obligation;
revoke all on function public.fn_log_acquisition_attempt_without_sms_obligation(jsonb)
  from public,anon,authenticated,service_role;

create or replace function public.fn_log_acquisition_attempt(p_input jsonb)
returns jsonb language plpgsql security definer set search_path='' as $$
declare v_result jsonb; v_attempt uuid; v_org uuid; v_episode uuid; v_actor uuid:=auth.uid(); v_obligation uuid;
begin
  v_result:=public.fn_log_acquisition_attempt_without_sms_obligation(p_input);
  if coalesce((v_result->>'duplicate')::boolean,false) then
    v_attempt:=(v_result->>'attemptId')::uuid;
    v_org:=(p_input->>'orgId')::uuid;
    select o.id into v_obligation from public.rep_sms_obligations o
      where o.org_id=v_org and o.attempt_id=v_attempt and o.obligation_kind='no_answer_sms';
    return jsonb_set(v_result,'{obligationId}',coalesce(to_jsonb(v_obligation),'null'::jsonb),true);
  end if;
  if p_input->>'outcome'='no_answer' then
    v_attempt:=(v_result->>'attemptId')::uuid;
    v_org:=(select p.org_id from public.properties p where p.id=(p_input->>'propertyId')::uuid);
    v_episode:=(v_result->>'assignmentEpisodeId')::uuid;
    v_obligation:=public.fn_ensure_rep_sms_no_answer_obligation(v_org,(p_input->>'propertyId')::uuid,v_episode,v_attempt,
      v_actor,(p_input->>'occurredAt')::timestamptz,p_input);
    v_result:=jsonb_set(v_result,'{obligationId}',coalesce(to_jsonb(v_obligation),'null'::jsonb),true);
  end if;
  return v_result;
end;
$$;
revoke all on function public.fn_log_acquisition_attempt(jsonb) from public,anon,service_role;
grant execute on function public.fn_log_acquisition_attempt(jsonb) to authenticated;

alter function public.fn_finalize_acquisition_attempt(jsonb)
  rename to fn_finalize_acquisition_attempt_without_sms_obligation;
revoke all on function public.fn_finalize_acquisition_attempt_without_sms_obligation(jsonb)
  from public,anon,authenticated,service_role;

create or replace function public.fn_finalize_acquisition_attempt(p_input jsonb)
returns jsonb language plpgsql security definer set search_path='' as $$
declare v_result jsonb; v_attempt public.acquisition_attempts%rowtype; v_org uuid; v_episode uuid; v_actor uuid:=auth.uid(); v_obligation uuid;
begin
  v_result:=public.fn_finalize_acquisition_attempt_without_sms_obligation(p_input);
  if coalesce((v_result->>'duplicate')::boolean,false) then
    v_org:=(p_input->>'orgId')::uuid;
    select o.id into v_obligation from public.rep_sms_obligations o
      where o.org_id=v_org and o.attempt_id=(v_result->>'attemptId')::uuid and o.obligation_kind='no_answer_sms';
    return jsonb_set(v_result,'{obligationId}',coalesce(to_jsonb(v_obligation),'null'::jsonb),true);
  end if;
  if p_input->>'outcome'='no_answer' then
    v_org:=(p_input->>'orgId')::uuid;
    select * into v_attempt from public.acquisition_attempts where id=(v_result->>'attemptId')::uuid and org_id=v_org;
    v_episode:=v_attempt.assignment_episode_id;
    v_obligation:=public.fn_ensure_rep_sms_no_answer_obligation(v_org,v_attempt.property_id,v_episode,v_attempt.id,v_actor,
      coalesce(v_attempt.occurred_at,(p_input->>'occurredAt')::timestamptz),p_input);
    v_result:=jsonb_set(v_result,'{obligationId}',coalesce(to_jsonb(v_obligation),'null'::jsonb),true);
  end if;
  return v_result;
end;
$$;
revoke all on function public.fn_finalize_acquisition_attempt(jsonb) from public,anon,service_role;
grant execute on function public.fn_finalize_acquisition_attempt(jsonb) to authenticated;

-- Compatibility helper: this overload is intentionally separate from the
-- public six-argument setter, so provider identity cannot be smuggled through
-- arbitrary JSON or a browser-side table write.
comment on table public.rep_sms_obligations is
  'Durable no-answer follow-up obligations. Empty at migration install; new rows are created by authenticated attempt RPCs or provider reconciliation for enrolled reps.';
comment on table public.rep_sms_obligation_audit is
  'Append-only audit of provider outcomes and owner corrections/exceptions for rep SMS obligations.';

commit;
