---
type: decision
status: active
tags: [sandra, crm, dialer, outreach, decision]
created: 2026-10-02
updated: 2026-10-02
aliases: ["Norma Sandra integration", "Have Norma call", "Bland AI Norma pilot"]
related: ["[[Sandra]]", "[[Switchboard]]"]
---
# Norma (Bland AI) into Sandra — pilot design decisions

Design review with Jarrad, 2026-10-02 (Claude, Fable 5.1). **Design only — no code written, Norma not changed, no calls placed.** Code facts checked against [[Sandra]] `origin/main` @ `6d678ad7` (the local checkout was 1,421 commits behind).

Norma = the Bland AI outbound seller-qualification agent. She calls sellers who have said they want an offer, and qualifies motivation, condition, timing, asking price, flexibility, decision-makers. She cannot invent a dollar offer or buying authority.

## Decided (Jarrad, 2026-10-02)
- **Entry point:** a dedicated "Have Norma call" button in the lead header actions. Not an outcome-menu option, not the drip picker.
- **Who sees it:** all members.
- **Human-initiated only.** A positive reply never auto-triggers a call. Norma is only used once a seller has indicated interest in an offer; that judgement (and calling-hours compliance) is the rep's.
- **Hard blocks:** Sandra refuses do-not-contact numbers and "not interested" leads. Everything else is rep judgement.
- **Pilot is callback-only.** Norma qualifies, takes a preferred callback time, a rep calls back. A callback request is not a confirmed appointment.
- **Live handoff is parked** until Bland confirms warm transfer is available on the account (see Unverified).
- **Callback tasks are assigned to Jarrad** (2–3 people on the team, so no bottleneck concern).
- **No answer:** hang up, no voicemail.
- **Drip:** pause the SMS drip when Norma is requested. (Claude's recommendation, not explicitly confirmed: resume on no-answer, stay paused if she reached the seller.)
- **Slack summary:** posted by the BMH outreach bot to the same channel [[Switchboard]] uses. Build should reuse Switchboard's configured channel ID rather than guess.
- **Caller ID:** buy a local Kansas City number in Bland; inbound calls to it forward to the Dialpad main line. Purchase is spend — needs Jarrad's OK at the time.
- **Rehearsal first:** Norma calls Jarrad's phone (he plays the seller) before any real seller.
- **Sequencing:** build "call now" (one call) first and rehearse it; then add "schedule for later" as step two of the same pilot. For scheduled calls Sandra holds the request and dials at the time after rechecking do-not-contact — not Bland's own `start_time`.
- **No follow-up-sequence option** in the pilot.

## Open
- **Decided:** when a seller tells Norma to stop calling, Sandra marks the lead **not interested** — not do-not-contact (Jarrad overrode Claude's auto-DNC recommendation). **Also decided:** the button refuses "not interested" leads as well as do-not-contact ones; a rep can change the status first if the seller comes back.
- Exact Slack channel name/ID (Claude could not find it via Slack search).
- Dialpad sales line ring time / voicemail behaviour (only matters once live handoff is un-parked).
- Legal read on AI-voice outbound consent: Jarrad's call; he is proceeding on "seller has indicated interest".

## Facts found
**Bland account (Codex via Bland MCP, read-only):**
- Norma is pathway-backed: agent "BMH Seller Outreach — Qualification" `7e69b0be-b31c-46ec-8b99-4eac0f829fa3`, pathway `7d2ab8a0-d0cf-4d70-87c3-370440c40faa`, staging version 0.0.17. (A separate agent literally named "Norma" is Bland's starter demo.)
- No Transfer Call node exists in the pathway — live handoff is unbuilt.
- Plan shows `status: "none"`; enterprise entitlement not confirmed.
- One number on the account: +1 (213) 444-7173 (Los Angeles).

**Bland docs (docs.bland.ai, read via a summarising fetch):**
- Warm transfer is an enterprise feature, configured on a pathway Transfer Call node. Private briefing, hold music, hold timeout and "continue in pathway" on timeout are documented.
- NOT documented: an explicit rep accept/decline gate, voicemail/IVR detection on the transfer leg, return-to-seller after a decline. A Dialpad voicemail could be treated as a rep.
- Proxy number shown to the rep must be on the same Twilio account as the call.
- Post-call webhook exposes transfer state, summary, variables, transcripts; signing is HMAC-SHA256 via `X-Webhook-Signature`.

**Sandra code (`origin/main` @ `6d678ad7`):**
- No Bland/Norma code exists.
- Sequence engine supports only `send_sms` and `change_status`, hard-wired in a DB check constraint, the `replace_steps` RPC and an if-chain in `src/lib/sequences/tick.ts`. One live drip per lead (unique index).
- Reusable: `evaluateSuppression` / DNC lock, `pausePropertyEnrollments` (needs a new pause reason), tasks (`callback` type; no requested-vs-confirmed state), `lead_events` (needs a new event type + timeline renderer), the Switchboard webhook auth/idempotency pattern, lead header `heroActions`.
- Must be built: Bland client, call-request record, post-call webhook, voice phone selection, Slack channel posting (Sandra only DMs individual users today), a timed job for scheduled calls.
- `memberships.acquisitions_enabled` exists as an acquisitions group switch (not used for the button, since all members get it).
- Unmatched inbound Dialpad department calls are not tied to a lead.

## Unverified
- Whether the Bland account can get warm transfer (ask Bland sales).
- Whether a Bland inbound number can simply forward to the Dialpad line.
- Norma's approved script content was not reviewed.
- Codex's research notes (`~/Documents/Codex/2026-10-01/…/DECISIONS-AND-CURRENT-CODE.md`) could not be read from the Claude session.
