# Native sequence reliability mutation runs

`run-sequence-reliability-mutations.mjs` is a single-mutant harness for the
native sequence path. It is intentionally separate from the disposable canary
runner and must run against a clean pinned commit in a fresh temporary
worktree.

The harness requires a dedicated local Docker socket:

```sh
SANDRA_CANARY_DOCKER_HOST=unix:///private/tmp/sandra-sequence-docker.sock \
  node scripts/run-sequence-reliability-mutations.mjs --list
```

Before a run, the exact source substitutions and selected test names can be
checked against a dirty working candidate without starting Docker or changing
any file:

```sh
node scripts/run-sequence-reliability-mutations.mjs \
  --check-patches --mutation=suppression-bypassed
```

For an execution, first choose a clean candidate SHA and run exactly one named
mutation. The current checkout must be clean and `HEAD` must equal the SHA;
the harness refuses to mutate a dirty or different checkout.

```sh
SANDRA_CANARY_DOCKER_HOST=unix:///private/tmp/sandra-sequence-docker.sock \
  node scripts/run-sequence-reliability-mutations.mjs \
  --commit=<candidate-sha> \
  --mutation=<name> \
  --artifacts-dir=/tmp/sequence-mutation-<name>
```

The supported names are:

| Mutation | Target contract | Positive controls |
| --- | --- | --- |
| `claim-uniqueness-removed` | 20 synchronized two-client claim trials retain one durable claim and one provider invocation each | native three-step lifecycle; missing-template repair |
| `advancement-suppressed` | a successful native lifecycle advances and completes | unknown-state quiet hold; reply-stop snapshot (no native advancement) |
| `final-authorization-removed` | a reply or cancel committed after the scheduler snapshot prevents provider dispatch | route step execution; missing sender repair |
| `persistence-error-ignored` | accepted provider delivery with a failed receipt UPDATE remains reconciliation-only | native lifecycle; missing sender repair |
| `unsafe-ambiguous-retry` | an accepted or unknown claim cannot be made sendable by the retry RPC, even when a legacy pause reason says `provider_failed` | route step execution; unknown-state quiet hold |
| `suppression-bypassed` | an automated send held by a human-owned disposition never reaches the provider | native lifecycle; unknown-state quiet hold |
| `ui-persistence-dropped` | the browser sequence edit survives the server action and reload | non-admin authoring boundary; browser egress denial |

Each run performs a clean preflight, starts Supabase on loopback only with the
mock provider, provisions the disposable owner, and selects one target and two
controls by exact test-name pattern. All three must pass before mutation. The
mutant must then produce exactly one assertion failure in the selected target;
compile, startup, connection, missing-test, whole-suite, and control failures
are rejected as invalid evidence. The worktree is restored, the database is
reset, the index preflight is repeated, and the target plus controls must pass
again.

Vitest reports are normalized to executed assertions, so filtered pending and
todo cases do not count as selected tests. An ordinary failed assertion is
accepted even though its suite is marked failed; a suite with no executed
assertion is treated as setup/collection failure. Mutation failures must match
the selected full name, expected diagnostic, and the exact assertion marker's
source location in the selected test. A thrown fixture error or hook failure
therefore cannot satisfy a mutant. The parser self-test can validate both real
passing and deliberately failing JSON reports without Docker:

```sh
node scripts/run-sequence-reliability-mutations.mjs \
  --self-test-parser=/tmp/sequence-parser-unit.json
# Use the same command with a deliberately failing one-test report to verify
# the failed-suite normalization path.
node scripts/run-sequence-reliability-mutations.mjs \
  --self-test-parser=/tmp/sequence-parser-failure.json
```

The UI persistence mutant selects the existing Playwright create/edit/reload
contract. The harness invokes `playwright.sequence-readiness.config.ts` with a
run-scoped local identity and ledger token; it does not edit or replace that
browser runner. The browser target and controls use the same loopback-only
Supabase and mock-provider guard as the normal Phase 4 lane.

The claim uniqueness mutation drops the active-claim index only after the clean
database preflight. It never edits a migration before startup, which prevents
an invalid migration from being reported as a behavioral mutation. Source and
migration mutants record before and after SHA-256 hashes and a patch manifest.

Artifacts are written outside the checkout: scrubbed command logs, one JSON
report per selected test, `mutation.patch.txt`, `evidence.json`, and the final
preflight. Docker resources are filtered by the owned temporary project name
and removed during cleanup only after label ownership checks. Occupied loopback
ports are rejected before startup or browser execution. PASS is emitted only
after Supabase, Docker resources, worktree, and temporary directory cleanup
have all succeeded; cleanup failures produce `CLEANUP_FAIL` and a nonzero exit.
Structured reports and evidence are recursively scrubbed as well as command
logs. The harness does not use hosted credentials or a hosted database and does
not execute mutations automatically.
