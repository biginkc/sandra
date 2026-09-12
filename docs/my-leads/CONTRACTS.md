# My Leads — frozen implementation contracts

**Technical proposal v1, September 11, 2026.** Implements [PRD v0.2](PRD.md). This document resolves alternatives in the three research memos for the execution packets. It is a specification, not applied SQL or deployed API. Revalidate source baselines before coding; changing these interfaces requires updating dependent packets, not a new product interview for routine implementation details.

## 1. Core choices

- Separate queue state, assignment episodes, attempt facts and offer facts. Keep the existing shared status enum and lead identity.
- Acquisitions is `memberships.acquisitions_enabled boolean default false`. Preserve access roles. A narrow owner RPC plus a designation-specific database guard verifies active same-org owner authority for any change to this field, including direct legacy membership UPDATE paths. Do not alter Hugo-owned access columns or role semantics.
- Do not modify the global admin users page. Owner management UI belongs inside My Leads and resolves a same-org roster through the existing authenticated server pattern.
- New feature tables are RPC-only for authenticated clients: RLS enabled, no direct authenticated/anonymous SELECT or mutation grants. Existing source tables retain their current grants/RLS. Narrow read and mutation definers use `search_path=''`, fully qualified relations, explicit active membership/selection checks and restricted execute grants. Service-only provider ingestion is not an authenticated-user RPC.
- Current warning evaluation derives from persisted event/assignment timestamps and server time. No stored stale boolean, cron, new automatic scheduler, or client-authored `now` is authoritative.
- No requirement to update the mockup first. No new eSign or DialPad voice integration.

## 2. Storage contract

Use the data research’s `acquisition_*` namespace with the following final requirements. This list controls where the preliminary research SQL differs. SQL fragments in research are explanatory sketches, not copy-ready migrations.

| Storage | Required fields and invariants |
|---|---|
| `memberships` addition | `acquisitions_enabled`; protected owner-only change, default false. Snapshot eligibility into new episodes. Toggling does not rewrite historic episodes or permissions. |
| `acquisition_org_settings` | `org_id` PK, `my_leads_enabled=false`, verified `needs_sequence_owner_id`, launch/cutover metadata. Validate active same-org recipient at configuration and each handoff. No names/emails used as mutation identities. |
| `acquisition_launch_cohorts` | ID/org/member, planned/running/complete state, preview fingerprint/count, cutoff, actor/timestamps. Exact cohort and prior values are preserved with per-property initialized state and episode history. No bulk action in migration. |
| `acquisition_queue_states` | Property/org composite identity; stage `contacted|needs_offer|offer_sent|under_contract`; stage entry time; motivation kind/text/by/time; archive reason/by/time; `version bigint`; launch cohort/prior status; signed-at/by fields for contracts even when no offer row exists. Missing state with an open episode derives Not contacted. No stage alias to shared status. |
| `acquisition_assignment_episodes` | ID/org/property/assignee; live or launch; eligibility snapshot; verified `assigned_at` or null for unknown launch; initialization/end time; earliest actual first-call time, actor, evidence identity and optional call activity link. One open episode per property. Historic records retain original actor identity after membership changes. |
| `acquisition_attempts` | ID/org/property/episode/original actor; kind call or outreach; source sandra/dialpad/manual; nullable outcome for an initiated Sandra call awaiting result; occurrence and record timestamps; optional recording/note/activity link; immutable logical provider key and request ID. Count only actual occurred attempts, never call-intent reservations. |
| `acquisition_offers` | ID/org/property/episode/original actor; positive amount in integer cents; method; sent and required follow-up instants; pending/accepted/declined outcome plus outcome time/by; request ID. Preserve offer history. At most one active pending offer per property in v1; return existing pending offer on retry and reject a distinct second pending offer until a deliberate supported outcome. |
| `acquisition_commands` | Org, actor/service identity, operation, idempotency UUID, canonical request hash, minimal committed result, created_at. Unique `(org_id, operation, idempotency_key)`. Includes a server-only call-context binding operation keyed by the stable call token, which is not an attempt. No secrets or signed credentials in stored payload/results. |

