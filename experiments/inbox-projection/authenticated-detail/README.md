# Authenticated detail SQL candidate

Both v1 and the separately installed v2 passed five grouped auth checks on the owned offline canonical-schema fixture on 2026-09-13. V2 is the preferred candidate after actual nested-plan testing exposed a v1 deep-pagination scan. `evidence.json` contains the exact SQL/harness hashes; `cleanup.json` confirms no idle transactions and an enabled canonical head trigger. This is an isolated database routine, not an installed application endpoint or production migration.

The initial seed failed the real `FINAL_OWNER_GUARD` because it attempted a member without an active organization owner. The timestamped failure receipt is preserved. The harness now creates a separate synthetic keeper owner before the tested member in each unique organization. The successful continuation checked the installed candidate function body, postgres owner, stable volatility, security-definer flag and empty search path before using new fixture IDs. It did not disable a trigger, reset the database or replace the installed function.

## Contract

`inbox_t2_authenticated_detail.detail(org uuid, conversation uuid, before timestamptz = null, before_id uuid = null)` returns requester/org/conversation, decimal-string `head_revision`, and up to 50 ordered messages. Each message includes UUID, raw PostgreSQL timestamp text, body, direction, raw read timestamp and decimal-string inbound revision. Both cursor components must be supplied together. Pass the exact returned timestamp string back; do not round it through a JavaScript Date. An exhausted cursor returns `history: []` while retaining the valid conversation's head.

The canonical database has no independent conversation entity table. Existing outbound-only SMS history is therefore a valid zero-head conversation. An unknown UUID or a conversation with no remaining SMS records is denied; retained head counters alone are not treated as a conversation authorization registry. This preserves the current resolver's message-backed identity semantics.

One SQL statement reads the arrival head, a materialized page of covered `(id, created_at)` keys, the primary-key message bodies with repeated organization/conversation/SMS checks, and explicitly ordered JSON. The stable routine also uses the calling SQL statement's snapshot for its preceding authorization/scope query. It never acknowledges or marks a message read. The harness invokes it in `BEGIN READ ONLY` transactions.

## Authorization evidence

Source behavior inspected:

- `supabase/migrations/20260728150000_hugo_access_authorization_hardening.sql`: active membership requires matching `auth.uid()`, active status, no deletion preparation, and unexpired access. The general helper also allows service-role claims.
- `supabase/migrations/20260816150000_sms_conversation_org_guard.sql`: conversation UUIDs can span organizations. More than one active-membership-visible organization raises `SMS_CONVERSATION_ORG_AMBIGUOUS`. The resolver bypasses its membership branch under `current_user = postgres`.

This routine explicitly requires non-null `auth.uid()` and `auth.role() = authenticated`; it evaluates the actual membership lifecycle predicates itself. It does not invoke the existing resolver from a postgres definer or inherit its owner bypass. Expiry uses the request statement timestamp. A supplied organization cannot select one side of an ambiguous conversation UUID. The private schema/function permit authenticated execution and deny anonymous and service roles.

The fixture sets trusted request claims through SQL and checks precise error code/message outcomes. It verifies revoked, suspended, expired, deletion-prepared, missing-user, other-user, wrong-organization, unknown-conversation, anonymous and service-role denial. This demonstrates SQL authorization conditional on trusted identity context; it does not verify JWT signatures, session expiry/revocation, a PostgREST exposure configuration, HTTP behavior or gateway response-time authorization rechecks. A revocation committed during an already running statement is outside that statement's snapshot; the gateway must recheck before returning protected data.

## Reproduction

Only after receiving an exclusive window for this already owned offline fixture:

```sh
python3 experiments/inbox-projection/authenticated-detail/run.py --run-owned-fixture --continue-installed
```

On a matching fixture without this private schema, omit `--continue-installed`. Neither mode drops existing objects. Preserve successful evidence before rerunning. Every run uses new IDs and names, retains synthetic fixtures and private candidate objects, and bounds subprocess/SQL waits. The source-arrival holder has bounded readiness and cleanup plus a server idle-transaction timeout. Only normal cleanup was exercised; process-death fallbacks were not fault-injected.

