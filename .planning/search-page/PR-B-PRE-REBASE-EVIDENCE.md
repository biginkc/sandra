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

## Re-run on PR A fast-path base (68482492; migrations 110000/110050/110055/110100)
tsc clean; unit 5,988; RTL 1,803; search_properties + oracle 91/91 (0 disagreements); filter-local 45 pass + 1 skipped
(page load 2 evals, head count 1); Playwright 3 Search specs + filter contract/drawer 49/49; Search volume 3/3
(baselines 168/26/83 ms, worst page p95 below budget, select-all at 20,000 = 2.50 s).
Harness fix: the volume seed's per-batch `refresh_property_filter_cache` crawls (31 min, one transaction) once 110055
drops the flag partial indexes; the seed now sets the message flags with one set-based UPDATE. Production maintains
flags incrementally, so this is a harness-only issue.

## RC test-review pass (Fable + Astra), sandbox with main's migrations (110000, 110050, 110100)
Mutation harness (`SEARCH_PROPS_MUTATION`, each must fail >=1 test; baseline 93/93 green):
drop-org-gate 24 fail, drop-agent-join 10, drop-deleted-at 17, drop-like-escape 4, add-limit-100 2,
drop-sms-channel 4, auth-uid-null 63, drop-length-cap 1, drop-structured 2.
New coverage: org B + cross-org anomalies (both builders), nullable-sort pagination (market/address/created_at/id,
both directions, 37-row pages), >1000-row match set, phone_3, cross-org linked contact, tsquery metachars next to
real terms, page-loader-shaped evaluation budget (2), legacy DNC regression vs main, filter selections for every
select-all action, server-derived dialer skip counts. Playwright 49/49, volume 3/3 (select-all 20k in 2.1 s).
