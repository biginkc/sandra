# Inbound persist burst: A/B/C/D (local 55329 sandbox only)

Same machine, same seed (50k properties / 250k messages), two independent runs (r1, r2; 4 reps each, state order rotated per rep). **A** = filter-cache
migrations reverted (origin/main before 1088ac0c). **B** = 20261002110000 + 110050 (cache triggers, full refresh on every insert). **C** = B + 110055 variant C
(share-lock skip when flags already cover the row). **D** = B + 110055 variant D (incremental guarded UPDATE for INSERTs; full refresh kept for anything that can clear).
Workload (`scripts/filter-volume/inbox-burst.mjs`): the `insertInboundMessage` path of `src/lib/messaging/inbound.ts` as one transaction per message (dedupe lookup, `messages`
insert with thread minted by trigger, `message_threads` AI-state clear). Not included: `sms_inbound_intents`/`webhook_events` writes, the PostgREST hop. Laptop + Docker disk,
pool of 70, so read the deltas and the r1-vs-r2 noise band. Cells are p50 / p99 in ms (4 reps pooled per run). No errors or deadlocks in any run.

| burst | state | r1 p50 / p99 | r2 p50 / p99 |
|---|---|---|---|
| 50 concurrent, SAME property | A | 160.6 / 450.6 | 177.6 / 415.5 |
| 50 concurrent, SAME property | B | 294.5 / 672.6 | 311.2 / 552.6 |
| 50 concurrent, SAME property | C | 226.7 / 582.1 | 262.6 / 466.7 |
| 50 concurrent, SAME property | D | 213.4 / 363.4 | 237.5 / 426.5 |
| 50 concurrent, 50 different properties | A | 27 / 69.9 | 26 / 42.9 |
| 50 concurrent, 50 different properties | B | 90.8 / 149.7 | 105.1 / 152.4 |
| 50 concurrent, 50 different properties | C | 112.2 / 193.3 | 173.3 / 311.6 |
| 50 concurrent, 50 different properties | D | 69 / 98.4 | 74.9 / 126.9 |
| 200 msgs / 10 s, 20% same property | A | 9.4 / 33.9 | 5.5 / 25.1 |
| 200 msgs / 10 s, 20% same property | B | 12.3 / 35.3 | 7.9 / 23.2 |
| 200 msgs / 10 s, 20% same property | C | 12.1 / 31.2 | 8.1 / 25.4 |
| 200 msgs / 10 s, 20% same property | D | 10.4 / 28 | 6.6 / 23 |

## Decision: D
D has the lowest p99 of B/C/D in both runs on every burst and the lowest p50 on the first-reply (distinct-property) case: diff50 p99 B 150/152, C 193/312, **D 98/127**
(A 70/43); same50 p99 B 673/553, C 582/467, **D 363/427** (A 451/416, noise band about +-100). C was worse than B on diff50 because it adds a lock phase without removing the
refresh work for first-reply rows; D replaces the 7-lookup recompute with one indexed guarded UPDATE. D is still above A on p50 (inherent: a denormalised cache must update
the property row on the first reply, and the global-DNC shared barrier and row lock remain).

## Correctness of D (migration 20261002110055)
Monotonic OR-only flag updates computed from the new rows (never from a snapshot read); order = shared global-DNC barrier -> row locks. (a) guarded UPDATE, (b) SHARE lock rows that look
covered, (c) guarded UPDATE re-applied under a fresh snapshot. Lists/tags: unguarded sorted-deduplicated merge + count (unique (property_id, list_id|tag_id) makes it identical to the
full refresh). Clearing changes keep the full refresh. Tests: trigger suite 18/18 (+33 total local) incl. both-orders clearer-vs-inserter race and a randomised 6-worker concurrent
workload with cache == truth afterwards; mutation check: removing the SHARE lock makes the race test fail. 45-case fixture exact; volume gate 22 cases, 0 count mismatches, worst
valid-baseline ratio 1.22; 5 cold lock-probe runs of the migration: 5/5 clean, 0 errors, max blocked ~1.0 s.
Residual: (c) can upgrade share -> no-key-update, which can theoretically deadlock with another upgrader on the same property (retryable 40P01).


# Round 3: variant E (HOT-friendly flips) vs A / B / D

E = D + (1) dropped the four boolean partial indexes (flag flips become HOT-eligible) and `fillfactor = 90`, (2) cheaper `properties_filter_cache_only_change`
(plpgsql row copy compare, jsonb/catalog path only as fallback), (3) `order by id for no key update` before incremental updates and list/tag merges, (4) writer GUC
restored to its prior value. Two independent runs (e1, e2; 4 reps each, rotated order), same machine and seed. Cells: p50 / p99 ms. Zero errors and zero clearer errors in every run.

