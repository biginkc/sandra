# My Leads: one-call close workflow

Decision record and build plan. Owner: Jarrad. Drafted 2026-10-04 from an interview with Jarrad,
production data, a code map, and two independent model reviews (Opus 5.5, context-free Fable).
Intended for review by Codex Astra via PR before implementation.

---

## Part 1: Decision record

### Problem (verified in production and code)

- Jarrad, the only acquisitions rep, gets through ~5 leads/day on `/my-leads`.
- He dials sellers natively in Dialpad. Sandra never sees those calls. He hand-pastes the
  `dialpad.com/shared/call/…` link and Dialpad's AI summary into `lead_notes`, then logs an
  attempt in a separate dialog (source DialPad requires a pasted recording link, server rule
  `RECORDING_REQUIRED` in `supabase/migrations/20260917193000_recording_accountability.sql:174`),
  then changes stage in a third dialog.
- 102 of 106 queue leads sit in Contacted with no scheduled next step. 137 `acquisition_attempts`
  rows have `outcome null` since Sept 12.
- Sections already order rows (warning rank, assignment order, property id;
  `20260912110000_acquisition_read_model.sql:133`), but that ordering does not express who to call
  next, so he reads conversations to decide.
- No comps or valuation data source exists. The CLOSR calculator is manual and on a separate page.
  Send for signature has ~30 hand-typed fields including price.
- Appointments: 9 write paths and 8 read paths, all on `public.tasks`, with `type` in
  (`follow_up`, `callback`, `custom`, `appointment`). My Leads reads only appointment+callback,
  the calendar reads only appointment, the offer follow-up lives on `acquisition_offers.follow_up_at`,
  Norma and Jitter insert tasks directly and skip notifications. A follow-up set on the lead page is
  invisible in My Leads.
- Dialpad: the embedded CTI panel was tried Sept 30–Oct 1 and abandoned (`dialpad_org_connections.status='disabled'`).
  The user-scoped Dialpad call webhook subscription is still configured. Its hangup payload carries
  `public_call_review_share_link`, `admin_recording_urls`, `external_number`, `custom_data`, plus
  `voicemail_link` and `transcription_text`, which are voicemail-only fields (null on all five stored
  calls). The call transcript and AI summary are **not** on the payload; they come from
  `GET /api/v2/transcripts/{call_id}` and AI Recap after the call. Sandra quarantines events without a Sandra token
  (`20260929034021_dialpad_cti_foundation.sql` ~838–870, reason `no_custom_data`).
- Jitter AI summaries have failed since Sept 7 (`call_transcripts.summary_error_code='summary_billing'`).
- Telnyx direct-calling pilot exists (outbound only, 9 calls). Rejected for outbound: showing the
  Dialpad number from Telnyx gets STIR/SHAKEN attestation B; Dialpad on its own number gets A.
- Dialpad `POST /api/v2/users/{id}/initiate_call` makes the desktop/web app dial immediately
  (no ring-first, no prompt step), mobile app unsupported, 5 requests/min, `custom_data` flows to
  call events.

### Decisions

