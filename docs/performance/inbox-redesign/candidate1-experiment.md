# Candidate 1: independent detail-read experiment

This is a bounded P0 experiment, not a production Inbox replacement or P0 exit.
The page and endpoint require INBOX_V2_EXPERIMENT_ENABLED=1; shared authentication
middleware still runs even when the local route guard returns not-found.

The first 200 rows use the existing list reader. Clicking a row fetches the new
ordinary-user authenticated detail endpoint, without reloading the list. The
page caches at most 20 conversation displays for 30 seconds. Network opens and
memory revisits are reported separately. It never marks read or executes actions.

Independent source review found no blocker in tenant checks, validated keyset
pagination or error handling. Focused checks: 32 contract/reader/endpoint unit
cases, two page guard cases and five client behavior cases passed; production
build passed. Real backend and browser evidence are recorded separately.

## Interpretation limits

- This minimal page excludes dashboard overhead and full Inbox controls.
- It renders latest 50 messages; the old Inbox can render 100. The reused context
  reader still fetches 100 internally; that duplicated work is not optimized yet.
- Old Inbox marks read; this read-only experiment does not. Timing improvement
  cannot be attributed solely to removing list queries.
- Context, history and latest inbound are separate observations, not an atomic
  snapshot. Cached display is not authority to send, assign or change an outcome.
- No continuous permission revocation, incoming-message reconciliation, search,
  filter, older-history UI, or bulk operations are implemented here.
- Local confirmed synthetic password sessions exercise domain and fixed-tenant
  middleware, not genuine production Hugo authentication.
- Serial clicks on synthetic data do not establish production, arrival-load,
  concurrent-user, full parity, or final architecture acceptance.

## Executed result

On the 55,000-conversation synthetic local BMH fixture, 20 network first opens
measured p50 231.4ms / p95 238.5ms / p99 248.3ms. Twenty memory revisits measured
p50 64.7ms / p95 65.4ms / p99 65.5ms. All sampled values were inside the initial
user-approved open/revisit targets. Initial list was 1,813.7ms. No browser errors
or external requests occurred. See browser-candidate1-55000-40.json.

The expanded old-Inbox run measured first-open p50 2,401.6ms / p95 14,448.6ms
and revisit p50 1,864.4ms / p95 1,898.7ms. Several first opens included unexplained
13–15-second delays; no assertion is made that all that time was database work.
Both runs used 20 first opens followed by 20 revisits in the same row order, on
the same owned fixture. Different rendering/action costs remain disclosed above.

Real backend validation passed 31 checks: ordinary-member paginated responses
matched authoritative rows; tenant rejection and invalid parameters worked; all
510 tested messages retained their read state. Anonymous traffic hit the existing
middleware login redirect, not the endpoint-local 401. See endpoint-correctness.json.

This supports continuing candidate 1. It does not justify a vendor replacement,
final P0 sign-off or production activation. Production catalog/workload evidence,
full rendering and mark-read parity, live reconciliation and list performance
remain open. The production experiment flag remains unset.

Final review found and fixed cache retention after a successful HTML login redirect.
A regression test now proves a failed current read invalidates other cached displays.
Recorded browser timings precede this error-path-only correction.
