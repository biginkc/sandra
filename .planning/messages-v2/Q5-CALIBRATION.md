# Q5 calibration: Jev auto-apply thresholds from data

Status: PROPOSAL ONLY. Nothing here is approved. PLAN.md is not edited. Every line in "Proposed replacement" needs Jarrad's verbatim approval, one rule at a time, before it goes anywhere.
Data: prod `copflsklaefwzipsrjqz`, SELECT only, run 2026-10-07.

## 1. How Closer Lab set its thresholds (summary)

- Frozen grader and frozen owner text (sha256-pinned) before any real-call run. Accept 0.9 and release 0.5 were fixed first and not tuned on the real 30 calls ("no tuning on the 30 real calls or the holdout", GRADER-FREEZE-2026-09-25).
- Truth = the owner's own rulings (rounds 1-6, REVIEW-BATCH answers, 100-ruling audit), then a blind judging pass on real calls.
- Agreement was measured against those rulings, then threshold sweeps were run on the labelled set. `JEV_REVIEW_BAND_THRESHOLDS`: present at p >= 0.5; p in [0.4, 0.6] goes to a human regardless of side.
- The honest result: on 70 blind-judged real lines the frozen grader agreed 71% (caught 8 of 26 owner-flagged, 8 invented). Sweeping 0.5 to 0.9 did not fix it; misses were disagreements with the written rule, not threshold noise (probe wobble only 0.01-0.06). Lesson for Sandra: a threshold cannot repair a label disagreement, and calibration on easy or weak labels overstates real accuracy.
- I found no separate latency-probe file in `.planning/pr-e/`; the docs-shape probe (REAL-30-FIRST-READ) is the nearest equivalent.

## 2. Sandra data and its weakness

Source: `sms_classification_runs.decision` (`outcome`, `outcomeConfidence` = native confidence, `probabilities`). Jev has run only since 2026-09-24. 581 runs; 504 are older than 72h and are the only ones used (younger ones have not had time to be corrected).

Truth proxy per run: the first `lead_events` `dispo_set` with `actor_type='user'` on the same property within 72h after the run, and before the next Jev run on that property.
- Explicit correction (human set a different label) = DISAGREE.
- No human change within 72h = WEAK AGREE. It does not prove anyone looked: prod today auto-applies Jev outcomes at any confidence, so a silent row only means the label stood.
- Human set the same label = strong agree.
- `ai_disposition_reviews` joined to runs holds 365 rows, all `auto_accepted`, same label, none superseded or corrected. It adds no disagreement signal. Human corrections therefore come only from `lead_events`.
- Agreement = (weak + strong) / n. Strong agreement is rare (nurture 12, all other outcomes 0), so for not_interested and wrong_number the 100% figures are weak agreement only.

Reuses the Phase 2 Q07 approach (RULES-PROPOSAL section 5, `scripts/messages-v2/mine-rules.sql`) with two changes: 72h window instead of 30 days, and the window ends at the next run on the same property so one human edit is not credited to two runs. Numbers therefore differ slightly from section 5 (for example nurture at or above 0.90: 6 here vs 8 there).

## 3. Method applied

