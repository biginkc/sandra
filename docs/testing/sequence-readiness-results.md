# Sequence readiness evidence — 2026-09-17

Status: all scoped execution gates passed. Opus 5 final evidence review APPROVED local/disposable readiness and PR preparation (session `d49ab6ae-49fc-4958-846c-caf382812957`). Preparation does not authorize production release or live messages.

PR: https://github.com/biginkc/sandra/pull/632. Code candidate: `2ddeaf555436ce0316f824639c061a4f7b9eab95`.

## What the tests establish

The disposable database suite exercises scheduling and step order, concurrent claims, reply/STOP/pause/cancel races, quiet hours, tenant access, failed persistence and safe recovery. The browser suite uses a prebuilt production app with real local password login, tests create/edit/enroll/pause/resume/cancel/reload and mock SMS/inbound-thread persistence, and checks member/tenant access and external-HTTP denial.

[Acceptance and production build](https://github.com/biginkc/sandra/actions/runs/35228140861): 231 database tests and 6 browser tests passed. [Verify](https://github.com/biginkc/sandra/actions/runs/35228140824) passed. The required local hook passed PostgreSQL rehearsals, TypeScript, 4,622 unit tests (3 skipped), and 1,511 component tests. Nine focused harness contracts pass. Changed-file lint is clean; repository-wide lint retains pre-existing errors.

Mutation proof requires a passing target and two controls, the intended assertion failure under a deliberate regression while both controls pass, a restored passing target/control set, and empty owned-resource cleanup. Startup, compile, navigation and whole-test timeout errors cannot count as proof. The UI assertion uses its Playwright-specific classifier: its 10-second expect.poll timeout carries the exact expected/received description mismatch, so it is a legitimate failed persistence assertion, not a whole-test timeout.

| Deliberate regression | Actual failing contract | Proof run | Source commit |
| --- | --- | --- | --- |
| Claim uniqueness removed | Concurrent claims invoke the provider more than once | [PASS](https://github.com/biginkc/sandra/actions/runs/35221922638) | `215777a8` |
| Advancement suppressed | Current-step state fails to advance | [PASS](https://github.com/biginkc/sandra/actions/runs/35224977706) | `72cab7c8` |
| Final authorization removed | Reply-paused tick outcome becomes failed rather than paused | [PASS](https://github.com/biginkc/sandra/actions/runs/35227327569) | `54092465` |
| Persistence error ignored | Scheduler fails to report the failed outcome | [PASS](https://github.com/biginkc/sandra/actions/runs/35221931081) | `215777a8` |
| Ambiguous retry allowed | Recovery authorizes retry instead of requiring reconciliation | [PASS](https://github.com/biginkc/sandra/actions/runs/35221933931) | `215777a8` |
| Suppression bypassed | Suppressed contact produces sent rather than blocked outcome | [PASS](https://github.com/biginkc/sandra/actions/runs/35221937134) | `215777a8` |
| UI persistence dropped | Edited description must persist in the database | [PASS](https://github.com/biginkc/sandra/actions/runs/35228139492) | `2ddeaf55` |

The final-authorization and ambiguous-retry failures occur before later provider-count assertions; those artifacts do not directly demonstrate an unauthorized or duplicate send. The [85-file source comparison](sequence-readiness-source-hashes.json) binds every proof commit to the candidate, including the historical018 migration: 84 files are identical at all proof commits; only the mutation harness differs within that 85-file set. The [complete repository diff](sequence-readiness-repository-closure.json) also confirms that all migrations, application files, test configurations/setup and lockfile are unchanged across proof commits. Later commits corrected disposable setup and failure classification. The six saved DB proofs were also [re-adjudicated using the final harness](sequence-readiness-mutation-adjudication.json): all actual target failures and all positive-control phases pass, while wrong-line and plain-error variants are rejected. The first four proof runs used the CLI-default registry; subsequent corrected runs explicitly used GHCR with the same pinned CLI version. Cross-registry image digest equivalence was not captured. This is not a production-equivalence claim. The [mutation binding record](sequence-readiness-mutation-binding.json) reconstructs every source patch to its recorded after-hash and confirms identical application/restoration functions at all proof commits. The DDL mutation awaits the drop and then queries the catalog, throwing if the index remains before recording the mutation; that inline absence guard passed. Raw post-drop rows were not saved; index presence is captured before the drop and after restoration.

## Review and repeatability

Opus 5 approved plan revision3, runtime/migration source, clock fixtures, browser harness, environment reporting and mutation-harness corrections. Latest source approval: `56a4c5f1-c2fe-4b15-b4a1-702e1b4537d5`. Independent evidence review accepted all seven proofs. The UI job completed all three phases and empty cleanup in 15m45s, within the 30-minute cap. The [seven proof summaries](sequence-readiness-mutation-results.json) preserve exact failures and limits. [Artifact provenance](sequence-readiness-artifact-provenance.json) records GitHub artifact IDs/archive digests and evidence JSON hashes; fresh downloads matched both the API digests and the local replay inputs. Final evidence approval: `d49ab6ae-49fc-4958-846c-caf382812957`; see PR #632 for the final documentation-head checks.

To repeat the full isolated lane on this branch, dispatch `Disposable canary validation` with `mutation=none`. For a named mutation, select its workflow input; a fresh full baseline runs before its isolated mutation job. The workflow pins Node 24 and Supabase CLI 2.116.0, creates a disposable database, uses mock transport and denies external HTTP. It never invokes the live-provider canary. The Phase-5 atomic allowance mutation remains a future fake-transport prerequisite that blocks live execution. Fixture phone values are generated test data used only by mock transport, not imported customer recipients; subscriber allocation is not asserted. Shared evidence summaries omit those values. Future live canaries must use separately authorized owned recipients; these mock fixture numbers must never be reused as live destinations.

## Release boundaries

Dependencies #530 and #516 remain open and must land before release; do not merge this child into the dependency owner's branch. Production database/provider/cadence equivalence, live delivery and recurring monitoring remain unverified. Live allowance is zero. No production merge, migration, deployment or customer message was performed.

Follow [rollout prerequisites](sequence-readiness-rollout.md): inventory ambiguous legacy claims, establish old-worker quiescence, apply migration before new workers, verify indexes/grants, and preserve claims/audit history during rollback. These are release prerequisites, not completed production operations.

Detailed chronology and failed attempts: [execution record](sequence-readiness-execution.md). Test contracts and authorization: [approved plan](sequence-readiness-plan.md).