## Limits and next checks

This proof checks exact ordered IDs across 50+24 records with microsecond timestamp ties and the empty next page. A held uncommitted inbound arrival is absent from both head and history; after commit, both appear with the same positive revision. It does not inject a commit at an arbitrary point inside the function or test a rendered-page acknowledgment.

The original routine's optional cursor OR was subsequently measured and corrected in a separate v2 function; see the actual RPC plan results below. Authentication, cursor decoding, final ordered JSON and pooled execution can all change execution plans. Small/empty conversations, realistic membership counts, concurrent writes and visibility-map churn still require broader plan testing.

No signed read boundary, receipt, write acknowledgment, HTTP handler, browser integration or production performance target is claimed here. Existing Inbox/Outbox application files and public migrations are unchanged.


## Actual RPC nested plans and explicit v2 correction

`plan-probe.py` loads `auto_explain` as the fixture superuser in an individual session, enables nested analyzed JSON plans and buffers, disables per-node timing and parameter-value logging, and then executes the real candidate as authenticated. All settings are local to a rolled-back transaction or the disposable session. This follows the [PostgreSQL 17 auto_explain documentation](https://www.postgresql.org/docs/17/auto-explain.html). No global configuration or extension installation was used.

A temporary synthetic keeper membership in the existing 100,000-message target organization is rolled back after each case. The actual stable function's authorization query, head/page/body query and outer invocation are retained. All four cases compare exact ordered IDs to a direct scoped oracle. The deep cursor sits after the first 90,000 records; OFFSET is used only to construct the test boundary, never in the candidate RPC.

| Actual nested history plan | Original v1 generic deep | Separate v2 generic deep |
| --- | ---: | ---: |
| Returned covered keys | 50 | 50 |
| Earlier keys rejected by filter | 90,000 | 0 |
| Key-scan heap fetches | 729 | 10 |
| Key-scan shared buffer hits | 1,054 | 7 |
| Primary-key body lookups | 50 | 50 |

V1's generic plan applied the optional cursor OR as a filter instead of a cursor index condition. Its first page and custom deep plan looked healthy, demonstrating why those checks alone were insufficient. Evidence is preserved in `rpc-plans-20260913T123403/`. Correct IDs did not imply bounded database work.

`setup-v2.sql` installs **detail_v2**, preserving the original detail function, setup.sql, original evidence.json and archived run-v1.py. V2 uses two explicit static statements: the first-page statement has no cursor predicate; the cursor statement has a direct tuple range. Each branch still composes head, limited keys, bodies and ordered JSON into one statement. The authentication and ambiguity logic is unchanged. No force-generic/custom setting was embedded in the function.

V2 reran the full auth/held-arrival correctness suite (`evidence-v2.json`). Its actual nested custom/generic first-page/deep-page plans all returned 50 scoped keys with no filter rejections and 50 PK body lookups. Both deep plans push the cursor into the index condition. See `rpc-plans-20260913T123456/`. The retained authorization plans also show the real membership lookup and per-membership existence probes, rather than omitting authorization from the experiment.

Reproduce the already installed v2 candidate only during an exclusive owned-fixture window:

```sh
python3 experiments/inbox-projection/authenticated-detail/run.py --run-owned-fixture --candidate-version v2 --continue-installed
python3 experiments/inbox-projection/authenticated-detail/plan-probe.py --run-owned-fixture --candidate-version v2
```

The rollback checks found no retained temporary membership. `cleanup-v2.json` records no held transactions, the enabled canonical head trigger and a fresh session's default `plan_cache_mode=auto`. Rollback can still leave dead index tuples from fixture inserts; these tests do not claim physically zero database footprint.

These are actual nested database-function plans, not bare-query extrapolations, but still not a production guarantee. Forced custom/generic modes exercise alternatives rather than a driver's automatic transition. The isolated warmed fixture does not measure network time, concurrent ingest, visibility-map churn, latency percentiles, token validation or a deployed HTTP/PostgREST route. Original and revised receipts remain separate so the failed bounded-work claim cannot be hidden by the correction.
