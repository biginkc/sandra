# Reviewed reply boundary

This increment supplies bulk-only template rendering, a no-retry Sendillo
transport and a dispatch boundary that always re-enters through a durable claim.
It does not activate bulk replies or modify the existing Outbox sender.

The SQL adapter for claim/persist is still required. Its contract must commit
eligibility, account admission and `dispatch_started` together before the network
call. A repeated claim must return the stored receipt or uncertainty, never a
second dispatch token. The claim must not be journaled as a separate durable step.
Transport/persistence mocks prove application control flow, not database crash
durability or an independently verified provider idempotency contract.

`context.sql` adds missing reply dependencies: sender inventory by canonical row
UUID, organization name and property market. Persistent counters capture old and
new identities and survive deletion/reinsertion. Historical source baselines are
inserted once; a missing canonical source does not allocate a counter. Snapshot
reads are repeated after the version lock is acquired. These dependencies
supplement existing identity, consent, message-content and inbound-head fences;
they are not complete send eligibility on their own.

`context-test.py --run-owned-fixture` validates the exact isolated container and
database marker, executes canonical trigger tests, then rolls back the entire
schema and synthetic source data. Eight groups cover ABA, tenant moves, unrelated
sync metadata, personalization changes, missing-source allocation, baseline and
effective private grants. `context-concurrency.py` uses two real connections and
observes the reader waiting on the writer's database lock. Both a previously
missing historical baseline and an existing sender revision return the writer's
committed current value after waiting. Its temporary schema/triggers are removed;
small uniquely marked synthetic source records remain in the owned fixture.
`verify.py` checks both recorded proofs' source hashes only.

Remaining integration: authenticated preparation with frozen individualized text
and From/To; duplicate destination review and cap 50; immutable acceptance;
bounded provider account admission; real SQL claim and receipt persistence;
Restate restart/ambiguous response tests; verified callback reconciliation;
review UI and isolated owned-recipient provider proof. No production schema,
flags, credentials or provider calls are changed here.
