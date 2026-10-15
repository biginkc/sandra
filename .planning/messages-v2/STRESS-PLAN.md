# Messages v2 Stage 5: stress test plan

Date: 2026-10-15. Designed by Fable (architect). Executed by Codex, autonomously, after PR 4 merges and before the Fable + Astra release-candidate review (REDESIGN-PLAN.md, "Stage 5"). Results go in `.planning/messages-v2/STRESS-RESULTS.md`.

Rule (Jarrad, memory `stress-test-means-volume`): volume, not a handful of checks. Every run below reports a failure RATE over hundreds of runs. Cost is estimated first and stopped at a spend gate before anything paid runs.

Budget: $100 total. Estimated spend for the whole stage as recommended below: Jev about $1, canary SMS about $8 to $20, alert texts about $1. Everything else is free (disposable stack, stub provider).

## What touches what

| Lane | Where it runs | Writes to production? | Sends a real text? |
|---|---|---|---|
| Disposable (D) | throwaway local Supabase stack (`e2e/stress/provision-stack.mjs`, fresh ports; never 54321/54322/54329/54331), mock SMS provider, Jev stub or live Jev | no | no |
| Production canary (P) | the production app and database, canary org only, canary-owned numbers only, every row tagged | yes, canary org only | yes, owned-to-owned only (Sandra's canary senders to canary numbers; alerts to Jarrad's phone) |

Order: every run is done on D first. P runs start only when the D run of the same item is green, and each P run has its own approval line below. If a D run is red, fix and re-run D; nothing goes to P.

Hard rules carried into every lane: Inbox/Messages v2 only; no new bulk AI; no text to a non-owned number; no production activation of anything that is off today; an uncertain send is never blind-retried; nothing is deleted in production except rows the harness itself created and tagged.

## Run 1: decision-accuracy replay (30 days of real texts)

- Harness: `npm run replay:nine -- --db-url <source> --days 30 --sample 30 --repeats 3` (`scripts/messages-v2/replay/nine.ts`). Read-only transaction on the source database, always rolled back; only network target is api.typesafe.ai; request ceiling computed from the real count before any paid call.
- Source: a read replica or a dump of production restored into the D stack. Reading production directly inside `begin transaction read only` is also acceptable (no write is possible) but counts as a production read: say so in the results.
- Volume: about 5,700 inbound texts (last run 5,651 + 90 flip samples).
- Cost: 5,741 requests x 1,500 tokens x $0.042/1M = $0.36.
- Gates (REDESIGN-PLAN Stage 5): agreement per question reported; the full disagreement list attached for Jarrad; no question below the not_interested baseline (94%) without Jarrad's sign-off.
- Lane: D (or read-only production read). Approval: Jev spend (A1).

Standing finding (must be in front of Jarrad before Stage 5 starts): the replay already on the PR 3 branch (`.planning/messages-v2/REPLAY-NINE-QUESTIONS.md`, 2026-10-15) shows overall agreement 69.0%, not_interested recall 72.0% (precision 93.6%), nurture recall 3.0%, new_lead recall 50.0%, with 1,052 disagreements. By the Stage 5 gate as written, this run is already red. Stage 5 cannot turn it green; only a rules decision by Jarrad can (accept the numbers, change the gate, or change the questions, which needs verbatim approval). Do not spend the rest of the stage's budget until he has answered.

## Run 2: wording variants (30 scenarios x 10 wordings x 3 repeats)

- Corpus: `scripts/messages-v2/stress/corpus.json` (data). 30 seller situations including every tie-breaker in the plan: stop + price, lawyer + price, identity + price, "$150k", maybe-later + offer, hostile + price, unclear + price, hostile-but-not-stop, price-with-refusal, "Anytime"/"noon is best", "yes" to a still-own opener, "yes" to an offer opener, slang, typos, long, responder off. Expected answer set and expected bucket per scenario follow the precedence in code (see `_expected_rule` in the file): up-front non-price keyword hold > hostile (wording or answer) > asked_stop > wrong_person > hot (talked_price / open_to_selling, or any lower answer yielding to a price keyword) > maybe_later > not_interested > asked_who > confirmed_owner > needs_person; responder off = nothing.
- Two lanes, same corpus, same arithmetic (`scripts/messages-v2/stress/core.ts`):
  - Classifier lane, no database: `npm run stress:messages-v2 -- --classifier live --repeats 3`. 870 requests. Bucket is predicted by a mirror of dispatch precedence built from the product's own pure helpers.
  - Dispatch lane, authoritative: `npm run stress:messages-v2:db` with `MV2_STRESS_JEV=live` on the D stack. 900 fresh leads, the REAL `dispatchAiResponse` with the nine-question engine on, new_lead switch on, approved replies and Jarrad's four drips seeded, mock provider. Bucket is read back from the outcome and the rows. Also proves: at most one classification per inbound, no outbound body other than the approved texts, responder-off property touched nothing.
