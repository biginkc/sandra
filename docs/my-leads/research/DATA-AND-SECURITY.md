# My Leads data and security implementation research

**Authority:** `docs/my-leads/PRD.md` version 0.2, status `consolidated-for-review`.

**Source freeze:** This memo was researched against GitHub main
`8c7053e7024433f46791eac1b186c1b7a7cf10ec` in the worktree
`sandra-my-leads-prd-20260911`. It is a design and implementation plan, not an
instruction to apply migrations, initialize Maria's cohort, or call a provider.
Revalidate the listed paths against current main immediately before coding. The
working tree also contains the v0.2 PRD as an uncommitted handoff change.

## Decisions that keep v0.2 additive

My Leads needs a queue projection beside the shared lead model. It should not
add a global `attempted` status, reinterpret arbitrary Leads-board edits, or
make appointments/tasks a qualification gate. The current shared status remains
the source for the existing Leads board; only the four specified milestones
synchronize it.

Acquisitions designation is a member capability snapshot, not a new access role.
Add `memberships.acquisitions_enabled boolean not null default false`. This
controls whether a *new* assignment episode receives the first-call clock. It
does not deny an otherwise authorized owner/member access to Sandra or the My
Leads page. A designation change must not rewrite historical episodes.

The designation column must not become writable through a generic membership
update path. Revoke `UPDATE (acquisitions_enabled)` from `authenticated` and
`anon` (and do not add it to any existing roster update grant); only the
owner-checked `fn_set_acquisitions_designation` function may change it. If the
deployment cannot enforce column-level privileges cleanly, add a narrow
`BEFORE UPDATE` guard that permits the change only while the same owner check
passes and otherwise raises. The global Admin Team page uses an admin-email
check and is not the authorization surface for this member designation.

Use six purpose-built tables and keep audit events in the existing ledger:

1. `acquisition_org_settings` — organization gate and verified handoff owner.
2. `acquisition_launch_cohorts` — explicit launch preview/apply state.
3. `acquisition_queue_states` — current queue stage, motivation response, and
   deliberate archive state.
4. `acquisition_assignment_episodes` — immutable assignment periods and
   episode-scoped first-call evidence.
5. `acquisition_attempts` — deduplicated call/outreach attempts.
6. `acquisition_offers` — offer history and required follow-up time.

`lead_events` remains the append-only audit/history convention. Queue RPCs must
insert its event row in the same transaction as the authoritative mutation;
the existing `recordLeadEvent` helper is deliberately best-effort and cannot be
the only consistency mechanism for a milestone. Existing ledger shape and
source uniqueness are in
[`20260825170000_lead_events_ledger.sql:7-60`](../../../supabase/migrations/20260825170000_lead_events_ledger.sql).

## Proposed schema

### `acquisition_org_settings`

One row per organization:

```sql
org_id uuid primary key references public.organizations(id) on delete cascade,
my_leads_enabled boolean not null default false,
needs_sequence_owner_id uuid,
active_launch_cohort_id uuid,
created_at timestamptz not null default now(),
updated_at timestamptz not null default now(),
foreign key (needs_sequence_owner_id, org_id)
  references public.memberships(user_id, org_id),
foreign key (active_launch_cohort_id, org_id)
  references public.acquisition_launch_cohorts(id, org_id)
```

The composite membership foreign key prevents a cross-organization handoff
identity. The owner-only configuration RPC must additionally require the target
membership to be active, unexpired, not `deletion_prepared_at`, and have a
verified display identity. `src/lib/auth/team-roster.ts:74-169` already resolves
active and historical members and rejects a missing identity label; reuse that
server-side resolver rather than matching an email or display name at mutation
time.

`my_leads_enabled` is the server-enforced BMH rollout gate. It should be read by
all page and mutation RPCs. Do not use a client-only flag. If the feature is
kept behind an environment allowlist during development, retain this database
check before launch so the data contract cannot be bypassed by a direct RPC.

### `acquisition_launch_cohorts`

```sql
id uuid primary key default gen_random_uuid(),
org_id uuid not null references public.organizations(id) on delete cascade,
status text not null check (status in ('planned','running','complete','rolled_back')),
member_id uuid not null,
preview_count integer not null default 0,
preview_fingerprint text not null,
started_at timestamptz,
completed_at timestamptz,
created_by uuid not null references auth.users(id),
created_at timestamptz not null default now(),
foreign key (member_id, org_id)
  references public.memberships(user_id, org_id),
unique (id, org_id)
```

Add a partial unique index allowing only one `planned`/`running` cohort per
organization. `preview_fingerprint` is a sorted hash of the exact eligible
property ids, current statuses, and assignee ids. Apply must receive the
fingerprint produced by preview; a changed cohort fails instead of silently
initializing a different population. Create the settings table after this
table, or add `acquisition_org_settings(active_launch_cohort_id)` as a
follow-up foreign key migration, so a settings row cannot point at a cohort
from another organization.

