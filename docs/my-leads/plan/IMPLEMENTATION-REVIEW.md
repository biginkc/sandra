# Implementation review checkpoint

This is the first assembled implementation review/fix round for this isolated feature. Packet reviews and complementary data/query reviews belong to this same round; they do not reset the cumulative three-round limit. Browser-reproduced blockers are recorded separately below. The earlier REVIEW.md covers planning documents only and is not code approval.

Source remains uncommitted on Sandra baseline `8c7053e7024433f46791eac1b186c1b7a7cf10ec` and Jitter baseline `2c00aafa46e4e29e4c20a496c3561fac0e9143eb`. A final source manifest and complete acceptance run are pending. No release approval is claimed.

| Finding | Disposition / evidence |
|---|---|
| Direct contract from Not contacted failed without queue state | Fixed transactional queue initialization; authenticated full-schema fixture and private launch verifier passed. |
| Launch excluded genuine pre-feature leads without an episode | Fixed nullable prior episode and rollback-to-absence; fresh full-schema preview/apply/replay passed. |
| Reconciliation could lose original performer/provider identity | Fixed strict original actor and provider alias linkage, bidirectional arrival order, linked-identity guard; private SQL and focused provider tests passed. |
| Appointment reschedule predecessors inflated KPI denominator | Fixed canonical exclusion; private SQL regression passed. |
| Appointment detail used mutable assignee | Fixed immutable booking actor plus separate current assignee for lifecycle controls; SQL and adapter regressions passed. |
| Offer/decline allowed future/infinite event timestamps | Fixed finite/nonfuture event checks and finite follow-up ordering; private direct-RPC regressions passed. |
| Detail omitted permanent DNC filter; address search omitted ZIP | Fixed by query owner; private SQL assertions and fresh full-schema/browser checks passed. |
| Former-assignee detail access alleged required | Not accepted as a scope expansion: the contract preserves historical KPI attribution and access after designation removal, not unrestricted current property detail after reassignment. Keep current-assignment authorization. |
| DNC receiver alleged to authorize calls | Corrected review: receiver records authenticated historical fact; existing Sandra eligibility and Jitter fail-closed egress checks govern calling. Live parity/race evidence remains a release check. |
| Disposition CHECK widening alleged incompatible | Source values are compatible. Target inventory/lock timing remains release preflight; no proven omitted legacy value. |

## Browser-reproduced blockers

- Duplicate page heading: fixed wrapper duplication.
- Mutation revalidation unmounted newly opened detail: fixed initial-prop effect dependency; independent client RTL regression passed.
- Member handoff could not select the configured recipient: fixed with a narrow recipient DTO without widening member roster/owner controls; fresh sequential browser handoff passed.

Browser test authoring defects (ambiguous labels and mismatched inline validation/checkbox locators) were corrected as test defects. Focused continuation runs are not substituted for a final fresh-cohort sequential acceptance run.
