# Fable review of disabled P0 increment

Actual Claude CLI reviewer: claude-fable-5-1, tools disabled. Reviewed commit
b0ab82a453444034e3588cc82ea94b42dcb4aca2. Verdict applies only to this
disabled increment and remains conditional on green exact-head CI.

**Verdict: APPROVE** this disabled-by-default increment, conditional on the exact-head CI run finishing green. No code-safety blocker found. The measured claims are defensible only as narrowly stated in the docs, and the docs do state them narrowly.

Findings, ordered by severity:

1. **Medium, evidence: comparison is confounded and the old-Inbox spikes are unattributed.** The candidate path still calls the old context reader with its 100-row read and lands at roughly 230 ms. So the old detail data path is not the bottleneck. The old Inbox's 13 to 15 second first opens are labeled unexplained. Until those are attributed to list re-query, mark-read writes, render, or build mode, the result supports "candidate 1 is fast" but not "candidate 1 is why." The doc discloses this correctly.

2. **Medium, statistics: n=20 does not support p99, and revisit is a cache hit by construction.** With 20 samples p99 is the maximum and p95 is the second-highest value. Reporting to one decimal overstates precision. The 65 ms memory revisit measures a React re-render of cached JSON, so passing the 200 ms target is nearly guaranteed. The meaningful revisit number is a post-TTL network open, which is the same as a first open here. State both facts in the doc.

3. **Medium, operability: the route swallows all exceptions without logging.** The catch in the detail route returns a generic 500 and records nothing. "No browser errors" is a client-side claim only. For a measurement surface, losing server-side error and timing visibility weakens future evidence. Add structured server logging that excludes bodies and addresses.

4. **Low, exposure surface: context returns the whole InboxDetail minus three fields as JSON.** History columns are deliberately projected, but context is not. The old page rendered a subset of this object server-side. Confirm the field list is intended for client JSON. The ordinary-user client and RLS bound the risk, so this is a verification ask, not a blocker.

5. **Low, side-effect assurance is partial.** The 510-message check proves read_at was untouched. It does not prove the reused context reader writes nothing else, such as last-viewed or activity rows. A quick grep of that reader for writes closes this.

6. **Low, flag evaluation timing.** The page calls notFound before any dynamic API. If the flag is unset at build time Next can prerender a static 404, so enabling the flag later needs a rebuild. This fails closed, which is acceptable. Setting `dynamic = "force-dynamic"` would make the guard per-request and match the unit test's assumption.

7. **Low, pagination beyond page 1 is untimed.** The keyset filter is correct and well validated. The PostgREST `or` form is less index-friendly than a row-value comparison, and no older page was measured in the browser. Not needed for this increment, but it belongs on the evidence list.

8. **Low, measured head differs from shipped head.** Timings precede the cache-invalidation fix. The fix touches only the failure branch and the RTL regression passed, so the happy-path numbers remain valid. Note it, as the doc already does.

Code I specifically tried to break and could not: cursor canonicalization via re-encode round trip, duplicate and unknown query keys, pageSize coercion, PostgREST filter injection given the timestamp and UUID grammars, request-version and abort races in the client, cross-tenant reads given membership org plus RLS plus explicit org filters, and the login-redirect HTML case.

What still blocks choosing the final architecture, independent of this increment:

- Attribution of old-Inbox time by phase, ideally with server timing on the existing page.
- A candidate that includes mark-read and full render, so parity cost is known.
- Production-shaped catalog and arrival load with concurrent sessions.
- List and older-history latency, which this surface excludes.
- Selection feedback, the fourth approved target, which was not measured here.

## Follow-up disposition

- Added opt-in static server outcome/timing logs; logger failure preserves responses.
- Small-sample quantiles are descriptive order statistics: with n=20, p99 is the
  maximum, not a supported estimate of the population tail. Keep raw precision in
  artifacts for reproducibility, but report approximate milliseconds to users.
- Cache-expiry network observations were collected separately:231ms and308ms, both above the200ms target. A cache-hit
  result is not a promise of latency for every subsequent revisit.
- Context field inspection: existing MessagesPage already passes entire InboxDetail
  into client CockpitView. Current fields are conversation/contact/property/display
  routing, ownership, consent and pending-review state; no provider secret fields.
  The experiment returns that existing context minus broad message history and
  duplicate identity fields. P1 should freeze an explicit field whitelist.
- Side-effect inspection: fetchInboxDetail and suppression helper use select-only
  queries; resolve_sms_conversation_org is a STABLE invoker function containing
  reads and authorization checks. Phone helper can report an error to monitoring;
  no application-record writes occur in the inspected context read path.
- The default-off page may build as a static404; enabling the experiment requires
  rebuilding/redeploying. No claim of runtime flag activation is made.
- Older-history page correctness was executed, but browser latency beyond the
  initial page remains unmeasured. Full parity/load and old-spike attribution
  remain explicitly open before P0 exit.

The logging follow-up is later than Fable’s reviewed commit; it has focused tests
and root source review. Do not mislabel it as Fable’s exact-head review.
