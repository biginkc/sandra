# Actual local Inbox application proof

This owned fixture connects the actual Next application and middleware to pinned GoTrue, PostgREST, canonical Inbox SQL, and Electric. It does not replace the Auth user endpoint or fabricate authenticated middleware responses. It uses the application's existing development-only password-test lane; production Hugo OAuth is not exercised.

## Ownership and limits

- Exact guarded T2 container: `603c10117cb7ef6a07d81448dd1a25b0c1ee2787a59f75871015c4a416cac557`, network `none`, PostgreSQL memory 512 MiB, cron jobs off.
- Separate database `sandra_inbox_install_20260913`, marker `sandra-inbox-production-candidate-owned-synthetic`. Existing T2 Auth and other fixtures are preserved.
- Real vendor Auth migrations own the complete Auth foundation. The candidate installer subsequently replays application migrations without modifying the Auth foundation.
- GoTrue and PostgREST each have 128 MiB limits and separate temporary roles. Dedicated Electric has a 512 MiB limit, one CPU, manual publication of only `inbox_bridge.summaries`, and a separate replication role.
- All service traffic stays in the namespace or passes through explicit host-loopback relays using `docker exec curl`. The relays add overhead; local development timings are not production SLO measurements.
- Generated role passwords, JWT signing key and synthetic login password stay in process memory. No production environment files or credentials are loaded. The Next launcher refuses ambient dotenv files.
- Auth lifecycle is bounded to one hour; application lifecycle to 55 minutes. Cleanup removes recorded child containers and roles and preserves the owned database for inspection. Do not run overlapping writers against this database.

## Sequence

1. Run `foundation.ts --create-owned-full-auth` only for a new guarded database, or `--resume-owned-full-auth` to reuse this exact marked Auth foundation. The foundation remains alive while subsequent steps run.
2. Run the separately reviewed production candidate bootstrap using `--resume-full-auth`, then install canonical Inbox and read/history components. Production defaults remain disabled; explicitly enable only this owned fixture after installation checks.
3. Run `application.ts --run-owned-installed-fixture`. It verifies FULL replica identity, starts dedicated Electric with verified `ELECTRIC_LONG_POLL_TIMEOUT=8000`, and starts the actual Next application with a sanitized environment. Read the public loopback URLs from `application-evidence.json`.
4. Run `browser.ts --run-owned-browser-proof`. It logs in through actual GoTrue, inserts only owned synthetic contacts/messages, publishes summaries through canonical snapshot/publish, and verifies the browser against real APIs. Canonical publication is explicit fixture setup; this does not prove production worker scheduling.

Use Node 22 through `/opt/homebrew/opt/node@22/bin`. The scripts require explicit modes and must run from this worktree. Generated evidence is a result, not a claim that an unexecuted step passed. Failure artifacts preserve the first observed behavior.

## Initial foundation findings

The pinned GoTrue image requires `DATABASE_URL`, `PORT`, and `DB_NAMESPACE`. A dedicated login role also requires an explicit `search_path=auth` connection option when using `SET ROLE supabase_auth_admin`; role defaults were not applied by that connection transition. The failed startup source and sanitized log are retained. The successful vendor foundation contains 23 Auth tables and migration version `20260625000000`.

The page still needs remaining product flows, including authoritative bulk metadata/reply actions and unknown-sender detail integration. This fixture does not activate production or claim complete product acceptance.

## Executed application results

The actual browser baseline passed with two synthetic conversations and 55 messages in the first conversation: real workset/counts, Electric projection, selection without history fetch, detail, read acknowledgment, older-page cursor, and cached revisit. Two quiet polls completed after approximately eight seconds each. The warmed local first open measured 206 ms and cached revisit 47 ms; these are single local observations, not percentile or production acceptance results. A separate actual session deletion produced a post-fetch gateway 401 and cleared browser rows, selection and detail.

The first application run found and retained a genuine Next integration defect: reconstructed request.url used localhost while browser Origin and Host used 127.0.0.1. The reviewed shared same-origin helper corrects both workset creation and read acknowledgment without trusting forwarded-host headers. A later locator failure was a test bug: the same message appeared in the row preview and history; the successful test scopes its locator to the history region.

PostgREST request access logs are unavailable in this pinned runtime. The empty postgrestRequestCounts map is **not** RPC-count evidence. Browser API timings include actual middleware but per-RPC transport instrumentation remains to be added. `verified-idle-polls.json` snapshots the running relay record; the mutable live poll file is ignored. `source-manifest.json` records the executed source and result hashes.
