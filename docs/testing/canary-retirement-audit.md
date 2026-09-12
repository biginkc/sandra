# Sandra canary audit — September 11, 2026

Audited current GitHub main `8df519abac5a15c023a9ead209dac90312383028` in an isolated checkout. Scope: the four scheduled canary scripts, both scheduling workflows, all 20 production browser spec files, shared helpers/auth, two Sendillo smoke scripts, current application contracts, and open PR 517. This is a source/history/run-evidence audit, not a successful execution certificate. No tests were run against production, no providers called, no workflows disabled, and nothing deleted.

## Decision

**Do not delete all canary coverage. Replace/consolidate the four old scheduled implementations, retain the important behaviors, and repair/revalidate the broader browser suite.** No file is approved for immediate removal solely because of age. A retirement candidate means removal together with validated replacement coverage and caller updates, not erasing a failing alarm without replacement.

The AI happy-path script last changed May 9 (`c9946c71`); main has 299 first-parent commits after that commit. That is commit count, not 299 PRs. However, the production browser auth/config was updated July 22 for Hugo, and Kanban/promotion tests changed August 16. The suite is not uniformly abandoned.

## Four scheduled scripts

| Script | Recommendation | Verified reason |
|---|---|---|
| `scripts/smoke-ai-responder-happy-prod.ts` | Replace with the stronger browser-test behavior and a provider-aware API check; then retire duplicate CLI implementation | Missing required phone type. Creates an outbound anchor, then polls any outbound with `limit(1)` and no ordering or AI filter (lines 137–158). It can select its own anchor and falsely fail. Uses invented `+1555…` destination rather than the browser suite's explicit recipient allowlist. Skips outside business hours with exit 0, so green can mean not exercised. |
| `scripts/smoke-ai-responder-escalation-prod.ts` | Consolidate with browser escalation and current-provider webhook helper | Missing phone type; old Dialpad trigger. Some DB calls ignore errors, including consent insertion and the query asserting absence of AI output, so an error can masquerade as no outbound. Negative assertion covers only `ai_responder_v1` output, not every unexpected send or delayed work. Preserve escalation/no-send intent. |
| `scripts/smoke-stop-keyword-prod.ts` | Replace with current-provider STOP and phone-suppression assertions | Missing phone type; arbitrary first organization; contact/property lack explicit org; no attribution anchor. It checks contact consent/flag/enrollment but not current durable phone-level suppression or same-phone duplicate contacts. Cleanup does not address that newer suppression state. Preserve STOP coverage. |
| `scripts/smoke-sequences-prod.ts` | Replace/consolidate after reconciling original owner's PR 517 | Missing phone type; fixed receiver; excludes only one old test URL rather than requiring the exact intended target; arbitrary first org. Logs completion without asserting it (lines 218–229). No `finally` for early seed failures: a contact failure occurs after sequence and step inserts and exits without cleanup. Cleanup ignores errors and compares step-run `step_id` with a sequence ID. |

