# Offline capture-generation and real boundary-codec integration

Six checks passed using the **actual** `src/lib/inbox/read-boundary.ts` application module, imported directly into Node **v22.23.2**. This is fixture integration, not an activated API or production migration.

Exact invocation from the worktree:

```sh
/opt/homebrew/opt/node@22/bin/node --experimental-strip-types --conditions=react-server experiments/inbox-projection/capture-boundary-integration/run.mjs --run-owned-fixture
```

No new dependencies or package configuration changes were needed. Node emitted its existing typeless-package warning while loading the TypeScript module; this does not constitute a full application test run under Node22. The harness requires Node22 and an explicit fixture flag, invokes the shared immutable-container/network/cron guard, and uses bounded subprocess and SQL timeouts.

## What was installed

`setup.sql` creates the private fixture schema `inbox_t2_capture_boundary`, containing a persistent singleton UUID generation and a separate `detail(org,conversation)` wrapper. The table has a true-only singleton primary key, a non-null generation, RLS enabled, and no PUBLIC/anon/authenticated/service_role grants. Only authenticated callers receive wrapper execution, with schema usage. The wrapper and underlying `detail_v2` are STABLE, SECURITY DEFINER routines with empty search paths. The existing routine still performs explicit auth.uid/role and Hugo membership/lifecycle checks; the wrapper does not call the owner-bypassing resolver.

The wrapper reads generation and existing authenticated head/history using the **same caller statement MVCC snapshot**. Missing generation raises SQLSTATE55000; there is no zero, random or default fallback at request time. The setup script initializes the singleton once; normal reads never create it. The harness refuses an already installed integration before any fixture writes, preserving the prior run rather than resetting metadata. No canonical head was reset or source trigger disabled, and the original authenticated function remains unchanged.

Generation UUIDs are proposed authoritative persistence metadata **inside this private fixture only**. The application codec is still unused by routes, and current production SQL does not acquire this metadata merely because the lab wrapper exists.

## Recorded checks

1. An authorized database snapshot provided requester, organization, conversation, generation and decimal head `1`. The actual application codec issued a signed envelope with fresh server-generated boundary/snapshot UUIDs; verification against a subsequent authorized DB context succeeded.
2. Another requester and organization were rejected by both database scope checks and token binding. Verification at the token expiry instant failed.
3. Direct generation SELECT and UPDATE failed specifically with SQLSTATE42501 for authenticated and service_role.
4. Deleting generation inside a transaction caused detail to fail with SQLSTATE55000. The failed transaction rolled back; the singleton retained its value.
5. A detail statement paused in `pg_sleep` while a second session committed a generation rotation. The held statement retained the old generation; a later statement returned the new generation. Verification of the old token against that fresh context failed. The head remained `1`, so this did not simulate or perform a head reset.
6. The original authenticated function definition hash was unchanged, and no source message was marked read.

The dedicated signing key comes from `randomBytes(32)` and stays in process memory. Neither it nor the full token is written to evidence or command arguments. `evidence.json` records only a SHA256 token hash, codec source hash, synthetic scope IDs, checks and runtime version.

## Remaining limits

Trusted JWT claims are simulated through local PostgreSQL session settings. There is no HTTP/JWT-signature/PostgREST/gateway, browser-render, receipt, idempotency or one-use proof here. This token is replayable integrity metadata, not authorization. Every acceptance and mutation batch still requires current authoritative access and generation checks under the production transaction protocol. A generation change can commit immediately after a verification read; this fixture does not establish the necessary write-side locking/fencing.

Generation rotation **does not repair** arrivals missed through bypassed writers, disabled triggers or an unsafe restore. Existing capture fencing, writer inventory, restoration procedures and head-generation compatibility checks remain required. Production must not silently initialize a new generation while continuing to trust invalid heads. The fixture's same-head rotation only proves token invalidation, not safe production cutover.

The codec's strict future-issue rejection and 300-second maximum are current engineering policy; distributed clock behavior and user-facing timing remain unproven. Its source was not changed for this integration. Previously recorded authenticated-detail and head proofs remain separate evidence for their own scenarios.
