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
- The page has no ordering inside sections, so he reads conversations to decide who to call.
- No comps or valuation data source exists. The CLOSR calculator is manual and on a separate page.
  Send for signature has ~30 hand-typed fields including price.
- Appointments: 9 write paths and 8 read paths, all on `public.tasks`, with `type` in
  (`follow_up`, `callback`, `custom`, `appointment`). My Leads reads only appointment+callback,
  the calendar reads only appointment, the offer follow-up lives on `acquisition_offers.follow_up_at`,
  Norma and Jitter insert tasks directly and skip notifications. A follow-up set on the lead page is
  invisible in My Leads.
- Dialpad: the embedded CTI panel was tried Sept 30–Oct 1 and abandoned (`dialpad_org_connections.status='disabled'`).
  The user-scoped Dialpad call webhook subscription is still configured. Its hangup payload carries
  `public_call_review_share_link`, `admin_recording_urls`, `external_number`, `voicemail_link`,
  `transcription_text`, `custom_data`. Sandra quarantines events without a Sandra token
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
| D1 | **Vocabulary.** Two next-step kinds: **Appointment** (phone by default; optional "in person" adds end time + address and suppresses auto-dial) and **Task** (non-seller work). "Next step" is the umbrella word. Relabel `callback`/`follow_up` → appointment(phone), `custom` → task, **open future rows only**; history untouched. Offer follow-up becomes a phone appointment titled "Offer follow-up"; `acquisition_offers.follow_up_at` is derived from it. One write function, one read definition, every screen. No snooze. | Four labels for one intent was a bug. Callback vs appointment collapse because the only behavioral difference is "does Sandra dial" and "is there a duration", which the in-person flag carries. Relabel only open rows because `acquisition_appointment_attribution` fires on insert of type appointment and converting history would change the "appointments kept" KPI. |
| D2 | **Layout.** A **Call next** strip of 10 ranked leads above the five existing sections (sections, KPI tiles and timers unchanged). Each row shows the reason it's there. Row actions: **Call today** (pin to top until called or midnight Central), **Not today** (hide from strip until midnight), **Dead / Nurture** (existing handoff with required reason). Strip is a computed view; it never moves a lead between sections. | Sections answer "where is the deal", the strip answers "what now". Both audiences (rep today, owner inspecting a hire later) served. Dead/Nurture so the strip can drain the stale pile. |
| D3 | **Ranking.** Tiers: (1) appointment due or overdue; (2) inbound text or inbound call unanswered, newest first; (3) Needs offer with no offer logged, Offer Sent past follow-up; (4) hot/warm motivation with no touch in 3 days; (5) everyone else, longest since last touch. Touch = latest of attempt, outbound text, note, call. Inbound text/call counts as a touch *by the seller* and feeds tier 2. Tie-break: assignment age then property id. "Today" and "midnight" are America/Chicago. Leads with no callable phone or all phones DNC are excluded from the strip and flagged. | Matches how Jarrad ranks on a good day: promise made, they reached out, money pending, warm going cold, then fairness. |
| D4 | **Dialing.** Dialpad for all outbound. Clicking **Call** on a strip row or call screen prepares a Sandra intent (existing `dialpad_call_intents` flow) and calls Dialpad `initiate_call` with the token; Jarrad's Dialpad desktop app dials the seller through his headset. The embedded panel and browser audio capture are **not** used. Scheduled phone appointments: at due time Sandra shows a prominent alert and pins the lead to the top of the strip as "Callback due now"; one click dials. No unattended auto-dial. Calls Jarrad dials directly in Dialpad (desktop or mobile) are matched to leads by exact 10-digit `external_number` against contact phones on properties assigned to him; one match → logged; several → "assign to lead"; none → quarantined `no_lead_match`. Dialpad connection re-enabled **after** the matcher exists. Telnyx stays a pilot. | Dialpad keeps full caller-ID trust on Jarrad's number and he is always at the laptop with a headset. Dialpad's API cannot ring-then-confirm, so scheduled callbacks are alert-plus-click. Number matching covers the mobile app and habit calls; mobile's only limitation is the post-call prompt waits until Sandra is next opened. |
| D5 | **Recording.** The attempt row is created at dial time. On the hangup webhook, Sandra writes `public_call_review_share_link` to `acquisition_attempts.recording_url` and stores `admin_recording_urls[0]`, `voicemail_link`, and `transcription_text` on the call activity. `RECORDING_REQUIRED` is relaxed for calls Sandra placed or matched (link arrives seconds later and is backfilled; a sweep flags attempts still missing a link after 10 min). Dialpad's own transcript and summary are the source of the AI summary and extracted facts. Deepgram/Claude transcription is deferred until Dialpad's output proves insufficient. | The link Jarrad pastes by hand is already in the payload. Dialpad already transcribes and summarizes; a third summarizer while Jitter's is broken repeats a pattern. |
| D6 | **Comps.** ATTOM API: as-is AVM with confidence range, ARV estimate, sold comps, owner of record, legal description; CLOSR anchors computed. Pulled automatically when a lead enters the top ten and on a one-click **Comp this lead** anywhere. Never blocks lead visibility; shows "comps pending". Confidence shown; "verify first" flag when low. Validate ATTOM against Assigns.com on 20 leads during the 30-day trial before paying. RentCast is the fallback. | Best data wins (Jarrad). Lazy pull keeps a paid vendor off the assignment path. Confidence rule: give a range when tight, verify when not. |
| D7 | **Call screen.** One screen in Sandra: Closer Lab script (already synced by `coach-scripts-sync`, token slots) filled from lead data, static scroll; numbers with confidence and CLOSR anchors; recent notes and texts; the send-contract card; the post-call prompt. | Scripts, numbers, history and the close in one place with no tab switch. |
| D8 | **Send-contract card.** Editable: price, closing date. Pickers with defaults: title company (default per market), buyer entity. Default: earnest money $500. Read-only review line before Send: seller name(s), legal description, price, closing date. Everything else prefilled from lead, public record, or org defaults. One **Send** → Dropbox Sign. The offer is logged and the stage moves to Offer Sent **only after Dropbox Sign confirms the request**. Legal description and vesting are never prefilled from a low-confidence source. | One-call close. The review line is the eyes-on step for the fields that become title problems. Logging after confirmation prevents ghost offers. Overrides PRD §"Log offer records an offer already made". |
| D9 | **Post-call prompt.** Auto-opens on hangup (desktop) or on next open (mobile). Outcome pre-guessed from the call (reached / no answer / voicemail / wrong number). One note field. Quick date picks (Tomorrow, 3 days, Next week, Pick) create a phone appointment. Ready to make an offer and Send contract reachable from the same prompt. Nothing blocks save; skipping leaves "outcome not set" and the touch still counts. Seller gets a morning-of reminder text (consent on record; quiet hours and STOP via existing messaging consent code); Jarrad gets the in-app alert at time. | One place decides section and next appearance. Voicemail becomes a real outcome (needs check-constraint widening) so it stops forcing the no-answer SMS flow. |
| D10 | **Scope.** Acquisitions group only (currently Jarrad). Maria's 2 and Mel's 13 queue leads move to Jarrad before anything schedules. KPIs/timers unchanged. 137 stale pending attempts closed out. Jitter summary billing fixed separately by Jarrad. | Attribution is fixed at insert time, so reassignment comes first. |

