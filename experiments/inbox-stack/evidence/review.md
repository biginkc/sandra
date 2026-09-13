# T1 integration review

Scope: isolated `experiments/inbox-stack` implementation and root TypeScript/ESLint
exclusion. Reviewed independently by the existing selection/database and durable
operation agents; root integrated fixes. This is not Fable production approval.

Findings fixed:

- The fixture accepts50 targets but the screen could submit100. The lab now shows
  and enforces its50-target limit; this does not establish a product metadata cap.
- Terminal partial operations polled forever. Both completed and partial stop.
- Plain-text proxy4xx responses lost their status during JSON parsing. Status is
  now preserved; malformed command JSON returns400.
- Worksets expired after60seconds. Browser renewal at45seconds replaces the
  collection while preserving selected IDs. Late creation after unmount is disposed.
- An uncertain command could be silently reused with a different selected group.
  The new-action control is suspended while uncertainty remains; Check same request
  reuses the immutable original body/key even after selection changes.
- A stale stream callback could disable a healthy replacement. Generation identity
  is now checked before setting local error state.
- Workset renewal401/403 did not clear the receipt cache. Renewal and stream denial
  now use the same cleanup function.
- Long synthetic outcome labels overflowed fixed rows. Cells now truncate visually.
- Runtime launchers reused names without enough provenance checks. They verify
  owned identity, image digest, loopback ports, network and resource constraints.

Evidence: sibling browser, bulk, sync and ui JSON reports. Browser checks use actual
pointer/keyboard interactions; service tests use actual local PostgreSQL, Electric
and Restate. Check report timestamps/source manifest when comparing candidates.

Open limits: real session authentication, server-reset recovery, automatic gesture
scrolling, complete production writer capture, provider attempt safety,500-ID
multi-shape transport, long-run resource use and actual workload latency. Idle
five-second upstream leases currently return retryable503; the browser continuity
test verifies eventual operation through renewal, not that this is an efficient
production polling policy. These limits are not hidden by the passing lab checks.
