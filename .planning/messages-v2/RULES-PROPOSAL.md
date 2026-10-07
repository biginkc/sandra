# Messages v2 — Phase 2 rules-mining proposal

Status: PROPOSAL ONLY. Nothing in this file is approved, wired, seeded or live. Every fenced block below is a **candidate** that needs Jarrad's verbatim approval, one block at a time, before any code uses it (PLAN.md §3 D5/D9, standing rule: no LLM adds, edits or removes a business rule). Where a block is approved, it is copied character for character. Counts are evidence, not authority.

**Path to approval.** Every reply-template candidate is loaded as an UNAPPROVED draft into the Phase 4 Templates library and approved there verbatim, one template at a time. Hold rules H-1..H-8 are approved as rule text through the same one-rule-per-approval process, surfaced in the /messages-v2 settings. Nothing in this document, and nothing said in chat, counts as approval.

Depends on: #837 (Messages v2 plan). Queries: `scripts/messages-v2/mine-rules.sql` (Q-numbers below refer to it).

## 1. Method and data volumes

Source: prod Supabase (`copflsklaefwzipsrjqz`), SELECT only, window 2026-04-10 to 2026-10-07 (180 days) unless stated. Run 2026-10-07.

| Item | Volume | Note |
|---|---|---|
| Inbound SMS | 20,480 | Q01 |
| Outbound SMS | 121,893 | mostly openers/drips/campaigns |
| Human disposition sets (`dispo_set`, actor `user`) | 6,022 | of 9,049 total `dispo_set` events (ai 1,561, system 1,466; Q02) |
| Legacy AI responder (`generated_by = ai_responder_v1`) sends | 4,954 | since 2026-04-24 |
| AI disposition reviews | 1,449 | 1,025 human-confirmed, 365 auto-accepted, 58 superseded, 1 pending (Q05) |
| Jev runs (`sms_classification_runs`) | 581 | **only since 2026-09-24 (13 days)**, so Jev evidence is thin (Q01, Q06) |
| Human-sent replies (see definition) | 2,727 first replies to an inbound | Q10 |

**Human reply definition (Q10):** outbound sms, `campaign_id` null, `generated_by` null or not `ai_responder_v1`, not a `sequence_step_runs` message, and the first outbound after the latest inbound in that conversation within the prior 48h. The messages table has no sender column, so "human" is by exclusion. It includes anything sent by hand through the UI by Mel or any other teammate. 21,293 outbound messages pass the first filters; 2,949 sit within 48h of an inbound; 2,727 are first replies.

**Findings that change how to read everything below**
1. Mel's real replies are about 10 macros, not free text. Four macro families (A, B, H, C below) = 1,758 of 2,727 first replies (64%). They map to the existing Library entries in `docs/sms-templates.md` (lines 356-374), so the "voice" is already approved text, not invention. (Q11, Q14)
2. **There is no `reply_intent` anywhere today**: not in the Jev decision JSON (keys are only `outcome`, `outcomeConfidence`, `wrongScope`, `probabilities`, `escalationReason`; Q06) and not in the code. So templates below are keyed to Jev `outcome` (+ `escalationReason`), not to an intent field. Defining intents is a Phase 4 design item and would itself need approval.
3. Transcript evidence is thin: 9 distinct Mel call files (one a byte-identical duplicate), all outbound cold calls from 2026-04-17, auto-transcribed and unlabelled by speaker. Mel never texts in them. `_jt-corpus` is JT's voice, not Mel's, so it was not used for tone. Voice claims below rest mostly on her SMS macros, not calls.
4. Outcome joins are proxies. "Resulting disposition" = first `dispo_set` (any actor) on the property within 3 days after the inbound; "none" does not mean nothing happened.

## 2. Reply templates (candidates)

Constraints applied to every candidate (from `docs/prompts/ai-responder-v2.md`): 160 characters or fewer, first person as Mel, no price, never the word "investor", at most one cash-offer ask, no motivation questions, no em dashes. Character counts are exact. Templates marked **hold-card draft only** would never auto-send; they would pre-fill a human's one-click hold card (D5: price, distress and new_lead never auto-reply).

