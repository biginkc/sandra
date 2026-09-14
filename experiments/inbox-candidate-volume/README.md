# Full-Auth candidate volume rehearsal

The first admission applied 1,000 owned known conversations (1,250 messages) through canonical inserts. Further scaling is paused because actual browser measurement exposed excessive authorization RPC fanout. Existing browser preview rows and its user are outside this seed's ownership. The earlier separate-organization proposal was rejected because unchanged middleware requires SANDRA_ORG_ID; this seed reads that constant and rejects a manifest for any other organization.

The target is 120,000 summaries: 108,000 known conversations and 12,000 distinct unknown senders. Known conversations have 135,000 messages (one per conversation, plus a second message for every fourth conversation); unknown senders add 12,000 messages. Total: 147,000 canonical messages, 108,000 contacts and 108,000 properties. Timestamps span 89 days. Half the properties are assigned to a separate synthetic owner; outcomes are distributed between no outcome, nurture and not interested. The second message alternates between inbound and outbound so reply filters have different selectivities. This is a synthetic approximation, not a claim about Sandra's measured distribution.

Use a separate real GoTrue user with no active membership, with exactly one active membership in the existing canonical Sandra organization. Frontend browser measurements must log in as that user. Never add another active membership to the current preview user: global membership authorization would invalidate their session. The worker uses actual canonical capture and publication; do not insert maintained summaries directly.

`seed.py --prepare` writes a unique local manifest without connecting to a database. It records the run UUID, deterministic ID namespace, expected counts and fixed timestamp. `--apply --manifest <path> --actor-user-id <uuid> --max-batches 10` is only for the marked local candidate after explicit shared fixture/load coordination. A batch has 100 conversations/senders, and every batch commits its progress in the same transaction as the canonical rows. No conflict is silently ignored. Reusing a manifest resumes its recorded checkpoint; conflicting actor identity or configuration fails.

Admission stages:

1. Seed 1,000 known conversations and measure row/index disk growth, transaction latency, queue depth, RSS and worker catch-up. Stop on statement/lock timeout, container resource failure, capture errors or failed reconciliation.
2. If healthy, finish 10,000 summaries and run actual browser selection/detail/history/count measurements while a separate bounded writer introduces a low controlled arrival rate.
3. Continue in bounded invocations to the 120,000-summary target only after root/frontend coordinate the resource window. Verify exact canonical and maintained counts, index plans and oldest pending work before browser measurement.

The existing Docker limit is one CPU and 512 MiB for PostgreSQL. This proves fixture behavior only. Do not run a long load while the user or frontend is measuring the preview. Do not raise container limits or create production resources automatically. Capture the actual stop reason rather than increasing timeouts to hide it.

Performance measurements must distinguish database workset/count/query time, Electric catch-up, API transport, first open, revisit, selection, and history page latency. Report sample count and p50/p95 separately. The earlier two-conversation browser results are not large-data acceptance. Unique UUIDs and an explicit message ownership prefix preserve the current preview's records, but the added rows are visible in that organization and shared CPU/disk load still requires coordination.

No delete/reset command is provided. A future cleanup must enumerate this exact manifest's UUID namespace and never erase retained capture heads, epochs or unrelated fixture state.

## Actual first admission

Ten transactions inserted 100 conversations each. Their combined SQL wall time was 2.178 seconds. The persistent projector reached no pending summary or parent work 14.035 seconds after the pre-seed baseline, including seed time. Worker logs recorded 3,000 parent batches and 2,792 publications: canonical fanout amplification remains visible in the evidence. Continuous numeric peak queue depth was not collected, so these receipts do not claim one.

The authenticated browser loaded two 500-row pages without API errors. First detail was 862 ms, revisit 39 ms, and Shift-selection 39 ms. Initial synchronization was 6.17 seconds and the next page 3.46 seconds. The transport counted 180 authorization RPCs, 142 scope reads, and 30 handle compare-and-swaps across two pages plus 18 seconds idle. This is a small admission, not the 120,000-row browser acceptance test. The additive authority optimization is a separately owned dependency; load must remain paused until its real browser proof is reviewed.