Bins of 0.05 on `outcomeConfidence`, per outcome. Closer Lab picked a fixed accept point and a band around the decision. Here:
1. Candidate threshold t = a bin edge. Trailing agreement = agreement over all runs with confidence >= t.
2. Suggested threshold = lowest t where trailing agreement >= 95% and trailing n >= 30.
3. Added guard (mine, not Closer Lab's): scan down only through contiguous occupied bins, and stop at any bin whose own agreement is below 95%. Without it the "lowest threshold" slides to 0.20-0.45, because weak labels make every low bin look fine. That is the failure Closer Lab's real-30 read exposed.
4. Review band = the 0.10 below the threshold, `[t - 0.10, t)`, same 0.1 half-width as Closer Lab's 0.4-0.6. Held rows in the band go to a human; rows below the band stay held in the normal inbox. The data cannot place the band (low bins look "fine" only because they were never reviewed), so its width is a design choice, not a measurement.
5. Fewer than 30 trailing samples after the guard = "insufficient, keep held".

## 4. Result

Per-bin counts (n / human-different) for the outcomes that matter, top down:

- not_interested: 1.00: 204/0, 0.95: 37/0, 0.90: 8/0, 0.85: 10/1, 0.80: 5/0, then 25 spread below with 0 different. Total 285, 1 different.
- wrong_number: 1.00: 24/0, 0.95: 12/0, 0.90: 5/0, 0.85: 4/0, 0.80: empty, then 12 below, 0 different. Total 57, 0 different.
- nurture: 0.95: 1/0, 0.90: 5/0, 0.85: 2/0, 0.80: empty, 0.75: 3, 0.70: 4, 0.65: 2, 0.55-0.50: 14 (2 different), 0.45-0.25: 10. Total 43, 2 different.
- opted_out: 5 runs (two at 1.00). dnc: 2 runs. unclear: 27 runs, 14 relabelled (48% agree).
- new_lead: 85 runs, 50 relabelled by a human (all to nurture except 1), 0 same label.

| outcome | n | suggested threshold | review band | agreement at suggestion | at 0.90 | at 0.95 | note |
|---|---|---|---|---|---|---|---|
| not_interested | 285 | 0.90 | [0.80, 0.90) | 249/249 = 100% | 100% (249) | 100% (241) | Mechanical "lowest" would be 0.20 (284/285 = 99.6%); guard stops at 0.90 because the 0.85 bin is 9/10. All weak agreement. 0.90 equals today's data-supported floor, 0.95 buys nothing (+8 rows, 0 errors). |
| wrong_number | 57 | 0.85 | [0.75, 0.85) | 45/45 = 100% | 100% (41) | 100% (36) | Zero corrections ever, but zero strong agreement too. 0.85 admits only 4 more runs than 0.90. Wilson 95% lower bound at n=45 is only about 92%, so "100%" is thinner than it looks. |
| nurture | 43 | insufficient, keep held | n/a | 8/8 at >= 0.85 (n < 30) | 6/6 (n=6) | 1/1 (n=1) | Next bin (0.80) is empty. Going low enough to reach 30 gives 0.40 at 95.2%, which is noise. |
| opted_out | 5 | insufficient, keep held | n/a | n/a | 2/2 | 2/2 | n=5 total. Q6 already suppresses the phone at any confidence; only the disposition write waits. |
| new_lead | 85 | none (never reaches 95%) | all held | n/a | 21/56 = 37.5% | 18/45 = 40.0% | 50 of 85 relabelled (prod-wide earlier count 51/93). Agreement is flat near 40% at every cut. Not a threshold problem; keep off. |
| unclear | 27 | n/a | n/a | n/a | n/a | n/a | Not an auto-apply outcome; 48% agreement. Informational. |
| dnc | 2 | insufficient | n/a | n/a | n/a | n/a | n=2. |

## 5. Caveats

- 13 days of Jev data, one operator team, mostly easy not_interested replies (204 of 285 are at 1.00). The result says "no evidence of harm", not "proven accurate".
- Weak agreement dominates. A reviewer who never opened the thread looks identical to a correct label. If no one is reviewing, the real error rate is unmeasured.
- The wrong direction is also unmeasured: a not_interested that should have been nurture and was never touched.
- Closer Lab's own real-call check (71% vs the clean-exam figures) shows calibrated thresholds degrade on real data. Re-run this query after 30+ days and after the review UI produces explicit confirm/correct events; those are the labels this method actually needs.
- Moving to a threshold is a tightening versus origin/main (any confidence), so holds increase regardless of the numbers above.
- Zero data supports 0.95 over 0.90 for not_interested, or any threshold for nurture/opted_out.

## 6. Proposed replacement for PLAN section 8 Q5 (needs verbatim approval, one rule at a time)

- `not_interested: auto-apply at native confidence ≥ 0.90`
- `wrong_number: auto-apply at native confidence ≥ 0.85`
- `nurture: hold for human review (insufficient data to set an auto-apply threshold)`
- `opted_out: hold for human review (insufficient data to set an auto-apply threshold)`
- `new_lead: hold for human review (agreement 41%; never auto-applies)`
- `automation_enabled: not_interested=on, wrong_number=on, nurture=off, opted_out=off, new_lead=off`

Notes for Jarrad: `new_lead=off` is unchanged from prod. `nurture=off` and `opted_out=off` are NEW restrictions versus prod today (both auto-apply now); this is what "insufficient, keep held" means in practice. If you would rather keep them on, the old 0.95 lines are the fallback but have no data behind them. The 0.85 vs 0.90 choice for wrong_number is a judgement call; the method gives 0.85, 0.90 is equally supported.
