# Messages v2 redesign — plan and checklist

Date: 2026-10-14. Owner: Jarrad Henry. Status: PLAN APPROVED FOR SEQUENCING; each PR still needs Jarrad's "go" before it starts.

Design source: the mockup Jarrad approved on 2026-10-14 (scratchpad `mockup/index.html`, local server port 8766) and the Claude Design canvas https://claude.ai/artifact/6RgLWLmHHeVGmtj67FbTbC. Brief: `messages-v2-redesign-brief.md` (same session; copy into this folder with PR 1).

## Ground rules for every PR

- [ ] Sandra's sidebar and top bar are untouched. Only the page inside changes.
- [ ] In the UI, every AI action is "Sandra". The word "Jev" never appears on the page.
- [ ] Sandra only sends texts Jarrad approved word for word. No LLM-written replies go out alone.
- [ ] Sandra only does things that can be undone (start a drip, set a reply type, send an approved text). Do-not-contact is always a person.
- [ ] No business rule text (question wording, reply text, drip text) is added or changed without Jarrad approving the exact text in a fenced block, one text per approval.
- [ ] Each PR: `Depends on:` line, Fable review, then Codex adversarial review at the current head returning `APPROVE_MERGE: YES`. Green CI is not approval.
- [ ] Each PR is verified on the production URL in a browser before it is called done.

## PR 1 — New page face (ship fast, no behaviour change)

Goal: the page looks and reads like the mockup, running on today's engine (the 8-answer Jev classifier). Nothing Sandra does changes yet.

