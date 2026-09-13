# User-approved initial performance budget

Approved September 13, 2026 in this task, in response to the explicit target question.

| Measure | Approved target |
|---|---|
| First conversation open | p95 ≤ 1,000 ms |
| Revisit a recently opened conversation | ≤ 200 ms (report p95 and p99, flag any exceedance) |
| Selection feedback | ≤ 100 ms (report p95 and p99, flag any exceedance) |
| Initial reviewed bulk reply | Maximum 50 recipients, enforced by server |

These are acceptance goals, not measurements. Measure click to first readable
correct content, separately from control readiness and selection paint. Cached
display is not authoritative permission. Record device/network, warm/cold state,
sample count, sustained arrival conditions, concurrent users and dataset tiers.

List/search/filter and ingestion budgets still require measured workload evidence
and a proposed numerical gate before the P0 decision. The user-approved four
targets do not implicitly approve arbitrary limits for those other dimensions.

## Dependency disposition

Based on exact-head review of open drafts #514, #518, #521 and #418, none is a
release-ready dependency. Build independent additive paths from main; no branch
code is copied. #518 is stacked on #514; #521 contains overlapping state machines
and conflicts. Any future reuse requires fresh validation and correct stacking.

Main was rebased to 7912891c before code work. GitHub deployment 6419416079 reports
Production success for that SHA on September 13. This proves GitHub's deployment
record, not independently observed application runtime behavior or schema parity.
