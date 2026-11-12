# Multi-number SMS campaigns — technical plan (v7)

Date: 2026-11-11. Status: plan only, build not authorized. Code refs are `origin/main`
@ `750c74fda`. v5 answers Astra rounds 1 (8 blocking), 2 (4), 3 (4), 4 (1), 5 (1) and 6 (1); see §9.

## 1. Goal and non-goals

**Goal.** A Sandra SMS campaign can send from several Sendillo numbers that are all
attached to an approved Sendillo 10DLC campaign. Sellers who have never been texted are
spread evenly across the numbers. Each seller phone is pinned to exactly one Sendillo
business number, and every later Sendillo seller-facing text goes out from that number.
Jarrad can compare delivery per number.

**Why.** ~10% of campaign texts stay at `sent` with no delivered/failed receipt, flat for
weeks, spread evenly over AT&T / T-Mobile / Verizon. Sendillo support suggested another
number. A split across an old and a new number shows whether the number matters.

**Non-goals.**
- No automatic buying, releasing, or attaching of numbers (Jarrad does that in Sendillo).
- No automatic retirement/replacement of a number based on delivery stats.
- No per-number pacing. Pace stays per campaign (one stream shared by N numbers).
- No change to rep SMS (rep grant numbers; a rep's own number is a separate thread by
  design) or internal alerts (`REP_SMS_FROM_NUMBER`, bypasses `send.ts`).
- No change to any seller-facing text, rule, or classifier.
- **No re-assignment in v1.** An assignment, once written, is immutable except through
  an admin RPC that is not wired to any UI or automatic path (§3.3).

## 2. Current state

Code facts (checked in the checkout):
- One sender per campaign: `campaign_delivery_settings` `unique(campaign_id)`
  (`supabase/migrations/20260702013000_campaign_delivery_settings.sql:10-25`). Two lock
  triggers on **`campaign_delivery_settings`** (not on `messages`): update lock
  (`…013000…:158-191`, replaced in `20260702143000_…lock_bypass.sql:3-46`) and insert
  lock (`…143000…:48-81`). There is no sender guard on `messages` today.
- `persist_campaign_delivery_settings` (`…013000…:193-270`) is the only writer, called
  from `src/lib/messaging/delivery.ts:516`.
- `queueSmsBatch` resolves one sender (`src/lib/messaging/bulk-queue.ts:174-196`) and
  passes it as explicit `from` (`:549-557`).
- `resolveOutboundFromAddress` (`src/lib/messaging/send.ts:2849-2986`): explicit →
  sticky (latest inbound `to_address` for contact+property+seller phone, `:2989-3020`) →
  campaign → env default → inventory gate. `queueForLater` stamps `from_address`
  (`:1666-1688`); release uses the stamped value and only re-checks inventory
  (`:1858-1902`, `:2277-2280`).
- Callers with no campaign that fall to the env default for non-repliers: drips
  (`src/lib/sequences/tick.ts:532-538`), Norma precall
  (`src/lib/norma/precall-sms.ts:89-97`), seller reminders
  (`src/lib/my-leads/seller-reminder.ts:359`).
- Explicit-`from` callers: routing-v2 replies with the number the seller texted
  (`src/lib/ai-responder/dispatch.ts:6843-6852`); lead composer / inline reply with the
  picker value (`src/app/(dashboard)/leads/send-sms-stamped.ts:100-108`,
  `leads/actions.ts:2191`); rep SMS (`rep-sms.ts`); asked-offer backfill is sticky-only
  (`asked-offer-backfill.ts:483-490`).
- **Inbox bulk reply does not use `resolveOutboundFromAddress`**:
  `src/lib/inbox/reply-dispatch-sql.ts:68-92` takes a frozen sender from SQL and
  `src/lib/inbox/reply-provider.ts:39-42` posts it to Sendillo. Its SQL requires only
  catalog `status='active'` (`experiments/inbox-reply-preparation/recipient.sql:184-187`,
  `experiments/inbox-reply-send/attempts.sql:312-321`).
- Inbound matching: `src/lib/messages/threading.ts:340` narrows candidates by the
  business number, may return an ambiguous/contact-level result (`:368-399`);
  conversation identity stays contact/property (`:176-185`). Status receipts match on
  provider message id (`src/lib/messaging/status-events.ts`).
- First-text identity is per (seller phone, business number) with sent/delivered
  evidence (`send.ts:181-229`, release `:1817-1849`).
- Catalog `provider_sender_numbers` (`20260701160000_provider_delivery_setup.sql:12-28`)
  is synced on demand only (`src/lib/messaging/delivery.ts:83`). Sync stores
  `numberStatus`/`messagingStatus`, ignores `attachedCampaign`/`attachedBrand` (in `raw`).
- Migrations: `supabase db push --include-all` (`.github/workflows/db-migrate-test.yml:138`,
  CLI pinned 2.109.1) runs each file's statements and the history insert in one
  transaction. `scripts/check-migration-safety.mjs` checks history/ordering only.

Production observations (read-only SQL by Claude, 2026-11-11; not visible in the checkout):
- `messages`: ~188k rows, 144 MB. All Sendillo outbound in the last 60 days is from
  `+18164876899`.