Already approved, not re-proposed: the identity reply (`decisions/Sandra identity-response deterministic interceptor`, PR #316). 1,951 of 4,954 legacy AI sends (39%) are exactly this text, so it is the most-used approved reply. Its `source` tag (`approved_template`) is an engineering detail in PLAN §8 Q7 (withdrawn); no approval is sought here.

### 2.1 not_interested  (Jev: 318 runs; 260 at or above 0.95)

Human evidence: macro H (`All good, <first name>, if anything changes in the next N-M months, mind if I check back?`) was sent 484 times; 255 of those had `not_interested` as the resulting disposition, 33 `nurture`; 198 got a reply within 24h (41%, includes more "no"s). Macro D (short acknowledgement) was sent 205 times, only 30 got a reply (15%), so it ends the thread cleanly. Inbounds that got H: `no` (118), `not for sale` (25), `no thanks` (19), `no thank you` (16), `not interested` (13), `nope` (13), `not at this time` (12). Mel's call tone matches: she closes on a refusal with a thank-you and one soft ask to keep in touch (`20260417-151333 8167411558-all.txt`, `20260417-152655 8167161212-all.txt`); no pushback.

Candidate NI-1 (human macro H, 484 sends; first name dropped so it needs no variable; 104 characters)
```
All good, thanks for letting me know. If anything changes in the next 6-12 months, mind if I check back?
```
Applies: clean refusal, Jev not_interested, no hostility, no third party, first reply in the thread.
Must NOT fire: hostile or profane inbound (see 3.3); "sold", "just sold", "already sold" (Jev tags 5+ of these not_interested; a check-back ask is wrong); any STOP-type wording; owner says they are not the owner (that is wrong_number); any reply after the AI/human has already answered once.

Candidate NI-2 (human macro D, 205 sends; 50 characters)
```
Understood, thanks for letting me know. Take care.
```
Applies: refusal with mild irritation ("no!", "hell no", "never"), where a check-back ask would grate; also the fallback if Jarrad rejects NI-1's follow-up question.
Must NOT fire: same list as NI-1.

### 2.2 wrong_number  (Jev: 72 runs; 41 at or above 0.95; 0 human corrections)

Human evidence: the referral macro `My apologies, I'll get you off the list right away. Quick favor though, any chance you know who owns <address>?` was sent 65 times; 33 got a reply within 24h (51%), which is the highest reply-back for any "no" type. The Library template is `Reply: Wrong number / referral ask` (`docs/sms-templates.md` line 360).

Candidate WN-1 (human macro (referral), 65 sends; address dropped to avoid repeating it per the anti-repetition rule; 105 characters)
```
Sorry about that, my mistake. I'll take this number off our list. Any chance you know who owns the place?
```
Applies: Jev wrong_number with `wrongScope = this_property`, "wrong number", "wrong person", "I don't own that".
Must NOT fire: `wrongScope = all` or `uncertain`; escalationReason `third_party` (20 of the 72 wrong_number runs carry it, so the person may be a relative or tenant who does know the owner, which is a human call); hostile wording; inbound says they are the owner.

Candidate WN-2 (LLM-drafted, 0 human sends; no referral ask; 82 characters)
```
Sorry about that, my mistake. I'll take this number off our list. Have a good one.
```
Applies: same as WN-1 but the inbound already shows annoyance.
Must NOT fire: same as WN-1.

### 2.3 nurture  (Jev: 51 runs; only 2 at or above 0.95, 8 at or above 0.90)

Human evidence: this is where Mel spends most of her effort. Macro B (call-time ask) 385 sends, 205 got a reply (53%), resulting disposition `nurture` 184 and `none` 194. Macro C (cash-offer ask) 171 sends, 123 got a reply (72%, the highest of any macro), inbound mostly `yes` (52). Both are Library-derived.

Candidate NU-1 (human macro B, 385 sends; 85 characters)
```
Thanks for your reply. When's a good time for a quick call? Shouldn't take very long.
```
Applies: inbound shows willingness to talk ("maybe", "text is better", "sure", "depends") with no price and no distress.
Must NOT fire: inbound already includes a price, a figure or "what's your offer" (17 inbounds answered with macro B were literally "what's your offer" variants, and Mel answered with a call ask anyway); any hold rule in section 3; Jev escalationReason `hot_lead` or `call_request` (a person should call, not text back a call ask).

Candidate NU-2 (human macro C, 171 sends; the one cash-offer ask; 110 characters)
```
Would you consider a cash offer for your property? We handle everything as-is, and you'd save on realtor fees.
```
Applies: ownership already confirmed in the thread and the seller is not hostile; one cash-offer ask maximum per thread.
Must NOT fire: if a cash-offer ask has already gone out in the thread; if the property is listed or the inbound mentions an agent (the "save on realtor fees" line is wrong for listed homes); price or distress inbound.

Candidate NU-3 (LLM-drafted, 0 human sends; adapted from the Example 1 wording in `docs/prompts/ai-responder-v2.md`; 96 characters)
```
Totally understand, no pressure. Would you be open to a cash offer if the number worked for you?
```
Applies: softer variant of NU-2 for a "maybe". Must NOT fire: same as NU-2. It borrows wording from the Example 1 text in the prompt file.

### 2.4 unclear  (Jev: 39 runs; none above 0.85)

Human evidence: Jev `unclear` inbounds are things like `over where`, `where`, `owner where?`, `huh`, `i'm sorry?`. Humans then set `nurture` 13, `not_interested` 5, `wrong_number` 1 and left 20 untouched. Macro A was also used here (see 2.5), including on `who is this?` (62+28 sends), where the approved identity reply should fire instead.

Candidate UC-1 (LLM-drafted, 0 human sends; written from the approved identity wording; 122 characters)
```
Sorry, I should have been clearer. I'm Mel with BMH, a local home buyer. Are you the owner of the property I texted about?
```
Applies: confusion with no identity question and no price (identity questions use the approved identity reply).
Must NOT fire: any "who is this / who are you" wording; any hold rule; inbound that is only punctuation or an emoji (a human decides).
Evidence is weak here: 39 runs in 13 days and no human equivalent. I would not auto-fire UC-1 on this data; hold-card draft is the safer default.

### 2.5 new_lead  (Jev: 93 runs; **hold-card draft only**, per D5)

This is the most important mismatch in the data. Of 93 Jev `new_lead` runs, humans later set `nurture` on 51, `not_interested` on 1, and left 41 untouched, and **never** set a label matching `new_lead` (0 of 93). The inbounds are `yes` (16), `sure` (12), `call me` (2). In practice a "yes" is answered by macro A, then marked `nurture` (343 of 718 A sends; 358 had no disposition). Macro A is the single most-used human reply: 718 sends, 361 got a reply (50%). That is the strongest counterargument to D5's "new_lead never auto-replies" and to treating Jev's `new_lead` as a lead at all, but D5 stands unless Jarrad changes it.

Candidate NL-1 (LLM-drafted, 0 human sends; hold-card draft only; mirrors macro B's wording; 84 characters)
```
Great, thanks for confirming. When's a good time for a quick call today or tomorrow?
```
Candidate NL-2 (human macro A, 718 sends; hold-card draft only; wording tidied; 104 characters). Flag: "Have you considered selling before?" is an interest probe, not a "why" question, but it is the closest thing to a motivation question in Mel's actual usage, and ai-responder-v2.md bans motivation questions. Needs an explicit ruling (Open question 2).
```
Thank you for your reply. I'm Mel with BMH, we're local home buyers. Have you considered selling before?
```
Must NOT fire as auto-send: always. These are suggestions on the hold card only.

### 2.6 opted_out and dnc  (Jev: 6 and 2 runs)

Candidate: **no reply template.** Evidence: Mel sent a removal confirmation only 3 times in 180 days (`You're removed, sorry for the bother. Have a good one.`, 0 replies), the Library lists it under Compliance, and suppression is already immediate. Whether a compliance confirmation text is required is a legal question for Jarrad, not something this data answers.

### 2.7 price or offer ask  (Jev escalationReason price_or_offer: 23 runs; **hold-card draft only**)

Human evidence: macro F (`Honestly depends a lot on condition ... ballpark same day`) 60 sends, 26 replied (43%); it is the Library deflection. Also seen: a "company doesn't authorize approvals via text" reply (28 sends, 171 characters average, over the 160 limit) and a seller-financing counter (17 sends, which names a price direction and so is a quote in substance).

Candidate PR-1 (human macro F, 60 sends; hold-card draft only; 131 characters). Flag: "ballpark same day" is a soft promise of a number.
```
Honestly depends a lot on condition. If you give me a couple of minutes on a quick call, I can usually get you a ballpark same day.
```
Candidate PR-2 (LLM-drafted, 0 human sends; hold-card draft only; shorter, no promise of timing; 68 characters)
```
Happy to get you a real number. When's a good time for a quick call?
```

### 2.8 Intents with no candidate

Third party / "listed with an agent", multi-property, sold, deceased, divorce: **no candidate.** Reasons: the Library has templates (lines 366-370), but 0 of the 2,727 human first replies used them in volume, the call transcripts contain none of these reactions, and D5 says distress never auto-replies. Even an LLM-drafted candidate would be invention here, so none was written. The LLM-drafted candidates elsewhere (WN-2, NU-3, UC-1, NL-1, PR-2, and all hold rules H-1 to H-8) are labelled as such.

## 3. Hold rules (candidates)

Rule text below is for always going to a human, beyond the Q8 send-gate table. Counts are keyword-proxy matches on all 20,480 inbounds (Q16, regexes are crude: "worth" also matches "not worth"). `AI replied` = the legacy AI answered within 1h today, which is how often a rule would have changed live behaviour. `Human replied` = a human answered within 48h.

| Rule | Inbounds | Legacy AI replied | Human replied | Resulting dispo (3d) |
|---|---|---|---|---|
| 3.1 price/offer | 972 | 14 | 380 | nurture 240, needs_seq 106, not_int 76, none 539 |
| 3.2 distress | 34 | 0 | 7 | nurture 5, not_int 4, none 22 |
| 3.3 hostility | 571 | **73** | 38 | not_int 92, dnc/opt 23, none 438 |
| 3.4 third party | 350 | 49 | 91 | nurture 69, not_int 56, none 200 |
| 3.5 multi-property | 86 | 9 | 22 | nurture 9, not_int 10, none 62 |
| 3.6 over 200 chars | 171 | 6 | 49 | nurture 29, not_int 15, none 115 |
| 3.7 legal | 75 | 5 | 8 | dnc/opt 6, wrong 6, none 53 |
| any rule | 2,032 (9.9% of inbound) | de-duplicated; AI-replied column not computed | | |

Candidate H-1 (price or offer; LLM-drafted, keyword-proxy evidence Q16)
```
Hold for a human, and never auto-reply, any inbound that asks for, mentions or answers with a price, an offer or a dollar figure.
```
Candidate H-2 (distress; LLM-drafted, keyword-proxy evidence Q16)
```
Hold for a human, and never auto-reply, any inbound that mentions divorce, death, probate, inheritance, foreclosure, liens, bankruptcy, back taxes, eviction, serious illness or a care facility.
```
Candidate H-3 (hostility; LLM-drafted, keyword-proxy evidence Q16). The live evidence: the legacy AI answered 73 hostile inbounds. 159 sends of `So sorry to bug you. Sounds like you get a lot of these. Are you <name>? Just want to make sure we don't bother you again` went out in 180 days, including to `Fuck off`, `Spam` and an abusive reply (12-row sample, Q17). Jev also classes `fuck off` as `not_interested` (5 + 3 runs), which would auto-send NI-1 if no hold rule existed.
```
Hold for a human, and never auto-reply, any inbound that is hostile, profane or accuses us of spam or scam. Opt-out wording is handled by the existing opt-out path, not by this rule.
```
Candidate H-4 (third party; LLM-drafted, keyword-proxy evidence Q16)
```
Hold for a human, and never auto-reply, any inbound that refers to someone else deciding or acting for the owner (realtor, agent, attorney, spouse, relative, landlord, tenant, property manager, estate).
```
Candidate H-5 (multi-property; LLM-drafted, keyword-proxy evidence Q16)
```
Hold for a human, and never auto-reply, any inbound that refers to more than one property or asks which property we mean.
```
Candidate H-6 (length; LLM-drafted, keyword-proxy evidence Q16)
```
Hold for a human, and never auto-reply, any inbound longer than 200 characters.
```
Candidate H-7 (legal; LLM-drafted, keyword-proxy evidence Q16)
```
Hold for a human, and never auto-reply, any inbound that mentions an attorney, lawyer, court, code violation, TCPA, FCC, police or a threat to report us.
```
Candidate H-8 (Jev flags; LLM-drafted, keyword-proxy evidence Q16). Jev `escalationReason` counts over 13 days: hot_lead 49, call_request 27, price_or_offer 23, third_party 27, multi_property 4, distress 2, needs_review 39, uncertain 38.
```
Hold for a human, and never auto-reply, any message where Jev's escalation reason is anything other than not_applicable.
```
Note for Jarrad: H-8 overlaps H-1, H-2, H-4 and H-5 by design (belt and braces). Of 581 Jev runs, 372 (64%) are `not_applicable`; the remaining 209 (36%) would be held, so H-8 is the broadest rule and will hold many clean-looking `new_lead` and `unclear` rows.

## 4. Dispo taxonomy proposals (PROPOSAL lines only; no outcome is renamed, per the sibling outcomes session)

Windows differ from the earlier 90-day audit; numbers are 180-day (Q02-Q05).

- P1. `nurture` is a parking step: humans move `nurture` to `needs_sequence` 1,701 times, the median wait is 10.7 days (15,459 minutes), and nurture/needs_sequence together are 3,993 of 6,022 human sets (66%). Decision needed: promote automatically after the human's first touch, or merge the two (not rename). Decision needed from Jarrad.
- P2. `callback_requested`: 0 new sets in 180 days, 109 exits (103 of them to `needs_sequence`). Decision needed: retire from the picker; keep for history.
- P3. `not_interested` and `wrong_number` are confused both ways: 145 human `not_interested` to `wrong_number` corrections vs 20 the other way. Decision needed: show Jev's `wrongScope` on the card so a person sees why.
- P4. `needs_sequence` carries two jobs (active interest, follow-up later): 135 go back to `nurture`, 48 to `not_interested`. Decision needed: needs a two-way split decision.
- P5. `booked_appointment` has no automated path and is moved out 49 times (29 to nurture, 20 to needs_sequence). Decision needed: define what ends an appointment.
- P6. Jev `new_lead` has a 0% label match with humans (51 of 93 became `nurture`). Decision needed: keep Jev's label, but treat it as "hot nurture" until Jarrad rules on Open question 1.
- P7. Jev puts abusive inbounds into `not_interested`. Decision needed: a hostility flag separate from the label (feeds H-3).
- P8. Carried forward from the earlier audit, not re-measured here: 404 properties had an inbound after their last dispo.

## 5. Threshold evidence (Q07)

Agree = the human later set the same label, or made no change within 30 days. Disagree = the human set a different label within 30 days. **Caveat: "no change" is not proof anyone looked.** In prod today Jev outcomes apply at any confidence, so a silent row means the label stood, not that it was reviewed. The window is 13 days.

| Outcome | Cutoff | Runs at or above | Agree | Disagree | Agreement | Extra runs auto-applied vs 0.95 |
|---|---|---|---|---|---|---|
| not_interested | 0.95 (seeded) | 260 | 260 | 0 | 100.0% | 0 |
| | 0.90 | 269 | 269 | 0 | 100.0% | +9 (0 wrong) |
| | 0.85 | 282 | 281 | 1 | 99.6% | +22 (1 wrong) |
| | 0.80 | 290 | 289 | 1 | 99.7% | +30 (1 wrong) |
| wrong_number | 0.90 (seeded) | 48 | 48 | 0 | 100.0% | |
| | 0.85 | 54 | 54 | 0 | 100.0% | +6 vs 0.90 (0 wrong) |
| | 0.80 | 56 | 56 | 0 | 100.0% | +8 vs 0.90 (0 wrong) |
| opted_out | 0.95 (seeded) | 3 | 3 | 0 | 100.0% | n too small |
| | 0.90 / 0.85 / 0.80 | 3 / 3 / 3 | 3 | 0 | 100.0% | none; 3 more runs sit below 0.80 |
| nurture | 0.95 (seeded) | 2 | 2 | 0 | 100.0% | n too small |
| | 0.90 | 8 | 7 | 1 | 87.5% | +6 |
| | 0.85 | 10 | 9 | 1 | 90.0% | +8 |
| | 0.80 | 11 | 10 | 1 | 90.9% | +9 |
| new_lead | 0.90 (seeded) | 59 | 24 | 35 | 40.7% | |
| | 0.85 | 67 | 25 | 42 | 37.3% | |
| | 0.80 | 77 | 31 | 46 | 40.3% | |
| | 0.95 | 48 | 21 | 27 | 43.8% | |
| unclear | any | 2 at 0.80+ | 1 | 1 | n too small | |
| dnc | any | 2 | 2 | 0 | n too small | |

Unfiltered (all confidences): not_interested 316 of 318 agree (99.4%), wrong_number 72 of 72, opted_out 6 of 6, nurture 47 of 51 (92.2%: 17 same label, 30 untouched, 4 different).

Legacy path as a cross-check (Q05, no confidence stored): since 2026-08-28, 1,025 AI dispositions were human-confirmed and 39 were changed by a human (96.3%); not_interested 682 vs 27 changed (96.2%), wrong_number 293 vs 10 (96.7%), opted_out 40 vs 2 (95.2%), dnc 10 vs 0. 19 more were replaced by a newer AI decision, which is not a human correction.

Reading it plainly: lowering `not_interested` to 0.90 adds 9 auto-applies with no disagreement; going to 0.85 or 0.80 adds 22 to 30 and one miss. `wrong_number` at 0.85 or 0.80 shows no disagreement across 8 extra rows. `nurture` and `opted_out` have too few runs to say anything. `new_lead` is the real problem and it is not a threshold problem: agreement stays near 40% at every cutoff because the human label is almost never `new_lead`.

## 6. Open questions for Jarrad

1. Humans treat Jev's `new_lead` as `nurture` (51 of 93) and answer a "yes" with macro A. Do you want `new_lead` kept as a hold, or mapped to a nurture-style reply path? (This is the strongest case against D5 as written.)
2. Macro A ("Have you considered selling before?") is Mel's most-used reply (718 sends, 50% reply-back). Does it count as a banned motivation question? If yes, NL-2 is out and NL-1 is the only new_lead draft.
3. Note: NI-1 asks a question after a "no" ("mind if I check back?"); NI-2 has no question. Each is approved or rejected on its own in the Templates library.
4. Note: NU-2 includes the claim "you'd save on realtor fees", which is wrong for listed homes (see its Must NOT fire list).
5. Note: PR-1 says "a ballpark same day", a soft promise of a number; PR-2 makes no timing promise. Both are hold-card drafts only.
6. H-3: should hostile wording also trigger suppression, as an opt-out would? Today it only silences the auto-reply. (Your call; the data shows 23 hostile inbounds ended in dnc/opted_out.)
7. Should opted_out/dnc send any confirmation text, or stay silent? (Legal question, not answerable from data.)
8. Do you want `reply_intent` built at all? Jev currently emits only an outcome and an escalation reason. If yes, the intent list is itself a rule set needing approval.
9. Note: section 5 shows no disagreement at `not_interested` 0.90 and `wrong_number` 0.85, against seeded 0.95 and 0.90. Only 13 days of data; no threshold is changed by this document.
10. More Mel evidence would help: call recordings of price, agent, hostile and "who is this" reactions are absent from all 9 transcripts.