| burst | state | e1 p50 / p99 | e2 p50 / p99 |
|---|---|---|---|
| 50 concurrent, SAME property | A | 130.1 / 227.5 | 155.7 / 247.1 |
| 50 concurrent, SAME property | B | 340.3 / 613.9 | 282.9 / 524.9 |
| 50 concurrent, SAME property | D | 227.4 / 438.7 | 290.8 / 549 |
| 50 concurrent, SAME property | E | 223.1 / 388.8 | 255.5 / 486.8 |
| 50 concurrent, 50 distinct properties | A | 22.2 / 30.5 | 23.1 / 31.7 |
| 50 concurrent, 50 distinct properties | B | 122.6 / 286.9 | 109.2 / 237.2 |
| 50 concurrent, 50 distinct properties | D | 72.7 / 139.7 | 101.1 / 150.9 |
| 50 concurrent, 50 distinct properties | E | 54.5 / 74.8 | 51 / 76.7 |
| 10 concurrent, distinct properties | A | 5.2 / 10.2 | 5.4 / 6.8 |
| 10 concurrent, distinct properties | B | 19.2 / 39.9 | 18.7 / 31.6 |
| 10 concurrent, distinct properties | D | 12.9 / 16.9 | 12.9 / 25 |
| 10 concurrent, distinct properties | E | 6.4 / 7.5 | 6.7 / 8.4 |
| 200 msgs / 10 s, 20% same property | A | 10 / 24.1 | 10.7 / 30.2 |
| 200 msgs / 10 s, 20% same property | B | 9.6 / 29.9 | 12.4 / 31.6 |
| 200 msgs / 10 s, 20% same property | D | 11.1 / 31.3 | 11.3 / 53.8 |
| 200 msgs / 10 s, 20% same property | E | 7.9 / 22.2 | 10 / 25.3 |
| mixed200 + concurrent clearers (read / delete) on the hot property | A | 7.7 / 27.5 | 9.7 / 24.1 |
| mixed200 + concurrent clearers (read / delete) on the hot property | B | 11.6 / 29.1 | 10.6 / 29.7 |
| mixed200 + concurrent clearers (read / delete) on the hot property | D | 11 / 57.5 | 8 / 29.3 |
| mixed200 + concurrent clearers (read / delete) on the hot property | E | 7.4 / 21.1 | 9.3 / 26.6 |

## Acceptance (recorded, not relaxed)
* 10-way distinct, absolute p99 <= 50 ms: **met** (E 7.5 / 8.4 ms; A 10.2 / 6.8).
* E p99 - A p99 <= 10 ms at 50-way distinct: **NOT met** (E 75 / 77 vs A 31 / 32: +44 / +45 ms; D was +109 / +119, B +256 / +206).
* E p99 - A p99 <= 10 ms at 50-way same property: **NOT met** (E 389 / 487 vs A 228 / 247: +161 / +240 ms; D +211 / +302, B +386 / +278; noise band ~+-100).
* Insert-vs-clear mixed burst (`clearmix`) and `mixed200`: E equals A within noise (p99 21 / 27 vs 28 / 24; 22 / 25 vs 24 / 30).
Remaining cost at 50-way: one properties UPDATE per first reply (row lock + tuple write) and the shared global-DNC barrier; same-property bursts additionally serialise on the property row
lock and the thread row (A is already ~230 ms p99 there). fillfactor only affects NEW pages, so already-full existing pages still produce non-HOT updates until vacuumed.

## Gates without the boolean indexes
Volume gate (Search + filter): 22 cases, 0 count mismatches, 0 over budget, worst valid-baseline ratio 1.34, slowest new p95 98 ms; no index had to be kept. Trigger suite + 45-case +
generated-column regression: 33/33 (incl. insert-vs-clear race and randomised concurrent workload). 5 cold lock-probe runs: 5/5 clean, max blocked ~1.2 s (110055 takes ACCESS EXCLUSIVE on
properties briefly for the index drops).

## Does the inbound persist path retry on 40P01?
No in-process retry. `insertInboundMessage` (`src/lib/messaging/inbound.ts`) returns the Postgres error; the webhook route marks the event as errored
(`markWebhookEventError`) and answers HTTP 500, and the provider's webhook redelivery (the reservation/lease logic allows re-processing errored events) is the retry. So a 40P01 costs one
failed webhook delivery, not a lost message, provided the provider retries. No app code changed here.


# Round 4 (clean private stack): production transaction boundaries, E vs E2
Quarantine: everything above that ran on the shared 55329 stack is **quarantined pending Norma's exact interval** (foreign suite traffic hit 55329 at about 14:24:55-14:25:10Z and 14:30:37-14:31:29Z). Rounds 1-3 used the *synthetic single-transaction workload* (lookup + insert + thread update in ONE transaction).
This round ran on a private stack (project `sandra-filter-vol3`, db 57329, nothing shared, guards have no defaults) with the **production boundaries** of `insertInboundMessage`
(lookup, insert, thread update as three separate autocommit requests; `BURST_MODE=prod`). States: A = no cache triggers; B = 110000+110050; E = 110055 variant E; **E2 = E + Astra fix
(multi-property statements lock the whole id-sorted set up front, no share/skip phase; share-skip fast path is single-property only)**. Two runs (p1, p2; 4 reps each, rotated). Cells p50 / p99 ms, 0 errors.

