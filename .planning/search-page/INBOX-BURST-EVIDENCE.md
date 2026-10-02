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