| # | Decision | Reasoning |
|---|---|---|
| D1 | **Vocabulary.** Two next-step kinds: **Appointment** (phone by default, 15 minutes; "in person" exposes duration + address; neither mode dials unattended) and **Task** (non-seller work). "Next step" is the umbrella word. Relabel `callback`/`follow_up` → appointment(phone), `custom` → task, **open future rows only**; history untouched. Offer follow-up becomes a phone appointment titled "Offer follow-up"; `acquisition_offers.follow_up_at` is derived from it. Storage stays `type in ('appointment','custom')`: appointments keep `end_at` (phone = due + 15 min) and a calendar chain, tasks keep `custom`; `follow_up` and `callback` are retired. The relabel runs through the appointment lifecycle (calendar chain created, lifecycle guard satisfied), never a bare `update`. `mode` defaults to `phone` for every existing row; in-person is set by hand on the few open appointments, not inferred from `end_at` (every appointment row has one). One write function, one read definition, every screen. No snooze. | Four labels for one intent was a bug. Callback vs appointment collapse because the only differences are whether the due-time alert offers one-click dial and whether a venue is needed, which the mode carries. Relabel only open rows because `acquisition_appointment_attribution` fires on insert of type appointment and converting history would change the "appointments kept" KPI. |
| D2 | **Layout.** A **Call next** strip of 10 ranked leads above the five existing sections (sections, KPI tiles and timers unchanged). Each row shows the reason it's there. Row actions: **Call today** (pin to top until called or midnight Central), **Not today** (hide from strip until midnight), **Dead / Nurture** (existing handoff with required reason). Strip is a computed view; it never moves a lead between sections. | Sections answer "where is the deal", the strip answers "what now". Both audiences (rep today, owner inspecting a hire later) served. Dead/Nurture so the strip can drain the stale pile. |
| D3 | **Ranking.** Tiers: (1) appointment due or overdue; (2) inbound text or inbound call unanswered, newest first; (3) Needs offer with no offer logged, Offer Sent past follow-up; (4) hot/warm motivation with no touch in 3 days; (5) everyone else, longest since last touch. Touch = latest of attempt, outbound text, note, call. Inbound text/call counts as a touch *by the seller* and feeds tier 2. Tie-break: assignment age then property id. "Today" and "midnight" are America/Chicago. Leads with no callable phone or all phones DNC are excluded from the strip and flagged. | Matches how Jarrad ranks on a good day: promise made, they reached out, money pending, warm going cold, then fairness. |
| D4 | **Dialing.** Dialpad for all outbound. Clicking **Call** on a strip row or call screen prepares a Sandra intent (existing `dialpad_call_intents` flow) and calls Dialpad `initiate_call` with the token; Jarrad's Dialpad desktop app dials the seller through his headset. The embedded panel and browser audio capture are **not** used. Scheduled phone appointments: at due time Sandra shows a prominent alert and pins the lead to the top of the strip as "Callback due now"; one click dials. No unattended auto-dial. Calls Jarrad dials directly in Dialpad (desktop or mobile) are matched to leads by exact 10-digit `external_number` against contact phones on properties assigned to him; one match → logged; several → "assign to lead"; none → quarantined `no_lead_match`. Dialpad connection re-enabled **after** the matcher exists. Telnyx stays a pilot. | Dialpad keeps full caller-ID trust on Jarrad's number and he is always at the laptop with a headset. Whether either endpoint can ring Jarrad first and then connect is unverified pending Phase 0 (`initiate_call` dials immediately per docs; `POST /api/v2/call` is undocumented on ordering), so scheduled callbacks are alert-plus-click regardless; the endpoint choice is provisional until the spike. Number matching covers the mobile app and habit calls; mobile's only limitation is the post-call prompt waits until Sandra is next opened. |
| D5 | **Recording.** The attempt row is created by the projection on the first call event, as today; dispatch records only the intent, and an intent with no event after 2 min is marked failed and counts as no touch. On the hangup webhook, Sandra writes `public_call_review_share_link` to `acquisition_attempts.recording_url` and stores `admin_recording_urls[0]` on the call activity; `voicemail_link`/`transcription_text` are stored only when present (voicemail). Three later artifacts are fetched separately, each with its own scope and latency: the call transcript (`GET /api/v2/transcripts/{call_id}`), the AI summary (AI Recap, scope `ai_recap`), and the recording file (download auth proven in Phase 0). The fetch is a hangup-triggered job with bounded retries (1, 5, 15, 60 min) that records readiness per artifact; the webhook subscription keeps its current six states (`src/lib/dialpad-cti/provisioning.ts:30`, validator `:425`), and adding `call_transcription`/`recording` states is a Phase 0 question, not an assumption. `RECORDING_REQUIRED` stays as is: it lives in the manual log wrapper `fn_log_acquisition_attempt` (`20260917193000_recording_accountability.sql:174`), and the projection path never calls it, so Sandra-placed and matched calls need no exemption. A sweep flags attempts still missing a link after 10 min. Deepgram/Claude transcription is deferred until Dialpad's output proves insufficient. | The link Jarrad pastes by hand is already in the payload. Dialpad already transcribes and summarizes; a third summarizer while Jitter's is broken repeats a pattern. |
| D6 | **Comps.** ATTOM API: as-is AVM with confidence range, sold comps, owner of record, legal description; CLOSR anchors computed. ARV is not an ATTOM product: Phase 0 decides whether Sandra computes it from renovated sold comps or leaves it to Jarrad, and `arv_estimate` is nullable, so Phase 3 ships without it if the method fails validation. The trial has written acceptance thresholds (coverage, AVM vs Jarrad's number, legal-description completeness) and a spend ceiling, both set by Jarrad before Phase 0. Pulled automatically when a lead enters the top ten and on a one-click **Comp this lead** anywhere. Never blocks lead visibility; shows "comps pending". Confidence shown; "verify first" flag when low. Validate ATTOM against Assigns.com on 20 leads during the 30-day trial before paying. RentCast is the fallback. | Best data wins (Jarrad). Lazy pull keeps a paid vendor off the assignment path. Confidence rule: give a range when tight, verify when not. |
| D7 | **Call screen.** One screen in Sandra: Closer Lab script (already synced by `coach-scripts-sync`, token slots) filled from lead data, static scroll; numbers with confidence and CLOSR anchors; recent notes and texts; the send-contract card; the post-call prompt. | Scripts, numbers, history and the close in one place with no tab switch. |
| D8 | **Send-contract card.** Editable: price, closing date. Pickers with defaults: title company (default per market), buyer entity. Default: earnest money $500. Read-only review line before Send: seller name(s), legal description, price, closing date. Everything else prefilled from lead, public record, or org defaults. One **Send** → Dropbox Sign through the existing durable eSign lifecycle (`lead-esign-action-core.ts`: `sending` → `sent` / `send_unknown` / `failed`). The offer is logged and the stage moves to Offer Sent **only after the request reaches `sent`**, by an idempotent projection keyed on the eSign request id; `send_unknown` shows "send unconfirmed" and is reconciled by the existing path, never re-sent; definitive failure logs nothing. `fn_log_acquisition_offer` can still reject (`STALE_STATE`, `STALE_ASSIGNMENT`, `PENDING_OFFER_EXISTS`; it also requires `auth.uid()`, `20260912120000_acquisition_workflow_commands.sql:24`), so the card pre-checks those before Send. If the contract reached `sent` and the RPC then rejects permanently, the request is kept as a durable pending offer projection row (status `conflict`, visible on the lead and in the strip as "contract sent, offer needs reconciling"); an authorized member resolves it from the lead page by one of three actions: void the stale pending offer and log the new one, reassign and log, or cancel the signature request. Policy: the signed-for contract wins over the stale offer record, and nothing is ever re-sent. Legal description and vesting are never prefilled from a low-confidence source. | One-call close. The review line is the eyes-on step for the fields that become title problems. Logging after confirmation prevents ghost offers. Overrides PRD §"Log offer records an offer already made". |
| D9 | **Post-call prompt.** Auto-opens on hangup (desktop) or on next open (mobile). Outcome pre-guessed from the call (reached / no answer / voicemail / wrong number). One note field. Quick date picks (Tomorrow, 3 days, Next week, Pick) create a phone appointment. Ready to make an offer and Send contract reachable from the same prompt. Nothing blocks save; skipping leaves "outcome not set" and the touch still counts. Seller gets a morning-of reminder text from a **new** seller-reminder job: recipient is the appointment's contact phone, scheduled morning-of in America/Chicago, consent and STOP re-checked at dispatch (`src/lib/messaging/consent.ts`), quiet hours via `src/lib/messaging/quiet-hours.ts`, one send per appointment, cancelled on reschedule or cancel. The existing `appointment-reminder-sweep` (texts the rep's reminder phone within 30 min of due) is unchanged. Jarrad gets the in-app alert at time. | One place decides section and next appearance. Voicemail becomes a real outcome (needs check-constraint widening) so it stops forcing the no-answer SMS flow. |
| D10 | **Scope.** Acquisitions group only (currently Jarrad). Maria's 2 and Mel's 13 queue leads **and their open tasks** move to Jarrad before anything schedules (attribution captures the task assignee, `20260912111000_acquisition_kpis.sql:18`, so moving leads alone is not enough). KPIs/timers unchanged. 137 stale pending attempts closed out. Jitter summary billing fixed separately by Jarrad. | Attribution is fixed at insert time, so reassignment comes first. |

