# Messages v2 — plan v1 (2026-10-08)

Status: DRAFT for review (Opus 5.5 + Astra medium). Nothing below is approved to ship until both reviews return BLOCKING: 0 and Jarrad confirms.

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

### 4.5 Holds (Phase 2)
Hold = run whose terminal step is `hold` (below-threshold, unclear, keyword escalation, safety block, LLM draft awaiting click, human-gated outcome). Actions: **Send** (approved draft as-is), **Edit** (edit then send; edit recorded), **Take over ↗** (open thread, mark human-owned), **Assign** (to a member), **Dismiss** (with reason; re-arms automation — mirrors existing SOP warning). Each resolution writes a `lead_events` row with `actor_type=user` and a feed card. A hold auto-collapses when a newer inbound on the same conversation resolves it (e.g. STOP).

### 4.6 Replies (Phase 4)
Template step: when Jev's `reply_intent` maps to an approved template and the outcome is auto-fire-eligible, send the template (as the "Mel" persona) through the existing `sendResponderMessage` path (safety + quiet-hours + consent gates unchanged). Otherwise the legacy Claude draft is produced but **held**, with Jev Noul checks displayed on the hold card (`quotes_price?`, `says_investor?`, `answers_question?`). LLM drafts never auto-send (D5).

### 4.7 Alerts (Phase 2)
Slack via existing per-user OAuth `WebClient` (`src/lib/integrations/slack/dispatch.ts`) — DM to Jarrad + each acquisitions member on hold creation and at +1h unresolved. SMS to Jarrad via `src/lib/notifications/rep-sms.ts` for hot holds. Email digest: no email sender exists in Sandra — add Resend (or equivalent) behind an env flag; hourly cron route listing open holds.

### 4.8 Mode switches
Phase 0–3: display only. Phase 4: per-label toggle UI writes through existing `fn_set_jev_outcome_threshold` / `fn_update_jev_automatic_classification` (owner-only). Per-label "AUTO/HELD" is expressed as threshold value (1.0 = always held), not a new column — avoids a new schema concept.

## 5. Phases and gates

| # | Phase | Lands | Gate |
|---|---|---|---|
| 0 | Rebase + feed | PR #837 (done: merge of #651, 28 migrations re-timestamped `20261008140000..142700`, Playwright local spec excluded) + `pipeline_runs` + seam + `/messages-v2` live feed, actions disabled | Codex APPROVE_MERGE at head; Jarrad watches ≥2h of live traffic |
| 1 | Holds rail + alerts | Hold derivation, actions (Send/Edit/Take over/Assign/Dismiss), Slack/SMS/email | Jarrad clears 10 real holds; alert delivery proven in prod |
| 2 | Rules mining + approvals | Templates, hold rules, dispo taxonomy proposals — each presented verbatim | Every rule text approved by Jarrad |
| 3 | Scorecard | Per-label agreement with human corrections over trailing window; threshold suggestion | Shown on page |
| 4 | Template auto-send + per-label switches | §4.6, §4.8; new_lead → lead assigned to Jarrad | One label at a time, off the scorecard |

Each phase is its own PR with `Depends on:` the previous one.

## 6. Dispo taxonomy audit (evidence only; proposals unapproved)

Human sets `nurture` then promotes to `needs_sequence` 1,701× (95% of human nurture sets) — nurture is a parking step. `callback_requested`: 0 new sets in 90 days. `not_interested`↔`wrong_number` confused both ways (145 / 9). `needs_sequence` carries two jobs (active interest + follow-up-later). Jev cannot emit `needs_sequence`/callback. 404 properties received an inbound after their last dispo (stale, not unprotected). A sibling session owns the outcome-label work (pending: "Price too high", "Listed with agent", "Sold", "Buyer"); v2 will consume its approved list and not rename anything.

## 7. Risks and mitigations

1. **Merging #837 changes prod behaviour**: thresholds start gating low-confidence Jev calls that today auto-apply → holds appear. Accepted (D3); seeded defaults reviewed before merge; `fn_set_jev_outcome_threshold` can relax per label without deploy.
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
