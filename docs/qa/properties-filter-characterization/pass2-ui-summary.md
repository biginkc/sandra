# Pass 2 Production UI Characterization

Generated: 2026-05-31T09:32:43.517Z
Project: copflsklaefwzipsrjqz
Org: 00000000-0000-0000-0000-000000000bbb
Pre-merge production deployment: dpl_Ebmqgk2eY6xKx259tVHyYQ35xnMj
Pass 1 scenarios: 272/272 passed

## Deployed Production Baseline

Target: https://sandra-sooty.vercel.app

| Pass 2 slice | Total | Passed | Failed |
| --- | ---: | ---: | ---: |
| Count matrix | 100 | 94 | 6 |
| URL rehydration | 23 | 22 | 1 |
| Saved preset save/reload/cleanup | 1 | 1 | 0 |

Failures were limited to relationship-backed filters that require embedded Supabase select aliases:

| Slice | Filter | Scenario | Expected | Rendered |
| --- | --- | --- | ---: | ---: |
| Count matrix | list_count | `{"min":1,"max":null}` | 47,140 | 0 |
| Count matrix | list_count+equity_pct | Cross-filter combo 2 | 1,950 | 0 |
| Count matrix | list_count | `{"min":2,"max":null}` | 11,134 | 0 |
| Count matrix | tag | any `6ed59b04-2631-427c-86f9-c65936f2327e` | 2,676 | 0 |
| Count matrix | list_count | `{"min":null,"max":1}` | 37,918 | 0 |
| Count matrix | tag | any `ef5918e7-9841-4008-92b5-ed0ec0c9609d` | 9,713 | 0 |
| URL rehydration | list_count | `{"min":1,"max":null}` | 47,140 | 0 |

## Local Fix Branch

Target: http://localhost:3466

| Pass 2 slice | Total | Passed | Failed |
| --- | ---: | ---: | ---: |
| Count matrix | 100 | 100 | 0 |
| URL rehydration | 23 | 23 | 0 |
| Saved preset save/reload/cleanup | 1 | 1 | 0 |

Runtime JSON outputs are intentionally kept under ignored `test-results/properties-filter-characterization/` because they contain auth-derived session artifacts during execution and nondeterministic timestamps.
