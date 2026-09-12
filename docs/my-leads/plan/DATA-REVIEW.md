# P01–P03/P05–P06 data and workflow review

## Final root dispositions

The numbered findings below preserve the reviewer's initial snapshot; they are not all open defects. See IMPLEMENTATION-REVIEW.md for the assembled review outcome.

- Finding 1: broader former-assignee property-detail access is **not accepted**. CONTRACTS §3/§6/line 94 preserve selected-member scope, history after designation changes, and immutable KPI credit; they do not grant former assignees ongoing access to current property notes after reassignment. The concrete appointment-actor discrepancy was fixed with immutable booking credit plus separate current-assignee lifecycle authorization, and regressions pass.
- Finding 2: existing fail-closed DNC egress checks are retained. Signed local receiver transport passed. Deployed provider parity remains a release gate; recording late historical evidence is not a permission-to-dial defect.
- Finding 3: finite/nonfuture offer and decline events and finite ordered follow-up are now enforced; direct-RPC regressions and full-schema replay pass.
- Finding 4: target-data/locking preflight remains a release check; no source-incompatible disposition value was found.
- Finding 5: ineligible clocks are intentionally retained without retroactive eligibility. Designation affects future timing, not access-role semantics; no expanded eligibility is inferred.
- Finding 6: malformed direct RPC casts fail atomically and the UI maps failures to a safe error. The generic validation wording is a nonblocking limitation, not an authorization bypass.

Status: implementation review only. No hosted database, provider, deployment, or
launch operation was used.

## Baseline and scope

The Sandra source baseline is GitHub main `8c7053e7024433f46791eac1b186c1b7a7cf10ec`
(10 September 2026). The P01–P03/P05–P06 files reviewed here are uncommitted
changes in the Sandra PRD worktree layered on that baseline. The P13 launch
operation is excluded. Findings below are based on the source as read, not on a
production schema or live provider configuration.

## Findings requiring action or explicit acceptance

### 1. P1 — Property detail cannot currently expose reassigned history

`fn_get_acquisition_detail` first applies the normal read scope and then requires
the property’s *current* `assigned_user_id` to equal the selected member
(`supabase/migrations/20260912113000_acquisition_detail.sql:31-35`). That is
appropriate for an active member’s current queue, but it prevents an owner from
opening a former member’s property history after the decline/handoff transaction
reassigns it. The contract says historical episode and activity access survives
designation changes and reassignment (`docs/my-leads/CONTRACTS.md:45,94,149`).

The same detail projection also emits `t.assignee_id` as the appointment actor
(`20260912113000_acquisition_detail.sql:14-19`). Appointment accountability is
captured immutably at booking in `acquisition_appointment_attribution`
(`20260912111000_acquisition_kpis.sql:3-9`), and the KPI query correctly uses
that table (`20260912111000_acquisition_kpis.sql:47-56`). Consequently, an
appointment reassigned through the canonical lifecycle can display a different
actor in detail than the actor credited by KPI.

Minimum change: separate the active-queue authorization check from a property
history check, and use the immutable appointment attribution for the detail actor.
Keep mutation authorization bound to the current episode/assignee. Add tests for
owner inspection after reassignment, appointment reassignment, and reschedule
successor attribution. If product intentionally limits detail to current
assignees, record that as a contract change rather than silently shipping the
current behavior.

### 2. P1 acceptance seam — DNC egress guards are present; tracked routing still needs proof

The Sandra start action re-runs the existing eligibility path immediately before
the Jitter request. `prepareLeadCall` loads the durable property lock and contact
DNC fields, classifies them, and rejects a blocked target
(`src/lib/dialer/actions.ts:87-119`); `startAuthenticatedJitterCall` explicitly
does this re-check rather than trusting the browser target
(`src/lib/dialer/jitter-server.ts:236-263`). It then binds the acquisition
context and sends the request with the stable token and tracked episode when
available (`src/lib/dialer/jitter-server.ts:307-333`).

Jitter’s product-live-list executor also re-reads the durable batch-item dial
state immediately before `create_call`. Missing or non-callable rows are
suppressed and read failures defer the operation
(`Jitter worktree: src/mvp/product-execution.ts:1115-1185`); the worker orders capability
authorization before this DNC/calling-window check
(`Jitter worktree: src/mvp/product-execution.ts:2009-2053`). This is a fail-closed egress
guard for the product-live-list path.

