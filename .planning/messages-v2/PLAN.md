# Messages v2 — plan v1 (2026-10-08)

Status: DRAFT v4 — Opus 5.5 r1 (3) → r2 (1, approval-only) → r3 pending; Astra medium r1 (5) → r2 (3: atomic send reservation, draft durability, switch precedence → fix round 3). Nothing below is approved to ship until both reviews return BLOCKING: 0 and Jarrad confirms.

## 1. Problem

Mel, the VA who tended Sandra's SMS inbox (`/messages`), resigned. Jarrad wants the inbox tended with as little human interaction as possible, driven by Jev (TypeSafe System One — typed judgments, not generated text) with an LLM only where a judgment call or a free-text reply is genuinely needed — and he wants to **watch** every action land in real time on a new page rather than have it run invisibly.

Volume (last 90 days, prod): ~10,950 inbound SMS; ~7,430 properties received a disposition; 69% of human disposition work was `nurture`/`needs_sequence`.

## 2. What exists today (prod, `origin/main`)

- **Inbound path:** Sendillo webhook → `src/lib/messaging/inbound.ts:handleInboundWebhook` → keyword gates (DNC :371, STOP :443, HELP :517, wrong-number :566) → message insert (:662) → owner notification / sequence pause / rep-takeover checks → AI dispatch (:1054; inline or via `src/workflows/ai-reply-delay.ts`).
- **AI responder:** `src/lib/ai-responder/dispatch.ts:dispatchAiResponse` — pre-gates, `classifyAiSkip` (consent, max turns, quiet hours), 45s thread debounce, single-flight claim (`ai_response_claims`), identity-question shortcut, then `classifyForDispatch` (`src/lib/sms-classification/dispatch-bridge.ts`) → Jev → route switch → legacy Claude `generateAiReply` + `safety.ts` + `humanize.ts` → `sendSmsToContact`. Escalation = `markPropertyNeedsAttention` (:2022).
- **Jev is already live in automatic mode:** `ai_responder_configs` for the org is `classifier_provider=jev`, `classifier_mode=automatic` since 2026-09-20. 581 `sms_classification_runs` (not_interested 318, new_lead 93, wrong_number 72, nurture 51, unclear 39, opted_out 6, dnc 2). Today automatic mode applies Jev's outcome with **no confidence threshold**.
- **PR #651 (unmerged):** per-outcome `jev_outcome_thresholds` (seeded provisional defaults by migration), `jev_lead_decisions`, `/jev` decision workspace (needs-decision queue + review), owner-only RLS on configs, atomic auto-apply RPCs. Never Codex-reviewed; one CI failure (local-only Playwright spec leaked into shared suite).
- **Compliance posture (verified 2026-10-08):** 1,052 STOP texts in 90 days → 1,051 phones in `sms_phone_suppressions`, 0 unprotected. Quiet hours 9pm–8am by property state. DNC flag one-way ratchet. Only sends after a STOP were three internal "drip test" messages to one number (needs Jarrad to confirm it is an internal test line).
- **Overlapping automation tracks:** legacy Claude responder, Jev bridge, and the flag-gated `/inbox` prepare/review/accept pipeline (`INBOX_WORKSPACE_SERVER_ENABLED`). v2 must not add a fourth decision path.

## 3. Decisions (Jarrad, interview 2026-10-08)