| `acquisition_query_cursors` | Opaque random UUID token PK, org/viewer/selected member, normalized query/stage/sort boundary, shared snapshot instant, expires_at. RPC-only; SQL issues and validates tokens. Five-minute TTL, bounded expired-row cleanup on issuance, no new scheduler. |
| `acquisition_appointment_attribution` | Task/org composite identity, immutable accountable rep (appointment assignee at booking), capture time/source. Add only if the P09 audit cannot identify equivalent immutable canonical evidence; exact adapter rule below. |

### Constraints that must be explicit

- Add the exact composite UNIQUE keys referenced by every composite FK, including episode `(id,property_id,org_id)`. An episode or call-activity reference must match both property and org, not merely an arbitrary UUID.
- Do not use membership FKs that erase history or unexpectedly prevent existing member removal. Use immutable user IDs with existing identity-deletion safety conventions; validate active membership during actions, not as a requirement that every historic actor remain a current member. Verify Hugo pristine-deletion/activity detection when adding new actor references; no cascading deletion of attempts/offers as a role toggle effect.
- `specified` motivation requires non-null, nonblank text; `no_motivation` requires an explicit recorded-by/time and no invented temperature; unanswered has no response. SQL CHECK must handle NULL explicitly. Existing `properties.motivation_level` remains hot/warm/cold/null.
- Valid source/kind pairs: `(sandra,call)`, `(dialpad,call)`, `(manual,outreach)`. Only Sandra initiation may have pending/null outcome. No Boolean equivalence that accidentally excludes DialPad calls.
- Offer outcome pending requires outcome time/by both null; resolved requires both non-null. Follow-up must be after sent time; delayed historical logging may legitimately enter overdue state. UI never invents a follow-up or schedules a task from it.
- Episode end may equal start for same-instant handoffs. Actual first call must lie within the original assignment interval to satisfy that episode. Late delivery time may be outside it; occurrence time is what matters. A call by someone other than the assigned Acquisitions rep counts for its performer but does not satisfy that rep’s response clock.
- Uniqueness fences: provider key per org/source, call activity link where present, form request identity, open episode, pending offer. Provider key canonical format and alias resolution are defined in §5.
- Add indexes on org/assignee/episode start, active queue stage/property, original actor/occurrence or sent time, property history and pending follow-up. No `now()` in an index predicate.

## 3. Authorization and mutation envelope

Server actions resolve authenticated caller and org. Owner may inspect selected Acquisitions rep; a member may inspect self only. Being Acquisitions is timing eligibility, not a new access role. Read requests never substitute viewer for performer. Owner-performed actions are credited to owner; owner inspection alone writes nothing.

Property-scoped business commands include `propertyId`, `expectedEpisodeId`, `expectedQueueVersion` (0 for no state), `idempotencyKey`, and command-specific data. When shared status is relevant, compare its expected/current value under the same property lock; do not blindly overwrite a board edit.

```ts
type QueueStage = 'not_contacted' | 'contacted' | 'needs_offer' | 'offer_sent' | 'under_contract';
type ErrorCode = 'UNAUTHENTICATED' | 'FORBIDDEN' | 'FEATURE_DISABLED'
  | 'NOT_FOUND' | 'STALE_ASSIGNMENT' | 'STALE_STATE' | 'DNC_LOCKED'
  | 'INVALID_INPUT' | 'IDEMPOTENCY_CONFLICT' | 'RECIPIENT_UNAVAILABLE'
  | 'PENDING_OFFER_EXISTS' | 'PROVIDER_EVIDENCE_PENDING';
type CommandResult =
  | { ok: true; duplicate: boolean; propertyId: string;
      queueVersion: number; stage: QueueStage | null; archived: boolean;
      attemptId?: string; offerId?: string; assignmentEpisodeId?: string }
  | { ok: false; code: ErrorCode; message: string; fieldErrors?: Record<string,string> };
```

