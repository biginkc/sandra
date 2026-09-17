# Sequence readiness browser lane

`playwright.sequence-readiness.config.ts` is the local-only Phase 4 browser
lane. It assumes the disposable Supabase stack is already running at
`127.0.0.1:54321`/`127.0.0.1:54322`; the config never loads `.env` files and
never starts or stops Supabase.

The lane starts three loopback processes: a token-protected provider ledger,
an external HTTP probe, and the Next app. The app and probe load
`tests/sequence-readiness/deny-external-http.cjs`, which rejects non-loopback
HTTP before the request reaches the network and records a sanitized event in
the ledger. The app builds once and then runs from Next's production server
on loopback before Playwright starts. The build uses the offline Google-font
transform fixture, so Turbopack does not contact a font provider. A disposable
worktree may use a node_modules symlink into the exact-deps cache; the
production browser build requires fresh CI validation, while local runs must
use a project-root dependency installation when Turbopack rejects an external
symlink target.
Playwright also installs a browser-context route that aborts
non-loopback `http` and `https` requests before network and records only their
origin, path, and method. Local app, API, and asset requests stay allowed. The
browser test verifies both denials and that the app loaded the server guard.
`tests/sequence-readiness/google-fonts-mock.cjs` is passed through
`NEXT_FONT_GOOGLE_MOCKED_RESPONSES`; the production Turbopack mode supplies
local font faces, while the development fixture can use bundled font bytes.
This tests offline compilation rather than remote font fetching and retains the
egress guard. The production browser server omits `E2E_AUTH_BYPASS` and uses
the real local password session. Its mock-provider ledger exception is
enabled only by `SEQUENCE_READINESS_PRODUCTION_BROWSER=1` together with the
exact disposable loopback identity and endpoint checks in the mock provider.
No provider credential or outbound provider request is permitted.

The disposable runner can launch it in the same isolated project by setting
`SANDRA_CANARY_BROWSER=1`; the runner forwards generated local keys and a
run-scoped auth identity to Playwright without printing them:

```sh
SANDRA_CANARY_BROWSER=1 \
SANDRA_CANARY_DOCKER_HOST=unix:///path/to/dedicated/docker.sock \
node scripts/run-disposable-canaries.mjs
```

For an already-running disposable stack, run it only after the runner has
printed its local status and export the generated local keys:

```sh
E2E_DISPOSABLE_DATABASE=1 \
TEST_SUPABASE_URL=http://127.0.0.1:54321 \
TEST_SUPABASE_DB_URL=postgresql://postgres:postgres@127.0.0.1:54322/postgres \
TEST_SUPABASE_ANON_KEY="$ANON_KEY" \
TEST_SUPABASE_SERVICE_ROLE_KEY="$SERVICE_ROLE_KEY" \
npx playwright test --config playwright.sequence-readiness.config.ts
```

The suite exercises sequence create/edit/enroll, reload persistence, paused
state, resume, cancel, and the non-admin authoring boundary. Database checks
use the run-scoped service-role client against the exact loopback target and
are limited to the disposable tenant fixtures.

CI installs Chromium and sets `SANDRA_CANARY_BROWSER=1`, so the normal
disposable lane runs the integration suites and then this browser lane against
the same fresh local database. For browser-only diagnostics, set both
`SANDRA_CANARY_BROWSER=1` and `SANDRA_CANARY_BROWSER_ONLY=1`; the runner still
provisions and tears down a fresh database, records `testLane: "browser-only"`
in the manifest, and intentionally skips Vitest.
