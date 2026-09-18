# Inbox production execution — 2026-09-17

## Completion contract
Full approved core Inbox usable in production after exact-candidate security, functional, stress/recovery, pilot and deployment verification. No customer sends or production stress traffic. Sequence enrollment, permanent DNC, Undo and Outbox rewrite excluded. Dormant code or merge is not completion.

## Current verified state
- Original saved-actions candidate: c4c769e6ad08ede4838b4b384b090875233ef186; original worktree clean and retained unchanged.
- Integration/product/infrastructure start: origin/main 36ee3f8cca42496e06e25c9cf6f8fac12d7b7521.
- Railway project inventory: no sandra-inbox project in accessible biginkc workspace. No provisioning performed.
- Existing owned fixture postgres belongs exclusively to backend lane for mutations. Other lanes require dedicated marked databases.
- Earlier tests and acceptance-matrix statuses are leads, not release evidence.

## Concurrent lanes and file ownership
- Backend: release-backend; experiments/inbox-saved-actions, action-api and saved-action-api. Existing owned fixture postgres exclusive operator.
- Product: release-product; src/components/inbox-workspace, src/app/inbox, new saved-action HTTP routes/helper, associated UI tests. No fixture mutations.
- Infrastructure: release-infra; experiments/inbox-production-install, new experiments/inbox-release harness. Dedicated DB only.
- Coordinator: release-integration; dependency review, release checklist, backend contract extensions, independent verification and integration. No shared fixture mutations while backend runs.

## Gates
- [x] Separate worktrees and worker ownership established.
- [ ] Saved-actions exact-head defects reproduced and repaired; candidate approval reset on changes.
- [ ] Missing core UI and backend behavior implemented.
- [ ] Production installer and complete isolated runtime rehearsed.
- [ ] Required dependencies independently reviewed and integrated.
- [ ] Full acceptance matrix passes, no required skips/blocked rows.
- [ ] Current and 3x growth full-stack performance/recovery passes.
- [ ] Production hosting/spend and pilot identity resolved before activation.
- [ ] Guarded migrations and code deployed with flags off; runtime verified.
- [ ] Owned no-send production smoke and rollback verified.
- [ ] Pilot accepted and default enablement verified.

## Behavior ledger
| ID | Requirement | Owner | Fresh evidence |
| --- | --- | --- | --- |
| F01 | Inbox / Outbox tabs | Product / coordinator | pending fresh integrated reproduction |
| F02 | Search messages | Product / coordinator | pending fresh integrated reproduction |
| F03 | Inbox filters | Product / coordinator | pending fresh integrated reproduction |
| F04 | Needs Outcome | Product / coordinator | pending fresh integrated reproduction |
| F05 | Hide DNC & tests | Product / coordinator | pending fresh integrated reproduction |
| F06 | Pagination and ordering | Product / coordinator | pending fresh integrated reproduction |
| F07 | Open and close a conversation | Product / coordinator | pending fresh integrated reproduction |
| F08 | Read message history | Product / coordinator | pending fresh integrated reproduction |
| F09 | Automatic mark-read | Product / coordinator | pending fresh integrated reproduction |
| F10 | Conversation identity/context | Product / coordinator | pending fresh integrated reproduction |
| F11 | AI status indicators | Product / coordinator | pending fresh integrated reproduction |
| F12 | Open record / copy links | Product / coordinator | pending fresh integrated reproduction |
| F13 | Call | Product / coordinator | pending fresh integrated reproduction |
| F14 | New Message | Product / coordinator | pending fresh integrated reproduction |
| A01 | Wrong number | Product / coordinator | pending fresh integrated reproduction |
| A02 | Bad / disconnected # | Product / coordinator | pending fresh integrated reproduction |
| A03 | Not interested | Product / coordinator | pending fresh integrated reproduction |
| A04 | Follow up | Product / coordinator | pending fresh integrated reproduction |
| A05 | Needs sequence | Product / coordinator | pending fresh integrated reproduction |
| A06 | SMS opt-out | Product / coordinator | pending fresh integrated reproduction |
| A07 | Permanent DNC unavailable here | Product / coordinator | pending fresh integrated reproduction |
| A08 | Move to Lead | Product / coordinator | pending fresh integrated reproduction |
| A09 | Book appt | Product / coordinator | pending fresh integrated reproduction |
| A10 | Assign to me / teammate | Product / coordinator | pending fresh integrated reproduction |
| A11 | Unassign | Product / coordinator | pending fresh integrated reproduction |
| A12 | Confirm Sandra disposition | Product / coordinator | pending fresh integrated reproduction |
| A13 | Correct an AI disposition | Product / coordinator | pending fresh integrated reproduction |
| R01 | Write/edit a reply | Product / coordinator | pending fresh integrated reproduction |
| R02 | Insert a template | Product / coordinator | pending fresh integrated reproduction |
| R03 | Send SMS / Cmd-Ctrl-Enter | Product / coordinator | pending fresh integrated reproduction |
| R04 | Use the conversation's reply route | Product / coordinator | pending fresh integrated reproduction |
| R05 | Restriction and route-change handling | Product / coordinator | pending fresh integrated reproduction |
| U01 | View unknown sender thread | Product / coordinator | pending fresh integrated reproduction |
| U02 | Merge with existing contact | Product / coordinator | pending fresh integrated reproduction |
| U03 | Merge with existing property | Product / coordinator | pending fresh integrated reproduction |
| U04 | Create new lead | Product / coordinator | pending fresh integrated reproduction |
| U05 | Dismiss unknown sender | Product / coordinator | pending fresh integrated reproduction |
| U06 | Restore dismissed sender | Product / coordinator | pending fresh integrated reproduction |
| U07 | Resolve known contact to an existing property | Product / coordinator | pending fresh integrated reproduction |
| U08 | Create property and resolve | Product / coordinator | pending fresh integrated reproduction |
| O01 | Inspect queued message cards | Product / coordinator | pending fresh integrated reproduction |
| O02 | Send next | Product / coordinator | pending fresh integrated reproduction |
| O03 | Send one queued message | Product / coordinator | pending fresh integrated reproduction |
| O04 | Start / pause auto-send | Product / coordinator | pending fresh integrated reproduction |
| O05 | Set cadence | Product / coordinator | pending fresh integrated reproduction |
| O06 | Edit queued text / save / cancel | Product / coordinator | pending fresh integrated reproduction |
| O07 | Delete queued message | Product / coordinator | pending fresh integrated reproduction |
| O08 | Load more queue rows | Product / coordinator | pending fresh integrated reproduction |
| O09 | Queue totals and timing | Product / coordinator | pending fresh integrated reproduction |
| O10 | Recover failed queue reads | Product / coordinator | pending fresh integrated reproduction |

Additional core rows: saved-action CRUD/version binding; single/bulk selection gestures and hidden review; snapshot-scoped dismiss/restore; reviewed bulk cap and durable attempts; operation recovery across disabled UI. Each requires real persisted outcomes, not screenshot-only assertions.

## Performance acceptance
First-open p95 <=1000ms; revisit <=200ms and selection <=100ms with p95/p99/exceedances; maximum 50 reply recipients. Measure realistic current workload and 3x growth with long histories, skew, concurrent users and sustained/burst arrivals. Remaining latency/lag/resource thresholds require explicit evidence-backed resolution before acceptance. No claimed stress pass yet.
