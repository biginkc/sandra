# PR B pre-rebase evidence (head 3a168a87, base PR A 5f1f50ec)

Private sandbox `sandra-search-e2e` (ports 54321/54322), pinned CLI 2.109.1 applied all three migrations
(110000, 110050, 110100). Container identity (`supabase_db_sandra-search-e2e`) checked before each DB command.
Never 54329 or hosted. Migration sha256 `1b138e5256b8b79f816a0e5aff6e300958465d64fdfbba6210aff571ac46f7eb`.

| check | result |
|---|---|
| Search volume (50k props / 250k SMS, reseeded), fail-closed baseline check | 3/3 pass |
| baselines p95 (alone / +wrong_number / +all lead stages) | 279 / 20 / 70 ms |
| worst search page p95 | 129 ms (budget 1500 ms) |
| ratio cells >3x | common surname +wrong_number 5.5x (baseline 20 ms), word +wrong_number 4.1x; both baseline < 50 ms noise-floor exemption |
| select-all at cap 20,000 | 2.50 s (budget 10 s) |
| search_properties integration + oracle comparison | 91/91, 0 disagreements |
| filter composition + evaluation budget + PR A suites | 42 pass, 1 skipped; page load 2 evals, head count 1 |
| dnc-safe filter-branch parity + workflow skippedLeads tests | 16/16 (mock-based) |

Note: the volume reseed leaves an owner membership without a user, so run the DB integration suites BEFORE it or
clear `public.memberships` and `svol-*` auth users first (sandbox only).
