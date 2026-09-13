# Unknown and dismissed summary contract

Status: twelve checks passed on the owned offline canonical fixture. `compute.sql` installs two private SQL functions, `run.py` contains guarded synthetic fixtures, and `parity-oracle.ts` invokes the actual application classifier. No production migration, application route, Outbox behavior or user-facing action was changed.

## Canonical behavior retained

| Rule | Source |
| --- | --- |
| Inbound SMS, contact_id NULL, from_address nonnull | src/lib/messages/list-unknown-senders.ts:100–110 |
| No time/status/property/conversation/noise/review/suppression condition | Same query:104–110 |
| Raw sender string grouping; empty skipped, whitespace retained | Same file:57–60 |
| Latest row supplies body/time/destination and whole-group dismissal | Same file:62–70 |
| Count includes active and dismissed eligible rows, not just visible ones | Same file:73 |
| Classify before active/dismissed filtering | Same file:77–88; src/app/(dashboard)/messages/page.tsx:202–205 |
| Page through all source rows in batches1000 until exhausted | Same file:31 and :99–122 |
| Legacy dismiss/restore uses address/contact/dismissal predicates but lacks channel/direction restrictions | src/lib/messages/triage.ts:425–451 |

Unlike known-conversation summaries, Unknown has **no90-day cutoff or older-review exception**. It also has no suppression/noise exclusion. These rules must not be copied from the known Inbox query. An as-of timestamp is recorded for bookkeeping but does not impose a new historical window. next_window_expiry is NULL. Full-history counts are preserved, with no claim that computing them has bounded cost.

The helper does not impose a fixed total row cap: it pages until exhaustion. The oracle test reads1013 synthetic eligible rows under an active single-organization membership, then invokes the production classifier through a mocked paginated transport. Its1000-row boundary is crossed and six exact raw groups are compared, including a1005-message group. This proves classification/pagination handling for this fixture, not real PostgREST transport behavior, concurrent-page consistency or production query budgets.

## Deliberate contract distinctions

Tenant identity is mandatory. New compute keys are `(org_id, raw_sender_key)`. Legacy JavaScript groups by raw sender across all rows visible to its current RLS session, so a user with multiple organizations can get a combined bucket. The new per-org separation implements the approved tenant-scoped contract; it is not exact parity with that legacy multi-org aggregation. Source parity is tested under single-org authorization. Different textual phone representations remain distinct; no normalization, trimming or property-based merging occurs.

Legacy source orders only created_at, so equal timestamps do not define a stable latest row. The new candidate uses `(created_at DESC,id DESC)` and returns latest_timestamp_tie_count plus legacy_tie_parity_defined=false when tied. This is explicit new determinism consistent with the history contract, not proof of legacy tie parity. It adds no blocking UI or extra confirmation step.

The preview is capped at120 characters as a narrow-summary proposal; the legacy helper returns full latestBody. No full history or provider metadata is exposed in a summary.

`sender_group_id` is NULL and identity_mapping_required=true. The exact raw display key is **not** a persisted typed target ID. A durable mapping with tenant identity and deletion/recreation rules must exist before emitting actionable `unknown_sender_group` targets. No hash-derived or phone-normalized identity was invented.

## Dismiss/restore proposal and frozen IDs

`propose_message_ids` selects only same-org, exact-raw-address, inbound SMS with contact_id NULL and the requested current dismissed state. This is intentionally narrower than the legacy broad update helper, per the approved command contract. A bounded request permits1–500 IDs, default200. It inspects at most limit+1 result rows and returns no IDs on overflow; it cannot silently approve a partial group. This limit is an internal proposal constraint, not an approved product group-size cap, and LIMIT alone does not bound scanned work without an appropriate query plan/index.

The function returns persisted=false and proposal_only. It does not create an operation receipt, durable workset or authorized command. A synthetic test captures the proposal IDs, introduces a later arrival, then updates only the captured IDs with current org/inbound/SMS/unmatched predicates. The later row, outbound row and email row remain untouched. Restore proposals select the correct dismissed inbound row. Production still needs durable frozen membership, requester authorization, dependency rechecks, idempotency and restart-safe handling; execution must never expand the raw group again and sweep in later arrivals.

## Running and evidence

After an exclusive fixture grant, run `python3 experiments/inbox-projection/unknown-summary-contract/run.py --run-owned-fixture`. It validates the shared exact container/image/resource/network/cron guard and ready fixture marker. Existing private schema causes a refusal before fixture writes; no automatic reset/reinstallation occurs. SQL and subprocesses have bounded timeouts. The successful run leaves unique synthetic organizations/records and private functions for inspection. All canonical guards remain enabled.

`evidence.json` contains twelve passing checks, setup/runner hashes and explicit limitations. It records PostgreSQL ACL errors42501 for ordinary/service roles; SQL remains worker-private. The source oracle uses real RLS filtering with simulated database claims, not JWT verification or an application endpoint. There are no runtime provider calls.

Remaining gaps: persisted typed identity mapping, dirty capture for unmatched identity/address/dismissal changes, concurrent fanout/repair, stable durable command snapshots, group counts under large history and live arrivals, and end-user read/write authorization. No Inbox/Outbox command implementation or production-scale certification follows from this proof.