### `acquisition_queue_states`

One row is created when launch initializes a lead or when an explicit queue
milestone first needs durable state. “Not contacted” is derived when an active
assignment has no qualifying attempt and no initialized queue state; it is not a
mutable stage value.

```sql
property_id uuid primary key,
org_id uuid not null,
stage text not null check (stage in ('contacted','needs_offer','offer_sent','under_contract')),
stage_entered_at timestamptz not null,
motivation_recorded boolean not null default false,
motivation_kind text check (motivation_kind in ('specified','no_motivation')),
motivation_text text,
motivation_recorded_at timestamptz,
motivation_recorded_by uuid references auth.users(id),
archived_at timestamptz,
archived_by uuid references auth.users(id),
archive_reason text check (archive_reason in ('needs_sequence_handoff','under_contract_archived','manual')),
launch_cohort_id uuid,
launch_previous_shared_status text,
created_at timestamptz not null default now(),
updated_at timestamptz not null default now(),
foreign key (property_id, org_id)
  references public.properties(id, org_id) on delete cascade,
foreign key (launch_cohort_id, org_id)
  references public.acquisition_launch_cohorts(id, org_id),
check (
  (not motivation_recorded and motivation_kind is null and motivation_text is null)
  or (motivation_recorded and motivation_kind = 'no_motivation' and motivation_text is null)
  or (motivation_recorded and motivation_kind = 'specified'
      and motivation_text is not null and btrim(motivation_text) <> '')
),
check (motivation_recorded = (motivation_recorded_at is not null)),
check (motivation_recorded = (motivation_recorded_by is not null))
```

`properties.motivation_level` remains the existing hot/warm/cold value. The new
response is a separate answer: `specified` preserves the entered seller text;
`no_motivation` is an explicit answer and is not represented as a false cold
value. The RPC may update `motivation_level` when the user selects an existing
value, and the queue state retains the answer needed to distinguish unanswered
from “no motivation provided.”

`archived_at` means “leave the active My Leads queue.” It is not a shared
`closed`/`dead` status and does not mean a contract closed. Offer decline and
not-interested handoff set `archive_reason='needs_sequence_handoff'` while
retaining all property history.

### `acquisition_assignment_episodes`

This is the source for attribution and the first-call clock. It deliberately
replaces the unsafe idea of one mutable `properties.assigned_at` value.

```sql
id uuid primary key default gen_random_uuid(),
org_id uuid not null,
property_id uuid not null,
assignee_user_id uuid not null references auth.users(id),
episode_kind text not null check (episode_kind in ('live','launch')),
eligible boolean not null,
assigned_at timestamptz,
initialized_at timestamptz not null default now(),
ended_at timestamptz,
first_call_started_at timestamptz,
first_call_actor_user_id uuid references auth.users(id),
first_call_activity_id uuid,
first_call_provider_key text,
launch_cohort_id uuid,
created_at timestamptz not null default now(),
foreign key (property_id, org_id)
  references public.properties(id, org_id) on delete cascade,
foreign key (assignee_user_id, org_id)
  references public.memberships(user_id, org_id),
foreign key (launch_cohort_id, org_id)
  references public.acquisition_launch_cohorts(id, org_id),
unique (id, property_id, org_id),
check ((episode_kind = 'live') = (assigned_at is not null)),
check (ended_at is null or ended_at >= coalesce(assigned_at, initialized_at)),
check (first_call_started_at is null or first_call_actor_user_id is not null),
foreign key (first_call_activity_id, property_id, org_id)
  references public.call_activities(id, property_id, org_id) on delete set null
```

Add a partial unique index on `(property_id) where ended_at is null`. The
assignment trigger/RPC closes the old episode before inserting the new one,
under the property row lock. A launch episode has `episode_kind='launch'`,
`eligible=false`, and `assigned_at null`; it records initialization without
inventing an assignment time. A live episode snapshots the target member's
`acquisitions_enabled` into `eligible`. Disabling the designation later does
not rewrite an already-created episode.

`first_call_provider_key` is the stable provider identity captured at call
initiation. It is needed because current Jitter writeback may create or update
`call_activities` after the lead has been reassigned. `first_call_activity_id`
is filled when the canonical call row is available; the provider key and
idempotency key remain the initial evidence.

For tenant-safe activity references, add the additive unique key
`call_activities(id, property_id, org_id)` before installing these foreign
keys. The new episode and attempt tables should reference that three-column
key, rather than trusting a globally unique activity id to prove the property
and organization match. If the existing call migration cannot add that key
without a lock-budget exception, use an equivalent deferred validation trigger
and keep the same RPC-side composite check; do not fall back to an id-only
link.

