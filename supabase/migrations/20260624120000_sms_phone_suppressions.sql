-- Durable phone-level SMS suppression.
--
-- STOP/DNC and explicit wrong-number-for-everything signals must outlive the
-- current contact row snapshot. A later import with the same phone must still
-- be blocked before any queued row, message insert, or provider call.

create table if not exists public.sms_phone_suppressions (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null default '00000000-0000-0000-0000-000000000bbb' references public.organizations(id),
  channel text not null default 'sms',
  phone_e164 text not null,
  source text not null,
  source_detail jsonb,
  first_contact_id uuid references public.contacts(id) on delete set null,
  provider text,
  suppressed_at timestamptz not null default now(),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint sms_phone_suppressions_channel_check check (channel = 'sms'),
  constraint sms_phone_suppressions_phone_e164_check check (phone_e164 ~ '^\\+[1-9][0-9]{7,14}$')
);

create unique index if not exists idx_sms_phone_suppressions_channel_phone
  on public.sms_phone_suppressions(channel, phone_e164);

create index if not exists idx_sms_phone_suppressions_phone
  on public.sms_phone_suppressions(phone_e164);

create index if not exists idx_sms_phone_suppressions_org
  on public.sms_phone_suppressions(org_id);

alter table public.sms_phone_suppressions enable row level security;

drop policy if exists sms_phone_suppressions_authenticated_select on public.sms_phone_suppressions;
create policy sms_phone_suppressions_authenticated_select
  on public.sms_phone_suppressions
  for select
  to authenticated
  using (org_id in (select org_id from public.memberships where user_id = auth.uid()));

drop policy if exists sms_phone_suppressions_authenticated_insert on public.sms_phone_suppressions;
create policy sms_phone_suppressions_authenticated_insert
  on public.sms_phone_suppressions
  for insert
  to authenticated
  with check (org_id in (select org_id from public.memberships where user_id = auth.uid()));

drop policy if exists sms_phone_suppressions_authenticated_update on public.sms_phone_suppressions;
create policy sms_phone_suppressions_authenticated_update
  on public.sms_phone_suppressions
  for update
  to authenticated
  using (org_id in (select org_id from public.memberships where user_id = auth.uid()))
  with check (org_id in (select org_id from public.memberships where user_id = auth.uid()));
