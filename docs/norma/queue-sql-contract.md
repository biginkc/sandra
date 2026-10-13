# Norma call queue — SQL contract pinned by the RED tests

Source: approved plan `~/.claude/plans/memoized-scribbling-reddy.md` (v8 + Round-3..7 corrections; later rounds override earlier). Tests: `supabase/migrations/norma_call_queue.integration.test.ts` and `supabase/migrations/norma_call_queue_scheduler.integration.test.ts` (each gets its `<version>_` prefix when the migration number is reserved, matching `<version>_norma_call_queue.sql`) and `tests/integration/norma-queue-fixture.ts` (finds the migration by suffix `_norma_call_queue.sql`; optional separate migration 1 of [G1] by suffix `_norma_legacy_claim_disable.sql` — PROPOSED name).

Rule: tests encode only approved behaviour. Anything the plan leaves open is marked **PROPOSED — needs review** (a shape/name choice, not a business rule) or is an `it.todo` with the question. No script/prompt/rubric text is touched.

All new functions: `SECURITY DEFINER`, `set search_path = public, pg_temp`, first statement rejects `coalesce(auth.role(),'') <> 'service_role'` with `errcode 42501`, `REVOKE ALL ... FROM PUBLIC, anon, authenticated`, `GRANT EXECUTE ... TO service_role` (plan Security [B17]).

## 1. Columns added to `norma_call_requests`
| column | type | notes |
|---|---|---|
| `queue_entry_id` | uuid null, indexed | immutable after insert; must reference an entry with same org/property/contact; null = button request |
| `queue_lease_token` | uuid null | immutable ([C1]) |
| `queue_dispatch_token` | uuid null | copy of `entry.dispatch_token` at creation ([E4]) |
| `send_attempted_at` | timestamptz null | stamped only by `fn_norma_mark_sending` ([C5]). **PROPOSED:** the guard trigger must not forbid table-owner writes to `send_attempted_at` (tests stamp and re-stamp it directly to place sends at fixed instants). Only `fn_norma_mark_sending` writes it in production. |

`norma_call_requests.outcome` already admits `reviewed` (migration 20261008090100).

## 2. Tables
### `norma_queue_entries`
`id uuid pk`, `org_id uuid not null`, `property_id uuid not null`, `contact_id uuid not null`, `requested_by uuid not null` (callback owner = requester), `rep_context text`,
`status text not null check in ('queued','calling','paused','done','cancelled','exhausted')`,
`pause_reason text null check in ('inbound_reply','needs_review','reviewed','rep_paused','unknown_state','provider_refused')`,
`end_reason text null`, `blocked_reason text null`, `phase text not null default 'A' check in ('A','B','C')`, `phase_dates_used smallint not null default 0`, `phase_c_count smallint not null default 0`,
`next_attempt_at timestamptz`, `lease_token uuid`, `lease_expires_at timestamptz`, **`dispatch_token uuid`** ([E4], revocable; rotated by pause/cancel/inbound park/block), `last_request_id uuid`, `last_sent_at timestamptz`, `reply_ack_at timestamptz`, `display_tz text`, `created_at timestamptz default now()`, `updated_at timestamptz default now()`.
Partial unique index `(property_id) where status in ('queued','calling','paused')`; index `(status, next_attempt_at)`. Guard trigger: no transition out of `done|cancelled|exhausted`. **PROPOSED:** `created_at` is not guarded (tests backdate it to make reply-watermark comparisons deterministic inside one transaction).

### `norma_queue_attempts`
`id uuid pk`, `entry_id uuid not null`, `request_id uuid not null unique`, `local_date date`, `slot text check in ('A_am','A_pm','B','C')`, `sent_at timestamptz`, `sent_at_inferred boolean not null default false` ([C22]), `resolution text check in ('pending','final')`, `outcome text`, `final_source text null check in ('webhook','reconcile','reviewed')`, `updated_at`. One row per send attempted (only when `send_attempted_at` is set, [F6]).

### `norma_queue_digests`
`org_id`, `local_date date`, `edition text` (**PROPOSED** check in `('morning','evening')`), `payload jsonb not null`, `status text` (**PROPOSED** default `'pending'`), `attempts int default 0`, `locked_until`, `last_error`, `sent_at`; unique `(org_id, local_date, edition)`.

### `norma_followup_reassignments`
`id`, `org_id`, `request_id uuid not null unique`, `property_id`, `intended_assignee uuid`, `kind text check in ('callback_task','review_task')`, `payload jsonb`, `status text` (**PROPOSED** values `'open'|'resolved'`, default `'open'`), `created_at`, `resolved_by`, `resolved_at`.

### `norma_state_timezones`
**PROPOSED columns:** `state text primary key` (upper-case USPS code), `timezone text not null` (IANA). Rows == `STATE_TO_TZ` exported from `src/lib/messaging/quiet-hours.ts`, exactly.

