# Canonical Inbox workset bridge — incomplete integration

Owned T2 fixture only. No production migration or Electric publication has been installed.

- `projection.sql` flattens maintained summary publication into a narrow DTO and removes tombstones. Unknown sender unread is null.
- `auth.sql` verifies canonical session existence/expiry plus exactly one globally active membership and tracks persistent access revisions. Claims must already have undergone actual JWT verification upstream; SQL tests do not prove that layer.
- `worksets.sql` persists immutable typed ordered memberships (maximum 500), actor-serialized generations, one-second creation throttle, maximum two live scopes, explicit same-actor/session/org/epoch replacement, and per-partition compare-and-set Electric handles (five fixed slices of at most 100 members).
- `public-api.sql` grants only the four wrapper functions to authenticated. Canonical/private tables remain unavailable to that role and anonymous RPC execution is denied.

Run `python3 experiments/inbox-workset-bridge/run.py --run-owned-fixture` only for a fresh guarded fixture; it refuses existing bridge state. The auth administrator creates the missing canonical sessions subset, then private installation is atomic. The first attempt lacked auth-schema create privileges and rolled back the bridge installation; that is why the bootstrap uses the auth administrator for this single table.

Run `python3 experiments/inbox-workset-bridge/test.py --run-owned-fixture` for repeatable randomized owned cases. `concurrency.py` additionally observes actual blocking between two connections before confirming the live-generation bound. Tests leave uniquely named synthetic records in the owned isolated fixture; they never clean broad existing data.

V1 filter is strictly `{ "view": "active" | "dismissed" | "review" | "unread" }`. Non-null cursor/search and other filters are unsupported and must be rejected upstream. This is not complete parity. Initial tests insert bounded projection fixture rows; a separate case proves the real maintained-row trigger and tombstone.

Remaining: full canonical parity and realistic query plans, active invalidation delivery, real canonical Electric integration, bounded historical scope cleanup, existing-user access-epoch baseline with install fencing, authoritative assignment labels and display-name change propagation, and complete production migration/rehearsal. Assignment label currently says Assigned when a user ID exists; this is an explicit unresolved display gap.

Public RPC arguments: inbox_authorize_sync(org_id), inbox_create_workset(org_id, filter, limit, replaces_scope_id), inbox_get_sync_scope(scope_id), inbox_bind_sync_handle(scope_id, partition_index, expected_handle, next_handle). Scope returns id/org_id/user_id/session_id/access_epoch/generation/expires_at/targets/handles; revision and generation are decimal strings and targets have kind/id. Permission errors fail closed.

Reviewed follow-up: authorization now reads session/membership/epoch in one SQL snapshot; expired same-context predecessor replacement is accepted. `auth-concurrency.py` observed coherent org/epoch pairs while canonical delete+insert membership transactions ran (org update is correctly forbidden by canonical guard). `partitions.py` verifies 500 targets, five independent handles and invalid partition denial. `rpc-sample.json` contains actual scalar RPC output using synthetic fixture identities only. Follow-up source installed via `apply-reviewed-fixes.py`; initial installation receipt describes historical initial source.

V2 implementation is now installed and small-fixture tested in `parity-v2.sql`: actual contact text/phone and canonical historical SMS FTS, independent overlapping counts, exact normalized filter binding and opaque keyset cursor with microsecond timestamps. Tests: parity-test.py, search-test.py. Unknown loader retains its actual legacy behavior of ignoring known search. V1 view-only wrapper remains intact. The v2 SQL is correctness groundwork, not a performance claim: it currently reads worker-private maintained JSON and requires indexed narrow filter metadata / actual realistic-volume query plans before release. Synthetic scalar v2 and read-wrapper receipts are retained alongside tests.

The one-second creation throttle and two-live-generation cap are trial constants for this fixture, not approved production interaction settings. `verify.py --installed` performs read-only source-body verification; regenerate a manifest only after rerunning evidence for affected changes. Root read-wrapper tests/receipts remain outside this PR because their independent schema is not a dependency of the core bridge.
