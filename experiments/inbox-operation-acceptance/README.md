# Durable Inbox operation acceptance core

Depends on action-definition PR #562. This is a private SQL implementation and disposable runtime rehearsal. It is not a production migration and is not wired to application routes. No provider sending or canonical Sandra mutations are implemented here.

`accept_prepared(org, requester, idempotency_key, preparation_id)` consumes a retained immutable server-owned preparation, not a browser-supplied eligibility flag. Its canonical input and SHA-256 hash use the exact `parseInboxActionIntent` output/domain; PostgreSQL verifies that hash plus organization, requester and copied definition bindings. The UUID idempotency key retains the parser's normalized UUID identity. Preparation is immutable and retained while accepted operations reference it.

`assert_request_access` must implement actual current server authorization. It runs even on replay. `assert_current_preparation` must lock/revalidate the canonical identity, eligibility and dependency versions and the complete target/effect mapping. Both default to throwing unavailable. This makes absence of the authoritative adapters fail closed. The runtime test replaces them only inside its uniquely owned disposable database with clearly synthetic fixtures.

Acceptance reserves UNIQUE(org, requester, idempotency key) before fresh preparation checks. Same hash returns the retained accepted operation even when the preparation later expires or its old dependencies change. A different hash conflicts. A new operation still requires current preparation and unexpired state after its validator finishes. Reservation, immutable definition copy, all item mappings, deduplicated effect steps and one dispatch event commit atomically; failure rolls everything back.

Preparation snapshot contains `items` (typed conversation/group, exact resolved identity or exclusion) and `effects` (authoritative effect key, ordered action/payload/dependencies, mapped item IDs). Two conversations sharing a property can map to the same effect steps without losing either selected row. No eligible item may silently disappear or lack an effect; excluded items cannot be effect targets. Real preparation must enforce domain-specific restrictions, actual source versions, active ownership eligibility, property deduplication and captured message IDs. The private storage checks do not replace those checks.

Steps cover metadata only: outcome, assign/unassign, promotion, unknown dismissal/restoration. A saved `review_reply` intent must be handled after metadata results through a separate reviewed reply workflow; no executable send step exists. Reply-only intents must not be converted into empty metadata jobs. Permanent DNC, sequence enrollment/management, AI, appointments and identity changes are excluded. Existing restrictive outcomes still require their SMS opt-out side effects in the future adapter.

`claim_step` returns a monotonically increasing fencing generation. An expired lease is reclaimed on the same step ID; predecessor success is required before a dependent step can claim. Within one database transaction, the adapter must call `lock_step_for_effect` **before** any canonical mutation, then validate actual state, apply the effect and call `finish_step` while keeping that lock. Completion rechecks generation/lease and stores one immutable receipt. The returned prior-step receipt carries the successful preceding step's revised dependencies; the adapter must combine them with unaffected original dependencies rather than falsely conflicting with its own outcome change. No function here applies the actual outcome or assignment. Completed step replay is handled by reading its existing receipt, not performing the effect again.

Dispatch claims keep the original event ID while lease generations change. Only the current unexpired generation can acknowledge. Restate delivery must use that stable event identity, and journals should receive opaque operation IDs, not protected payloads.

## Rehearsal

Run with an explicit owned T1 connection:

```sh
LOCAL_REHEARSAL_DATABASE_URL=postgres://postgres@127.0.0.1:58782/sandra_inbox_t1 node experiments/inbox-operation-acceptance/run.mjs --run-owned-fixture
```

The runner verifies the T1 fixture marker, creates one unique `sandra_inbox_acceptance_*` database, installs only there, uses independent SQL sessions and actual expired leases, and removes exactly that database afterward. T1 canonical/publication tables are unchanged. Runtime evidence includes a synthetic canonical effect update and receipt in the same transaction: invalid receipt and stale fence each roll back the effect, while success plus guarded replay retains exactly one effect and receipt. This is an analogue, not evidence of the actual Sandra outcome adapter. Direct execute denial is tested for authenticated/service_role when those roles exist; no shared roles are created. Runtime evidence also covers atomic acceptance/rollback, matching/conflicting replay, access revocation, immutable copies, property-step deduplication, generation fencing, ordered receipt handoff and stable dispatch identity.

Remaining integration: actual Sandra authenticated preparation and transactional outcome/assignment adapters; current canonical eligibility and source-version coverage; step failure/partial-success retry receipts and cancellation; distributed admission budgets; Restate ingress/dispatch recovery; durable retention and cleanup policy; reviewed reply operations/providers. The core must not be exposed or enabled until these applicable boundaries exist and pass runtime tests. Synthetic fixture authorization is never an acceptable production adapter.