The call-start receiver’s later DNC check is not a defect: it records an already
created seller-call fact, then gates queue/status advancement
(`supabase/migrations/20260912100000_acquisition_call_evidence.sql:98-121`). A
late event must preserve truthful history and the original actor/episode without
advancing a new owner. The remaining P07/P08 acceptance seam is to prove that a
tracked My Leads request always enters this product-live-list path with the
durable batch-item link, and to exercise a lock race between Sandra preparation
and the Jitter pre-egress read. If a tracked request can bypass that path, add
the equivalent final guard there; if the link is absent, the current live-list
guard safely refuses the dial but the feature is incomplete.

### 3. P1 — Offer and decline timestamps accept values that attempts/contracts reject

Manual attempts require finite, non-future `occurredAt`
(`supabase/migrations/20260912101000_acquisition_manual_attempts.sql:21-25`),
and contract recording makes the same finite/past check for `signedAt`
(`supabase/migrations/20260912120000_acquisition_workflow_commands.sql:502-506`).
The offer command validates only non-null `sentAt`/`followUpAt` and their ordering
(`20260912120000_acquisition_workflow_commands.sql:326-332`); its table constraint
also checks only `follow_up_at > sent_at`
(`20260912090200_acquisition_attempt_offer_facts.sql:99-106`). Decline checks
only that `occurredAt` is non-null (`20260912120000_acquisition_workflow_commands.sql:601-604`).

Direct RPC callers can therefore record a future or infinite offer/decline event
(for example, an infinite follow-up is greater than a finite sent time). This
would distort period KPIs and warning evaluation. Add finite and past checks to
the offer and decline command boundaries, then add direct-RPC tests; do not rely
on the client form. The persisted facts should remain event-time facts and keep
the original actor.

### 4. P2 / release preflight — Disposition CHECK replacement is source-compatible but needs target-data rehearsal

P05/P06 drops and recreates `properties_outreach_dispo_check`
(`supabase/migrations/20260912120000_acquisition_workflow_commands.sql:8-15`).
The source list carries forward the known legacy dispositions and adds
`needs_sequence`/`booked_appointment`; it is compatible with
`045_outreach_dispo.sql:24-34` and the appointment widening migration
(`20260814150000_appointments_schema.sql:475-490`). No source omission of a
known value is proven. The operational risk is that adding the CHECK scans the
table under a lock: an unrecorded historical value can fail it, and a
long-running writer can delay unrelated traffic.

Before release admission, run a read-only distinct-value inventory against the
target schema and rehearse lock timing/execution order. Escalate only if the
inventory finds an unmapped value or the timing rehearsal exceeds the release
window; otherwise this remains a deployment preflight rather than a verified
application defect.

### 5. P2 — Ineligible assignment episodes are returned by the active queue query

The assignment observer intentionally records an episode with `eligible=false`
when the organization is configured but the member is not designated or the
assignment is otherwise suppressed (`supabase/migrations/20260912090100_acquisition_queue_episodes.sql:250-282`).
The queue projection joins any open episode for the selected member but does not
filter `e.eligible` (`supabase/migrations/20260912110000_acquisition_read_model.sql:44-72`).
The read-scope helper explicitly permits self selection regardless of designation
(`20260912110000_acquisition_read_model.sql:31-34`). Such a row can appear as
`not_contacted` with `clockEligible:false` and no timing warning.

This may be deliberate traceability behavior, but the PRD calls the queue an
eligible assignment workflow while also requiring prelaunch/ineligible periods
to be retained. Confirm the product decision. If ineligible rows are visible,
label/filter counts accordingly and ensure they never contribute to stale or
first-call KPIs. If they are hidden, add `e.eligible` (or a separate history
projection) to the query and test designation-off/re-enable cases. Treat this as
a contract clarification until decided, not as a proven data-integrity failure.

### 6. P2 — JSON wrappers can bypass the intended `INVALID_INPUT` error shape

The authenticated P05/P06 JSON wrappers cast fields such as UUID, bigint, and
timestamptz before invoking the scalar validators
(`supabase/migrations/20260912120000_acquisition_workflow_commands.sql:811-831,
835-860,886-905`). A malformed value raises PostgreSQL’s cast error rather than
the command’s explicit `INVALID_INPUT` exception. This is safe against
unauthorized writes because all functions still authenticate and the underlying
tables have no browser grants, but the UI receives a generic database failure
instead of a typed validation response. Normalize/catch casts at the wrapper
boundary or document the error mapping and test malformed direct RPC input.

## Behaviors that are compatible with the PRD

