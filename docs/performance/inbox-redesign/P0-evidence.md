# P0 evidence and dependency record

Status: started; no candidate comparison or implementation performance claim.

## Scope

P0 gathers workload and timing evidence and freezes performance budgets before
choosing a read architecture. Current old Inbox and Outbox remain unchanged.
Production thread opening marks read; browser measurements require isolated or
authorized synthetic data. Use ordinary user access for representative timings.

## Required evidence

| Evidence | Current result | Remaining work |
|---|---|---|
| Main baseline | 269d44ca at worktree creation | Recheck before implementation/PR |
| Production deployment | Not verified | Record deployed SHA and configuration |
| Catalog/index definitions | Script prepared, not run | Bounded authorized metadata snapshot |
| Conversation click baseline | Historical reports only | First open/revisit p50/p95/p99 |
| Current volume/distribution | Partial estimates only | Conversation/history/unknown skew |
| Incoming activity | Not measured | Peak arrivals and concurrency |
| Candidate comparison | Not started | Freeze workload and budget first |
| Inventory parity | 50 mapped entries | Each needs actual evidence |

`catalog-snapshot.sql` gathers only table estimates, index definitions and
function hashes in a read-only transaction with statement/lock timeouts. It
does not prove index usage. Do not output connection strings or retain raw
customer traces. Function hashes need a same-version isolated migration baseline.

## Existing work to resolve before touching overlapping paths

Read-only GitHub inspection on September 13 found these open draft PRs:

- #514: independent conversation loading; its description reports missing
  authenticated preview acceptance. Do not treat earlier code review as current
  end-to-end proof.
- #518: scoped refresh and performance instrumentation; overlaps proposed P0/P1.
- #521: reply/switch stability; reported browser/fixture failures and incomplete
  cleanup mean no passing acceptance should be inferred.
- #418: remove unrelated page work; old rebase/verification gaps remain stated.

These are potential overlap, not accepted dependencies or active assignments.
No branch code has been copied. Review exact current heads and choose a documented
integration boundary before changing their paths. If reuse depends on validated
unmerged work, obey repository dependency/stack rules. Do not revive historical
orchestration or assume another owner's changes may be merged.

## Candidate-neutral first read contract

Inputs: authenticated session, canonical conversation identity, optional opaque
history cursor and bounded page size. Server derives organization; never trusts
browser-supplied tenant authority. Output: correct conversation identity, bounded
ordered history, next cursor, display context, authoritative context revision
information and explicit access/loading errors. No mark-read or other mutation
in this read. Controls still validate current safety at action execution.

Client must discard superseded A responses after opening B, clear protected
cache on access changes, and only mark read after the intended detail renders.
Measure detail separately from list/search/counts. No projection or vendor
implementation is selected by this contract.

## Exit artifact

Record numerical budgets approved by the user, exact fixture distributions and
arrival schedule, repeat count and warm/cold conditions, baseline and candidate
percentiles, safety/parity results, candidate decision and unresolved risks.
First benchmark candidate 1. Move to candidate 2 only on budget/correctness
failure; candidate 3 initially receives a paper assessment. Never mark a budget
passed from service-role metadata timings or a tiny demo dataset.

## September 13 progress

- Initial user-approved targets and 50-recipient cap recorded in
  `approved-budget.md`; remaining search/list/ingestion targets are not fabricated.
- Main baseline updated to 7912891c. Dependency review resolved overlap as
  independent additive work, without copying unreviewed branches.
- New candidate-neutral request/cursor validator has 19 passing unit tests.
  Page timing helper and existing page regression lane have 17 passing tests
  with timing off and on. Typecheck and focused lint pass.
- Independent peer review found no P0 blocker in validator/catalog capture.
  Before P1 freezes response types, add explicit reconciliation metadata and a
  deliberate message projection; the current response type is provisional.
- Catalog SQL successfully ran on the exclusively owned local stack, in a
  read-only transaction. This does not establish production schema parity.
- Production Supabase CLI authentication failed with Unauthorized. User asked
  to restore login; isolated work continues.
- Owned Colima profile `inbox-redesign-20260913` hosts the isolated Supabase
  project at API58421/database58422. No other Colima profile was started or
  selected as the user's default. Local keys are retained outside the repository.
- Repository verification initially lacked explicit local DB configuration, then
  a nested rehearsal needed PG connection settings. The corrected run explicitly
  targets the owned local cluster using the Node24 runtime. These failed setup
  attempts are not passing product-test evidence.