### `acquisition_attempts`

```sql
id uuid primary key default gen_random_uuid(),
org_id uuid not null,
property_id uuid not null,
assignment_episode_id uuid,
actor_user_id uuid not null references auth.users(id),
attempt_kind text not null check (attempt_kind in ('call','outreach')),
source text not null check (source in ('sandra','dialpad','manual')),
outcome text check (outcome in ('no_answer','reached','wrong_number')),
occurred_at timestamptz not null,
recorded_at timestamptz not null default now(),
note text,
recording_url text,
call_activity_id uuid,
provider_attempt_key text,
idempotency_key uuid not null,
created_at timestamptz not null default now(),
foreign key (property_id, org_id)
  references public.properties(id, org_id) on delete cascade,
foreign key (assignment_episode_id, property_id, org_id)
  references public.acquisition_assignment_episodes(id, property_id, org_id),
foreign key (call_activity_id, property_id, org_id)
  references public.call_activities(id, property_id, org_id) on delete set null,
check ((attempt_kind = 'call') or source = 'manual'),
check (attempt_kind = 'outreach' or source in ('sandra','dialpad')),
check (attempt_kind = 'outreach' or outcome is not null or source = 'sandra'),
check (source <> 'sandra' or provider_attempt_key is not null),
check (attempt_kind = 'call' or call_activity_id is null),
check (attempt_kind = 'call' or provider_attempt_key is null)
```

Use unique indexes for `(org_id, idempotency_key)`, `(org_id, call_activity_id)
where call_activity_id is not null`, and `(org_id, source,
provider_attempt_key) where provider_attempt_key is not null`. A Sandra attempt
may be inserted at actual provider initiation with a null outcome and finalized
by wrap-up; this is not an invented `no_answer`. A DialPad attempt requires an
outcome but does not require a recording link under v0.2. An outreach row can
move a queue to Contacted but can never populate first-call evidence.

The automatic call path must bind the attempt to `assignment_episode_id` at
initiation. Later completion/writeback looks up the attempt by stable provider
identity and updates its outcome without consulting the property's current
assignee. It must not reopen an archived queue or regress a later stage.

### `acquisition_offers`

```sql
id uuid primary key default gen_random_uuid(),
org_id uuid not null,
property_id uuid not null,
actor_user_id uuid not null references auth.users(id),
assignment_episode_id uuid,
amount_cents bigint not null check (amount_cents >= 0),
sent_via text not null check (sent_via in ('dropbox_sign','verbal','email_text')),
sent_at timestamptz not null,
follow_up_at timestamptz not null,
outcome text not null default 'pending' check (outcome in ('pending','accepted','declined')),
outcome_at timestamptz,
outcome_by uuid references auth.users(id),
idempotency_key uuid not null,
created_at timestamptz not null default now(),
updated_at timestamptz not null default now(),
foreign key (property_id, org_id)
  references public.properties(id, org_id) on delete cascade,
foreign key (assignment_episode_id, property_id, org_id)
  references public.acquisition_assignment_episodes(id, property_id, org_id),
check (
  (outcome = 'pending' and outcome_at is null and outcome_by is null)
  or (outcome in ('accepted','declined') and outcome_at is not null and outcome_by is not null)
)
```

Allow multiple offer rows for offer history. Index `(property_id, sent_at desc)`
and `(org_id, follow_up_at) where outcome='pending'`. Unique
`(org_id, idempotency_key)` makes retries return the original offer. Logging an
offer must not send eSign, create a task, or create an appointment; Dropbox Sign
is a method label only.

## Assignment integration and trigger contract

Current assignment writes are not limited to one action. The single-lead action
is [`src/app/(dashboard)/leads/actions.ts:2262-2359`](../../../src/app/(dashboard)/leads/actions.ts),
bulk assignment directly updates properties at
[`src/app/(dashboard)/leads/actions.ts:911-1065`](../../../src/app/(dashboard)/leads/actions.ts),
and lead creation can set the initial assignee at
[`src/lib/leads/create.ts:268-290`](../../../src/lib/leads/create.ts). The new
assignment episode contract must cover all three paths. The existing database
assignee guard remains authoritative at
[`20260816030000_leads_tenant_paging_safety.sql:4-40`](../../../supabase/migrations/20260816030000_leads_tenant_paging_safety.sql).

Install an `AFTER INSERT OR UPDATE OF assigned_user_id` trigger on
`properties` that calls a narrowly scoped `SECURITY DEFINER` helper:

1. Lock/close the open episode for the property.
2. If the new assignee is non-null, insert a live episode with
   `assigned_at=statement_timestamp()` and an `eligible` snapshot from the
   target membership.