- Catalog (last synced 2026-09-17): 4 rows, all Sandra-`active`. `+18164876899`:
  `messagingStatus Active`, `attachedCampaign "Kansas City Metro SMS Outreach"`,
  `attachedBrand "BMH Group"`. Two rows: `Inactive`, both attachments `"not assigned"`.
  One row: `Active` but attached to another brand. Sandra would let any be picked today.

Sendillo (public API manual, unauthenticated read): caller chooses `from`;
`invalid_campaign_sender`; "Assign Numbers" starts `PENDING`. Undocumented: messaging
webhook scope (account vs number), rate limits, the approved-state value.

## 3. Design

### 3.1 Keys and definitions
- **Seller key**: `(org_id, 'sendillo', seller_phone_e164)`, E.164 enforced by a check
  constraint (`^\+[1-9][0-9]{6,14}$`).
- **Sendable number**: catalog row with `status='active'`, `lower(messaging_status)='active'`,
  `attached_campaign` not null/empty/`'not assigned'`, and `attached_brand` equal to the
  org's Sendillo brand (new nullable column `organizations`-level setting
  `sendillo_brand_name`; when null the brand check is skipped, preserving other orgs).
  Implemented once as SQL function `is_sendable_sender(org, provider, phone)` and used by
  TypeScript through an RPC/view so app and SQL paths cannot diverge.
- **Pool number**: a sendable number that is a member of any `campaign_sender_numbers`
  row for the org, or the org's `default_sender_phone` (§3.8). Only pool numbers can be
  evidence, be allocated, or be adopted. A number used only for rep SMS is never a pool
  number.
- **Rep traffic**: outbound rows carrying `metadata.repSms` (written by
  `src/lib/messaging/rep-sms.ts:1017-1038` through the shared pipeline,
  `send.ts:908-924`), **and inbound replies that belong to a rep conversation**: an
  inbound is a rep reply when the most recent **dispatched** outbound from that same
  business number to that seller phone before it is a rep row — same qualification as
  the takeover matcher: only rows that pass `canEstablishRepSmsTakeover`
  (`rep-sms-human-takeover.ts:139-159`), ordered by `sent_at ?? created_at` (`:127-129`);
  queued/undispatched rows never hide rep ownership. This is the ownership rule the
  takeover matcher already applies (`src/lib/messaging/rep-sms-human-takeover.ts:319-354`, invoked at
  `src/lib/messaging/inbound.ts:1057-1064`, recorded at `:1088-1100`). The rule is
  computed from message rows, so it classifies historical inbound too. Rep traffic is
  never evidence, even when the rep's number is also a pool number.
- **Seller-facing Sendillo send**: any outbound SMS whose provider is Sendillo and whose
  recipient is a seller phone. Rep SMS and internal alerts are not in this set.

### 3.2 Schema — additive only in PR 1; no existing trigger or RPC is modified

**`campaign_sender_numbers`**
`(campaign_id fk, org_id, provider, phone_e164, position int, paused_at null, created_at)`;
`primary key (campaign_id, phone_e164)`; `unique (campaign_id, position)`. RLS: member
`select` only. All writes through security-definer RPCs that check org membership,
campaign/org/provider consistency, and E.164.
- **Backfill** in the same migration: one row (position 0) per existing
  `campaign_delivery_settings` row with a non-null sender.
- **Mirror trigger** `after insert or update on campaign_delivery_settings`: makes the
  settings sender the single position-0 row. If the primary changes (only possible
  before any outbound exists, per the existing update lock) the old position-0 row is
  deleted; if the new primary already exists as a secondary it is moved to position 0.
  Tests: unchanged save, unlocked primary change, primary := existing secondary. The unchanged application (old `persist_…` RPC) therefore keeps
  the table correct. Existing settings lock triggers stay exactly as they are: the
  primary still cannot change once outbound exists, and campaign/provider on a locked
  row are still protected.
- No trigger on `messages`. Sender correctness for campaign rows is enforced in the
  allocation RPC (§3.4) and the release-time check (§3.5), matching today's model where
  `messages` has no sender guard.

**`sms_sender_settings`**
`(org_id pk, pinning_enabled bool default false, pinning_enabled_at null, allocation_enabled bool default false, default_sender_phone null, admission_paused_at null, updated_at)`.
Member `select`; writes by service role only. Constraints enforced by trigger:
- `allocation_enabled` may become true only if `pinning_enabled` is true and
  `pinning_enabled_at <= now() - interval '1 hour'`.
- `pinning_enabled` may become false only if `allocation_enabled` is false **and** no
  row in `sms_sender_assignments` for the org has `sender_phone_e164 <> default_sender_phone`
  (evaluated over all assignments, regardless of source or campaign).
- `default_sender_phone` cannot change while pinning is enabled; enabling pinning
  requires it to be non-null and sendable, and sets `pinning_enabled_at = now()`
  (cleared when pinning is disabled). Comparisons are null-safe (`is distinct from`).
  A missing settings row means pinning off.
- **Lock protocol.** Every settings write takes
  `pg_advisory_xact_lock(hashtextextended(org||':sms_sender_settings',0))` (exclusive)
  in a `before` trigger, before evaluating the checks above. `resolve_sms_sender` takes
  the same key **shared** (`pg_advisory_xact_lock_shared`) before reading settings and
  holds it to commit. A settings change therefore waits for every in-flight resolution
  to commit and then sees its assignment; a resolution that starts later sees the new
  settings. Lock order is always settings (shared) → seller (exclusive).