SQL errors with transaction abort semantics are translated at the server boundary. Do not catch and return success after one sub-write failed. Idempotent replay requires authenticating the same actor/org first, comparing request hash, then returning the stored result before rechecking current assignment. This allows a successful handoff retry after the actor no longer owns the property, without granting new access to its current state.

Org-level commands are explicit envelope exceptions: `set_acquisition_designation` uses org/member/expected designation, `set_acquisition_settings` uses org/expected settings revision, and `apply_acquisition_launch` uses org/cohort/fingerprint. Each includes idempotency UUID, canonical request hash and a committed result in `acquisition_commands`; replay rules are identical. P01 creates the receipt foundation before these RPCs; P03 extends it for property commands rather than recreating it. Launch replay returns its original cohort/count without applying again. Launch locking is command identity → organization settings → target membership → sorted properties → queue/episode rows; designation commands take command identity → target membership. The property assignment observer never takes settings/membership locks, preventing inversion. Verify designation/access/settings snapshots while those locks are held, not only before the transaction.

Designation UPDATE guard: unchanged values pass existing membership operations. A changed value requires a transaction-local marker set only within the narrow designation definer AND an authenticated active same-org owner checked by the trigger. Neither a marker alone nor `service_role` alone authorizes a change. Keep general SQL/marker-setting functions inaccessible to API callers. A service/Hugo write preserving the designation passes; a service write changing it is rejected. Any separately admitted rollout uses the audited owner command or a separately reviewed migration, not an undocumented bypass.

Historic user references use single-column `auth.users(id)` foreign keys with `ON DELETE RESTRICT`, plus independent property/org composite constraints. Membership removal is allowed, historic users remain. This deliberately participates in Hugo’s existing durable-activity scan/hard-delete block for users with real feature history; verify the scanner recognizes these references. Do not use CASCADE or masquerade activity as a pristine user to permit identity deletion.

Lock order for feature commands: command identity/advisory key → property → queue state → open episode → targeted offer. Assignment observers already run under a property write; they must not acquire command locks or lock org settings afterward. Existing appointment transactions remain independent; do not call booking/provider network services while holding feature SQL locks.

### RPCs and effects

| RPC | Caller / input beyond envelope | Atomic result |
|---|---|---|
| `fn_set_acquisition_designation` | Active owner, org/member, enabled | Change protected designation; audit; no permission or historical timing rewrite. |
| `fn_set_acquisition_settings` | Active owner, verified recipient; rollout enable only through admitted deployment operation | Store settings; no global Auth mutation. |
| `fn_log_acquisition_attempt` | Current assignee or same-org owner; kind/source/outcome/occurredAt/note/recording; known Sandra call reference for finalizing that attempt | One attempt; applicable Contacted milestone; actual external call may satisfy its original eligible episode. |
| `fn_ready_acquisition_offer` | Motivation kind/text, optional existing temperature | Needs offer / Interested; shared Interested unless later/terminal; preserve stage-entry on retry. |
| `fn_log_acquisition_offer` | Amount/method/sentAt/followUpAt, existing or supplied motivation | One offer + Offer Sent milestone; no outbound/provider/task operation. |
| `fn_record_acquisition_contract` | SignedAt and optional existing offer ID | Under Contract and signed evidence; resolve matching pending offer accepted when present. No fake offer created if none exists. |
| `fn_decline_acquisition_offer` | Current pending offer ID and occurrence time | Declined offer + shared Offer Declined + Needs sequence + Jarrad reassignment + queue exit. |
| `fn_handoff_acquisition_lead` | Reason/not-interested/nurture | Needs sequence + configured Jarrad reassignment + queue exit; no Dead status or enrollment. |
| `fn_archive_acquisition_contract` | Explicit archive intent | Archive queue only, preserve Under Contract/shared history. |
| `fn_record_acquisition_call_start` | SERVICE ONLY authenticated provider adapter, §5 evidence | One actual started attempt and episode clock stop; applicable milestones only if original episode is still current. |
| `fn_finalize_acquisition_attempt` | SERVICE or original-call-authorized existing wrap-up adapter | Resolve/link same original attempt; no current-assignee lookup for attribution and no new owner’s stage change. |