### `norma_queue_control`
`singleton boolean primary key check (singleton)`, `enabled boolean not null default false`. Missing row = OFF. RLS enabled, no policies, ALL privileges revoked from PUBLIC, anon, authenticated, service_role. Read only by SECURITY DEFINER admission functions (SHARE row lock).

### Security matrix
- RLS enabled on all six new tables.
- `norma_queue_entries`, `norma_queue_attempts`: member SELECT only (policy copied from `norma_call_requests`; attempts derive tenancy via join to entries [C17 note]); no write privileges/policies for anon/authenticated.
- `norma_followup_reassignments`: org-member SELECT policy, no write.
- `norma_queue_digests`, `norma_state_timezones`: RLS on, no member policy (service only).
- Authenticated/anon INSERT/UPDATE/DELETE denied on every new table.

**PROPOSED (fixture latitude):** tests, as the table owner inside the rollback transaction, directly UPDATE `norma_queue_entries.status` to `queued` or `done` (with `end_reason`) to build settlement start-states, backdate `created_at`, and set `norma_call_requests.send_attempted_at` / `dispatch_started_at`. No CHECK or guard may forbid those owner-level writes (only leaving an absorbing state is forbidden).

## 3. Statuses / enums used by the functions
Entry status and pause_reason: see 2. Request open statuses (existing): `requested, dispatching, dispatched, dispatch_unknown, needs_review`.
Settlement outcomes: `no_answer | callback_requested | reached_no_callback | not_interested | wrong_number | unknown | reviewed` (`needs_review` accepted as an alias of `unknown`, plan rule 5). Sources: `webhook | reconcile | reviewed`.
Dialing window: **half-open [09:00, 19:30)** seller-local, Monday to Saturday ([Jarrad decision] for the hours; half-open is the pinned reading of 'to 19:30', consistent with the plan's `A_pm` interval [14:00, 19:30)). Tests pin 08:59:59 closed, 09:00:00 open, 19:29:59 open, 19:30:00 closed, in Tx1 claim, `claim_dispatch_v2` and `mark_sending`.

## 4. Functions
Common: every function below fails `42501` for non-service callers.

### `fn_norma_queue_block_reason(p_property_id uuid) returns text`
NULL when callable; otherwise a reason string. Covers: `fn_norma_eligibility` reasons, `properties.status in ('dead','closed')`, `outreach_dispo in ('wrong_number','bad_number','dnc','opted_out','not_interested')`, contact `do_not_contact`, effective **voice** consent opted out, effective **sms** consent opted out ([Jarrad 2026-10-07]; same latest-event rule as `consent.ts:79-84`: newest event ignoring `help_request`; `opt_out`/`provider_auto_opt_out` = opted out; `opt_in_*` = allowed), no callable phone. **Exact reason strings are not pinned** (PROPOSED: tests assert non-null only, and equality between this function and the enqueue `reason`), EXCEPT the two consent reasons, which are **PROPOSED** as exactly `voice_consent_opted_out` and `sms_consent_opted_out` (used by the runtime tests as `ineligible:<reason>`; needs review).

### `fn_norma_queue_enqueue(p_org_id uuid, p_requested_by uuid, p_property_ids uuid[], p_rep_context text) returns table(property_id uuid, result text, entry_id uuid, reason text, next_attempt_at timestamptz, display_tz text)`
One row per requested property. `next_attempt_at` and `display_tz` are the values SQL computed for the inserted entry (rule 1 / [B16]; the server action only passes them through); both NULL for rows that insert nothing (`blocked`, `open_request`, `unknown_state`); for `already_queued` they echo the existing entry. Pinned clock (wallclock Mon 2030-01-07 14:00Z, MO lead): `next_attempt_at = 2030-01-07T15:00:00Z`, `display_tz = 'America/Chicago'`. **PROPOSED `result` values:** `queued | already_queued | blocked | open_request | unknown_state`. `blocked` carries `reason`. Requester not an active member of `p_org_id`: whole call raises an exception whose message contains `requester_not_member` (PROPOSED shape) and inserts nothing. Inserted entry: `status='queued'`, `phase='A'`, `display_tz` = zone of `properties.state`, `next_attempt_at` = next window open (>= now), `requested_by` = `p_requested_by`. Idempotent: re-enqueue of a live property returns `already_queued` with the same `entry_id`. Unknown/NULL state -> `unknown_state`, no entry inserted.

### `fn_norma_queue_claim(p_entry_id uuid, p_now timestamptz, p_queue_enabled boolean, p_max_concurrent integer default null, p_daily_cap integer default null, p_cap_tz text default 'America/Chicago') returns table(result text, entry_id uuid, property_id uuid, contact_id uuid, phone_e164 text, requested_by uuid, rep_context text, lease_token uuid, dispatch_token uuid)`   — Tx1 of [C1]
**PROPOSED shape.** `FOR UPDATE SKIP LOCKED` on the entry. Requires `queued`, `next_attempt_at <= p_now`, `blocked_reason is null`. `result`: `claimed` | `blocked:<reason>` (entry -> `done`; includes `blocked:requester_not_member` when the requester is no longer an active member [B11]) | `window_closed` (entry stays `queued`, `next_attempt_at` RECOMPUTED by SQL to the scheduler slot at `p_now`, `> p_now`; the tick never reschedules) | `disabled` | `not_due` | `not_claimable` (not queued / locked / absorbing) | `unknown_state` (**R2, PROPOSED token**: the property's CURRENT state has no row in `norma_state_timezones`; the entry becomes `paused/unknown_state` with `dispatch_token` rotated, no lease, nothing counted, same effect as `fn_norma_queue_pause_unknown_state`) | `capacity_precheck` ([N2], plan rule 2; **PROPOSED** trailing defaulted limit args, both NULL = no pre-check): the non-binding count (same definitions as `claim_dispatch_v2`, all orgs, excluding nothing of this entry) is already `>= p_max_concurrent` or `>= p_daily_cap`; no request, no lease, nothing counted; entry stays `queued` with `next_attempt_at` RECOMPUTED (PINNED: the scheduler slot at `p_now`, so `>= p_now`, never left at its stale value) | `already_open` (plan rule 2: another request for the property is open; entry stays `queued` with a recomputed `next_attempt_at`, nothing created or counted). On `claimed`: `status='calling'`, new `lease_token`, new `dispatch_token`, `lease_expires_at = p_now + 15 minutes` (PROPOSED: `p_now` is the single clock input so tests are deterministic). Window evaluated in the zone recomputed from the CURRENT `properties.state` at `p_now`. `phone_e164` = the contact's first callable phone.

### `fn_norma_create_request_v2(p_property_id uuid, p_contact_id uuid, p_phone_e164 text, p_requested_by uuid, p_rep_context text, p_callback_assignee_id uuid, p_queue_entry_id uuid default null, p_queue_lease_token uuid default null) returns table(outcome text, request_id uuid, idempotency_key uuid, block_reason text)`   — Tx2 of [C1]
Same return shape as `fn_norma_create_request`. With `p_queue_entry_id`: locks request/property then the entry last; requires entry `calling` + matching `lease_token`; sets `last_request_id`; copies `lease_token` and `dispatch_token` to the request; callback assignee is `p_callback_assignee_id` (queue passes the requester). Cross-org / mismatched property/contact link, or lease mismatch -> raises (no request). Without `p_queue_entry_id` it behaves as `fn_norma_create_request`. A `blocked` outcome creates nothing (`request_id` null, as the button path); the tick then calls nothing and the entry is recovered by the block triggers / `fn_norma_queue_sweep_blocks` plus `fn_norma_queue_release_expired_leases` (`done` when `blocked_reason` is set). **PROPOSED / open (not asserted in SQL tests):** whether the queue path should instead insert a closed `dispatch_rejected` row so `fn_norma_queue_apply_presend(request_id, 'ineligible:<r>')` has an anchor; the tick unit tests cover both shapes (it applies only when a request id exists).

### `fn_norma_claim_dispatch_v2(p_request_id uuid, p_expected_attempt integer, p_now timestamptz, p_queue_enabled boolean, p_max_concurrent integer, p_daily_cap integer, p_cap_tz text) returns text`
**PROPOSED:** the plan's four arguments plus the three limits (`NORMA_QUEUE_MAX_CONCURRENT`, `NORMA_QUEUE_DAILY_CAP`, `NORMA_QUEUE_CAP_TZ`), because `norma_queue_control` carries no limits [E6]. Under global advisory lock `norma_dial_capacity`. **All time in this function is `p_now`; it never reads the wall clock.** 'Today' ([C8]) is the calendar day of `p_now` in `p_cap_tz`. Returns `claimed` (request -> `dispatching`, `dispatch_started_at = p_now`) | `queue_refused:<reason>` (entry not `calling`, `last_request_id` mismatch, lease expired at `p_now`, `dispatch_token` mismatch, `p_queue_enabled` false, `blocked_reason` set, window closed at `p_now` in the current property zone) | `capacity_concurrency` | `capacity_daily` | `number_busy` | `ineligible:<reason>` (**PROPOSED**: for ANY request, queue or button, shared `fn_norma_eligibility` incl. consent fails at claim time; request stays `requested`, nothing written) | `not_claimed` (**PROPOSED**: request not `requested` or wrong attempt). Refusals write nothing.
- Concurrency: count of requests in `dispatching, dispatched, dispatch_unknown, needs_review`, ALL orgs, excluding the candidate; refuse when `>= p_max_concurrent`. Held until final or reviewed ([E1]; no 30-minute bound).
- Daily: requests whose day (in `p_cap_tz`) of `coalesce(send_attempted_at, dispatched_at, dispatch_started_at)` equals the day of `p_now`, plus every request still `dispatching` with no `send_attempted_at`, plus unresolved legacy rows (`dispatch_unknown`/`needs_review` with no `send_attempted_at`, regardless of timestamps); refuse when `>= p_daily_cap`. A `dispatch_unknown` row keeps its own `send_attempted_at`, so a pre-midnight claim with a post-midnight uncertain send counts in the post-midnight day [C8].
- Number: `number_busy` when another request on the same `phone_e164` is in an open status (incl. `needs_review`) or has `coalesce(send_attempted_at, dispatched_at, dispatch_started_at)` less than 10 s before `p_now` [F3 spacing fallback].

### `fn_norma_claim_dispatch(p_request_id uuid, p_expected_attempt integer default null) returns boolean`  (legacy; replaced, same signature)
Always returns `false`, writes nothing, single overload `(uuid, integer)` in the catalog; the 1-argument call resolves ([E3]/[G1]).

### `fn_norma_mark_sending(p_request_id uuid, p_dispatch_token uuid default null, p_expected_attempt integer default null) returns text`
**PROPOSED shape.** Replaces `fn_norma_presend_fence` in `dispatchNormaCall` ([H1]). Returns `sending` or `refused:<reason>`. Under all admission locks, then reads `norma_private.fn_norma_wallclock()` **once** ([E2]) and uses that one value for every time check and for the stamp. Admits only when:
- request is `dispatching` (any other status, e.g. `dispatch_unknown` after reconcile, is refused and the row is left untouched [C9]);
- **freshness ([H1], carried over from the fence):** `dispatch_started_at` is within 90 s of the wall-clock reading;
- (queue rows) entry `calling`, `blocked_reason` null, `dispatch_token` matches the argument/request and `lease_expires_at` not passed, current-zone window open at the wall clock (half-open), `norma_queue_control` row exists with `enabled`;
- shared eligibility (incl. SMS/voice consent opt-outs) still passes, for queue AND button rows.
On `sending`: stamps `send_attempted_at` = the wall-clock reading and touches `updated_at` (as the fence did). On refusal, the return is `refused:<reason>` with this vocabulary (so the runtime can map it):
- fence-type: `stale_claim` (freshness > 90 s), `not_dispatching` (any other request status), `lease_mismatch` / `token_rotated` (dispatch token differs from the entry's / the request's), `lease_expired`;
- admission: `window_closed` (pinned by the E2 concurrency test), `control_off` (control row present with `enabled = false`; pinned by the E6 test), `queue_disabled` (a MISSING control row may answer `control_off` or `queue_disabled`), `blocked` (a block also rotates the token, so `token_rotated` may fire first);
- eligibility (incl. consent): `ineligible:<fn_norma_eligibility reason>`, the same string `dispatch.ts` uses.
What happens to the request on refusal:
- **queue row:** request -> `dispatch_rejected` (reason in `dispatch_error`), `send_attempted_at` stays null, no attempts row;
- **button row** (no `queue_entry_id`) **([B4], replaces the earlier 'leave dispatching for every reason')**: an eligibility/consent refusal closes the request `dispatch_rejected` with `dispatch_error = 'ineligible:<reason>'` (mirrors the existing `dispatch.ts` eligibility rejection); only fence-type refusals (`stale_claim`, `not_dispatching`, as in [H1]) leave the row untouched (`dispatching` / its current status, `send_attempted_at` null), which the runtime maps to the #793 `not_claimed` behaviour (reconcile expires it later). Admission-type reasons only arise for queue rows. Queue rows: EVERY refusal closes the request `dispatch_rejected`; the entry transition is then applied by `fn_norma_queue_apply_presend` / the lease watchdog.

### `fn_norma_eligibility(p_property_id uuid, p_contact_id uuid, p_phone_e164 text) returns table(eligible boolean, block_reason text)`  (existing function, extended [C25])
Additionally ineligible when the contact's effective consent state is opted out on the `sms` channel OR the `voice` channel, derived from `consent_events` by the latest-event rule of `consent.ts:79-84` (ignore `help_request`; newest `opt_out` / `provider_auto_opt_out` = opted out; newest `opt_in_*` = allowed). Applies to the button path (`fn_norma_create_request`), queue enqueue, claim_v2 and mark_sending alike (Jarrad 2026-10-07).

### `norma_private.fn_norma_wallclock() returns timestamptz`  (clock seam)
Volatile; default body `clock_timestamp()`; in schema `norma_private`; EXECUTE for anon/authenticated revoked. It is the **only** place SQL reads the real clock (enqueue, resume, settlement scheduling, `fn_norma_mark_sending`, `touch updated_at`, merge logging). Functions that take `p_now` use it and never the wall clock. Tests `create or replace` it inside their rollback savepoint to pin an instant.

### `fn_norma_queue_next_slot_for(p_state text, p_sends timestamptz[], p_now timestamptz) returns jsonb`  (pure)
No table reads, no clock. Returns exactly `{"kind":"slot","phase":"A|B|C","slot":"A_am|A_pm|B|C","at":"<ISO-8601 instant>"}` | `{"kind":"exhausted"}` | `{"kind":"unknown_state"}`. Oracle: `src/lib/norma/queue/scheduler.fixtures.ts`, run by `norma_call_queue_scheduler.integration.test.ts` with exact instant equality. A send is `A_am` when its local time is before 14:00, else `A_pm`.

### `fn_norma_queue_next_slot(p_entry_id uuid, p_now timestamptz) returns jsonb`  (entry wrapper)
Same JSON; state = the property's CURRENT `state`, sends = the entry's attempts ledger `sent_at` values. Settlement and resume write its `at` into `next_attempt_at` (e.g. a first send at 11:00 Chicago settled `no_answer` gives exactly 14:00 Chicago the same day). Attempts rows carry `local_date` (send's local date in the property zone) and `slot`.

### `norma_private.fn_norma_queue_park_for_reply(p_property_id uuid, p_message_created_at timestamptz) returns void`  (PROPOSED seam, [B19])
The `messages` AFTER INSERT trigger calls it; an exception in it aborts the inbound insert visibly. Tests replace it with a raising body.

### `norma_private.fn_norma_followup_reassignment_upsert(p_org_id uuid, p_request_id uuid, p_property_id uuid, p_intended_assignee uuid, p_kind text, p_payload jsonb) returns void`  (PROPOSED seam, [C23])
The single writer of `norma_followup_reassignments` for completion and escalation. `ON CONFLICT (request_id)`: `callback_task` supersedes `review_task` (kind, payload, assignee replaced, status reset to `open`); a second `review_task` is a no-op; a `review_task` never downgrades a `callback_task`.

### `merge_duplicate_properties(keeper_id uuid, loser_id uuid)`  (existing, extended [H8])
Repoints `norma_queue_entries` and `norma_followup_reassignments` from loser to keeper (attempts follow via `entry_id`; the ledger must survive the loser's request/property delete, **PROPOSED**: `norma_queue_attempts.request_id` has NO foreign key: it is a non-FK snapshot of the request id, so deleting the loser's requests (cascade from the property) leaves attempts rows, including `pending` ones, intact [N4]). If both properties have a LIVE entry, the survivor's is kept and the loser's becomes `cancelled` with `end_reason = 'merged_into:<keeper ENTRY id>'` (the id is the surviving ENTRY's id, not the keeper property's; still repointed to the keeper). This holds when the loser entry is `calling` with an in-flight request: the request is cascade-deleted, its attempts row remains, the survivor entry is untouched [N4]. An absorbing loser entry is repointed with its state unchanged. The 'log both' part of H8 has no pinned shape (`it.todo`).

### `fn_norma_queue_settle(p_request_id uuid, p_outcome text, p_source text) returns text`
**PROPOSED return:** `applied | noop | no_entry`. Locates the entry by immutable `request.queue_entry_id` (never by token); a request without `queue_entry_id` (button) locates the property's live entry. Upserts the attempts row by `request_id` ONLY when `send_attempted_at` is set ([C22]/[F6]). `unknown` keeps the attempt `pending`; any other outcome sets `final` with that outcome; a second final settlement is a no-op; a `pending` row can still be resolved by a later outcome. Precedence: absorbing > `blocked_reason` (-> `done`) > terminal outcome (-> `done`, even when paused) > paused (stays paused) > scheduling. `no_answer`: `calling` -> `queued` with next slot; `paused` stays. `unknown`/`needs_review` -> `paused/needs_review`; `reviewed` -> `paused/reviewed`. **[N6] pause_reason on an already-paused entry:** a paused entry keeps its `pause_reason` (`unknown`, `needs_review` and `no_answer` on `paused/rep_paused` leave `rep_paused`), EXCEPT `reviewed`, which sets `pause_reason='reviewed'`. Button request: terminal outcomes end any live entry; `no_answer|unknown|reviewed` change nothing. **A button send never writes `norma_queue_attempts` (rule 5):** no row from mark_sending, bind, completion or settle for a request without `queue_entry_id`.

### `fn_norma_queue_pause(p_entry_id uuid, p_actor uuid) returns text`
PROPOSED shape. `queued|calling` -> `paused/rep_paused`, rotates `dispatch_token`. Returns `paused | noop | refused:<reason>`. Absorbing: unchanged.

### `fn_norma_queue_resume(p_entry_id uuid, p_actor uuid, p_now timestamptz default null) returns text`
PROPOSED shape. `paused` -> `queued`, `reply_ack_at = now`, `next_attempt_at` from the scheduler. Refused (returns `refused:<reason>`, no change) while any open request exists for the property, while `blocked_reason` is set, or when absorbing, and (**R2**) for a `paused/unknown_state` entry while the property's current state is still unmapped: exactly `refused:unknown_state`; once the state maps again, Resume is allowed (`resumed`). Returns `resumed | refused:<reason>`.

**Authorisation (pause, resume, cancel; UI 'per-entry org authorisation'):** `p_actor` must be an ACTIVE member of the entry's org (any active member, not only the requester). Non-members, suspended members, members of other orgs and unknown uuids get `refused:<reason>` with no change. **Bulk resume** is the single-row resume applied per row: only `paused` entries resume; `queued`, `calling`, `done`, `cancelled` and a `paused` entry with an open request each answer `refused:<reason>` independently.

### `fn_norma_queue_cancel(p_entry_id uuid, p_actor uuid) returns text`
PROPOSED shape. Any live entry -> `cancelled`, rotates `dispatch_token`; an in-flight call still settles its attempts row. Returns `cancelled | noop`.

### `fn_norma_queue_apply_presend(p_request_id uuid, p_result text) returns text`  (PROPOSED shape; review B2, plan rule 4)
The store-port function the tick (and reconcile, for `stranded_requested_expired`; button rows keep `fn_norma_mark_dispatch_rejected`) calls with the outcome of an attempted dispatch. SQL owns EVERY entry transition and every reschedule (claim, apply_presend, settle, sweeps, triggers); the tick performs none. Dispatch result -> token: `queue_refused:<r>`, `capacity_concurrency`, `capacity_daily`, `number_busy`, `gate:<r>`, `bland_not_configured`, `pre_send_error`, `ineligible:<r>`; Bland HTTP 4xx except 408 -> `bland_rejected:<status>` (e.g. `bland_rejected:422`); Bland 408 / 5xx / timeout -> `bland_unknown`. Returns `applied` (it changed the request or entry), `noop` (nothing to do: replay, stale request, request already bound/completed), `no_entry` (button request: untouched). Acts on the entry only while `entry.last_request_id = p_request_id`, so a stale replay for an earlier request cannot requeue a newer call. Results (**PROPOSED tokens** for Bland: `bland_rejected:<http status>`, `bland_unknown`):
| `p_result` | request | entry | attempts |
|---|---|---|---|
| `queue_refused:*`, `capacity_concurrency`, `capacity_daily`, `number_busy`, `gate:<r>`, `bland_not_configured`, `stranded_requested_expired` | `dispatch_rejected`, `dispatch_error = p_result` (from `requested` or `dispatching`) | `queued`, `next_attempt_at` = scheduler slot at the wall clock (Monday 09:00 when the window is closed) | none |
| `pre_send_error` | `dispatch_rejected` | `queued`, due on the next tick (`next_attempt_at <= wall clock`) | none |
| `ineligible:<r>` | `dispatch_rejected` | `done`, `blocked_reason = <r>`, `end_reason = 'blocked:<r>'` (the same string as `fn_norma_eligibility`) | none |
| `bland_rejected:<4xx except 408>` | `dispatch_rejected` | `paused/provider_refused` | **none, even when `send_attempted_at` is set** (ruling) |
| `bland_unknown` (408 / 5xx / timeout) | `dispatch_unknown` | stays `calling` | `pending` row (`sent_at = send_attempted_at`) ONLY when `send_attempted_at` is set ([F6]); resolved later by webhook / reconcile / review |
Precedence still applies: a `paused` entry stays paused (keeps its reason), absorbing entries stay, a `calling` entry with `blocked_reason` goes `done`, `ineligible` ends a paused entry. Idempotent: a second identical call is a `noop` and changes nothing.

### `fn_norma_queue_release_expired_leases(p_now timestamptz) returns integer`  (PROPOSED shape; tick step 2)
Releases `calling` entries whose `lease_expires_at < p_now` and that have NO open request (`requested, dispatching, dispatched, dispatch_unknown, needs_review`): -> `queued` (`done` if `blocked_reason` is set), `next_attempt_at` = scheduler slot at `p_now`, nothing counted; the old lease can no longer create a request. Entries with an open request, live leases, and non-`calling` entries are untouched. Returns the number released; a second call returns 0. (Lease equality at exactly `p_now` is not pinned.)

### `fn_norma_queue_sweep_blocks() returns integer`  (PROPOSED shape; tick step 3; backstop for missed triggers)
For every live entry whose `fn_norma_queue_block_reason(property_id)` is non-null: set `blocked_reason`; `queued|paused` -> `done` with `end_reason = 'blocked:<reason>'` (PROPOSED vocabulary, same as claim); `calling` stays `calling` with `blocked_reason` set and a rotated `dispatch_token` (settlement converts it). Clean and absorbing entries untouched. Returns the number newly blocked; a second call returns 0.

### `fn_norma_queue_sweep_replies() returns integer`  (PROPOSED shape; tick step 3; [B19]/[C19] watermark)
Parks a `queued` entry as `paused/inbound_reply` only when an inbound message exists for its property with `created_at > coalesce(reply_ack_at, entry.created_at)`. Outbound messages, older messages, other properties, non-`queued` entries are ignored. Resume sets `reply_ack_at`, so re-evaluating the same message leaves the entry queued. Returns the number parked; second call 0. **R1 (resolved):** the sweep parks ONLY `queued` entries. A `calling` entry is never touched by the sweep (status and `dispatch_token` unchanged); a `calling` entry is parked solely by the `messages` AFTER INSERT trigger, which rotates its `dispatch_token`.

### `fn_norma_queue_pause_unknown_state(p_entry_id uuid) returns text`  (PROPOSED shape)
A `queued` or `calling` entry whose property's CURRENT state has no row in `norma_state_timezones` (unknown or NULL) -> `paused/unknown_state`, `dispatch_token` rotated (an in-flight call still settles by precedence); returns `paused`. A known state, an already-paused entry (keeps its reason) or an absorbing entry -> `noop`. Idempotent. **R2 (resolved, PROPOSED token):** claim on such an entry answers `unknown_state` (see `fn_norma_queue_claim`) and leaves it `paused/unknown_state`; Resume is `refused:unknown_state` until the state maps again.

## 5. Triggers pinned behaviourally
- `messages` AFTER INSERT (inbound, `property_id` not null): parks live entries `paused/inbound_reply` and rotates `dispatch_token`, only when `created_at > coalesce(reply_ack_at, entry.created_at)` ([C19]). Outbound messages never park. This is the only parking path.
- Property / contact / consent_events triggers: set `blocked_reason` on live entries; `queued|paused` -> `done` at once; `calling` keeps `blocked_reason` (and rotates `dispatch_token`) and settlement converts to `done` regardless of outcome ([B20]).
- `norma_call_requests` guard: `queue_entry_id` immutable and same-org/property/contact.

## 6. Test-clock strategy
- One rollback-only transaction on one connection; each test runs in a SAVEPOINT that is rolled back. Nothing reads the real clock and nothing is skipped.
- Functions with `p_now` (claim, claim_v2, resume, next_slot) are driven by fixed January 2030 instants (Chicago = UTC-6). Everything else reads `norma_private.fn_norma_wallclock()`, which each test replaces (default pin: Mon 2030-01-07 14:00Z = 08:00 Chicago, closed, so enqueue yields `next_attempt_at` = 15:00Z exactly).
- Fixture latitude: tests backdate `next_attempt_at` / `created_at` and write `send_attempted_at`, `dispatch_started_at`, `updated_at` as table owner (triggers off via `session_replication_role = replica` where a guard would interfere).
- Pre-migration rows ([E3]/[F3]/[G1]) are seeded by a hook that runs after the existing Norma chain and before the queue migration (`openQueueFixture(url, { beforeQueueMigration })`), in a second, separate fixture so they cannot skew the main suite's capacity counts.
- Concurrency (second `describe` in `norma_call_queue.integration.test.ts`, via `openConcurrentFixture`): a run-owned disposable DATABASE `q_<random>` on the loopback server (create database; `pg_dump --schema-only | psql` clone of the source schema, like `src/lib/norma/stress/db.ts`; apply the migration chain; `drop database ... with (force)` at the end), committed data and several `pg` clients. There `norma_private.fn_norma_wallclock()` is replaced by a body reading `public.zz_test_clock`, which the test moves. Covers [C7] (two orgs at limit 1: one `claimed`, one `capacity_concurrency`), [C1] (second `fn_norma_queue_claim` answers `not_claimable` without waiting), [E6] (OFF update blocks behind an in-flight `mark_sending`, later admissions refused), [E2] (`mark_sending` blocked on the control-row lock while the clock moves 19:29:59 -> 19:30:01 is refused). **PROPOSED:** `mark_sending` takes its control-row SHARE lock before reading the clock, and the control lock is observable as a row lock on `norma_queue_control`. Still `it.todo`: [B1] lock-order stress (probabilistic, 1,000 randomised runs; belongs to the stress harness).

## 7. Open questions
Business questions (each an `it.todo` marked `needs Jarrad`, nothing invented):
(none open: the two earlier questions are resolved by the rulings below)

Resolved by rulings (review round 2, derived from the plan): button sends never write the queue attempts ledger (rule 5); pause/resume/cancel allowed for any active member of the entry's org; `blocked_reason` reuses the source reason strings (equality with `fn_norma_eligibility` asserted); bulk resume refuses non-paused rows per row.

Resolved by engineering (reviewer, no rule text added):
- A `queued` entry settled `no_answer` records the attempt, stays `queued`, slot recomputed.
- `unknown` on `paused/rep_paused` keeps `rep_paused` (attempt recorded `pending`).
- Second `review_task` is a no-op ([C23]); asserted through the PROPOSED upsert seam above.
- A requester who left the org: claim answers `blocked:requester_not_member`, entry -> `done`.

Still open (not business rules): exact `blocked_reason` strings; shape of the H8 'log both' record.

## 8. Tracked tests GREEN must change
`src/lib/norma/dispatch.test.ts` (tracked) pins the legacy `fn_norma_claim_dispatch` claim and the `fn_norma_presend_fence` pre-send fence. When `dispatchNormaCall` moves to `fn_norma_claim_dispatch_v2` / `fn_norma_mark_sending` (see `dispatch.queue.test.ts`), those assertions must be edited or replaced. That edit of a tracked test requires explicit approval at GREEN; the RED phase leaves the file untouched and the existing suite passing.

## IMPLEMENTATION NOTES (GREEN, SQL)
Files: `supabase/migrations/20261099000000_norma_legacy_claim_disable.sql` (G1 migration 1) and `20261099000100_norma_call_queue.sql` (migration 2). The `20261099` prefix is temporary; Root retimestamps. Nothing here edits an existing migration.
Engineering choices where the contract left a shape open (no business rule added):
- `fn_norma_eligibility` is now a thin service-role wrapper over `norma_private.fn_norma_eligibility_core` (same body plus the voice then sms consent check). Triggers and sweeps call the core because they do not run under a service-role jwt. New reasons: `voice_consent_opted_out`, `sms_consent_opted_out`.
- `block_reason` reuses eligibility's strings first, then queue-only ones: `property_dead`, `property_closed`, `wrong_number`, `bad_number` (and the disposition itself for `not_interested`/`dnc`/`opted_out` when eligibility did not already refuse). "No callable phone" answers `phone_not_on_contact` (equal to what eligibility says for the same contact).
- `end_reason` values written by SQL: `blocked:<reason>`, `outcome:<outcome>` (terminal settlement), `cancelled`, `exhausted`, `merged_into:<keeper entry id>`.
- `resume` sets `reply_ack_at = coalesce(p_now, now())` (transaction time, the same clock as `messages.created_at`), and schedules from `coalesce(p_now, wallclock)`. Results: `resumed | refused:<not_found|not_authorized|not_paused|blocked|open_request|unknown_state|exhausted>`.
- `claim` answers `already_open` / `capacity_precheck` by recomputing `next_attempt_at` to the scheduler slot at `p_now` (pinned), which is `p_now` itself while the window is open: the entry is immediately due again. The tick loop must not re-claim the same entry in a tight loop within one tick.
- `fn_norma_mark_sending` vocabulary: `stale_claim`, `not_dispatching` (untouched row, also for queue rows), `lease_mismatch`, `token_rotated`, `blocked`, `lease_expired`, `queue_disabled` (no control row), `control_off`, `unknown_state`, `window_closed`, `ineligible:<reason>`. Locks taken before the single clock read: request row, lead (enrollments, contact, property), entry (SHARE), control row (SHARE; queue rows only). Closings go through `fn_norma_mark_dispatch_rejected` so drip pauses are released.
- Settlement hooks: `fn_norma_complete_call` (known outcome, source `webhook`), `fn_norma_mark_needs_review` (as `unknown`, source `reconcile`), `fn_norma_mark_reviewed` (`reviewed`), plus `fn_norma_bind_call_id` writes the `pending` attempts row when `send_attempted_at` is set. Task creation in completion/escalation is isolated: a `FORBIDDEN:` actor rejection records a `norma_followup_reassignments` row (`callback_task` / `review_task`) and the outcome still commits.
- A late `no_answer`/`unknown`/`reviewed` for an OLDER request does not move an entry that is `calling` a newer request (attempt is still recorded).
- `merge_duplicate_properties` also repoints the entry's `contact_id` to the survivor's homeowner contact (eligibility is per property and contact).
- `norma_queue_control` is seeded with one row, `enabled = false`.
- `norma_queue_entries.contact_id` has no FK to contacts (a contact delete must not cascade into the ledger); `norma_queue_attempts.request_id` and `norma_followup_reassignments.request_id` are non-FK snapshots.
Test-environment findings (not migration defects): see the GREEN report (shared loopback DB state, `organizations.name` uniqueness, `properties.state` / `contacts.phone_1_type` NOT NULL).

- Evidence run (disposable real-chain stack, all migrations <= 20261007999999 via e2e/stress/provision-stack.mjs): queue suites 466 pass / 5 todo; B1 lock-order stress (src/lib/norma/stress/queue-lock-order.integration.test.ts) 1,000 runs, 0 deadlocks, 0 hangs, 0 lost settlements, 0 lost blocks. Stress suite needs NORMA_QUEUE_MAX_CONCURRENT / NORMA_QUEUE_DAILY_CAP (vitest.norma-queue-stress.config.ts).
