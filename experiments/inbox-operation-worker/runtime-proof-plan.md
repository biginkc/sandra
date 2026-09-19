# Owned signed worker proof

This plan is not execution evidence. The runtime has not been started. Keep the current preview and original operations fixture intact.

Use a fresh canonical-schema database named `sandra_inbox_action_runtime_20260913` in the marked T2 container. Install reviewed capture, baseline, core/domain/SMS and authoritative metadata sources. Do not copy pending outboxes or preparations from another database. Only synthetic users, contacts, properties, messages and accepted operations belong in this database. Baseline completion must be achieved by the real installer, not by overriding readiness.

The dedicated action role receives only the five reviewed worker functions. Prove its direct canonical table writes, action preparation/acceptance, and internal receipt-table access are denied. Use an ephemeral random fixture credential; keep it in an ignored owner-only directory and never print it or include it in receipts. Production login provisioning remains a separate step.

Build the reviewed pinned Node image, run it without root, with read-only root filesystem, dropped capabilities, no published ports, 1 CPU / 1 GiB and its two-connection pool. Run a separate pinned Restate 1.7.5 instance using a new persistent data volume and an ephemeral ED25519 signing key. Do not touch the existing T1 Restate. All traffic stays in the marked T2 network namespace, using explicit owned aliases. An unsigned callback must fail while a Restate-signed callback succeeds. Check actual public-key configuration on both sides; do not simulate verification with a mock.

Prove these behaviors using ordinary canonical action preparation and acceptance:

1. Accept outcome plus assignment, close the accepting client, and observe the real dispatcher, signed callback and canonical durable receipts completing both steps.
2. Block the second step with a separate canonical row lock. Once the first step commits, terminate the worker process. Restart it and release the lock. Verify both terminal receipts and exactly one canonical event per step. The original operation and immutable step identities must survive.
3. Repeat while also restarting Restate with the same owned data volume. Accepted work must resume without a browser resubmission.
4. Forward a real `/send` request through an owned fault proxy, then drop its successful response. Confirm the SQL dispatch lease remains unacknowledged. After lease expiry, the same immutable event ID must be redelivered and acknowledged. Verify no duplicate canonical effects.
5. Reject a callback without the configured signature. Confirm no canonical change and no receipt was produced by that request.
6. Saturate concurrent readiness requests while an operation executes. Confirm probes coalesce and the worker never exceeds its two DB connections. Stop Restate and demonstrate readiness failure; restart it and demonstrate recovery without restarting the worker.
7. Hold a source write concurrently with preparation/acceptance/execution to induce a real PostgreSQL deadlock. Record the actual victim and same-request retry. A different transaction being the victim is not proof that the worker retried an aborted effect.

Each result must bind the exact SQL bodies, worker source, image digests, role grants and runner hash. Failure preserves evidence; cleanup verifies exact container IDs/labels and the fresh database marker before removing only owned resources. No provider endpoint is involved.

Signing configuration is based on the official [Restate service security documentation](https://docs.restate.dev/services/security), checked September 13, 2026, and the installed pinned SDK endpoint declarations. Actual compatibility remains a runtime test.