3. If the current shared status is an active supported milestone
   (`contacted`, `interested`, `offer_sent`, or `under_contract`) and this is a
   new property assignment after launch, create the corresponding queue state;
   do not create an active state for `offer_declined`, `closed`, or `dead`, and
   do not reverse an existing queue stage from an arbitrary status edit.
4. Never touch appointments, notes, sequences, or DNC state.

The trigger prevents direct bulk/create paths from silently bypassing episode
history. The application actions should still move to a common RPC or retain
CAS handling and return its result; the trigger is the defense-in-depth source
of episode truth, not a replacement for the existing assignee validation.

A generic reassign to another active member keeps queue state and activity
history on the property, closes the old episode, and opens a new episode. The
new episode may be ineligible for the first-call timer if the target is not
Acquisitions-designated. It must not reset the queue stage. Unassigning closes
the episode and removes the property from active queue reads. The special
Needs-sequence handoff archives the queue state, sets the existing
`needs_sequence` disposition, and assigns the persisted verified handoff owner
in one RPC; it does not enroll a sequence or create a task.

## RPC contracts

All mutation RPCs should be `SECURITY DEFINER`, with `set search_path = ''`,
fully qualified relation names, explicit active-membership checks, and
`REVOKE ALL ... FROM public, anon` followed by the narrowest required
`GRANT EXECUTE`. The function must derive the actor from `auth.uid()` for a
normal user assertion, never accept an actor id from the browser, and validate
the organization and property through composite keys. A server-only adapter
may use the service role, but it still validates a signed capability and the
same tenant keys; do not treat service role as a substitute for input checks.

A function that only reads a target queue may be `SECURITY INVOKER` if the
policy itself enforces the target selection. The recommended page RPC is a
narrow definer because existing organization RLS permits same-org reads while
v0.2 requires owner-selected member scoping; the definer must enforce that
scope explicitly before returning rows.

### Configuration and reads

- `fn_set_acquisitions_designation(p_org_id uuid, p_user_id uuid, p_enabled boolean) returns jsonb` — active owner only; target must be an active same-org member; changes future episode snapshots only.
- `fn_set_acquisition_handoff_owner(p_org_id uuid, p_user_id uuid) returns jsonb` — active owner only; target must have a verified identity and active same-org membership; persist the user id, never resolve “Jarrad” by text during a lead mutation.
- `fn_preview_acquisition_launch(p_org_id uuid, p_member_id uuid) returns table(eligible_count integer, fingerprint text, status_counts jsonb)` — owner only; read-only and no cohort mutation. The fingerprint is the review token; the property set is re-read and compared during apply.
- `fn_initialize_acquisition_launch(p_org_id uuid, p_member_id uuid, p_expected_fingerprint text) returns jsonb` — owner only; locks the settings row, rechecks the exact eligible set against the fingerprint, creates the planned/running cohort, initializes only that reviewed target cohort, and commits queue states, launch episodes, earlier status promotion, and audit events together.
- `fn_get_acquisition_queue_page(p_org_id uuid, p_selected_member_id uuid, p_search text, p_cursor jsonb, p_limit integer, p_as_of timestamptz) returns jsonb` — actor must be an active org member; selected member may be self, or an active owner may select another member. The RPC must cap `p_limit`, apply the feature gate, exclude DNC/deleted rows, return `snapshot_at`, and use deterministic `(warning_rank, assignment_sort, property_id)` ordering.
- `fn_get_acquisition_kpis(p_org_id uuid, p_selected_member_id uuid, p_period_start timestamptz, p_period_end timestamptz, p_timezone text) returns table(...)` — same actor/selection check and same source definitions for rep and owner; period boundaries are interpreted in `America/Chicago` by the server, not trusted from a browser string.

### Calls and attempts

- `fn_record_acquisition_call_start(p_signed_call_token text, p_provider_attempt_key text, p_started_at timestamptz, p_call_activity_id uuid default null, p_idempotency_key uuid) returns jsonb` — server-only internal evidence adapter; verifies the signed Sandra/Jitter call capability contains the original actor, organization, property, episode, and stable `callToken`, then locks that episode and records first-call evidence once. It inserts or replays the Sandra attempt and updates shared status to `contacted` only when it is still `new_lead`; never regresses a later or terminal status. Revoke execution from `authenticated` and grant only to the internal service role. A browser cannot stop the clock by passing its own property, actor, or timestamp.
- `fn_log_acquisition_attempt(p_property_id uuid, p_attempt_kind text, p_source text, p_outcome text, p_occurred_at timestamptz, p_note text, p_recording_url text, p_call_activity_id uuid default null, p_idempotency_key uuid) returns jsonb` — validates external occurrence time and caller scope, links the current episode when applicable, rejects a mismatched call reference, and creates/replays one attempt. Manual completion of an automatic Sandra call must update the existing attempt by stable provider key instead of inserting another row.
- `fn_finalize_acquisition_attempt(p_signed_call_token text, p_provider_attempt_key text, p_outcome text, p_note text, p_call_activity_id uuid default null) returns jsonb` — called by the authenticated/server call wrap-up path; authorizes by the original signed call/operator token, not the current property assignee. It may update only the matching pending attempt and cannot reopen an archived queue or regress a later stage. Grant only to the internal writeback path if that path already authenticates the sealed token.

