# Real Electric → workspace adapter fixture

Run from this worktree root with Node 22:

```sh
PATH=/opt/homebrew/opt/node@22/bin:$PATH node --import tsx experiments/inbox-workspace-sync-integration/run.ts --run-owned-fixture
```

The harness verifies the exact owned Electric 1.8.1 container identity, pinned image reference, loopback binding, running status, manual-publication mode and stream ID. It verifies the `inbox_t1.fixture_identity` marker before changing the owned local T1 database at port 58782. It creates a uniquely named fixture schema with one narrow summary table, sets PostgreSQL replica identity FULL (required by manual publication), and adds only that table to the existing owned publication. It binds its independent gateway to `127.0.0.1` with port zero, atomically reserving an unoccupied port without replacing existing listeners.

The gateway has one synthetic session, immutable two-target membership with exact kind/UUID pairs and tenant restriction, a fixed table, bounded responses, protocol parameter allowlisting, scoped handles and a second access check before forwarding each buffered response. The browser-facing transport receives no database or upstream credentials. It requests Electric's default response replica mode to exercise partial UPDATE values despite the database's required FULL replica identity.

The harness uses the committed workspace adapter and actual installed TanStack/Electric packages, not a replacement collection. It checks authorized known/unknown snapshots, changed-field update merging, key-only deletion, forbidden scope/SQL/handle tampering and revocation after an upstream response has arrived but before forwarding it. Finally it stops its own listener/requests, drops only the run's fixture schema, asserts the publication table list matches its prior state, and closes the database client. Passed evidence is written only after every cleanup step succeeds; initial guard failures also close the database client. The adversarial fixture includes an unselected opposite-kind row sharing the selected known row's UUID.

This is not the canonical T2 maintained model: rows are synthetic DTO fixtures populated directly. Production auth, membership epochs, leases, host routing, browser rendering, arrival volume and performance acceptance remain separate. The gateway is only a test harness, not a production endpoint implementation. Existing preview and lab services are untouched.

## Finding corrected by this integration

The initial real snapshot exposed an adapter error that the protocol doubles had missed: PostgreSQL boolean values arrive as JSON strings before Electric applies its schema parser. Full `WorkspaceRow` validation at the raw-response boundary rejected `"true"` instead of allowing Electric to parse it into `true`, preventing hydration. The preserved `initial-wire-type-failure.log` contains only owned synthetic records from that failed run. The adapter now checks scope/identity before parsing and validates all presentation fields after Electric parses and merges the record. Two regression cases cover the real wire boolean and invalid parsed presentation data.

The recorded six checks prove this small real-engine data path, not the workload or production SLOs. An observed 1,182-byte maximum is a fixture response measurement, not a general expected response size. Cleanup removes the fixture table from the manual publication by dropping only its uniquely generated schema and verifies the original publication members remain intact. No replication settings are changed.