- Volume: 900 runs per lane.
- Cost: 870 to 900 requests x 1,500 tokens x $0.042/1M = $0.06 per lane; $0.12 for both. (Repeats can go to 5 for $0.20 total; the gate stays at 3.)
- Gates per scenario: flip rate (same text, different answer across the 3 repeats) under 2% of wordings; wrong-bucket rate under 5% of runs; zero failed runs. Known-gap and review scenarios (below) are reported, not gated.
- Lane: D only. There is no production version of this run. Approval: Jev spend (A1).
- Dry run done 2026-10-15 with the stub classifier (no paid call): 870 runs, 0 flips, 0 wrong buckets, 25/25 gated scenarios pass (`npm run stress:messages-v2 -- --classifier stub`). With `--noise 0.08` the same harness reports 14.8% flips and 2.9% wrong buckets and fails 16 scenarios, so the arithmetic catches what it is meant to catch. Dispatch lane dry run the same day on a throwaway stack (ports 55631/55630, stub Jev, real dispatchAiResponse, 900 fresh leads, 14.5 minutes): 0 flips, 0.3% wrong bucket, 25 of 26 gated scenarios pass; the one red is `responder_off` (finding 4 below), a product result, not a harness defect.

Scenarios reported but not gated until Jarrad answers (business decisions, not engineering):
- `price_with_refusal` ("$5M take it or leave it"): Jarrad 2026-10-03 sided with Jev keeping these in Stop texting; the engine routes a talked_price answer hot. One bucket, please.
- `not_interested_plus_price` ("No thanks, not interested in an offer"): by code every not_interested answer yields to a price keyword, so this lands on Jarrad's My Leads with a Slack and a text. Confirm or change.
- `sold_already` ("I sold it last year"): no answer covers "sold"; by code wrong_person sends the wrong-number reply and closes. Pick the bucket.
- `gave_time_to_call` ("Anytime", "noon is best"): known gap. Jarrad 2026-10-14 said these belong under Wants an offer with no new question; today they land in needs_person (replay rows 9, 31, 32, 37). The run reports how many of the 30 land hot vs needs_person.

## Run 3: burst (300 inbound texts in 10 minutes)

- Mechanism: inbound texts are injected through the Sendillo inbound webhook with a valid signature (no carrier involved for the inbound leg). D: `npm run replay:server` + `npm run replay:run` pattern (stubbed Sandra server, handshake proves SMS_PROVIDER_STUB=1 and no provider key). P: the same signed webhook against the production URL, canary org, canary properties and canary numbers only, every property address prefixed `STRESS <run-id>`.
- Mix: the 300 texts are drawn from the Run 2 corpus so every bucket appears (about 40% hot-shaped, 20% stop/hostile, 40% the rest).
- Measures (each a rate over 300 x 3 = 900 texts): texts with exactly one pipeline run (gate 100%); duplicate seller replies (gate 0); reply delay inside 2 to 6 minutes (gate 100% of sent replies); tape card visible within 5 s of the inbound via realtime (gate 99%+, measured by Playwright polling the page); "Waiting for a person" count equal to the DB count at the end (gate exact); 5xx responses (gate 0); hydration errors in the console (gate 0).
- Volume: 3 repeats.
- Cost: D is free. P: Sandra's approved replies to canary numbers (about 60% of 300 texts get a reply) at roughly $0.02 per segment, assume $0.03 with two-segment bodies: about $6 per burst, $18 for three. Verify the per-segment price on the Sendillo invoice before the run. Hot alerts during the burst are counted under Run 5.
- Recommendation: 3 bursts on D, then 1 burst on P (about $6) ⭐ because the duplicate/ordering races are the same on both and the P burst is only there to prove the real provider path and realtime on the real URL. 3 bursts on P (about $18) is the plan's literal reading and is also within budget; Jarrad picks.
- Lane: D then P. Approval: P burst = production writes on the canary org + canary SMS spend (A2).

## Run 4: UI load (5,000 open holds, 2,000 runs in one day)

- Seed: a SQL seeder on the canary org (D first, then P) that writes 5,000 flagged properties with hold reasons spread across the real reason set and 2,000 pipeline runs with steps, all tagged, all dated inside one day.
- Measures: first paint of `/messages-v2` under 3 s (Playwright trace, 5 loads, report the median and the worst); "Show older" and "Show yesterday's tape" page to the end with no gaps and no duplicates (compare the union of pages against the DB counts: gate exact); memory stable over 30 minutes with realtime on (Chrome DevTools heap snapshot at 0, 15, 30 minutes: gate under 20% growth after the first minute).
- Volume: 5 cold loads + 3 full paging passes + 1 thirty-minute soak, per lane.
- Cost: free. No texts, no Jev.
- Lane: D then P. Approval: P seed = 7,000 production rows on the canary org (A4). The canary org must be a different org id from BMH's; the seeder refuses otherwise.