Generic reassignment continues through existing actions plus an assignment observer; do not refactor every assignment action into a new monolithic command. Existing note/appointment actions remain canonical; My Leads adapters authorize selected property and reuse them.

## 4. Assignment, launch and archive lifecycle

Observe `properties` inserts/actual `assigned_user_id` changes for organizations configured for this feature. Close previous episode and open new episode; do nothing for an unchanged assignee. Preserve existing assignee/DNC/tenant guards. Generic reassignment preserves queue stage and property history. Derive an advanced initial queue stage from shared status only when initializing/first enrolling, never from arbitrary later board-status edits.

Once an organization has feature settings, the observer records assignment periods even while the UI gate is disabled; eligibility is false until rollout is enabled. This prevents silently missing assignments during staged launch. No shared status is changed merely by recording an episode. The organization feature toggle false hides feature operations without destroying history. A member designation toggle is different: it affects new episodes only. Existing eligible episodes retain timing, queue access and warnings until closed; self and owner retain access to that member’s active queue/history. The owner selector includes currently designated members plus former designated members with feature history, labels the latter “Acquisitions disabled,” and preserves historical KPI inspection. New assignments after designation disable have ineligible clocks. Re-enabling does not retroactively start clocks on those assignments.

Needs-sequence handoff deliberately archives the queue before reassignment in the same transaction; pass a transaction-local handoff marker containing the property ID to the assignment observer, validated against the just-written archive reason and same transaction command. The observer closes the old episode but suppresses reopening for this marked handoff, and the command clears the marker before returning; the observer must not reopen it for Jarrad, even if Jarrad is Acquisitions. A later deliberate reassignment of that handed-off lead into an Acquisitions queue can clear only the handoff archive and reopen at Contacted, preserving prior episode/offer history; an ordinary read never reopens anything. Under Contract archival is preserved and is not implicitly cleared by assignment.

Launch preview is read-only and computes an exact eligible Maria cohort and fingerprint, including each property’s current open episode ID/assignment revision and the target member’s designation, active-access and settings revision snapshots. Assignment away-and-back or designation/access changes invalidate the preview even when current assignee/status matches. Add any settings-to-cohort composite FK in P02 after the cohort table exists, never forward-reference it in P01. A separate admitted apply creates the cohort record, initializes/reconciles only that exact set, retains before-values, closes any prelaunch ineligible observer episode if necessary and creates the launch-initialized excluded episode. Lock the declared properties in sorted order, verify expected assignees/statuses/queue versions and recheck set membership; fail the whole operation on changed cohort. Assignments captured outside the reviewed set remain traceable as ineligible prelaunch or eligible post-cutover episodes, never fabricated into the preview.

Earlier statuses become Contacted; Interested/Offer Sent/Under Contract keep later queue milestones. Closed/Dead/DNC and already-archived rows are excluded. Offer Declined shared state is preserved and does not automatically create another decline event or enroll anything; include its count in launch preview for review. No first-call time/attempt, generated offer, task or sequence is created. Metadata capture is not credited rep activity.

## 5. Actual-call evidence — mandatory integration contract

**Research result:** Sandra `openLead()` and `startTarget()` stamp provisional UI time too early. Jitter `start-call` creates a run; `connect('registered')` concerns the operator leg. Neither is proof the seller was dialed. Jitter source at `2c00aafa46e4e29e4c20a496c3561fac0e9143eb` shows seller placement downstream at `product.create_call` and Telnyx TeXML Calls creation. See the call research for exact paths. Deployed parity remains unverified.

