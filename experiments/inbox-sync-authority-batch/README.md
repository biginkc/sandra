# Atomic synchronization authority

The real first1,000-record browser measurement found 10 PostgREST requests for each handle-bearing partition response: authenticate, initial scope read, three scope/access pairs, then bind authorization and handle CAS. Five partitions amplified those requests while each request also retained the existing middleware GoTrue/membership checks.

This additive candidate uses two authenticated SQL RPCs per completed partition response:

- `inbox_sync_snapshot_v1(scope_id)` derives verified JWT actor/session, checks canonical authority, and returns the immutable scope plus current expiry.
- `inbox_sync_finalize_v1(scope_id, expected_scope, partition_index, expected_handle, next_handle)` locks the canonical actor epoch, reauthorizes after the lock, locks the workset, compares its complete immutable identity/targets/generation/expiry against the exact raw SQL proof, validates the partition and handle CAS, and checks natural expiry before returning. Unchanged handles perform no row update. The raw proof preserves timestamp microseconds; it never comes from the browser's query parameters.

The gateway buffers and bounds upstream bytes, finalizes before delivering them, checks the final authority again locally, and retains the original15-second deadline. It never caches authority between requests. Canonical denial/replacement returns403; a valid-authority stale-handle conflict retains409 semantics. Existing middleware email/Hugo/membership checks remain unchanged. Production repository installation requires both new public RPCs; missing functions fail closed without reverting to old calls. Setup here is explicitly limited to the marked owned candidate, and still needs inclusion in the reviewed production installer.

Validation includes37 focused repository/gateway cases, actual authenticated SQL scope/CAS/typed-target/partition/session-deletion/suspension/replacement/grant checks, concurrent replacement while finalization waits for the epoch lock, natural expiry, and a real GoTrue/Next/Electric browser session revoked during an active long poll. The browser returned401 and cleared rows and selection. Its response body became unavailable to Playwright after the client cancelled pending requests; the evidence does not claim body inspection in that case.

Comparable local samples against1,000 added conversations and two500-member pages:

| Observation | Original | Atomic |
| --- | ---: | ---: |
| Initial synchronization including login |6.17s|2.84s|
| Next500 synchronization |3.46s|1.31s|
| First detail open |862ms|851ms|
| Cached revisit |39ms|37ms|
| Shift selection |39ms|36ms|
| RPCs per completed sync response |10|2|

The optimized sample completed30 sync responses, with40 snapshot calls (10 additional polls started then cancelled) and30 finalize calls. The remaining12 legacy authority/scope calls belonged to other endpoints. Both samples had47 middleware Auth and47 membership requests. Quiet polls lasted about8seconds; initial shapes required one initial fetch and one catch-up before live polling. No short empty polling loop was found.

These are local individual measurements using Next development mode and a Docker namespace HTTP relay, with different warmup/cache histories. RPC reduction is demonstrated; timing improvements are directional, not production percentile acceptance or a claim that the remaining latency is solved. Further work should measure actual hosting latency and the separately preserved middleware cost.


A subsequent warm-server distribution used50 distinct conversations, each with one immediate revisit and Shift selection. First-open median197ms/p95308ms/max814ms; revisit median35ms/p9539ms/max48ms; selection median31ms/p9539ms/max74ms. Exactly50 detail requests were observed; selections and immediate revisits added none. Initial first-readable row1.756s, controls1.767s, and all-partition live1.770s included a fresh real login. Raw samples are in `experiments/inbox-volume-browser/distribution-evidence.json`. This sample does not cover cold application boot, larger corpus, concurrent users or production network conditions.