### Review findings and resolution

| Finding | Source | Resolution |
|---|---|---|
| Press-1 at callback time not supported by Dialpad | Opus, Fable, verified | Alert + one-click dial (D4) |
| Log offer before Dropbox Sign confirms → ghost offers | Opus | Log after confirmation (D8) |
| Relabel history breaks "appointments kept" attribution | Opus | Open future rows only (D1) |
| Post-call save races webhook link; RECORDING_REQUIRED rejects | Opus, Fable | Attempt created at dial time, rule relaxed for Sandra-placed/matched calls, backfill + sweep (D5) |
| `contacts.phone_digits` is three numbers concatenated with fuzzy index | Opus | Exact 10-digit `contact_phone_numbers` table (Phase 2) |
| Contact-level DNC only a display flag; auto-dial risk | Opus | Server-side DNC check in dial RPC; excluded from strip (D3, D4) |
| Dialpad unknowns: custom_data on API calls, webhook while connection disabled, MP3 auth, 5/min | Opus | Phase 0 spike |
| ATTOM coverage/cost/legal-description quality unknown | Opus, Fable | Phase 0 trial; lazy pull (D6) |
| Strip degenerates to "ten oldest leads" | Fable | Dead/Nurture on strip rows + one-time triage of the 102 (D2, Phase 1) |
| One-click Send on unvalidated data | Fable | Read-only review line; no low-confidence legal/vesting (D8) |
| Pre-comp on assignment puts vendor on critical path | Fable | Lazy pull + one-click (D6) |
| Relabel has cron side effects (reminder sweep, calendar chains) | Fable | Computed `next_step_kind` view first; writers migrated one at a time; reminder sweep filtered to appointments created through the new path (Phase 1) |
| Third summarizer duplicates Dialpad's | Fable, Jarrad agreed | Dialpad transcript/summary only (D5) |
| Mobile-originated calls | Fable, Jarrad asked | Covered by matching; prompt waits for next open (D4) |
| Enable connection before matcher floods quarantine | Fable | Connection enabled last in Phase 2 |
| "Discipline not tooling" | Fable | Disagreed on cause (logging cost two minutes per call); agreed on order: pipeline first, telephony second |
| Snoozed status exists in schema | Opus | Relabel treats `snoozed` as open; UI never writes it |
| TCPA for reminder texts | Opus | Consent on record (Jarrad); quiet hours + STOP from existing `src/lib/messaging/consent.ts` path |
| Legal review of template defaults | Opus | Dropped by Jarrad |
| PRD conflicts (§3 no automatic appointments/dialer; §5 DialPad link optional + manual v1; offer logging records an offer already made; §13 Maria) | Opus | Consciously overridden; PRD v0.3 written in Phase 1 |