### Review findings and resolution

| Finding | Source | Resolution |
|---|---|---|
| Press-1 at callback time not supported by Dialpad | Opus, Fable; `initiate_call` confirmed, `POST /call` unverified | Alert + one-click dial (D4) regardless; Phase 0 tests `POST /call` |
| Log offer before Dropbox Sign confirms → ghost offers | Opus | Log after confirmation (D8) |
| Relabel history breaks "appointments kept" attribution | Opus | Open future rows only (D1) |
| Post-call save races webhook link; RECORDING_REQUIRED rejects | Opus, Fable | Attempt created by the projection on the first call event; the manual rule is untouched because the projection never calls it; link backfilled on hangup + 10-min sweep (D5) |
| `contacts.phone_digits` is three numbers concatenated with fuzzy index | Opus | Exact 10-digit `contact_phone_numbers` table (Phase 2) |
| Contact-level DNC only a display flag; auto-dial risk | Opus | Server-side DNC check in dial RPC; excluded from strip (D3, D4) |
| Dialpad unknowns: custom_data on API calls, webhook while connection disabled, MP3 auth, 5/min | Opus | Phase 0 spike |
| ATTOM coverage/cost/legal-description quality unknown | Opus, Fable | Phase 0 trial; lazy pull (D6) |
| Strip degenerates to "ten oldest leads" | Fable | Dead/Nurture on strip rows + one-time triage of the 102 (D2, Phase 1) |
| One-click Send on unvalidated data | Fable | Read-only review line; no low-confidence legal/vesting (D8) |
| Pre-comp on assignment puts vendor on critical path | Fable | Lazy pull + one-click (D6) |
| Relabel has cron side effects (reminder sweep, calendar chains) | Fable | Computed `next_step_kind` view first; writers migrated one at a time; rep reminder sweep unchanged, seller reminders in a separate job (D9, Phase 1) |
| Third summarizer duplicates Dialpad's | Fable, Jarrad agreed | Dialpad transcript/summary only (D5) |
| Mobile-originated calls | Fable, Jarrad asked | Covered by matching; prompt waits for next open (D4) |
| Enable connection before matcher floods quarantine | Fable | Connection enabled last in Phase 2 |
| "Discipline not tooling" | Fable | Disagreed on cause (logging cost two minutes per call); agreed on order: pipeline first, telephony second |
| Snoozed status exists in schema | Opus | Relabel treats `snoozed` as open; UI never writes it |
| TCPA for reminder texts | Opus | Consent on record (Jarrad); STOP/consent from `src/lib/messaging/consent.ts`, quiet hours from `src/lib/messaging/quiet-hours.ts` (new seller-reminder job, D9) |
| Legal review of template defaults | Opus | Dropped by Jarrad |
| PRD conflicts (§3 no automatic appointments/dialer; §5 DialPad link optional + manual v1; offer logging records an offer already made; §13 Maria) | Opus | Consciously overridden; PRD v0.3 written in Phase 1 |

### Codex Astra review (2026-10-04, head 83cfcafe): findings and resolution

Verdict at 83cfcafe: `APPROVE_PLAN: NO`, `BLOCKING: 4`. Every repo-backed claim was re-verified
against the code before resolution. All sixteen are folded into the decisions and plan above.