The latest scheduled runs on September 11 all fail with the same contact-fixture line-type error. [SMS run](https://github.com/biginkc/sandra/actions/runs/34629914050), [sequence run](https://github.com/biginkc/sandra/actions/runs/34627217575). The schema rule is explicit in `supabase/migrations/20260902174035_save_unverified_lead_phone.sql:17`.

**Correction to the earlier provider inference:** a Dialpad reference alone does not prove a dead test. `src/lib/messaging/registry.ts` still supports Dialpad, Sendillo, and Twilio; the Dialpad inbound route still calls the shared inbound handler. Sequence sends call `sendSmsToContact`, which resolves the configured outbound provider. A Twilio-owned receiving endpoint could still verify delivery from Sendillo. What the old SMS checks definitely fail to cover is Sendillo's own payload/signature/status contract. Live logs show that contract is in use; this audit did not establish that every Dialpad credential or receiver is retired.

## Browser inventory: retain intent, qualify execution

All rows require controlled execution against the current candidate before being counted green. “Keep” means valuable coverage with current code support; it does not mean this audit proved it passes.

| File in `e2e/prod-canary/` | Disposition | Rationale / needed work |
|---|---|---|
| `auth-shell.spec.ts` | Keep, extend | Navigation with an existing session. Does not test a fresh Hugo login. |
| `auth-membership.spec.ts` | Keep | Seeds visible/hidden org rows and verifies isolation in UI. Validate identity and org setup. |
| `prospects.spec.ts` | Keep | Search result plus persisted prospect checks. |
| `lists.spec.ts` | Keep | List creation and archive persistence. |
| `filters.spec.ts` | Keep; prefer staging | Combined filters with positive/negative rows. Skeleton visibility assertion is implementation-sensitive and can fail when UI becomes faster. |
| `large-list-filter.spec.ts` | Keep in staging/release suite | 275-row regression case; unnecessary churn for frequent production checks. |
| `quick-presets.spec.ts` | Keep | Save/apply/clear preset behavior, including empty-name rejection. |
| `imports.spec.ts` | Keep in staging/release suite | Actual upload, job completion, persisted rows; refresh UI selectors as needed. |
| `import-updates.spec.ts` | Keep in staging/release suite | Matched/unmatched update counts and persisted statuses. |
| `lead-qualification.spec.ts` | Keep | Promotion/job outcome; updated August 16. |
| `kanban-status.spec.ts` | Keep | Drag/status persistence/reload; updated August 16. |
| `lead-management.spec.ts` | Repair, keep | Expects menu item `Me` and text `Assigned: me`; current team-member label is display name/email plus ` (you)`. Persisted assignee assertion remains useful. Does not cover Messages assignment. |
| `templates.spec.ts` | Keep | Create/edit/delete with persistence and reload verification. |
| `inbound-sms.spec.ts` | Adapt | Typed fixture already exists; replace or parameterize Dialpad injection with current provider route and attribution. |
| `outbound-sms.spec.ts` | Keep, strengthen | Allowlisted recipient and UI send. Checks DB `sent`, not proof the destination phone received it. Validate org-scoped existing-contact reuse. |
| `ai-responder.spec.ts` | Adapt; reuse over old CLI | Waits for actual AI metadata and sent status, unlike old CLI anchor query. Allowlisted recipient. Still uses Dialpad injection and business-hour skip; report skipped distinctly. |
| `ai-escalation.spec.ts` | Adapt; reuse | Typed fixture and stronger DB error assertions. Update provider, attribution, and delayed/no-send proof. |
| `stop-dnc.spec.ts` | Adapt; reuse | Typed fixture, anchor, consent/enrollment plus blocked-send UI checks. Add phone-level suppression, org isolation, and matching cleanup. |
| `sequences.spec.ts` | Repair and consolidate | Already requires completed enrollment AND matching sent message, stronger than CLI. Validate exact org/receiver/time window and cleanup; DB sent is not handset receipt. |
| `dialer-handoff.spec.ts` | Keep as handoff integration; add separate call canary | Creates batch and simulates signed fetch/claim/writeback. Does not actually establish audio, release a real call lock, or prove recording availability. |

Shared suite prerequisites also need work: reusable contacts are looked up by phone without org/run-ownership proof; several seeds depend on implicit org defaults; cleanup is inconsistent about checking errors and newer side effects. Do not schedule the entire suite every few minutes. An authenticated browser state captured from Hugo is required by current `playwright.canary.config.ts`; it does not automate fresh login or session renewal. The old local checkout's password-based documentation was not authoritative—this audit uses current main.

## Useful newer pieces already present

- `scripts/smoke-sendillo-webhook-prod.ts`: keep and repair. Tests Sendillo JSON/header parsing, thread persistence, duplicate replay/notification behavior, plus STOP mode. It disables AI on its fixture; it is not an AI replacement. Its contact insert also omits phone type. It has more explicit cleanup-error reporting, but still needs current phone-suppression cleanup and assertions. Direct injection does not prove Sendillo is actually configured to deliver webhooks.
- `scripts/smoke-sendillo-live-prod.ts`: retain as an on-demand real-provider diagnostic, not an unattended job as-is. Exercises live Sendillo with a controlled Dialpad counterpart. Also lacks contact phone type and swallows cleanup errors. It imports local messaging code for part of the send path, so bind that code to the deployed revision or replace it with a deployed API/UI action. Revalidate recipient ownership, budgets, and provider configuration before execution.
- `Coach Realtime authorization`: retain the PR test. It checks authorization in the test environment; it is not production voice-health coverage.

## Concrete retirement boundaries

After replacements are proven, remove the four obsolete script implementations and their four package commands together; repoint or consolidate `canary-sms.yml` and `canary-sequences.yml` into maintained jobs. Keep the scheduling capability on GitHub. Avoid maintaining two divergent copies of the same assertions.

**Do not delete:** the whole `e2e/prod-canary` directory; shared `scripts/canary-helpers.ts` (both Sendillo scripts import it); production Dialpad routes/adapters merely because old tests use them; `test_sms_log` or the test-receiver endpoint (`e2e/dialpad-to-twilio-roundtrip.spec.ts` also uses them); schema/migrations or historical evidence as part of test cleanup.

[PR 517](https://github.com/biginkc/sandra/pull/517) is open and owned by the existing Sequence session. Its diff adds explicit owned mobile-recipient preflight. It does not fix final-status assertions, all cleanup gaps, or broader coverage. Its new environment requirements are not added to the scheduling YAML in that diff. Reconcile that work before replacing the same script; do not close or overwrite it as part of this audit.

## Missing current incidents

None of these production specs performs Mel's reply → switch → disposition → assign journey while inbound updates arrive, verifies assigned prospects in Mine, or checks draft/selection survival. They also do not prove Maria can end a real call and immediately start another with a usable recording. Those are new production/staging acceptance journeys, not benefits obtained by deleting old tests. Provider billing failures, Sendillo status callbacks, stuck-job progress, and fresh Hugo login/session renewal need explicit coverage too.

Acceptance for replacement: the check passes the intended current path, demonstrably fails at the boundary it claims to protect, records the exact candidate/environment, leaves verified cleanup, distinguishes skip/fixture/product failure, and reaches a tested alert destination. Keep heavyweight fixtures in staging and use a small bounded owned-fixture set in production.
