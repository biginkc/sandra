# Workspace synchronization adapter review

Independent source review, 2026-09-13. No database access or test execution by
this reviewer. Reviewed source HEAD: `ebb9100cfc504905a02181fd356a02d8bcef2273`.

Reviewed file SHA256s:

- `workspace-sync.ts`: `59fdde50fbb10fea6c77d647f5b888559f8e97981f5b21a825c8f3113f615430`
- `workspace-sync.test.ts`: `2cfe4ab2e409194913fc7f79be4f89cf26e99ae49beb44cd0541185869d291c4`

## Source verdict

The identified deadline bug is fixed on inspection. `authorizedNow` checks both
the active generation and `Date.now() >= scope.expiresAt`. Its failure path can
still stop the same generation without recursion. The transport checks after
fetch completion and after JSON parsing; publication also checks the deadline.
The timer remains a proactive cleanup mechanism rather than the sole guard
against expired delivery. This does not claim a pre-dispatch expiry check or
remote authorization: the gateway must independently reject expired requests.

The prior cancellation override is also fixed: request, caller and scope signals
are combined, preserving individual cancellation without aborting the whole scope.
Identity extraction now accepts partial update/delete identities; complete rows
are validated before publication. Replaced-generation callbacks cannot republish
old rows or revoke the replacement session.

## Test evidence qualification

Partial UPDATE/DELETE tests use the real pinned Electric/TanStack collection with
a synthetic fetch transport. Their response fixture now includes the required
`electric-cursor` header along with handle, offset, schema and up-to-date control.
This exercises client protocol handling, not a deployed gateway or live Electric
server. The reviewer inspected these tests but did not execute them.

The deadline test correctly advances only `Date`, leaving the expiry timer
unadvanced, then delivers a pending response. The final reviewed test uses a
protocol-valid response, including `electric-cursor` and up-to-date control, and
asserts `response.clone` is never called. This closes the earlier false-positive
risk from malformed protocol data: the assertion now distinguishes rejection
before parsing from later protocol failure. Source inspection and this test's
assertions close the identified expired-delivery issue; this reviewer did not
independently rerun the test suite.

The implementation worker also performed a mutation check by removing the
deadline guard temporarily. The reviewer inspected
`/tmp/sandra-workspace-sync-expiry-mutation.log`: the expiry-only test failed with
`live` state and a visible row instead of empty `resync_required` state. The
restored source hash matches the reviewed hash above. This supports the test's
ability to catch the original failure; the log alone does not prove other
expiry schedules or production authorization.

## Remaining integration contracts

- Gateway authorization on every snapshot/poll/reconnect, server-owned workset
  membership, access epoch enforcement, session expiry and revocation teardown
  are not implemented or proven by this client adapter.
- Membership, row count and retained text bounds do not bound response bytes
  before `response.clone().json()`. Enforce response-byte and lease limits at the
  gateway; do not describe this adapter as independently memory-bounded against
  an arbitrary upstream response.
- `onAccessBoundary` delegates clearing external detail/Query caches and selection.
  Callback invocation tests do not prove those caches are actually cleared. The
  controller integration must verify clearing and rejection of late detail loads.
- Client workset expiry produces `resync_required`; it is not proof of an
  authentication event. Server/session integration must call the appropriate
  access-loss boundary rather than relying on a workset timer alone.

This review does not certify production readiness, authenticated server behavior,
browser performance targets, or deployment. No remaining source correctness
blocker was identified for this scoped client adapter. The integration contracts
above remain release prerequisites.
