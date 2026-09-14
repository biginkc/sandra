# Known-summary worker integration with existing projection CAS

Twelve checks passed against the actual installed `inbox_t2_summary_contract.compute`, dirty-generation capture and projection CAS functions. This connects the full known-conversation JSON to the existing publication protocol without replacing prior proof functions. It remains an offline worker-private rehearsal, not a production migration, route or queue worker.

Run only with exclusive fixture access:

```sh
python3 experiments/inbox-projection/summary-worker-integration/run.py --run-owned-fixture
```

The harness refuses optimized Python before any external call, checks immutable fixture/container/network/cron identity, requires the installed dirty trigger enabled, and refuses an existing integration schema before writes. Statements and subprocesses have bounded timeouts. It creates only synthetic organizations/contact/property/messages; deletion/reinsertion affects its own message. Setup and existing function definition hashes are recorded in `evidence.json`. Prior proof functions, schemas and evidence remain intact.

## Publication protocol exercised

The new STABLE snapshot wraps the existing projection snapshot and the real summary compute into one SQL statement snapshot. It captures dirty generation **G**, current projection revision **R**, existing narrow projection fields and the full computed JSON for a fixed `as_of`. Missing dirty scope yields no candidate. The existing compute's eligibility, fields, preview, visibility and tombstones are used directly.

The private commit wrapper validates the summary scope/kind, invokes the installed CAS commit and, only when it returns `applied`, writes the full summary with revision R+1 and source generation G. The original function retains its dirty-then-projection lock order; the wrapper then writes its private summary row. Commit reads no canonical messages/contact/property tables and has no canonical foreign keys. JSON persistence, projection revision and acknowledgment happen in one transaction.

The extra JSON table is a fixture integration adapter, **not a second independently publishable production projection**. For these fixture keys, only the wrapper may publish full summaries. The old direct CAS function would update narrow metadata without updating this table; consumers must not assume that path maintains full JSON. Production should put the full summary into its authoritative projection transaction and enforce the intended worker interface. This lab does not prevent trusted postgres from bypassing that interface.

## Verified outcomes

- Initial G=1/R=0 snapshot contained the actual complete compute result. Publication stored exactly that JSON with matching full/narrow revision and acknowledged generation.
- A captured older generation published after another source write, but acknowledged only its captured G. The newer generation remained pending. This is intentional convergence behavior, not a claim that every published row is the latest possible value.
- After the newest result published, a same-R peer returned `projection_conflict` and an older acknowledged generation returned `invalid_generation`; neither altered the stored JSON.
- A temporary CHECK constraint forced the full JSON write to fail **after** the original CAS had run. The whole transaction rolled back, including CAS revision and dirty acknowledgment. Retrying the complete candidate succeeded.
- Read/body updates dirtied the conversation and published the real unread count and preview. A later covered event also recomputed changed contact name, property eligibility and route.
- Deleting the last eligible source message published a keyed `exists:false` tombstone while retaining monotonic projection metadata. Reinserting the same source ID produced a fresh generation/revision and live JSON; replaying the old tombstone was rejected.
- Authenticated/service_role could not call the private snapshot (SQLSTATE42501). All original compute/dirty/CAS definitions retained their hashes.

## Proven coverage gaps, not passing production gates

The negative cases are deliberate and material: changing the contact name, property status and message route/status did **not** advance the current dirty generation. The status change made a fresh compute return `exists:false` while stored JSON still said `exists:true`. A covered body update was used explicitly to demonstrate recomputation afterward; it is not a fanout implementation.

The current message trigger watches ID/org/conversation/channel/direction/body/read_at/created_at and skips arrival-revision-only updates. It does not cover all message dependencies: status, contact_id, property_id, from_address and to_address are missing. Separate contacts, properties, message_threads, consent_events, suppressions and AI disposition reviews also need correctly scoped fanout. Mentioning existing review/responder fields preserves current source semantics; it does not expand the redesigned Inbox's AI scope.

Time alone also changes the 2,160-hour eligibility window. Advancing the compute's as-of time produced a tombstone without a source write or dirty-generation change; stored JSON remained live. An expiry scheduler must mark the correct key dirty (advance generation) and recompute after its deadline. Merely recomputing the same acknowledged G cannot publish through the existing CAS.

These tests do not implement either missing dependency fanout or expiry scheduling. Therefore **the integration is not ready for complete continuous summary maintenance** despite correct publication of captured candidates. Old/new identity fanout, delete behavior, retries, queue delivery, live workload limits, consumer auth and generation/capture restore fencing remain broader production gates. Candidates are trusted worker output, not public client input or authorization tokens. Only the known-conversation compute is integrated here; unknown-message summaries remain separate.