The current source integration points are the successful start result in
[`src/lib/dialer/jitter-server.ts:306-365`](../../../src/lib/dialer/jitter-server.ts)
and the transport start in
[`src/components/softphone/softphone-provider.tsx:743-760`](../../../src/components/softphone/softphone-provider.tsx),
but those results are not yet authoritative seller-call evidence. The CALLS
research memo identifies the required technical prerequisite: deployed Jitter
must emit a durable seller-leg `providerAttemptId`/occurrence event keyed by
the signed `callToken`, or document `product.create_call` success as the
seller-placement boundary. Until that contract is verified, do not wire
`fn_record_acquisition_call_start` to `start-call`, `connect("registered")`,
RTC registration, or UI state. Opening/cancelling a dialog must never call the
new RPC. A failed setup before verified provider initiation must not create
first-call evidence.

### Milestones and offers

- `fn_ready_acquisition_offer(p_property_id uuid, p_motivation_kind text, p_motivation_text text, p_motivation_level text default null, p_idempotency_key uuid) returns jsonb` — current assignee or authorized owner; requires an explicit motivation answer (including `no_motivation`), locks property and queue state, sets queue stage to `needs_offer`, and promotes shared status to `interested` only when it is earlier than that state.
- `fn_log_acquisition_offer(p_property_id uuid, p_amount_cents bigint, p_sent_via text, p_sent_at timestamptz, p_follow_up_at timestamptz, p_motivation_kind text default null, p_motivation_text text default null, p_idempotency_key uuid) returns jsonb` — same mutation scope; requires an existing or supplied motivation answer, writes the offer, sets queue stage `offer_sent`, and promotes shared status to `offer_sent` without sending anything.
- `fn_record_acquisition_contract(p_property_id uuid, p_signed_at timestamptz, p_idempotency_key uuid) returns jsonb` — current assignee or owner; sets queue stage/shared status `under_contract`, emits a signed event, and leaves the row visible until deliberate archive.
- `fn_decline_acquisition_offer(p_offer_id uuid, p_occurred_at timestamptz, p_idempotency_key uuid) returns jsonb` — locks offer/property/state, sets offer outcome `declined`, shared status `offer_declined`, queue archive reason `needs_sequence_handoff`, disposition `needs_sequence`, and reassigns to the configured handoff owner in one transaction. It must reject later/terminal states instead of silently regressing them.
- `fn_handoff_acquisition_lead(p_property_id uuid, p_reason text, p_idempotency_key uuid) returns jsonb` — same atomic disposition/reassignment operation for not-interested/nurture handoff; no enrollment, message, task, appointment, or fabricated activity.
- `fn_archive_acquisition_contract(p_property_id uuid, p_idempotency_key uuid) returns jsonb` — deliberate queue archive only; it does not set shared status `closed` or `dead`.

These operations should use the same row-lock and replay-before-validation
pattern already established by `fn_book_appointment` in
[`20260814170000_appointment_booking_rpcs.sql:501-835`](../../../supabase/migrations/20260814170000_appointment_booking_rpcs.sql).
`SELECT ... FOR UPDATE` serializes competing stage/assignment/offer actions;
the idempotency key then makes a retried request return the committed result.
Do not compose several client-side PostgREST writes and call them “atomic.”

Existing appointment booking/completion/reassignment remains canonical. The
schema permits `held`, `no_show`, `rescheduled`, and `cancelled` outcomes in
[`20260814150000_appointments_schema.sql:35-111`](../../../supabase/migrations/20260814150000_appointments_schema.sql),
and completion records `completed_by` in the lifecycle RPC
([`20260814210000_appointment_lifecycle_rpcs.sql:129-206`](../../../supabase/migrations/20260814210000_appointment_lifecycle_rpcs.sql)). My Leads must not introduce the old `happened_ready` vocabulary or automatically schedule work.

## RLS, grants, and function safety

Current properties, notes, tasks, calls, and membership policies are
organization-scoped. The new tables should preserve organization visibility
for controlled server reads but expose all browser reads and mutations only
through the RPCs:

- Enable RLS on every new public table.
- Do not grant direct `SELECT`, `INSERT`, `UPDATE`, or `DELETE` on attempts,
  offers, queue state, episodes, cohorts, or org settings to `anon` or
  `authenticated`. Service role is migration/maintenance only. Grant
  `authenticated` only `EXECUTE` on the explicitly scoped queue/configuration
  RPCs; the definer read RPC must enforce selected-member authorization before
  it reads rows. This avoids the existing broad same-org policy becoming a
  selected-rep queue bypass.
