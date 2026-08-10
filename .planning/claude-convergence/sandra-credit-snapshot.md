# Sandra credit snapshot convergence ledger

## Goal

- `goal_id`: `sandra-credit-snapshot`
- Move the skip-trace provider balance call out of the Overview request path.
- Refresh the balance on a 15-minute schedule during 06:00–00:00 America/Chicago.
- Make Overview read only the latest stored snapshot.
- Give admins an intentional manual refresh control and show snapshot freshness.

## Plan source and alignment

- Plan source: Jarrad's approved design in the 2026-08-10 Codex task.
- Alignment: directly addresses measured fresh-tab Sandra startup latency while preserving the existing dashboard information architecture.
- Exclusions: no unrelated Messages, Prospects, Leads, provider, or dashboard-summary performance work.
- Dependency: none identified; the existing `metric_snapshots` table and cron authentication pattern are already on `origin/main`.

## Baseline

- Baseline ref: `origin/main` at `c4297c62e2b140f30184646e0600dc14ad0390e4`.
- Production observation: two fresh direct URL loads exceeded the 10-second navigation deadline; Overview was inspectable at approximately 22 and 31 seconds.
- Current cause boundary: `DashboardPage` awaits `getSkipTraceBalance()`, which directly awaits the external provider.

## Authority and safety

- Authority profile: Production-aware.
- No provider call will run during page rendering.
- No real provider call is required for local tests.
- Production database migration/application and deployment remain release gates.
- No secrets or customer data are recorded here.

## Acceptance gates

- [ ] Overview reads the latest stored balance without invoking the provider.
- [ ] Scheduled refresh is authenticated, idempotent, and calls the provider only within 06:00–00:00 America/Chicago.
- [ ] Schedule remains correct across daylight-saving changes.
- [ ] Admin manual refresh deliberately calls the provider, persists the result, and refreshes the displayed snapshot.
- [ ] Non-admin users cannot trigger manual provider refresh.
- [ ] UI shows balance health plus a trustworthy last-checked or not-yet-checked state.
- [ ] Existing last successful balance survives a provider failure.
- [ ] Focused tests, typecheck, unit/RTL tests, and production build pass.
- [ ] Manual adversarial review has no unresolved valid findings.
- [ ] Preview Chrome proof shows Overview renders from a stored snapshot without a live provider dependency.

## Tool and transport preflight

- Isolated worktree: `/Users/jarradhenry/Sites/BMH apps/_codex_worktrees/sandra-credit-snapshot`.
- GitHub CLI: available; open PR inventory checked.
- Chrome control: available and already used for the production baseline.
- Claude desktop: running, but an unrelated active local-agent session is present; unsafe to overwrite.
- Claude CLI fallback: installed and authenticated; use deterministic headless review for this loop.
- Provider CLI/API: not needed for implementation or tests.

## Iterations

### Iteration 1 — architecture review

- Claude desktop was intentionally not disturbed because an unrelated active local-agent session was present.
- The authenticated Claude CLI passed a one-word health check but returned no substantive output for three architecture-review attempts, including safe mode and direct prompt variants.
- Classification: `claude_surface_unavailable` for substantive review. Continued only because the next implementation action was scoped, reversible, and independently testable.
- Codex adversarial check: accepted the snapshot-plus-manual-refresh design; added failure preservation, explicit admin authorization, DST boundary tests, and a no-provider-read regression test.

### Iteration 2 — implementation and verification

- Implemented stored snapshot reads, intentional provider capture, Central-time window logic, authenticated cron route, admin manual refresh, freshness UI, and the 15-minute schedule.
- Focused verification: 14 tests passed.
- Full verification: typecheck passed; 1,549 unit tests passed; 503 RTL tests passed.
- Production build: passed. Existing unrelated `/templates` dynamic-render warnings remained non-fatal.
- Fallow: no changed-file dead exports or circular dependencies; complexity warnings were limited to the already branchy dashboard card plus its small age formatter. Four unused dependency findings are inherited package-level findings outside scope.
- Secrets: only existing variable names (`CRON_SECRET`, Supabase service-role configuration through the existing admin client) are referenced. No secret values were added.
- Manual review: in progress across data/cron, security/UX, and tests/runtime lanes.

### Iteration 3 — adversarial review fixes

- Three independent read-only lanes reviewed every changed surface.
- Accepted and fixed:
  - overlapping refreshes could let an older response overwrite a newer balance; added a fixed-path, service-role-only atomic RPC with a newer-wins predicate;
  - the provider request was unbounded; added an eight-second timeout scoped to the balance endpoint;
  - relative freshness text froze in open tabs; replaced it with an exact Central timestamp;
  - the no-snapshot state had lost its settings recovery link; restored it;
  - strengthened exact query, invalid value, failed write, missing secret, POST parity, admin/non-admin, and migration contract coverage.
- Re-review verdict from all three lanes: no remaining actionable findings.
- Final focused verification: 46 server/provider/migration tests and 3 component tests passed.
- Final full verification: typecheck passed; 1,558 unit tests passed; 506 RTL tests passed; 59 migration-safety tests passed.
- Ephemeral PostgreSQL rehearsal:
  - migration applied cleanly;
  - a `12:00Z` reading was stored and a later-arriving `11:00Z` reading returned `false` without replacing it;
  - authenticated execute privilege was false and service-role execute privilege was true.
- Temporary PostgreSQL cluster was stopped and moved to Trash for recoverable cleanup.