Preferred producer event: confirmed seller-call creation with a provider call ID, using the time of the successful seller placement request/event. Telnyx documents [outbound call creation](https://developers.telnyx.com/api-reference/texml-rest-commands/initiate-an-outbound-call) and a signed [initiated callback with CallInitiatedAt and CallSid](https://developers.telnyx.com/api-reference/callbacks/texml-call-initiated); bind either accepted evidence to the seller leg and stable Sandra context. Seller answer is not required. The provider adapter must distinguish operator and seller legs and cannot infer this from an RTC client status alone.

```ts
type ActualSellerCallStarted = {
  eventId: string; eventVersion: 1;
  orgId: string; propertyId: string; actorUserId: string;
  assignmentEpisodeId: string | null;
  sandraCallToken: string; jitterCallId: string; sellerProviderCallId: string;
  occurredAt: string; evidence: 'seller_call_create_succeeded';
};
```

At rest, represent the stable call token by a SHA-256 digest in command keys/bindings and dedupe aliases; never persist a signed start capability, bearer token or raw credential. Hash the same stable token on incoming verified evidence before lookup. Token digest is an identity lookup, not authentication.

Bind `sandraCallToken` to server-resolved org/property/actor/episode before the external start request using a server-only command receipt (`bind_call_context`). That receipt is not an attempt and never stops a timer. The evidence receiver verifies existing internal authentication, stable binding and provider identifiers. Never accept this DTO from an ordinary browser as authoritative provider evidence. Use the repository’s internal signing/idempotency conventions; no new leaked service credentials.

Canonical logical dedupe identity is `(org_id,'sandra',SHA256(sandraCallToken))`, with immutable Jitter call ID and seller provider call ID aliases recorded/validated. If existing writeback lacks callToken, resolve it through the verified binding; do not create an unrelated second attempt. Reject contradictory alias/property/org/actor mappings.

The producer durably records/publishes the event after seller placement success and retries delivery using existing delivery facilities. A Sandra receiver transaction records the attempt and first-call evidence idempotently. Provider success and Sandra SQL cannot be one distributed transaction: when delivery fails, retain provider evidence for retry/reconciliation and keep the UI pending until durable evidence arrives. Do not redial as a remedy for failed analytics persistence. Do not use Next `after()` or a best-effort coach index as the sole durable record.

If current deployed Jitter has no suitable initiation event, add a bounded producer/receiver contract extension without changing dial/bridge behavior. That is an explicit cross-repository subpacket requiring its own owner/baseline/deployment dependency, not an invitation for the UI packet to modify Jitter. Until that extension is verified, call-clock end-to-end acceptance remains pending; all other packets can proceed with an authenticated contract fixture.

Late wrap-up updates the original attempt and retains original actor/episode. It cannot reopen or advance a new assignee’s queue. Provider result mapping: definitive connected-human → Reached; definitive no-answer/busy/voicemail → No answer; explicit wrong-number disposition → Wrong number. Ambiguous/cancelled/failed transport results must not be converted into a fabricated seller outcome; retain pending/unknown detail until authoritative outcome or user log. Existing call artifact values are not overwritten to match queue vocabulary.

## 6. Reads, paging and time

Create server wrappers in `src/lib/my-leads/queries.ts` over:

- `fn_get_acquisition_queue_page`: org, selected member, bounded search, stage/cursor map, clamped limit ≤20 per stage by default (hard max50). Initial snapshot returns five stage pages, each with its own cursor/hasMore. Follow-up requests can fetch one stage. Counts describe full current queue; search may filter row counts but does not redefine rep-wide KPI values. Label filtered counts explicitly.
- `fn_get_acquisition_kpis`: org/member, server-normalized half-open period. Compute all six tiles from durable source facts; return sample denominators and unavailable/pending counts.
- `fn_get_acquisition_detail`: org/member/property, bounded cursors for attempts/notes/offers/history; no full transcript/message bodies in initial list.
- `fn_get_acquisition_badge`: org and authenticated caller only; never accepts another member as badge subject.
- `fn_get_acquisition_roster`: authorized same-org rows; owner gets available designation controls/selected Acquisitions list, member gets self as needed.

Each read enforces active org membership, feature flag and selected-member authority before returning data. Ordinary callers cannot supply authoritative `asOf`; SQL uses a fixed statement timestamp for the snapshot. Return that timestamp and `nextWarningAt` for display refresh. Store all timestamps as UTC `timestamptz`; format America/Chicago in UI.

The cursor sent to a client is a random UUID referring to `acquisition_query_cursors`, not caller-authored JSON or a timestamp. SQL stores stage, warning rank, assignment sort key, property ID, org, authenticated viewer, selected member, normalized search/period filters and a five-minute expiry. Every page validates all bindings and current authorization. Issue all five initial stage cursors from one statement snapshot; subsequent pages recover that fixed warning-evaluation instant only from the stored token. Invalid/expired/mismatched tokens require a fresh first page. Restart on refresh or mutation. This freezes time-based ranking, not an MVCC snapshot across HTTP requests; concurrent assignment/stage changes require refreshing counts/pages, with client ID dedupe. Never claim immutable membership across pages or use offsets across a changing queue.

Row DTO: property identity/name/address/phone; queue stage/version; current episode/eligibility; actual/unknown assignment time; stage entry; motivation temperature plus separate response kind/text; all warning reasons and primary display reason; first-call state; next future appointment/callback; latest relevant offer. Do not collapse different motivation concepts or multiple warnings into one stored enum.

Use existing zoned helpers to build a pure `workingMinutesBetween(start,end)` and boundary fixtures, plus a SQL equivalent/helper for queue-wide warning evaluation. They must agree on one schedule/threshold definition and shared fixture vectors; SQL is authoritative for counts, ordering and warnings. Warning due can be derived via `workingDeadline(start,30)` without walking every historic minute. No persisted stale flag or `now()` index predicate.

Periods: half-open `[start,end)`, local Central boundaries, Monday-start week as the implementation default. First-call KPI uses elapsed seconds, not business minutes. Attempts/offers use original performer and occurrence/sent time even after handoff. Appointment accountability is the appointment’s `tasks.assignee_id` at booking, not `created_by` (booker), `completed_by` (recorder), or the property’s current assignee. Both denominator and numerator use that same immutable accountable rep. The denominator is property-linked, non-cancelled appointment tasks whose canonical `due_at` falls in the selected period; the numerator is that same set with canonical outcome `held`. Rescheduling follows the canonical due date; do not count mutation ledger entries as additional appointments. Capture booking-time assignee from an immutable canonical event if verified. Otherwise P09 adds `acquisition_appointment_attribution` and a narrow task INSERT trigger for property-linked appointments, including appointments booked from existing surfaces; outcome/lifecycle behavior is unchanged. A replacement appointment task gets its own snapshot. Do not rewrite attribution on property/task reassignment or owner completion. Backfill only when immutable booking evidence proves the assignee; existing ambiguous rows contribute to unavailable counts and are excluded from the calculated ratio, with the denominator labeled as known-attribution appointments. No inferred current-assignee historical credit.

Active acquisition outstanding first-call warnings are deduplicated with stage warnings. Under Contract/terminal/archived leads do not continue accumulating actionable outreach warnings. The row’s stopped or historical clock can remain visible. Feature enablement/clock eligibility applies prospectively; launch cohort is excluded.

## 7. Refresh and failure behavior

Use authenticated Server Components for initial snapshot and narrow Client Components for interaction. After a successful mutation, revalidate My Leads and only affected existing lead surfaces, then refresh the selected rep snapshot and signed-in badge. No optimistic success for multi-write commands. Clear previous selected member’s rows/details while a new selection loads; discard stale responses by request identity.

A lightweight foreground refresh at most once per minute or at the nearest warning boundary keeps time-based indicators current; pause it when hidden and refresh on focus. This is read-only refresh, not task scheduling. Avoid new mandatory Realtime subscriptions or all-row subscriptions across tenants. Supabase realtime can be a later optimization, not correctness infrastructure.

Collapsed list remains usable when detail fails. Reuse request UUID on retry; show typed validation/stale assignment errors with a refresh action. Missing historical evidence is unavailable, not a zero KPI or fabricated stage event.