- [ ] Replace the header badges with a `Sandra's rules` button opening a side panel. Panel shows the current switches as plain-English rows (today's 5 switches + drip switch + cutoff), grouped "Goes to Jarrad / Sandra handles alone / Waits for a person".
- [ ] Replace the live-feed step log with tape cards: time, name, address, our last text, their text, colored tag, one plain sentence, one "what she did" line with undo where undoable.
- [ ] Map today's engine words to tape words: new_lead → "Wants an offer", nurture → "Maybe later", not_interested → "Not interested", wrong_number → "Wrong person", opted_out → "Asked to stop", unclear → "Can't read it", escalation `hot_lead`/`call_request` → "Wants an offer", `price_or_offer` → "Talked price". (Display mapping only.)
- [ ] "LEGACY / already_terminal" cards become one quiet line: "Already a lead, left for the person who owns it" with the seller text shown.
- [ ] Live card state: "Sandra is reading…" → decided → "Replying in a few minutes" → sent.
- [ ] "Waiting for a person" column: newest first, plain reason, one-click actions (Stop texting them / It's just a no / Send the hostile reply / Dismiss / Open thread). No oldest-first anywhere.
- [ ] Hide permanently DNC-locked properties from the waiting column (63 today).
- [ ] One accuracy line in the header: "right N% of the time this week". Remove the scorecard grid and the Luna block from the page (data stays; nothing deleted).
- [ ] "Show yesterday's tape" loads earlier days.
- [ ] Rename on-page: "Jev is on" → "Sandra is on", etc. Admin link "Jev thresholds" left alone for now.
- [ ] Playwright: page renders, tape card shows a plain sentence, rules panel opens, waiting column newest-first, DNC-locked hidden.
- [ ] Depends on: none.

## PR 2 — Hot sellers go to Jarrad, and only hot sellers ping

Goal: "wants an offer" and "talked price" become a lead on My Leads under Jarrad Henry, with a Slack message and a text message. Nothing else pings.

- [ ] On a hot decision: set the property to a lead and assign it to Jarrad's user (today promotion sets status only; add the assignment).
- [ ] Tape line reads "Handed to Jarrad · now on My Leads · Slack and text sent".
- [ ] Fix the hot-hold text alert: it has never fired. Align `HOLD_ALERT_HOT_REASONS` (prod env) with the reasons Sandra actually writes (`model:hot_lead`, `model:call_request`, `keyword:price_offer`), or make the match prefix-based in code. Prove one real text to Jarrad's phone.
- [ ] Stop the per-hold Slack DM and 1-hour nudge for non-hot holds (263 DMs last week). Keep Slack DM for hot only.
- [ ] Switch `new_lead` automation on in `jev_outcome_thresholds` once PR 2 is live (owner action, logged).
- [ ] Playwright + prod canary: one canary hot text → lead appears on My Leads assigned to Jarrad, Slack + SMS delivery rows `sent`.
- [ ] Depends on: PR 1.

PR 2 coordination notes (from root / My Leads owner, 2026-10-15):
- Contract: `messages.metadata.inbound_message_id` must reference a same-org, same-property inbound message UUID; `inbound_stamp_unresolved: true` means "no handled reply". Preserve stamp arguments in any composer touched.
- Collision surfaces owned by My Leads (do not edit without coordinating): `messages/inbox-detail.tsx`; `leads/[id]/inline-reply.tsx`, `leads/[id]/page.tsx`; `leads/send-sms-stamped.ts`; `lib/messaging/rep-sms.ts`, `lib/messaging/inbound-stamp.ts`; `my-leads/sms-actions.ts`, `my-leads/rep-sms-composer.tsx`. `leads/actions.ts` is CI-frozen.
- PR 2 scope stays in `src/lib/ai-responder/dispatch.ts` (promotion + assignment), `src/lib/hold-alerts/*` (hot reasons, non-hot DM stop), prod env `HOLD_ALERT_HOT_REASONS`, and the tape line. None of the surfaces above.
- My Leads merges: PR #872 merged at 3ea463e3; PR #873 (8617227f) holds the next reserved slot. PR 2 requests its slot after those gates.

## PR 3 — Jarrad's nine questions replace the eight answers

Goal: the engine decides with the nine approved yes/no questions, 60% cutoff, and starts Jarrad's six drips.

- [ ] Load the nine questions verbatim from memory note `jev-approved-questions` (never retyped by a model). Jarrad re-approves the exact text in the PR body, one block.
- [x] Group order (first yes wins): Stop texting (asked_stop or hostile) > Wrong person > Talked price > Open to selling > Maybe later > Not interested > Asked who > Confirmed owner > Needs a person. Approved by Jarrad 2026-10-14 ("yes").
- [ ] Decide the open gap: "gave a time to call" (e.g. "Anytime", "noon is best"). Today it rides on the hot-lead path; Jarrad decides whether it needs its own question. If a new question is added, its text needs verbatim approval.
- [ ] Actions per question (per Jarrad 2026-10-14): 1 and 9 → Jarrad (PR 2 path). 2, 3, 4, 5, 8 → approved reply + matching drip. 6, 7 → waiting for a person. Unclear → waiting for a person.
- [ ] Drip wiring: Maybe later → "Maybe later"; Asked who → "Asked who is texting"; Not interested → "Not interested"; Confirmed owner → "Confirmed owner". Wrong person → close, no drip. "Talking price", "Book appointment", "Curious" are never auto-started.
- [ ] Approved replies: not_interested, nurture (maybe later), wrong_number, hostile exist. "Asked who is texting" uses the approved identity reply (`IDENTITY_REPLY_BODY`, PR #316); the "Asked who is texting" drip skips its day-1 text when that reply already went out. "Confirmed owner" sends no reply: enroll straight into the "Confirmed owner" drip, first line kept as is ("Hey, we tried to give you a call…") per Jarrad 2026-10-14.
- [ ] "Gave a time to call" stays under "wants an offer" (Jarrad 2026-10-14). No new question.
- [ ] Cutoff 0.6 replaces 0.90/0.95; rules panel shows it as "60% sure or more".
- [ ] Shadow run first: 30-day replay harness (`scripts/messages-v2/replay`) comparing nine-question decisions to the human dispositions; report agreement per question to Jarrad before switching on.
- [ ] Depends on: PR 2.

## PR 4 — Clear-out and controls

- [ ] Rules panel switches write through the same owner-only RPCs as today, one switch per question, logged with who/when.
- [ ] Remove the dead scorecard and Luna code paths (not just hidden). Keep Luna's tables; drop the UI.
- [ ] Rename the admin link "Jev thresholds" → "Sandra's rules" (same page).
- [ ] Retire the app's 8-answer labels from the UI entirely.
- [ ] Reuse My Leads' shared `MultiHouseBadge` ("Owns N houses") next to the seller's name on tape cards and waiting cards, with its batched org-scoped read. Waits on the My Leads badge PR merging (Jarrad 2026-10-15: badge visible "when you're messaging").
- [ ] Depends on: PR 3.

## Stage 5 — Stress test (after PR 4, before the release-candidate review)

Rule: volume, not a handful of checks. Every item reports a failure rate, not a pass/fail. Fable designs the runs; Codex executes them autonomously; results go in `.planning/messages-v2/STRESS-RESULTS.md`. Nothing goes to the Fable + Astra release-candidate review until this stage is green.

- [ ] **Decision accuracy replay.** Run the last 30 days of real inbound texts (≈900) through the nine-question engine with the 60% cutoff via `scripts/messages-v2/replay` (sends impossible). Compare each decision to the human disposition. Report agreement per question and the full list of disagreements for Jarrad to spot-check. Gate: no question below the not_interested baseline (94%) without Jarrad's sign-off.
- [ ] **Wording variants.** 30 seller scenarios (one per plain-English situation, including the tie-breaker cases) × 10 wordings each (slang, typos, lowercase, long, hostile-but-not-stop, price-with-refusal, "Anytime"/"noon is best", "yes" to a still-own opener, "yes" to an offer opener) × 3 repeat runs. Report flip rate per scenario (same text, different answer) and wrong-bucket rate. Gate: flip rate under 2%, wrong-bucket under 5% per scenario.
- [ ] **Burst.** Seed 300 inbound texts in 10 minutes to canary properties (canary org/number only, tagged, cleaned up after). Measure: every text gets exactly one pipeline run; no duplicate replies; reply delay stays within 2–6 min; tape shows every card within 5 s via realtime; "Waiting for a person" count matches the DB; no 5xx; no hydration errors. Repeat 3 times.
- [ ] **UI load.** With 5,000 open holds and 2,000 runs in one day (seeded on the canary org): first paint under 3 s; "Show older" and "Show yesterday's tape" page correctly to the end with no gaps or duplicates (compare against DB counts); memory stable over 30 min with realtime on.
- [ ] **Alert fan-out.** 50 hot sellers in 5 min: exactly one Slack DM + one SMS to Jarrad each, caps respected (20 DMs/hr, 10 SMS/hr), nothing for non-hot holds, zero duplicate sends on retry.
- [ ] **Kill switches.** With the burst running: flip each rule off mid-burst and confirm holds appear instead of actions within one text; set outbound_mode=hold and confirm zero sends; restore and confirm resumption with no double-sends.
- [ ] **Cleanup proof.** All canary data removed; counts of real (non-canary) properties, messages, drips and leads unchanged before vs after.

## PR 1 status (2026-10-15)

- [x] PR #874 "new page face" merged a36565ae0 (merged before the Fable+Astra gate by mistake; both reviewed post-merge: Fable YES w/ should-fixes, Astra NO w/ 3 blockers). Left live per Jarrad.
- [x] PR #880 "post-merge review fixes" merged a294f985d with Opus, Sol, Fable and Astra approvals at exact head fc45da729, 8/8 CI, preview 8/8. Fixes: alert cron isolated on the pre-#874 loader (hash-pinned, decisions-equivalence tested); one shared in-org reference verifier for drafts/decisions/reviews; positive property verification everywhere; bounded scoped builds with request-count tests at 150/10k; org filter on message queries; five owner-facing strings replaced with Jarrad-approved text (verbatim, 2026-10-15).
- Rule reaffirmed: every merge needs Fable then Astra approval at the exact tested head, after Opus and Sol.

## Already done (2026-10-14)

- [x] 2,400 old "needs attention" flags cleared with an audit row each. 63 remain only because those properties are DNC-locked.
- [x] Design approved: tape, waiting pile, rules panel, hot → My Leads.
- [x] Naming: Sandra on the page, Jev under the hood.

## Decisions still open for Jarrad

None. All design decisions are closed as of 2026-10-14. Each PR still needs its own "go".
