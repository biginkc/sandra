# Deployment readiness — My Leads

## Current task authority

Jarrad explicitly narrowed completion to manually reviewed, verified PRs ready for his deployment decision. Pushes, PRs, temporary CI accounts and rerun replacements are authorized, with exact-run cleanup. Do not merge, deploy (including previews), apply shared/production migrations, enable the feature, initialize real leads, or place real calls/messages. This overrides older release-execution wording throughout this plan. Use built-in review agents only; remain isolated from Sandra orchestration and unrelated tasks.

## Checklist

- [x] Implementation and local acceptance committed (Sandra b4f48fdd; Jitter c41f2e0).
- [x] Refresh main baselines and inspect open PR dependencies; main remains unchanged in both repositories.
- [x] Inspect publication triggers: GitHub PR workflows test; migrations require main or explicit dispatch. No repository hooks returned by the GitHub hooks API.
- [x] Inspect live hosting: both Vercel projects follow main for production and allow Git deployments; add exact-branch exclusions before push. Railway project PR environments and bot PR environments are both false; both services follow main.
- [ ] Consolidate three independent review lanes, adjudicate findings, fix and verify.
- [ ] Publish guarded branches/PRs and verify no preview deployments occurred.
- [ ] Verify CI and exact-run test-account cleanup.
- [ ] Final exact-candidate readiness receipt and deployment checklist.

## Publication guard

Each branch carries `git.deploymentEnabled` false for its exact name in vercel.json. Other branches retain their normal behavior. Source: https://vercel.com/docs/project-configuration/git-configuration . Railway settings were queried read-only through its API; no project settings were changed. Do not dispatch migration workflows. Do not merge these PRs.

## Checks intentionally reserved for release

Hosted migration preflight/application and postflight; deployment artifact/environment parity; authenticated actual live seller-call creation through the deployed producer and receiver; external calendar synchronization; review and application of Maria’s exact current cohort; feature enablement. These are not claimed passed by local tests or green PR CI.

Release order: validate/apply Sandra schema through the established migration workflow, deploy the compatible Sandra receiver with My Leads disabled, validate/apply Jitter schema and deploy producer, verify real provider evidence under separately granted call permission, preview/review/apply the current cohort, and enable only after a separate explicit decision. See LAUNCH-RUNBOOK.md for guarded preview/apply/rollback. Recheck main and migration history immediately before release; do not assume this task's baseline remains current.