| # | Decision |
|---|---|
| D1 | New **page** `/messages-v2`, not a tab. Old `/messages` untouched as fallback. |
| D2 | Build on PR #651 (rebased), not a fresh pipeline. |
| D3 | Automation stays **automatic** (it is already live); Jarrad watches live. Originally "shadow for a couple hours" — revised once prod state was known. Scorecard gates further promotion. |
| D4 | All four outcome groups may auto-fire when the scorecard supports it: `not_interested/wrong_number/bad_number`; `opted_out/dnc` incl. non-keyword wording; `nurture/needs_sequence` + start drip; `new_lead` → move to lead, **assigned to Jarrad** (fixed). |
| D5 | Replies: only **verbatim-approved templates** auto-send. Every LLM draft is **held** for one click. Price / distress / new_lead never auto-reply. |
| D6 | Page = left **live feed** (one card per inbound burst, newest on top, cards age out, ~45s burst debounce) + right **holds rail** (oldest first; amber >1h, red >4h). No thread list; "open thread ↗" deep-links to old Messages. Per-label mode badges in header. |
| D7 | Holds visible to Jarrad (owner) + acquisitions members. |
| D8 | Out of sight: Slack message per hold (+1h nudge), SMS to Jarrad for hot holds (new_lead/price/distress), hourly email digest. **Nothing auto-sends after a timeout.** |
| D9 | Rules source: mine ALL dispositions, transcripts and existing prompts (not just Mel's). Every template, hold rule and taxonomy change goes to Jarrad **verbatim** for approval. Audit whether current dispos still make sense (done; proposals pending). |

Standing rules carried into every brief: no LLM adds/edits/removes a business rule without verbatim human approval; Codex approval at current head before any merge; every PR declares `Depends on:`; subagents run Sonnet.

## 4. Architecture

### 4.1 One pipeline, observed
No new decision engine. Each inbound burst already flows through inbound.ts → dispatch.ts → dispatch-bridge.ts. v2 adds an **observation seam** and, later, a **template reply step** and **hold resolution actions** inside that same path.

### 4.2 Evidence tables (migration `20261008143000_pipeline_runs.sql`)
```
pipeline_runs (id, org_id, inbound_message_id UNIQUE, property_id, contact_id, conversation_id,
  status running|replied|held|escalated|closed|skipped|error, mode shadow|automatic|legacy,
  final_outcome, reason, classification_run_id, claim_id, outbound_message_id,
  inbound_preview ≤160 chars, started_at, completed_at)
pipeline_run_steps (id, run_id FK cascade, org_id, seq, kind gate|jev|threshold|action|reply|hold|shadow,
  name, result pass|block|applied|held|sent|would_apply|error|skipped, detail jsonb, created_at, UNIQUE(run_id,seq))
```
RLS select via `hugo_has_active_org_access(org_id)`; insert/update service_role only; both in `supabase_realtime` publication. `detail` never contains message bodies or phone numbers.

### 4.3 Seam `src/lib/pipeline-runs/`
`startRun` (after message insert, or at each keyword exit), `recordStep`, `finishRun` (in `stampAiResponderTerminalOutcome`, the single funnel). Best-effort, non-throwing, null-ctx no-op. `runId` rides on `AiDispatchInput` and the delay-workflow params. Steps recorded at: keyword gates; pre-gates; `classifyAiSkip`; debounce; claim; Jev classify (`{classificationRunId, outcome, probabilities, nativeConfidence, model, latencyMs}`); threshold decision; auto-apply branches; route-switch dispositions; safety block; send; `markPropertyNeedsAttention` (hold). Fewest touch points: wrap `markPropertyNeedsAttention` and `completeAiResponseClaim`.

### 4.4 Page `src/app/(dashboard)/messages-v2/`
Server page: access gate `owner || isAcquisitionsCaller` (separate from the Messages gate, which denies acquisitions members); loads last 200 runs + steps, open holds (status held/escalated with no later run on the conversation), header stats, mode badges from `ai_responder_configs` + `jev_outcome_thresholds`. Client view: realtime channel `messages-v2:feed` on INSERT `pipeline_runs`/`pipeline_run_steps` and UPDATE `pipeline_runs`, merged into client state (no refresh per step). Phase-0 actions render disabled.

### 4.5 Holds (Phase 1)
Hold = run whose terminal step is `hold` (below-threshold, unclear, keyword escalation, safety block, LLM draft awaiting click, human-gated outcome). Actions: **Send** (approved draft as-is), **Edit** (edit then send; edit recorded), **Take over ↗** (open thread, mark human-owned), **Assign** (to a member), **Dismiss** (with reason; re-arms automation — mirrors existing SOP warning). Each resolution writes a `lead_events` row with `actor_type=user` and a feed card. Holds are derived from the sources of truth — `properties.needs_human_attention`, pending `jev_lead_decisions`, pending `ai_disposition_reviews` — and clear only when those clear (never because a later run merely exists). **Send/Edit go through `sendResponderMessage` only** and re-check at click time: suppression/DNC, consent, recipient quiet hours, "this inbound is still the latest", and "no outbound since"; a stale draft is refused, not sent. Drafts live in their own RLS-scoped table (step `detail` never carries bodies).

### 4.6 Replies (enforcement Phase 1, template sends Phase 4)
Template step: when Jev's `reply_intent` maps to an approved template and the outcome is auto-fire-eligible, send the template (as the "Mel" persona) through the existing `sendResponderMessage` path (safety + quiet-hours + consent gates unchanged). Otherwise the legacy Claude draft is produced but **held**, with Jev Noul checks displayed on the hold card (`quotes_price?`, `says_investor?`, `answers_question?`). LLM drafts never auto-send (D5). **Enforced in Phase 1 at the single chokepoint:** `sendResponderMessage` takes `source: 'approved_template' | 'llm' | 'human'`; `llm` is rejected and converted to a hold. Until Phase 1 lands, the legacy Claude responder keeps auto-sending as it does on prod today — stated here so the gap is explicit, not implied.

### 4.7 Alerts (Phase 1)
Slack via existing per-user OAuth `WebClient` (`src/lib/integrations/slack/dispatch.ts`) — DM to Jarrad + each acquisitions member on hold creation and at +1h unresolved. SMS to Jarrad via `src/lib/notifications/rep-sms.ts` for hot holds. Email digest: no email sender exists in Sandra — add Resend (or equivalent) behind an env flag; hourly cron route listing open holds. **Alert payloads carry ids, names and links only — never seller message text** (new vendors receive no SMS bodies). Caps: one Slack DM per hold plus one nudge at +1h; at most 20 DMs per member per hour; hot-hold SMS to Jarrad max 10/hour.

### 4.8 Mode switches
Phase 0–3: display only. Phase 4: per-label toggle UI writes through `fn_set_jev_outcome_threshold` / `fn_update_jev_automatic_classification` (owner-only). Per-label on/off is an explicit `jev_outcome_thresholds.automation_enabled` boolean checked independently of confidence (a threshold of 1.0 is NOT a switch — confidence equal to the threshold auto-applies). Seeded to preserve prod today: on for not_interested / wrong_number / nurture / opted_out; **off for new_lead** (origin/main always escalated new leads to a human). So merging #837 does not start auto-promoting leads; D4's "new_lead → lead assigned to Jarrad" is Phase 4 and needs its own approval.

### 4.8b Outbound policy gate (Phase 0)
All responder sends pass one chokepoint, `sendResponderMessage`, which (a) re-verifies immediately before the provider call that the run's inbound is still the latest in the conversation and no outbound has gone since the claim (closes the two-inbounds-one-conversation double-reply race, which pre-dates v2), (b) takes a `source: approved_template | llm | human`, and (c) honours `ai_responder_configs.outbound_mode = send | hold` (owner-only), env `AI_RESPONDER_OUTBOUND_MODE`, and env `AI_RESPONDER_LLM_AUTOSEND` (default `1` = prod today; `0` = D5 enforcement, flipped in Phase 1). **Precedence: either hold wins** — a send requires DB mode `send` AND env unset-or-`send`; the env can force `hold` but can never override an owner's DB `hold`. Sends are serialized per conversation by an expiring reservation (`ai_send_reservations`, RPC `fn_reserve_ai_send`); latest-inbound and no-outbound-since-claim are re-validated under the reservation, lookup errors fail closed (no send, `send_check_failed` hold), and the outbound policy is re-read immediately before the provider call. Held drafts are persisted idempotently (unique on pending inbound) before the claim completes; a persistence failure leaves the claim open so the ordinary retry re-runs. Held drafts go to `ai_reply_drafts` (RLS owner||acquisitions) and raise a hold — this is the draft-only rollback Astra asked for.

### 4.9 Kill switches and rollback
- **Automation:** `classifier_mode=shadow` stops Jev from driving effects but the legacy responder still generates and sends; **draft-only rollback** = `outbound_mode=hold` (§4.8b), which stops every **AI-responder** send and holds drafts instead. It does NOT stop sequence ticks, bulk-queue sends or Norma pre-call SMS — those have their own controls; routing them through the same gate is Phase 1 work.
- **Seam:** `PIPELINE_RUNS_ENABLED=0` makes recording a no-op; the page simply shows no new cards.
- **Thresholds:** per-label relax/tighten via `fn_set_jev_outcome_threshold`, no deploy.
- **Rollback:** every migration ships a `supabase/rollbacks/` counterpart; `pipeline_*` tables are additive and droppable.
- **Seam health:** failures go to `reportError`; a 10-minute cron sweeps `running` rows older than 30 min to `error`; the page header shows inbound-vs-runs coverage for the last hour and turns red when runs < inbound.

### 4.10 Consent / purpose matrix (Phase 4 gate)
`send.ts` permits no-consent sends and does not distinguish marketing from informational purpose. Before template auto-send or automated drip enrollment, Jarrad approves a matrix of {message purpose} × {consent state} → allowed/held, and it is enforced centrally in `sendResponderMessage`. Recipient-local quiet hours are part of that same gate.

### 4.11 Alert delivery semantics (Phase 1)
Durable `hold_alert_deliveries` rows keyed by (hold, recipient, channel, stage) with bounded retries, visible failures on the hold card (`no_token` / `pref_disabled` from Slack dispatch are surfaced, not swallowed), recipient authorization re-checked at delivery time, and the caps in §4.7.

### 4.12 Migration proof (done 2026-10-08)
Full chain (389 files incl. the 28 re-timestamped) applied clean on a fresh Supabase 17 image; every jev_* object exists exactly once; `verify:migration-safety-unit` 60/60. Seven of the 28 are not idempotent (unconditional create) — irrelevant because **neither prod (`copflsklaefwzipsrjqz`) nor test (`ncsngxlcyxylaeskiteu`) ever applied the old versions** (verified via `supabase_migrations.schema_migrations`; only `20260920120000_sms_classification_runs` is present). PR #651 must be closed when #837 merges.

### 4.13 Known compliance gaps (not closed by this plan)
- Quiet hours are keyed to the **property's** state; TCPA quiet hours follow the **recipient's** location. Absentee owners are common. Phase 4 (template auto-send) is gated on recipient-local quiet hours.
- Florida's 8am–8pm window and 3-texts-per-24h cap are not modelled.
- `dnc` is always human-gated in code (`thresholds.ts:81`) even though D4 lists it as auto-fire — open for Jarrad (Q4).
- `ai_disposition_reviews` reads and its RPCs still allow any active org member (pre-dates this PR); these rows render as holds, so D7 is only partly applied there — Phase 1.

## 5. Phases and gates

| # | Phase | Lands | Gate |
|---|---|---|---|
| 0 | Rebase + feed | PR #837 (done: merge of #651, 28 migrations re-timestamped `20261008140000..142700`, Playwright local spec excluded) + `pipeline_runs` + seam + `/messages-v2` live feed, actions disabled | Codex APPROVE_MERGE at head; Jarrad watches ≥2h of live traffic |
| 1 | Holds + alerts + D5 enforcement | Hold actions (Send/Edit/Take over/Assign/Dismiss) with click-time re-checks, drafts table, `sendResponderMessage.source` rejecting `llm`, Slack/SMS/email | Jarrad clears 10 real holds; alert delivery proven in prod; no LLM auto-send observed for 24h |
| 2 | Rules mining + approvals | Templates, hold rules, dispo taxonomy proposals — each presented verbatim | Every rule text approved by Jarrad |
| 3 | Scorecard | Per-label agreement with human corrections over trailing window; threshold suggestion | Shown on page |
| 4 | Template auto-send + per-label switches | §4.6, §4.8; new_lead → lead assigned to Jarrad | One label at a time, off the scorecard |

Each phase is its own PR with `Depends on:` the previous one.

## 6. Dispo taxonomy audit (evidence only; proposals unapproved)

Human sets `nurture` then promotes to `needs_sequence` 1,701× (95% of human nurture sets) — nurture is a parking step. `callback_requested`: 0 new sets in 90 days. `not_interested`↔`wrong_number` confused both ways (145 / 9). `needs_sequence` carries two jobs (active interest + follow-up-later). Jev cannot emit `needs_sequence`/callback. 404 properties received an inbound after their last dispo (stale, not unprotected). A sibling session owns the outcome-label work (pending: "Price too high", "Listed with agent", "Sold", "Buyer"); v2 will consume its approved list and not rename anything.

## 7. Risks and mitigations

1. **Merging #837 changes prod behaviour**: thresholds start gating low-confidence Jev calls that today auto-apply → holds appear. Accepted (D3) **only once each seeded threshold is approved verbatim (§8)**; `fn_set_jev_outcome_threshold` can relax per label without deploy. Phase 0 bundles observation with this behaviour change — mitigated by the two kill switches (§4.9), and the first 2h of feed is the baseline window.
1b. **Opt-out regression in #651 (found by review, fixed):** below-threshold Jev `opted_out` only proposed a disposition and left the phone reachable; now every Jev `opted_out` suppresses the phone immediately and defers only the disposition write.
1c. **PR #651 must be closed when #837 lands** — its original-timestamp migrations would otherwise re-apply the same objects out of order.
1d. **Other prod behaviour changes in #837 (enumerated):** (i) the pre-send supersession/reservation check can now *skip* a reply that previously would have gone out as a second reply to a burst — intended; (ii) the six Jev decision RPCs and `jev_lead_decisions` reads now require owner‖acquisitions instead of any active member — plain members lose `/jev` workspace actions (D7); (iii) a duplicate dispatch can no longer finalize a run it does not own.
2. **Migration ordering**: 28 re-timestamped migrations; guard `check-migration-safety` must pass; integration tests on local PG; `db-migrate-test` runs first on merge.
3. **Double-reply**: existing single-flight claim + debounce are untouched; the template step reuses `sendResponderMessage`. No new send path.
4. **Realtime fan-out**: two tables publish every step; page keeps ≤200 runs client-side; RLS by org.
5. **Hold flood**: if thresholds are too tight the rail floods. Scorecard + per-label threshold relax; alerts rate-limited (one Slack DM per hold, one nudge).
6. **Persona**: outbound still signs "Mel" (`OUTBOUND_SENDER_NAME`) with no human behind it — Jarrad accepted; revisit if sellers ask for her.
7. **Email sender does not exist** — new dependency; feature-flagged, digest only.
8. **#651 quality unverified** (no prior review; +656/-100 in dispatch.ts). Codex adversarial review of #837 is the gate, not CI.

## 8. Open questions for Jarrad

- Q1 Confirm the number that received "drip test" messages after a STOP (8/15 → 9/26–28) is an internal test line.
- Q2 Approve the dispo-taxonomy proposals (separate rule-approval set) or defer to the sibling outcomes session.
- Q3 Email provider choice for the digest (Resend default?).
- Q4 `dnc`: keep the code's always-human gate (suppression still immediate) or allow auto-apply as D4 implies?
- Q7 The fixed deterministic "Who is this?" identity reply is currently tagged `source: llm` at the chokepoint; when `AI_RESPONDER_LLM_AUTOSEND=0` (Phase 1) it would be held too. Reclassify it as `approved_template` (its text was approved in `decisions/Sandra identity-response deterministic interceptor`)? Needs a yes.
- Q6 **Opt-out suppression rule (own approval):**
  - `When Jev classifies an inbound SMS as opted_out at any confidence, suppress that phone number immediately (no further automated texts to it from any property), and defer only the disposition write for human review. A human rejecting that review does NOT restore texting; un-suppression stays a separate manual action.`
- Q5 **Verbatim approvals required before merge** — each line is a business rule. Note: on origin/main, automatic mode auto-applied not_interested / wrong_number / opted_out / nurture at **any** confidence, so the 0.90/0.95 cutoffs are a real tightening (more holds), not a no-op; the `automation_enabled` line preserves which outcomes may act at all:
  - `new_lead: auto-apply at native confidence ≥ 0.90`
  - `wrong_number: auto-apply at native confidence ≥ 0.90`
  - `not_interested: auto-apply at native confidence ≥ 0.95`
  - `nurture: auto-apply at native confidence ≥ 0.95`
  - `opted_out: auto-apply at native confidence ≥ 0.95`
  - `automation_enabled: not_interested=on, wrong_number=on, nurture=on, opted_out=on, new_lead=off (as prod today)`
