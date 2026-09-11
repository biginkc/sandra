# Deployment readiness — My Leads

## Current task authority

Jarrad explicitly narrowed completion to manually reviewed, verified PRs ready for his deployment decision. Pushes, PRs, temporary CI accounts and rerun replacements are authorized, with exact-run cleanup. Do not merge, deploy (including previews), apply shared/production migrations, enable the feature, initialize real leads, or place real calls/messages. This overrides older release-execution wording throughout this plan. Use built-in review agents only; remain isolated from Sandra orchestration and unrelated tasks.

## Checklist

- [x] Implementation and local acceptance committed (Sandra b4f48fdd; Jitter c41f2e0).
- [x] Refresh main baselines and inspect open PR dependencies; main remains unchanged in both repositories.
- [x] Inspect publication triggers: GitHub PR workflows test; migrations require main or explicit dispatch. No repository hooks returned by the GitHub hooks API.
- [x] Inspect live hosting: both Vercel projects follow main for production and allow Git deployments; add exact-branch exclusions before push. Railway project PR environments and bot PR environments are both false; both services follow main.
- [x] Consolidate three independent review lanes, adjudicate findings, fix and verify.
- [x] Publish guarded branches/PRs and verify no preview deployments occurred.
- [ ] Verify CI and exact-run test-account cleanup.
- [ ] Final exact-candidate readiness receipt and deployment checklist.

## Publication guard

Each branch carries `git.deploymentEnabled` false for its exact name in vercel.json. Other branches retain their normal behavior. Source: https://vercel.com/docs/project-configuration/git-configuration . Railway settings were queried read-only through its API; no project settings were changed. Do not dispatch migration workflows. Do not merge these PRs.

## Checks intentionally reserved for release

Hosted migration preflight/application and postflight; deployment artifact/environment parity; authenticated actual live seller-call creation through the deployed producer and receiver; external calendar synchronization; review and application of Maria’s exact current cohort; feature enablement. These are not claimed passed by local tests or green PR CI.

Release order: validate/apply Sandra schema through the established migration workflow, deploy the compatible Sandra receiver with My Leads disabled, validate/apply Jitter schema and deploy producer, verify real provider evidence under separately granted call permission, preview/review/apply the current cohort, and enable only after a separate explicit decision. See LAUNCH-RUNBOOK.md for guarded preview/apply/rollback. Recheck main and migration history immediately before release; do not assume this task's baseline remains current.

## Review evidence in progress

PRs: https://github.com/biginkc/sandra/pull/523 and https://github.com/biginkc/Jitter/pull/240 (draft during review). Published heads: Sandra a8321c99, Jitter d878f2a. Initial Vercel deployment-list checks found no deployment for either branch. GitHub workflows are running; no migration workflow was dispatched.

Three built-in reviewer lanes cover SQL/data/launch, call/provider/calendar, and UI/query presentation/tests. Root covers release configuration, documentation, manifest, secret scanning, and cross-lane adjudication. External Claude sessions are not used because this task explicitly requests built-in review agents and isolation.

Fallow audit ran in both repositories against origin/main. It reports unused exports, standalone scripts/configs, complexity, and duplicate blocks, including inherited findings. These are review leads, not verified defects or a passing gate. Explicit CLI scripts and compatibility exports are not removed solely because static analysis sees no importer. Reviewer adjudication will identify any concrete defects.

The changed-file secret scan found no private-key blocks, provider-key patterns, JWT literals, or Vercel deployment-hook URLs in either candidate. Runtime configuration continues to use existing Supabase, Sandra/Jitter service-token, and softphone capability variables; the launch CLI additionally reads MY_LEADS_ACCESS_TOKEN only for explicitly admitted execution. No secret values are included in review artifacts. 1Password account discovery succeeded, but vault-list authorization was dismissed; storage/category/environment mappings remain unverified. Do not treat that as verified provisioning or rotate credentials in this task.

GitHub currently has a Sandra protect-main ruleset prohibiting force pushes; no required-check rule was returned. Jitter protection inspection returned a plan/permissions restriction. Therefore readiness means the recorded checks passed and manual review finished; do not claim GitHub mechanically enforces all release gates. Neither fact grants merge permission.

## Final local candidate

Sandra UI/reporting fixes are committed at 58beb28a. Final launch SQL captures the admitted cohort and passed its private concurrency/rollback test and a fresh full 216+13 migration replay. Jitter final reviewed implementation is b9f1ecd; the full executor suite passed 140/140, and the strengthened interruption regression passed with unchanged recovery state. The final CI and cleanup receipts will be recorded in the PR bodies after these source commits are pushed, so documentation commits do not repeatedly restart hosted tests. PR checks are the authoritative final-CI source.

Local native verification after UI fixes passed 3,778 unit tests, 1,268 RTL tests, atomic-migration tests, eSign rehearsal and typecheck. No optional refactors or speculative timestamp/performance changes were made. MANUAL-REVIEW.md records accepted fixes and nonblocking deferrals.
