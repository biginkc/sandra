# Authoritative Inbox metadata action candidate

Installed only in the owned original PostgreSQL fixture: 7 actual behavior groups and 4 actual two-connection concurrency groups pass, with source-bound evidence. No production migration or worker/application flag is enabled by this directory.

The server accepts typed selected targets and an ordered outcome/assignment definition. It obtains the requester and organization from current database-backed session authority. SQL preparation computes canonical conversation-to-property mappings, deduplicates property effects, and captures precise current target/policy/SMS scope dependencies; clients cannot supply eligibility or version snapshots. Nonexistent conversation IDs take a negative fast path without creating persistent counters. Candidate mappings are recomputed after acquiring persistent counter locks, including after baseline insertion waits.

The reviewed preparation returns item exclusions and affected-property/effect counts. Acceptance requires the original preparation, requester, idempotency key, and retained input hash, then rechecks current dependencies in the acceptance transaction. Accepted replay returns the immutable operation identity. Preparation expiry does not invalidate an already accepted replay. Outbox rows are created atomically by the existing acceptance core; deployment still requires a durable dispatcher/worker runtime to consume them independently of the browser.

Private worker execution rolls back canonical work on a known business conflict and records a durable fenced failure receipt, blocking dependent successor steps. Status exposes item/step codes and operation `succeeded`, `partial`, `failed`, or `cancelled` results. Completion means every step is terminal; it never implies success by itself. The state model permits future cancellation but no cancellation route is enabled. Unrecognized invariant errors, deadlocks, serialization failures, and ambiguous transport failures are not disguised as record conflicts. Prepare/accept API calls retry the entire RPC only for explicit PostgreSQL `40P01`/`40001` aborted transactions. Durable worker retry/reconciliation still requires runtime proof.

Only `wrong_number`, `bad_number`, `not_interested`, `needs_sequence`, `nurture`, and full SMS `opted_out` are executable in this metadata slice. Permanent DNC remains gated; replies and sequence management are not implemented here. Unknown sender targets are excluded until the separate captured-message dismissal adapter is integrated.

`install.py --run-owned-fixture` refuses any existing action API namespace and checks the owned database identity, container guard, disabled cron, exact installed capture function bodies, and enabled unconditional writer triggers. It installs the private candidate and authenticated wrappers without resetting any other fixture. It does not seed global authorization epochs: the reviewed installation baseline must cover every historical member, including assignees who never logged in. Missing epochs fail closed. Existing target/policy/SMS counters are preserved; preparation initializes only missing counters after installed writer coverage has been verified.

Run `run.py --run-owned-fixture` for actual authenticated SQL prepare→accept→canonical effect→status checks and `concurrency.py --run-owned-fixture` for real two-connection baseline/writer waits. Their trusted SQL JWT claims are not an HTTP JWT proof. Only each concurrency run's synthetic counter rows are removed to simulate historical absence. Source hashes and limitations are retained in evidence, and no evidence is claimed until those commands pass.

Application routes are separately disabled unless `INBOX_ACTIONS_SERVER_ENABLED=1`:

- `POST /api/inbox/actions/prepare`
- `POST /api/inbox/actions/accept`
- `GET /api/inbox/operations/:operationId`
- `GET /api/inbox/actions/assignees`
- `GET /api/inbox/operations/recover?preparationId=...&idempotencyKey=...`

The DTO is `src/lib/inbox/action-api-contract.ts`. Current focused unit tests cover input identity, replay references, exact RPC retry, ambiguous response handling, response decoding, terminal results, and HTTP body/origin boundaries. They do not prove live transport, canonical database behavior, or durable worker delivery.

SMS preparation review reports deduplicated contact, linked-property and active-enrollment counts from the immutable prepared scope, including affected unselected sibling properties. Recovery is requester/org scoped to the exact original preparation and key. Acceptance and recovery share a transaction-scoped key lock, while exact relational identities remain authoritative. Recovery returns `accepted` with the durable identity, `pending` while no acceptance is observed and the preparation remains valid, or definitive `expired_not_accepted` after its deadline and after waiting for a preceding acceptance transaction. Only the definitive expired state permits abandoning that uncertain original pair. The client otherwise retains/retries the same preparation/key, never inventing a new key from a pending lookup. The optional approved browser recovery reference contains only opaque preparation/key under auth identity; no selection, message content, PII or localStorage.