- If a direct server-side maintenance query is required, keep RLS enabled and
  use a narrowly scoped service role path. Do not add a broad same-org browser
  policy as a convenience fallback.
- The queue/KPI RPC validates `p_selected_member_id` before any row is read. A
  non-owner cannot inspect another member's queue. An owner-selected visit is
  attributed to the selected member for reads but never changes activity actor
  or event attribution.
- DNC checks remain authoritative. Current property locks make the row
  read-only and sidecar notes/tasks reject locked-property mutation in
  [`20260815190000_true_dnc_property_lock.sql:35-97`](../../../supabase/migrations/20260815190000_true_dnc_property_lock.sql)
and [`:408-467`](../../../supabase/migrations/20260815190000_true_dnc_property_lock.sql). The new RPCs must not write sequentially around that lock or reinterpret `needs_sequence` as DNC. Attempts/offers/notes on a locked property fail with the existing compliance error.
- Existing `setOutreachDispo` updates the property and then performs suppression
  side effects in separate calls ([`src/app/(dashboard)/messages/dispo-actions.ts:97-253`](../../../src/app/(dashboard)/messages/dispo-actions.ts)). The new decline/handoff RPC should implement only the supported `needs_sequence` disposition and reassignment atomically; it must not call that multi-step action and must not add automatic enrollment.

