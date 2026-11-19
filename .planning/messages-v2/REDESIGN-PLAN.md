# Messages v2 redesign — plan and checklist

Date: 2026-10-14. Owner: Jarrad Henry. Status: PLAN APPROVED FOR SEQUENCING; each PR still needs Jarrad's "go" before it starts.

Design source: the mockup Jarrad approved on 2026-10-14 (scratchpad `mockup/index.html`, local server port 8766) and the Claude Design canvas https://claude.ai/artifact/6RgLWLmHHeVGmtj67FbTbC. Brief: `messages-v2-redesign-brief.md` (same session; copy into this folder with PR 1).

## Ground rules for every PR

- [x] Sandra's sidebar and top bar are untouched. Only the page inside changes.
- [x] In the UI, every AI action is "Sandra". The word "Jev" never appears on the page. (PR 1: checked on the page and in the rules panel; the confirm dialog still shows engine rule text such as `nurture: auto-apply at native confidence ≥ 0.95 (ON)` because that is the exact text an owner approves.)
- [ ] Sandra only sends texts Jarrad approved word for word. No LLM-written replies go out alone.
- [ ] Sandra only does things that can be undone (start a drip, set a reply type, send an approved text). Do-not-contact is always a person.
- [ ] No business rule text (question wording, reply text, drip text) is added or changed without Jarrad approving the exact text in a fenced block, one text per approval.
- [ ] Each PR: `Depends on:` line, Fable review, then Codex adversarial review at the current head returning `APPROVE_MERGE: YES`. Green CI is not approval.
- [ ] Each PR is verified on the production URL in a browser before it is called done.

## PR 1 — New page face (ship fast, no behaviour change)

Goal: the page looks and reads like the mockup, running on today's engine (the 8-answer Jev classifier). Nothing Sandra does changes yet.

- [x] Replace the header badges with a `Sandra's rules` button opening a side panel. Panel shows the current switches as plain-English rows (today's 5 switches + drip switch + cutoff), grouped "Goes to Jarrad / Sandra handles alone / Waits for a person".
- [x] Replace the live-feed step log with tape cards: time, name, address, our last text, their text, colored tag, one plain sentence, one "what she did" line with undo where undoable.
- [x] Map today's engine words to tape words: new_lead → "Wants an offer", nurture → "Maybe later", not_interested → "Not interested", wrong_number → "Wrong person", opted_out → "Asked to stop", unclear → "Can't read it", escalation `hot_lead`/`call_request` → "Wants an offer", `price_or_offer` → "Talked price". (Display mapping only.)
- [x] "LEGACY / already_terminal" cards become one quiet line: "Already a lead, left for the person who owns it" with the seller text shown.
- [x] Live card state: "Sandra is reading…" → decided → "Replying in a few minutes" → sent.
- [x] "Waiting for a person" column: newest first, plain reason, today's hold actions relabelled (Send / Edit / Open thread / Dismiss / Stop texting them). No oldest-first anywhere. (New one-click actions "It's just a no" and "Send the hostile reply" are not in PR 1: they change behaviour.)
- [x] Hide permanently DNC-locked properties from the waiting column (63 today).
- [x] One accuracy line in the header: "right N% of the time this week". Remove the scorecard grid and the Luna block from the page (data stays; nothing deleted).
- [x] "Show yesterday's tape" loads earlier days.
- [x] Rename on-page: "Jev is on" → "Sandra is on", etc. Admin link "Jev thresholds" left alone for now.
- [x] Playwright (written; needs the Supabase test project to run): page renders, tape card shows a plain sentence, rules panel opens, waiting column newest-first, DNC-locked hidden.
- [x] Depends on: none.

## PR 2 — Hot sellers go to Jarrad, and only hot sellers ping

Goal: "wants an offer" and "talked price" become a lead on My Leads under Jarrad Henry, with a Slack message and a text message. Nothing else pings.

- [x] On a hot decision: set the property to a lead and assign it to Jarrad's user (today promotion sets status only; add the assignment).
- [x] Tape line reads "Handed to Jarrad · now on My Leads · Slack and text sent".
- [x] (code; real text still to prove after switch-on) Fix the hot-hold text alert: it has never fired. Done in code: hot = lib/hot-sellers/hot.ts; HOLD_ALERT_HOT_REASONS removed. Align `HOLD_ALERT_HOT_REASONS` (prod env) with the reasons Sandra actually writes (`model:hot_lead`, `model:call_request`, `keyword:price_offer`), or make the match prefix-based in code. Prove one real text to Jarrad's phone.
- [x] Stop the per-hold Slack DM and 1-hour nudge for non-hot holds (263 DMs last week). Keep Slack DM for hot only.
- [ ] Switch `new_lead` automation on in `jev_outcome_thresholds` once PR 2 is live (owner action, logged).
- [x] (written, disabled by default) Playwright + prod canary: one canary hot text → lead appears on My Leads assigned to Jarrad, Slack + SMS delivery rows `sent`.
- [ ] Depends on: PR 1.

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
- [ ] Depends on: PR 3.

## Already done (2026-10-14)

- [x] 2,400 old "needs attention" flags cleared with an audit row each. 63 remain only because those properties are DNC-locked.
- [x] Design approved: tape, waiting pile, rules panel, hot → My Leads.
- [x] Naming: Sandra on the page, Jev under the hood.

## Decisions still open for Jarrad

None. All design decisions are closed as of 2026-10-14. Each PR still needs its own "go".