### What needs Jarrad

- Confirm or create a Dialpad API key with scope to call `initiate_call` and download admin recordings (1Password).
- ATTOM 30-day trial account and, after validation, the subscription.
- Title company list with per-market default; buyer entity list with default.
- Fix Jitter summary billing (separate).
- Reassign Maria's and Mel's queue leads to himself (or approve the migration doing it).

---

## Part 2: Build plan

All code in a worktree. One PR per phase, stacked, `Depends on:` declared. Codex Astra reviews the
decision record PR (this document under `docs/my-leads/DECISIONS-2026-10.md`) first.

### Phase 0: Spike (1–2 days, no product code)

Goal: retire the external unknowns before building on them.

1. **Dialpad test call.** Script under `scripts/` using the stored API key: `initiate_call` to a
   training lead with `custom_data`; capture the full webhook payloads for calling/connected/hangup;
   confirm `custom_data` round-trips for API-initiated calls; confirm events arrive for a call dialed
   natively on desktop and on mobile; attempt `GET admin_recording_urls[0]` with the API key and record
   status/expiry; measure webhook-to-hangup latency. Requires temporarily setting the connection
   `active` (revert after).
2. **ATTOM trial.** Script pulls property detail, AVM, sales comps, owner, legal description for 20 of
   Jarrad's real leads; CSV for side-by-side with Assigns; record per-call cost, latency, KC-metro and
   Kansas-side coverage, legal-description completeness.
3. **Dropbox Sign template audit.** Dump the template's custom fields via existing
   `src/lib/esign/website-template-registration.ts` helpers; confirm whether an assignment clause
   exists; list every field and its prefill source for D8.

Exit: a short findings note appended to the decision doc. Go/no-go on D4 details and D6 provider.

### Phase 1: Next-step vocabulary, ranked strip, post-call prompt, link capture

**1a. Appointment/Task consolidation (SQL + lib).**
- Migration: add `tasks.next_step_kind` generated/computed as `case type when 'appointment' then
  'appointment' when 'callback' then 'appointment' when 'follow_up' then 'appointment' else 'task'
  end`, plus `tasks.mode text check in ('phone','in_person') default 'phone'`; `in_person` set for
  existing appointment rows with `end_at`. Update **open, future** `callback`/`follow_up` rows to
  `type='appointment', mode='phone'` and backfill `acquisition_appointment_attribution` with a new
  `source='relabel_2026_10'` (widen its check). Leave completed/cancelled rows untouched.
- Add `'voicemail'` to `acquisition_attempts` outcome checks and the finalize/log RPC `in (...)`
  lists (`20260929120000_dialpad_cti_call_projection.sql:464,91`); Contact rate treats it as not-reached.
- One write path: `src/lib/next-steps/index.ts` → `createNextStep({ propertyId, kind:'appointment'|'task',
  mode, dueAt, endAt?, title, assigneeId })` wrapping `fn_book_appointment` for appointments and
  `createTask` for tasks, always dispatching notifications/lead events/calendar. Migrate writers:
  lead task widget (`leads/actions.ts` createLeadTaskAction), board `set_lead_next_action`, dialer
  wrap-up (`src/lib/dialer/actions.ts:602`), Jitter writeback SQL, Norma `fn_norma_complete_call`,
  My Leads schedule action, offer dialog (creates "Offer follow-up" appointment; `follow_up_at` kept
  in sync by trigger). Then a DB trigger rejects inserts of `follow_up`/`custom`.
- One read definition: `my_leads_queue_rows`/`fn_get_acquisition_queue_page`
  (`20261003120000_my_leads_queue_row_lookup.sql:44-59`), detail read model
  (`20260917110000_rep_sms_obligation_read_models.sql:130`), `fn_calendar_month_appointments`,
  lead page, dashboard, board: all read `next_step_kind='appointment'` for next step, any assignee
  on My Leads/lead page, viewer on dashboard (unchanged). Calendar shows phone and in-person,
  phone as 15-min blocks. Google Calendar sync only for `in_person`.