The [Supabase RLS guide](https://supabase.com/docs/guides/database/postgres/row-level-security)
requires both RLS policies and grants, and recommends database tests for
allow/deny cases. The [Supabase database-functions guide](https://supabase.com/docs/guides/database/functions)
recommends `SECURITY INVOKER` by default; where this page requires a definer,
follow its `search_path` and execute-grant guidance. PostgreSQL's
[CREATE FUNCTION security-definer guidance](https://www.postgresql.org/docs/current/sql-createfunction.html)
explains why `search_path` must exclude writable schemas and why default
`PUBLIC` execute must be revoked. If a read view is introduced, use
`security_invoker`; Supabase documents the risk of default definer views in
[Tables and data](https://supabase.com/docs/guides/database/tables#view-security).

`lead_events` is currently browser-readable but server-append-only, with a
unique source identity. Add queue event constants in `src/lib/events/index.ts`
and use a direct transactional insert from the RPC. Do not use the existing
best-effort `recordLeadEvents` helper as the transaction boundary.

## Query, timer, and KPI implementation

Use bounded server RPCs, not a client-side all-leads fetch. Helpful indexes:

```sql
create index ... on acquisition_assignment_episodes
  (org_id, assignee_user_id, assigned_at, property_id)
  where ended_at is null;
create index ... on acquisition_queue_states
  (org_id, stage, stage_entered_at, property_id)
  where archived_at is null;
create index ... on acquisition_attempts
  (property_id, occurred_at desc);
create index ... on acquisition_offers
  (org_id, follow_up_at, property_id)
  where outcome = 'pending';
```

The queue query computes five sections:

- `Not contacted`: active assigned property, no archived queue state, and no
  qualifying attempt (`call` or `outreach`).
- `Contacted`: qualifying attempt or launch-initialized `contacted` state, with
  no later queue state.
- `Needs offer / Interested`: current queue state `needs_offer`.
- `Offer Sent`: current queue state `offer_sent` and latest offer.
- `Under Contract`: current queue state `under_contract` until archived.

A later call cannot move a row back to Contacted. A handoff/archive excludes it
from active reads regardless of the new owner's designation. Callback indicators
come from existing open future appointment tasks; no appointment completion
changes queue stage automatically.

The six KPI definitions should be implemented from event-time fields:

- Attempts: `count(distinct acquisition_attempts.id)` by `actor_user_id` and
  `occurred_at` in the selected range.
- Contact rate: reached attempts divided by counted attempts; zero denominator
  is unavailable, not zero percent.
- Assign-to-first-call: average elapsed difference between live eligible
  episode `assigned_at` and `first_call_started_at`, where episode start is in
  the selected period; exclude launch episodes, null/pending evidence, and
  unknown times.
- Appointments kept: canonical tasks due in the period with completed outcome
  `held`, attributed using the appointment's accountable actor/event rather than
  current assignee.
- Offers sent: offers whose `sent_at` is in the period, attributed to
  `actor_user_id`, not current assignee.
- Stale: current distinct warning rows in the selected member's active queue,
  independent of period dates. Count a lead once even when it has both a
  pending first-call warning and a stage warning.

The first-call warning uses accumulated Monday-Friday 09:00-17:00
`America/Chicago` minutes and carries across nights/weekends. The KPI remains
elapsed duration, as v0.2 requires; label it clearly. Implement a stable SQL
helper or server query function for working-time accumulation, but do not put
`now()` or a timezone-dependent calculation in an index predicate. PostgreSQL
requires index expressions and predicates to use immutable functions; see the
[`CREATE INDEX` reference](https://www.postgresql.org/docs/current/sql-createindex.html).
Use the partial indexes above to narrow candidates, then evaluate the warning
against a fixed `p_as_of` timestamp. Centralize the 30-minute and 12-hour
thresholds and timezone in a server module/config object.

## Launch/backfill and rollback

Launch is a reviewed operation, not an automatic migration side effect:

1. Deploy additive tables, RLS, grants, indexes, triggers, and RPCs with
   `my_leads_enabled=false`.
2. Use `fn_preview_acquisition_launch` to return the exact active assigned
   cohort, status counts, exclusions, and fingerprint. Preview must exclude
   deleted, closed, dead, DNC-locked, and unassigned properties.
3. After review, create a planned cohort and apply with the exact fingerprint.
   The transaction creates launch queue state/episodes, stores each prior shared
   status in `launch_previous_shared_status`, promotes only earlier statuses to
   `contacted`, and preserves `interested`, `offer_sent`, `under_contract`, and
   terminal/DNC exclusions. It creates no attempt, call-start, note, task,
   appointment, sequence enrollment, or provider activity.
4. Set `my_leads_enabled=true` only after the applied cohort summary is
   reviewed. New assignments then create live episodes through the trigger.
5. The first-call KPI and warning exclude `episode_kind='launch'`. Unknown
   assignment times remain unknown; never backfill them from `updated_at`.

A failed apply rolls back as one transaction. Turning the feature gate off is
the safe operational rollback and preserves history. A data rollback may run
only before post-launch activity: verify the cohort has no later attempt, offer,
contract, reassignment, or stage event; restore the stored prior shared status,
delete only launch-created queue state/episodes, and mark the cohort
`rolled_back`. Once real activity exists, use a forward corrective migration or
per-property repair review; do not bulk-delete history or rewrite KPI events.
Schema rollback after deployment should likewise be forward-only. Test-only
reset may drop the additive tables after all dependent functions, policies, and
triggers are removed.

## Bounded implementation packets

These packets are sized for one Luna/xhigh implementation turn each. Do not run
shared DB/provider work or push before Tester admission; root owns the exact
candidate gate and review sequence. Prefer the existing owner + Acquisitions
member + second-organization member fixtures (three accounts total); add a
fourth only if a deny case cannot be expressed otherwise.

### Packet A — schema, settings, and RLS

**Depends on:** none. Add memberships designation, the six tables, the
tenant-safe `call_activities(id, property_id, org_id)` key, constraints,
indexes, grants/policies, generated types, and event constants. Add migration
contract tests that assert no global status constraint change, no direct
authenticated table grants, and no designation update path outside its owner
RPC.

**Checks:** `npm run verify:migration-safety-unit`, `npm run typecheck`, focused
Vitest contract tests, and `npm run lint`. After Tester admission, run the
focused database RLS/integration suite with `npm run test:integration -- <test>`.

### Packet B — assignment episodes and launch preview/apply

**Depends on:** A. Add the properties assignment trigger, CAS/RPC integration
for `updateLeadAssignee`, `assignLeadsBulk`, and lead creation, plus preview,
exact-fingerprint apply, and safe rollback checks. Prove that reassignment
closes/opens episodes, generic non-Acquisitions members still retain queue
access, and designation only changes future eligibility.

**Checks:** existing assignment safety tests plus focused episode concurrency,
launch idempotency, cross-org, inactive-member, and DNC exclusion tests. Use
`npm run test:integration -- <focused-file>` only after admission; no provider
or broad cohort data.

### Packet C — call initiation and attempt deduplication

**Depends on:** A and B. Bind the existing Sandra start result to the active
episode, create a pending automatic attempt, finalize by stable provider key,
and add manual DialPad/outreach logging. Cover reassignment between initiation
and writeback; preserve original actor/episode and never regress current queue.

**Checks:** existing dialer/softphone unit and contract tests, focused
idempotency/provider-writeback tests, `npm run typecheck`, and `npm run lint`.
Do not make real calls.

### Packet D — milestone, offer, decline, and handoff RPCs

**Depends on:** A and B; C for first-call/attempt references. Add row-lock,
CAS/idempotency RPCs, queue stage transitions, motivation semantics, offer
history, status synchronization, `needs_sequence` handoff, and deliberate
Under Contract archive. Reuse appointment lifecycle records without altering
appointment outcomes.

**Checks:** focused transaction tests for retries, concurrent writers, later/
terminal status non-regression, DNC lock rejection, verified handoff identity,
original actor attribution, and no automatic task/sequence/provider side
 effects.

### Packet E — bounded queue/KPI read model

**Depends on:** A-D. Add page/KPI RPCs, deterministic cursor pagination, warning
calculation, working-time helper, and indexes. Validate selected-member
authorization separately from row RLS and ensure owner views do not become
activity actors.

**Checks:** fixture-driven hand SQL comparisons, DST and Friday-to-Monday clock
cases, zero denominators, stale deduplication, and cross-org/unauthorized
selection. Use the existing test scripts (`npm run test:integration`,
`npm run verify:migration-safety-rehearsal`) after admission.

### Packet F — page integration (owned by the UI packet)

**Depends on:** E. Consume only the bounded RPC contracts; do not query the six
tables directly from browser components. Add the sidebar feature-gated link,
owner selector, five sections, row details, and dialogs without changing the
existing Leads board shell or call provider behavior. UI acceptance must include
narrow/zoomed layouts and the existing authenticated browser process.

## Contract pitfalls to keep visible

- Existing `properties` status is constrained to
  `new_lead`, `contacted`, `interested`, `offer_sent`, `offer_declined`,
  `under_contract`, `closed`, and `dead`; see
  [`004_status_enum_swap_researching_for_offer_declined.sql:7-18`](../../../supabase/migrations/004_status_enum_swap_researching_for_offer_declined.sql).
  Do not add `attempted` or make queue stage a status alias.
- Existing call activities use `operator_user_id`, provider identity,
  `started_at`, and provider outcome fields at
  [`058_dialer_and_call_activity.sql:76-111`](../../../supabase/migrations/058_dialer_and_call_activity.sql).
  Provider writeback may be later than initiation and may arrive after
  reassignment; provider identity must be durable in the new attempt row.
- Existing DNC is a permanent property lock, not a generic “closed out” state.
  [`src/lib/dnc/property-lock.ts:9-25`](../../../src/lib/dnc/property-lock.ts) and
  [`20260815190000_true_dnc_property_lock.sql:35-180`](../../../supabase/migrations/20260815190000_true_dnc_property_lock.sql) must remain authoritative.
- Existing `lead_events` uses `(source_type, source_id)` uniqueness and browser
  read/server append permissions. New transactional RPCs must use a stable
  source id and must not depend on a post-commit best-effort append.
- Existing appointment lifecycle uses calendar mutation ledgers, row locks,
  idempotency, and DNC guards. Do not direct-update `tasks` for appointment
  completion or reassignment.
- Generated `src/lib/supabase/types.ts` currently has no acquisition tables,
  designation, queue fields, episodes, attempts, or offers. Regenerate/update
  types only as part of the migration packet; do not hand-wave missing types.

## Official references used

- [Supabase Row Level Security](https://supabase.com/docs/guides/database/postgres/row-level-security) — enable RLS on every exposed table, pair policies with grants, test allow/deny paths, and use carefully scoped definer helpers when policy recursion requires them.
- [Supabase Database Functions](https://supabase.com/docs/guides/database/functions) — default to invoker functions; for definer functions, pin `search_path` and grant execute explicitly.
- [Supabase Tables and data: view security](https://supabase.com/docs/guides/database/tables#view-security) — default views can bypass underlying RLS; queue read views must be `security_invoker` or replaced with an authorized RPC.
- [PostgreSQL CREATE FUNCTION](https://www.postgresql.org/docs/current/sql-createfunction.html) — `SECURITY DEFINER` runs with owner privileges, requires a safe search path, and should revoke default `PUBLIC` execution.
- [PostgreSQL CREATE INDEX](https://www.postgresql.org/docs/current/sql-createindex.html) — partial predicates and index expressions cannot depend on mutable current time or non-immutable functions; working-time warnings belong in bounded query evaluation.
- [PostgreSQL SELECT locking](https://www.postgresql.org/docs/current/sql-select.html#SQL-FOR-UPDATE-SHARE) — `FOR UPDATE` serializes competing row mutations; `SKIP LOCKED` is suitable for worker queues, not a user mutation that must report a conflict.
- [PostgreSQL constraints](https://www.postgresql.org/docs/current/ddl-constraints.html) — partial unique indexes enforce one open episode/idempotency subset, while `CHECK` constraints cannot validate membership in another table; active-member checks therefore remain trigger/RPC logic.

## Verification boundary

This memo verifies source structure and official PostgreSQL/Supabase guidance,
not live database coverage, provider configuration, or Maria's exact assigned
cohort. Before implementation, re-run the source anchors against current main,
confirm any pending call/assignment work, regenerate database types from the
merged schema, and obtain the existing Tester admission before shared database
execution. No migration, backfill, provider call, or cohort mutation is part of
this research task.