- P01 defaults `memberships.acquisitions_enabled` and the org gate off, revokes
  direct table/column access, and limits designation/settings changes to
  authenticated owner RPCs. The designation trigger rejects legacy direct
  changes (`20260912090000_acquisition_settings.sql:7-11,98-146,172-185,278-281`).
- P02 uses composite tenant/property/episode references, an open-episode unique
  index, and an assignment-only observer. It closes the prior episode, preserves
  queue stage on ordinary reassignment, and seeds an advanced stage only at the
  assignment/enrollment boundary (`20260912090100_acquisition_queue_episodes.sql:125-178,205-315`).
  The shared-status mapping is intentionally one-way at that boundary: an
  absent queue row reads as `not_contacted`, while `contacted`, `interested`,
  `offer_sent`, and `under_contract` seed their corresponding later stages;
  arbitrary later Leads-board status edits do not reverse-sync queue stage
  (`20260912090100_acquisition_queue_episodes.sql:284-303`).
- P03 separates automatic Sandra calls from manual DialPad/outreach. The manual
  command accepts only resolved outcomes, while the service-only call evidence
  path creates one Sandra pending attempt and deduplicates by the stable context
  token (`20260912101000_acquisition_manual_attempts.sql:21-25,36-66`;
  `20260912100000_acquisition_call_evidence.sql:69-103,130-133`). A form retry
  and a provider retry therefore have distinct identities.
- P05/P06 authenticate before replay, hash the request, lock property → queue →
  episode → offer, use expected status/episode/version CAS fields, and record
  the command/event in the same transaction. Decline/handoff archive before the
  marked reassignment and set existing `needs_sequence`; they do not enroll,
  create a task, send a message, or send eSign (`20260912120000_acquisition_workflow_commands.sql:184-242,353-402,601-648,688-724`).
- All new acquisition tables are RLS-enabled with `REVOKE ALL`, and public
  mutations are narrow authenticated RPCs. Historic actor references use
  `auth.users` with `ON DELETE RESTRICT`; Hugo’s activity check discovers every
  single-column public FK to `auth.users` from the catalog, so these new actor
  references are included without a hand-maintained table allowlist
  (`20260912090000_acquisition_settings.sql:16-47`;
  `20260912090200_acquisition_attempt_offer_facts.sql:6-70,72-124`;
  `20260727150000_hugo_access_provisioner.sql:261-300`). This remains a schema
  rehearsal item because no hosted deletion workflow was exercised.
- Existing appointment booking remains the canonical task/lifecycle path. It
  requires an active same-org assignee, creates the task and calendar ledger in
  one transaction, and uses an optional org-scoped idempotency key with a
  request-mismatch check (`20260814170000_appointment_booking_rpcs.sql:539-631,694-835`).
  Offer method `dropbox_sign` is only a stored method label in P05; no eSign send
  is called by the workflow command.

## Execution order and proof still needed

The additive dependency order is P01 settings/receipts, P02 queue/episodes,
P03 attempts/offers and call evidence, read/KPI/detail projections, then P05/P06
workflow commands. Appointment attribution must exist before feature KPI/detail
acceptance; existing appointment lifecycle/provider workers remain independent.
For tracked calls, the verified Sandra receiver must be deployed before the P07
producer is enabled. P13 cohort initialization is intentionally outside this
review.

Before release admission, require these focused proofs:

1. owner/former-member detail after reassignment, immutable appointment actor
   through reassign/reschedule, and unknown existing appointment accounting;
2. tracked-call routing to a durable product-live-list batch item, the pre-egress
   DNC lock race, and late call evidence retaining original actor/episode without
   advancing a new owner;
3. direct RPC future/infinite offer and decline timestamps;
4. disposition-value inventory and lock/execution rehearsal on the committed
   schema;
5. designation-off/prelaunch queue visibility and KPI exclusion semantics.

## Local validation

From the Sandra PRD worktree, the bounded checks completed successfully:

- `npm test -- src/lib/my-leads/settings.test.ts src/lib/my-leads/validation.test.ts src/lib/my-leads/workflow-actions.test.ts src/lib/my-leads/launch.test.ts` — 4 files, 40 tests.
- `node scripts/verify-acquisition-evidence.mjs` — local PG17 fixture and evidence/reassignment/KPI assertions passed.
- `node scripts/verify-acquisition-time.mjs` — six deadline/minute vectors and grant isolation passed.
- `npm run verify:migration-safety-unit` — completed successfully.
- `npm run typecheck` — passed.

These are local fixture/unit results, not a hosted migration, live provider, or
production acceptance claim. No source outside this owned review document was
modified.