**`sms_sender_assignments`**
`(org_id, provider, seller_phone_e164, sender_phone_e164, source text check in ('evidence_inbound','evidence_outbound','commitment','campaign','user_pick','default','admin'), source_campaign_id null, source_message_id null, assigned_at)`;
`primary key (org_id, provider, seller_phone_e164)`. RLS: member `select` only. No
`update` grant to any role; rows change only via `admin_reassign_sms_sender` (service
role only). Added to `reset_tenant_tables()`.

**RPCs (security definer, `search_path` pinned, execute granted to `authenticated` and
`service_role` unless noted)**
- `add_campaign_sender_numbers(p_campaign_id, p_phones text[])`: appends sendable
  numbers (max 49 per campaign). Never removes.
- `set_campaign_sender_paused(p_campaign_id, p_phone, p_paused bool)`: takes
  `for update` on the row. The primary can be paused. Pausing only stops new
  allocations.
- `resolve_sms_sender(p_org_id, p_seller_phone, p_campaign_id null, p_allow_default bool, p_requested_sender null, p_commitment_sender null)`
  → `(sender_phone, source, status)`. The single authority for the pinned number; §3.3.
  Flags and the default sender are read inside the function from `sms_sender_settings`
  (§3.8), never passed by the caller. When called by `authenticated` it verifies org
  membership for `p_org_id`; `public` execute is revoked on every new function.
- `admit_sms_submission(p_org_id, p_seller_phone, p_from)` → `ok | paused | conflict`:
  the **submission fence**, called by every seller-facing Sendillo path immediately
  before the provider call (immediate send `send.ts:1201-1205`, release `:2277-2280`,
  inbox transport `reply-provider.ts:39-42`). Takes the settings lock shared.
  `admission_paused_at` set → `paused` (immediate sends return a retryable "sending is
  paused for a few minutes" error with nothing submitted; queue release and inbox
  dispatch leave the row/attempt untouched for the next sweep). Pinning off → `ok`.
  Pinning on → `ok` only if `p_from` equals the seller's assignment (adopting `p_from`
  as a `commitment` if none exists and it is a pool number); otherwise `conflict`, and
  the message is held per §3.5 instead of submitted. Rep SMS does not call it.
  When the fence answers `paused` or `conflict` after release has already moved a row to
  `pending` (`send.ts:2008-2029`) or the inbox worker has committed `dispatch_started`
  (`experiments/inbox-reply-send-worker/runner.mjs:61-82`), the path performs an explicit
  pre-submission rollback to the prior state under the row's existing idempotency key;
  PR 2/3 specify and test pause → unpause → exactly one submission. For the inbox
  ledger this is a reviewed change to constraints that today make dispatch markers
  immutable and reject the reverse transition (`attempts.sql:209-210`, `:242-245`),
  designed together with replay fencing; the alternative PR 3 may choose is to call the
  fence before committing `dispatch_started`. The inbox worker's
  real runtime is the vendored transport (`experiments/inbox-reply-send-worker/server.mjs:51-55`);
  the fence, grants and deployment verification apply there. Because that worker is
  long-running (`server.mjs:101-105`), the drain for it is an explicit worker
  stop/confirm-idle step, not a time bound.
- `adopt_sms_sender_assignments(p_org_id, p_after_phone, p_limit)`: service role only;
  keyset-paged batch that calls the same resolution (evidence + commitments only, no
  allocation, no default) for every seller phone with Sendillo history or outstanding
  rows. Used once at activation (§6 step 3).
- `preview_sms_sender_conflicts(p_org_id)`: read-only; lists every outstanding non-rep
  Sendillo row (queued, scheduled, paused) and every undispatched inbox attempt whose
  sender differs from what resolution would assign for that seller, every seller
  with outstanding work on more than one number, and every possibly-submitted send
  (§3.3 step 2d: `is_possibly_submitted_sms`, inbox `dispatch_started`/`uncertain`)
  whose sender differs from that seller's evidence or assignment.
- `admin_reassign_sms_sender(...)`: service role only; not called by any code path in v1.
- `campaign_kpis_by_sender(p_campaign_id)`: per `from_address` for rows with that
  `campaign_id`: `queued`, `sent_total` (status in sent/delivered/failed), `delivered`,
  `failed`, `sent_no_receipt` (status `sent` and `sent_at < now() - interval '24 hours'`),
  `repliers` (distinct seller phones with an inbound whose `to_address` is that number
  and `created_at` after their campaign message). Percentages use `sent_total` as the
  denominator.

**Indexes** (plain `create index if not exists`, inside the normal transactional
migration; `set local lock_timeout = '5s'; set local statement_timeout = '120s'`):
- `messages (org_id, to_address, created_at desc, id desc) where direction='outbound' and channel='sms'`
- `messages (org_id, from_address, created_at desc, id desc) where direction='inbound' and channel='sms'`

At 188k rows / 144 MB each build is on the order of a second under a `SHARE` lock. If the
lock or statement times out the whole migration rolls back (no invalid index is left,
because it is not `concurrently`), the workflow fails, and it is re-run. PR 1 merge
precondition: rehearse the exact migration files with the pinned CLI (`supabase db push`
2.109.1) against the test project loaded to ≥ production row count, record build time,
and merge outside a campaign send window.

