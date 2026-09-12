# E2E reliability investigation

Base: `8df519abac5a15c023a9ead209dac90312383028`. Incident: [run 34667054536](https://github.com/biginkc/sandra/actions/runs/34667054536).

## Evidence and conclusions

- Attempt 1 failed before the DNC assertion: a fixture reset RPC and a subsequent notification deletion returned Gateway Timeout. The message does not establish whether the database was overloaded, waiting on a lock, or inaccessible through its gateway. The existing helper discards HTTP status and database error codes. Do not classify this as a DNC application failure or retry an ambiguous reset indiscriminately.
- Attempt 2 initial heading failure: RSC response headers arrived after 236 ms; the retained trace contains neither a complete body nor a response-end time before the five-second assertion expired.
- Attempt 2 first retry: RSC response took 5,708 ms; the body contains the expected heading. It finished approximately 175 ms before the assertion deadline. This supports a synchronization problem, not a missing heading assertion.
- Attempt 2 second retry: selecting the teammate issued the correct RSC request. HTTP 200 headers arrived after 313 ms, but the body was unfinished at assertion expiry. This was not a missed select event. An HTTP status is insufficient to establish a completed navigation.
- Attempt 3 was cancelled under the deployment waiver. All three exact-run identity cleanups succeeded. Cancellation is not test success.

Playwright distinguishes response headers from response completion; see its [request lifecycle](https://playwright.dev/docs/api/class-request). Traces remain in protected temporary storage because they can contain authenticated test data.

## Bounded synchronization change

The two affected uncached navigations wait for the matching server response body before applying the existing URL, heading, and positive/negative row assertions. HTTP failures and aborted bodies remain failures. No test/expect timeout or retry count is increased. This does not prove that hosted response latency is acceptable, and it does not establish Turbopack as the root cause.

Preserve the five serial server groups and the two existing Webpack navigation tests while investigating. Production-server substitution is not a drop-in change: the current test authentication bypass deliberately refuses production mode. Preserve the static workflow queue and transaction-scoped advisory lock.

## Local evidence

A new task-owned Colima/Supabase stack at loopback ports 54321/54322 replayed all 230 current migrations. It uses no hosted/provider credentials. The existing job-identity lifecycle arms its protection snapshot and the same two namespaced principals are reused throughout this local campaign.

- Original foundation: 2 tests including authentication passed, zero retries, 30.1 seconds.
- Foundation with response synchronization: 2 tests passed, zero retries.
- Original exact-number DNC refusal: 2 tests including authentication passed, zero retries, 15.3 seconds.
- Controlled streamed-response browser reproduction: HTTP 200 and early URL commit still produced the original five-second missing-heading failure; releasing the body let the new synchronization and unchanged heading assertion succeed.
- Focused ESLint and TypeScript passed for the initial synchronization candidate. Changes after that checkpoint require fresh validation.

Complete-suite verification, hosted database diagnosis and final cleanup are recorded below as they complete. Local results are not a hosted release certificate.

### Full-suite discoveries and focused corrections

The first serial group ran without retries: 42 passed, one existing real-provider skip, two unknown-sender triage failures. Both failed while clicking a menu item that became detached during opening. The shared helper called `isVisible({ timeout: 1500 })`, which checks immediately, then tried Escape/Enter and a forced click. A delayed-menu regression reproduced three trigger actions instead of one on the original helper.

The helper now clicks once and uses its existing ten-second visibility assertion before the normal item click. The delayed-menu regression passes, and all 13 real-app triage tests pass without retries in 26.8 seconds. The four combined network/menu synthetic tests pass in 7.3 seconds. Independent manual review rounds 1 and 2 found no blocking source corrections. Separate gpt-6-astra / medium source approval passed; see the review receipt. Complete-suite acceptance is recorded below.

The initial local cleanup hit `FINAL_OWNER_GUARD`: these were the fresh database's only principals, unlike a hosted test project with existing owners. Recovery was confined to the disposable loopback database: assert exactly two run-owned users and exclusively owned memberships, reset task fixtures, restore the originally empty membership baseline, then invoke the unchanged exact-run Auth cleanup. It removed both principals, and SQL verified zero Auth users. No production guard was changed or disabled. Subsequent local cleanup uses the same checked baseline restoration.

Hosted log diagnosis is currently access-limited: the saved Supabase CLI credential and a direct Management API project metadata request both returned Unauthorized/401. No hosted SQL, reset, Auth mutation or configuration change was performed. A restored Supabase login is needed to distinguish backend locks from gateway/service instability in the original incident window.

## Test retirement and deployment boundaries

The separate [canary retirement audit](canary-retirement-audit.md) identifies four defective old implementations, but no verified immediate deletion. Preserve unique coverage until replacement verification. Sequence PR 517 is still open and must not be overwritten. Messages/My Leads expanded coverage discussion is deferred at Jarrad's request.

This branch is excluded in `vercel.json` before publication because new branches otherwise permit automatic previews. No merge, deployment, production migration, real message/call, feature enablement or real-lead mutation is authorized.

## Functional sidebar defect found during complete verification

The next complete run passed the first four groups (44 + 59 + 25 + 2 tests; seven existing skips), then exposed a separate product defect in the final Webpack group. At the unchanged 1280×720 viewport, Jobs was below the sidebar edge. Playwright's trial click repeatedly reported “element is outside of viewport”; the screenshot confirmed the navigation had no usable scrolling region after the additional My Leads link.

The bounded fix adds `min-h-0 overflow-y-auto` to the sidebar navigation within its fixed-height flex container. No link, route, permission condition, browser assertion, timeout, retry, or viewport was changed. Sidebar RTL (two tests), ESLint, and the focused Webpack browser group (three tests, zero retries, 54.2 seconds) pass. Independent manual round 3 and refreshed separate code approval both pass. The fresh complete five-group run passed with zero retries: 44 + 59 + 25 + 2 + 3 = 133 passed; seven existing skips. Every group used a fresh development server and a separate artifact directory. Exact-run cleanup then succeeded and SQL verified zero local Auth users.

Local parity limitation: this campaign uses macOS Chrome and Node 26.8.1, while hosted CI uses Ubuntu Chrome and Node 24. The private local database validates current migrations and application behavior but cannot prove hosted gateway stability.

## Required repository verification

`npm run verify` passed from a clean generated-artifact state: 12 atomic migration tests, the local eSign migration rehearsal, TypeScript, 3,778 unit tests in 344 files, and 1,268 component tests in 118 files. This is the command required by the tracked pre-commit hook; it was run explicitly because dependency installation used `npm ci --ignore-scripts`.

The first invocation after browser testing failed TypeScript on generated `.next/dev/types` for campaigns, jobs, lists, and templates: their exported sortable-column constants are not permitted page exports. All four page sources were byte-compared against the base revision and are unchanged. The generated development artifacts and original failure log were retained in private temporary storage before rerunning verification without `.next`, matching the clean checkout state. This remains a pre-existing generated-type/build limitation, not a claim that every possible build gate passes. No source/type exclusions were added to hide it.

Browser-generated tracked screenshots were restored to the base revision; this task contains no visual mockup updates.

The complete separate synthetic browser gate passed: 76 tests, zero retries, 2.2 minutes, including the delayed menu, streamed response, HTTP error, and aborted response regressions.