| # | Finding | Resolution |
|---|---|---|
| B1 | Relabel not executable: appointments need `end_at` + calendar chain + lifecycle guard; no `task` storage type; contradicts "computed view first" | D1 + Phase 1a: storage stays `appointment`/`custom`; relabel through the lifecycle (15-min `end_at`, chain); additive view and shared SQL `fn_create_next_step` first; reject trigger last |
| B2 | D4/D5 contradict the pre-reads (`POST /call`; `transcription_text` is voicemail only) | D4 keeps alert-plus-click, endpoint provisional; D5 separates recording link, voicemail transcript, call transcript, AI Recap; Phase 0 proves each |
| B3 | "Failure → nothing logged" loses contracts that were sent; existing lifecycle has `sending`/`send_unknown`; offer RPC can reject | D8 + Phase 3: existing eSign lifecycle kept, idempotent offer projection on `sent`, `send_unknown` reconciled never re-sent, RPC rejections pre-checked; tests listed |
| B4 | ARV is not validated by the spike; no thresholds or spend ceiling | D6: ARV conditional and nullable; thresholds, ceiling and ARV method moved to "What needs Jarrad"; Phase 0 item 2 measures them |
| N1 | `end_at` does not identify in-person (every appointment has one) | Phase 1a: all existing rows `phone`; Jarrad flags in-person by hand |
| N2 | Attribution captures the task assignee; 1e ran after 1a | 1e runs first and moves tasks too (D10) |
| N3 | `fn_norma_mark_needs_review` (and `fn_reschedule_appointment`) missing from writer inventory; "schedule action"/"offer dialog" are new writers | Phase 1a inventory corrected |
| N4 | Existing reminder sweep texts the rep within 30 min; quiet hours are in `quiet-hours.ts`, not `consent.ts` | D9: new seller-reminder job with its own contract; existing sweep untouched; file refs fixed |
| N5 | Wrong constraint cites; `unknown` invalid on attempts; `RECORDING_REQUIRED` is in the manual wrapper only | Cites fixed (`…offer_facts.sql:14`, `…non_retryable.sql:416/:1142`); stale close-out is Jarrad's choice; no `RECORDING_REQUIRED` exemption needed (D5) |
| N6 | `listRecentDialpadCalls` is 5 intents / 1 h | Phase 2: durable unacknowledged-call query with persisted acknowledgement |
| N7 | 14 `dialpad-cti:` predicates, not two | Phase 2: one shared predicate; frozen match per (org, call id); duplicate/out-of-order/reassignment cases |
| N8 | Dispatch-time attempt changes first-event semantics | D5/Phase 2: attempt stays on first event; intent timeout; tests |
| N9 | Offer follow-up ownership circular; N undefined; must be after send | Phase 1a/3: created in the offer transaction, propagation defined, N and fallback to Jarrad |
| N10 | Template audit helpers write; use `getTemplate` | Phase 0 item 3 rewritten |
| N11 | `is_training` leads produce no attempt | Verification uses an isolated synthetic lead; training isolation asserted separately |
| N12 | "No ordering" was wrong | Problem statement corrected |

Re-review at e9858a10: `APPROVE_PLAN: NO`, `BLOCKING: 2` (B3 partial, NB1), resolved as follows.

| # | Finding | Resolution |
|---|---|---|
| B2 (partial) | "cannot ring-then-confirm" still asserted | D4 and the review row now say unverified pending Phase 0 |
| B3 (partial) | No recovery when a sent contract meets a permanent offer conflict | D8: durable `conflict` projection row, three authorized recovery actions, contract wins, never re-sent |
| N9 (partial) | Propagation values undefined; `follow_up_at` non-null | Phase 1a: reschedule/complete/cancel/outcome rules defined; tier 3 reads the task |
| N11 (partial) | Verification step 2 used a training number | Same synthetic lead from mobile; training isolation asserted separately |
| NB1 | `call_transcription` is not a subscribed state (`provisioning.ts:30`, `:425`) | D5/Phase 3: hangup-triggered fetch job with bounded retries; subscription unchanged; extra states a Phase 0 question |
| NN1 | Old resolution rows contradicted revised D5/D9 | Rows rewritten |
| NN2 | `calculateClosr` zero-fills missing ARV (`closr-v1.ts:49`) | Phase 3: ARV-dependent anchors suppressed, "unavailable" never zero |
| NN3 | D1 wording kept "suppresses auto-dial" and duration rationale | D1 reworded |

### What needs Jarrad

- Say which of the two stored Dialpad keys is live, and confirm it can initiate calls, export recordings
  (`recordings_export`) and read AI Recap (`ai_recap`); each is a separate permission.
- ATTOM 30-day trial account, a spend ceiling for the trial, the acceptance thresholds (coverage %,
  AVM-vs-your-number tolerance, legal-description completeness), and the ARV method (Sandra computes
  from renovated comps, or you set it); the subscription decision comes after validation.
- Offer follow-up cadence: N days before closing (must be after the send time); fallback when closing is
  within N days.
- How the 137 stale pending attempts close: a new outcome value (e.g. `not_logged`) or deletion of those
  with no call activity (destructive; separate approval).
- Flag which of the open appointments are in person (the rest default to phone).
- Title company list with per-market default; buyer entity list with default.
- Fix Jitter summary billing (separate).
- Reassign Maria's and Mel's queue leads to himself (or approve the migration doing it).

---

## Part 2: Build plan

All code in a worktree. One PR per phase, stacked, `Depends on:` declared. Codex Astra reviews the
decision record PR (this document under `docs/my-leads/DECISIONS-2026-10.md`) first.

### Phase 0: Spike (1–2 days, no product code)

Goal: retire the external unknowns before building on them.

1. **Dialpad test call.** Script under `scripts/` using the stored API key. First
   `GET /api/v2/subscriptions/call` to confirm the user-scoped subscription survived the 401 period.
   Then both `initiate_call` and `POST /api/v2/call` to a training lead with `custom_data` (ring order,
   `call_id`, mobile); capture the full webhook payloads for calling/connected/hangup; confirm
   `custom_data` round-trips; confirm events arrive for a call dialed natively on desktop and on mobile;
   attempt `GET admin_recording_urls[0]` with the API key and record status/expiry; fetch
   `GET /api/v2/transcripts/{call_id}` and AI Recap and record when each became available and which
   permission it needed; measure webhook-to-hangup latency. Requires temporarily setting the connection
   `active` (revert after). Events quarantined during the spike are the only replay candidates.
2. **ATTOM trial.** Script pulls property detail, AVM, sales comps, owner, legal description for 20 of
   Jarrad's real leads; CSV for side-by-side of ATTOM AVM vs Zestimate vs Jarrad's number; record
   per-call cost, latency, KC-metro and Kansas-side coverage, legal-description completeness, and
   whether an ARV can be derived from renovated sold comps. Judged against Jarrad's thresholds and
   within his spend ceiling.