**Catalog**: add `attached_campaign`, `attached_brand` to `provider_sender_numbers`;
the PR 1 migration backfills both from `raw`; the sync fills them going forward.

### 3.3 `resolve_sms_sender` — one transaction, one authority

Takes the org settings lock shared (§3.2), reads `sms_sender_settings`, then serialises
per seller with `pg_advisory_xact_lock(hashtextextended(org||':sendillo:'||seller_phone, 0))`.

0. **Pinning disabled** → return `status='pinning_off'` (caller runs today's logic).
1. **Existing assignment** → return it. If its number is not sendable, return
   `status='assigned_sender_unavailable'` (callers fail the send; no fallback).
2. **Evidence** (phone-wide; org + `channel='sms'` + `provider='sendillo'`; business
   number is a pool number; rep traffic excluded; ties `created_at desc, id desc`):
   a. latest **inbound** from the seller phone whose `to_address` is a pool number and
      which is not a rep reply (§3.1) (`evidence_inbound`);
   b. else latest non-rep **outbound** to the seller phone with status in
      (`sent`,`delivered`) (`evidence_outbound`);
   c. else an outstanding **commitment**: `p_commitment_sender` if supplied (the stamp of
      the row being released / the frozen sender of the inbox attempt being dispatched),
      else the earliest non-rep outbound row to the seller phone that can still be sent —
      `status='queued'` (scheduled rows are `queued` with `scheduled_for`) or the paused
      state that campaign resume restores to `queued`
      (`20261021210000_…:353-370`) — if its sender is a pool number (`commitment`).
   d. else a **possibly submitted** send to the seller phone on a pool number
      (`commitment`), defined by one shared SQL predicate
      `is_possibly_submitted_sms(message)` used by resolution, preview, and adoption:
      **a provider attempt was started and no conclusive provider rejection is
      recorded.** Concretely, an outbound row that is `pending`; or `failed` with
      `metadata.providerOutcome='provider_unknown'` (`send.ts:1314-1328`, `:2334-2354`);
      or `failed` with
      `metadata.providerAttempt.recoveryReason='stale_pending_provider_attempt'` — the
      state the sequence-tick cron writes when it expires a pending send after 15
      minutes (`send.ts:69`, `src/app/api/cron/sequence-tick/handlers.ts:378-417`),
      which the code itself documents as an unknown outcome (`:280-288`); or any other
      row carrying `metadata.providerAttempt` without a definite rejection. The
      predicate reads existing metadata, so it covers historical rows as well as
      future ones, and it stays true across later recovery transitions. Plus an inbox
      attempt in `dispatch_started` or `uncertain`. Sandra cannot prove these did not reach the seller, so their sender
      is preserved. Elapsed time never clears them; only a conclusive provider result
      (a `failed` status callback / definite provider rejection) or operator
      reconciliation does.
   Rows that definitely were not delivered to the carrier — failed with a definite
   provider rejection, cancelled, skipped — are never evidence.
   If branches c/d find more than one distinct number for a seller, resolution returns
   `status='sender_conflict_unresolved'` and writes nothing; the seller's sends are held
   until an operator reconciles (same hold as §3.5).
3. **Campaign allocation** (only when `p_campaign_id` is given): lock the campaign's
   `campaign_sender_numbers` rows `for share`; eligible = un-paused and sendable.
   - `allocation_enabled` false → eligible is reduced to the primary, and only if the
     primary equals `default_sender_phone`; otherwise
     `status='campaign_has_no_sendable_number'`.
   - Eligible empty → `status='campaign_has_no_sendable_number'`. Never the default.
   - Else pick `eligible[1 + ((hashtextextended(seller_phone,0) % n) + n) % n]` over
     `phone_e164` order; insert assignment (`campaign`).
4. **Requested sender** (no campaign; `p_requested_sender` supplied by the composer for
   a first contact): if it is a pool number — and, while `allocation_enabled` is false,
   equal to `default_sender_phone` — insert assignment (`user_pick`); else
   `status='requested_sender_not_sendable'`. Under pinning the composer picker lists
   exactly the numbers this step would accept, so nothing selectable always fails.

**Invariant while allocation is off:** steps 3–5 can only ever write
`default_sender_phone`. Only evidence/commitments (numbers the seller already has
history or queued work with) can produce another number.
5. **Default** (no campaign, no requested sender, `p_allow_default`):
   `default_sender_phone` if sendable; insert assignment (`default`).
6. Otherwise `status='no_sender'` (callers behave as today's "no sticky" outcome).

Steps 1–2 always precede 3–5, so a requested or allocated number never overrides an
existing assignment or evidence, and a concurrent composer-vs-campaign first contact
resolves to whichever transaction takes the seller lock first; the other gets that row
at step 1.

Assignments are immutable, so there is no re-assignment race and inbound never writes
assignments. A seller who texts a pool number other than their assignment is answered
from the assignment; the event increments `inbound_on_non_assigned_number` on the
health card.

### 3.4 `resolveOutboundFromAddress` (TypeScript) with pinning on

Adds `fromProvenance: 'rep_grant' | 'inbound_reply' | 'user_pick' | undefined`.

- `rep_grant` (rep SMS): unchanged, bypasses pinning.
- Everything else that is a seller-facing Sendillo send calls `resolve_sms_sender` first.
  - `status='ok'`: that number is used. If an explicit `from` was supplied
    (`inbound_reply` from routing-v2, `user_pick` from the composer) and differs, the
    assignment wins; the mismatch is logged with provenance. The composer no longer
    offers a choice for an assigned seller: the picker shows the assigned number
    read-only, and the server action rejects a different value with
    `sender_conflicts_with_assignment` before any provider call. For a seller with
    no assignment and no evidence, the composer's pick is passed as
    `p_requested_sender` and becomes the assignment (§3.3 step 4), so first-contact
    composer sends keep working (`send-sms-stamped.ts:100-108`, `leads/actions.ts:2186-2194`).
  - `pinning_off`: today's code path, unchanged.
  - `assigned_sender_unavailable` / `campaign_has_no_sendable_number`: the send fails
    with that code, in the style of today's inactive-sender failure (`send.ts:1895-1900`).
  - `no_sender`: today's behaviour for the caller (e.g. sticky-only callers error).
- Rows stamped by the pinned resolver carry `metadata.senderPinned = true`.
- `queueSmsBatch` stops passing explicit `from` when the RPC does not answer
  `pinning_off`; it passes `campaignId`. Per 250-property page it batches: one read of existing assignments
  for the page's phones, then `resolve_sms_sender` only for phones without one.
- Inventory gate stays, using `is_sendable_sender`.

### 3.5 Release
Release keeps sending the stamped `from_address` and now calls
`resolve_sms_sender(..., p_commitment_sender := stamped)` first:
- `pinning_off` → today's behaviour.
- No assignment existed → resolution adopts one (evidence first, else the stamp as
  `commitment`). This is how rows queued before activation get an assignment; nothing is
  failed for merely predating the feature.
- Row has `metadata.senderPinned`: stamp must equal the assignment and be sendable, else
  the row fails with `sender_conflicts_with_assignment` / `assigned_sender_unavailable`.
- Row has no marker (legacy) and the stamp equals the assignment: sent as today.
- Row has no marker and the stamp differs from the assignment: **not sent**. The row is
  placed on a recoverable hold (stays unsent with `metadata.senderHold =
  'legacy_stamp_mismatch'`, excluded from release sweeps, counted on the health card).
  An operator action resolves it: re-stamp to the assignment (the opening-identity
  check then runs for that pair as for any send) or cancel. Nothing is silently
  rewritten and nothing is terminally failed.
Re-pace/pause/resume never touch `from_address` or `metadata.senderPinned`.

### 3.6 Inbox bulk reply path
- Preparation SQL (`experiments/inbox-reply-preparation/recipient.sql`): the frozen
  sender becomes `resolve_sms_sender(p_org_id => org, p_seller_phone => phone, p_allow_default => false)`.
  Under pinning, recipients whose status is neither `ok` nor `pinning_off` are excluded
  with that reason, as unavailable senders are today.
- Dispatch authorization (`experiments/inbox-reply-send/attempts.sql:312-321`): replace
  `status='active'` with `is_sendable_sender` **and** frozen sender = current assignment.
  A failed check ends the attempt through the existing durable-attempt failure path; no
  retry on another number.
- Attempts prepared under pinning carry a `sender_pinned` marker. Attempts prepared
  before activation do not; at dispatch under pinning they adopt through
  `p_commitment_sender` exactly like legacy queue rows: frozen sender equals the
  resulting assignment → dispatched under the existing predicate; differs → the attempt
  is held with reason `legacy_stamp_mismatch`, not sent. The attempt ledger has no hold
  state today (`attempts.sql:104`), sender identity is immutable (`:198-206`) and
  transitions are constrained (`:212-245`); PR 3 adds a durable hold state and its
  transitions as a reviewed ledger change. Recovery never re-stamps an attempt: the
  operator cancels the held attempt and a newly prepared, newly authorized attempt is
  created on the assigned number.
- **`pinning_off` branch (both preparation and dispatch):** when `resolve_sms_sender`
  answers `pinning_off`, the SQL runs today's sender selection and today's
  `status='active'` predicate unchanged. `is_sendable_sender` and the assignment
  equality check apply only under pinning.
- Installation: the change ships through the existing inbox backend packet and
  installer (`experiments/inbox-release/assemble-backend-packet.py:50-55`,
  `.github/workflows/inbox-installer.yml:69-71`), including grants so the constrained
  inbox execution roles can call `resolve_sms_sender` and `is_sendable_sender`; the
  installer verification covers those grants.

### 3.7 Validation and screens
- `resolveDeliverySelection` (`delivery.ts:367`) accepts `senderNumbers: string[]`:
  dedupe, 1–49, all sendable. First = primary, persisted by the existing RPC; the rest by
  `add_campaign_sender_numbers`.
- `properties/actions.ts:228-251`: `SENDER_LOCKED` becomes "requested set ⊆ campaign set
  and same primary".
- `campaigns/actions.ts:1085-1140` (revival): "every stamped `from_address` on the
  campaign's outbound rows is a campaign member or that seller's assignment".
- `ad-hoc-bulk-sms.ts:215-254`: same resolver change.
- `campaigns/delivery-select.tsx`: checkbox list; non-sendable numbers disabled with the
  reason. Callers `create-campaign-form.tsx`, `properties/bulk-sms-modal.tsx`.
- Campaign detail: numbers list + per-number KPI table + "add number".
- Health card: per-number `sent_no_receipt` %, counts of `assigned_sender_unavailable`,
  `campaign_has_no_sendable_number`, `inbound_on_non_assigned_number`.
- Catalog sync also runs from the Sendillo health-snapshot cron (PR 1, so sendable
  status is fresh before anything depends on it).

### 3.8 Activation switches (database, not env)
`sms_sender_settings` (§3.2) is the only switch. Every seller-facing Sendillo send path
— `resolveOutboundFromAddress`, release, bulk queue, inbox preparation and dispatch —
calls `resolve_sms_sender`, which reads the row inside the per-seller lock. There is no
per-process flag state, so workers on any deployment that contains PR 2+ agree.

**Activation fence (admission pause + drain + submission fence).** A send may have
resolved its sender off-path — including a composer's explicit non-default number
(`send.ts:2870-2872`, `send-sms-stamped.ts:100-108`) — and still be between resolution
and provider submission when pinning is switched on. Activation therefore runs as:
1. Set `admission_paused_at = now()`. From this commit on, `admit_sms_submission`
   answers `paused` on every seller-facing path of every PR 2+ deployment, so nothing
   new is submitted.
2. Drain: wait 15 minutes (3× the platform's maximum function duration). Any send that
   passed the fence before the pause has by then submitted or died. Pinning cannot be
   enabled unless `admission_paused_at <= now() - interval '15 minutes'` (DB-enforced in
   the settings trigger).
3. Run `preview_sms_sender_conflicts`; reconcile to zero. Sends that submitted during
   the drain are evidence if they reached `sent`/`delivered`, and commitments if their
   outcome is unknown (§3.3 step 2d) — either way their number is preserved for that
   seller, so a text Sendillo accepted but Sandra recorded as `provider_unknown` cannot
   be followed by a different number. Activation is blocked while any such send
   conflicts with the seller's other evidence.
4. Set `pinning_enabled` (same transaction may keep the pause).
5. Clear `admission_paused_at`. Every send that now reaches the fence — including one
   that resolved off-path before step 1 and was parked — is checked against the
   assignment: equal → submits; different → held, never submitted.
Precondition: no deployment older than PR 2 is serving (those have no fence).
The allocation-off invariant (§3.3) and the DB-enforced hour before allocation remain as
defence in depth. Rollback of pinning uses the same pause → drain → switch sequence.

**Rollback fence.** The settings lock protocol (§3.2) serialises "disable pinning"
against assignment writers, so the "no non-default assignment" check cannot miss a
concurrent commit.

`SMS_MULTI_SENDER_UI` (env) only shows or hides the multi-select; it has no effect on
sending.

Unflagged, shipping in PR 1: the sendable rule at campaign create **and revival**
(`campaigns/actions.ts:986` validates delivery before the archived lookup at `:1022`),
so a campaign whose stored sender is not sendable can no longer be created or revived.
That is an intended behaviour change, excluded from any "off = identical" claim, and
covered by a test. Locked revival keeps skipping settings persistence
(`campaigns/actions.ts:1189`); additional numbers are saved only through
`add_campaign_sender_numbers`, never by re-running the single-sender persist on a
campaign that already has outbound rows.

## 4. Slices (stacked PRs)

| PR | Content | Depends on |
|---|---|---|
| 1 | Tables (incl. `sms_sender_settings`, off), backfill, mirror trigger, RPCs, indexes, catalog columns + backfill, `is_sendable_sender`, sendable rule at create/revive, cron sync, types | none |
| 2 | Pinning: resolver + provenance, release adoption + check, composer lock + first-contact pick, drips/precall/reminders/routing-v2/asked-offer via resolver | #1 |
| 3 | Inbox bulk reply SQL + dispatch; bulk queue via `resolve_sms_sender`; validation generalisation; ad-hoc path | #2 |
| 4 | Multi-select UI, adoption batch runner, add/pause number, per-number KPIs, health card | #3 |

PR 1 gate: the **unchanged application** test suite (campaign create, revive, bulk
queue, release) passes against the new schema. Each PR: Claude review, Codex adversarial
review at current head (`APPROVE_MERGE: YES`), green CI, then merge through the normal
migration workflow.

## 5. Tests

- **Resolver RPC (integration, real Postgres)**: each step; newer failed/cancelled row on
  B does not override older delivered A; inbound on another property/contact for the
  same phone is found; queued-only commitment; evidence on a non-sendable number
  ignored; all numbers paused → `campaign_has_no_sendable_number`, no default, no
  assignment written; pause racing allocation (two sessions) never allocates a paused
  number; 50 concurrent resolves for one phone → one row, one number; allocation off →
  primary only; split within ±5% over 10k phones.
- **Round-2 cases**: first-contact composer send with a picked pool number creates a
  `user_pick` assignment; composer-vs-campaign first-contact race (two sessions) yields
  one assignment and both sends use it; campaign history on A + newer rep SMS on B →
  A; rep-only history on B, then first campaign → allocated from the campaign set, not
  B; inbound to a rep-only number is not evidence; campaign history on A → rep SMS on
  B → seller replies to B, **with B in the pool** → A; composer-vs-campaign race when
  the campaign wins: the composer send is rejected with
  `sender_conflicts_with_assignment` and the picker reloads showing the assignment; activation with an empty assignment
  table: queued row, paused-then-resumed row, and an inbox attempt prepared while
  pinning was off all send as stamped and leave an assignment when compatible; legacy
  stamp ≠ assignment (queue row, paused-then-resumed row, inbox attempt) is held, not
  sent; a held queue row is releasable after operator re-stamp, a held inbox attempt is
  replaced by a newly prepared attempt; `preview_sms_sender_conflicts` lists
  exactly those; deterministic boundary tests using injected pauses: (a) send holds
  after `pinning_off` and before submit, pinning is enabled and a composer first
  contact runs → both use the default; (a2) composer resolves **explicit non-default B**
  off-path and holds before the pending insert, activation runs (pause, drain, enable,
  unpause), a pinned first contact assigns A, the composer resumes → its submission is
  refused by the fence and held, B is never sent; (a3) during the pause every path
  returns `paused` and submits nothing; pinning cannot be enabled before the drain
  interval; delivered campaign A → sent rep B → queued ordinary B → inbound B: rep
  ownership still holds, evidence is A; (a4) off-path composer explicit B is accepted
  by the provider but the response is lost (`provider_unknown`), no callback arrives,
  activation completes → the seller's assignment is B and a later first-contact path
  uses B, never A; `provider_unknown` on B plus delivered history on A → activation
  blocked by the preview until reconciled; provider accepts explicit B → process dies
  with the row `pending` → the real stale-pending sweep expires it during the drain →
  activation with no callbacks → B is the assignment (or activation blocks if A
  evidence exists), never A after B; pause → unpause yields exactly one submission
  for a released queue row and for an inbox attempt; (b) resolver holds after reading settings and
  before commit, disable-pinning blocks until it commits and then is rejected if it
  wrote a non-default number; settings null/missing-row/combined-update cases; inbox
  preparation **and** dispatch golden tests with pinning off; settings trigger rejects allocation before the hour,
  rejects pinning-off with a non-default assignment of any source (including one with
  no campaign), and rejects default change while on; two app instances, one answering
  `pinning_off` just before activation, cannot produce a second number for a seller
  while allocation is off; bulk workflow spanning activation.
- **send.ts (unit + integration)**: assignment beats `inbound_reply` and `user_pick`
  explicit; composer conflict rejected before provider call; `rep_grant` unchanged;
  release rejects stamped ≠ assignment and unavailable; pinning off = golden-master of
  today's order for resolver, release, and inbox dispatch (existing tests untouched and
  green; create/revive sendable rule excluded).
- **Callers**: `tick.test.ts`, `tick.routing-v2.test.ts`, `precall-sms.test.ts`,
  `seller-reminder.test.ts` + transport integration, `send-sms-stamped.test.ts`,
  `dispatch.routing-v2-outbox.test.ts`, `routing-v2.dispatch.integration.test.ts`,
  `asked-offer-backfill` tests, `rep-sms*.test.ts`, `opening-identity.test.ts`.
- **Bulk**: `bulk-queue.test.ts`, `workflows/bulk-sms.test.ts` (flag flips mid-workflow
  between chunks), `properties/actions.bulk-sms.integration.test.ts`,
  `campaigns/actions.integration.test.ts` (create/revive, sendable rule),
  `20261021210000_…integration.test.ts` (+ `from_address` preserved), mirror-trigger and
  backfill migration tests, old-app-on-new-schema test.
- **Inbox bulk reply**: unavailable sender excluded at preparation; sender made
  unavailable after preparation fails the attempt without sending; frozen ≠ assignment
  rejected; existing durable-attempt tests green.
- **Rollback tests**: pinning on → allocate seller to B and send → allocation off →
  drip, reminder, precall, composer, queued release all use B; new seller gets primary.
- **E2E**: seed two mock sendable numbers in `e2e/inbox-acceptance/outbox-global-setup.ts`;
  spec: 2-number campaign → rows split → reply → drip and reminder from the same number.
- **Performance**: `explain (analyze)` of the three evidence queries on a prod-sized
  table uses the new indexes; budget < 5 ms each.

## 6. Rollout

0. **Provider proof (no code; needs Jarrad).** Jarrad attaches one more number to the
   BMH campaign in Sendillo. Claude re-syncs the catalog and records the raw row before,
   during (`PENDING`), and after approval — this fixes the real approved-state values,
   and `is_sendable_sender` is adjusted in PR 1 if they differ from §3.1. Then one text
   from the new number to Jarrad's mobile and one reply: `sent` + `delivered` callbacks
   and the inbound (with the new `to_address`) must all arrive in Sandra. This proves
   that number works; it settles webhook scope. If the inbound does not arrive, stop.
1. Merge PR 1. Checkpoint: catalog columns populated for all rows; sendable = exactly
   the numbers expected; cron sync observed once.
2. Merge PR 2–4, both flags off.
3. **Pinning on**, by the §3.8 activation sequence. Preconditions: no deployment older
   than PR 3 is serving (no invocations on older deployment ids for 15 minutes); no
   campaign is mid-send; `default_sender_phone` = current `SENDILLO_FROM_NUMBER`. Pause
   admission → stop the inbox reply worker and confirm idle → 15-minute drain → `preview_sms_sender_conflicts` is zero (including
   paused and later-scheduled work) or reconciled → enable pinning → run
   `adopt_sms_sender_assignments` to completion → re-run the preview (still zero) →
   restart the inbox worker → unpause. Seller texting is paused for roughly 20 minutes; done outside send hours.
   Checkpoint over 24h: zero `sender_conflicts_with_assignment`,
   `assigned_sender_unavailable`, and held `legacy_stamp_mismatch` rows; every assignment's number is
   the old number.
4. **Allocation on** (≥ 1 hour after step 3, DB-enforced; in practice after the 24h
   checkpoint). First 2-number campaign. Read `campaign_kpis_by_sender` at 72h.
   Sellers with history stay on the old number, so the comparison is restricted to rows
   whose assignment `source='campaign'` on both numbers to keep cohorts like-for-like.

**Rollback.**
- Stop multi-number: `allocation_enabled = false`. Assigned sellers keep their number
  everywhere; unassigned sellers get the primary; queued rows release unchanged; a
  running bulk workflow sees it on its next RPC call.
- Pinning can be turned off only while every assignment is on the default number; the
  settings trigger enforces this for all processes. Once a seller is on another number,
  pinning stays on and a pinning defect is fixed in code. If `sms_sender_settings`
  cannot be read, `resolve_sms_sender` raises and the send fails (retryable) rather
  than falling back to the legacy path.

## 7. Risks

- Webhook scope and approved-state value are undocumented → step 0.
- Assigned number later detached/released → that seller's automated texts fail loudly
  until an admin reassigns; visible on the health card. Accepted for v1.
- Overlapping lists make the split uneven (assigned sellers keep their number).
- T-Mobile daily cap is per brand; more numbers do not raise it.
- `SHARE` lock during index build → rehearsed, timed, off-window.

## 8. Jarrad decisions (default in brackets)
- Pacing stays per campaign [yes].
- Composer is locked to the seller's number [yes].
- First extra number: one he already owns in Sendillo [yes].

## 9. Change log
**v2 (Astra round 1)**
1. Concurrent index dropped → plain transactional index with timeouts + pinned-CLI
   rehearsal. 2. No message trigger; existing lock triggers untouched; backfill + mirror
   trigger keep the old app working. 3. Explicit sends no longer beat the assignment;
   provenance added; composer locked. 4. Inbound re-assignment removed; assignments
   immutable. 5. Evidence query defined (status-qualified, phone-wide, sendable-only,
   queued commitments). 6. Empty/paused campaign set is a hard stop; allocation is
   atomic in SQL. 7. Inbox bulk reply path included. 8. Two flags; rollback keeps
   pinning. Non-blocking items: refs corrected, production observations dated and
   separated, catalog backfill + checkpoint, RPC permissions/pause RPC/RLS, KPI
   definitions, flag-off wording.

**v3 (Astra round 2)** 1. Composer first contact: `p_requested_sender` initialises the
assignment under the seller lock. 2. Evidence limited to pool numbers and non-rep rows.
3. Legacy queued/paused rows and pre-activation inbox attempts adopt an assignment at
release/dispatch (`p_commitment_sender`), plus an eager adoption batch; legacy rows are
never failed for a mismatch; "by construction" claim removed. 4. Switches moved from
env/boot checks to `sms_sender_settings`, read in the RPC under the seller lock, with
DB-enforced ordering (pinning ≥ 1h before allocation; no pinning-off with non-default
assignments). Non-blocking: mirror-trigger rules, RPC signature/permissions, hash index
normalisation, inbox install route and grants, `queued`+`scheduled_for` wording,
rollout expectation, no re-persist on locked campaigns.

**v4 (Astra round 3)** 1. Inbound rep replies excluded from evidence by the takeover
ownership rule, also on shared pool/rep numbers and historical rows. 2. Conflicting
legacy stamps (queue, paused, inbox attempts) are held for operator reconciliation, not
sent; `preview_sms_sender_conflicts` gates activation. 3. Settings ↔ resolver lock
protocol (exclusive/shared advisory lock) serialises rollback; activation fenced by the
allocation-off invariant (only the default can be newly assigned) plus the DB-enforced
hour. 4. Inbox preparation and dispatch have explicit `pinning_off` branches that keep
today's logic. Non-blocking: picker/server eligibility aligned, settings null rules,
named-argument RPC example, race-test expectation.

**v5 (Astra round 4)** Activation is now pause admission → drain → reconcile → enable →
unpause, with a submission fence (`admit_sms_submission`) on every seller-facing path
immediately before the provider call, closing the off-path explicit-B composer race.
Non-blocking: rep-ownership lookup qualified (dispatched rows, `sent_at ?? created_at`);
inbox hold is a new reviewed ledger state with re-preparation, not re-stamping.

**v6 (Astra round 5)** Possibly-submitted sends (`pending`, `provider_unknown`, inbox
`dispatch_started`/`uncertain`) are commitments that preserve their sender and are
covered by the conflict preview; time alone never clears them. Non-blocking: explicit
pre-submission rollback after a fence refusal with exactly-once tests; the inbox
worker's vendored transport and stop/confirm-idle drain named.

**v7 (Astra round 6)** The possibly-submitted predicate is one shared SQL function keyed
on "provider attempt started, no conclusive rejection", which includes rows the
stale-pending cron expires (`stale_pending_provider_attempt`) and historical rows.
Non-blocking: inbox dispatch-marker constraints named as a PR 3 obligation.