| burst | state | p1 p50 / p99 | p2 p50 / p99 |
|---|---|---|---|
| 50 concurrent, SAME property | A | 204.8 / 293.9 | 232.2 / 343.7 |
| 50 concurrent, SAME property | B | 363.9 / 707.9 | 405.5 / 562.2 |
| 50 concurrent, SAME property | E | 255.6 / 331.5 | 303.1 / 511.7 |
| 50 concurrent, SAME property | E2 | 307.1 / 464.2 | 307.8 / 396.5 |
| 50 concurrent, 50 distinct properties | A | 21.8 / 43 | 20.5 / 33.5 |
| 50 concurrent, 50 distinct properties | B | 103.4 / 228.3 | 78.8 / 123.1 |
| 50 concurrent, 50 distinct properties | E | 46.8 / 76.6 | 48.9 / 85.2 |
| 50 concurrent, 50 distinct properties | E2 | 54.2 / 98.4 | 47.3 / 80 |
| 10 concurrent, distinct properties | A | 5.3 / 10.5 | 4.8 / 7.2 |
| 10 concurrent, distinct properties | B | 15.1 / 22.9 | 12.8 / 25 |
| 10 concurrent, distinct properties | E | 5.6 / 13.6 | 5.7 / 7.8 |
| 10 concurrent, distinct properties | E2 | 7.8 / 11.8 | 5.3 / 8.3 |
| 200 msgs / 10 s, 20% same property | A | 6.8 / 135.9 | 8 / 23.9 |
| 200 msgs / 10 s, 20% same property | B | 10 / 24.5 | 11.1 / 27.7 |
| 200 msgs / 10 s, 20% same property | E | 8.7 / 20.7 | 9.6 / 22.1 |
| 200 msgs / 10 s, 20% same property | E2 | 7.5 / 19.5 | 9.6 / 26.3 |
| mixed200 + concurrent clearers | A | 6.5 / 44.2 | 7.2 / 17.8 |
| mixed200 + concurrent clearers | B | 9.3 / 23.1 | 11.1 / 62.3 |
| mixed200 + concurrent clearers | E | 7.3 / 18 | 8.3 / 22.9 |
| mixed200 + concurrent clearers | E2 | 7.5 / 21.9 | 8.5 / 26.9 |

Reading: E2 ~= E (no regression from the lock-order fix). 10-way distinct: E2 p99 11.8 / 8.3 vs A 10.5 / 7.2 (met, <= 50 ms; within ~1-2 ms of A). 50-way distinct: E2 +55 / +46 ms over A (acceptance <= +10 ms NOT met; B was +185 / +90).
50-way same property: E2 +170 / +53 ms over A (not met; noise band ~+-100 ms). Mixed and clear-mix: E2 equals A within noise. Production boundaries lower B's penalty slightly versus the synthetic workload.

## Acceptance/tests on the clean stack
Trigger suite + 45-case + generated-column + deterministic overlapping-batch regression (old E deadlocks, E2 passes) + global-DNC writer interleave (both orders, `apply_switchboard_contact_preferences` global DNC vs inbound insert) +
bounded-retry randomized workload (every op completes, deadlocks counted and bounded, cache == truth): 35 passed, 1 skipped (fixture generator). Volume gate (no boolean partial indexes): 22 cases, 0 count mismatches, 0 over budget, worst valid-baseline ratio 0.76.
5 cold lock-probe runs: 5/5 clean, 0 errors, max blocked 0.6 s.

## Does 110055 make full-refresh paths slower? (Search-lane crawl report)
Same seed (50k properties / 250k messages), B = without 110055, E2 = with; mean of 2 runs, ms (each in a rolled-back transaction):

| operation | B | E2 |
|---|---|---|
| refresh 1 property (dirty cache) | 12.9 | 11.3 |
| refresh 100 | 120.8 | 47.2 |
| refresh 1000 | 1074.1 | 225.3 |
| refresh 1000 (no-op) | 22.1 | 26.6 |
| mark-read 1 message | 3.4 | 3.2 |
| bulk mark-read 500 msgs / 100 props | 142.4 | 54.3 |
| delete 100 messages | 17.0 | 12.7 |

Seed pattern from the report (insert 20k properties + messages, then `refresh_property_filter_cache` in 5000-id batches IN THE SAME transaction): B 13.2 s, E2 1.9 s. Row-by-row message inserts with triggers on (6000): B 1.8 / 2.95 ms per insert (one-tx / autocommit), E2 0.67 / 1.7.
Nested plans (auto_explain, `refresh-plan-B.txt` / `refresh-plan-E2.txt`) are identical (same index scans; the dropped indexes are not used by the refresh). **The crawl is not reproducible**: dropping the boolean indexes makes every full-refresh path faster, never slower. Need the Search lane's exact seed
SQL, stack state (was `analyze` run? triggers on or off? which 110055 variant?) and its pg_stat_activity during the crawl to find the real cause.
