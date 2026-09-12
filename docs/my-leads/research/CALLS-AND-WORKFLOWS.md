---
type: research
status: ready-for-planning
version: "0.2"
scope: calls-and-workflows
baseline: "8c7053e7024433f46791eac1b186c1b7a7cf10ec"
updated: 2026-09-11
---

# Calls and workflows research

This memo is implementation research for revised PRD v0.2. It does not authorize schema application, provider calls, cohort initialization, or deployment. Findings below are from the immutable main snapshot at `8c7053e7024433f46791eac1b186c1b7a7cf10ec` in this worktree. The revised PRD is authoritative over the older build prompt, mockup, SOPs, and the previous feasibility assessment.

## Scope decisions that control this plan

PRD v0.2 keeps My Leads as an additional workspace over existing lead records. It preserves shared properties, assignment, notes, calls, appointments, and activity history; it separates queue stage from shared sales status; and it forbids a global `attempted` status. The relevant behavior is in [PRD §1](../PRD.md#L12), [§3](../PRD.md#L42), and [§4](../PRD.md#L74).

The call workflow has four constraints that should shape the adapter rather than the UI:

- Use the existing Sandra call flow and Live Coach, with a preselected lead.
- A dialog open, cancel, failed preparation, or failed pre-dial attempt does not stop the first-call clock.
- Actual initiation stops that clock, including an unanswered placed call; seller answer and call completion are too late.
- DialPad v1 is manual external-call logging. Recording links are optional. There is no new DialPad voice API, automatic recording import, automatic appointment, automatic task, automatic sequence enrollment, or contract send.

These are [PRD §5](../PRD.md#L117) and [§12](../PRD.md#L204).

## Actual Sandra/Jitter call path

The repository calls the provider “Jitter,” but the provider-facing browser leg is Telnyx. There is no public Jitter SDK or public Jitter API documentation in the repository or in the official provider documentation search; Jitter appears to be an internal service contract. The adapter boundary is therefore defined by Sandra source, not invented Jitter docs.

1. **Lead eligibility is server-authoritative.** `prepareLeadCall(propertyId)` loads the lead/contact, checks DNC and quiet hours, pauses sequence enrollments, and returns a prepared target in [`src/lib/dialer/actions.ts:77`](../../../src/lib/dialer/actions.ts#L77). The browser target is not trusted at the provider boundary.

2. **A start intent is minted before dialing.** `mintStartIntent()` authenticates the member, creates a UUID `callToken`, and signs an HMAC start-intent capability in [`src/lib/dialer/jitter-server.ts:368`](../../../src/lib/dialer/jitter-server.ts#L368). The same stable token is used for Jitter start retries and Sandra wrap-up.

3. **The successful Jitter start response is only a provider-session boundary until the downstream dial contract is verified.** `startAuthenticatedJitterCall()` re-authenticates, validates the capability/token and target, re-runs `prepareLeadCall`, checks the verified timezone, then calls `requestJitterStartCall(..., intent.idempotencyKey)` in [`src/lib/dialer/jitter-server.ts:181`](../../../src/lib/dialer/jitter-server.ts#L181). The internal contract sends a signed HTTPS request to `/api/internal/sandra/softphone/start-call`, with `Idempotency-Key`, and expects `call_id`, `session_id`, `batch_id`, and `run_id` in [`src/lib/dialer/jitter-contract.ts:6`](../../../src/lib/dialer/jitter-contract.ts#L6), [`jitter-contract.ts:173`](../../../src/lib/dialer/jitter-contract.ts#L173), and [`jitter-contract.ts:250`](../../../src/lib/dialer/jitter-contract.ts#L250). The adjacent Jitter service at `Jitter@2c00aafa46e4e29e4c20a496c3561fac0e9143eb` confirms that its Sandra `start-call` service provisions/binds a live-list run and returns `call_id`/`run_id` (`src/softphone/sandra-softphone-service.ts:107`); its route does not itself return a seller provider-leg identity. Therefore this response cannot yet be used as the PRD's actual placed-call evidence.

4. **Browser RTC setup follows provider provisioning, but `connect("registered")` is still not the seller-leg proof.** `JitterCallTransport.startInternal()` requests microphone permission, starts Jitter, stores the returned call ID, obtains the short-lived RTC token, creates a Telnyx RTC client, registers it, and calls Jitter `connect(..., "registered")` in [`src/lib/dialer/jitter-transport.ts:632`](../../../src/lib/dialer/jitter-transport.ts#L632). The adjacent Jitter connect route delegates `registered` to `operator-call` and returns only `{ dialing: true }` plus an operator/browser identity (`Jitter@2c00aafa46e4e29e4c20a496c3561fac0e9143eb:src/app/api/internal/sandra/softphone/connect/route.ts:21`; `src/app/api/product/telephony/operator-call/route.ts:289`). Its `accepted` path explicitly says browser acceptance is normal before any called-party attempt exists and defers exact attempt binding to callbacks/audio health (`src/app/api/internal/sandra/softphone/connect/route.ts:158`). Its later browser-audio confirmation opens the product execution gate, while the seller leg is created by a separate `product.create_call` effect. Sandra's current source therefore does not establish whether the PRD clock should stop at Jitter provisioning, operator-leg request, or seller-leg placement.

5. **The UI currently sets a provisional timestamp too early.** `openLead()` creates a target with `startedAt: new Date().toISOString()` before `startTarget()` runs in [`src/components/softphone/softphone-provider.tsx:786`](../../../src/components/softphone/softphone-provider.tsx#L786). `startTarget()` transitions the UI to `call_started` before microphone permission, eligibility, Jitter provisioning, or RTC setup in [`softphone-provider.tsx:470`](../../../src/components/softphone/softphone-provider.tsx#L470). That value is suitable for the existing call duration display but must not be used for the revised first-call clock.

6. **A second hook exists at transport success, but it is not durable seller placement.** After `transport.start()` resolves, the provider retains the active handle and publishes the coach call ID in [`softphone-provider.tsx:743`](../../../src/components/softphone/softphone-provider.tsx#L743). Because `transport.start()` resolves only after RTC registration and the Jitter connect request, this is later than Jitter provisioning. It is useful for “the rep can now speak,” but it can still precede the separate seller `product.create_call` egress and it has no server-side first-call write. Do not treat it as authoritative until the Jitter service contract proves that `connect` completion means seller-leg placement.

7. **Live Coach is downstream of initiation.** The server schedules a best-effort `coach_call_index` upsert with `after()` before the Jitter start request; it deliberately never blocks dialing in [`src/lib/dialer/jitter-server.ts:129`](../../../src/lib/dialer/jitter-server.ts#L129), [`jitter-server.ts:290`](../../../src/lib/dialer/jitter-server.ts#L290). The browser subscribes to `coach:{callId}` only after transport success, with retry/backoff and a reconnect-gap indicator in [`src/lib/coach/use-coach-channel.ts:21`](../../../src/lib/coach/use-coach-channel.ts#L21), [`use-coach-channel.ts:117`](../../../src/lib/coach/use-coach-channel.ts#L117). Live Coach should remain a consequence of a call, not the clock source.

8. **Provider truth controls termination.** Telnyx call updates map `requesting|trying|answering|early` to `connecting`, `active|held` to `live`, and terminal states to `ended|failed` in [`src/lib/dialer/jitter-transport.ts:165`](../../../src/lib/dialer/jitter-transport.ts#L165). For local terminal signals, the transport polls Jitter status and only treats a signed provider-terminal response as authoritative in [`jitter-transport.ts:1164`](../../../src/lib/dialer/jitter-transport.ts#L1164). A retained call similarly keeps polling in [`jitter-transport.ts:1227`](../../../src/lib/dialer/jitter-transport.ts#L1227). PRD attempt occurrence should use the actual call-start evidence; outcome can use wrap-up/provider result.

9. **Wrap-up is not the call-start event.** `completeSoftphoneCall()` requires notes, validates the sealed call capability and wrap token, claims or updates the activity, and writes `started_at`, `ended_at`, `duration_seconds`, outcome, disposition, and notes in [`src/lib/dialer/actions.ts:338`](../../../src/lib/dialer/actions.ts#L338). It is a durable result/writeback path, not a valid first-call-clock trigger.

### Integration prerequisite: settle the actual placed-call event

The adjacent Jitter source resolves the ambiguity enough to rule out one unsafe shortcut: Sandra's `start-call` response creates/binds the Jitter run, `connect("registered")` requests the operator/browser leg, and browser-audio acceptance gates the product executor. The seller call is subsequently represented by a `product.create_call` effect and Telnyx `POST /texml/.../Calls`; Jitter's provider executor records the returned provider call ID in its call registry before reporting success (`Jitter@2c00aafa46e4e29e4c20a496c3561fac0e9143eb:src/mvp/product-execution.ts:1314, src/reducer/index.ts:1271, src/telephony/telnyx-provider.ts:391, src/telephony/telnyx-provider.ts:708`). This is adjacent-repository evidence, not a public Jitter contract, and the verified remote-main commit is dated 2026-09-09; production deployment parity remains unverified.

Telnyx's official TeXML documentation makes the provider boundary concrete: an outbound REST initiation immediately creates a call resource, and the initiate endpoint returns a provider status alongside the call resource ([Calls](https://developers.telnyx.com/docs/voice/texml/rest-api/calls/index), [Initiate an outbound call](https://developers.telnyx.com/api-reference/texml-rest-commands/initiate-an-outbound-call)). The signed [TeXML call-initiated callback](https://developers.telnyx.com/api-reference/callbacks/texml-call-initiated) is a second provider-side occurrence source. This supports treating Jitter's `product.create_call` POST/returned CallSid or its verified `initiated` callback as the seller-placement candidate, while still requiring Jitter to bind that identity to Sandra's stable `callToken`, assignment episode, and original actor before the My Leads clock can stop.

Before Packet A/B chooses the first-call clock, verify the deployed Jitter implementation and contract for the exact seller-placement boundary:

- **Preferred:** a durable Jitter/provider event or transaction that records the outbound seller provider call ID plus `initiated`/`ringing` occurrence time. Use that event once, keyed by the stable Sandra `callToken` and provider attempt ID. An unanswered placed call counts; answer is not required.
- **Acceptable only with contract evidence:** `product.create_call` success/returned provider identity, if Jitter explicitly defines that response as accepted seller-leg placement and the timestamp is the provider-request event time rather than a later UI event. Preserve a nullable pending/ambiguous outcome until that identity is known.
- **Not sufficient by itself:** Sandra `start-call` response, `connect("registered")` response, RTC registration, coach indexing, UI `startedAt`, or wrap-up. These prove session/operator preparation or later observation, not necessarily seller egress.

If the deployed Jitter service cannot expose one of the first two boundaries, the PRD's first-call clock cannot be implemented authoritatively from Sandra main alone. The smallest compatible change is an additive Jitter response/writeback field or signed event carrying `providerAttemptId`, `occurredAt`, and stable `callToken`; do not infer it from browser state.

## Durable activity, writeback, and dedupe

The existing `call_activities` table is the durable call-artifact parent. It stores `jitter_attempt_id`, provider/session identifiers, operator, lead/contact links, `started_at`, `ended_at`, outcome, disposition, recording path, and raw-event count; its uniqueness and indexes are defined in [`supabase/migrations/058_dialer_and_call_activity.sql:76`](../../../supabase/migrations/058_dialer_and_call_activity.sql#L76). RLS is organization-scoped in [`058_dialer_and_call_activity.sql:158`](../../../supabase/migrations/058_dialer_and_call_activity.sql#L158), so My Leads must add assigned-member predicates server-side.

There are two durable ordering cases:

- **Wrap-up first:** Sandra writes `call_activities.provider = "sandra_softphone"` with `jitter_attempt_id = "sandra-" + rawCallId` or the wrap token fallback, then a later Jitter artifact/writeback enriches the row.
- **Writeback first:** Jitter can create or update the activity before wrap-up. The softphone writeback RPC preserves operator-entered wrap fields and only merges Jitter-owned metadata in [`supabase/migrations/20260825010000_jitter_softphone_artifact_writeback_match.sql:117`](../../../supabase/migrations/20260825010000_jitter_softphone_artifact_writeback_match.sql#L117).

The durable identity fences are already strong enough to reuse:

- A partial unique index arbitrates `(org_id, provider, jitter_attempt_id)` for Sandra softphone rows ([migration lines 33-35](../../../supabase/migrations/20260825010000_jitter_softphone_artifact_writeback_match.sql#L33)).
- The writeback route requires an idempotency key, authenticates the Jitter consumer, validates timestamps/UUIDs/outcomes, and reserves the request before calling the RPC ([route lines 397-508](../../../src/app/api/internal/jitter/call-activities/by-jitter-attempt/[attemptId]/route.ts#L397)).
- Artifact routes derive an effective key from session scope plus request key and reject cached conflicts ([recordings route lines 47-110](../../../src/app/api/internal/jitter/call-activities/by-jitter-attempt/[attemptId]/recordings/route.ts#L47)).
- `completeSoftphoneCall()` uses the wrap token and an operator/attempt fence, then retries safely against an existing row ([actions lines 371-565](../../../src/lib/dialer/actions.ts#L371)).
- Callback booking passes the same wrap token as `idempotencyKey`, so a lost response does not create a second task ([actions lines 571-613](../../../src/lib/dialer/actions.ts#L571)).

### Proposed My Leads attempt adapter

The PRD needs a deduplicated attempt fact with source, outcome, occurrence time, actor, optional recording link, and optional call reference. The least disruptive contract is:

```text
recordAttempt({
  propertyId,
  contactId?,
  actorUserId,
  source: "sandra" | "dialpad",
  outcome: "no_answer" | "reached" | "wrong_number",
  occurredAt,
  note?,
  recordingUrl?,
  callActivityId?,
  providerAttemptId?,
  clientRequestId
}) -> { attemptId, duplicate, callActivityId? }
```

The server action/RPC should:

1. Authorize the actor and verify the lead belongs to the actor’s selected queue/org.
2. Require `occurredAt` from the rep for manual DialPad logging; do not substitute save time.
3. If `source="sandra"`, accept a known `callActivityId`/provider attempt and resolve the existing `call_activities` row before creating a My Leads attempt.
4. Use a unique idempotency key for the user submission and a separate nullable provider identity for dedupe. A retry of the same form submission returns the original attempt; a later manual disposition for the same call updates/links rather than inserts.
5. Store `callActivityId` and provider attempt identity as references, but do not overload `call_activities.outcome`: the existing outcome vocabulary is transport/result-oriented (`connected_human`, `voicemail`, `no_answer`, `busy`, `failed`, `canceled`, `unknown`) in [`src/app/api/internal/jitter/call-activities/by-jitter-attempt/[attemptId]/route.ts:57`](../../../src/app/api/internal/jitter/call-activities/by-jitter-attempt/[attemptId]/route.ts#L57).
6. Apply the queue milestone in the same transaction or an equivalently recoverable post-commit action. An outreach attempt may advance queue stage to Contacted without regressing a later stage or shared terminal status.
7. Treat failed preparation, invalid target, microphone denial, Jitter configuration failure, and canceled pre-dial attempts as no attempt and no first-call clock stop.

For Sandra/Jitter, the first-call evidence row is unresolved until the deployed Jitter contract identifies seller-leg placement. Prefer the Jitter/provider event that records a seller provider call ID and `initiated`/`ringing` occurrence; if the service contract explicitly defines `product.create_call` success as placed-call acceptance, use that provider identity and request timestamp. Record it in the same server-side mutation that marks the eligible assignment period as stopped. Keep a nullable pending/ambiguous state while a provider identity or callback is unresolved. Do not use the Sandra `start-call` response, `connect("registered")`, RTC registration, `openLead()`’s provisional `startedAt`, the coach index `after()` write, a seller answer, or wrap-up as a substitute.

### Timestamp contract

Use separate timestamps because they answer different questions:

- `assignment_period.started_at`: when this Acquisitions assignment period began.
- `first_call_evidence.occurred_at`: when the verified Jitter/provider seller-leg event records placement (`initiated`/`ringing`), or the explicitly documented `product.create_call` acceptance fallback.
- `lead_attempt.occurred_at`: actual attempt occurrence, supplied by provider or rep; for Sandra it should point to the authoritative call-start evidence.
- `lead_attempt.recorded_at`: when Sandra accepted the form/writeback.
- `call_activities.started_at`: existing transport/activity timestamp; preserve its current meaning.
- `call_activities.ended_at`: existing terminal/wrap-up timestamp.

Never overwrite a prior stopped first-call evidence row on retries. A lost response must be reconciled by `callToken`/provider call identity, not by creating a new timestamp.

## Call retries and failure matrix

| Boundary | Retry behavior | Durable result |
|---|---|---|
| Mint start intent | Safe to mint a new intent only before provider start; retain the current token for one attempt. | No call or timestamp. |
| Jitter start request | Internal adapter retries at most twice for retryable/ambiguous failures, carrying the same `Idempotency-Key` ([jitter-contract.ts:250](../../../src/lib/dialer/jitter-contract.ts#L250)). | Success returns a provider-session identity; network/5xx may be ambiguous. Do not count it as seller placement without the verified downstream contract. |
| Ambiguous start | Transport attempts cancel-by-start-intent or call-ID cleanup; do not let UI retry create a second call with a new logical attempt until cleanup/reconciliation resolves. | Mark pending/ambiguous internally; no first-call fact until seller-placement evidence and provider identity are known. |
| RTC token/registration | Retry/recover with the same call ID; token is short-lived and validated before use. | The session may exist if start succeeded, but no first-call evidence is written unless the seller-placement event has already been observed. |
| Coach index | Best-effort `after()` upsert, conflict on `client_call_id`; subscription retries independently. | Coach degradation must not block the call or first-call timestamp. |
| Hangup/cancel | Three cancel attempts with backoff; pagehide sends a beacon plus authenticated cancel action; lack of confirmation leaves teardown unconfirmed ([jitter-transport.ts:1640](../../../src/lib/dialer/jitter-transport.ts#L1640)). | Keep the call/attempt identity for recovery; do not create a second attempt. |
| Wrap-up | Re-submit same wrap token; claim/update existing activity. | One activity and one linked My Leads attempt. |
| Manual attempt form | Client request ID is reused for UI retry. Provider reference, when present, is a second dedupe key. | One attempt row; duplicate response returns original. |
| Callback booking | Existing `fn_book_appointment` supports caller idempotency and returns `duplicate`; use a fresh callback request key for deliberate booking and the existing wrap token for call-wrap callback ([book-appointment-action.ts:33](../../../src/components/appointments/book-appointment-action.ts#L33)). | One task/calendar chain; no retry-created duplicate. |

A failed server response after a provider may have committed is not equivalent to a normal validation error. The adapter should surface “start may have succeeded; reconciling” and keep the stable logical attempt identity. This follows the existing `ambiguous` contract in [`jitter-contract.ts:99`](../../../src/lib/dialer/jitter-contract.ts#L99).

## Call source and manual DialPad logging

The codebase’s Dialpad adapter is SMS-only: [`src/lib/messaging/providers/dialpad.ts:12`](../../../src/lib/messaging/providers/dialpad.ts#L12) documents Dialpad API v2 SMS endpoints and webhook credentials. No voice-call API, recording import, or Dialpad call ID path exists in Sandra main. PRD v0.2 deliberately makes DialPad v1 manual, so the plan should not introduce one.

For manual DialPad attempts:

- Source label is `DialPad` in UI but stored as a stable lowercase enum.
- Recording URL is optional; preserve it if supplied and validate URL length/scheme according to the app’s normal input policy.
- `occurredAt` is required and editable; `recordedAt` is server time.
- A manual external call may stop the first-call clock only if it is explicitly marked as the first qualifying call attempt and has a real occurrence time. Non-call outreach can advance Contacted but cannot produce first-call evidence.
- Manual logging must run the same assignment, DNC, org, and later-stage non-regression guards as Sandra attempts.
- Do not call the Dialpad messaging provider from this workflow and do not infer voice behavior from its SMS credentials.

## Callbacks and appointments

The existing callback path is deliberately compatible with v0.2:

- `completeSoftphoneCall()` accepts an optional callback and calls `bookAppointment()` with the wrap token as idempotency key ([actions lines 571-590](../../../src/lib/dialer/actions.ts#L571)).
- `bookAppointment()` resolves org membership from the linked property/contact, validates DNC, converts the submitted wall time using the authoritative time zone, and invokes `fn_book_appointment` ([book-appointment-action.ts:265](../../../src/components/appointments/book-appointment-action.ts#L265)).
- The existing appointment lifecycle supports complete/cancel/reschedule/reassign through typed RPC wrappers; completion vocabulary is `held | no_show` in [`src/lib/appointments/lifecycle.ts:21`](../../../src/lib/appointments/lifecycle.ts#L21). v0.2 explicitly says to reuse it and not create a new qualification vocabulary.

Recommended My Leads hooks:

1. **Set callback/appointment:** call existing booking action with an explicit client idempotency key. Do not create a new task in a page-specific table.
2. **Reschedule/cancel/complete:** call existing lifecycle server actions. Do not synthesize a new appointment outcome or automatically create a follow-up task.
3. **Contacted indicator:** query existing open future appointment/callback tasks linked to the property; an elapsed, canceled, or completed task does not satisfy the future-next-step indicator.
4. **Appointments kept KPI:** count existing due appointments with canonical `held` outcome, preserving the event actor/assignee used at booking/completion. Do not attribute historical appointments to the current queue owner merely because the lead was reassigned.
5. **No automation:** do not invoke reminder sweeps, sequence enrollment, or task creation as a side effect of queue stage changes or offer logging. Existing calendar sync remains the appointment subsystem’s responsibility.

The current RPC’s side effects and calendar mutation ledger should remain authoritative. Relevant schema/locking behavior is in [`supabase/migrations/20260814150000_appointments_schema.sql:500`](../../../supabase/migrations/20260814150000_appointments_schema.sql#L500) and completion locking is in [`20260814210000_appointment_lifecycle_rpcs.sql:175`](../../../supabase/migrations/20260814210000_appointment_lifecycle_rpcs.sql#L175).

## Notes and offer logging

### Notes

The existing note action is the correct write path. `createLeadNote()` authenticates the user, checks the lead/DNC boundary, resolves org membership, and inserts `lead_notes` with author and body in [`src/app/(dashboard)/leads/actions.ts:2482`](../../../src/app/(dashboard)/leads/actions.ts#L2482). The existing feed subscribes to inserts and renders newest activity in [`src/app/(dashboard)/leads/[id]/notes-feed.tsx:89`](../../../src/app/(dashboard)/leads/[id]/notes-feed.tsx#L89).

The My Leads note template should be a client-side prefill only. It must call `createLeadNote(propertyId, body)` once on submit and never change queue stage/status. Keep qualification fields such as reason, deadline, condition, mortgage, net needed, and next step in the template text, not as a second note store. Tests can reuse the existing note-feed and `va-polish.integration.test.ts` action coverage.

### Offers

Offer logging is deliberately manual in v0.2. The code has existing Dropbox Sign sending and contract lifecycle actions, but they must not be called from My Leads:

- `sendContractAction()` invokes the existing eSign core and revalidates the lead in [`src/app/(dashboard)/leads/[id]/lead-esign-actions.ts:22`](../../../src/app/(dashboard)/leads/[id]/lead-esign-actions.ts#L22).
- `SendForSignature` validates templates, merge fields, signers, confirmation, and a send intent before sending in [`src/app/(dashboard)/leads/[id]/send-for-signature.tsx:239`](../../../src/app/(dashboard)/leads/[id]/send-for-signature.tsx#L239).

The My Leads `logOffer` adapter should record amount, method, sent time, required follow-up time, actor, and outcome in a new offer ledger or equivalent additive record. Selecting `dropbox_sign` is a method label only; it must not call `sendContractAction`, mint an eSign send intent, or create a task/calendar appointment. Contract-signed and offer-declined actions are separate explicit mutations. “Signed” should be manually recorded in this workflow, not inferred from an eSign provider callback.

The offer mutation should:

- require a motivation response if the lead has no recorded response, including the explicit `no_motivation_provided` value;
- reject missing follow-up date/time;
- use an idempotency key for form retries;
- preserve original actor and sent time after reassignment;
- advance queue stage and shared status only through the specified milestone transaction;
- update no task, calendar, sequence, message, or eSign record.

## Recommended durable hooks and dependencies

A safe implementation can be divided into small Luna-sized packets. Each packet is independently reviewable and should avoid changing shared calling components until the contract packet is accepted.

### Packet A — call evidence contract

**Owns:** migration/types for Acquisitions designation, assignment-period history, first-call evidence, and deduplicated attempts; server-side scope and idempotency helpers.

**Depends on:** no feature packet; must first revalidate current main and open call PRs.

**Key decisions to lock:** which deployed Jitter/provider event proves seller-leg placement; whether manual external attempts may stop the clock; unique keys for provider attempts and user submissions.

**Tests:** SQL/RPC integration for same-key replay, provider/manual link, two concurrent wrap-ups, assignment-period reassignment, later-stage non-regression, unknown/pending first call, and cross-org/unauthorized actor rejection.

### Packet B — Jitter initiation hook

**Owns:** narrow hook from the existing successful Sandra/Jitter start action into Packet A’s first-call evidence write.

**Depends on:** Packet A. Review open PR #522's exact recovery-retention diff if this hook touches the same provider identity path; do not assume it is merged or make it a blanket prerequisite.

**Hook:** do not implement this packet against the Sandra `start-call` response alone. First settle the deployed Jitter seller-leg contract. The preferred hook is a signed/durable Jitter/provider event carrying the stable Sandra `callToken`, seller provider attempt ID, and `initiated`/`ringing` occurrence time; the acceptable fallback is a `product.create_call` success whose contract explicitly means seller-leg placement. That hook still runs in the authenticated server context that owns the operator, property, assignment-period, token, and prepared target. Do not use `after()`; once the seller-placement event is authoritative, the evidence mutation is part of the call result and must not be best-effort telemetry. If evidence persistence fails after seller egress, return a recoverable “call started but timing evidence is pending” state and reconcile by stable token/provider ID rather than retrying as a new attempt. Until this contract is verified, Packet B is blocked at the integration boundary, not at the UI.

**Tests:** `src/lib/dialer/jitter-contract.test.ts`, `jitter-server.test.ts`, `jitter-transport.test.ts`, and a focused server/RPC integration test for seller-placement success, 4xx refusal, ambiguous 5xx/network, duplicate token, late provider callback, and evidence-mutation failure after provider acceptance. **Proposed new test:** prove `start-call`/`connect("registered")` do not write first-call evidence before the seller event.

### Packet C — manual attempt and wrap-up linker

**Owns:** My Leads `recordAttempt` action and Sandra wrap-up/provider linking.

**Depends on:** Packet A; Packet B’s identity fields.

**Rules:** manual DialPad uses occurrence time and optional recording URL; Sandra attempts prefer existing `call_activities`; same logical call cannot create a second My Leads attempt; DNC and identity checks run before milestone side effects.

**Tests:** no-answer/reached/wrong-number, manual save retry, same provider attempt plus manual outcome, call activity writeback first, wrap-up first, DNC race, and later-stage non-regression.

### Packet D — appointment and callback adapter

**Owns:** My Leads call/appointment controls and selector queries only.

**Depends on:** Packet A if callback linkage is stored on attempts; otherwise independent.

**Reuse:** `bookAppointment`, lifecycle actions, existing task/calendar rows. No new appointments table or outcomes.

**Tests:** existing booking/lifecycle tests plus My Leads query fixtures for future/open versus completed/canceled/overdue appointments, duplicate booking retry, time-zone/DST validation, and no automatic task creation.

### Packet E — notes and manual offer workflow

**Owns:** template prefill, `logOffer`, manual Contract signed, Offer declined, Needs sequence/reassignment coordination.

**Depends on:** Packet A queue/milestone mutation contract; existing DNC and assignment guards.

**Rules:** notes call `createLeadNote`; offers never invoke eSign; outcomes retain original actor; decline uses existing `needs_sequence` disposition and verified Jarrad member identity.

**Tests:** note template does not mutate stage, required motivation/follow-up validation, offer retry idempotency, signed/declined transitions, reassignment attribution, DNC lock, and no task/eSign/sequence side effects.

### Packet F — KPI/timer read model

**Owns:** bounded server queries for five queue sections, warnings, and six KPI tiles.

**Depends on:** durable event fields from Packets A–E.

**Rules:** event-time actor attribution; stale count independent of selected period; assignment clock only for new Acquisitions assignment periods; working minutes only for first-call warning; elapsed duration for assign-to-first-call KPI; pending/unknown is unavailable, never zero.

**Tests:** fixture clocks for Friday-to-Monday, after-hours, DST, actual start versus dialog open, reassignment, launch cohort exclusion, duplicate attempt, zero denominator, and owner inspecting another rep.

### Packet G — UI shell and access

**Owns:** `/my-leads`, sidebar link/badge, owner member selector, five-section row UI and dialogs.

**Depends on:** read/action contracts from A–F. It should not alter the existing Leads board or global property status vocabulary.

**Tests:** server authorization for own/owner-selected queues, cross-org rejection, narrow viewport/zoom, dialog cancel/no timestamp, first-call initiation, direct offer/signed path, and manual DialPad occurrence time.

## Pending PR overlap

The three open PRs should be treated as unmerged dependencies:

- **#519** `coach/precall-setup`: adds `src/components/softphone/precall-setup-panel.tsx`, `use-precall-setup.ts`, pre-call coach context/actions, and changes the shared softphone provider/lead button. My Leads should not copy it; revalidate its eventual API before changing shared call UI.
- **#522** softphone recovery retention: changes `src/components/softphone/softphone-provider.tsx` and its tests. It directly overlaps retained call identity, wrap-up timing, and first-call evidence recovery.
- **#492** terminal poll: changes `src/lib/dialer/jitter-transport.ts`, its tests, and E2E workflow. It overlaps the definition of authoritative terminal provider proof, but not initiation.

The plan should branch or coordinate according to the repository’s PR dependency rules after these relationships are rechecked immediately before implementation.

## Official documentation and unsupported areas

- [Telnyx WebRTC JavaScript quickstart](https://developers.telnyx.com/development/webrtc/js-sdk/quickstart/index) documents the browser client, JWT login, readiness, notification events, and call states. This supports the source finding that Sandra’s browser leg is Telnyx; it does not document Sandra’s internal Jitter bridge or its start/writeback semantics.
- [Telnyx WebRTC Call class](https://developers.telnyx.com/docs/voice/webrtc/js-sdk/classes/call) documents `newCall`, call state, hangup, DTMF, hold, and mute. It supports mapping browser/provider state but is not an authority for Sandra’s durable `call_activities` timestamp.
- [Telnyx WebRTC SDK commonalities](https://developers.telnyx.com/docs/voice/webrtc/sdk-commonalities) describes client/call lifecycle states and authentication options. It supports using provider state for terminal proof and distinguishes transport state from an application’s persisted activity.
- [Telnyx TeXML Calls](https://developers.telnyx.com/docs/voice/texml/rest-api/calls/index) says an outbound REST initiation creates a call resource immediately, and [Initiate an outbound call](https://developers.telnyx.com/api-reference/texml-rest-commands/initiate-an-outbound-call) documents the exact `POST /texml/Accounts/{account_sid}/Calls` endpoint used by adjacent Jitter. These support the seller-leg placement candidate; they do not define Sandra/Jitter's assignment or My Leads writeback semantics.
- [Telnyx TeXML call-initiated callback](https://developers.telnyx.com/api-reference/callbacks/texml-call-initiated) documents a signed provider callback for the initiated lifecycle event. Prefer it for event-time evidence when Jitter forwards and binds it durably; it remains unverified in this research because no provider calls or production webhook inspection were performed.
- [Next.js `after()`](https://nextjs.org/docs/app/api-reference/functions/after) documents post-response work. It supports the existing best-effort coach-index design; it is not appropriate as the required first-call evidence write because v0.2 requires a durable authoritative initiation event.
- [Supabase JavaScript RPC reference](https://supabase.com/docs/reference/javascript/rpc) documents calling Postgres functions. Existing booking/writeback/lifecycle RPCs remain the transaction boundaries; no new page-local direct table writes should bypass them.
- No official public Jitter API/SDK documentation was located. The Jitter adapter contract is internal and is evidenced by `src/lib/dialer/jitter-contract.ts`, `jitter-server.ts`, `jitter-transport.ts`, and the internal writeback routes/migrations. Provider configuration, live Jitter behavior, recording availability, and production webhook delivery remain unverified because this research performed no provider calls.

## Recommended validation commands

Focused unit tests:

```bash
npm run test -- src/lib/dialer/jitter-contract.test.ts src/lib/dialer/jitter-server.test.ts src/lib/dialer/jitter-transport.test.ts
npm run test -- src/lib/dialer/actions.test.ts src/components/softphone/softphone-provider.test.tsx
npm run test -- src/components/appointments/book-appointment-action.test.ts src/components/appointments/lifecycle-actions.test.ts src/lib/appointments/lifecycle.test.ts
npm run test:rtl -- 'src/app/(dashboard)/leads/[id]/notes-feed.test.tsx'
npm run test:integration -- 'src/app/(dashboard)/leads/va-polish.integration.test.ts'
```

Jitter/writeback integration tests:

```bash
npm run test:integration -- 'src/app/api/internal/jitter/call-activities/by-jitter-attempt/[attemptId]/route.integration.test.ts'
npm run test:integration -- 'src/app/api/internal/jitter/call-activities/by-jitter-attempt/[attemptId]/recordings/route.integration.test.ts'
npm run test:integration -- src/lib/appointments/inline-sync-kick.integration.test.ts
```

Repository gates after implementation packets:

```bash
npm run typecheck
npm run lint
npm test
npm run test:rtl
npm run test:e2e:synthetic
```

These commands validate local contracts and test doubles. They do not prove live Jitter/Telnyx configuration, provider recording delivery, or production calendar credentials. Those require the existing authorized canary/release process and must remain outside this research task.

No tests or provider calls were run for this research-only memo. The listed paths were checked against the repository file inventory; the seller-placement contract test called out above is proposed work.