## Run 5: alert fan-out (50 hot sellers in 5 minutes)

- Mechanism: 50 hot-shaped inbound texts (from the Run 2 hot scenarios) on 50 fresh canary leads inside 5 minutes, then the hold-alert cron on its normal schedule for the next 6 hours.
- Measures: exactly one Slack DM and one SMS to Jarrad per hot seller (gate 50/50, zero duplicates, checked in `hold_alert_deliveries`); caps respected: never more than 20 DMs per recipient per hour and 10 SMS per hour (`src/lib/hold-alerts/core.ts` MAX_DMS_PER_RECIPIENT_PER_HOUR / MAX_SMS_PER_HOUR), so the 50 SMS drain over about 5 hours and nothing is lost; nothing for non-hot holds (gate 0 deliveries for the 50 non-hot texts sent alongside); zero duplicate sends when the cron is run twice back to back and when a delivery is retried after a forced provider error. On D the senders are recorded in-process exactly as `hot-acceptance-matrix.db.integration.test.ts` does; on P the real Slack and SMS channels are used.
- Volume: 100 texts (50 hot + 50 not), 1 pass on D with the cron run every minute, 1 pass on P.
- Cost: D free. P: up to 50 SMS to Jarrad's phone (about $1) plus 50 Slack DMs (free). Jarrad's phone will buzz 10 times an hour for 5 hours; he should know the day.
- Lane: D then P. Approval: P = 50 canary leads assigned to Jarrad on My Leads (production writes), 50 texts to his phone (A3).

## Run 6: kill switches mid-burst

- Mechanism: during a Run 3 burst, flip each rule switch off through the owner-only RPC the rules panel uses (one switch per question, PR 4), and separately set `outbound_mode = 'hold'`; restore each after 2 minutes.
- Measures: after a switch is off, the next text of that shape produces a hold instead of an action (gate: within one text, i.e. zero actions taken after the flip is committed); with outbound_mode=hold, zero sends (gate 0 messages leave `pending`); after restore, held texts are not double-sent (gate 0 duplicates) and new texts resume (gate 100% of the next 20 handled).
- Volume: 9 switches + outbound_mode, each flipped once per burst, over 3 D bursts (30 flips) and the P burst (10 flips).
- Cost: inside Run 3.
- Lane: D then P. Approval: P flips are production config writes on the canary org's `ai_responder_configs` and `jev_outcome_thresholds` rows only (A4). The script refuses any org id other than the canary org.

## Run 7: cleanup proof

- Before anything runs on P: snapshot counts per non-canary org of properties, contacts, messages, sequence_enrollments, leads (properties with status lead / assigned), hold_alert_deliveries, sms_classification_runs, pipeline_runs. Save with a hash.
- After all P runs: delete every row tagged with the run id (canary org only), then re-snapshot. Gate: every non-canary count identical, and zero rows with the run tag remain. Attach both snapshots to STRESS-RESULTS.md.
- Lane: P (D stacks are destroyed with `provision-stack.mjs --stop`). Approval: production deletes of harness-tagged canary rows (A5). The cleanup script refuses to delete any row without the tag or outside the canary org.

## Cost summary

| Run | Jev | SMS | Other | Total |
|---|---|---|---|---|
| 1 replay | $0.36 | 0 | 0 | $0.36 |
| 2 wording matrix (both lanes) | $0.12 | 0 | 0 | $0.12 |
| 3 burst, 3x D + 1x P (⭐) | 0 | about $6 | 0 | about $6 |
| 3 burst, 3x D + 3x P (alternative) | 0 | about $18 | 0 | about $18 |
| 4 UI load | 0 | 0 | 0 | 0 |
| 5 alert fan-out, P | 0 | about $1 | 0 | about $1 |
| 6 kill switches | inside 3 | inside 3 | 0 | 0 |
| 7 cleanup | 0 | 0 | 0 | 0 |
| Re-runs after fixes (allow 2x of runs 1 and 2) | $1.00 | 0 | 0 | $1.00 |
| Total (⭐ path) | about $1.50 | about $7 | 0 | under $10 of the $100 |

Hard stops in code: replay cap $30 and a request ceiling equal to the real count; wording matrix `--max-usd` (default $1) and a request ceiling equal to the run count. No harness can exceed its estimate.