3. **Dropbox Sign template audit.** Read-only: call `createDropboxSignProvider(...).getTemplate`
   (`src/lib/esign/dropbox-sign.ts:191`) with the test-mode key (the exported helpers in
   `website-template-registration.ts` write template state); inspect the template document itself for
   an assignment clause; list every field and its prefill source for D8; record which inputs (signer
   emails, vesting, legal description) have no source and define the editable fallback.

Exit: a short findings note appended to the decision doc. Go/no-go on D4 details and D6 provider.

### Phase 1: Next-step vocabulary, ranked strip, post-call prompt, link capture

**1a. Appointment/Task consolidation (SQL + lib).**
- Order: 1e housekeeping (lead **and task** reassignment) lands first, so attribution of relabeled rows
  goes to Jarrad.
- Migration, additive first: add `tasks.next_step_kind` generated as `case type when 'appointment' then
  'appointment' when 'callback' then 'appointment' when 'follow_up' then 'appointment' else 'task'
  end`, plus `tasks.mode text check in ('phone','in_person') default 'phone'`. Every existing row is
  `phone` (every appointment row has `end_at`, `tasks_end_at_check`, so it is no evidence of in-person);
  Jarrad flags in-person rows by hand. Then convert **open, future** `callback`/`follow_up` rows to
  `type='appointment', mode='phone'` through the appointment lifecycle: `end_at = due_at + 15 min`,
  calendar chain created, lifecycle guard (`appointment identity ... immutable outside the lifecycle`,
  `20260814170000_appointment_booking_rpcs.sql`) satisfied via the migration-only setting; backfill
  `acquisition_appointment_attribution` with `source='relabel_2026_10'` (widen its check, currently
  `source='booking_insert'` only). Leave completed/cancelled rows untouched. Tasks keep `type='custom'`.
- Add `'voicemail'` to the `acquisition_attempts.outcome` column check (currently
  `no_answer|reached|wrong_number`, `20260912090200_acquisition_attempt_offer_facts.sql:14`) and to the
  log/finalize RPC lists (`20261003130000_my_leads_conflicts_non_retryable.sql:416` and `:1142`);
  Contact rate treats it as not-reached. `'unknown'` exists only on `call_activities`, not attempts.
