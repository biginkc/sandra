# CLOSR calculator verification

## Contract

- Workspace and saves require an active owner or active Acquisitions membership. Owners bypass the Acquisitions designation and workflow toggle; non-owners remain behind the organization's workflow flag.
- Saved calculation views follow existing active same-organization lead access.
- Listing percentage starts at 90%, can be unlocked, and is retained per snapshot. Commission stays at 4% of as-is value.
- All eleven working worksheet outputs retain intermediate precision. Broken source B16 is excluded.
- Saving writes an immutable snapshot and timeline event atomically; it never sends an offer or changes lead status.

## Independent worksheet oracle

Source SHA-256: `1017cc7835ae7f41a8d32e3228b9510fe01697c4a018f22b86df7c1061a4bdf8`.

The six fixtures in `src/lib/calculators/worksheet-fixtures.json` use cached results from independently recalculated worksheet copies: original, ordinary, decimals, zero repairs, blank repairs, and negative results. They cover B5/B17/B19/B21/B23/B26/E21/E22/E23/E24/E26. Browser tests compare all 66 displayed amounts; math tests also compare unformatted values within spreadsheet floating-point tolerance. Additional tests cover the user-supplied ARV $350,000 / rehab $50,000 example.

## Repeatable gates

- `npm run verify`: existing application typecheck/unit/RTL gates plus disposable calculator PostgreSQL rehearsal.
- `npm run test:e2e:synthetic`: real calculator component in a database-free browser harness, worksheet parity, lead attachment, lost-response retry, original-version reopen, immutable revision, detach, guide, mobile and sequential typing.
- `npm run build`: production Next.js compilation.
- `e2e/prod-canary/calculators.spec.ts`: opt-in production UI/DB test through the established Hugo-authenticated runner. It creates one marked, assigned lead with AI responder disabled; validates parity, saved snapshot/event, retry, timeline, reopening, revision, and unchanged lead/message state. Cleanup soft-deletes only that exact owned lead, retaining immutable test snapshots.

Synthetic persistence is a test double; its pass does not establish production persistence. The separate PostgreSQL rehearsal exercises ACL/RLS, membership/assignment/tenant checks, idempotency, revision allocation, atomic event rollback, immutability and merge preservation. The production canary must be reported separately.

## Review

Astra medium and Claude Opus 5 reviewed the implementation. Findings fixed during review include decimal keystroke loss, misleading expense label, missing yellow calculated cells, validation bounds, retry/revision lock order, missing source checksum, redundant lead-page queries, history pagination and percentage preservation. Final approval and deployment identifiers are recorded in the PR/release report.

## Production test access

The configured test account may be an active owner without Acquisitions membership and should retain calculator access. The canary also accepts an active Acquisitions member. At preparation time, configured credentials did not complete Hugo sign-in and Chrome had no active session. Production verification is not claimed until a valid authorized session is available.