## Approvals needed (nothing below runs until the line is answered)

- A1 (root or Jarrad): Jev spend for Runs 1 and 2, about $0.50, up to $1.50 with re-runs.
- A2 (Jarrad): production canary burst: signed inbound webhooks to the production URL for the canary org, Sandra's approved replies to canary-owned numbers, about $6 (1 burst) or $18 (3 bursts).
- A3 (Jarrad): alert fan-out on production: 50 canary leads handed to Jarrad on My Leads, 50 Slack DMs and up to 50 texts to his phone over about 5 hours, about $1.
- A4 (Jarrad): production writes on the canary org only: 5,000 holds + 2,000 runs seeded; rule switches and outbound_mode flipped on the canary org's config rows during the P burst.
- A5 (Jarrad): production deletes of harness-tagged canary rows at the end (Run 7).
- A6 (Jarrad, rules): the four bucket decisions listed under Run 2 (price-with-refusal, not-interested + offer word, sold, gave-a-time). Any wording change to a question or reply needs the exact text approved in a fenced block, one per approval; no model writes it.
- A7 (Jarrad, gate): Run 1 is already below the 94% gate on the branch. Accept, re-gate, or change rules before Stage 5 proceeds.

No approval is needed for: provisioning and destroying D stacks, every D-lane run with the stub classifier, reading this repo, writing STRESS-RESULTS.md.

## Harness files on this branch

- `scripts/messages-v2/stress/corpus.json`: the 30 x 10 corpus (data).
- `scripts/messages-v2/stress/corpus.ts`: loader and validation (exactly 10 distinct wordings per scenario, known answers and buckets, a second accepted bucket requires a review note).
- `scripts/messages-v2/stress/core.ts`: buckets, dispatch-precedence mirror (built from the product's own pure helpers), stub classifier, flip and wrong-bucket statistics, cost, environment guard (explicit bindings, loopback, never the dev-stack ports, no hosted refs, no provider credential, MV2_STRESS_DISPOSABLE_DB=1), report.
- `scripts/messages-v2/stress/cli.ts`: classifier lane (`npm run stress:messages-v2`).
- `scripts/messages-v2/stress/dispatch.stress.integration.test.ts` + `vitest.messages-v2-stress.config.ts`: dispatch lane (`npm run stress:messages-v2:db`).
- `scripts/messages-v2/stress/core.test.ts`: unit tests, including "no question text appears in the corpus" and "the mirror agrees with every gated scenario's expected bucket".
- Runs 3 to 7 reuse what exists: `scripts/messages-v2/replay/{server,run,seed}.ts` for webhook-driven bursts, `e2e/stress/provision-stack.mjs` for the stack, the sender-recording pattern of `src/lib/hot-sellers/hot-acceptance-matrix.db.integration.test.ts` for alert counting, Playwright for paint, paging and realtime. Their burst/seed/cleanup scripts are Codex's to write at Stage 5 time, under the lane rules above; they are not on this branch.

## Findings for the PR 2 / PR 3 reviewers (surfaced while designing; not fixed here)

1. Lawyer + price without a dollar amount: `matchEscalationKeyword` picks the LONGEST matching phrase, so "Send any offer to my lawyer" is a legal hold (no alert) while "Offer goes to legal, not me" is a price hold (alert). Whether Jarrad is pinged depends on word length. With a dollar amount the price regex wins every time. The corpus uses amounts for this scenario so the gate is stable; the inconsistency itself is a product question.
2. Any not_interested, maybe_later, asked_who, confirmed_owner or needs_person answer yields to a price keyword (`NINE_YIELDS_TO_HOT`, dispatch.ts). "No thanks, not interested in an offer" therefore becomes a hot hand-off. Deliberate per PR 2, but Jarrad should see the volume: in the 30-day replay, 33 of 1,738 human not_interested texts were read as talked_price.
3. "Sold" has no bucket; wrong_person closes it with the wrong-number reply.
4. Responder off is not silent. Found by the dispatch lane on the throwaway stack (2026-10-15, stub Jev, `MV2_STRESS_ONLY=...,responder_off`): with `properties.ai_responder_disabled = true` the step-2 keyword gate in dispatch.ts still runs ("Keyword gate (runs even without a config so we surface the right signal on lead detail regardless)"), so "Talk to my lawyer" on a human-takeover lead writes a `keyword:legal_contract` hold and the lead reappears in "Waiting for a person". Jev is never called (that part is right, acceptance row "held lead under human takeover"), but the plan's rule "responder off: no hold, no alert" is false for keyword texts. 3 of 30 responder_off runs landed in `keyword_hold`; the scenario is gated and stays red until PR 2/PR 3 decide whether that hold is wanted.
