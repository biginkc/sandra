# Inbox T1: real Restate durability experiment

Synthetic local fixture only. This does not enable a production feature, change the product Outbox, or send messages. Runtime pinned to Restate1.7.5 image `docker.restate.dev/restatedev/restate@sha256:675b85e7bf674f9dfda04a391fa33e850650d57e464b694ca8df5866acad95cc`; TypeScript SDK1.17.0 from parent package lock. [Official release notes](https://github.com/restatedev/restate/blob/main/release-notes/v1.7.5.md), [durable steps](https://docs.restate.dev/develop/ts/durable-steps), [versioning](https://docs.restate.dev/services/versioning).

## Checklist

- [x] Guarded acceptance transaction, durable event, canonical mutation and per-step receipt.
- [x] Actual Restate ingress acceptance and TypeScript service invocation.
- [x] Stable relay idempotency across changing claim generations.
- [x] Property deduplication and immutable request hash conflict.
- [x] SIGKILL after canonical commit, before journal acknowledgment, followed by restart.
- [x] Between-step error and runtime retry.
- [x] Current membership revocation and authoritative property revision conflict.
- [x] Persisted evidence asserts SQL update audit counts, not merely final values.
- [ ] Provider uncertainty attempt implementation (not covered by this slice).
- [ ] Production security, multiworker admission, cancellation and user-initiated retry API.

## Run

From `experiments/inbox-stack` after root fixture/dependencies setup:

```
./node_modules/.bin/tsx bulk/setup.ts
./node_modules/.bin/tsx bulk/worker.ts
```

Run `bulk/start-runtime.sh` in another terminal to start the owned512MiB runtime and register the local worker; it requires the existing Docker network. Already-running owned runtime is reused only after ownership, pinned digest, exact network/loopback ports,512MiB memory and named-volume checks. The exact original container ID is allowlisted because it predates the ownership label; new instances receive that label. Unknown or stopped/unhealthy containers fail closed. Use `bulk/start-runtime.sh --inspect-only` to validate without creating, starting or registering. It uses a named persistent volume. Runtime loopback ports58785/58786; worker58788. Restate reaches the loopback host worker through Colima's verified `host.lima.internal` forwarding. No port binds to all interfaces.

Run `./node_modules/.bin/tsx bulk/server.ts` for acceptance API58789 and transactional relay. For tests, stop the worker and API first: `./node_modules/.bin/tsx bulk/test.ts` owns a worker child, intentionally kills/restarts it, briefly revokes the synthetic user and restores it in finally. Do not run concurrently with interactive fixture validation. The Restate runtime remains running; the test does not delete data.

## API

Every request needs explicit `x-fixture-user` header containing a fixture user UUID. No missing-header fallback. This is fixture identity injection, NOT production authentication. All routes bind127.0.0.1.

`POST http://127.0.0.1:58789/operations` with JSON:

```
{"clientRequestId":"new-stable-request-key","conversationIds":["fixture-conversation-uuid"],"outcome":"Interested","assignedUserId":"aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa"}
```

Omit assignedUserId for outcome only. T1 does not expose unassignment or production outcome taxonomy. Max50 selected IDs. Response202 `{operationId,targetCount}` or `{operationId,reused:true}`. Unknown fields are rejected. Input fields normalize in fixed order before hashing; fault defaults to null. Fixture-only `fault` values `after_commit` and `between_steps` are deliberately available solely for this disposable harness.

`GET /operations/:id` returns persisted `state` and `receipts` for an active member who owns the operation. Selecting two conversations for the same property gives one mutation target; audit asserts exactly one outcome and one assignment SQL update. Workers recheck active requester/assignee and revision under locks.

The UI should proxy these APIs or use the gateway's own authorized fixture mapping; no permissive CORS is provided. IDs come from root's500-row summaries. No production domain types are altered.

## Evidence and limits

`evidence.json` records the executed checks. All8 original scenarios passed against the actual runtime, including the hard crash. Property triggers advance revisions and synchronize root's summary table, enabling the Electric path to observe canonical results. This fixture's trigger coverage is not proof of all production writers.

Targets are processed sequentially in this first compatibility slice. Accepted operations survive API/browser closure. A deliberate runtime retry between steps is supported; a user-facing retry/cancel endpoint is not implemented. No authoritative receipt generation claim is made for distributed stale-worker ownership: DB unique receipts and target transaction locks protect this single-worker proof, while relay claims are generation-fenced. Production design requires stronger admission/claim/version/cancel contracts.

Local Restate handlers deliberately have no request-signature validation and are reachable only on loopback via the owned VM. This is not a production endpoint configuration. Production must verify Restate identity, authorize ingress, separate tenant membership and bound resource use. No HA, scale, provider behavior, SDK upgrade or production migration claims follow from these tests.