- One write path: `src/lib/next-steps/index.ts` → `createNextStep({ propertyId, kind:'appointment'|'task',
  mode, dueAt, endAt?, title, assigneeId })` wrapping `fn_book_appointment` for appointments and
  `createTask` for tasks, always dispatching notifications/lead events/calendar. SQL producers call a shared
  database function (`fn_create_next_step`), not the TypeScript wrapper. Migrate every writer, one at a
  time: lead task widget (`leads/actions.ts` createLeadTaskAction), board `set_lead_next_action`
  (`20260815233000_leads_urgency_paging.sql:449`), dialer wrap-up (`src/lib/dialer/actions.ts:602`),
  `fn_reschedule_appointment`, Jitter writeback SQL (`jitter_writeback_call_activity` and
  `_softphone`), Norma `fn_norma_complete_call` **and** `fn_norma_mark_needs_review`
  (`20261002120500_norma_lock_order.sql:587`, inserts `custom`). New writers: My Leads schedule action
  and the offer dialog ("Offer follow-up" appointment created in the same transaction as
  `fn_log_acquisition_offer`, which sets `follow_up_at` from it (`follow_up_at` stays non-null,
  `20260912090200_acquisition_attempt_offer_facts.sql:81`, and must be after `sent_at`,
  `20261003130000_my_leads_conflicts_non_retryable.sql:682`). Propagation: reschedule → `follow_up_at =
  new due_at`; completing the task leaves `follow_up_at` as history; the task cannot be cancelled while
  the offer is pending (reschedule or record the offer outcome instead); recording the offer outcome
  auto-completes the task. Ranking tier 3 "Offer Sent past follow-up" reads the task, not the column.
  Only after every writer is migrated does a DB trigger reject inserts of `follow_up`/`callback`.
- One read definition: `my_leads_queue_rows`/`fn_get_acquisition_queue_page`
  (`20261003120000_my_leads_queue_row_lookup.sql:44-59`), detail read model
  (`20260917110000_rep_sms_obligation_read_models.sql:130`), `fn_calendar_month_appointments`,
  lead page, dashboard, board: all read `next_step_kind='appointment'` for next step, any assignee
  on My Leads/lead page, viewer on dashboard (unchanged). Calendar shows phone and in-person,
  phone as 15-min blocks. Google Calendar sync only for `in_person`.
- New seller-reminder job per D9 (recipient, schedule, consent/STOP recheck, quiet hours, dedupe,
  cancellation), tested for both recipients and retry; `appointment-reminder-sweep` untouched.
- Snooze UI removed; `snoozed_until` ignored by new reads.

**1b. Ranking + Call next strip (SQL + UI).**
- Migration: `fn_my_leads_call_next(org, member, now)` returns top 10 with `tier`, `reason`,
  `reason_at`; inputs: tasks (next_step_kind appointment, due ≤ now+15min or overdue), inbound
  (`properties.has_unread_inbound`, last inbound message at; inbound `call_activities`),
  `acquisition_queue_states.stage` + `acquisition_offers`, motivation + last touch
  (max of attempts.occurred_at, outbound messages, lead_notes, call_activities), exclusions
  (DNC-locked, contact DNC on all phones, no phone, `my_leads_strip_overrides.hidden_until > now`),
  pins (`my_leads_strip_overrides.pinned_until`). New table `my_leads_strip_overrides(property_id,
  member_id, pinned_until, hidden_until)` with RLS by org + member.
- UI: `src/app/(dashboard)/my-leads/_components/call-next-strip.tsx` above `MyLeadsQueue` in
  `client.tsx`; row = name, address, reason, Call, Call today / Not today / Dead-Nurture menu
  (Dead/Nurture opens existing handoff dialog). Owner member selector applies. Refresh on every
  mutation and on a 30s poll.
- One-time triage helper: a filter chip "no next step, untouched > 14 days" so Jarrad can work the
  102 with Dead/Nurture or a date.

**1c. Post-call prompt v1 (manual open, same dialog as the auto-open in Phase 2).**
- Rewrite `attempt-dialog.tsx` as `post-call-prompt.tsx`: outcome (4 options, pre-filled when a call
  is known), one note (written to `lead_notes`, not the hidden attempt note), quick date picks →
  `createNextStep(appointment, phone)`, buttons Ready to make an offer / Send contract (Phase 3) /
  Dead-Nurture. No "when did it occur" for linked calls. Recording link field shown only for manual
  DialPad source (until Phase 2 removes the need). Acquisitions manager prefilled from viewer and
  remembered. Drip picker stays after save.
- Detail panel shows attempt notes and the new strip reason.

**1d. Hangup link capture (SQL, small).**
- In the existing projection (`20260929120000_dialpad_cti_call_projection.sql` hangup branch): set
  `acquisition_attempts.recording_url = coalesce(recording_url, payload->>'public_call_review_share_link')`,
  store `admin_recording_urls[0]` on new nullable `call_activities.provider_recording_url`, and
  `voicemail_link`/`transcription_text` (voicemail only) on `provider_voicemail_url`,
  `provider_voicemail_transcript`. The call transcript and AI Recap land later via a fetch job into
  `provider_transcript`/`provider_summary` (Phase 3). No change to `RECORDING_REQUIRED` (D5). Backfill
  5 existing rows.
  (Delivers value only once Phase 2 re-enables the connection; shipped here so Phase 2 is config.)

**1e. Housekeeping (runs before 1a).** Reassign Maria's/Mel's queue leads **and their open tasks** to
Jarrad (migration, idempotent, preview first). Close 137 pending `sandra` attempts older than 7 days
the way Jarrad chooses (`'unknown'` is not a valid attempt outcome today; deletion is a separately
approved destructive step). PRD v0.3 with the overrides table.

Tests: migration integration tests beside each migration (pattern `*.integration.test.ts`); vitest
for strip, prompt, ranking reasons; existing My Leads suites green; snapshot of KPIs before/after
relabel compared in the test.

### Phase 2: Dialing and matching (Depends on: Phase 1)

- **Click-to-dial via API.** `src/lib/dialpad-cti/api-dial.ts`: `initiate_call` with the intent's
  `custom_data`, caller ID from grants, server-side DNC check per number, rate-limit guard
  (queue + 5/min). Reuse `startDialpadCall` intent lifecycle; replace the iframe dispatch; delete the
  panel's capture path. Attempt row stays created by the projection on the first event (D5); dispatch
  writes the intent only, and a 2-min no-event timeout marks the intent failed with no touch. Tests:
  webhook-before-response, provider rejection, timeout, exactly-once stage/first-call-clock effects.
- **Native-call matching.** Migration: `contact_phone_numbers(contact_id, e164, digits10, slot)`
  maintained by trigger from `contacts.phone_1..3`. New matcher branch for `no_custom_data` events
  whose `target.id` equals a verified binding: exact `digits10` match → properties assigned to the
  binding's user, active queue row; one → synthesize intent, project (`provider_attempt_key =
  'dialpad-native:<call_id>'`); several → disposition `received`/`ambiguous_lead` → "Assign to lead"
  strip in My Leads with an RPC that pins and projects; none → `quarantined`/`no_lead_match`.
  Inbound direction creates a call activity and tier-2 signal, not an attempt. Replace every
  `'dialpad-cti:'` predicate (14 sites across 7 migrations: indexes, the check constraint, `on conflict`
  targets, finalize, references, dispatch, recording and training playback) with one shared predicate
  that also accepts `'dialpad-native:'`. One frozen match per (org, provider call id); duplicate and
  out-of-order events, concurrent assignment, and reassignment during a call are specified and tested.
  Replay only events quarantined during the Phase 0 spike (nothing was stored while disabled).
- **Auto-open prompt.** `client.tsx` polls (visible tab, 10s) a new query for durable unacknowledged
  ended calls (attempt with provider key, `prompt_acknowledged_at is null`, paginated), not
  `listRecentDialpadCalls` (5 intents within 1 h, `src/lib/dialpad-cti/dispatch.ts:28,548`), so a prompt
  survives next-day reopening and more than five calls. Acknowledgement is persisted separately from
  outcome (skipping leaves outcome null). Opens the post-call prompt prefilled (outcome from
  `call_activities.outcome`, voicemail from `voicemail_link`). Never over an open dialog.
- **Callback alert.** Appointments (phone) due within 2 min: banner + pinned strip row "Callback
  due now", one-click Call. Browser notification if permitted.
- **Enable the connection last** via `scripts/provision-dialpad-cti.ts`; confirm the user-scoped
  subscription is enabled.

Tests: api-dial unit tests; matcher integration tests (one/several/none/inbound/DNC); prompt
auto-open; replay idempotency; a training-lead end-to-end in preview.

### Phase 3: Comps, call screen, send-contract card (Depends on: Phase 2; ATTOM trial outcome)

- **ATTOM provider.** `src/lib/comps/providers/attom.ts` behind `src/lib/comps/index.ts`
  (`compLead(propertyId)`), server-only key, raw responses stored in `lead_comps(property_id,
  provider, fetched_at, as_is_value, as_is_low, as_is_high, confidence, arv_estimate, comps jsonb,
  owner_of_record, legal_description, raw)` with RLS by org. Triggered when a lead enters the top
  ten (from the strip RPC result, server job) and by **Comp this lead**. Monthly cap in config.
  CLOSR anchors computed via `src/lib/calculators/closr-v1.ts`, but only when ARV and the rehab inputs are present and validated: `calculateClosr` turns missing inputs into zero (`closr-v1.ts:49`), so ARV-dependent anchors are suppressed and shown as "unavailable", never computed from zero.
- **Call screen.** `src/app/(dashboard)/my-leads/call/[propertyId]` (or a full-height drawer):
  left Closer Lab script from `src/lib/coach/script-cache.ts` with tokens resolved from lead/contact/
  comps; right numbers card (as-is, ARV or "unavailable", confidence, anchors only when ARV-dependent inputs exist, "verify first"), notes/texts, send
  card, post-call prompt docked. Call button → Phase 2 dial.
- **Send-contract card.** New component on the existing send orchestration in
  `lead-esign-action-core.ts` (`provider.sendWithTemplate` then `reconcileSent`; `send-contract.ts` is
  not the live path): price, closing date editable; title company and entity
  pickers from new org settings tables (`acquisition_contract_defaults`); earnest $500 default;
  read-only review line; all other template fields mapped from lead/public record/defaults per the
  Phase 0 audit. On `sent` → idempotent offer projection keyed on the request id calls
  `fn_log_acquisition_offer`, which creates the "Offer follow-up" appointment (closing date − N days,
  N from Jarrad, after `sent_at`, short-closing fallback) in the same transaction and stage →
  Offer Sent. `send_unknown` → "send unconfirmed", reconciled, never re-sent. Definitive failure →
  nothing logged, error shown. Tests: timeout, provider success then DB failure, concurrent lead
  mutation, recovery without resend.
- **AI facts from Dialpad.** The hangup-triggered fetch job (D5; bounded retries, per-artifact
  readiness, no subscription change) pulls the transcript and AI Recap into
  `provider_transcript`/`provider_summary`; when present, a server job writes a
  summary note and proposes motivation/timeline/condition/mortgage/asking/next-step into a
  `lead_call_facts` row shown on the prompt as prefill chips (accept to write to the lead).

Tests: provider mocked; comps RLS; call screen render; send card prefill mapping snapshot;
offer-logged-after-confirmation integration test.

### Verification (end to end, after Phase 3)

1. Preview deploy with Phase 0 keys. An isolated synthetic lead (not `is_training`: training leads get
   an internal-training activity and no attempt row, `20260930036000_dialpad_training_projection.sql:122`;
   training isolation is asserted separately): appears in strip with a reason; Comp this lead
   fills numbers; Call dials via Dialpad desktop; hangup → prompt opens prefilled, share link on the
   attempt, Dialpad summary note present; tap "Next week" → appointment in My Leads, lead page,
   calendar, dashboard identically; at due time the alert pins the lead; Send contract with a test
   Dropbox Sign account → offer logged after confirmation, stage Offer Sent.
2. Dial the same synthetic lead's number from the Dialpad mobile app → matched, attempt
   `dialpad-native:…`, prompt on next open. Separately, dial a training lead → internal-training
   activity, no attempt row, no prompt.
3. KPI tiles before/after Phase 1 relabel agree on historical periods.

### Out of scope / later

Telnyx as dialer (requires porting numbers), Deepgram/Claude transcription, inbound call handling on
Telnyx, Assigns.com integration (no API found), Jitter summary billing (Jarrad), portfolio of local
caller-ID numbers.

---

## Phase 0 pre-reads (2026-10-04, read-only; no code, no provider calls)

Sources: Dialpad developer docs, the 15 Dialpad events stored in production, the BMH Secrets vault
(service-account view), and Assigns.com while logged in. Nothing here changes a decision on its own;
proposed plan edits are listed at the end for review.

### Dialpad API (developers.dialpad.com)

- **`POST /api/v2/users/{id}/initiate_call`** ([ref](https://developers.dialpad.com/reference/usersinitiate_call)).
  Body: `phone_number`, `outbound_caller_id`, `group_id`, `group_type`, `custom_data` (string,
  "passed through to any subscribed call events", no documented size limit). Response is a `device`
  object, **no `call_id`**. Needs the web/desktop app or a CTI device; mobile app and deskphones
  unsupported. Rate limit 5/min **per user target** ([ref](https://developers.dialpad.com/docs/rate-limits)).
  No scope named; a user-level key may pass `me` as the id. Docs silent on ring-first vs dial-now.
- **`POST /api/v2/call`** ("initiate via ring", [ref](https://developers.dialpad.com/reference/callinitiate)).
  "Rings all devices (or a single specified device)" including **mobile and deskphones**; body adds
  `user_id` (required), `device_id`, `is_consult`; **returns `call_id`**. 5/min. Not considered in the
  decision record. Whether it rings Jarrad first and then dials the seller is undocumented; if it does,
  it is the "ring-then-connect" behaviour D4 assumed Dialpad could not do. Spike both endpoints.
- **Call events** ([subscription](https://developers.dialpad.com/reference/webhook_call_event_subscriptioncreate),
  [payload](https://developers.dialpad.com/docs/call-events)). Subscription takes `endpoint_id`,
  `call_states[]`, `target_type`/`target_id` (user scoping supported). `custom_data` is present only for
  calls started via the API or the app launch URL; for group calls only on the operator event. Signing
  is JWT HS256 with the shared secret (matches Sandra's verifier). Docs are **silent on whether natively
  dialed calls (desktop/mobile) fire events**; the spike item stands.
- **Recordings and transcripts.** The docs never list `admin_recording_urls` on any event; recordings
  are documented as a separate `recording` state with `recording_details[]`/`recording_url[]`, and
  `public_call_review_share_link` only on `call_transcription`. **Production disagrees and wins**: all
  five hangup payloads stored Sept 30–Oct 1 carry `admin_recording_urls[0]`
  (`https://dialpad.com/blob/adminrecording/<id>.mp3`), `public_call_review_share_link`
  (`dialpad.com/shared/call/…`), `company_call_review_share_link`, `recording_details`,
  `voicemail_link`, `transcription_text` and `custom_data`; `connected` events already carry
  `admin_recording_urls`, `calling` events do not. Recording URLs in events require the
  `recordings_export` scope (or a company-admin key plus Dialpad support enabling export). Download
  auth and URL expiry are undocumented (spike). Fallbacks after the fact:
  `GET /api/v2/call/{id}` (10/min; returns `admin_call_recording_share_links`, `recording_details`,
  `transcription_text`, `custom_data`), `POST /api/v2/recording_share_link` (100/min),
  `GET /api/v2/transcripts/{call_id}` (lines + moments, 1200/min, **no summary**). The summary D5 relies
  on comes from the `recap_*` event fields or `GET … ai_recap` (scope `ai_recap`, 12/min).
- **Keys and scopes.** Only company admins create API keys; company keys act across all users.
  Documented scopes: `recordings_export`, `message_content_export`, `screen_pop`, `calls:list`,
  `fax_message`, `change_log`, `offline_access`, plus endpoint-level `ai_recap` and others.

### Production state (sandra-crm, queried 2026-10-04)

- `dialpad_call_events`: **15 rows = 5 calls × calling/connected/hangup**, all `matched`, **0
  quarantined**, all outbound, all with `custom_data`. The `no_custom_data` quarantine path has never
  fired.
- `dialpad_org_connections.status = 'disabled'` since 2026-10-01. The voice webhook returns **401 and
  stores nothing** for a disabled connection (`src/lib/dialpad-cti/event-processing.ts:163`). So every
  call since Oct 1 was dropped, not quarantined: **there is nothing to replay**, and Dialpad may have
  disabled the subscription after sustained 401s. Phase 0 must read the subscription state before
  relying on it.

### 1Password (BMH Secrets vault)

- **Dialpad:** four items. `Dialpad - API` (API credential, created 2026-04-02, updated 05-18) and
  `DialPad Sandra API key` (secure note, 2026-05-17) both have **empty notes**: no owner user, company,
  or scopes recorded. `Dialpad - CTI Client ID` (09-26) and `Dialpad - CTI Webhook Secret - BMH`
  (09-29, managed by provisioning) are not API keys. Scope can only be learned from Dialpad Admin >
  API Keys or a test call.
- **ATTOM:** none. **RentCast:** none. **Assigns:** no stored login.
- **Dropbox Sign:** `Dropbox Sign - Sandra eSign Test Mode` (2026-08-30: API key, client id, callback
  secret, embedded domain `sandra.bmhgroupkc.com`) exists, so the Phase 0 template audit and the Phase 3
  send test have a test-mode key. Production login `Dropbox Sign - BMH Acquisitions Login`.

### Assigns.com (logged in, Pro plan)

- **API:** Compass → Developer exposes `https://api.assigns.com/api` with one endpoint,
  `POST /webhooks/contacts` (create a Mini CRM contact) under workspace API keys. Inbound only. No
  comps, property, or valuation endpoint; no CSV/PDF export on the Comp Map or Report tab. "No API" in
  Out of scope is confirmed.
- **Where the data comes from** (observed on the Comp Map's own backend calls
  `app.assigns.com/api/comp/search` and `/api/comp/property`): every comp record carries
  `dataSource: "attom"`; the subject property's value is `zestimate`/`rentZestimate` with
  `source: "zillow"`; the property record is `dataSource: "PUBLIC_RECORD"` with `parcelNumber`,
  `legalDescription`, `mlsId`/`mlsSource`, `parcelGeometry` and an `ownerData` block (loans, balances,
  rates). So **Assigns' sold comps are ATTOM**, its headline value is Zillow's Zestimate, and the owner
  panel is public record.
- The legal description shown for a KC lead was the subdivision name only ("VINEYARD WOODS"), not a
  full legal. D8's rule against prefilling legal/vesting from a low-confidence source stands; the ATTOM
  trial must check legal-description completeness explicitly.
- Usage is metered on the Pro plan (comp searches counted; AI searches 100/cycle; skip trace
  25,000/month).

### Proposed plan edits from the pre-reads (for Codex review and Jarrad)

1. **Phase 0 item 1:** test `POST /api/v2/call` beside `initiate_call` (ring order, `call_id`, mobile);
   `GET /api/v2/subscriptions/call` to confirm the user-scoped subscription survived the 401 period;
   `GET /api/v2/call/{id}`, `/transcripts/{id}` and `ai_recap` as the after-the-fact path for links,
   transcript and summary.
2. **Phase 2:** drop "replay quarantined events since Sept 29"; nothing was stored while disabled.
   Events quarantined during the Phase 0 spike are the only replay candidates.
3. **What needs Jarrad:** say which of the two stored Dialpad keys is live and confirm it carries
   `recordings_export` and `ai_recap` (or is a company-admin key with export enabled by support).
4. **D6 validation:** comparing ATTOM comps against Assigns compares ATTOM against itself. Reframe the
   20-lead check as ATTOM AVM vs Zestimate vs Jarrad's own number, and judge the sold-comps list on
   completeness, not agreement.
5. **D5 wording:** "Dialpad's own transcript and summary" means the transcripts endpoint plus AI Recap,
   each with its own scope and rate limit; the hangup payload carries only the voicemail
   `transcription_text`.
