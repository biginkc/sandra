# Workload evidence still needed for P0 exit

Current experiments deliberately model volume; they do not establish production
volume or arrival rates. Do not label 55,000 conversations as the measured current
production tier. Supabase CLI authentication still returns Unauthorized.

## What the retained fixture actually exercises

- 55,000 synthetic contacts/properties with one conversation each.
- Ten inbound SMS per conversation, spread across a 60-day window.
- One conversation receives another 500 messages (510 total).
- 250 additional unknown-sender messages.
- All properties are prospects with AI response disabled; no provider sends.
- Confirmed local member/owner identities; no genuine Hugo provisioning.
- No pending review population, consent distribution, outbound queued/failed
  mixture, realistic multi-property identities, concurrent operators or arrivals.
- Other isolated fixture tenants remain in the same cluster; total table size is
  larger than the browser tenant. This matters to planner observations.

## Production metadata capture after access is restored

Use bounded read-only aggregate/metadata queries with statement and lock timeouts.
Record deployed function/index hashes, estimates and plans before choosing fixes.
Collect counts and histogram buckets, not customer message bodies or raw traces:
conversation count and history-size percentiles; linked/unknown and recent/old
message proportions; inbound/outbound/state distributions; consent/review/identity
skew; minute-level arrival counts over an agreed representative window; concurrent
operator/session evidence from available logs. State missing retention explicitly.

Build the next synthetic tiers from those aggregates (current and three times
volume) and an agreed peak-arrival headroom. Verify fixture invariants first,
then measure ordinary authenticated users against frozen gates. Do not substitute
a service-role count or local query for a browser latency claim.

## Pending decisions and proofs

Initial first-open/revisit/selection/cap targets are approved. A separate question
proposes list p95 1 second, search/filter and accepted-job p95 500ms, arrival
visibility 2 seconds; it remains pending. Memory and ingestion regression limits
still need a bounded proposal informed by the workload. No final P0 selection or
production activation follows from the current partial results.
