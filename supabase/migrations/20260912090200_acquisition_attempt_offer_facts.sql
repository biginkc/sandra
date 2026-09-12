-- My Leads foundation: immutable attempt/offer facts and their tenant-safe
-- references to assignment episodes, call activity and command receipts.

begin;

create table public.acquisition_attempts (
  id uuid primary key default extensions.gen_random_uuid(),
  org_id uuid not null references public.organizations(id) on delete cascade,
  property_id uuid not null,
  assignment_episode_id uuid,
  actor_user_id uuid not null references auth.users(id) on delete restrict,
  attempt_kind text not null check (attempt_kind in ('call', 'outreach')),
  source text not null check (source in ('sandra', 'dialpad', 'manual')),
  outcome text check (outcome in ('no_answer', 'reached', 'wrong_number')),
  occurred_at timestamptz not null,
  recorded_at timestamptz not null default now(),
  note text,
  recording_url text,
  call_activity_id uuid,
  provider_attempt_key text,
  idempotency_key uuid not null,
  command_id uuid,
  created_at timestamptz not null default now(),
  constraint acquisition_attempts_property_org_fkey
    foreign key (property_id, org_id)
    references public.properties(id, org_id) on delete cascade,
  constraint acquisition_attempts_episode_property_org_fkey
    foreign key (assignment_episode_id, property_id, org_id)
    references public.acquisition_assignment_episodes(id, property_id, org_id),
  constraint acquisition_attempts_activity_property_org_fkey
    foreign key (call_activity_id, property_id, org_id)
    references public.call_activities(id, property_id, org_id)
    on delete set null (call_activity_id),
  constraint acquisition_attempts_command_org_fkey
    foreign key (command_id, org_id)
    references public.acquisition_commands(id, org_id)
    on delete set null (command_id),
  constraint acquisition_attempts_source_kind_check
    check (
      (source in ('sandra', 'dialpad') and attempt_kind = 'call')
      or (source = 'manual' and attempt_kind = 'outreach')
    ),
  constraint acquisition_attempts_pending_outcome_check
    check (source = 'sandra' or outcome is not null),
  constraint acquisition_attempts_sandra_key_check
    check (source <> 'sandra' or provider_attempt_key is not null),
  constraint acquisition_attempts_provider_key_nonblank_check
    check (provider_attempt_key is null or btrim(provider_attempt_key) <> ''),
  constraint acquisition_attempts_call_link_check
    check (attempt_kind = 'call' or call_activity_id is null),
  constraint acquisition_attempts_provider_key_kind_check
    check (attempt_kind = 'call' or provider_attempt_key is null)
);

create unique index acquisition_attempts_idempotency_idx
  on public.acquisition_attempts (org_id, idempotency_key);
create unique index acquisition_attempts_provider_key_idx
  on public.acquisition_attempts (org_id, source, provider_attempt_key)
  where provider_attempt_key is not null;
create unique index acquisition_attempts_call_activity_idx
  on public.acquisition_attempts (org_id, call_activity_id)
  where call_activity_id is not null;
create index acquisition_attempts_property_occurred_idx
  on public.acquisition_attempts (org_id, property_id, occurred_at desc);
create index acquisition_attempts_actor_occurred_idx
  on public.acquisition_attempts (org_id, actor_user_id, occurred_at desc);

alter table public.acquisition_attempts enable row level security;
revoke all on table public.acquisition_attempts
  from public, anon, authenticated, service_role;

create table public.acquisition_offers (
  id uuid primary key default extensions.gen_random_uuid(),
  org_id uuid not null references public.organizations(id) on delete cascade,
  property_id uuid not null,
  assignment_episode_id uuid,
  actor_user_id uuid not null references auth.users(id) on delete restrict,
  amount_cents bigint not null check (amount_cents > 0),
  sent_via text not null check (sent_via in ('dropbox_sign', 'verbal', 'email_text')),
  sent_at timestamptz not null,
  follow_up_at timestamptz not null,
  outcome text not null default 'pending',
  outcome_at timestamptz,
  outcome_by uuid references auth.users(id) on delete restrict,
  idempotency_key uuid not null,
  command_id uuid,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint acquisition_offers_property_org_fkey
    foreign key (property_id, org_id)
    references public.properties(id, org_id) on delete cascade,
  constraint acquisition_offers_episode_property_org_fkey
    foreign key (assignment_episode_id, property_id, org_id)
    references public.acquisition_assignment_episodes(id, property_id, org_id),
  constraint acquisition_offers_command_org_fkey
    foreign key (command_id, org_id)
    references public.acquisition_commands(id, org_id)
    on delete set null (command_id),
  constraint acquisition_offers_follow_up_after_sent_check
    check (follow_up_at > sent_at),
  constraint acquisition_offers_outcome_check
    check (
      (outcome = 'pending' and outcome_at is null and outcome_by is null)
      or
      (outcome in ('accepted', 'declined') and outcome_at is not null and outcome_by is not null)
    )
);

create unique index acquisition_offers_idempotency_idx
  on public.acquisition_offers (org_id, idempotency_key);
create unique index acquisition_offers_pending_property_idx
  on public.acquisition_offers (org_id, property_id)
  where outcome = 'pending';
create index acquisition_offers_property_sent_idx
  on public.acquisition_offers (org_id, property_id, sent_at desc);
create index acquisition_offers_pending_follow_up_idx
  on public.acquisition_offers (org_id, follow_up_at, property_id)
  where outcome = 'pending';
create index acquisition_offers_actor_sent_idx
  on public.acquisition_offers (org_id, actor_user_id, sent_at desc);

alter table public.acquisition_offers enable row level security;
revoke all on table public.acquisition_offers
  from public, anon, authenticated, service_role;

commit;