- `appointment-reminder-sweep` sends seller morning-of texts only for appointments created through
  the new path with a contact that has SMS consent, using `src/lib/messaging/consent.ts`.
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
  store `admin_recording_urls[0]`, `voicemail_link`, `transcription_text` on new nullable
  `call_activities.provider_recording_url`, `provider_voicemail_url`, `provider_transcript`.
  `RECORDING_REQUIRED` skipped when `provider_attempt_key is not null`. Backfill 5 existing rows.
  (Delivers value only once Phase 2 re-enables the connection; shipped here so Phase 2 is config.)

**1e. Housekeeping.** Reassign Maria's/Mel's queue leads to Jarrad (migration, idempotent,
preview first). Close 137 pending `sandra` attempts older than 7 days with `outcome='unknown'` or
delete if no call activity (decide in review). PRD v0.3 with the overrides table.

Tests: migration integration tests beside each migration (pattern `*.integration.test.ts`); vitest
for strip, prompt, ranking reasons; existing My Leads suites green; snapshot of KPIs before/after
relabel compared in the test.

### Phase 2: Dialing and matching (Depends on: Phase 1)

- **Click-to-dial via API.** `src/lib/dialpad-cti/api-dial.ts`: `initiate_call` with the intent's
  `custom_data`, caller ID from grants, server-side DNC check per number, rate-limit guard
  (queue + 5/min). Reuse `startDialpadCall` intent lifecycle; replace the iframe dispatch; delete the
  panel's capture path. Attempt row created at dispatch (already done by projection on first event;
  make it at dispatch instead).
- **Native-call matching.** Migration: `contact_phone_numbers(contact_id, e164, digits10, slot)`
  maintained by trigger from `contacts.phone_1..3`. New matcher branch for `no_custom_data` events
  whose `target.id` equals a verified binding: exact `digits10` match → properties assigned to the
  binding's user, active queue row; one → synthesize intent, project (`provider_attempt_key =
  'dialpad-native:<call_id>'`); several → disposition `received`/`ambiguous_lead` → "Assign to lead"
  strip in My Leads with an RPC that pins and projects; none → `quarantined`/`no_lead_match`.
  Inbound direction creates a call activity and tier-2 signal, not an attempt. Widen the two
  `'dialpad-cti:%'` predicates to include `'dialpad-native:%'`. Replay quarantined events since
  Sept 29 once.
- **Auto-open prompt.** `client.tsx` polls `listRecentDialpadCalls` (visible tab, 10s); on a new
  ended call with a pending attempt, opens the post-call prompt prefilled (outcome from
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
  CLOSR anchors computed via `src/lib/calculators/closr-v1.ts`.
- **Call screen.** `src/app/(dashboard)/my-leads/call/[propertyId]` (or a full-height drawer):
  left Closer Lab script from `src/lib/coach/script-cache.ts` with tokens resolved from lead/contact/
  comps; right numbers card (as-is, ARV, confidence, anchors, "verify first"), notes/texts, send
  card, post-call prompt docked. Call button → Phase 2 dial.
- **Send-contract card.** New component using `sendContractWithTemplate`
  (`src/lib/esign/send-contract.ts:30`): price, closing date editable; title company and entity
  pickers from new org settings tables (`acquisition_contract_defaults`); earnest $500 default;
  read-only review line; all other template fields mapped from lead/public record/defaults per the
  Phase 0 audit. On provider confirmation → `fn_log_acquisition_offer` with `follow_up_at` = closing
  date − N days (creates the "Offer follow-up" appointment via the Phase 1 trigger) and stage →
  Offer Sent. Failure → nothing logged, error shown.
- **AI facts from Dialpad.** When `provider_transcript`/summary present, a server job writes a
  summary note and proposes motivation/timeline/condition/mortgage/asking/next-step into a
  `lead_call_facts` row shown on the prompt as prefill chips (accept to write to the lead).

Tests: provider mocked; comps RLS; call screen render; send card prefill mapping snapshot;
offer-logged-after-confirmation integration test.

### Verification (end to end, after Phase 3)

1. Preview deploy with Phase 0 keys. Training lead: appears in strip with a reason; Comp this lead
   fills numbers; Call dials via Dialpad desktop; hangup → prompt opens prefilled, share link on the
   attempt, Dialpad summary note present; tap "Next week" → appointment in My Leads, lead page,
   calendar, dashboard identically; at due time the alert pins the lead; Send contract with a test
   Dropbox Sign account → offer logged after confirmation, stage Offer Sent.
2. Dial the training number from the Dialpad mobile app → matched, attempt `dialpad-native:…`,
   prompt on next open.
3. KPI tiles before/after Phase 1 relabel agree on historical periods.

### Out of scope / later

Telnyx as dialer (requires porting numbers), Deepgram/Claude transcription, inbound call handling on
Telnyx, Assigns.com integration (no API found), Jitter summary billing (Jarrad), portfolio of local
caller-ID numbers.
