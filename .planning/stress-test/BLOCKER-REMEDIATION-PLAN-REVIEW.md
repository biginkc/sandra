# Manual review of blocker remediation plan

2026-09-13. Method: static inspection of plan, local Playwright config/spec, My Leads actions/client/form, query authentication, canonical appointment controls and workflow testing requirements. No browser execution; this is a self-review, not independent Astra approval.

Verdict: original plan required changes. Revised plan supports starting implementation, but does not yet prove every blocker is resolved.

| Severity | Finding and evidence | Resolution |
| --- | --- | --- |
| High | Config testMatch includes only my-leads.local.spec.ts; all proposed nested specs would be silently excluded. | Add testMatch and inventory gate; explicitly exclude mobile. |
| High | J18-01 treated cancellation as possibly absent. appointment-outcome-row.tsx implements future native confirmation and past-due inline confirmation. | Specify both real paths and dismiss-before-write assertions. |
| High | Arbitrary Monday/DST server-time coverage remained unspecified while claiming a path for all cases. WORKFLOW-TEST-PLAN.md disallows replacing journeys with unit evidence. | Explicit subassertion/coverage decision required before full campaign; do not claim this gap solved. |
| High | Retaining fixtures in the same org can contaminate aggregate KPI oracles; completed appointments cannot exercise open outcome controls. | Fresh run/case orgs, one active membership per identity, open elapsed fixtures and separate historical fixtures. |
| High | Lost-response test did not prove identical retry or prevent forwarder retries. client.tsx keys submissions by payload hash. | Require same key/payload hashes and one forwarding operation, then independent row counts. |
| Medium | Auth rejection may be HTTP 200 application failure; refresh revocation is not immediate access-token expiry. actions.ts and queries.ts use application errors/getUser. | Explicit expiry/refresh setup and zero-write authorization oracle. |
| Medium | Browser-only clock control and synthetic focus cannot prove hidden-tab server refresh. client.tsx reads document.hidden and uses up to 60-second timer. | Genuine headed-tab visibility plus short database-relative threshold and bounded server-backed recovery. |
| Medium | Existing provider mocks not proven to cover calendar/task side effects. | Adapter inventory and outbound containment preflight required. |

All corrections are incorporated into BLOCKER-REMEDIATION-TECHNICAL-PLAN.md. Remaining transport/time/auth preflight questions are explicitly tracked rather than represented as verified capabilities.

## Independent Astra harness review and disposition

Astra reviewed the actual preflight implementation. Findings: runtime/candidate binding incomplete; provider isolation not fully proved; retained org fixtures unsuitable for clean KPI baselines; persisted UTC checks absent; membership test does not establish token expiry; legacy mobile test still discoverable. Missing full-run gates include ownership transfer, post-commit refresh failure and durable artifacts/manifests.

Corrections applied: owned container/port guard is called before fixture writes; mobile test excluded via grepInvert; offer sent/follow-up values now derive from database time and are checked for native input validity and exact persisted UTC values. Decline preflight runs in Asia/Tokyo, independently of Central entry semantics. Both date workflows passed together (2 tests, 12.3s).

Qualification to provider finding: code inspection of completeAppointmentAction shows completion records a lead event and revalidates, without calling calendar sync; inline-sync-kick.ts explicitly excludes completion. Existing appointment preflight dismisses cancellation and never commits it. Full booking/rescheduling/provider containment still requires independent proof. This narrows the risk for existing completion evidence without claiming all provider gates passed.

Remaining findings remain open for full campaign readiness; the 84-case ledger remains NOT RUN.

### Build export fixes — independent Astra review

Astra reviewed four page constant export removals and five API implementation extractions against HEAD. No actionable findings: constants retain local consumers; extracted code is identical except maxDuration removal, with literals 60/60/800/300 retained in route modules; HTTP exports remain intact and helper test imports follow the implementations. Focused unit verification: 61/61 passed. Local production build subsequently completed successfully. Full repository verification hook is running before candidate commit.
