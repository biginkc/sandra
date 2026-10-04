# My Leads one-call close: technical plan (Phases 0–4)

Companion to `DECISIONS-2026-10.md` (Codex Astra `APPROVE_PLAN: YES` at 6edf9b68). That document says
what and why; this one says exactly how, at the level a builder agent executes unattended. Where the
two disagree, this plan wins only where it cites a verified code fact; otherwise the decision record
wins and the conflict is listed under "Cross-phase contracts".

Drafted 2026-10-04/05 from the repository at 6edf9b68 by five parallel read-only passes (one per
phase), assembled and reconciled here. Nothing in it has been run.

## Authorization and approved defaults (Jarrad, 2026-10-04)

Jarrad's instruction: Phases 0–3 are to be completed overnight by Codex with his explicit permission.
That permission covers building every phase, merging Codex-approved green PRs into `main`, applying
migrations through the established Sandra workflow, and the real-lead data changes named below, each
with a before-image so it is reversible. Jarrad's authorization covers the content; the root
orchestrator's exact-SHA slot (see "Coordination and release control") governs the timing of every
merge, migration and deploy, overnight included. Production migrations apply automatically about a
minute after a merge to `main` (see the contract row on migration approval and merge timing). It does **not** cover creating accounts, spending beyond the
stated caps, dialing non-owned numbers, live Dialpad tests that need his desktop app and phone
(morning, with him), contacting real sellers, or any business-rule text (verbatim approval only).

Defaults Jarrad approved verbatim ("approved"):

| Item | Approved value |
|---|---|
| Offer follow-up | 3 days before closing at 09:00 America/Chicago; if closing is sooner, the next morning 09:00 |
| 137 stale pending attempts | close with a new outcome `not_logged`; nothing deleted |
| Existing open appointments | all `mode='phone'`; Jarrad flags in-person rows by hand later |
| Maria's 2 and Mel's 13 queue leads | leads **and** their open tasks move to Jarrad |
| ARV | Jarrad's own number (nullable); ATTOM-derived ARV not attempted in v1 |
| ATTOM monthly cap | 0 until Jarrad sets it after the trial verdict; comps stay off in production until then |
| ATTOM trial spend | up to $20 total (Jarrad, 2026-10-04), hard-capped in the script |
| Personal Dialpad calls | unmatched payloads redacted after 30 days |

Still owed by Jarrad (each phase states the default used meanwhile): ATTOM trial
acceptance thresholds (trial spend is approved up to $20); title company and buyer entity lists; owned phone number for test calls; the
seller-reminder SMS text (job ships disabled until supplied; pending Jarrad's verbatim approval);
verbatim approval of the Dialpad AI-facts extraction prompt (`FACTS_PROMPT_V1` ships null; pending
Jarrad's verbatim approval); the "appointments kept" KPI scope question (P1a-core Risks). Also owed,
with the default used meanwhile:

| Item | Default used |
|---|---|
| Offer follow-up closes as `cancelled` vs the decision record's "completes" | `cancelled` (KPI-neutral; one constant in the 1a.6 trigger) |
| Quick-pick time of day (Tomorrow / 3 days / Next week) | 10:00 America/Chicago (P1 Inputs) |
| Dialer wrap-up callbacks 30 min → 15 min | 15 |
| Tier-1 overdue cap in the Call-next strip (P1b Risks) | no cap (D3 "due or overdue"); Jarrad may ask for an N-day cap |
| Softphone voicemail mapping (`my_leads_reconcile_call` maps a Sandra softphone `voicemail` to `no_answer`) | left unchanged (P1c Risks) |
| The >5-minute-conversation KPI tile for Dialpad calls (2 Risks) | left unchanged, raised to Jarrad |
| `offersSent` counting both a stale offer and its superseding offer (3.6) | left as is (both were real sends) |
| Which Supabase project Vercel Preview points at | hosted test project `ncsngxlcyxylaeskiteu` (Phase 4 Inputs) |

Credentials now in BMH Secrets, read only via the `op` CLI with the BMH service account (never the
SDK, desktop app or browser): `op://BMH Secrets/ATTOM - API/credential` — exact item title
`ATTOM - API` (Free Trial, 30 days from 2026-10-04, account jarrad@bmhgroupkc.com). Runtime code on
Vercel reads `ATTOM_API_KEY` from the Vercel environment, which is populated from that item by the
operator with `op read`, never pasted; `Dialpad - API`, `DialPad Sandra API key` (scope
unknown; Phase 0.1 probes both); `Dropbox Sign - Sandra eSign Test Mode`.

## PR stack and sequencing

All branches are stacked on `claude/my-leads-one-call-close-decisions` (PR #791) until it merges,
then re-based onto `main`. Every PR body states `Depends on: #<n>` and is created with
`gh pr create --base <parent branch>`. One writer per worktree. Merge order is strictly the order
below; CI applies every merged migration to the test project and production, so **no migration may
contain a data step** — data steps are service-only functions run by an operator script after a
pasted preview (Phase 1e, Phase 4 runbook).

| Order | Branch | Scope | Depends on |
|---|---|---|---|
| 0 | `claude/my-leads-p0-spike` | Phase 0 scripts, findings note — **owned by the Codex root orchestrator (sole writer, Sonnet 5.5 builder)**; Claude does not write here | #791 |
| 1 | `claude/my-leads-p4-before-image` | Phase 4 KPI parity harness + lease manifest + monitor, no migration (the branch name is historical) | #791 |
| 2 | `claude/my-leads-p1e-housekeeping` | Phase 1e service functions, before-image tables + operator script (the only before-image store) | #791 |
| 3 | `claude/my-leads-p1a-core` | additive schema, feature-flag table, `fn_create_next_step`, one read definition, mode-aware lifecycle functions, the read-only retire preflight function | p1e |
| 4 | `claude/my-leads-p1a-writers` | every writer migrated, offer follow-up chain | p1a-core |
| 5 | `claude/my-leads-p1b-strip` | ranking RPC, overrides table, strip UI | p1a-writers |
| 6 | `claude/my-leads-p1c-prompt` | post-call prompt v1 (behind `post_call_prompt`) | p1b-strip |
| 7 | `claude/my-leads-p1c2-seller-reminders` | seller-reminder job (ships disabled) | p1c-prompt |
| 8 | `claude/my-leads-p1d-link-capture` | hangup link capture columns + guard | p1c2-seller-reminders |
| 9 | `claude/my-leads-p2-data-plane` | shared ledger key, intent timeout, phone table, native match, assign-to-lead, fetch job | p1d-link-capture |
| 10 | `claude/my-leads-p2-ui` | API dial, unacknowledged-call polling, callback alert, redaction, activation runbook | p2-data-plane |
| 11 | `claude/my-leads-p2-acceptance` | Phase 2 acceptance slice: Phase 2 fixtures/stubs, T8 (Phase 2 attended acceptance spec), phase-gated monitoring kit; no migration. Must merge before Phase 2's release step | p2-ui |
| 12 | `claude/my-leads-p3-comps` | comps provider + fixture, `lead_comps`, CLOSR suppression | p2-acceptance |
| 13 | `claude/my-leads-p3-call-screen` | call screen route | p3-comps |
| 14 | `claude/my-leads-p3-send-card` | contract defaults, send card, offer projection, supersede/recovery, AI facts | p3-call-screen |
| 15 | `claude/my-leads-p1a-retire` | reject trigger, snooze removal, retire follow-up/callback types (last migration, after the bake; its preflight function ships earlier in p1a-core) | p3-send-card |
| 16 | `claude/my-leads-p4-acceptance` | remaining Playwright acceptance specs (Phase 1 and Phase 3 slices), runbook, full monitoring | p1a-retire |

Merge strictly in this order. The migration safety gate refuses a pending migration older than the
history's high-water mark, so a PR that merges early strands every older-timestamped PR behind it.

Ancestry rule (each branch's base contains everything it imports): P1b imports `follow_up_calendar_chain_id`
(P1a-writers), so it is based on `p1a-writers`; the seller-reminder job (P1c-2) is based on `p1c-prompt`, which
carries the strip and prompt that Phase 2 imports through the chain p1d → p2-data-plane → p2-ui →
p2-acceptance → p3-comps → p3-call-screen → p3-send-card → p1a-retire → p4-acceptance. A reviewer checks it
with `git merge-base --is-ancestor <dependency head> <branch head>` for every row's Depends-on before the
branch is offered for merge.

Migration timestamp blocks (must sort after `20261003160000` and after each other; Phase 4 and the
`p2-acceptance` slice have no migration; the retire preflight function ships in P1a-core, not in the
retire migration; root re-checks against the actual release order at lease time): Phase 1
`20261005100000`–`20261005199999`; Phase 2 `20261006100000`–`20261006199999`; Phase 3
`20261007100000`–`20261007199999`; retire `20261008100000`–`20261008199999` (p1a-retire, merged last
after its ≥24 hour bake). Builders rename placeholder timestamps in the phase sections to these
blocks.

## Coordination and release control

- **Root orchestrator (Codex master)** serializes every Sandra merge, migration and deployment and
  grants an exact-SHA slot per candidate. Nobody merges or deploys without that slot, overnight
  included (Jarrad's authorization covers the content, the slot covers the timing); implementation
  and reviews keep moving meanwhile. Jarrad made this work top priority above Inbox; Inbox does not
  block independent My Leads work.
- **Ownership.** Root owns `claude/my-leads-p0-spike` and appends Phase 0 findings there. The Claude
  session "Optimize my leads page" owns `claude/my-leads-one-call-close-decisions` (decision record,
  this plan, `STATUS.md`, PR comments) and the plan reviews. Later stack branches are claimed in
  `STATUS.md` before anyone writes to them; one writer per branch.
- **Review split.** Sonnet 5.5 builds; Opus 5.5 does every intermediate review; Fable 5.1 and Astra
  (gpt-6-astra, medium) review only each phase's tested release candidate, once, before its slot.
- **Real-data changes** happen only through the tested operator script with before-images; never in a
  migration. No live Dialpad tests, seller contact, spending, account creation or unapproved business
  text.

## Cross-phase contracts (resolved here; phase sections defer to this table)

| Topic | Contract |
|---|---|
| Offer follow-up linkage | The offer row carries the appointment **chain** id (Phase 1a.6), not a task id, because `fn_reschedule_appointment` closes the old task and inserts a new one in the same chain. Phase 3's offer projection passes `p_follow_up_at`; the 1a.6 body of `fn_log_acquisition_offer` calls `fn_create_next_step` and stores the chain. 1a.6 trigger 3 cancels the chain's open task (`cancelled/cancelled`, not `held`, which would inflate appointments-kept) whenever the outcome leaves `pending`, including `superseded`. No other helper exists. |
| `fn_log_acquisition_offer` signature | Phase 1a.6 keeps the current 13-argument form and adds the chain behaviour in the copied function body (1a.6); the 13-argument signature is unchanged; Phase 3 calls it unchanged through a service-role wrapper that sets the actor claim and re-reads the compare-and-swap values under lock. |
| Transcript and Recap storage | Phase 2.9 stores transcript and Recap in the existing `call_transcripts` table (its trigger mirrors status onto `call_activities`). Phase 3's AI-facts job reads from `call_transcripts`, not from new `provider_transcript`/`provider_summary` columns; the decision record's column names are superseded. |
| Hangup link columns | Phase 1d adds `call_activities.provider_recording_url`, `provider_voicemail_url`, `provider_voicemail_transcript`, guarded against browser writes by extending `my_leads_guard_call_metrics`. |
| Ledger key predicate | Phase 2.1 replaces all 18 literal `dialpad-cti:` sites (12 live, 6 superseded) with the shared helpers and adds a regression test that fails if any literal survives; Phase 3 and 4 use the helpers. |
| Several-match disposition | Native-match events with several candidate leads are `quarantined` with reason `ambiguous_lead` (not `received`, which the one-minute sweep would re-drive forever); "Assign to lead" resolves them. |
| Intent timeout | "failed" is a marker on the intent, not a terminal status; a late event for a real call still projects. |
| Data steps | Never inside a migration. Phase 1e's `my_leads_housekeeping_runs`/`_before_images` (`20261005100000`) are the only before-image store; every data op is a service-only function (explicit subcommand-to-RPC map in 1e.4) run by `scripts/my-leads-housekeeping.mjs` (preview → `--confirm <fingerprint>` → apply). The **fingerprint is computed in SQL**: the preview returns a canonical sha256 over every candidate row and its relevant before-values; apply takes `p_expected_fingerprint`, locks the candidate rows in id order, recomputes the fingerprint under those locks and raises `HOUSEKEEPING_PREVIEW_STALE` (writes nothing) on any difference, so counts and samples never stand in for the approved rows. Every function filters every table by `org_id = p_org`, records a complete before-image **and** after-image per row (`op` = `created` or `updated`), and rollback is conflict-safe: `fn_my_leads_housekeeping_rollback(run_id)` restores or removes a row only if it still equals its after-image and is not referenced by permanent evidence (for example `dialpad_call_intents`); anything changed later is skipped and listed under `summary.notRestored`. Phase 4 adds no before-image table. Every migration ships a rollback twin under `supabase/rollbacks/`. |
| Reassigned leads and the first-call clock | The reassign function creates the new assignment episodes with `eligible=false`, so Jarrad's first-call clock and KPIs do not restart. Reassigned leads keep `eligible=false`. |
| Dial eligibility | `fn_prepare_dialpad_call_intent` (`foundation.sql:660`) and `fn_authorize_dialpad_dispatch` (`dispatch.sql:159`) both require `v_episode.eligible`, which would lock the 15 reassigned leads out of dialing. 2.7 adds anchored patches removing `or not v_episode.eligible` from both functions (open episode + assignee still required), with tests. **Flagged for orchestrator review.** |
| Feature flags (kill switches) | `my_leads_feature_flags(org_id pk, call_next_strip, post_call_prompt, click_to_dial, native_matcher, auto_prompt, callback_alert, call_screen, contract_card, seller_reminders, artifact_fetch, facts_job, offer_projection, comp_queue bool default false)` created in P1a-core `20261005120000`; every new surface and **every new job or cron** (seller reminders, artifact fetch, facts, offer projection sweep, comp queue drain) checks its own flag server-side before claiming or sending anything; a missing table, row or column reads as OFF, so code that reaches main before its migration is applied is inert. |
| Schema readiness (deploy-before-migration) | Vercel serves new code about a minute before its migration applies (see the next row), so inertness cannot rest on flags alone: a changed **existing** action would call a missing function or column. A server-only helper `src/lib/my-leads/schema-ready.ts` exports `schemaReady(feature: SchemaFeature): Promise<boolean>`. It runs one catalog check through the service client (`to_regprocedure('public.fn(args)')` and `information_schema.columns` lookups for exactly the functions and columns that feature's code path calls, held in one `REQUIREMENTS` map beside the helper), caches `true` for the life of the process and `false` for 30 seconds (a landing migration is picked up without a redeploy), and treats any error as `false`. Every changed EXISTING action and writer is gated by it and keeps a **legacy fallback that runs today's code path unchanged until its schema is ready** (named per work item as "Readiness": `next_step_write`, `offer_follow_up_chain`, `lead_note_idempotency`, `post_call_support`, `call_next`, `hangup_link_columns`, `api_dial`, `ack_prompts`, `callbacks_due`, `offer_projection`, `contract_defaults`, `lead_comps`, `call_facts`). Examples: the `bookAppointment` adapter and `book-appointment-action.ts` keep the current `fn_book_appointment` body when `next_step_write` is false; `createLeadNote` omits `idempotency_key` when `lead_note_idempotency` is false. SQL writers migrated in a migration call only functions created in the same or an earlier migration of the same sub-PR chain, so they have no gap. Tests run each new code path against the PRECEDING schema (the previous sub-PR's migrations only: missing columns and missing functions, not just missing flag rows) and assert the legacy path runs and nothing throws. |
| Migration approval and merge timing | Production migrations apply automatically ~1 min after a merge to `main` (`db-migrate-prod.yml` via `workflow_run`; the Production environment has no required reviewers as of 2026-10-04 despite the workflow comment; that is an operator-verified release precondition, re-checked with fresh evidence at every release slot, never assumed from this document). The only gate is the root orchestrator's exact-SHA slot before merge. Code must still be inert without its migration (schema readiness plus feature-flag row, see the two rows above) to cover the minutes between the Vercel deploy and the migration run; each PR body states how. |
| Revert | Revert has two layers: (1) turn the consumer flags off (`my_leads_feature_flags`) to stop behaviour immediately; (2) undo data with the before-image rollback (`fn_my_leads_housekeeping_rollback(run_id)`) and schema with the `supabase/rollbacks/` twin for every migration. Both are required for every phase. The Dialpad connection stays active; the only connection-level revert is `provision-dialpad-cti.ts --mode deactivate` (subscriptions first). Never hand-edit `status`. |
| Synthetic acceptance lead | Phase 4 uses a non-training synthetic lead (training leads get no attempt row). Dialpad intents/events are permanent, so the lead is soft-retired, never deleted. |
| ATTOM in production | Fixture provider refused in production; real provider gated by the monthly cap (default 0). |
| Dialpad activation | Phase 2.11 adds a webhook-only activation path and a `deactivate` mode; disabling the connection is lossy (401, nothing stored), so the preferred revert keeps the connection active and turns consumers off (see the Revert row). |
| Subscription states | Unchanged six states; transcript/Recap are fetched by the hangup-triggered job; adding `call_transcription`/`recap_*` states is decided by Phase 0.2 evidence. |
| Seller reminder text | No LLM writes it; the job refuses to send until Jarrad supplies the text verbatim. |
| Secret access | `op` CLI with the BMH service account only. Existing tooling that uses the 1Password SDK (`loadOnePasswordSdk` in `src/lib/dialpad-cti/provisioning-adapters.ts`, used by `scripts/provision-dialpad-cti.ts`) gets an `op`-CLI runner behind the same `SecretStorePort` before any phase script or the Phase 2.11 activation reuses it; no new code calls the SDK. |

---

## Phase 0: Spike

**Goal.** Retire the external unknowns (Dialpad key scope and endpoint behaviour, ATTOM data quality and cost, Dropbox Sign template shape) with repeatable, read-mostly scripts and a findings note that decides D4 endpoint, D5 fetch schedule and D6 provider, without touching product code.

**Depends on.** PR #791 (the decision record, branch `claude/my-leads-one-call-close-decisions`, Codex `APPROVE_PLAN: YES` at 6edf9b68). No migrations, no `src/` or `supabase/` changes.

**Branch / PR.** `claude/my-leads-p0-spike` → base `claude/my-leads-one-call-close-decisions`; PR title `chore(my-leads): phase 0 spike harness and findings (Dialpad probe, ATTOM trial, eSign template audit)`; `Depends on: #791`. Created with `gh pr create --base claude/my-leads-one-call-close-decisions`. The findings appended to `DECISIONS-2026-10.md` change a Codex-approved file, so the PR needs a fresh Codex review at its head before anything is offered for merge.

**Inputs needed before start.**
- Credentials already in the vault (no new credential is needed to build or to run 0.1 and 0.4):
  - Dialpad: items `Dialpad - API` (field `credential`; `DEFAULT_API_KEY_ITEM`, `src/lib/dialpad-cti/provisioning.ts:27`, `CREDENTIAL_FIELD` `:29`) and `DialPad Sandra API key` (secure note, field name unknown; read the note body). Both probed; Jarrad does not need to pick first (0.1 reports which one is live).
  - Supabase Management API PAT: item `Supabase - Management API PAT` (`MANAGEMENT_PAT_ITEM`, `src/lib/dialpad-cti/provisioning-adapters.ts:35`), used for read-only SQL as the provisioning scripts do.
  - Dropbox Sign test mode: item `Dropbox Sign - Sandra eSign Test Mode` (API key, client id).
  - 1Password is reached only through the `op` CLI authenticated as the BMH service account: `OP_SERVICE_ACCOUNT_TOKEN` read from Keychain (`security find-generic-password -w -s OP_SERVICE_ACCOUNT_TOKEN`) into the child process env, then `op read 'op://BMH Secrets/<item>/<field>'` spawned with `execFile` (no shell). The secret arrives on stdout and is never placed in argv, logs or files. **Not** the 1Password SDK (`loadOnePasswordSdk`), the desktop app, or a browser extension; Jarrad's standing credential rule is op CLI + service account only.
- Run-time facts: org id and connection id (read from `dialpad_org_connections` by 0.1's SQL; `--org-id` is the only typed id), Jarrad's member id for 0.3 (`--member-id`).
- Needs Jarrad present (0.2 only): desktop Dialpad app logged in, mobile app logged in, one owned phone as the seller stand-in (call it B) not on his Dialpad line, a 60 to 90 minute window outside rep calling hours.
- Defaults assumed if absent:
  - ATTOM key exists (`ATTOM - API`, free 30-day trial). 0.3 may call ATTOM only within the free trial's included allowance: trial spend is hard-capped at **$20 total** (Jarrad, 2026-10-04); the script tracks per-call cost and stops before a call that would exceed it, and a call with unknown cost is not made. The monthly production cap stays `0`. Fixture mode remains the default for tests and CI. Thresholds stay unapproved until Jarrad sets them.
  - No approved thresholds: `attom-thresholds.json` ships with `"approvedAt": null`; the report prints `UNAPPROVED DEFAULTS` and refuses a GO verdict.
  - No template ids: 0.4 audits every `esign_templates` row with `lifecycle_state='finalized'` and `deleted_at is null` that the test key can see, and records the ones it cannot.
  - The user-scoped Dialpad subscription targets Jarrad's Dialpad user id. 0.1 verifies this; if it targets another user, 0.2 stops and reports (see Risks).

**Affected files (for the release lease).** No migration, no deploy; the only live side effect is the 0.2 connection flip, which is reverted in the same session.
- New (all under `scripts/my-leads-phase0/` unless noted):
  - `lib/secrets.ts`, `lib/dialpad-client.ts`, `lib/mgmt-sql.ts`, `lib/csv.ts`, `lib/findings-doc.ts`, `lib/verdicts.ts`
  - `lib/attom-client.ts`, `lib/attom-normalize.ts`, `lib/attom-metrics.ts`, `lib/legal-description.ts`, `lib/arv.ts`
  - `dialpad-key-probe.ts`, `dialpad-live-test.ts`, `attom-trial.ts`, `esign-template-audit.ts`
  - `attom-thresholds.json`, `attom-cost.json`, `fixtures/attom/*.json` (synthetic), `README.md`
  - `*.test.ts` beside each lib and script (list in each item)
  - `docs/my-leads/phase0/findings/dialpad-key-probe.json`, `dialpad-live-test.json`, `attom-trial-summary.json`, `esign-template-audit.json` (redacted, committed)
- Modified: `vitest.config.ts` (line 9 `include`), `.gitignore` (add after line 67), `docs/my-leads/DECISIONS-2026-10.md` (append-only new top-level section `## Phase 0 findings`).

### Work items (ordered; each independently committable)

#### 0.0 Shared harness
- Files: create `scripts/my-leads-phase0/lib/{secrets,dialpad-client,mgmt-sql,csv,findings-doc}.ts` and tests; modify `vitest.config.ts`, `.gitignore`; create `scripts/my-leads-phase0/README.md` (run order and safety rules, modelled on `scripts/direct-call-feasibility/README.md`).
- Change:
  - `vitest.config.ts:9`: add `"scripts/my-leads-phase0/**/*.test.ts"` to `include` (the list is explicit; only `sequence-canary-*` and `direct-call-feasibility/**` are included today, so scripts tests do not run otherwise).
  - `.gitignore`: add `/scripts/my-leads-phase0/.run/` (raw payloads, PDFs and run state; precedent line 67 `/scripts/direct-call-feasibility/.run/`). Redacted findings go to `docs/my-leads/phase0/findings/` and are committed.
  - Conventions copied from `scripts/direct-call-feasibility` (README, `redact.ts`): dry-run or `plan` is the default for anything that writes or dials; live actions need an explicit flag plus a typed confirmation phrase; a hard allowlist of dial targets; run state under `.run/<run-id>/state.json`. Import `redactText`/`redactHeaders` from `../direct-call-feasibility/redact.ts` (`redactText(input, secrets)` masks bearer tokens and `+E164` to `+***last4`) rather than copying.
  - `lib/secrets.ts`:
    ```ts
    export type SecretSource = { label: string; item: string; field?: string };
    export type SecretResult =
      | { state: 'found'; value: string; via: 'env' | 'field' | 'note' }
      | { state: 'missing' | 'duplicate' | 'no_field' };
    export async function readSecret(src: SecretSource, deps?: { env?: NodeJS.ProcessEnv; store?: SecretStorePort }): Promise<SecretResult>;
    export async function listFieldTitles(item: string): Promise<string[]>; // titles only, never values
    ```
    Order: env `PHASE0_<LABEL>` (for CI or when the vault is unreachable) → `op read 'op://BMH Secrets/<item>/<field ?? credential>'` via the service-account runner above → for secure notes, `op item get '<item>' --vault 'BMH Secrets' --fields notesPlain --reveal` through the same runner; accept a note body only if it is a single token of at least 16 characters with no whitespace. Every secret read is `guard.add(value)` into one shared `SecretGuard` (`provisioning.ts:261`, `scrub`) and every file or stdout write goes through `guard.scrub`.
  - `lib/mgmt-sql.ts`:
    ```ts
    export function createReadOnlyRunner(projectRef: string, pat: () => Promise<string>): QueryRunner; // wraps createManagementQueryRunner (provisioning-adapters.ts:237)
    export function assertReadOnlySql(sql: string): void; // throws unless /^\s*(select|with)\b/i, a single statement, and no insert|update|delete|alter|drop|create|grant|truncate|call|do|copy token
    ```
    The Management API executes as a superuser, so this guard plus its test is the only control. Writes (the 0.2 flip) go through a separate `createFlipRunner` that accepts exactly the two statements built by `buildStatusFlipSql(connectionId, orgId, to)`; ids pass a UUID regex before interpolation (same discipline as `lit(value, SAFE_UUID)`, `provisioning-adapters.ts:232` and `:230`).
  - `lib/dialpad-client.ts` (a new client, because `createDialpadPort` returns only `{status,text}` with no headers or timing and forces `redirect:'error'`, `provisioning-adapters.ts:195-223`; keep its path allowlist idea `DIALPAD_PATH`, `:200`, and `DIALPAD_API_ORIGIN`, `directory.ts:15`):
    ```ts
    export type ProbeResult = { probe: string; method: 'GET'|'POST'|'PATCH'; path: string /* ids replaced by :id */; status: number | 'network_error'; ms: number; retryAfter: string | null; rateLimitHeaders: Record<string,string>; serverDate: string | null; bodyKeys: string[]; errorPreview: string | null /* non-2xx only, redacted, max 300 chars */; at: string };
    export type DownloadResult = { mode: 'noauth'|'bearer'; status: number|'network_error'; contentType: string|null; totalBytes: number|null; redirectHost: string|null; expiryHints: Record<string,string>; magic: 'mp3-id3'|'mp3-frame'|'wav'|'mp4'|'html'|'json'|'unknown'|null; ms: number };
    export function createDialpadClient(opts: { apiKey: string; label: string; guard: SecretGuard; fetchImpl?: FetchLike; now?: () => number; sleep?: (ms: number) => Promise<void> }): {
      request(method: 'GET'|'POST'|'PATCH', path: string, probe: string, body?: unknown): Promise<{ result: ProbeResult; json: unknown | null }>;
      download(url: string, mode: 'noauth'|'bearer'): Promise<DownloadResult>; // Range: bytes=0-1023, redirect: 'manual', never writes the body anywhere
    };
    ```
    Per-route minimum spacing (from the pre-read limits): `GET /api/v2/call/{id}` 7000 ms (10/min), `POST /api/v2/call` and `POST /api/v2/users/{id}/initiate_call` 13000 ms (5/min per user), transcripts 100 ms, everything else 500 ms. On 429, honour `Retry-After` once, record it, and stop that probe; never loop. int64 ids are quoted before `JSON.parse` using the same regex idea as `parseProviderJson` (`provisioning.ts:121-130`); duplicate that 6-line function locally (do not export from `provisioning.ts`, which is product code) and test with `9007199254740993`.
  - `lib/csv.ts`: `toCsv(rows: Record<string, string|number|null>[], columns: readonly string[]): string` with RFC 4180 quoting and formula-injection guard (prefix `'` when a cell starts with `= + - @`).
  - `lib/findings-doc.ts`: `appendFindingsSection(docPath: string, marker: '0.1'|'0.2'|'0.3'|'0.4'|'0.5', markdown: string): { appended: boolean }`. Creates `## Phase 0 findings` once; each item is `### 0.k ...` preceded by `<!-- phase0:0.k -->`; refuses (returns `appended:false`, exit code 3) if the marker already exists, so reruns never duplicate or overwrite.
- Side effects checked: none in product code. `vitest.config.ts` change adds these tests to the husky fast path and `npm test`, so tests must be hermetic (mocked fetch, no network, no Keychain, no `op`; inject a fake `runOp(args) => Promise<string>` runner so tests never spawn the binary).
- Tests (`lib/*.test.ts`):
  - `assertReadOnlySql` rejects `update x`, `select 1; delete from y`, comment-hidden writes (`select 1 /* */; drop table x`), accepts CTE selects.
  - `buildStatusFlipSql` rejects non-UUIDs and any `to` other than `active|disabled`; the output contains `and status = 'disabled'` for `active` and `and status = 'active'` for `disabled`.
  - Dialpad client: int64 id survives; 429 sets `retryAfter` and stops; Authorization header and key never appear in any returned `ProbeResult` or `errorPreview`; `download` never reads past the first 1024 bytes and records only redirect host plus expiry parameter names/values.
  - Guard: a canary secret string passed through `findings-doc` output is scrubbed.
  - `appendFindingsSection` idempotency (second call returns `appended:false`).
  - `toCsv` quoting and formula guard.
- Rollback: delete the directory and revert the two config lines.

#### 0.1 Dialpad key probe (read-only)
- Files: create `scripts/my-leads-phase0/dialpad-key-probe.ts`, `dialpad-key-probe.test.ts`, `lib/verdicts.ts` (probe classification part), output `docs/my-leads/phase0/findings/dialpad-key-probe.json`.
- CLI: `npx tsx scripts/my-leads-phase0/dialpad-key-probe.ts --org-id <uuid> [--keys "Dialpad - API,DialPad Sandra API key"] [--call-id <id> ...] [--project-ref copflsklaefwzipsrjqz] [--out <path>] [--append-to docs/my-leads/DECISIONS-2026-10.md] [--plan]`. `--plan` prints the probe list and the SQL, makes no network call. Default run is read-only (GET and SELECT only; asserted by `assertReadOnlySql` and a method check).
- Change:
  1. SQL (read-only, one query each):
     - `select id, org_id, status, dialpad_company_id, updated_at from public.dialpad_org_connections where org_id = $1` (columns as read at `provisioning-adapters.ts:322`). Never select `webhook_secret_ref` value into the findings (it is a name, but keep the file minimal).
     - `select provider_call_id, event_state, event_timestamp_ms, received_at, disposition, payload ->> 'custom_data' is not null as has_custom_data, payload -> 'target' ->> 'id' as target_id, payload -> 'target' ->> 'type' as target_type, payload -> 'admin_recording_urls' ->> 0 as admin_url, payload ->> 'public_call_review_share_link' as share_link from public.dialpad_call_events where org_id = $1 order by event_timestamp_ms` (columns per `supabase/migrations/20260929034021_dialpad_cti_foundation.sql:211-232`). Expect 15 rows = 5 call ids x calling/connected/hangup (decision record, pre-reads, Production state). The five call ids and the Dialpad user id (`target_id`) come from here, so `--call-id` is only an override. Keep `admin_url` and `share_link` in memory only (used for download probes); the findings store host plus path shape, never the full signed URL.
  2. For each key label (in order), run probes through `createDialpadClient`. Each probe has a stable id used as evidence in the capability map:

     | id | request | What it tells us |
     |---|---|---|
     | P01 | `GET /api/v2/company` | company-level (admin) key if 200 |
     | P02 | `GET /api/v2/users/{target_id}` (same call the app makes, `directory.ts:85`) | directory read; company id compare with `dialpad_company_id` |
     | P03 | `GET /api/v2/users/me` | user-level key identity (docs: user keys may pass `me`) |
     | P04 | `GET /api/v2/webhooks` (paged like `listAll`, `provisioning.ts:189-209`) | find the hook whose `hook_url` equals `webhookUrlFor({publicOrigin}, connectionId)` (`provisioning.ts:170`) |
     | P05 | `GET /api/v2/subscriptions/call` (paged; parse with the same field rules as `parseSubscription`, `provisioning.ts:171-187`) | the owned subscription (`webhookId` = P04 hook id): `enabled`, `call_states`, `target_type`, `target_id`, `group_calls_only`. This is the answer to "did the user-scoped subscription survive the 401 period" |
     | P06 | `GET /api/v2/subscriptions/call/{id}` | single read of the same record (confirms list and get agree) |
     | P07 | `GET /api/v2/call` with `limit=1` | `calls:list` style access |
     | P08 x5 | `GET /api/v2/call/{call_id}` (10/min, 7 s spacing) | which fields exist after the fact: `custom_data`, `admin_call_recording_share_links`, `call_recording_share_links`, `recording_details`, `was_recorded`, `voicemail_link`, `transcription_text`, `state`; `custom_data` equals the stored event value? Record presence booleans and lengths, not values |
     | P09 x5 | `GET /api/v2/transcripts/{call_id}` | transcript permission and readiness; record `lines` count and `moments` count only |
     | P10 x5 | `GET /api/v2/transcripts/{call_id}/url` | URL form of the transcript; status only |
     | P11 | AI Recap candidates, in order: `GET /api/v2/call/{call_id}/ai_recap`, `GET /api/v2/calls/{call_id}/ai_recap` (path unverified: the Dialpad docs describe `recap_summary`/`recap_outcome`/`recap_action_items` as call states delivered by webhook and document no REST path) | record each status; if all 404, finding is "no REST AI Recap path found; recap arrives as event states", which feeds D5 |
     | P12 x5 x2 | download `admin_url` from the stored hangup payload, once with no Authorization header and once with Bearer; also download one `admin_call_recording_share_links[0]` from P08 | `recordings_export` effect; status, content type, total bytes, redirect host, expiry hints, audio magic. Audio is never written to disk |

  3. Classification (pure function `classifyStatus(status): 'allowed'|'unauthorized_key'|'forbidden_scope'|'not_found'|'rate_limited'|'server_error'|'network_error'`): 200-299 allowed; 401 key invalid or revoked; 403 scope or plan missing; 404 not found (for per-call probes this may mean retention, not permission, so the capability map marks it `inconclusive` unless another call id returned 200); 429 rate limited.
  4. Capability map per key (derived only from probe statuses; Dialpad exposes no "list my scopes" endpoint, so scopes are inferred, and the output says so):
     ```ts
     export type KeyFindings = {
       label: string; via: 'env'|'field'|'note'|null; keyUsable: boolean; // false when P02/P03 both 401
       identity: { companyLevel: boolean; userId: string | null; companyIdMatchesConnection: boolean | null };
       capabilities: Record<'readUsers'|'listWebhooks'|'listSubscriptions'|'readCall'|'readTranscript'|'readTranscriptUrl'|'listCalls'|'aiRecapRest'|'recordingDownloadBearer'|'recordingDownloadNoAuth', { verdict: 'allowed'|'denied'|'inconclusive'|'not_tested'; evidence: string[] /* probe ids */ }>;
       subscription: { found: boolean; id: string | null; enabled: boolean | null; callStates: string[]; targetType: string | null; targetIdMatchesStoredEvents: boolean | null; hookUrlMatches: boolean | null };
       probes: ProbeResult[];
     };
     export type DialpadKeyProbeFindings = {
       schemaVersion: 1; runAt: string; orgId: string; connection: { id: string; status: string; dialpadCompanyId: string | null };
       storedCalls: { callIds: string[]; eventsPerCall: Record<string, string[]>; allMatched: boolean; allHaveCustomData: boolean };
       keys: KeyFindings[]; liveKeyLabel: string | null; /* first key with listSubscriptions allowed and subscription.found */
       permissionNeeds: { initiateCallOrPostCall: 'not_probed_read_only'; recordingsExport: ...; aiRecap: ...; transcripts: ...; callsList: ... };
       conclusions: string[];
     };
     ```
     `liveKeyLabel` = first key where P05 is `allowed` and the owned subscription was found. If no key is usable: exit 4, print the exact blocker ("both stored keys rejected: generate a company-admin key with recordings_export and the transcript scope and store it with custom-save-credential") and still write the findings file.
  5. Redaction: phone numbers via `redactText`; no transcript text, no recap text, no `transcription_text` (store length only); no signed URL query strings. The findings JSON is committed.
  6. `--append-to`: render `renderProbeSummary(findings): string` (a 10 to 15 line Markdown block: table of key x capability, subscription status, the five calls' artifact availability, conclusions) and call `appendFindingsSection(doc, '0.1', md)`.
- Side effects checked: GET and SELECT only. Rate limits are respected by the client spacing (P08 is the slow one: 5 calls x 7 s per key). The Dialpad webhook route is not touched (`event-processing.ts:163` still returns 401 for the disabled connection).
- Tests (`dialpad-key-probe.test.ts`, mocked `fetchImpl` and runner, no network):
  - Both keys 401 → exit 4, findings file still written, `liveKeyLabel` null.
  - Key A 200 on P05 with an enabled owned subscription → `liveKeyLabel` is A even if key B also works.
  - Subscription present but `enabled:false` → `conclusions` contains the exact line "subscription disabled; 0.2 must PATCH enabled=true (write, needs Jarrad)".
  - Subscription absent → conclusion "subscription missing; 0.2 must POST a new one (write, needs Jarrad)".
  - 403 vs 401 vs 404 produce distinct verdicts; per-call 404 on a single id stays `inconclusive`.
  - `--plan` makes zero fetch calls (assert mock call count 0).
  - A non-SELECT SQL string cannot reach the runner (the runner mock asserts).
  - The output JSON contains no `Bearer`, no key text, no `dialpad.com/blob` query strings.
  - Stored-event expectations: given 15 fixture rows (5 call ids x 3 states) `storedCalls.allMatched` is true.
- Rollback: delete the script; the findings file and the appended section are a plain revert.

#### 0.2 Dialpad live test (needs Jarrad present; build unattended, run with him)
- Files: create `scripts/my-leads-phase0/dialpad-live-test.ts`, `dialpad-live-test.test.ts`, `lib/verdicts.ts` (D4/D5 deciders, see 0.5); output `docs/my-leads/phase0/findings/dialpad-live-test.json`; raw events under gitignored `.run/<run-id>/`.
- Why no existing call path covers this: the repo never calls the REST `POST /api/v2/users/{id}/initiate_call`. The `initiate_call` in `src/lib/dialpad-cti/protocol.ts:10,121` and `contracts.ts:91` is the Mini Dialer postMessage method used by the abandoned embedded panel; the five stored calls therefore prove `custom_data` only for that path, not for either REST endpoint.
- CLI: `npx tsx scripts/my-leads-phase0/dialpad-live-test.ts <command> --run-id <slug> --org-id <uuid> --connection-id <uuid> --dialpad-user-id <id> --key <label from 0.1> [--allow-number +1XXXXXXXXXX ...]` with commands `plan` (default), `preflight`, `open-window`, `call <C1..C12>`, `poll`, `collect`, `close-window`, `verify-clean`, `recheck`. Every dial target must be in `--allow-number` (E.164, `E164` regex as in `direct-call-feasibility/env.ts`), else the script refuses before any request.
- Custom data used by the spike: `phase0.<run-id>.<call-id>` (not a Sandra token). It does not match `^sandra\.dialpad\.v1\.[0-9a-f]{48}$` (`supabase/migrations/20260929034021_dialpad_cti_foundation.sql:178`) and will not find an intent, so `fn_match_dialpad_call_event` quarantines each event as `unknown_custom_data` (`:847-849`) and `fn_process_dialpad_call_event` never projects (it projects only matched events, `20260929120000_dialpad_cti_call_projection.sql:377-404`). Result: payloads are stored, and no `acquisition_attempts`, `call_activities` or KPI rows are created. Native calls without `custom_data` are quarantined `no_custom_data` (`:847`).
- Safe flip and revert (the "connection temporarily active" mechanism):
  - Status handling today: `dialpad_org_connections.status in ('disabled','active')`, default `disabled` (`20260929034021...:90`); ingest raises `FORBIDDEN connection_inactive` unless `status = 'active'` (`:775-778`); the route returns 401 and stores nothing for a disabled connection (`src/lib/dialpad-cti/event-processing.ts:163`). The guard trigger allows a status update; it blocks only delete, identity change and secret-version decrease (`:271-285`); `touch` sets `updated_at` (`:258-264`).
  - Open (reuse, strict): `createConnectionDbPort(runner).findConnection(orgId, null, connectionId)` then `activateConnection(id, expected)` (`provisioning-adapters.ts:317` and `:339`), which updates only when `status='disabled'` and secret ref, version 1, company id, key ref, origins and client id all still match; it returns the row count and the script requires exactly 1.
  - Close (new, spike-only SQL in `lib/mgmt-sql.ts`; there is no deactivate method in the provisioning port):
    ```sql
    update public.dialpad_org_connections set status = 'disabled', updated_at = now()
     where id = '<connection-id>' and org_id = '<org-id>' and status = 'active' returning id, status;
    ```
    Must return exactly 1 row, then `select status` re-read must say `disabled`.
  - Revert triggers: normal `close-window`; the script's `finally`; `SIGINT`/`SIGTERM`/`uncaughtException` handlers; the hard window cap (`--window-minutes`, default 60, max 90) which closes automatically; and `state.json` (written before the flip with the pre-state) so a later `close-window --run-id` or `verify-clean --run-id` can revert after a crash. `verify-clean` exits non-zero unless the connection is `disabled` and the subscription `enabled` equals the recorded original.
  - Pre-conditions checked by `preflight` (all read-only): connection row is `disabled` and matches `findConnection`; Vercel production env names include the webhook-secret env derived by `parseInputs(...).webhookSecretEnv` (`provisioning.ts:122`) via `createVercelPort(...).listProductionEnvNames()` (`provisioning-adapters.ts:180`; needs the `vercel` CLI), otherwise the route would answer 503 (`src/lib/dialpad-cti/event-processing.ts:166-171`, `candidates.length === 0`) and Dialpad would retry; the Dialpad webhook object for `webhookUrlFor` exists and uses HS256; the owned subscription's `target_id` is the Dialpad user id Jarrad types and `GET /api/v2/users/{id}` returns his email; the sweep cron is configured (`vercel.json:51-54`); `dialpad_call_events` row count and max `received_at` recorded as the "before" snapshot.
  - If the subscription is `enabled:false`, `open-window` PATCHes it with the exact body shape provisioning uses (`provisioning.ts:887`: `{"enabled":true,"target_type":"user","target_id":<id>,"endpoint_id":<webhook id>,"group_calls_only":<bool>,"call_states":[...]}`), records the original, and restores it on close. This is a Dialpad write: requires `--allow-subscription-write` and a typed phrase, and is [JARRAD]-approved in the run checklist. If the subscription does not exist, stop (creating one is a separate approved step, not part of this spike).
  - Confirmation: `open-window` requires `--i-am-present` and the typed phrase `OPEN WINDOW <first 8 of connection id>`.
  - Effect of `active` while open (checked): `startDialpadCall` (`dispatch.ts:462`) and the panel loaders (`dispatch.ts:300`, `:344`) start working for verified bindings; `fn_claim_dialpad_member_binding` allows claims (`foundation.sql:436`); members can read the row (`:914-917`). The only cron touching events is the minute sweep over received or matched-unprojected events (`event-processing.ts` `sweepDialpadCallEvents`), which ignores quarantined rows. Nothing else reads `status`.
  - Permanent residue: `dialpad_call_events` rows cannot be deleted (`dialpad_cti_guard_event`, `foundation.sql:388-393`). Spike rows hold only Jarrad's owned numbers plus any real call he makes during the window; hence the run is outside calling hours and the `collect` step reports any event whose `external_number` is not in `--allow-number` ("foreign events": must be 0; if not 0 stop and tell Jarrad). The findings record `received_at` window and call ids so Phase 2's replay logic excludes them (all spike rows are `unknown_custom_data` or `no_custom_data`; the sibling re-resolution at `call_projection.sql:394-403` only fires after a matched event on the same call chain, which cannot occur without an intent).
- Run checklist (exact order; the script prints this from `plan` and tracks completion in `state.json`):
  1. `preflight` passes; Jarrad confirms: desktop app online and in foreground, mobile app online, B charged and on speaker, he is not expecting real calls; time is outside calling hours.
  2. `open-window` (subscription PATCH if needed, then connection flip). Script prints the cap time.
  3. Calls, strictly one at a time, at least 20 s between API calls (5/min per user). For each, the script timestamps `tPostSent`/`tPostResp`, prints the operator prompt, then records answers typed by Jarrad:

     | id | Action | What to observe and record |
     |---|---|---|
     | C1 | `POST /api/v2/users/{id}/initiate_call` `{phone_number: B, custom_data}` with desktop app up | does the desktop app ring/prompt Jarrad first or dial B immediately; seconds to B ringing; response keys (`device` object, no `call_id` expected); caller ID shown on B |
     | C2 | same as C1 but desktop app fully quit and web app closed | error status and body verbatim (this is the failure the future Call button must handle) |
     | C3 | `POST /api/v2/call` `{user_id, phone_number: B, custom_data}` (all devices) | which device rings first (desktop, mobile, deskphone); whether B rings before or after Jarrad answers the rep leg (ring-then-connect evidence); response `call_id`; answer on desktop |
     | C4 | same as C3 with `device_id` of the desktop (`GET /api/v2/users/{id}/devices` first) | single-device targeting works; mobile does not ring |
     | C5 | same as C3, answer on mobile | works from mobile; events and `custom_data` identical |
     | C6 | Jarrad dials B natively from the desktop app (no API) | do `calling/connected/hangup` events arrive; `custom_data` absent; payload `target`, `external_number`, `direction` |
     | C7 | Jarrad dials B natively from the mobile app | same questions |
     | C8 | B calls Jarrad's Dialpad number; he answers | inbound payload (direction, `external_number`) for D3 tier 2 |
     | C9 | B calls; he does not answer; B leaves a 10 s voicemail | `missed`/`voicemail` states; `voicemail_link`, `transcription_text` present and when |
     | C10 | repeat C1 or C3 (whichever passed), 60 to 90 s conversation, B reads a short scripted sentence | transcript and recap readiness (below); this is the artifact-latency call |
     | C11 | only if C1 and C3 both fail the custom-data check: dial via the Dialpad app launch URL carrying `custom_data` (docs say custom_data is also present for app-launch-URL calls) | fallback evidence for D4 |
     | C12 | hang up while B is still ringing (cancel before connect) | state sequence for a never-connected outbound call (feeds "no answer" guess in D9) |

  4. After C10 hangup run `poll --run-id ... --call C10`: every 30 s for up to 90 minutes (and C3 for 20 minutes) call `GET /api/v2/call/{id}` (10/min), `GET /api/v2/transcripts/{id}` and the AI Recap candidate from 0.1 P11; record first-success wall time relative to the hangup event for: `admin_call_recording_share_links` populated, `recording_details` populated, transcript 200, transcript `moments` non-empty, AI Recap (REST or event state). Also issue one `POST /api/v2/recording_share_link` (100/min; request body per the Dialpad reference, builder reads `developers.dialpad.com/reference` first and records any 4xx body verbatim) to see whether a share link can be minted after the fact.
  5. Recording download attempt (C3 and C10): `download` of `admin_recording_urls[0]` from the hangup payload with no auth, with Bearer for each key, record status, type, bytes, redirect host, expiry parameters. Save nothing. If a body is needed to prove playability, Jarrad may allow one owned test call saved to `.run/<run-id>/c10.mp3` (gitignored), deleted by `close-window`.
  6. Optional state-extension step (needs `--allow-subscription-write`, [JARRAD] yes/no at the prompt): PATCH the owned subscription's `call_states` to the current six plus `recording`, `call_transcription`, `recap_summary`, `recap_outcome`, `recap_action_items` (names from the Dialpad call-events doc; CALL_STATES today is `['calling','ringing','connected','hangup','voicemail','missed']`, `provisioning.ts:30`), place one more 60 s call, record which extra states arrive, when, and with which fields (`public_call_review_share_link`, recap fields), whether Dialpad accepts each name (record 4xx body), then PATCH back to the original six and verify. Extra-state events land as quarantined rows and do not fail anything (matcher has no state filter). This answers the NB1 question in the decision record.
  7. `collect`: read-only SQL for events with `received_at` between window open and close; write raw payloads to `.run/<run-id>/raw/events.json`; build per-call timeline; compute clock offset from the `Date` header of the API responses (`ProbeResult.serverDate`) so latencies are skew-corrected.
  8. `close-window` (restore the subscription first, then revert the flip, so Dialpad never keeps delivering to a disabled connection), then `verify-clean`. Jarrad confirms on the phone that nothing else is ringing.
  9. `recheck` at T+24 h and T+7 d (a later manual or scheduled run): repeat the recording download with the recorded URL to measure expiry; append the result to the findings JSON.
- Data to record (schema in `dialpad-live-test.json`, redacted):
  ```ts
  export type LiveCallRecord = {
    id: 'C1'|...|'C12'; endpoint: 'initiate_call'|'post_call'|'native_desktop'|'native_mobile'|'inbound'|'voicemail'|'cancel'|'launch_url';
    request: { path: string; bodyKeys: string[]; customData: string | null; deviceId: string | null };
    http: { status: number|'network_error'|null; ms: number|null; respKeys: string[]; respCallId: string | null; errorPreview: string | null };
    operator: { ringFirst: 'rep_first'|'seller_first'|'simultaneous'|'unknown'; desktopPrompted: boolean|null; answeredOn: 'desktop'|'mobile'|'deskphone'|null; secondsToSellerRing: number|null; callerIdOnB: string|null /* last4 */; audioOk: boolean|null; notes: string };
    events: { state: string; eventTimestampMs: number; receivedAt: string; hasCustomData: boolean; customDataEqual: boolean|null; keys: string[]; hasAdminRecordingUrls: boolean; hasPublicShareLink: boolean; hasRecap: boolean; disposition: string; reason: string | null }[];
    derived: { postToCallingMs: number|null; callingToConnectedMs: number|null; hangupWebhookDelayMs: number|null /* received_at - event_timestamp, skew-corrected */; allThreeStatesHaveCustomData: boolean|null };
    artifacts: { adminLinkReadyMs: number|null; recordingDetailsReadyMs: number|null; transcriptReadyMs: number|null; transcriptMomentsReadyMs: number|null; recapReadyMs: number|null; recapVia: 'rest'|'event_state'|'none'|null; recordingDownload: DownloadResult[]; shareLinkMinted: boolean|null };
  };
  export type LiveTestFindings = { schemaVersion: 1; runId: string; window: { openedAt: string; closedAt: string; cappedByTimer: boolean }; subscription: { original: { enabled: boolean|null; callStates: string[] }; patched: boolean; restored: boolean }; connection: { before: string; during: string; after: string }; foreignEvents: number; calls: LiveCallRecord[]; extraStates: { name: string; accepted: boolean; arrived: boolean; readyMs: number|null }[]; recheck: { atMs: number; status: number|'network_error'; mode: string }[]; verdicts: { d4: D4Decision; d5: D5Decision } };
  ```
  Latency acceptance numbers are in 0.5; this item only measures. The Markdown summary (`renderLiveSummary`) is appended to the decision doc with `--append-to` on `collect`.
- Stop conditions (script exits after attempting revert and prints them): any dial target not allowlisted; a foreign event; flip row count not 1; window cap reached; Management API or Dialpad errors during revert (print the exact `close-window --run-id <slug>` and `verify-clean` commands to rerun; no hand-written SQL; if the script itself cannot run, escalate to root); any 401/403 from the chosen key on the first API call (go back to 0.1 and re-pick the key).
- Tests (`dialpad-live-test.test.ts`, mocked):
  - `plan` and `preflight` perform no write (mock asserts no POST/PATCH/UPDATE).
  - A non-allowlisted number is refused with zero fetches.
  - `open-window` refuses without `--i-am-present`, without the typed phrase, or when `activateConnection` returns 0 or 2.
  - Revert runs on thrown error, on `SIGINT` (emit via `process.emit`), and on timer cap (fake timers); `state.json` before-state allows `close-window` in a fresh process.
  - `verify-clean` fails when status is `active` or subscription `enabled` differs from the original.
  - Subscription PATCH body equals the provisioning shape and restore uses the saved original `call_states`.
  - Derived latency math with a synthetic skew (client clock +3 s) returns the corrected value.
  - `foreignEvents` counts rows whose `external_number` is outside the allowlist.
- Rollback: `close-window --run-id <slug>` (idempotent, re-reads state, subscription first); revert of the PR removes the script. If the flip was somehow left on, `README.md` and every error message print that command. This spike runs before Phase 2 builds the general tool; once 2.11 has merged, `provision-dialpad-cti.ts --mode deactivate` (subscriptions first) is the only way to disable the connection.

#### 0.3 ATTOM trial script
- Files: create `scripts/my-leads-phase0/attom-trial.ts`, `lib/{attom-client,attom-normalize,attom-metrics,legal-description,arv}.ts`, `attom-thresholds.json`, `attom-cost.json`, `fixtures/attom/{full,partial,no_match,subdivision_only_legal,low_confidence_avm,comps_not_entitled}.json` (synthetic, invented addresses; never paste real ATTOM responses into the repo, licensing), tests; output `.run/attom/` (raw responses, gitignored) and `docs/my-leads/phase0/findings/attom-trial-summary.json` (aggregates only, no addresses).
- CLI: `npx tsx scripts/my-leads-phase0/attom-trial.ts <select-leads|pull|report|all> --org-id <uuid> --member-id <uuid> [--seed phase0-2026-10] [--fixtures] [--live --max-calls 150 --max-usd 20] [--blind-sheet <csv>]`. Default is `--fixtures` when no `ATTOM_API_KEY`/vault item is present; `--live` is required for any ATTOM request and refuses without `--max-calls`, `--max-usd` (hard cap 20, Jarrad 2026-10-04) and a resolvable per-call cost (below); an unknown cost means that call is not made and fixtures are the only mode. There is no `--calls-only` bypass. ATTOM key: env `ATTOM_API_KEY`, else vault item `ATTOM - API`, field `credential` (stored 2026-10-04).
- Lead selection (documented, reproducible, read-only SQL via `createReadOnlyRunner`):
  ```sql
  with cand as (
    select p.id, p.address, p.city, upper(p.state) as state, p.zip, p.attom_id, p.apn, p.fips_code, p.zpid,
           p.beds, p.baths, p.sqft, p.year_built, p.arv, p.is_vacant, p.motivation_level,
           coalesce(q.stage,'not_contacted') as stage, c.first_name, c.last_name,
           md5(p.id::text || '<seed>') as h
    from public.properties p
    join public.acquisition_assignment_episodes e
      on e.property_id = p.id and e.org_id = p.org_id and e.ended_at is null and e.assignee_user_id = '<member-id>'
    left join public.acquisition_queue_states q on q.property_id = p.id and q.org_id = p.org_id
    left join public.contacts c on c.id = p.homeowner_contact_id and c.org_id = p.org_id
    where p.org_id = '<org-id>' and p.assigned_user_id = '<member-id>' and p.deleted_at is null
      and not p.is_dnc_locked and not p.is_training
      and p.status not in ('closed','dead','dnc') and q.archived_at is null
  ), ranked as (
    select *, row_number() over (partition by state order by h) as rn from cand
  )
  select * from ranked where (state in ('MO','KS') and rn <= 10) order by state, rn
  ```
  The filter is the `facts` CTE of `my_leads_queue_rows` (`supabase/migrations/20260912110000_acquisition_read_model.sql:57` join and `:71` where) plus `not p.is_training` (that function does not exclude training leads; decision record N11; column `20260908120000_training_lead_guards.sql:2`). 10 per state gives the KC-metro MO side and the Kansas side the trial needs; if a state has fewer than 10, the script fills from the other state and then from any other state by `h` order, and records the actual split. The seed, SQL text, row counts per state and per stage, and the 20 property ids go into `summary.selection`. `p.attom_id` is pulled to measure how many leads already carry an id and whether the address lookup resolves to the same id.
- Blind sheet (to avoid anchoring on ATTOM): `select-leads` also writes `.run/attom/jarrad-blind-sheet.csv` with only `property_id,address,city,state,zip,jarrad_asis,jarrad_arv,jarrad_rehab,zestimate_manual,notes`, value columns empty. Jarrad fills his as-is, ARV and rehab numbers before `pull` runs, and types the Zillow Zestimate by hand (Zillow has no API; no scraping). `report` refuses to compute accuracy metrics for rows where `jarrad_asis` is empty and says how many rows were skipped.
- ATTOM calls per lead (base `https://api.gateway.attomdata.com`, headers `apikey: <key>`, `Accept: application/json`). Paths and parameter names are taken from ATTOM's documentation as found on 2026-10-04 and must be confirmed against the live ATTOM docs by the builder before coding; any non-200 body is recorded verbatim (redacted) and that call is retried once without optional parameters:

  | id | Endpoint | Params | Extract |
  |---|---|---|---|
  | A1 | `GET /propertyapi/v1.0.0/property/detail` | `address1=<street>`, `address2=<City, ST ZIP>` | `identifier.attomId`, `address`, `summary.legal1`, `lot`, `building.size`, `building.rooms`, `summary.yearbuilt`, `location.latitude/longitude`, `identifier.apn`, `area.countrysecsubd` |
  | A2 | `GET /propertyapi/v1.0.0/attomavm/detail` | same address, or `attomid` from A1 | `avm.amount.value`, `.low`, `.high`, `.scr` (confidence score), `avm.eventDate` |
  | A3 | Sales comparables (`GET /property/v2/salescomparables/propid/{attomId}`; address form `.../address/{street}/{city}/{county}/{state}/{zip}` as fallback) | `searchType=Radius`, `miles=1`, `minComps=3`, `maxComps=10`, `saleDateRange=12` (months), `bedroomsRange=1`, `bathroomsRange=1`, `sqFeetRange=500` | per comp: sale price, sale date, distance, beds, baths, sqft, year built, address |
  | A4 | `GET /propertyapi/v1.0.0/property/detailowner` | same address | owner 1 and 2 full names, absentee status, mailing address |
  | A5 (optional `--with-expanded`) | `GET /propertyapi/v1.0.0/property/expandedprofile` | same address | exists only to check whether a longer legal description appears elsewhere |

  The legal description is taken from A1 (`summary.legal1`; the ATTOM docs show it as a one-line value such as a subdivision plus lot). To avoid hard-coding a path that may be wrong, `lib/attom-normalize.ts` exports `findLegalFields(json): { path: string; value: string }[]` (recursive scan for keys matching `/^legal/i`) and the summary records every path that exists across the 20 leads. A "comps not entitled" response (ATTOM sales comparables is a separate entitlement and may be absent from a trial key) is classified `not_entitled`, not `failed`, and the report states that D6 cannot be judged until Jarrad asks ATTOM to enable it.
- Normalisation and metrics:
  ```ts
  export type LeadPull = { propertyId: string; mode: 'live'|'fixture'; calls: { id: 'A1'|'A2'|'A3'|'A4'|'A5'; status: number|'network_error'|'not_entitled'; ms: number; credits: number|null; usd: number|null; headers: Record<string,string> }[]; attomId: string|null; attomIdMatchesStored: boolean|null; avm: { value: number|null; low: number|null; high: number|null; scr: number|null; eventDate: string|null }; comps: Comp[]; owner: { owner1: string|null; owner2: string|null; absentee: boolean|null; mailingAddress: string|null }; legal: { text: string|null; klass: 'full'|'subdivision_only'|'missing'; path: string|null } };
  export function classifyLegalDescription(text: string | null): 'full'|'subdivision_only'|'missing';
  export function deriveArvFromComps(subject: { sqft: number|null; beds: number|null }, comps: Comp[], opts?: { maxMonths?: number; maxMiles?: number; minComps?: number }): { arv: number|null; method: string; compsUsed: number };
  ```
  - `classifyLegalDescription`: `missing` if null or shorter than 8 chars; `full` if at least 25 characters and it contains a lot token (`/\b(LOT|LT)\b/i`) and one of block, subdivision, plat, section, township/range tokens (`/\b(BLK|BLOCK|SUB|ADDITION|ADD|PLAT|SEC|TWP|RNG)\b/i`) or a metes-and-bounds marker (`/\b(BEGINNING|THENCE|POB)\b/i`); otherwise `subdivision_only` (the Assigns example, "VINEYARD WOODS", is `subdivision_only`). The heuristic is recorded as a heuristic: Jarrad spot-checks 5 of the `full` results against the county record before the legal-description gate is treated as passed.
  - `deriveArvFromComps` (no ATTOM renovated flag exists; this is a proxy and the report says so): informational only (ARV is Jarrad's own number, approved 2026-10-04): keep comps sold within `maxMonths` (6), within `maxMiles` (1), beds within plus or minus 1, sqft within plus or minus 20 percent of subject; require at least `minComps` (4) after filtering else `arv:null`; ARV = subject sqft x median of the top-quartile price per square foot. Compared against `jarrad_arv`.
  - CLOSR anchors use `calculateClosr({ ...DEFAULT_INPUTS, asIs: avm.value })` (`src/lib/calculators/closr-v1.ts:5-9` defaults, `:48` function) and record only `commission`, `listing`, `equity`, `family`, `secure`, `rapid` (`:61-62`). Because `calculateClosr` zero-fills a missing ARV (`:49` `n()`), `arv70`, `investor` and `offers` are never written to the CSV unless `arv` is non-null, and a test asserts that (decision record NN2).
  - Cost: `attom-cost.json` `{ "perCallUsd": { "A1": null, "A2": null, "A3": null, "A4": null, "A5": null }, "perCallCredits": { ... null }, "ceilingUsd": null, "ceilingCalls": 150 }`. `--live` requires `ceilingCalls` (150) and `ceilingUsd` (20, a hard cap on total trial spend). Before every call the client resolves that call's cost from ATTOM's published per-call price (`perCallUsd`, filled by the builder from ATTOM's price list and confirmed against the account usage endpoint or the credit/quota headers of the previous response) and stops before any call whose cost is unknown, or whose cost added to the running total would exceed $20, recording `stoppedBy: 'cost_unknown' | 'ceiling_usd' | 'ceiling_calls'`. Free-trial calls cost $0 and count as such. The running total is persisted in `.run/attom/state.json` so reruns cannot restart from zero.** Headers whose names match `/credit|quota|rate|limit|usage/i` and the ATTOM `status.total`/`transactionID` fields are captured into `calls[].headers` to learn how the trial reports consumption. Expected volume: 20 leads x 4 calls = 80, plus at most 20 retries and 5 optional A5 = 105; default ceiling 150 calls.
  - Latency: per call `ms`; per lead sequential total; one lead is also pulled with A1, A2, A4 in parallel to measure the fastest lead pull. Report p50/p95.
- CSV outputs (`.run/attom/leads-comparison.csv`, uncommitted because it holds addresses and Jarrad's numbers):
  `property_id, address, city, state, stage, mode, a1_status, a2_status, a3_status, a4_status, attom_id, attom_id_matches_stored, avm_value, avm_low, avm_high, avm_scr, jarrad_asis, avm_vs_jarrad_pct, zestimate_manual, zestimate_vs_jarrad_pct, avm_vs_zestimate_pct, comps_returned, comps_within_12mo_1mi, comps_complete_fields_pct, legal_text_len, legal_class, owner1, owner2, owner_surname_matches_contact, jarrad_arv, derived_arv, derived_arv_vs_jarrad_pct, closr_equity, closr_family, closr_secure, closr_rapid, ms_total_sequential, usd_est, credits_est`.
- Thresholds Jarrad must set. They live in `scripts/my-leads-phase0/attom-thresholds.json`; the committed file holds proposed defaults and `"approvedAt": null, "approvedBy": null`. Only Jarrad edits the values and sets those two fields. `report` prints `UNAPPROVED DEFAULTS` and caps the verdict at `NOT_EVALUATED` while `approvedAt` is null.

  | Key | Meaning | Proposed default [JARRAD] |
  |---|---|---|
  | `maxTrialSpendUsd` | spend ceiling for the whole trial | `20` (Jarrad, 2026-10-04) |
  | `matchCoveragePct` | leads where A1 resolves a property (overall, and each of MO and KS) | 90 overall, 85 per state |
  | `avmPresentPct` | leads with an AVM value | 85 |
  | `avmUsableConfidencePct` | share of AVMs with `scr` at or above `avmMinScr` | 60 at `avmMinScr` 70 |
  | `avmVsJarradMedianAbsPct` | median absolute percent gap between ATTOM AVM and Jarrad's as-is | 10 |
  | `avmWithin15PctShare` | share of leads where the gap is within 15 percent | 70 |
  | `avmOff25PctMaxLeads` | leads allowed to differ by more than 25 percent | 2 of 20 |
  | `compsCoveragePct` | leads with at least 3 sold comps in 12 months within 1 mile | 75 |
  | `compsFieldCompletePct` | comp fields (price, date, beds, baths, sqft, distance) populated | 90 |
  | `legalFullPct` | leads whose legal description classifies `full` | 80 (failing this does not fail ATTOM; legal stays manual per D8) |
  | `ownerPresentPct` and `ownerSurnameMatchPct` | owner of record present; surname matches Sandra's contact | 85 and 70 |
  | `callLatencyP95Ms` and `leadPullP95Ms` | per call and full sequential pull | 3000 and 10000 |
  | `costPerLeadPullUsd` | cost of one lead's pull | $0.50 |
  | `arvWithin10PctShare` | derived ARV within 10 percent of Jarrad's ARV | 60 (informational only: ARV is Jarrad's own number, approved 2026-10-04; a derived ARV is never written in v1) |
  | ARV method | Jarrad sets it (approved 2026-10-04); derived ARV is informational only | Jarrad sets it |

- Fixture mode: `--fixtures` generates 20 synthetic leads (no database, no network), maps each to a fixture case by `md5(address) % cases`, runs the same pull, normalise, metrics and report path, stamps every CSV row `mode=fixture`, prints a `FIXTURE DATA - NOT A TRIAL RESULT` banner, and forces the verdict to `NOT_EVALUATED`. It exists so the pipeline is proven before a key exists and so the unit tests run in CI.
- Side effects checked: read-only SQL; ATTOM is the only external call and runs only with `--live`; no writes to Sandra tables; nothing is stored on `properties` (a later phase adds comp storage).
- Tests (`attom-trial.test.ts`, `lib/*.test.ts`):
  - `classifyLegalDescription`: lot+block → `full`; "VINEYARD WOODS" → `subdivision_only`; "" → `missing`; metes-and-bounds text → `full`.
  - `deriveArvFromComps` returns null under 4 comps, uses the top-quartile median otherwise, and ignores comps outside the filters.
  - CLOSR rows: with `arv=null` the CSV has no `arv70|investor|offers` values; with `asIs` only, `equity` equals `calculateClosr({...DEFAULT_INPUTS, asIs}).equity`.
  - `--live` with an unknown per-call cost makes no call (mock counts zero); with $19.90 spent and a $0.25 call the call is refused with `stoppedBy: 'ceiling_usd'`; the running total survives a restart; there is no flag that skips the cost check (a test greps the CLI parser for `calls-only`).
  - Thresholds with `approvedAt: null` can never yield `GO`.
  - `comps_not_entitled` fixture maps to `not_entitled`, not `failed`, and the verdict becomes `INCONCLUSIVE_COMPS`.
  - Selection SQL: the string contains `not p.is_training` and `p.assigned_user_id`, passes `assertReadOnlySql`, and fixture mode never constructs a runner.
  - Blind sheet has no ATTOM columns; `report` skips rows with an empty `jarrad_asis` and reports the count.
  - Output CSV and summary contain no API key and no full address in the committed summary JSON.
  - Full pipeline `all --fixtures` exits 0, yields 20 rows, and prints the banner.
- Rollback: delete the files; nothing persists in the database.

#### 0.4 Dropbox Sign template audit
- Files: create `scripts/my-leads-phase0/esign-template-audit.ts`, `esign-template-audit.test.ts`, output `docs/my-leads/phase0/findings/esign-template-audit.json` (field names and verdicts only), raw template PDFs in gitignored `.run/esign/`.
- Run: `node --conditions=react-server --import tsx scripts/my-leads-phase0/esign-template-audit.ts --org-id <uuid> [--template-id <provider id> ...] [--no-pdf] [--append-to docs/my-leads/DECISIONS-2026-10.md]`. The flag is needed because `src/lib/esign/dropbox-sign.ts:1` imports `server-only` (precedent: `scripts/inbox-p0-baseline.ts:2`). The `@/` alias is resolved by tsx from `tsconfig.json:24-26`.
- Change:
  1. Read-only SQL: `select id, name, document_type, seller_role, signer_roles, merge_field_names, sign_template_id, lifecycle_state, template_origin, provider_account_id, provider_metadata from public.esign_templates where org_id = $1 and deleted_at is null` (columns from `20260829194500_esign_foundation.sql:224-285` and `...912220000_esign_website_soft_delete.sql`; verify `template_origin`, `provider_account_id` and `provider_metadata` against `src/lib/supabase/types.ts` before coding). `--template-id` overrides discovery.
  2. Key: item `Dropbox Sign - Sandra eSign Test Mode` through `readSecret`; field titles found with `listFieldTitles` (match `/api.?key/i` and `/client.?id/i`; print titles only). Build the provider exactly as the app does: `createDropboxSignProvider({ apiKey: new EsignSecret(key), clientId })` (`src/lib/esign/dropbox-sign.ts:88`; `EsignSecret`, `src/lib/esign/secret.ts:1`).
  3. Calls, all read-only: `provider.validateCredentials()` (`:96`, `accountGet` and `apiAppGet`), `provider.getTemplate(id)` (`:191`, returns `ProviderTemplateMetadata`, `src/lib/esign/contracts.ts:141-155`). Do not call `registerDropboxWebsiteTemplate` or `revalidateDropboxWebsiteTemplate` (`website-template-registration.ts:74`, `:92`): they write template state. For the clause check the script also calls `provider.getTemplateFiles(id)` (`dropbox-sign.ts:202`, a GET of the template PDF; the decision record asks to inspect the document itself, so this is the one call beyond `getTemplate`, and it only reads). A 404 means the template is not visible to this key (it belongs to another Dropbox Sign account); the script records `not_visible_to_key` and lists which template ids Jarrad must supply from the test account.
  4. Structural checks per template, reusing the app's own rules rather than inventing new ones: `isEmbedded === false`, `isLocked === false`, at least one document, account membership (the rules in `validateWebsiteProviderMetadata`, `website-template-registration.ts:197-240`); `getEsignFieldSchema(names)` (`contracts.ts:55-59`) resolves to `legacy-v1` (5 fields), `residential-v1` (13) or `novation-v1` (26); sender-assigned fields are the merge fields (`assignedTo === 'sender'`, `dropbox-sign.ts` `providerTemplateField`); signer roles match `ESIGN_TEMPLATE_SIGNER_ROLES` (`contracts.ts:74-77`, Seller then Buyer) or `ESIGN_NOVATION_TWO_SELLER_ROLES` (`:79-83`); drift between live metadata and the stored `provider_metadata`.
  5. Assignment clause check: `pdftotext -layout - -` through `spawn` with the PDF on stdin (`/opt/homebrew/bin/pdftotext` exists on this machine; same stdin-only discipline as `runCommand`, `provisioning-adapters.ts:142`); if the binary is missing, save the PDF under `.run/esign/` and mark the check `manual_review_required`. Search the text with case-insensitive patterns and keep a 120-character context window for each hit:
     - `assign(s|ment|able)?` near `(this (agreement|contract)|rights|buyer)`
     - `and/or assigns`, `and assigns`
     - `without (the )?(prior )?(written )?consent`
     - `(may|shall|shall not|may not) assign`
     Verdict enum: `explicit_assignment_right` (Buyer may assign), `and_assigns_only`, `assignment_prohibited_or_consent_required`, `silent`, `manual_review_required`. The script detects and quotes; it does not give legal advice and Jarrad dropped legal review of template defaults, so it reports only.
  6. Vesting and signer inputs: also search the text for `vest|tenancy|joint tenan|tenants in common|as husband and wife`, and report whether any template field could hold vesting (no schema field named for it exists in any of the three schemas, `contracts.ts:23-59`). Signer emails are not merge fields: they come from `SendContractInput.signers` (`src/app/(dashboard)/leads/[id]/esign-types.ts` `SignerAssignment`) and `sellerDefaults` (`lead-esign-action-core.ts:399-403`); `send` blocks `owner_email_missing` is a warning only (`:1122`).
  7. Field inventory table written to the findings and to the doc. The prefill column is the proposed D8 source (it is a plan, not an existing behaviour: today `loadPreflight` prefills only `seller_name` and `property_address` plus the residential address and seller email, `lead-esign-action-core.ts:399-411`, `send-for-signature.tsx:635-651`; `send-contract.ts:121-130` requires every field except `additional_terms` to be non-blank). The script checks each template field name against this table and flags the observed confidence:

     | Field (schemas) | Prefill source for D8 | Expected confidence | Gap or note |
     |---|---|---|---|
     | `seller_name` (all) | `contacts.first_name + last_name` of `homeowner_contact_id` (already `context.sellerName`); cross-check ATTOM owner of record | High when it matches owner of record, Medium otherwise | two-seller novation needs `Seller 2` from ATTOM owner 2 or manual |
     | `buyer_name` (res, nov) | org default buyer entity (D8 picker) | High | list and default are [JARRAD] |
     | `property_address`, `property_city`, `property_state`, `property_zip` | `properties.address/city/state/zip` | High (CASS-verified where `cass_status` says so) | novation schema has only `property_address` and `property_state` |
     | `legal_description` (res, nov) | ATTOM A1 legal text | Low unless `classifyLegalDescription` is `full`; never prefilled when Low (D8) | editable fallback is required; subdivision-only is common |
     | `offer_price` (all) | editable; seeded from the latest `offer_calculations.decision.proposedOffer` (`20260916090000_offer_calculations.sql:24`) | High because Jarrad edits it | |
     | `earnest_money` (all) | org default $500 | High | |
     | `earnest_money_holder` (res, nov) | title company picker | High if picker | title company list is [JARRAD] |
     | `cash_balance` (res) | `offer_price - earnest_money` | High if the template means that | audit checks the template's label text |
     | `closing_date` (all) | editable; default none, the rep types it (3.9) | High as editable | none |
     | `additional_terms` (res, nov) | empty, optional | n/a | exempt from the non-blank rule |
     | `agreement_date` (nov) | send date, America/Chicago | High | |
     | `seller_closing_cost_cap` (nov) | org default | Medium | default [JARRAD] |
     | `closing_agent_name`, `closing_agent_phone`, `closing_agent_address` (nov) | title company record | Medium | title company list must carry phone and address |
     | `due_diligence_days`, `access_days_per_week`, `access_hours_per_visit` (nov) | org program defaults | Medium | defaults [JARRAD] |
     | `offer_expiration` (nov) | send time + default window | Medium | window [JARRAD] |
     | `acceptance_date` (nov) | none (signer or counter-sign date) | Low | check whether this should be a signer field, not sender |
     | `buyer_phone`, `buyer_email` (nov) | org default buyer entity contact | High | |
     | `seller_phone` (nov) | `contacts.phone_1`..`phone_3` (the dialled slot) | High | |
     | `seller_email` (nov) | `contacts.email` (`sellerDefaults.emailAddress`) | Medium (often empty) | editable fallback |
     | `attorney_in_fact` (nov) | org default BMH signatory | Medium | [JARRAD] |
     | `release_date` (nov) | derived from closing date and diligence days | Low | likely manual |

  8. Gaps list (rule-generated, in `gaps[]`): template fields not in any schema (this makes `getEsignFieldSchema` return null; note `registerDropboxWebsiteTemplate` dereferences the result with `!` at `website-template-registration.ts:86`, so such a template would throw at registration); schema fields missing from the template; merge fields assigned to a signer instead of the sender; roles not matching the two role sets; embedded or locked template; stored vs live metadata drift; no assignment language; no vesting field; any field in the table above marked Low or without a source.
- Side effects checked: all calls are GET; test-mode key; no signature request is created, no template is created or deleted. Template PDFs are contract templates (no personal data) and stay in gitignored `.run/`.
- Tests (`esign-template-audit.test.ts`, mocked provider and `spawn`):
  - Given a `ProviderTemplateMetadata` fixture with the 13 residential fields, schema resolves to `residential-v1` and no gaps are produced except those from the prefill table.
  - An extra field `foo` → gap "not in any schema" and the registration-throw note.
  - A merge field assigned to `Seller` → gap "assigned to signer".
  - Assignment regex: "Buyer may assign this Agreement" → `explicit_assignment_right`; "heirs, successors and assigns" → `and_assigns_only`; "may not assign without Seller's written consent" → `assignment_prohibited_or_consent_required`; none → `silent`.
  - Missing `pdftotext` → `manual_review_required` and the PDF is saved, not parsed.
  - A 404 from `getTemplate` is recorded `not_visible_to_key` and the run continues with the next template.
  - Provider mock asserts no method other than `validateCredentials`, `getTemplate`, `getTemplateFiles` is ever called.
  - Output contains no API key.
- Rollback: delete the files.

#### 0.5 Findings note and go/no-go criteria
- Files: modify `docs/my-leads/DECISIONS-2026-10.md` (append only); create `scripts/my-leads-phase0/lib/verdicts.ts` and `verdicts.test.ts`. Do not edit any existing line of the approved decision text; proposed decision edits go in a subsection the next Codex review can accept or reject.
- Findings note format (appended by `appendFindingsSection`, one subsection per item, in this order):
  ```
  ## Phase 0 findings (run <YYYY-MM-DD>, <git sha of the scripts>)
  Status line: 0.1 done | 0.2 done/deferred | 0.3 fixtures-only/live done | 0.4 done/partial
  ### 0.1 Dialpad key probe   <!-- phase0:0.1 -->
    - Live key: <label or none>; company-level: yes/no; subscription: found/enabled/target user = Jarrad: yes/no
    - Capability table (key x capability, verdict, evidence ids)
    - Five stored calls: share link on GET /call: n/5; admin link: n/5; transcript 200: n/5; recap path: rest|event|none
    - Permission needs stated plainly (what Jarrad must ask Dialpad for, if anything)
  ### 0.2 Dialpad live test   <!-- phase0:0.2 -->
    - Per-call table C1..C12: endpoint, custom_data on calling/connected/hangup, ring order, mobile, caller ID
    - Latency table: p50/max for post->calling, webhook delay, artifact readiness (admin link, transcript, recap)
    - Recording download: no-auth/Bearer status, expiry hints, T+24h/T+7d recheck
    - Extra subscription states accepted and what they carry
    - Verdicts (generated): D4 endpoint, D5 schedule and artifact sources
  ### 0.3 ATTOM trial   <!-- phase0:0.3 -->
    - Mode: live|fixture; thresholds approvedAt; per-metric table (value, threshold, pass/fail); spend vs ceiling
    - Legal-description class counts; comps entitlement
    - Verdict (generated): D6
  ### 0.4 Dropbox Sign template audit   <!-- phase0:0.4 -->
    - Per-template structure result, schema version, assignment-clause verdict with quoted context
    - Field inventory table; gaps list
  ### Proposed decision edits (not applied; for Codex review and Jarrad)
    - numbered, each citing the finding that triggers it
  ```
- Go/no-go criteria (implemented as pure functions in `lib/verdicts.ts` so the doc text is generated, not hand-written):

  **D4 endpoint** (`decideD4(initiateCall: EndpointEvidence, postCall: EndpointEvidence, native: NativeEvidence, launchUrl?: EndpointEvidence): D4Decision`)
  - An endpoint PASSES when `custom_data` equals the sent value on all three of `calling`, `connected`, `hangup`, the call is placed through the intended device, and the HTTP response is 2xx. (The matcher binds on the first event carrying the token and frozen target and number; `fn_match_dialpad_call_event`, `foundation.sql:839-880`.)
  - `initiate_call` passes → keep D4 as written. If `POST /call` also passes and the operator recorded `ringFirst = rep_first` in every `POST /call` attempt, add "ring-then-connect candidate for scheduled callbacks" to Proposed decision edits; it never auto-changes D4, and a change needs a decision-doc edit and Codex review.
  - Only `POST /call` passes → D4 endpoint becomes `POST /api/v2/call` with `user_id`; consequences listed (returns `call_id` immediately, rings every device unless `device_id` is set, mobile supported).
  - Neither passes but app launch URL (C11) passes → D4 uses the launch URL.
  - None pass → D4 falls back to number matching only (`no_lead_match` path); the Call button cannot attach a Sandra token, and Phase 2's intent flow is replaced by time-window plus number matching. This is a plan change for Jarrad.
  - Native desktop and native mobile events must arrive with `direction`, `external_number` and `target`; if mobile events do not arrive, the D4 claim that mobile calls are matched is struck from the decision record.
  - Failure behaviour from C2 (desktop app quit) is recorded as the error the Call button must show.

  **D5 fetch design** (`decideD5(...)`):
  - `recording_url` backfill source: hangup payload `public_call_review_share_link` present on native calls (yes/no); if no, backfill from `GET /api/v2/call/{id}` or `POST /recording_share_link`, whichever returned a link.
  - Admin recording download auth: `bearer_ok`, `noauth_ok` or `none`; if `none`, "download recording file" is out of Phase 3 scope and only the share link is stored; if expiry is under 24 h, the plan stores the share link only and never the signed blob URL.
  - Retry schedule: take the p95 readiness for transcript and recap across C3/C10, pick the smallest schedule from `{1,5,15,60,240}` minutes whose last step is at least 1.5 times that p95; the decision record's 1/5/15/60 is kept only if p95 is 40 minutes or less.
  - AI Recap: `rest` (path recorded), `event_state` (needs the extra subscription state, so D5's "subscription keeps its six states" must change), or `none` (D5 drops the summary until Dialpad enables it, and Jarrad is told which Dialpad plan feature or permission is missing).
  - Transcript endpoint permission: if 403 with the best key, state the exact permission to request.
  - Webhook delivery delay: p95 of `received_at - event_timestamp` at 10 s or less; above that, the 2-minute "intent with no event" timeout in D5 is lengthened to 3 x p95.

  **D6 provider** (`decideD6(report, thresholds): 'GO_ATTOM'|'CONDITIONAL_ATTOM_LEGAL_MANUAL'|'NO_GO_TRY_RENTCAST'|'INCONCLUSIVE_COMPS'|'NOT_EVALUATED'`):
  - `NOT_EVALUATED` when mode is fixture or `approvedAt` is null.
  - `INCONCLUSIVE_COMPS` when A3 returned `not_entitled` for more than half the leads.
  - `NO_GO_TRY_RENTCAST` when any of match coverage, AVM present, AVM-vs-Jarrad (median, within-15 share, off-25 count), comps coverage or cost-per-pull fails. The same harness is then reused for RentCast through a second `PropertyDataProvider` adapter (a follow-up task, not part of this phase).
  - `CONDITIONAL_ATTOM_LEGAL_MANUAL` when all of those pass but `legalFullPct` fails: ATTOM goes ahead and `legal_description` stays an empty editable field in D8.
  - `GO_ATTOM` when everything passes, including `legalFullPct` after Jarrad's 5-sample spot-check.
  - Latency failures alone (`callLatencyP95Ms`, `leadPullP95Ms`) do not change the provider verdict; they change the plan (pull on assignment is already rejected, so a slow pull only affects the "comps pending" window).
  - Spend over `maxTrialSpendUsd` stops the run and the verdict is computed on what completed, marked partial.
- Tests (`verdicts.test.ts`): table-driven cases for every branch above (D4: four outcomes plus ring-first note; D5: schedule selection at p95 of 3, 20, 70 and 300 minutes, recap rest/event/none, bearer/noauth/none; D6: all five outputs including the unapproved-thresholds cap).
- Rollback: the appended section is removed by reverting the PR; the generated verdicts are inputs for Proposed decision edits and change nothing until Codex and Jarrad accept them.

### Acceptance (what the builder runs before opening the PR)
- Static: `npm run typecheck` (`tsc --noEmit`, `package.json:43`) clean; `npx eslint scripts/my-leads-phase0 vitest.config.ts` clean; `npx vitest run scripts/my-leads-phase0` all green; `npm test` (`vitest run`, `package.json:13`) green with the added include.
- Hermetic dry runs (no network, no keys needed):
  - `npx tsx scripts/my-leads-phase0/dialpad-key-probe.ts --org-id <uuid> --plan` prints the probe list and SQL, exits 0.
  - `npx tsx scripts/my-leads-phase0/dialpad-live-test.ts plan --run-id x --org-id <uuid> --connection-id <uuid> --dialpad-user-id 1` prints the checklist, exits 0, performs no request.
  - `npx tsx scripts/my-leads-phase0/attom-trial.ts all --org-id <uuid> --member-id <uuid> --fixtures` exits 0, prints the fixture banner, writes 20 rows, verdict `NOT_EVALUATED`.
- Unattended live runs the builder performs (read-only, credentials already provided): `dialpad-key-probe.ts` with `--append-to` (expect 15 stored events, 5 call ids, a `liveKeyLabel` or an explicit blocker, and the subscription state); `esign-template-audit.ts` with the test-mode key (expect a per-template table or `not_visible_to_key`). Expected result: both write findings JSON and append `0.1` and `0.4` sections; reruns exit 3 without changing the doc.
- Not run unattended: 0.2 (needs Jarrad), 0.3 live (needs only approved thresholds; spend is hard-capped at $20). The PR states each as pending with the exact command.
- Repo and production checks: `git diff --stat main...HEAD` shows no file under `src/` or `supabase/`; `select status from public.dialpad_org_connections` is still `disabled` and `select count(*) from public.dialpad_call_events` is unchanged by anything the builder ran; `verify-clean` is available but only relevant after 0.2. No canary or preview check applies (no deployed code); the verification is the script output plus the unchanged production rows.
- Review: Claude review, then Codex adversarial review at the PR head (`APPROVE_MERGE: YES` read from the raw verdict) before any merge offer; re-review after any new commit.

### Risks and open questions
- [JARRAD] Whose user does the existing subscription target? The provisioning script takes `--canary-user-id` (`scripts/provision-dialpad-cti.ts:49`, up to two, `MAX_CANARY_USERS = 2`, `provisioning.ts:32`). If it is not Jarrad's Dialpad user, events from his desktop will not reach Sandra, and 0.2 needs a new or edited subscription (a Dialpad write). 0.1 reports `targetIdMatchesStoredEvents`; the run checklist asks Jarrad to confirm his Dialpad user id.
- [JARRAD] Approval for the two Dialpad writes in 0.2 (re-enable a disabled subscription; temporary extra `call_states`) and for the temporary production `status='active'` flip, each with the revert described. Default if he declines the subscription writes: run only what the current subscription allows and record the rest as untested.
- Dialpad may have auto-disabled or deleted the subscription after the 401 period (the pre-reads flag this). If it is gone, creating a new one is outside this phase; the fallback is Option B: capture raw payloads on a disposable local receiver behind a tunnel with a temporary second subscription, following the `scripts/direct-call-feasibility` safety rules, which proves payload shape but not Sandra's signature and quarantine path.
- Spike events can never be deleted (`dialpad_cti_guard_event`, `foundation.sql:388-393`); they stay quarantined. Keep the run to owned numbers and outside calling hours; Phase 2 must exclude the recorded window from any replay.
- The AI Recap REST path is unknown (Dialpad documents recap as webhook states, `call-events` doc, and `GET /call/{id}` lists no recap fields). 0.1 and 0.2 report what they find; do not assume a REST path exists.
- ATTOM paths, parameter names and the comps entitlement are from the public docs as of 2026-10-04 and unverified against a live key. A trial key may not include Sales Comparables; the script treats that as `not_entitled` and the report says D6 cannot be judged. Ask ATTOM to enable it before the 30-day trial clock is spent.
- ATTOM sold comps carry no renovation flag. Any "renovated comps" ARV is a price-per-square-foot proxy; expect it to fail validation, which D6 already allows (nullable `arv_estimate`).
- Comparing ATTOM comps to Assigns compares ATTOM to itself (pre-read finding 4); the check is ATTOM AVM vs Zestimate vs Jarrad's own number, and comps are judged on completeness.
- Legal-description class is a heuristic. Jarrad spot-checks 5 results; until then the gate is not treated as passed.
- The Dropbox Sign test-mode key may belong to a different account than the production website templates, so `getTemplate` can 404 on templates the app uses. If so, [JARRAD] supplies test-account template ids, or the audit is re-run with the production key under his explicit approval (production key use is not assumed).
- `registerDropboxWebsiteTemplate` asserts the schema with `!` (`website-template-registration.ts:86`), so a template whose field set is not exactly one of the three schemas throws at registration. If the audit finds such a template, D8 needs a template change or a schema addition; record it as a gap, do not work around it here.
- The Management API runs SQL as a superuser; the read-only guard (`assertReadOnlySql`) and the single-statement flip builder are the controls and are test-covered. Review them with extra care.
- Modifying `vitest.config.ts` pulls these tests into the husky fast path; keep every test hermetic.
- Appending to `DECISIONS-2026-10.md` modifies a Codex-approved file; findings go in a new section only, and the PR needs a fresh Codex review at its head.


---

## Phase 1: Next-step vocabulary, ranked strip, post-call prompt, link capture
**Goal.** Make every "what happens next" a single appointment-or-task write path with one read definition, rank the ten leads Jarrad should call next with a stated reason, replace the three-dialog logging flow with one post-call prompt, and capture Dialpad's recording link at hangup.
**Depends on.** The decision-record PR for `docs/my-leads/DECISIONS-2026-10.md` (Codex-approved at 6edf9b68, branch `claude/my-leads-one-call-close-decisions`). No code dependency on Phase 0 (spike) and none on Phase 2/3.
**Branch / PR.** Split into 8 stacked PRs (a single PR would be ~7,000+ changed lines). Every base below is a branch, never `main`, except P1e once the decision-record PR has merged. The merge order is the header table's order, not the table order below. Each PR body states `Depends on: #<parent>`; numbers are filled when the parent PR is created. AGENTS.md "PR dependency locking" applies: create each child with `gh pr create --base <parent branch>`.

| Sub-PR | Branch | Base | Depends on | Covers | Est. lines |
|---|---|---|---|---|---|
| P1e | `claude/my-leads-p1e-housekeeping` | `claude/my-leads-one-call-close-decisions` (or `main` once that PR is merged) | #791 | 1e: housekeeping functions + run ledger + operator script, attempt outcome widening, PRD v0.3 | ~900 |
| P1a-core | `claude/my-leads-p1a-core` | `claude/my-leads-p1e-housekeeping` | P1e | 1a: additive schema, feature-flag table, `schemaReady` helper, `fn_create_next_step`, `createNextStep`, one read definition, mode-aware lifecycle, relabel function (not run), retire preflight function | ~1,600 |
| P1a-writers | `claude/my-leads-p1a-writers` | `claude/my-leads-p1a-core` | P1a-core | 1a: every writer migrated one by one, offer follow-up chain | ~1,500 |
| P1b | `claude/my-leads-p1b-strip` | `claude/my-leads-p1a-writers` | P1a-writers (the ranking reads `follow_up_calendar_chain_id`) | 1b: ranking RPC, overrides table, strip UI, triage list | ~1,500 |
| P1c | `claude/my-leads-p1c-prompt` | `claude/my-leads-p1b-strip` | P1b | 1c: prompt rewrite (behind `post_call_prompt`), voicemail outcome wiring, note idempotency | ~1,500 |
| P1c-2 | `claude/my-leads-p1c2-seller-reminders` | `claude/my-leads-p1c-prompt` | P1c (and through it P1b, P1a-writers) | D9 seller-reminder job | ~900 |
| P1d | `claude/my-leads-p1d-link-capture` | `claude/my-leads-p1c2-seller-reminders` | P1c-2 | 1d: hangup link capture (touches only the projection and call_activities) | ~400 |
| P1a-retire | `claude/my-leads-p1a-retire` | `claude/my-leads-p3-send-card` | P3 send-card + relabel run (data) + ≥24 h bake | 1a: reject trigger (last), type narrowing, snooze removal, KPI snapshot test, delete the old attempt dialog (the preflight function already shipped in P1a-core) | ~500 |

PR titles (each body ends with `Depends on: #<parent PR number>` or `Depends on: none`):
- P1e: `feat(my-leads): housekeeping tools to reassign leads and close stale attempts (1e)`
- P1a-core: `feat(my-leads): next-step schema, fn_create_next_step and one read definition (1a)`
- P1a-writers: `feat(my-leads): route every task writer through fn_create_next_step (1a)`
- P1a-retire: `feat(my-leads): reject follow_up/callback inserts, remove snooze, KPI snapshot test (1a)`
- P1b: `feat(my-leads): ranked Call next strip with overrides and triage list (1b)`
- P1c: `feat(my-leads): post-call prompt with voicemail, note and quick next step (1c)`
- P1c-2: `feat(my-leads): seller morning-of reminder job, disabled until copy approved (D9)`
- P1d: `feat(dialpad): capture recording link and voicemail at hangup (1d)`

Ordering that is NOT mechanical and must be enforced by the operator runbook (the migration pipeline applies every merged migration to prod automatically via `db-migrate-test.yml` then `db-migrate-prod.yml`, so merging a schema PR is not a data change, but running a data function is):
1. Merge P1e. Run housekeeping preview, get Jarrad's approval, apply (reassign, then close attempts).
2. Merge P1a-core, then P1a-writers (and deploy). Only now run the relabel preview and apply, then the offer follow-up backfill. Re-run relabel once more right before step 3 (idempotent) to catch rows created in the gap.
3. Merge P1a-retire (reject trigger) last, after P1b, P1c, P1c-2, P1d and Phases 2-3, at `20261008100000`, once the ≥24 hour bake has passed and the preflight (already live since P1a-core) reports `openFutureLegacy = 0`.
Merge strictly in header order; the safety gate refuses a pending migration older than history's high-water mark.

**Migration timestamps.** Reserve `20261005100000`–`20261005199999` for Phase 1 (latest on this branch is `20261003160000_slack_workspace_preview_policy.sql`). Phase 0/2/3 drafters must not use this block. Naming: `timestamp_name.sql`, a `*.integration.test.ts` beside it, and a rollback file `supabase/rollbacks/<same timestamp>_<name>.sql` (existing convention, e.g. `supabase/rollbacks/20261002120000_norma_call_requests.sql`; rollbacks are never auto-applied).

**Inputs needed before start.** Credentials: none for builders (all work is local stack + vitest). `SUPABASE_SERVICE_ROLE_KEY` + project URL (via `op run`, never typed) are needed only by the operator who runs `scripts/my-leads-housekeeping.mjs`. Local Postgres on `127.0.0.1:54329` (`supabase/config.toml`) for `npm run test:integration:local`. Jarrad decisions, with the default I assumed if he does not answer:
- Approved: `not_logged` for the 137 stale pending attempts (new value, added in P1e). Nothing is deleted; deleting rows with no call activity is NOT built.
- Approved: all existing open appointments are `phone`; Jarrad flags in-person rows by hand later (`fn_set_next_step_mode`, P1a-core).
- [JARRAD] Time of day for the quick picks Tomorrow / 3 days / Next week. Default 10:00 America/Chicago. "Pick" lets him choose any time.
- [JARRAD] Exact seller-reminder text (D9). Default: none. The job ships disabled (`seller_reminder_settings.enabled=false`) and refuses to send while `SELLER_REMINDER_COPY` is null. No LLM may write that text (global rule: no LLM touches a rule/script/reply without verbatim human approval).
- [JARRAD] When an offer's outcome is recorded, its "Offer follow-up" appointment auto-closes. Default: `cancelled`/`cancelled` (leaves the "appointments kept" KPI untouched). The record says "completes"; `completed`/`held` would add a held appointment to the KPI each time. One constant in the trigger.
- Resolved by contract ("Reassigned leads and the first-call clock" and "Dial eligibility"): reassigned leads (Maria 2, Mel 13) get their new assignment episode created `eligible=false` so Jarrad's first-call clock and KPI samples do not restart (D10 "KPIs/timers unchanged"); 2.7 removes the dial-time `eligible` requirement so they can still be dialed.
- [JARRAD] Dialer wrap-up callbacks move from 30 min to 15 min (D1 phone = 15 min). Default: 15.
- [JARRAD] New appointments created from My Leads/the lead page do not set `outreach_dispo='booked_appointment'` or pause drips (today's `callback` tasks never did); only the dialer wrap-up keeps that effect (it relies on it, `src/lib/dialer/actions.ts:596`). Default as stated.
- Org id and Jarrad's user id are resolved by the operator script from `memberships` (owner + `acquisitions_enabled`), never hard-coded.

**Affected files (for the release lease).** `*` = new, everything else modified.
- SQL (all `supabase/migrations/…` plus `supabase/rollbacks/…` twins): `20261005100000_my_leads_housekeeping_tools.sql*`, `20261005110000_acquisition_attempt_outcome_voicemail_not_logged.sql*`, `20261005120000_next_step_schema.sql*`, `20261005120500_fn_create_next_step.sql*`, `20261005121000_next_step_read_model.sql*`, `20261005121500_next_step_relabel_functions.sql*`, `20261005130000_offer_follow_up_chain.sql*`, `20261005130100_set_lead_next_action_next_step.sql*`, `20261005130200_jitter_softphone_callback_next_step.sql*`, `20261005130300_jitter_writeback_callback_next_step.sql*`, `20261005130400_norma_complete_call_next_step.sql*`, `20261005130500_norma_needs_review_next_step.sql*`, `20261008100000_retire_follow_up_callback_types.sql*`, `20261005150000_my_leads_call_next.sql*`, `20261005160000_post_call_prompt_support.sql*`, `20261005170000_seller_appointment_reminders.sql*`, `20261005180000_dialpad_hangup_link_capture.sql*`, and one `*.integration.test.ts*` beside each.
- Config: `vitest.integration.config.ts` (add each new local-only test to `exclude`), `vitest.local-integration.config.ts` (add to `include`), `.github/workflows/e2e.yml` (one step per new `*.integration.test.ts`, copying the `:201-207` steps; CI runs local-integration tests only through those explicit steps), `vercel.json` (one cron entry).
- Scripts: `scripts/my-leads-housekeeping.mjs*`, `scripts/my-leads-housekeeping.test.mjs*`.
- Docs: `docs/my-leads/PRD.md` (v0.2 → v0.3), `docs/my-leads/DECISIONS-2026-10.md` (append "Phase 1 shipped" note only).
- Lib: `src/lib/next-steps/index.ts*`, `src/lib/next-steps/index.test.ts*`, `src/lib/next-steps/org.ts*`, `src/lib/my-leads/call-next.ts*`, `src/lib/my-leads/call-next.test.ts*`, `src/lib/my-leads/quick-picks.ts*`, `src/lib/my-leads/quick-picks.test.ts*`, `src/lib/my-leads/outcome-suggestion.ts*`, `src/lib/my-leads/seller-reminder.ts*`, `src/lib/my-leads/seller-reminder-copy.ts*`, `src/lib/tasks/index.ts`, `src/lib/tasks/index.test.ts`, `src/lib/tasks/index.integration.test.ts`, `src/lib/my-leads/queries.ts`, `src/lib/my-leads/types.ts`, `src/lib/my-leads/validation.ts`, `src/lib/dialer/actions.ts`, `src/lib/norma/stress/invariants.ts`, `src/lib/supabase/types.ts` (regenerated).
- App: `src/components/appointments/book-appointment-action.ts` (remove `bookAppointment`, keep org/assignee helpers re-exported), `src/components/appointments/book-appointment-popover.tsx`, `src/app/(dashboard)/leads/actions.ts`, `src/app/(dashboard)/leads/board-actions.ts`, `src/app/(dashboard)/leads/[id]/lead-task-widget.tsx`, `src/app/(dashboard)/leads/[id]/next-action-card.tsx`, `src/app/(dashboard)/dashboard/_components/task-actions-row.tsx`, `src/app/(dashboard)/tasks/actions.ts`, `src/app/(dashboard)/calendar/queries.ts`, `src/app/(dashboard)/calendar/_components/appointment-block.tsx`, `src/app/(dashboard)/my-leads/{page.tsx,client.tsx,actions.ts,adapter.ts}`, `src/app/(dashboard)/my-leads/strip-actions.ts*`, `src/app/(dashboard)/my-leads/_components/{call-next-strip.tsx*,call-next-row.tsx*,call-next-reason.ts*,triage-list.tsx*,post-call-prompt.tsx*,no-answer-follow-up.tsx*,use-attempt-workflow.ts,types.ts,queue-row.tsx,detail-panel.tsx,attempt-dialog.tsx (deleted)}`, plus their `*.test.tsx`, `src/app/api/cron/seller-appointment-reminders/{route.ts*,handlers.ts*,route.test.ts*}`, `src/app/(dashboard)/leads/[id]/acquisition-history.tsx`, `src/app/(dashboard)/leads/[id]/lead-call-summary.tsx`, `src/lib/integrations/slack/unfurl-blocks.ts` (voicemail label only).
- Tests/e2e: `e2e/my-leads.local.spec.ts`, `e2e/synthetic/my-leads-call-next.spec.ts*`, `e2e/synthetic/fixtures/my-leads-call-next-harness.tsx*`, `src/lib/my-leads/next-step-kpi-snapshot.integration.test.ts*`, `src/app/api/internal/jitter/call-activities/by-jitter-attempt/[attemptId]/route.integration.test.ts`, `supabase/migrations/20261002120000_norma_call_requests.integration.test.ts`, `supabase/migrations/20260814200000_appointment_reminders.integration.test.ts` (only if they insert retired types), and every other fixture that inserts a `follow_up`/`callback` task, found by the grep in 1a.11 (known: `src/lib/tasks/index.integration.test.ts`, `src/app/api/webhooks/slack/actions/route.integration.test.ts`, `src/lib/norma/stress/*.integration.test.ts`, `e2e/properties-filter-contract.spec.ts`, `e2e/properties-filter-db-oracle-smoke.spec.ts`, `tests/search-oracle/fixture-generator.ts`, `src/lib/prospects/*.integration.test.ts`).
- Also new: `src/components/appointments/next-step-actions.ts*` (server-action wrapper for `createNextStep`), `src/app/(dashboard)/leads/[id]/lead-task-widget.test.tsx` and `src/app/(dashboard)/leads/actions.test.ts` (modified).

### Verified facts the plan rests on (re-check if any migration after `20261003160000` lands first)
- Tasks CHECKs: type `('follow_up','callback','custom','appointment')` `20260814150000_appointments_schema.sql:66-70`; `tasks_end_at_check` (appointment ⇔ `end_at` set, `end_at > due_at`) `:82-87`; `tasks_outcome_check` (terminal appointments need an outcome in held/no_show/rescheduled/cancelled) `:94-103`; `tasks_calendar_chain_invariant_check` (appointment ⇔ `calendar_chain_id`) `:109-111`; non-appointment needs a property `:75-77`.
- Lifecycle guard `tasks_tenant_integrity_guard` (latest text `20260814170000_appointment_booking_rpcs.sql:86-272`): without the transaction-local setting `sandra.allow_appointment_time_move='on'` it blocks type changes across the appointment boundary and `calendar_chain_id` changes (`:157-169`), time moves (`:141-155`), assignee swaps (`:171-183`), and status/outcome/snooze/generation/idempotency-key changes (`:185-209`); inserts of appointments must be open and unclaimed (`:101-123`). Delete guard `20260814150000:442-467`.
- Other triggers on `public.tasks` the new write path must pass: `guard_training_tasks` (`20260908120000_training_lead_guards.sql:100`), `tasks_reject_dnc_locked_contact` (`20260815190000_true_dnc_property_lock.sql:350-358`, raises `DNC_LOCKED`), `trg_acquisition_appointment_attribution` AFTER INSERT (`20260912111000_acquisition_kpis.sql:25`), statement triggers `zz_tasks_filter_cache_*` (`20261002110000_properties_filter_cache_columns.sql:414-430`).
- `fn_book_appointment` (live wrapper `20260816093000_targeted_calendar_mutation_claim.sql:35-75`, base `20260814170000:501-827`) needs `auth.uid()`, a matching timezone label, a start inside [-1 h, +2 y], a 15 min–24 h window, always writes a `task_calendar_mutations` create row and, for property bookings, promotes prospect→new_lead and sets `outreach_dispo='booked_appointment'` (`:787-816`). SQL producers (Norma, Jitter) run as service role with no `auth.uid()`, so they cannot call it.
- `fn_reschedule_appointment` is a successor-row model: the old row is closed `completed/rescheduled` and a NEW task id is inserted in the same `calendar_chain_id` without `mode`/`location` (`20260814210000_appointment_lifecycle_rpcs.sql:451-483`; live wrapper over `fn_reschedule_appointment_base_20260816`, `20260816093000:77-110`). Anything that points at "the follow-up task" must therefore point at the chain, not the task id.
- `completeTask` refuses appointments (`src/lib/tasks/index.ts:143-149`); the UI already branches on `type==='appointment'` for the outcome row (`src/app/(dashboard)/leads/[id]/next-action-card.tsx:137`, `src/app/(dashboard)/my-leads/_components/existing-detail-actions.tsx:32,61`), so relabeled rows switch to the outcome flow with no UI change.
- One queue projection: `my_leads_queue_rows_for` (`20261003120000_my_leads_queue_row_lookup.sql:21-82`; next step lateral `:44-47` reads `type in ('appointment','callback')`, future-dated only), and `my_leads_queue_rows(org,member,at)` delegates to it (`:84-88`). Section order is warning rank, assignment time, property id, all descending (`20260912110000_acquisition_read_model.sql:133`).
- Detail read model `my_leads_detail_rows` `20260917110000_rep_sms_obligation_read_models.sql:105-136` (appointments union `:125-131`); KPIs latest `20260930031000_dialpad_recording_provider_window_finalizer.sql:885-927` (`type='appointment'` in the contact, overdue, due and held counts).
- `acquisition_appointment_attribution.source` is an unnamed inline CHECK `source='booking_insert'` (`20260912111000:8`); attribution is captured by an AFTER INSERT trigger only, `accountable_user_id = new.assignee_id` (`:12-24`), so a task reassigned or converted by UPDATE keeps (or lacks) its original attribution.
- `acquisition_attempts.outcome` is an unnamed inline CHECK `('no_answer','reached','wrong_number')` (`20260912090200_acquisition_attempt_offer_facts.sql:14`); the log RPC rejects anything else at `20261003130000_my_leads_conflicts_non_retryable.sql:416`, finalize at `:1142`. The public wrappers only create the no-answer SMS obligation when `outcome='no_answer'` (`20260917193000_recording_accountability.sql:170-195`, `20260917100000_rep_sms_obligations.sql:974-995`), so a new `voicemail` value is automatically obligation-free.
- Reassigning `properties.assigned_user_id` fires `observe_my_leads_property_assignment` (`20260912090100_acquisition_queue_episodes.sql:314`), which ends the open episode and inserts a new `live`, `eligible` episode (`:276-283`), restarting the first-call clock.
- `tasks.source_key` exists with unique `(org_id, source_key)` (`20261002120000_norma_call_requests.sql:27-31`); Norma upserts on it and can flip an existing `custom` review task to `callback` (`20261002120500_norma_lock_order.sql:367-392`).
- `lead_next_action_idempotency_key` is constrained to `type='follow_up'` (`20260815233000_leads_urgency_paging.sql:6-19`); relabeling such rows without changing that CHECK would fail.

---

## Sub-PR P1e — Housekeeping tools (decision 1e, D10)

### Work items (ordered; each independently committable)

#### 1e.1 Run ledger and before-image tables
- Files: create `supabase/migrations/20261005100000_my_leads_housekeeping_tools.sql`, `supabase/rollbacks/20261005100000_my_leads_housekeeping_tools.sql`, `supabase/migrations/20261005100000_my_leads_housekeeping_tools.integration.test.ts`.
- Change (DDL):
```sql
begin;
create table public.my_leads_housekeeping_runs (
  id uuid primary key default extensions.gen_random_uuid(),
  org_id uuid not null references public.organizations(id) on delete cascade,
  kind text not null check (kind in ('reassign','close_attempts','relabel','offer_follow_up_backfill','link_backfill','phone_backfill','ack_legacy_prompts')),
  status text not null default 'applied' check (status in ('applied','rolled_back')),
  params jsonb not null default '{}'::jsonb,
  fingerprint text,                                   -- the preview fingerprint the apply was validated against
  summary jsonb not null default '{}'::jsonb,         -- counts, skipped[], notRestored[]
  created_at timestamptz not null default now(),
  rolled_back_at timestamptz
);
create table public.my_leads_housekeeping_before_images (
  run_id uuid not null references public.my_leads_housekeeping_runs(id) on delete cascade,
  table_name text not null check (table_name in ('properties','acquisition_assignment_episodes','tasks','task_calendar_mutations','acquisition_attempts','acquisition_offers','acquisition_appointment_attribution','call_activities','contact_phone_numbers')),
  row_id uuid not null,
  org_id uuid not null,                               -- every image row is tenant-scoped
  op text not null default 'updated' check (op in ('created','updated')),
  before jsonb,                                       -- null for op='created'
  after jsonb,                                        -- the row as the run left it; rollback restores only if the row still equals this
  primary key (run_id, table_name, row_id)
);
alter table public.my_leads_housekeeping_runs enable row level security;
alter table public.my_leads_housekeeping_before_images enable row level security;
revoke all on public.my_leads_housekeeping_runs, public.my_leads_housekeeping_before_images
  from public, anon, authenticated, service_role;
-- service-only helper used by every function below (same gate as jitter/norma RPCs)
create or replace function public.my_leads_housekeeping_require_service() returns void
language plpgsql security definer set search_path = '' as $$
begin
  if coalesce(auth.role(), '') <> 'service_role' then
    raise exception 'service role required' using errcode = '42501';
  end if;
end $$;
revoke all on function public.my_leads_housekeeping_require_service() from public, anon, authenticated, service_role;
-- canonical fingerprint: callers pass jsonb_agg(<candidate row + relevant before-values> order by <row id>); jsonb text
-- output has a deterministic key order, so the same rows always give the same digest
create or replace function public.my_leads_housekeeping_fingerprint(p_rows jsonb) returns text
language sql immutable set search_path = '' as $$
  select encode(extensions.digest(convert_to(coalesce(p_rows, '[]'::jsonb)::text, 'UTF8'), 'sha256'), 'hex') $$;
revoke all on function public.my_leads_housekeeping_fingerprint(jsonb) from public, anon, authenticated, service_role;
commit;
```
  Shared apply contract for every operation function in this plan (`reassign`, `close_attempts`, `relabel`, `offer_follow_up_backfill`, `link_backfill`, `phone_backfill`, `ack_legacy_prompts`): signature `(p_org uuid, <op params>, p_apply boolean default false, p_expected_fingerprint text default null)`. Preview (`p_apply=false`) writes nothing and returns `{counts…, sample, fingerprint}`. Apply (`p_apply=true`) requires a non-null `p_expected_fingerprint` and runs: (1) `pg_advisory_xact_lock(hashtextextended('my-leads-housekeeping:'||p_org,0))`; (2) derive the candidate ids with the same query the preview uses; (3) `select … for update` the candidate rows (and the dependent rows the operation will touch) in id order, every statement filtered by `org_id = p_org`; (4) recompute the fingerprint from the locked rows through `my_leads_housekeeping_fingerprint`; (5) if it differs from `p_expected_fingerprint`, `raise exception 'HOUSEKEEPING_PREVIEW_STALE' using errcode = 'MLH01'` before any write; (6) insert the run row with `fingerprint`; (7) mutate only the fingerprinted ids, writing a before-image and an after-image per row with `op='created'|'updated'`. The fingerprint covers the exact ids plus the before-values the operation reads or overwrites (per operation, listed in its section), so replacing one candidate with another of the same count, or editing a candidate between preview and apply, changes the digest.
- Side effects checked: tables are revoked from every API role (same posture as `acquisition_attempts`, `20260912090200:68-70`); only `security definer` functions below write them; no RLS policies, so no API read either.
- Tests: `…integration.test.ts` loopback pattern copied from `20261003120000_my_leads_queue_row_lookup.integration.test.ts` (replay the SQL inside `begin … rollback`, `as('authenticated')` helper): authenticated/anon cannot select either table; helper raises `42501` unless `request.jwt.claim.role='service_role'`; `my_leads_housekeeping_fingerprint` is deterministic (same rows in the same order give the same digest, one changed value or one substituted row gives another).
- Rollback: rollback file drops both tables and the helper (no data outside these tables depends on them).

#### 1e.2 Reassign Maria's/Mel's queue leads and their open tasks to Jarrad (D10)
- Files: same migration file as 1e.1 (append) or `20261005100100_my_leads_housekeeping_reassign.sql*` if the first file exceeds ~600 lines (split is fine; both in this PR).
- Change: two service-only functions.
  - `public.fn_my_leads_housekeeping_reassign(p_org uuid, p_target uuid, p_owner uuid, p_apply boolean default false, p_keep_clock boolean default false, p_expected_fingerprint text default null) returns jsonb` (`security definer set search_path=''`; follows the shared apply contract in 1e.1).
  - `public.fn_my_leads_housekeeping_rollback(p_run uuid) returns jsonb` (handles all four kinds; the reassign branch is here, others added by later work items).
  Scope definition (the exact "queue leads"): for every `memberships m` in the org with `m.acquisitions_enabled and m.user_id <> p_target`, the property ids returned by `public.my_leads_queue_rows(p_org, m.user_id, statement_timestamp())` (assigned, open episode, not DNC-locked, status not closed/dead/dnc, not archived; `20261003120000:62-64`). Preconditions (raise with named codes): `p_target` is an active member with `acquisitions_enabled` (else the observer would create an ineligible episode, `20260912090100:207-229`); `p_owner` is an active org owner (used only to authorize the appointment reassign below).
  Body, `p_apply=false` (preview): no writes; return `{leads:[{from, count}], tasks:{nonAppointment:n, appointments:n}, appointmentsInFlight:n, sample:[ids], fingerprint}`. The fingerprint is over, per property ordered by id: `{property_id, assigned_user_id, updated_at, open_episode:{id, assignee_user_id, eligible, ended_at}, tasks:[{id, type, status, assignee_id, due_at, updated_at, calendar_generation}] ordered by id}` for every property in the scope and every open task on it, so a substituted lead, a changed assignee or an edited task all change the digest.
  Body, `p_apply=true`: the shared apply contract (advisory lock, lock the in-scope `properties`, their open `acquisition_assignment_episodes` and open `tasks` for update in id order with `org_id = p_org`, recompute the fingerprint, `HOUSEKEEPING_PREVIEW_STALE` on mismatch); then insert a run row (`kind='reassign'`, params = target/owner, fingerprint); then per property ordered by id, inside `begin … exception when others then record skip end`:
  1. before- and after-image `properties` (`assigned_user_id`, `updated_at`) and the open episode (`id, ended_at, eligible, assignee_user_id`).
  2. `update public.properties set assigned_user_id = p_target, updated_at = statement_timestamp() where id = r.id and org_id = p_org and assigned_user_id = r.old_assignee;` (the observer trigger ends the old episode and inserts the new one).
  3. new episode (skipped when `p_keep_clock`): `update public.acquisition_assignment_episodes set eligible = false where org_id=p_org and property_id=r.id and ended_at is null and assignee_user_id=p_target;` image it as `op='created'` with its id and after-values. This keeps Jarrad's first-call clock/KPI samples unchanged (`eligible` gates both: `20261003120000:35-36`, `20260930031000:918`).
  4. open non-appointment tasks on that property with `assignee_id <> p_target` (predicate includes `org_id = p_org`): before-image and after-image `tasks(assignee_id, updated_at)`, then plain `update public.tasks set assignee_id = p_target, updated_at = now() where id = … and org_id = p_org` (non-appointment rows have no assignee lock; the tenant trigger re-validates the new assignee membership).
  5. open appointment tasks: before-image the task row `{assignee_id, calendar_generation, updated_at, google_calendar_event_id, mode}` (the appointment task before-image the earlier draft omitted); impersonate the owner so the proven lifecycle code does the work: `perform set_config('request.jwt.claim.sub', p_owner::text, true); perform public.fn_reassign_appointment(t.id, p_target, md5(v_run::text||t.id::text)::uuid);` then `set_config('request.jwt.claim.sub','',true)`; after-image the task (`assignee_id`, new `calendar_generation`) and image the `task_calendar_mutations` row the function created (`op='created'`, id from `reassign_idempotency_key`) when one exists. `fn_reassign_appointment` is mode-aware (1a.4b), so a phone appointment never creates a Google event here. A calendar sync in flight raises inside `fn_reassign_appointment`; the per-row handler records `{task, reason}` in `summary.skipped` and continues.
  Summary written to the run row: counts, `skipped[]`. Idempotent: a rerun finds no queue leads for the other members.
  Summary written to the run row: counts, `skipped[]`. Idempotent: a rerun finds no queue leads for the other members.
- Side effects checked: observer trigger (above); `tasks_reject_dnc_locked_contact` raises `DNC_LOCKED` for a DNC contact: the per-row handler skips that task (queue leads are never property-locked, a contact lock is possible); attribution is insert-time only so the reassigned appointments keep Maria's/Mel's attribution (correct: those are historical facts); `zz_properties_filter_cache_*` and `zz_tasks_filter_cache_*` statement triggers fire per statement (fine at ~15 leads); `my_leads_workflow` events are not written (this is an operator action, recorded in the run row); open drips on those leads are untouched.
- Preview query (read-only, runs as postgres via the Supabase SQL tool; also exposed by `--preview`):
```sql
select m.user_id as from_member, count(*) as queue_leads
from public.memberships m
cross join lateral public.my_leads_queue_rows(:org, m.user_id, statement_timestamp()) r
where m.org_id=:org and m.acquisitions_enabled and m.user_id <> :jarrad
group by 1;
select t.type, t.status, count(*)
from public.tasks t
where t.org_id=:org and t.status in ('open','snoozed') and t.assignee_id <> :jarrad
  and t.related_property_id in (
    select r.property_id from public.memberships m
    cross join lateral public.my_leads_queue_rows(:org, m.user_id, statement_timestamp()) r
    where m.org_id=:org and m.acquisitions_enabled and m.user_id <> :jarrad)
group by 1,2;
```
- Rollback (data): `select public.fn_my_leads_housekeeping_rollback(:run)`, conflict-safe per property (all predicates carry `org_id = p_org` taken from the run row). A property is restored only if all of these hold, otherwise it is skipped whole and listed in `summary.notRestored` with its reason: `properties.assigned_user_id` still equals the after-image; the created episode is still open and unchanged (`eligible=false`, not ended) and **no permanent row references it**: no `acquisition_attempts`, `acquisition_offers`, note-attempt rows and no `dialpad_call_intents` row with `assignment_episode_id` = the created episode (intents are undeletable evidence, `20260929034021_dialpad_cti_foundation.sql:198`); no later episode exists. When restorable: set `assigned_user_id` back (observer creates episode E3), delete E3 and the created episode, clear `ended_at` on the original episode (restores it exactly; its `first_call_*` columns were never touched). Tasks: a non-appointment task is restored only if its `assignee_id` still equals the after-image (a user who reassigned it since keeps their change); an appointment is restored through the same owner-impersonated `fn_reassign_appointment` back to the old assignee only if it is still open, still assigned to the target and `calendar_generation` equals the after-image, otherwise `notRestored`. Set run `status='rolled_back'` (or `applied` with `summary.notRestored` non-empty when anything was skipped).
- Tests: `…housekeeping_tools.integration.test.ts` cases: (a) preview returns counts and writes nothing; (b) apply moves property, ends old episode, creates one eligible=false episode, moves a custom task and an open appointment (ledger `reassign` row exists), skips a DNC-contact task and reports it; (c) second apply is a no-op; (d) rollback restores owner, original episode open with `first_call_started_at` intact, task assignees; (e) rollback refused after an attempt was logged on the new episode; (f) anon/authenticated denied; (g) KPI before/after: `fn_get_acquisition_kpis` for Jarrad over a window containing the reassign shows `firstCallSamples/firstCallPending` unchanged; (h) fingerprint fence: after a preview, substitute one in-scope lead for another lead of the same previous assignee (count unchanged) and separately edit one task's assignee or due time, then apply with the old fingerprint: `HOUSEKEEPING_PREVIEW_STALE`, nothing written; a concurrent edit committed after the apply took its locks is blocked until the apply commits; (i) tenant predicates: a same-id-shaped row in a second org is never read, locked or written; (j) rollback preserves later user edits: a task re-assigned by a user after the run keeps that assignee, an appointment rescheduled or reassigned after the run is reported `notRestored`, and a property whose created episode is referenced by a `dialpad_call_intents` row (or an attempt) is skipped whole, never deleted; (k) the appointment task before-image and the created ledger row image are present and restore correctly in the untouched case.

#### 1e.3 Close stale pending attempts (default `not_logged`)
- Files: `supabase/migrations/20261005110000_acquisition_attempt_outcome_voicemail_not_logged.sql*` (+ rollback + integration test); function appended to the housekeeping migration.
- Change (constraint, found by definition because the inline CHECK is unnamed):
```sql
begin;
do $$
declare v_name text;
begin
  select c.conname into v_name from pg_constraint c
  where c.conrelid = 'public.acquisition_attempts'::regclass and c.contype = 'c'
    and pg_get_constraintdef(c.oid) like '%no_answer%' and pg_get_constraintdef(c.oid) like '%wrong_number%'
    and pg_get_constraintdef(c.oid) not like '%provider_attempt_key%';
  if v_name is null then raise exception 'acquisition_attempts outcome check not found'; end if;
  execute format('alter table public.acquisition_attempts drop constraint %I', v_name);
end $$;
alter table public.acquisition_attempts add constraint acquisition_attempts_outcome_check
  check (outcome is null or outcome in ('no_answer','reached','wrong_number','voicemail','not_logged'));
commit;
```
  `acquisition_attempts_pending_outcome_check` (`20260929120000_dialpad_cti_call_projection.sql:90-96`) is unaffected (it only requires outcome non-null for non-pending sources). `not_logged` is system-only: the log/finalize RPC lists get `voicemail` only (in P1c), never `not_logged`, so a user cannot pick it. KPI `reached` counts only `'reached'` (`20260930031000:891`) so both new values are "not reached"; `pendingOutcomes` counts `outcome is null` so closing rows lowers it for historical windows (expected, called out in the KPI test).
  Function: `public.fn_my_leads_housekeeping_close_attempts(p_org uuid, p_older_than interval default '7 days', p_apply boolean default false, p_expected_fingerprint text default null) returns jsonb` (shared apply contract, 1e.1). Candidates: `org_id = p_org and outcome is null and source='sandra' and occurred_at < statement_timestamp() - p_older_than`. Preview returns `{count, oldest, newest, withCallActivity, byActor:[…], pendingDialpadCti:n, fingerprint}` (the last count is for visibility only; those rows are not touched); the fingerprint is over `[{id, outcome, occurred_at, call_activity_id}]` ordered by id. Apply: lock the candidate attempts for update, verify the fingerprint, run row `kind='close_attempts'`, before-image `acquisition_attempts(outcome=null)` and after-image `(outcome='not_logged')`, `update … set outcome='not_logged' where id = … and org_id = p_org and outcome is null`.
- Side effects checked: `my_leads_reconcile_call` uses `coalesce(a.outcome, …)` (`20260912130000_acquisition_call_reconciliation.sql:9`), so a late call activity can no longer set the outcome on a closed row (intended); no `rep_sms_obligations` are created (the wrapper only acts on `no_answer` at write time); `my_leads_detail_rows` attempts fact shows the raw outcome string, so the UI label map needs `not_logged` and `voicemail` (see 1c.2).
- Preview query: `select count(*), min(occurred_at), max(occurred_at), count(*) filter (where call_activity_id is null) from public.acquisition_attempts where org_id=:org and outcome is null and source='sandra' and occurred_at < now() - interval '7 days';` (expect 137 per the record).
- Rollback (data): `fn_my_leads_housekeeping_rollback(:run)` sets `outcome=null` for a before-imaged id only while its `outcome` is still `not_logged` (valid because `acquisition_attempts_pending_outcome_check` allows null for source `sandra`); a row a user has since finalized or edited is skipped and listed in `summary.notRestored`. Rollback (schema): rollback file narrows the CHECK back, only if no row uses the new values.
- Tests: constraint accepts `voicemail`/`not_logged`, rejects `bogus`; preview writes nothing; apply closes only rows older than 7 days and only `sandra`; rollback restores nulls; the wrapper `fn_log_acquisition_attempt` still rejects `not_logged` (until P1c adds `voicemail`, then only `voicemail`).

#### 1e.4 Operator script and PRD v0.3
- Files: create `scripts/my-leads-housekeeping.mjs`, `scripts/my-leads-housekeeping.test.mjs`; modify `docs/my-leads/PRD.md`.
- Change: script usage `op run --env-file=… -- node scripts/my-leads-housekeeping.mjs <reassign|close-attempts|relabel|offer-backfill|link-backfill|phone-backfill|ack-legacy-prompts|rollback> --org <uuid> [--target <uuid>] [--owner <uuid>] [--apply --confirm <fingerprint>] [--run <uuid>]`. Defaults to preview and prints the human summary plus the **fingerprint returned by the preview RPC** (not a hash the script computes from the summary JSON). `--apply` requires `--confirm <fingerprint>`; the script passes it as `p_expected_fingerprint`, and the RPC itself validates it under locks (1e.1), so apply cannot run on a different set than the one Jarrad approved even if rows moved in between. Uses `@supabase/supabase-js` with the service-role key from env, calls only the RPCs in this explicit subcommand map (an allowlist in code), prints the run id:

  | Subcommand | RPC |
  |---|---|
  | `reassign` | `fn_my_leads_housekeeping_reassign` (1e.2) |
  | `close-attempts` | `fn_my_leads_housekeeping_close_attempts` (1e.3) |
  | `relabel` | `fn_my_leads_relabel_open_next_steps` (1a.5) |
  | `offer-backfill` | `fn_my_leads_backfill_offer_follow_ups` (1a.6) |
  | `link-backfill` | `fn_my_leads_housekeeping_link_backfill` (1d.1) |
  | `phone-backfill` | `fn_contact_phone_numbers_backfill` (2.3) |
  | `ack-legacy-prompts` | `fn_my_leads_ack_legacy_call_prompts` (2.6) |
  | `rollback` | `fn_my_leads_housekeeping_rollback` |

  Test (`node --test`, same style as `scripts/check-migration-safety.test.mjs`): refuses apply without `--confirm`; passes the confirm value through unchanged as `p_expected_fingerprint`; every RPC name the script can call is in the map above (a test fails if another name appears); never logs the key.
  PRD v0.3: set `version: "0.3"` (`docs/my-leads/PRD.md:4`), update the status line (`:13`), and add an "Overrides" table listing each conscious override of §3 (no automatic appointments/dialer, line 23), §5 (DialPad link optional + manual, line 80), "Log offer records an offer already made" (line 94), §13 Maria (line 29), each pointing at the decision id (D1, D4, D5, D8, D10). No behavioral text elsewhere is rewritten.
- Rollback: delete script; revert doc.

### Acceptance (P1e)
- `npm run typecheck && npm run lint && npm run test` (script tests are `node --test`: `node --test scripts/my-leads-housekeeping.test.mjs`).
- `npm run test:integration:local` with the three new `*.integration.test.ts` files added to `vitest.local-integration.config.ts` and excluded in `vitest.integration.config.ts`.
- `npm run verify:migration-safety-unit`.
- Production check (read-only): run `--preview` for `reassign` and `close-attempts` against prod via the service account; paste both JSON outputs into the PR. Expected: reassign leads 15 (2 + 13), attempts 137. Nothing is applied by the PR merge.

### Risks and open questions (P1e)
- Apply is a production data change to existing leads: needs Jarrad's approval of the pasted preview before `--apply` (AGENTS.md: existing prospects/leads are protected).
- Impersonating the owner with `set_config('request.jwt.claim.sub')` inside a definer function is the same trick the integration tests use; it is safe only because the function is service-role gated and the claim is reset in the same statement list.
- Reassigned leads get a new episode with `assigned_at = now`, so they sort to the top of their sections (`assignment_sort desc`, `20260912110000:133`) and read "Just now" in the assignment column (`adapter.ts` `assignmentAge`). Cosmetic and expected; mention it in the PR so it is not mistaken for a bug.
- `eligible=false` on the new episodes is the resolved contract (see Inputs); `--keep-clock` exists only if Jarrad later says he wants the clock to restart.

---

## Sub-PR P1a-core — Additive schema, shared write function, one read definition (decisions D1, 1a)

### Work items (ordered; each independently committable)

#### 1a.1 Additive columns, constraints, attribution source
- Files: create `supabase/migrations/20261005120000_next_step_schema.sql`, rollback twin, `…next_step_schema.integration.test.ts`, `src/lib/my-leads/flags.ts` + `flags.test.ts`, `src/lib/my-leads/schema-ready.ts` + `schema-ready.test.ts` (contract row "Schema readiness"; the `REQUIREMENTS` map starts with `next_step_write` = `fn_create_next_step(...)` plus `tasks.mode`, `tasks.next_step_kind` and each later sub-PR appends its own feature), `scripts/my-leads-flags.mjs`.
- Change:
```sql
begin;
alter table public.tasks
  add column mode text not null default 'phone',
  add column location text,
  add column next_step_kind text generated always as (
    case type when 'appointment' then 'appointment'
              when 'callback'    then 'appointment'
              when 'follow_up'   then 'appointment'
              else 'task' end) stored;
alter table public.tasks
  add constraint tasks_mode_check check (mode in ('phone','in_person')),
  add constraint tasks_in_person_appointment_check check (mode = 'phone' or type = 'appointment'),
  add constraint tasks_location_check check (location is null or (mode = 'in_person' and length(location) <= 500));
-- A relabeled follow-up keeps its lead-next-action idempotency key; the old CHECK
-- (20260815233000_leads_urgency_paging.sql:6-19) only allowed type='follow_up'.
alter table public.tasks drop constraint tasks_lead_next_action_follow_up_check;
alter table public.tasks add constraint tasks_lead_next_action_follow_up_check
  check (lead_next_action_idempotency_key is null or type in ('follow_up','appointment'));
-- Attribution CHECK is an unnamed inline `check(source='booking_insert')` (20260912111000:8).
do $$
declare v text;
begin
  select c.conname into v from pg_constraint c
  where c.conrelid = 'public.acquisition_appointment_attribution'::regclass and c.contype = 'c'
    and pg_get_constraintdef(c.oid) like '%booking_insert%';
  if v is null then raise exception 'attribution source check not found'; end if;
  execute format('alter table public.acquisition_appointment_attribution drop constraint %I', v);
end $$;
alter table public.acquisition_appointment_attribution
  add constraint acquisition_appointment_attribution_source_check
  check (source in ('booking_insert','relabel_2026_10','next_step_conversion','offer_backfill'));
-- Kill switches: every new surface and job checks its flag server-side; a missing table or row reads as OFF.
create table public.my_leads_feature_flags (
  org_id uuid primary key references public.organizations(id) on delete cascade,
  call_next_strip boolean not null default false,
  post_call_prompt boolean not null default false,
  click_to_dial boolean not null default false,
  native_matcher boolean not null default false,
  auto_prompt boolean not null default false,
  callback_alert boolean not null default false,
  call_screen boolean not null default false,
  contract_card boolean not null default false,
  seller_reminders boolean not null default false,
  artifact_fetch boolean not null default false,
  facts_job boolean not null default false,
  offer_projection boolean not null default false,
  comp_queue boolean not null default false,
  updated_at timestamptz not null default now()
);
alter table public.my_leads_feature_flags enable row level security;
revoke all on public.my_leads_feature_flags from public, anon, authenticated;
grant select, insert, update on public.my_leads_feature_flags to service_role;
commit;
```
  Flag reads go through `src/lib/my-leads/flags.ts` (`getMyLeadsFlag(orgId, flag): Promise<boolean>`, service-role client; a missing table (`42P01`), missing row, missing column (`42703`) or any error returns `false`, so a new surface or job that reaches `main` before its migration is applied is inert; changed existing actions additionally use `schemaReady`). Operators flip flags with `scripts/my-leads-flags.mjs <flag> <on|off> --org <uuid>` (service role, upserts the row, prints before and after); turning a flag off is the first layer of every revert (contract row "Revert"). Seeding rows is a data step run by that script, never by the migration.
  Every existing row becomes `mode='phone'` (decision N1: `end_at` is not evidence of in-person). `next_step_kind` is a STORED generated column (PG17 has no virtual columns); it rewrites `public.tasks` once under a brief ACCESS EXCLUSIVE lock. Builder: `select count(*) from public.tasks` on the test project first; if it is above ~200k stop and ask.
- Side effects checked: the generated column recomputes on every `type` update (the relabel and the Norma conversion need no extra write); the tenant guard does not gate `mode`/`location`, so a direct REST update could flip them (no money or consent impact; accepted, noted in Risks); `reset_tenant_tables()` (`20260814150000:682-772`) truncates `tasks` and is unaffected by new columns; `supabase/ci` and `search_properties` fixtures that `insert into public.tasks` keep working because both new columns are defaulted.
- Tests: columns exist with defaults; `in_person` on a `custom` task rejected; `location` on a phone row rejected; generated value for all four legacy types; a `follow_up` row with a lead-next-action key can be updated to `appointment` under the lifecycle flag; attribution accepts the three new sources (`relabel_2026_10`, `next_step_conversion`, `offer_backfill`) and still rejects `bogus`; `my_leads_feature_flags` is unreadable by `anon`/`authenticated`, defaults every flag (all thirteen) to false, and `getMyLeadsFlag` returns false for a missing row, a missing column and a missing table; `schemaReady('next_step_write')` is false against the pre-migration schema (missing columns and missing function), true after, caches `true`, re-checks `false` after 30 s, and treats a query error as false.
- Rollback: rollback file drops the three columns and the three constraints, restores `tasks_lead_next_action_follow_up_check` (`type = 'follow_up'`) and the attribution check (`source='booking_insert'`), and drops `my_leads_feature_flags`; run only after the relabel data rollback (1a.5) because rows with the new attribution sources would violate the old check.

#### 1a.2 `fn_create_next_step` — the one SQL write function
- Files: create `supabase/migrations/20261005120500_fn_create_next_step.sql`, rollback twin, `…fn_create_next_step.integration.test.ts`.
- Signature (all callers use named arguments; grants `authenticated` and `service_role`, revoked from `public, anon`):
```sql
create or replace function public.fn_create_next_step(
  p_org uuid, p_actor uuid, p_assignee uuid,
  p_kind text,                       -- 'appointment' | 'task'
  p_title text, p_due_at timestamptz,
  p_property uuid default null, p_contact uuid default null,
  p_mode text default 'phone',       -- appointments only
  p_end_at timestamptz default null, -- in_person only; phone is always due_at + 15 minutes
  p_location text default null,      -- in_person only
  p_description text default null,
  p_source_key text default null,    -- idempotent upsert key (tasks.source_key), Norma-style
  p_idempotency_key uuid default null,        -- appointments: tasks.booking_idempotency_key replay
  p_lead_next_action_key uuid default null,   -- set_lead_next_action replay (tasks.lead_next_action_idempotency_key)
  p_origin text default 'app',                -- 'app' | 'jitter' | 'norma' | 'offer' | 'board' | 'offer_backfill'
  p_enforce_window boolean default false,     -- user-originated: start within [-1h,+2y], same bounds as fn_book_appointment (20260814170000:689)
  p_apply_booking_effects boolean default false -- dialer wrap-up only: prospect->new_lead + dispo booked_appointment
) returns jsonb
language plpgsql security definer set search_path = ''
```
  Returns `{task_id, calendar_chain_id|null, ledger_id|null, duplicate, converted, kind, mode, related_property_id, contact_id, already_qualified}`.
- Body, in order (error codes are literal exception messages, SQLSTATE `22023` for input, `42501` for auth, `P0001` for state, as in `fn_book_appointment`):
  1. **Caller.** `if coalesce(auth.role(),'') <> 'service_role' and auth.uid() is distinct from p_actor then raise 'FORBIDDEN' (42501)`. The actor (and for service role too) must be an active member of `p_org` (`for share of m`, same predicate as `20260814170000:547-558`). Assignee membership is enforced by `tasks_tenant_integrity_guard` on insert (`20260814170000:247-268`); no duplicate check here.
  2. **Shape.** `p_kind in ('appointment','task')`, non-blank title, finite `p_due_at`. `v_type := case p_kind when 'appointment' then 'appointment' else 'custom' end`. A `task` needs `p_property` (CHECK `tasks_related_property_linkage_check`, `20260814150000:75-77`), must have `p_mode` null or `'phone'`, and may not carry `p_lead_next_action_key`, `p_idempotency_key`, `p_location`. Appointment: `v_mode := coalesce(p_mode,'phone')`; phone → `v_end := p_due_at + interval '15 minutes'` and any explicit `p_end_at` must equal it; in_person → `p_end_at` required, `15 min <= end-start <= 24 h`. `p_location` only for in_person, length ≤ 500. If `p_enforce_window`: `p_due_at between now()-interval '1 hour' and now()+interval '2 years'`.
  3. **Appointment replay.** If `p_idempotency_key` is not null: select by `(org_id, booking_idempotency_key)`; if found compare property/contact/assignee/due/end/title/description exactly as `20260814170000:583-614` and raise `fn_create_next_step: idempotency key reuse with different request` on mismatch, else return the stored row with `duplicate:true`.
  4. **Source-key upsert** (Norma contract, replaces `on conflict (org_id, source_key) do update`, `20261002120500:367-392`). If `p_source_key` is not null: `select * into v_old from public.tasks where org_id=p_org and source_key=p_source_key for update`. If found: raise when `v_old.related_property_id is distinct from p_property`, when `v_old.type='appointment' and p_kind='task'`, or when `v_old.google_calendar_event_id is not null and v_old.due_at is distinct from p_due_at`. Otherwise `perform set_config('sandra.allow_appointment_time_move','on',true)` and one `update public.tasks set type=v_type, mode=v_mode, title=v_title, due_at=p_due_at, end_at=v_end, location=p_location, description=p_description, calendar_chain_id = case when v_type='appointment' then coalesce(v_old.calendar_chain_id, v_chain) end, status='open', snoozed_until=null, completed_at=null, completed_by=null, outcome=null, reminder_claimed_at=null, calendar_generation=v_old.calendar_generation+1, updated_at=now() where id=v_old.id` (assignee, contact, created_by untouched, matching the old `do update set` list), then `set_config('sandra.allow_appointment_time_move','',true)` so the lifecycle bypass does not stay on for the rest of the caller's transaction. `v_converted := v_old.type <> v_type`. When converting a non-appointment to an appointment, insert the attribution row (`source='next_step_conversion'`, `accountable_user_id=v_old.assignee_id`) because the AFTER INSERT trigger will not fire (`on conflict (task_id) do nothing`). Skip to step 7.
  5. **Insert.** `insert into public.tasks (org_id, assignee_id, related_property_id, contact_id, type, mode, status, title, description, location, due_at, end_at, calendar_chain_id, created_by, booking_idempotency_key, lead_next_action_key…, source_key)`; appointments get `calendar_chain_id = v_chain`; the AFTER INSERT attribution trigger captures `assignee_id` for property-linked appointments (`20260912111000:12-24`); when `p_origin = 'offer_backfill'` the function then sets that attribution row's `source` to `'offer_backfill'` (one `update … where task_id = <new id>`, allowed by the widened CHECK) so backfilled follow-ups are identifiable and excluded from historical attribution reasoning (see 1a.6). Wrap in `exception when unique_violation` as `20260814170000:734-774` does, re-reading the winner by the same key for `idx_tasks_org_booking_idempotency_key`, `idx_tasks_org_lead_next_action_idempotency` and `idx_tasks_org_source_key`; any other constraint re-raises.
  6. **Calendar ledger, in-person only.** Phone appointments get no `task_calendar_mutations` row (Google sync is in-person only, D1); in_person inserts the create row exactly as `20260814170000:721-733` (`client_event_id := public.fn_uuid_to_base32hex(id)`) and returns `ledger_id`. Phone rows therefore never sit behind the "calendar sync in progress" guard that complete/cancel/reschedule enforce (`20260814210000:185-193`).
  7. **Lead event** (property-linked only): `insert into public.lead_events … on conflict (source_type, source_id) where source_id is not null do nothing`. Event type = `appointment_booked` (`source_type 'appointments.booked'`, `source_id = task id`) when `p_kind='appointment' and p_origin in ('app','board','offer')`, otherwise `task_created` (the `offer_backfill` origin also writes `task_created`, actor `system`) (`'tasks.created'`, the exact identity Norma already writes, so `src/lib/norma/stress/invariants.ts:279` keeps counting one event per task). Actor type `user` with `actor_id=p_actor` for `app/board/offer`, `system` (actor null) for `jitter/norma`. Payload `{task_id, task_type, due_at, assignee_id, mode, origin}`.
  8. **Booking effects** (only when `p_apply_booking_effects and p_property is not null`): the two property updates verbatim from `20260814170000:796-815` (prospect→new_lead with `qualified_by=p_actor::text`, then `outreach_dispo='booked_appointment', follow_up_at=null`); set `already_qualified` in the result from the first update's row count.
- Side effects checked: tenant guard INSERT branch requires open/unclaimed appointment (we always insert open); `guard_training_tasks` and `tasks_reject_dnc_locked_contact` raise for training/DNC targets and propagate to callers (Norma already catches `DNC_LOCKED`, `20261002120500:380-387`); `lead_events` insert needs the definer (browser role has select only, `20260825170000_lead_events_ledger.sql:55-60`); bell/Slack notifications are NOT written here (SQL producers skip them today; the TS wrapper dispatches them); `properties.follow_up_at` is left alone unless booking effects are on.
- Tests (`…fn_create_next_step.integration.test.ts`, loopback pattern, `as('authenticated', sub, …)` and `as('service_role', …)`): (1) phone appointment: `end_at=due+15m`, chain set, no ledger row, attribution row for assignee, `appointment_booked` event; (2) in_person: needs `p_end_at`, ledger row with `client_event_id`; (3) task: `type='custom'`, `next_step_kind='task'`, requires property; (4) authenticated with `p_actor <> auth.uid()` → `FORBIDDEN`; non-member actor → `FORBIDDEN`; anon denied; (5) `p_enforce_window` rejects +3 years and −2 h, allows −30 min; service-role call with `p_enforce_window=false` accepts a past due date (Jitter callback case); (6) idempotency key replay returns `duplicate:true` with the same ids, a replay with a different due → mismatch error, two concurrent calls with one key produce one row; (7) `p_lead_next_action_key` replay; (8) source-key: first call inserts, second call updates in place and reopens a completed row, custom→appointment conversion sets chain/end_at and inserts attribution `next_step_conversion`, appointment→task raises, property mismatch raises; (9) DNC-locked property raises `DNC_LOCKED`; training lead raises `TRAINING_PROTECTED`; (10) `p_apply_booking_effects` promotes a prospect and sets the dispo, default does neither; (11) the AFTER INSERT attribution trigger does not fire for `task` kind; (12) a `jitter`-origin call writes a `task_created` event with `actor_type='system'`.
- Rollback: rollback file drops the function. No data written by merge.

#### 1a.3 TypeScript wrapper `createNextStep`
- Files: create `src/lib/next-steps/index.ts` (server-only), `src/lib/next-steps/org.ts`, `src/lib/next-steps/index.test.ts`; modify `src/components/appointments/book-appointment-action.ts`.
- Change: move `resolveBookingOrgId` (`book-appointment-action.ts:137-186`; its doc block starts at `:123`) into `org.ts` (`listBookingAssignees`, `:600`, imports it from there) and import it back, so `bookAppointment` and `createNextStep` share one org resolution (no behavior change). Exported API:
```ts
export type NextStepKind = "appointment" | "task";
export type NextStepMode = "phone" | "in_person";
export const PHONE_APPOINTMENT_MINUTES = 15;
export type CreateNextStepInput = {
  kind: NextStepKind;
  assigneeId: string;
  title: string;
  dueAt: string;                   // ISO instant, already converted server-side (never trust a client Date)
  propertyId?: string; contactId?: string;
  mode?: NextStepMode;             // appointment only, default "phone"
  durationMinutes?: number;        // in_person only (phone is fixed at 15)
  location?: string; note?: string;
  idempotencyKey?: string;         // UUID, one per user action
  origin?: "app" | "board" | "offer";
  applyBookingEffects?: boolean;   // dialer wrap-up only
};
export type CreateNextStepResult = {
  taskId: string; calendarChainId: string | null; ledgerId: string | null;
  duplicate: boolean; kind: NextStepKind; mode: NextStepMode;
  relatedPropertyId: string | null; contactId: string | null;
};
export async function createNextStep(input: CreateNextStepInput): Promise<Result<CreateNextStepResult>>;
```
  Body mirrors `bookAppointment` (`book-appointment-action.ts:276-575`): validate input (title, duration only for in_person, `dueAt` finite), `assertNotTrainingTarget`, `assertPropertyDncUnlocked`/`assertContactDncUnlocked`, `resolveBookingOrgId`, then `supabase.rpc("fn_create_next_step", {...named args})` (typed through a local `NextStepRpcClient` like `AppointmentRpcClient` at `:79-116` until `types.ts` is regenerated). After commit, in this order and each failure-isolated with `reportError`: (a) if `ledger_id`: `kickCalendarMutationSync(createAdminClient(), ledger_id)`; (b) if `assigneeId !== user.id && !duplicate`: `after()` dispatch `dispatchTaskAssigned` + `dispatchTaskAssignedSlack` with `taskType` `appointment|custom` (admin-loaded prefs, as `:458-486`); no `dispatchTaskCalendarEvent` (the ledger is the only calendar creator, `:445-456`); (c) when `applyBookingEffects`: `recordLeadEvents([QUALIFIED])` if `!already_qualified` and `pausePropertyEnrollments(...)` (`:490-515`); (d) `revalidatePath` for `/leads/<id>`, `/my-leads`, `/messages`, `/dashboard`, `/calendar`. SQL already wrote the lead event, so TS must not (otherwise duplicates).
  `bookAppointment` stays exported for one release as a thin adapter (`createNextStep({kind:"appointment", mode:"in_person", durationMinutes, …})`) so a stale deploy/tab keeps working; it is deleted in P1a-retire. **Readiness (`next_step_write`):** the adapter and the booking action call `fn_create_next_step` only when `schemaReady('next_step_write')`; until then they run the current `fn_book_appointment` code path byte-for-byte (the body of `bookAppointment` at `book-appointment-action.ts:276-575` is kept as `bookAppointmentLegacy` for exactly this fallback and deleted with the adapter in P1a-retire), so a deploy that lands before its migration cannot fail an existing booking.
- Side effects checked: `after()` usage requires a request scope (same constraint `bookAppointment` already has); `loadIntegrationPrefs` admin read as before.
- Tests (`index.test.ts`, mocked clients like `src/components/appointments/book-appointment-action.test.ts`): with `schemaReady('next_step_write')` false the booking action runs the legacy path and never calls `fn_create_next_step` (asserted against a schema that lacks the function and the `tasks.mode` column); phone path sends `p_mode:'phone'` and no end/duration; in_person requires duration; training and DNC blocks short-circuit before the RPC; duplicate skips notifications; ledger id triggers exactly one kick; RPC error maps to `{code}` (`FORBIDDEN`, `DNC_LOCKED`, `INVALID_INPUT`); no `dispatchTaskCalendarEvent` is called; booking effects off by default.
- Rollback: revert the files; `bookAppointment` was never removed in this PR.

#### 1a.4 One read definition for the next step
- Files: create `supabase/migrations/20261005121000_next_step_read_model.sql`, rollback twin, `…next_step_read_model.integration.test.ts`; modify `src/lib/my-leads/queries.ts`, `src/app/(dashboard)/my-leads/adapter.ts`, `src/app/(dashboard)/my-leads/_components/types.ts`, `src/app/(dashboard)/my-leads/_components/queue-row.tsx`, `src/app/(dashboard)/calendar/queries.ts`, `src/app/(dashboard)/calendar/_components/appointment-block.tsx`.
- Change (SQL, three `create or replace` bodies copied verbatim from the cited migration with only the listed diffs):
  1. `my_leads_queue_rows_for(p_org,p_member,p_at,p_property_id)` (`20261003120000:21-82`; keep `plan_cache_mode`, `stable`, `security definer`): in the `step` lateral replace `t.type in ('appointment','callback')` with `t.next_step_kind = 'appointment'`, also select `t.mode as mode`; in `facts` expose `step.mode as next_step_mode`; in the payload set `'nextStepType', case when w.next_step_at is null then null else 'appointment' end` and add `'nextStepMode', w.next_step_mode`. `my_leads_queue_rows(org,member,at)` (`:84-88`) is unchanged and keeps its grants. Everything downstream (page, KPIs, badge, drip scope, rep SMS) reads through it, so they all change together.
  2. `my_leads_detail_rows(p_org,p_property,p_group)` (`20260917110000:105-136`): appointments union reads `t.next_step_kind = 'appointment'` (was `t.type in ('appointment','callback')`, `:131`) and adds `'mode', t.mode, 'location', t.location` to the fact. `callbackActionAllowed` stays for legacy `callback` rows that are not relabeled (past-due ones stay legacy by design).
  3. `fn_reschedule_appointment_base_20260816(uuid,timestamptz,timestamptz,text,uuid)` (the renamed original, body `20260814210000:326-492`): the successor INSERT (`:460-469`) gains `mode, location` → `v_task.mode, v_task.location` so rescheduling an in-person appointment does not silently become phone. Grants unchanged (revoked from all; only the public wrapper calls it, `20260816093000:77-110`).
  Unchanged on purpose: `fn_get_acquisition_kpis` and friends already read `type='appointment'` (`20260930031000:894-919`), `fn_calendar_month_appointments` reads `type='appointment'` (`20260816130000:153-156`), `leads_board`/`get_leads_board_page` read the earliest open task of any type (`20260815233000:130-141`), the dashboard and lead page select open tasks without a type filter (`src/app/(dashboard)/dashboard/queries.ts:184-190`, `leads/[id]/page.tsx:291`). They pick up relabeled rows with no change.
- Change (TS): `QueueRow.nextStepType: 'appointment' | null` and new `nextStepMode: 'phone' | 'in_person' | null` (`queries.ts:15`); `DetailFact` gains `mode`, `location` (`queries.ts:114`); `MyLeadQueueRow.nextStep` becomes `{ kind: "appointment"; mode: "phone" | "in_person"; label: string } | null` (`_components/types.ts:66`); `adapter.ts:41` builds it from the two payload fields; every next-step render also carries `data-next-step-id`, `data-next-step-due-at` (ISO) and `data-next-step-kind` (seam S4) on the My Leads row/detail, the lead page, the calendar agenda and month cell, and the dashboard `tasks-panel` row (`src/app/(dashboard)/dashboard/_components/tasks-panel.tsx:268`, modified for this); `queue-row.tsx:316-323,408-416` render "Phone appointment · {label}" / "In person · {label}" instead of the callback/appointment branch; `adapter.ts:74` keeps `callbackAction` only for rows still typed `callback`. Calendar: `calendar/queries.ts` (RPC call at `:236`) makes one extra `from("tasks").select("id, mode").in("id", ids)` for the returned appointments (no RPC signature change; **Readiness `next_step_write`**: skipped, with no tag shown, until `tasks.mode` exists) and `appointment-block.tsx` shows a small "Phone" / "In person" tag; phone blocks already render as 15-minute blocks because their `end_at` is `due+15m`.
- Side effects checked: the detail RPC and queue RPC keep names, argument lists and grants (`create or replace` preserves them); KPI tile "Contact without follow-up" (`20260930031000:894`) now counts relabeled callbacks as follow-ups, which is the intended D1 effect; "appointments overdue" (`:895`) starts including phone appointments.
- Tests (`…next_step_read_model.integration.test.ts`): a lead with a future `callback`, a future `appointment` and a `custom` task: only the first two feed `nextStepAt` (earliest wins), `nextStepType` is `'appointment'`, `nextStepMode` correct; a past-due legacy callback is not a next step; detail appointments group includes legacy callbacks and relabeled rows with `mode`; reschedule of an in_person appointment keeps `mode` and `location` on the successor; queue-page ordering test from `20261003120000…integration.test.ts` still passes unchanged (`fn_get_acquisition_queue_page` untouched). Vitest: `adapter.test.ts`, `queue.test.tsx`, `detail-panel.test.tsx` updated for the new `nextStep` shape and labels.
- Rollback: rollback file restores the three prior bodies verbatim from the cited migrations.

#### 1a.4b Mode-aware lifecycle: reschedule, reassign, cancel and mode change (B6)
- Files: append to `20261005121000_next_step_read_model.sql` (it already replaces `fn_reschedule_appointment_base_20260816`) or create `20261005121200_next_step_mode_aware_lifecycle.sql` + rollback twin + `…mode_aware_lifecycle.integration.test.ts`.
- Rule. A **phone** appointment never creates or moves a Google event and never gets a ledger row that the sweep would claim for a create; an **in-person** appointment keeps today's behaviour exactly. An event that already exists on a row (a relabeled legacy row, or a row switched to phone) is removed through the existing reconciliation path: a `cancel` ledger row carrying the old `event_id`, claimed by the same sweep (`fn_claim_calendar_mutations`, `operation in ('create','reschedule','reassign','cancel')`).
- Change (each is `create or replace` of the live body with only the stated diff, same technique as 1a.8):
  1. `fn_reschedule_appointment_base_20260816` (base `20260814210000:326-492`, ledger insert `:475-483`): when `v_task.mode = 'in_person'` insert the `reschedule` ledger row exactly as today. When `mode = 'phone'`: if `v_task.google_calendar_event_id is not null` insert one `cancel` ledger row for the chain with that `event_id` (the successor never gets an event); otherwise insert the same row directly in phase `'finalized'` (an audit and replay record that the sweep never claims, because claims select only `pending`/`provider_done`, `:780,:967`; the builder reads the finalized-phase CHECK at `20260814150000_appointments_schema.sql:556` and supplies any column it requires). The RPC's return keeps `ledger_id` (null-safe in TS: the kick runs only for a pending row).
  2. `fn_reassign_appointment` (`20260814210000:576-700`, ledger insert `:687-697`): `mode = 'in_person'` unchanged (the `reassign` row, delete under the old assignee and create under the new). `mode = 'phone'`: if an event exists insert a `cancel` ledger row for it (`new_assignee_id` kept for the audit, no create half), else insert the `reassign` row born `'finalized'`; the keyed replay lookup (`reassign_idempotency_key`, `:612-640`) therefore still finds its row, so replay and the A→B→A protection are preserved. No Google event is ever created for a phone appointment.
  3. `fn_cancel_appointment` (`:219-300`, ledger insert `:289-295`): in-person unchanged; phone with an existing event → `cancel` pending row; phone without an event → the `cancel` row born `'finalized'` (or none; the builder keeps one row for replay symmetry).
  4. `fn_set_next_step_mode(p_task, p_mode, p_location)` (1a.5): `phone → in_person` inserts the `create` row (as `fn_create_next_step` step 6); `in_person → phone` when an event exists inserts a `cancel` pending row for it, when none exists inserts nothing; both bump `calendar_generation` under the lifecycle flag.
- Side effects checked: the guards that refuse complete/cancel/reschedule while a sync is in progress (`:185-193`, `:264`, `:407`, `:652`) read only `pending`/`provider_done`/`needs_repair`, so a `finalized` audit row never blocks; the KPI and attribution paths do not read the ledger; Google credentials are never touched for phone rows.
- Tests (local integration; Google client mocked at the worker boundary, with **valid Google credentials seeded** so a stray create would actually be attempted): reassigning a phone appointment that never had an event creates no pending ledger row and the worker makes zero `events.insert` calls; reassigning an in-person appointment still produces the delete-plus-create pair; rescheduling a phone appointment makes no create or move call; a phone row that carries an event is cancelled through the sweep (one `events.delete`); `phone → in_person` creates exactly one event, `in_person → phone` deletes the existing event and creates none; keyed reassign replay on a phone row returns `duplicate: true`; cancel of a phone row with and without an event; a relabeled legacy row with a `google_calendar_event_id` is cleaned up on its first reschedule.
- Rollback: the rollback twin restores the three prior bodies verbatim.

#### 1a.5 Relabel, mode-setting, retire preflight and rollback functions (data steps and a read-only check, NOT run by the merge)
- Files: create `supabase/migrations/20261005121500_next_step_relabel_functions.sql`, rollback twin, `…next_step_relabel_functions.integration.test.ts`.
- Change:
  - `public.fn_my_leads_relabel_open_next_steps(p_org uuid, p_expected_assignee uuid, p_apply boolean default false, p_expected_fingerprint text default null) returns jsonb` (service-only, `security definer set search_path=''`; shared apply contract, 1e.1; the fingerprint is over `[{id, type, status, due_at, snoozed_until, assignee_id, updated_at}]` ordered by id; every task and attribution statement filters `org_id = p_org`; each task before-image is paired with an after-image `{type:'appointment', mode:'phone', due_at, end_at, calendar_chain_id, status:'open'}` and the attribution row it inserts is imaged `op='created'`). Candidates: `type in ('callback','follow_up')`, `status in ('open','snoozed')`, effective due `greatest(due_at, case when status='snoozed' then snoozed_until end) > statement_timestamp()` (open and future only; completed/cancelled/past-due rows are history and stay untouched), property not deleted and not DNC-locked. Precondition: raise `ASSIGNEE_MISMATCH: n rows` if any candidate's `assignee_id <> p_expected_assignee` (this is the mechanical form of "1e before 1a": relabel backfills attribution to the assignee at relabel time). Preview (`p_apply=false`) returns `{candidates, snoozedToOpen, skippedLocked, byType, byAssignee}` and writes nothing. Apply: run row `kind='relabel'`; per candidate, in `begin … exception when others then skip` (records `{task, sqlstate}`): before-image `tasks` `{type,status,due_at,snoozed_until,end_at,calendar_chain_id,mode,related_property_id}`; `perform set_config('sandra.allow_appointment_time_move','on',true)`; one `update public.tasks set type='appointment', mode='phone', due_at=<effective due>, end_at=<effective due>+interval '15 minutes', status='open', snoozed_until=null, calendar_chain_id=gen_random_uuid(), updated_at=now() where id=…`; then `insert into public.acquisition_appointment_attribution (task_id, org_id, accountable_user_id, source) values (…, 'relabel_2026_10') on conflict (task_id) do nothing` (only if `acquisition_org_settings` exists, mirroring `20260912111000:15-17`; before-image the attribution row id). No ledger row (phone). `google_calendar_event_id`/slack columns on legacy rows are left in place.
  - `public.fn_set_next_step_mode(p_task uuid, p_mode text, p_location text default null) returns void` (service-only): the "Jarrad flags in-person by hand" operator step (open appointments only; sets `mode`/`location`; when `p_mode='in_person'` and no ledger row exists it inserts the create row exactly as `fn_create_next_step` step 6 does, so hand-flagged in-person rows get their Google event; the reverse transition and the other lifecycle calls are mode-aware per 1a.4b).
  - `public.fn_my_leads_housekeeping_rollback(p_run uuid)` replaced (copy of the 1e.2 function) with an added `relabel` branch: restores a row only if it still equals its after-image (still `open`, same `due_at`/`end_at`/`calendar_chain_id`, no ledger row and no successor in the chain); anything else is reported in `summary.notRestored`. Restoration is the before-image under the lifecycle flag plus `sandra.allow_retired_task_type='on'` (the P1a-retire trigger honors it), and the created attribution row is deleted only if it is still `source='relabel_2026_10'` and unchanged.
  - `public.fn_my_leads_next_step_retire_preflight(p_org uuid) returns jsonb` (service-only, read-only; **moved here from the P1a-retire migration so the gate exists before the merge it gates**): the body that 1a.11 previously created, byte for byte (`openFutureLegacy`, `openPastDueLegacy`, `snoozedLegacy`, `byAssignee`, grants to `service_role` only). The retire migration no longer creates it.
- Side effects checked: tenant guard UPDATE branch passes only because of the flag (`20260814170000:157-169`); `tasks_end_at_check` and `tasks_calendar_chain_invariant_check` are satisfied by the single update; `tasks_reject_dnc_locked_contact` raising `DNC_LOCKED` on a DNC task contact is caught per row; KPI effect is limited to future-dated rows (their `due_at` is after now, so every historical window is unchanged, asserted by the snapshot test in P1a-retire); the rep reminder sweep (`fn_claim_appointment_reminders`, `type='appointment'`, `20260814200000_appointment_reminders.sql:152-153`) will start reminding Jarrad about each relabeled call 30 minutes before it is due (existing sweep, unchanged per D9).
- Preview query: `select t.type, count(*) total, count(*) filter (where t.status='snoozed') snoozed, count(*) filter (where p.is_dnc_locked or p.deleted_at is not null) skipped, count(distinct t.assignee_id) assignees from public.tasks t join public.properties p on p.id=t.related_property_id and p.org_id=t.org_id where t.org_id=:org and t.type in ('callback','follow_up') and t.status in ('open','snoozed') and greatest(t.due_at, case when t.status='snoozed' then t.snoozed_until end) > now() group by 1;`
- Rollback (data): `select public.fn_my_leads_housekeeping_rollback(:run)`. Rollback (schema): rollback file drops the four functions.
- Tests: preview writes nothing; apply with a stale fingerprint (one candidate substituted, or one edited between preview and apply) raises `HOUSEKEEPING_PREVIEW_STALE`; apply converts a callback and a follow_up (keeping a lead-next-action key), converts a `snoozed` row to open at its snoozed time, leaves completed and past-due rows alone, skips a DNC-contact row and reports it, raises `ASSIGNEE_MISMATCH` when a candidate belongs to another member, second apply is a no-op, rollback restores type/chain/end_at and removes the attribution row, rollback skips a row that was since completed or rescheduled; the retire preflight returns the counts of a seeded legacy set, is service-role only, and writes nothing; `fn_get_acquisition_kpis` for a historical window before/after apply is identical (full snapshot test is in P1a-retire 1a.12).

### Acceptance (P1a-core)
- `npm run typecheck && npm run lint && npm run test && npm run test:rtl`; `npm run test:integration:local` (new files added to the local config, excluded from the hosted one); `npm run verify:migration-safety-unit`; the readiness tests of the contract row "Schema readiness" (new TS against the preceding schema). Regenerate `src/lib/supabase/types.ts` with the project's existing generator against the local stack and commit it.
- Production check (read-only): run the relabel preview and the preview query above; paste output. Nothing in this PR changes production rows; the new columns default and existing readers are behavior-compatible. After merge, confirm on prod: `select count(*) from public.tasks where mode <> 'phone'` is 0 and `select next_step_kind, count(*) from public.tasks group by 1` matches `type` counts.
- Vercel preview: open `/my-leads` as an acquisitions user; rows with an existing future callback show "Phone appointment"; lead page and dashboard unchanged.

### Risks and open questions (P1a-core)
- The stored generated column rewrites `tasks`; confirm size first (above).
- `fn_create_next_step` keeps `phone` appointments out of the Google ledger entirely. A stale-build call to the old `fn_book_appointment` still creates a ledger row and a Google event (mode defaults to `phone` but the worker does not look at it); intentional, so no in-person booking is silently lost during rollout.
- KPI meaning shifts: `appointmentsDue/Held` (`20260930031000:919`) will now include every phone next step and every Norma/Jitter callback created after this lands (attribution is captured at insert). [JARRAD] confirm the "appointments kept" tile should now mean "next steps kept".
- Slack "Mark done" buttons on old task-assigned messages call `completeTask`, which refuses appointments (`src/lib/tasks/index.ts:143-149`); after relabel those clicks fail (they already fail for appointments today, `src/lib/integrations/slack/dispatch.ts:266-298`). Low impact; not changed here.

---

## Sub-PR P1a-writers — Migrate every writer, one at a time (decision 1a "One write path")

Writer inventory (verified by `grep` over `src/` and `supabase/migrations/`; there are no other inserts into `public.tasks` besides the superseded older Norma/Jitter definitions):

| # | Writer | Today | File:line | Becomes |
|---|---|---|---|---|
| W1 | Lead page task widget | `createTask` type `follow_up`/`callback` | `src/app/(dashboard)/leads/actions.ts:1866-2060` (insert call `:1992`), UI `src/app/(dashboard)/leads/[id]/lead-task-widget.tsx` | `createNextStep` appointment/task |
| W2 | Board quick next action | RPC `set_lead_next_action` | `src/app/(dashboard)/leads/board-actions.ts:125-160` (rpc `:138`) → SQL `20260815233000_leads_urgency_paging.sql:342-466` (insert `:449`) | RPC body calls `fn_create_next_step` |
| W3 | Dialer wrap-up callback | `bookAppointment` (30 min) | `src/lib/dialer/actions.ts:596-640` (call `:602`) | `createNextStep` phone 15 min, booking effects on |
| W4 | Booking popover (lead page, My Leads "schedule-next-step", calendar block) | `bookAppointment` | `src/components/appointments/book-appointment-popover.tsx:297`, `src/app/(dashboard)/my-leads/client.tsx:1262-1281` | `createNextStep` via server action |
| W5 | Jitter writeback (softphone path) | inserts `callback` | `20260825010000_jitter_softphone_artifact_writeback_match.sql:388-423` (select `:399-406`, insert `:409-420`) | `fn_create_next_step` |
| W6 | Jitter writeback (main path, live as `jitter_writeback_call_activity_before_metrics` since `20260913121000_jitter_call_metrics_evidence.sql:6-7`) | inserts `callback` | `20260825010000…:707-741` (select `:718-725`, insert `:727-739`) | `fn_create_next_step` |
| W7 | Norma `fn_norma_complete_call` | upsert `callback`/`custom` by `source_key` | `20261002120500_norma_lock_order.sql:180-422` (insert `:375`, event `:394-402`) | `fn_create_next_step` with `p_source_key` |
| W8 | Norma `fn_norma_mark_needs_review` | insert `custom` | `20261002120500…:558-612` (insert `:587`) | `fn_create_next_step` kind `task` |
| W9 | Reschedule successor | inserts appointment | covered in 1a.4 (carries `mode`/`location`) | done |
| W10 | Offer dialog "Offer follow-up" (new writer) | none (`follow_up_at` column only) | `fn_log_acquisition_offer` `20261003130000…:651-822` | creates the appointment in the offer transaction |
| W11 | My Leads post-call quick picks (new writer) | none | P1c | `createNextStep` |

#### 1a.6 Offer follow-up chain, propagation and guards (W10)
- Files: create `supabase/migrations/20261005130000_offer_follow_up_chain.sql`, rollback twin, `…offer_follow_up_chain.integration.test.ts`.
- Change:
  - `alter table public.acquisition_offers add column follow_up_calendar_chain_id uuid;` plus `create index acquisition_offers_follow_up_chain_idx on public.acquisition_offers (org_id, follow_up_calendar_chain_id) where follow_up_calendar_chain_id is not null;`. No FK: the chain is shared by reschedule successors, so it is not a unique key on `tasks` (that is why the pointer is the chain, not a task id: `fn_reschedule_appointment` closes the old row and inserts a new id, `20260814210000:451-483`).
  - `create or replace function public.fn_log_acquisition_offer(p_org_id uuid, p_property_id uuid, p_expected_episode_id uuid, p_expected_queue_version bigint, p_expected_shared_status text, p_idempotency_key uuid, p_amount_cents bigint, p_sent_via text, p_sent_at timestamptz, p_follow_up_at timestamptz, p_motivation_kind text default null, p_motivation_text text default null, p_temperature text default null)`: body copied verbatim from `20261003130000_my_leads_conflicts_non_retryable.sql:651-822`, plus: declare `v_follow jsonb;`; immediately before `insert into public.acquisition_offers (` (`:799`), after the pending-offer and motivation checks, add
```sql
  v_follow := public.fn_create_next_step(
    p_org := p_org_id, p_actor := v_actor,
    p_assignee := coalesce(v_property.assigned_user_id, v_actor),
    p_kind := 'appointment', p_title := 'Offer follow-up', p_due_at := p_follow_up_at,
    p_property := p_property_id, p_contact := v_property.homeowner_contact_id,
    p_mode := 'phone', p_source_key := 'offer_follow_up:' || v_offer_id::text, p_origin := 'offer');
```
    and add `follow_up_calendar_chain_id` to that insert with `(v_follow->>'calendar_chain_id')::uuid`. The earlier validation `p_follow_up_at > p_sent_at` (`:682`) already guarantees the CHECK `acquisition_offers_follow_up_after_sent_check` (`20260912090200:99-100`); `follow_up_at` stays non-null (`:81`). A back-dated "offer already made" can yield a past due date, which correctly shows up overdue. The `fn_log_acquisition_offer(p_input jsonb)` wrapper (`20260912120000_acquisition_workflow_commands.sql:838-864`) is unchanged.
  - Propagation and guards as three triggers (all `security definer set search_path=''`):
    1. `trg_tasks_offer_follow_up_sync` AFTER INSERT ON `public.tasks` WHEN `new.type='appointment' and new.calendar_chain_id is not null`: select the pending offer with `follow_up_calendar_chain_id = new.calendar_chain_id` (for update); none → return (this is the offer's own initial task, the offer row does not exist yet). Found → if `new.due_at <= offer.sent_at` raise `OFFER_FOLLOW_UP_BEFORE_SENT` (P0001) else `update acquisition_offers set follow_up_at = new.due_at, updated_at = statement_timestamp()`. This implements "reschedule → follow_up_at = new due_at" for every reschedule path.
    2. `trg_tasks_offer_follow_up_cancel_guard` BEFORE UPDATE OF status ON `public.tasks` WHEN `old.type='appointment' and new.status='cancelled' and old.status <> 'cancelled'`: unless `current_setting('sandra.allow_offer_follow_up_close', true)='on'`, raise `OFFER_FOLLOW_UP_PENDING: reschedule it or record the offer outcome instead` when a pending offer has this chain. Completing (held/no_show) and rescheduling stay allowed; only cancel is blocked.
    3. `trg_acquisition_offer_close_follow_up` AFTER UPDATE OF outcome ON `public.acquisition_offers` WHEN `old.outcome='pending' and new.outcome <> 'pending'` (covers `fn_record_acquisition_contract` `:901`, `fn_decline_acquisition_offer` `:976`, and the future `superseded` value): set both GUCs locally, `update public.tasks set status='cancelled', outcome='cancelled', calendar_generation=calendar_generation+1, updated_at=now() where org_id=new.org_id and calendar_chain_id=new.follow_up_calendar_chain_id and type='appointment' and status in ('open','snoozed')`, then reset both GUCs to `''` (do not leave the lifecycle bypass on for the rest of the transaction). Deviation from the record's word "auto-completes": cancelled is KPI-neutral (see Inputs). Phone-only in Phase 1, so no calendar ledger row is needed; the trigger inserts a `cancel` ledger row only if the task `mode='in_person'`.
  - `public.fn_my_leads_backfill_offer_follow_ups(p_org uuid, p_actor uuid, p_apply boolean default false, p_expected_fingerprint text default null) returns jsonb` (service-only; shared apply contract, 1e.1; fingerprint over `[{offer_id, property_id, outcome, follow_up_at, follow_up_calendar_chain_id, assignee}]` ordered by offer id; every statement filters `org_id = p_org`): for each pending offer with null chain, create the task through `fn_create_next_step` with **`p_due_at := greatest(o.follow_up_at, v_next_nine)`**, where `v_next_nine` is the next 09:00 America/Chicago strictly after the run (`(date_trunc('day', now() at time zone 'America/Chicago') + interval '9 hours' + case when (now() at time zone 'America/Chicago')::time >= time '09:00' then interval '1 day' else interval '0' end) at time zone 'America/Chicago'`), so the appointment is **never in the past**: an overdue offer's follow-up appears at the next 09:00, a not-yet-due offer keeps its own `follow_up_at`. Assignee = the property's assigned user, `p_source_key := 'offer_follow_up:'||o.id`, **`p_origin := 'offer_backfill'`** (attribution `source='offer_backfill'`, 1a.2). Then set the chain on the offer; `acquisition_offers.follow_up_at` is deliberately left at its historical value. Why this keeps the KPI gate: the attribution trigger stamps the appointment at its due time, and every backfilled `due_at` is after the run, so it cannot fall inside any closed historical `appointmentsDue` window; `fn_get_acquisition_kpis` for a historical window is therefore identical before and after (verified by the KPI rehearsal with an overdue-offer fixture, 4.6). Image: `acquisition_offers(follow_up_calendar_chain_id)` before/after, the created task (`op='created'`), its attribution row (`op='created'`); run row `kind='offer_follow_up_backfill'`. Rollback branch (added to `fn_my_leads_housekeeping_rollback` by copy-replace in this migration): per offer, only if the created task is still open and unchanged and the offer's chain still equals the after-image, cancel the task under both GUCs, delete its `offer_backfill` attribution row and null the chain; a rescheduled, completed or offer-resolved follow-up is skipped and listed in `summary.notRestored`.
- Side effects checked: `acquisition_offers_pending_property_idx` (one pending per property, `20260912090200:111-113`) means at most one chain is pending per lead; reschedule's ledger/lifecycle machinery is untouched; trigger 3 fires inside functions that already hold the property/offer row locks (`…:885,964` `for update`), so lock order stays property → offer → task; the P1b ranking reads the chain to show "Offer follow-up overdue" in tier 3.
- Preview query (backfill): `select count(*), min(follow_up_at), max(follow_up_at), count(*) filter (where follow_up_at < now()) overdue from public.acquisition_offers where org_id=:org and outcome='pending' and follow_up_calendar_chain_id is null;` (the preview JSON adds `overdueMovedToNextNine: n` and the fingerprint).
- Rollback (data): `fn_my_leads_housekeeping_rollback(:run)`. Rollback (schema): rollback file drops triggers, restores the prior `fn_log_acquisition_offer` body (`20261003130000:651-822`), drops the column.
- Tests: log an offer → one open phone appointment titled "Offer follow-up" with the same due as `follow_up_at`, chain stored on the offer, attribution row for the lead's assignee; second offer while pending → `PENDING_OFFER_EXISTS`, no extra task; reschedule the follow-up (via `fn_reschedule_appointment` as the assignee) → `follow_up_at` equals the successor's due and the offer still points at the chain; reschedule to a time at or before `sent_at` → `OFFER_FOLLOW_UP_BEFORE_SENT`; `fn_cancel_appointment` while pending → `OFFER_FOLLOW_UP_PENDING`; complete as held → allowed, `follow_up_at` unchanged (history); decline/accept the offer → the open task becomes cancelled, GUCs are reset (a later direct cancel in the same transaction is blocked again); `fn_log_acquisition_offer` replay with the same idempotency key returns the stored result and creates no second task; backfill creates one task per pending offer, is idempotent, rollback cancels them; **overdue-offer fixture:** a pending offer whose `follow_up_at` is 20 days past gets an appointment due at the next 09:00 Central (never before `now()`), attribution `offer_backfill`, offer `follow_up_at` unchanged, and `fn_get_acquisition_kpis` for a closed historical window is identical before and after; a stale fingerprint raises `HOUSEKEEPING_PREVIEW_STALE`; a follow-up the rep rescheduled after the run is not touched by rollback; DNC-locked lead raises `DNC_LOCKED` before any task is created.

#### 1a.7 `set_lead_next_action` (W2)
- Files: create `supabase/migrations/20261005130100_set_lead_next_action_next_step.sql`, rollback twin, integration test.
- Change: `create or replace function public.set_lead_next_action(p_property_id uuid, p_due_at timestamptz, p_idempotency_key uuid)` with the identical `returns table (...)`, `security invoker`, `set search_path = public, pg_temp`, body copied from `20260815233000:342-466` except: replay check `task_row.type <> 'follow_up'` (`:405`) becomes `task_row.next_step_kind <> 'appointment'` (a replayed key now resolves to a relabeled or new appointment); the insert at `:449-456` becomes
```sql
  select * into task_row from public.tasks where id = (public.fn_create_next_step(
    p_org := lead_row.org_id, p_actor := actor_id, p_assignee := actor_id, p_kind := 'appointment',
    p_title := 'Follow up on ' || lead_row.address, p_due_at := p_due_at,
    p_property := lead_row.id, p_contact := lead_row.homeowner_contact_id,
    p_lead_next_action_key := p_idempotency_key, p_origin := 'board') ->> 'task_id')::uuid;
```
  (`p_enforce_window` false: today's function has no window check.) `was_created` stays `true` on this branch. The TS action (`board-actions.ts:125-160`) needs no change; it only reads `id/title/due_at/was_created`.
- Side effects checked: the existing "one open task per lead" early return (`:421-436`) is kept, so a lead with any open task still returns it; idempotent replay of a pre-migration key hits the widened `tasks_lead_next_action_follow_up_check`; board counts read the earliest open task of any type (`20260815233000:130-141`).
- Tests: new key creates an appointment with the key stored; replay returns `was_created=false`; replay of a key whose row was relabeled (`follow_up`→`appointment`) returns it; different due on replay → `IDEMPOTENCY_KEY_CONFLICT`; DNC-locked → `DNC_LOCKED`; prospect → `NOT_A_LEAD`.
- Rollback: restore body from `20260815233000:342-466`.

#### 1a.8 Jitter writers (W5, W6) — two migrations, one per function
- Files: `supabase/migrations/20261005130200_jitter_softphone_callback_next_step.sql` (replaces `jitter_writeback_call_activity_softphone(text, jsonb, uuid, text, text, uuid, text, text)`), `…130300_jitter_writeback_callback_next_step.sql` (replaces `jitter_writeback_call_activity_before_metrics(text,jsonb,uuid,text,text,uuid,text,text)`), rollback twins, integration tests.
- Change: neither function is edited by hand. The builder generates each migration from the live definition: apply all migrations through `20261005130100` to a scratch local DB, `select pg_get_functiondef('<signature>'::regprocedure)`, apply exactly two textual replacements, and assert each pattern matched exactly once (a small helper inside the migration generator script, not shipped). Replacement 1 (the pre-check, `…:399-406` and `:718-725`): `and t.type = 'callback'` → `and t.next_step_kind = 'appointment'` (a reused open appointment at the same due time is still deduplicated). Replacement 2 (the insert, `…:408-420` and `:727-739`): the `insert into public.tasks (…) values (…) returning id into v_callback_task_id;` becomes
```sql
        v_callback_task_id := (public.fn_create_next_step(
          p_org := p_org_id, p_actor := p_callback_assignee_id, p_assignee := p_callback_assignee_id,
          p_kind := 'appointment',
          p_title := 'Callback ' || coalesce((select address from public.properties where id = v_property_id), 'property'),
          p_due_at := v_callback_at, p_property := v_property_id, p_mode := 'phone',
          p_origin := 'jitter') ->> 'task_id')::uuid;
```
  Everything else (the response `callback_task` object at `…:479-481` and `:797-799`, DNC handling, receipts, grants) is byte-identical; `create or replace` keeps ownership and grants (`20260913121000:98-100` re-grants the public one; the renamed one stays revoked).
- Side effects checked: runs as service role so `fn_create_next_step` takes the trusted branch; `p_enforce_window` false (a `callback_at` days out or slightly past is accepted as before); `tasks_reject_dnc_locked_contact` still raises; the new write adds a `task_created` lead event (`actor_type='system'`) and, for property-linked appointments, an attribution row for the callback assignee, so Jitter-requested callbacks now count in `appointmentsDue` (see core Risks); no bell/Slack notification (as today).
- Tests (local integration, extend `src/app/api/internal/jitter/call-activities/by-jitter-attempt/[attemptId]/route.integration.test.ts` where it already asserts the callback task): disposition `callback_requested` produces exactly one open `appointment` (phone, `end_at=due+15m`) and the same call twice produces one; assertion that `pg_get_functiondef` of both functions contains `fn_create_next_step` and no `'callback'` task-type literal; response shape unchanged.
- Rollback: rollback files restore the prior definitions from `20260825010000` (softphone `:37-503`, main `:508-821`; the `_before_metrics` rename from `20260913121000:6-7` is preserved).

#### 1a.9 Norma writers (W7, W8) — two migrations
- Files: `supabase/migrations/20261005130400_norma_complete_call_next_step.sql`, `…130500_norma_needs_review_next_step.sql`, rollback twins, integration tests; modify `src/lib/norma/stress/invariants.ts:239`.
- Change: `fn_norma_complete_call(uuid, text, text, jsonb)` is a verbatim copy of `20261002120500_norma_lock_order.sql:180-422` with the task block (`:367-402`: the `insert … on conflict … do update` and the following `lead_events` insert) replaced by
```sql
    begin
      v_task_id := (public.fn_create_next_step(
        p_org := r.org_id,
        p_actor := coalesce(r.requested_by, r.callback_assignee_id),
        p_assignee := r.callback_assignee_id,
        p_kind := case when v_task_type = 'custom' then 'task' else 'appointment' end,
        p_title := v_task_title, p_due_at := v_task_due,
        p_property := r.property_id, p_contact := r.contact_id,
        p_mode := 'phone', p_description := v_task_desc,
        p_source_key := v_task_key, p_origin := 'norma') ->> 'task_id')::uuid;
    exception when others then
      if not (sqlstate = 'P0001' and split_part(sqlerrm, ':', 1) = 'DNC_LOCKED') then raise; end if;
      v_task_id := null;
    end;
```
  (`v_task_type` still computes `callback`/`custom` for the title/description branches; `callback` now means kind `appointment`.) The manual `task_created` lead event is removed because `fn_create_next_step` writes the identical identity (`tasks.created`, task id), keeping `invariants.ts:279` (one event per Norma task) true. The reopen semantics of the old `do update` (status open, snooze/complete cleared) are reproduced by step 4 of `fn_create_next_step`, including the case where the Norma needs-review `custom` task is converted to a callback appointment (the conversion also inserts the missing attribution row). The "no task wanted" branch (`:405-417`, cancels a leftover review task) is unchanged.
  `fn_norma_mark_needs_review(uuid, text)` is a verbatim copy of `:558-612` with `insert into public.tasks … on conflict do nothing` replaced by `fn_create_next_step(p_kind := 'task', p_title := 'Norma call needs review: outcome unknown', p_due_at := now(), p_source_key := 'norma_call:'||r.id::text, p_description := <the existing string>, p_origin := 'norma', …)` inside the same `DNC_LOCKED` handler, and its manual lead event (`:601-607`) removed for the same reason.
  `src/lib/norma/stress/invariants.ts:239`: expected type for non-wrong-number outcomes `'callback'` → `'appointment'`; also assert `mode='phone'`.
- Side effects checked: lock order (request → enrollments → contact → property) is untouched because `fn_create_next_step` takes no new locks outside the task row; `norma_notifications` Slack outbox untouched; a stuck review task then a late callback result upgrades in place (the only path that crosses the appointment boundary by UPDATE, hence the flag inside the function); the `callback_assignee_id` must be an active member or the tenant guard raises as before.
- Tests: extend `20261002120000_norma_call_requests.integration.test.ts` expectations (`callback` → `appointment`) and add cases: needs-review task then `callback_requested` result converts the same row (same task id, `source_key` intact, chain set, attribution `next_step_conversion`), replay of `fn_norma_complete_call` returns `replayed` without a second task, DNC-locked lead still records the result with no task, wrong number stays a `custom` task; `npm run test:norma-stress` passes with the updated invariant.
- Rollback: restore prior bodies from `20261002120500:180-422` and `:558-612`.

#### 1a.10 TypeScript writers (W1, W3, W4) and the server-action wrapper
- Files: create `src/components/appointments/next-step-actions.ts` (`"use server"`: `createNextStepAction(input)` calls `createNextStep` and returns its `Result`; client components cannot import the lib directly); modify `src/app/(dashboard)/leads/actions.ts`, `src/app/(dashboard)/leads/[id]/lead-task-widget.tsx` and `.test.tsx`, `src/app/(dashboard)/leads/actions.test.ts`, `src/components/appointments/book-appointment-popover.tsx`, `src/app/(dashboard)/my-leads/client.tsx`, `src/lib/dialer/actions.ts` (+ its test).
- Change:
  - W1 `createLeadTaskAction(propertyId, input)` → `input: { kind: 'appointment' | 'task'; dueAt: string; assigneeId: string; title?: string; mode?: 'phone'|'in_person'; durationMinutes?: number; location?: string; note?: string }`. Keep the existing property lookup, `assertNotTrainingTarget`, `assertPropertyDncUnlocked`, actor and assignee membership checks and their error codes (`:1904-1985`); replace the `createTask` call (`:1992`) and the `after()` block with `createNextStep(...)` (title defaults: appointment `Call ${address}`, task requires a non-blank title). `dispatchTaskCalendarEvent` is dropped (phone has no calendar event; in-person uses the ledger). `LeadTaskKind` becomes `'appointment' | 'task'`. Widget: toggle labels `Appointment` / `Task` (test ids `lead-task-type-appointment`, `lead-task-type-task`), Phone/In person switch for appointments (in person reveals duration select and location input), title input shown for tasks; `callAction` success copy updated.
  - W3 dialer: replace `bookAppointment({...durationMinutes: 30...})` (`src/lib/dialer/actions.ts:602-613`) with `createNextStep({ kind:'appointment', mode:'phone', propertyId, contactId, assigneeId:user.id, dueAt: wallTimeToUtc({date,time,timeZone:resolvedZone}).utc.toISOString(), title: "Call back " + (input.target.address ?? "lead"), note: input.notes.trim(), idempotencyKey: input.wrapToken, applyBookingEffects:true, origin:'app' })` (invalid wall time returns the existing "Choose a valid date and time" error). The duplicate-repair block (`:625-640`) stays because booking effects stay on for this one caller. `getMemberTimezone` remains exported from `book-appointment-action.ts`.
  - W4 popover: add `mode` state (default `phone` when a property or contact is linked, `in_person` for a personal block); phone hides the duration control and submits 15 minutes; in person shows duration and a location input; submit calls `createNextStepAction`; reschedule mode passes the appointment's current `mode` so phone reschedules use `start+15m`. My Leads dialog (`client.tsx:1262-1281`) passes `contactId={dialog.row.contactId ?? undefined}` and `defaultMode="phone"`.
  - Remove nothing yet (`createTask`, `snoozeTask`, `bookAppointment` stay until P1a-retire so a stale deploy keeps working).
  - **Readiness (`next_step_write`, `offer_follow_up_chain`):** `createLeadTaskAction`, the dialer wrap-up, the popover action and the My Leads dialog call `createNextStep` only when `schemaReady('next_step_write')`; otherwise each runs its current code path unchanged (`createTask` / `bookAppointment` legacy body, 30-minute dialer callback), so the unflagged runbook window between deploy and migration cannot break an existing writer. The SQL writers (W2, W5-W8, W10) are replaced inside their own migrations and call only `fn_create_next_step`, which an earlier migration of this stack already created.
- Side effects checked: the dialer still sets `outreach_dispo='booked_appointment'` and pauses the drip through `applyBookingEffects` (that is today's behavior at `:596-600`); My Leads and lead-page next steps do not (default); `revalidatePath('/my-leads')` is added so the queue refreshes.
- Tests: every migrated TS writer against the preceding schema (no `fn_create_next_step`, no `tasks.mode`) takes the legacy path and succeeds; `leads/actions.test.ts` (kind validation, assignee errors preserved, no calendar dispatch), widget test (toggle, mode reveal, title required for task), popover test (phone hides duration, submits 15 min; in person submits duration/location), dialer test (callback books phone 15 min with the wrap token as idempotency key, duplicate path repairs the dispo exactly as before), `book-appointment-action.test.ts` still green (adapter unchanged).
- Rollback: revert the files; SQL is already compatible with old callers until P1a-retire.

### Acceptance (P1a-writers)
- `npm run typecheck && npm run lint && npm run test && npm run test:rtl`; `npm run test:integration:local`; `npm run test:norma-stress`; `npm run verify:migration-safety-unit`.
- Vercel preview with the test project: create an Appointment (phone) from the lead widget, from My Leads "schedule next step", from the board quick action, log an offer, then confirm in SQL that every new `tasks` row has `type in ('appointment','custom')`, phone rows have `end_at=due_at+interval '15 minutes'` and no `task_calendar_mutations` row, the offer has a chain and an open "Offer follow-up".
- Production: nothing automatic. After merge and deploy, run the relabel preview/apply and the offer follow-up backfill preview/apply (operator, with Jarrad's approval of the pasted previews).

### Risks and open questions (P1a-writers)
- Jitter and Norma bodies are large; the generator-plus-assertion approach (match exactly once) is the guard against a wrong copy. Reviewers should diff `pg_get_functiondef` before/after.
- Five SQL writer migrations are independent commits on purpose: if one regresses, revert that commit only.
- The dialer's 30→15 minute change is user-visible (calendar block length) [JARRAD].

---

## Sub-PR P1a-retire — Reject trigger last, type narrowing, snooze removal, KPI snapshot (decision 1a final bullets)

#### 1a.11 Reject trigger, TypeScript narrowing, snooze removal (preflight already shipped in P1a-core)
- Files: create `supabase/migrations/20261008100000_retire_follow_up_callback_types.sql`, rollback twin, `…retire_follow_up_callback_types.integration.test.ts`; modify `src/lib/tasks/index.ts` (+ `index.test.ts`, `index.integration.test.ts`), `src/app/(dashboard)/tasks/actions.ts`, `src/app/(dashboard)/leads/[id]/next-action-card.tsx`, `src/app/(dashboard)/dashboard/_components/task-actions-row.tsx` (+ their tests), `src/components/appointments/book-appointment-action.ts` (delete `bookAppointment`), `src/lib/norma/stress/*.integration.test.ts` fixtures that insert `callback` tasks.
- Change (SQL):
```sql
begin;
create or replace function public.tasks_reject_retired_types() returns trigger
language plpgsql set search_path = '' as $$
begin
  if coalesce(current_setting('sandra.allow_retired_task_type', true), '') = 'on' then return new; end if;
  -- explicit branches: plpgsql does not short-circuit, and OLD is unassigned in INSERT triggers
  -- (same warning as tasks_tenant_integrity_guard, 20260814150000_appointments_schema.sql:249-252)
  if tg_op = 'INSERT' then
    if new.type in ('follow_up','callback') then
      raise exception 'TASK_TYPE_RETIRED: create an appointment (phone) or a task instead of %', new.type using errcode = 'P0001';
    end if;
  elsif new.type in ('follow_up','callback') and new.type is distinct from old.type then
    raise exception 'TASK_TYPE_RETIRED: create an appointment (phone) or a task instead of %', new.type using errcode = 'P0001';
  end if;
  return new;
end $$;
revoke all on function public.tasks_reject_retired_types() from public, anon, authenticated;
create trigger trg_tasks_reject_retired_types before insert or update of type on public.tasks
  for each row execute function public.tasks_reject_retired_types();
-- the read-only retire preflight (`fn_my_leads_next_step_retire_preflight`) is NOT created here: it ships in P1a-core (1a.5) so the operator gate exists before this migration is reviewed or merged
commit;
```
  The type CHECK is deliberately NOT narrowed: historical rows keep `follow_up`/`callback` (decision: "history untouched"), and old completed rows must stay valid. Rollback of the relabel (1a.5) sets the old type under `sandra.allow_retired_task_type='on'`, which this trigger honors.
  The migration does NOT raise on leftover rows (that would block the whole CI migration pipeline on the shared test project, whose fixtures may contain such rows); the preflight (created by P1a-core, `20261005121500`, so it is live in production well before this PR is merged) is the operator gate instead.
  Change (TS): `src/lib/tasks/index.ts`: `TaskType` stays a read-side union of all four values, add `export type CreatableTaskType = 'appointment' | 'custom'`; delete `createTask` (`:48-123`), `snoozeTask` (`:249-366`), `scheduleCalendarUpdateAfterSnooze` and `dispoToTaskType` (`:20`); keep `completeTask` (non-appointments, e.g. the tasks that remain) and `reassignTask`. `tasks/actions.ts`: delete `snoozeTaskAction`. `next-action-card.tsx` and `task-actions-row.tsx`: remove the Snooze popover, `SNOOZE_PRESETS`, `TaskOperation` snooze branch. Delete `bookAppointment` and its adapter and `src/components/appointments/book-appointment-action.test.ts` cases that only covered it (the org/assignee helpers stay). Delete `src/app/(dashboard)/my-leads/_components/attempt-dialog.tsx` and its call sites (P1c keeps the old attempt dialog behind the `post_call_prompt` flag; it is deleted here, only after the flag has been on in production). Update every fixture that inserts `follow_up`/`callback` (run `grep -rnE "'follow_up'|'callback'" src e2e tests scripts supabase/migrations --include='*.ts'` and fix each, notably `src/lib/tasks/index.integration.test.ts`, `src/app/api/webhooks/slack/actions/route.integration.test.ts`, `src/lib/norma/stress/*`, `e2e/properties-filter-*`, `tests/search-oracle/fixture-generator.ts`); fixtures that need an old-typed row use `set_config('sandra.allow_retired_task_type','on',true)`.
- Side effects checked: `snoozed_until` is no longer written by any code (`snoozeTask` deleted); existing reads (`greatest(due_at, case when status='snoozed' then snoozed_until end)` in the queue/KPI SQL) are left alone because the relabel converts any `snoozed` row, and rewriting them is not needed ("ignored by new reads": the P1b ranking ignores it); legacy past-due `callback`/`follow_up` rows stay completable through `completeTask` (non-appointment).
- Tests: INSERT of `callback`/`follow_up` raises `TASK_TYPE_RETIRED` for authenticated and service role; INSERT of `appointment`/`custom` passes; UPDATE of an existing historical `callback` row's title/status still passes (trigger fires only when the type changes); the GUC escape works; Norma upsert path cannot produce a retired type; `tasks` unit tests updated.
- Rollback: rollback file drops the trigger and its function (the preflight stays, it belongs to P1a-core); code revert restores `createTask` etc.

#### 1a.12 KPI snapshot test
- Files: create `src/lib/my-leads/next-step-kpi-snapshot.integration.test.ts` (add to `vitest.local-integration.config.ts` include and `vitest.integration.config.ts` exclude).
- Change: loopback test replaying the P1e and P1a-core migrations in one rolled-back transaction. Seed one org with Jarrad as acquisitions member, queue leads in several stages, attempts (`reached`, `no_answer`, `voicemail`, pending `null` older than 7 days), pending and decided offers, past appointments (`held`, `no_show`, `rescheduled`, `cancelled`), legacy `callback`/`follow_up` rows (completed, past-due open, future open, future snoozed), and one future callback on a lead in `contacted`. Impersonate Jarrad (`set_config('request.jwt.claim.sub')`) and capture `fn_get_acquisition_kpis(org, jarrad, start, end)` for two historical windows (ending before the seed's "now") and one live window containing today. Then apply, in order: close-attempts, reassign (a second member's lead), relabel. Assertions: (1) historical windows are deep-equal before and after except `asOf` and `pendingOutcomes` (which drops by exactly the number of closed attempts inside the window); (2) `firstCallSamples` and `firstCallPending` for Jarrad are unchanged by the reassign (eligible=false episodes); (3) live window: `appointmentsDue` rises by exactly the relabeled rows due in the window, `contactWithoutFollowUp` falls by exactly the number of `contacted` leads whose only future step was a relabeled callback, `appointmentsHeld`, `attempts`, `reached`, `offersSent` unchanged; (4) rollback of all three runs returns every window to the original values; (5) completed and past-due legacy rows are not converted and not attributed.
- Rollback: delete the test.

### Acceptance (P1a-retire)
- All commands from P1a-writers plus the new retire and snapshot tests.
- Operator gate before merge (the function already exists in production from P1a-core): `select public.fn_my_leads_next_step_retire_preflight(:org)` via the service account must report `openFutureLegacy = 0` (run the relabel apply one more time first; it is idempotent). Paste the JSON in the PR. KPI before/after printout for Jarrad via the SQL snippet below, pasted in the PR:
```sql
begin; select set_config('request.jwt.claim.sub', :jarrad, true);
select public.fn_get_acquisition_kpis(:org, :jarrad, date_trunc('day', now()) - interval '30 days', date_trunc('day', now()));
rollback;
```

### Risks and open questions (P1a-retire)
- A stale browser tab or old deploy that still posts `follow_up`/`callback` fails after this merge; the error is `TASK_TYPE_RETIRED` and the retire PR must not merge until P1a-writers has been deployed and idle for one release.
- Past-due legacy rows remain `follow_up`/`callback` forever; the strip reads `next_step_kind` (which maps them to `appointment`), so they still surface as overdue, but their detail row shows the old Done control rather than the outcome row. Acceptable by D1 ("history untouched"); revisit only if Jarrad wants them converted (would change historical KPIs, not done here).

---

## Sub-PR P1b — Ranked "Call next" strip (decisions D2, D3, 1b)

### Work items (ordered; each independently committable)

#### 1b.1 Overrides table, touch facts, ranking and write RPCs
- Files: create `supabase/migrations/20261005150000_my_leads_call_next.sql`, rollback twin, `supabase/migrations/20261005150000_my_leads_call_next.integration.test.ts`.
- Change (DDL and functions; every function `security definer set search_path = ''`):
```sql
begin;
create table public.my_leads_strip_overrides (
  org_id uuid not null references public.organizations(id) on delete cascade,
  member_id uuid not null references auth.users(id) on delete cascade,
  property_id uuid not null,
  pinned_at timestamptz, pinned_until timestamptz,   -- "Call today": pin until called or midnight Central
  hidden_until timestamptz,                            -- "Not today": hidden until midnight Central
  updated_at timestamptz not null default now(),
  primary key (org_id, member_id, property_id),
  constraint my_leads_strip_overrides_property_org_fkey
    foreign key (property_id, org_id) references public.properties(id, org_id) on delete cascade,
  constraint my_leads_strip_overrides_one_kind_check
    check (num_nonnulls(pinned_until, hidden_until) = 1 and ((pinned_until is null) = (pinned_at is null)))
);
alter table public.my_leads_strip_overrides enable row level security;
revoke all on public.my_leads_strip_overrides from public, anon, authenticated, service_role;
grant select on public.my_leads_strip_overrides to authenticated;
create policy my_leads_strip_overrides_select_own on public.my_leads_strip_overrides
  for select to authenticated
  using (member_id = (select auth.uid()) and public.hugo_has_active_org_access(org_id));
-- writes go only through fn_set_my_leads_strip_override (no insert/update/delete grant, no write policy)
```
  `public.my_leads_touch_facts(p_org uuid, p_member uuid, p_at timestamptz) returns table(property_id uuid, last_touch_at timestamptz, last_call_at timestamptz, last_inbound_at timestamptz, last_inbound_kind text)` (`language sql stable`, revoked from every API role, internal): over the member's queue (`my_leads_queue_rows(p_org,p_member,p_at)` joined to `properties` for `homeowner_contact_id`):
  - `last_touch_at` = max of: `acquisition_attempts.occurred_at`; outbound SMS `messages.created_at` with `status in ('sent','delivered')` matched by `property_id`, or `property_id is null and contact_id = homeowner_contact_id` (same attribution rule as the SMS history read, `src/lib/my-leads/queries.ts` `readAcquisitionSmsHistory`); `lead_notes.created_at`; outbound `call_activities.started_at` (`direction is distinct from 'inbound'`). All bounded by `<= p_at`. This is D3's "attempt, outbound text, note, call". `last_call_at` = max of `acquisition_attempts.occurred_at` and outbound `call_activities.started_at` only (no text, no note); it alone clears a "Call today" pin (D2: pinned until called).
  - `last_inbound_at/kind` = newest of: inbound SMS (`direction='inbound' and channel='sms'`, same attribution) and inbound `call_activities` with `ended_at is not null and coalesce(talk_duration_seconds,0)=0` (dormant until Phase 2 records inbound calls; the predicate ships now so Phase 2 only has to write rows). An inbound item is a touch by the seller, never part of `last_touch_at`.
  Indexes already serve this: `idx_messages_property_direction_created (property_id, direction, created_at desc)` (`20260815233000:29-31`), `acquisition_attempts_property_occurred_idx` (`20260912090200:63-64`). No new index.
  `public.my_leads_call_next_rows(p_org uuid, p_member uuid, p_at timestamptz) returns table(property_id uuid, tier smallint, reason text, reason_at timestamptz, pinned boolean, hidden boolean, excluded_reason text, last_touch_at timestamptz, assignment_sort timestamptz, sort_key double precision, row_data jsonb)` (`language sql stable`, internal, revoked from every API role so tests can pass a fixed `p_at`). Shape of the SQL (the one projection, no second copy of the queue rules):
```sql
with q as (select r.property_id, r.stage, r.assignment_sort, r.row_data
           from public.my_leads_queue_rows(p_org, p_member, p_at) r),
people as (
  select q.*, p.motivation_level, p.homeowner_contact_id, c.do_not_contact,
         array_remove(array[nullif(btrim(c.phone_1),''), nullif(btrim(c.phone_2),''), nullif(btrim(c.phone_3),'')], null) as phones
  from q join public.properties p on p.id = q.property_id and p.org_id = p_org
  left join public.contacts c on c.id = p.homeowner_contact_id and c.org_id = p_org),
facts as (
  select pe.*, tf.last_touch_at, tf.last_call_at, tf.last_inbound_at, tf.last_inbound_kind,
    exists (select 1 from public.sequence_enrollments e
            where e.org_id = p_org and e.property_id = pe.property_id and e.status = 'active') as in_drip,
    ov.pinned_at, ov.pinned_until, ov.hidden_until
  from people pe
  left join public.my_leads_touch_facts(p_org, p_member, p_at) tf on tf.property_id = pe.property_id
  left join public.my_leads_strip_overrides ov
    on ov.org_id = p_org and ov.member_id = p_member and ov.property_id = pe.property_id),
appts as (   -- open appointments only; 'snoozed' is ignored (D1: no snooze)
  select t.related_property_id as property_id, t.due_at,
    exists (select 1 from public.acquisition_offers o
            where o.org_id = p_org and o.property_id = t.related_property_id and o.outcome = 'pending'
              and o.follow_up_calendar_chain_id = t.calendar_chain_id) as is_offer_follow_up
  from public.tasks t
  where t.org_id = p_org and t.next_step_kind = 'appointment' and t.status = 'open'
    and t.related_property_id is not null and t.due_at <= p_at + interval '15 minutes'),
due as (
  select property_id,
         min(due_at) filter (where not is_offer_follow_up) as appt_due_at,
         min(due_at) filter (where is_offer_follow_up)     as offer_task_due_at
  from appts group by property_id),
pend as (select o.property_id, o.follow_up_at, (o.follow_up_calendar_chain_id is not null) as has_chain
         from public.acquisition_offers o where o.org_id = p_org and o.outcome = 'pending'),
ranked as (
  select f.*, d.appt_due_at, d.offer_task_due_at, pe2.follow_up_at as offer_follow_up_at,
    (f.pinned_until > p_at and (f.last_call_at is null or f.last_call_at <= f.pinned_at)) as pinned,
    (f.hidden_until > p_at) as hidden,
    case when f.do_not_contact then 'contact_dnc' when cardinality(f.phones) = 0 then 'no_phone' end as excluded_reason,
    case
      when f.pinned_until > p_at and (f.last_call_at is null or f.last_call_at <= f.pinned_at) then 0
      when d.appt_due_at is not null then 1
      when f.last_inbound_at is not null and f.last_inbound_at > coalesce(f.last_touch_at, '-infinity') then 2
      when f.stage = 'needs_offer' and pe2.property_id is null then 3
      when f.stage = 'offer_sent' and coalesce(d.offer_task_due_at, case when not pe2.has_chain then pe2.follow_up_at end) <= p_at then 3
      when f.motivation_level in ('hot','warm') and coalesce(f.last_touch_at, '-infinity') < p_at - interval '3 days' then 4
      else 5 end::smallint as tier
  from facts f left join due d using (property_id) left join pend pe2 on pe2.property_id = f.property_id
  where not f.in_drip)
select property_id, tier,
  case tier when 0 then 'pinned_call_today'
            when 1 then case when appt_due_at <= p_at then 'appointment_overdue' else 'appointment_due' end
            when 2 then case last_inbound_kind when 'call' then 'inbound_call' else 'inbound_text' end
            when 3 then case when stage = 'needs_offer' then 'needs_offer' else 'offer_follow_up_overdue' end
            when 4 then case motivation_level when 'hot' then 'hot_going_cold' else 'warm_going_cold' end
            else 'longest_since_touch' end as reason,
  case tier when 0 then pinned_at when 1 then appt_due_at when 2 then last_inbound_at
            when 3 then coalesce(offer_task_due_at, offer_follow_up_at, (row_data->>'stageEnteredAt')::timestamptz)
            else last_touch_at end as reason_at,
  pinned, hidden, excluded_reason, last_touch_at, assignment_sort,
  case tier when 0 then extract(epoch from pinned_at) when 1 then extract(epoch from appt_due_at)
            when 2 then -extract(epoch from last_inbound_at) when 3 then extract(epoch from coalesce(offer_task_due_at, offer_follow_up_at, (row_data->>'stageEnteredAt')::timestamptz))
            else coalesce(extract(epoch from last_touch_at), -1e12) end as sort_key,
  row_data
from ranked;
```
  (`pinned`/`hidden` are computed once in a CTE in the real migration and wrapped in `coalesce(..., false)` because the override columns are null for most leads; shown inline here for brevity.) Tier semantics against D3: 1 appointment due (within 15 min) or overdue, any mode, any assignee (My Leads reads any assignee, D1), offer follow-up appointments excluded here and ranked in tier 3 instead; 2 inbound text or call newer than the last touch, newest first; 3 `needs_offer` with no offer, or `offer_sent` whose follow-up task (the chain, falling back to `acquisition_offers.follow_up_at` only for offers not yet backfilled) is due; 4 hot/warm (`properties.motivation_level`, the queue row's `temperature`) with no touch in 3 days; 5 everyone else, longest since touch first (never-touched first). Ties: assignment age (oldest `assignment_sort` first, `20261003120000:32` = `coalesce(e.assigned_at, e.initialized_at)`), then `property_id`. "Today"/"midnight" are America/Chicago (below). Exclusions, per D3: no callable phone (`phones` empty) and contact DNC (`contacts.do_not_contact`, which the global phone registry already ratchets via `zz_apply_global_phone_dnc_to_contact`, `20260830092331_switchboard_contact_preferences.sql:73-96`, so the registry is not re-queried); property-level DNC-locked leads are already absent from the queue projection (`20261003120000:62`); leads in an active drip (`sequence_enrollments.status='active'`) are excluded exactly as the sections hide them (`src/app/(dashboard)/my-leads/adapter.ts` `stagePages` filters `activeIds`); a drip lead that replied is `paused` and surfaces through the inbound-text tier.
  `public.fn_get_my_leads_call_next(p_org_id uuid, p_member_id uuid, p_limit integer default 10) returns jsonb` (default volatility like `fn_get_my_leads_queue_row`, `20261003120000:100`, because it calls the non-stable `my_leads_require_read_scope`; `set statement_timeout = '5s'`, granted to `authenticated`, revoked from `public, anon`): `perform public.my_leads_require_read_scope(p_org_id, p_member_id)` (same gate as every queue read, `20260912110000:19-37`; owners may read a rep's strip); `p_limit` 1–25 else `INVALID_INPUT` (22023); reads `my_leads_call_next_rows(p_org_id, p_member_id, statement_timestamp())` once (`materialized`) and returns `{ rows: [{propertyId, tier, reason, reasonAt, pinned, lastTouchAt, row: <queue row_data>}] (top p_limit of not-excluded, not-hidden, ordered by tier, sort_key, assignment_sort, property_id), excluded: [{propertyId, address, reason}] (max 25), hiddenCount, snapshotAt }`. `row` is the same JSON the queue returns, so the client can hand it to the existing actions unchanged. Naming: this pair is the decision record's "call next" RPC; the `now` parameter lives on the internal `my_leads_call_next_rows(org, member, at)` (so tests can pin time) and the public wrapper uses `statement_timestamp()` like every other queue RPC.
  `public.fn_set_my_leads_strip_override(p_org_id uuid, p_member_id uuid, p_property_id uuid, p_action text) returns jsonb`: `my_leads_require_read_scope`; `auth.uid() = p_member_id` else `FORBIDDEN` (an owner can read a rep's strip but never change it); `p_action in ('call_today','not_today','clear')` else `INVALID_INPUT`; the lead must be in the member's queue (`my_leads_queue_rows(...)`) else `NOT_FOUND` (P0002); midnight is computed in the database, never taken from the client: `v_midnight := (date_trunc('day', v_now at time zone 'America/Chicago') + interval '1 day') at time zone 'America/Chicago'` (the pattern the KPI function uses for `v_today_start`, `20260930031000:887`). First deletes this member's expired rows, then `call_today` upserts `pinned_at=v_now, pinned_until=v_midnight, hidden_until=null`; `not_today` upserts `hidden_until=v_midnight, pinned_*=null`; `clear` deletes. Returns `{ok, until}`.
  `public.fn_get_my_leads_triage(p_org_id uuid, p_member_id uuid, p_days integer default 14, p_limit integer default 25, p_after_touch timestamptz default null, p_after_property uuid default null) returns jsonb` (the "untouched > 14 days, no next step" chip, 1b "One-time triage helper"): queue leads not in an active drip with no open appointment due in the future (any mode) and `last_touch_at is null or < now - p_days days`; ordered by `last_touch_at asc nulls first, property_id`; keyset pagination; returns `{rows: [{propertyId, lastTouchAt, row}], totalCount, cursor}`. Same auth gate and bounds (days 1–365, limit 1–50).
- Side effects checked: read-only except the override table; `my_leads_queue_rows` is `stable security definer` and revoked from API roles, so only these definer wrappers can reach it (`20261003120000:84-88`); the strip never touches `acquisition_queue_states`, so it cannot move a lead between sections (D2); KPIs and timers are untouched.
- Tests (`…my_leads_call_next.integration.test.ts`, loopback pattern with `as('authenticated', sub, …)` from `20261003120000…integration.test.ts`; internal rows function exercised with a fixed `p_at`): one lead per tier lands in the right tier with the right `reason` and `reason_at`; ordering inside each tier (tier 1 oldest due first; tier 2 newest inbound first; tier 5 never-touched first); tie-break by assignment age then id; an appointment due in 10 minutes is tier 1 but one due in 20 minutes is not; an offer follow-up appointment (chain on a pending offer) is tier 3 `offer_follow_up_overdue`, not tier 1; `offer_sent` without a chain falls back to `follow_up_at`; inbound after last outbound is tier 2, an outbound or note after the inbound drops it to tier 4/5; a snoozed task is ignored; a legacy `callback` due now counts as tier 1 (via `next_step_kind`); contact DNC and phone-less leads are excluded and appear in `excluded`; drip-active lead is absent; `call_today` pins to the top, clears automatically after a later attempt or outbound call (an outbound text or note does not unpin) and after midnight Central (test across a DST boundary date), `not_today` hides and counts in `hiddenCount`; both overrides reject a lead outside the queue and another member's id; owner may read a rep's strip but not write; anon and unauthenticated denied; direct call to the internal rows/touch functions by `authenticated` is denied; `p_limit` 0 and 26 rejected; 400-lead volume case completes under the 5 s statement timeout; the queue page ordering (`fn_get_acquisition_queue_page`) is unchanged (existing test).
- Rollback: rollback file drops the five functions and the table. No production rows are written by merge.

#### 1b.2 Server reads and actions (TypeScript)
- Files: create `src/lib/my-leads/call-next.ts` (server-only), `src/lib/my-leads/call-next.test.ts`, `src/app/(dashboard)/my-leads/strip-actions.ts` (`"use server"`); modify `src/app/(dashboard)/my-leads/actions.ts`, `src/app/(dashboard)/my-leads/page.tsx`.
- Change: in `call-next.ts` reuse `myLeadsViewer`/`readRpc`'s pattern from `src/lib/my-leads/queries.ts` (export `readRpc` or duplicate its 15-line error mapping; prefer export):
```ts
export type CallNextReason =
  | "pinned_call_today" | "appointment_due" | "appointment_overdue" | "inbound_text" | "inbound_call"
  | "needs_offer" | "offer_follow_up_overdue" | "hot_going_cold" | "warm_going_cold" | "longest_since_touch";
export type CallNextRow = { propertyId: string; tier: 0 | 1 | 2 | 3 | 4 | 5; reason: CallNextReason;
  reasonAt: string | null; pinned: boolean; lastTouchAt: string | null; row: QueueRow };
export type CallNextSnapshot = { rows: CallNextRow[];
  excluded: { propertyId: string; address: string; reason: "no_phone" | "contact_dnc" }[];
  hiddenCount: number; snapshotAt: string };
export async function getCallNext(input: { memberId: string }): Promise<CallNextSnapshot>;   // fn_get_my_leads_call_next, limit 10
export type TriageSnapshot = { rows: { propertyId: string; lastTouchAt: string | null; row: QueueRow }[]; totalCount: number; cursor: { touch: string | null; property: string } | null };
export async function getTriage(input: { memberId: string; cursor?: TriageSnapshot["cursor"] }): Promise<TriageSnapshot>;
```
  Validate the JSON at the boundary the way `isQueueRowFor` does (`queries.ts` `getMyLeadsQueueRow`): a malformed row is dropped, never rendered. `strip-actions.ts` (`"use server"`): `loadCallNext(memberId)`, `loadTriage(memberId, cursor)`, `setStripOverride({memberId, propertyId, action})` → `fn_set_my_leads_strip_override`, each returning `{ok:true,...} | {ok:false,message}` and reporting failures through `reportMyLeadsReadFailure`-style helpers (`actions.ts:507-514`). `loadMyLeads` (`actions.ts:36-58`) adds `getCallNext` to its `Promise.all` as `.catch(() => null)` so a strip failure never blanks the page, and returns `strip`. `page.tsx:170` adds the same read to its `Promise.all` and passes `initialStrip` to `MyLeadsClient`. Both first read the `call_next_strip` flag (`getMyLeadsFlag`, 1a.1) and `schemaReady('call_next')` (the ranking functions exist); when either is false they skip the strip RPC and return `strip: null`, so the existing queue is unchanged and the strip code is inert until the flag is on and its migration has landed.
- Side effects checked: the 30-second background refresh (`client.tsx` `refresh`, `:426-513`, timer `:532-565`) already calls `loadMyLeads`, so the strip refreshes on the poll and after every mutation (`onCommitted` → `refresh()`, `:708-714`) with no new timer; no new route.
- Tests (`call-next.test.ts`): flag off (or a missing flags table) never calls the strip RPC and returns `strip: null`; maps RPC errors like `queries.test.ts`; drops malformed rows; `loadMyLeads` returns `strip: null` when the strip RPC fails but the queue succeeds; `setStripOverride` rejects an unknown action before the RPC.
- Rollback: revert files.

#### 1b.3 Strip UI
- Files: create `src/app/(dashboard)/my-leads/_components/call-next-strip.tsx`, `call-next-row.tsx`, `call-next-reason.ts`, `triage-list.tsx` and a `*.test.tsx` for each; modify `src/app/(dashboard)/my-leads/client.tsx`, `src/app/(dashboard)/my-leads/_components/types.ts`.
- Test ids (seam S4): `call-next-strip` on the strip, `call-next-row-<propertyId>`, `call-next-reason-<propertyId>`, `call-next-action-call-today-<propertyId>`, `call-next-action-not-today-<propertyId>`, `call-next-action-dead-nurture-<propertyId>`.
- Component tree and behavior:
```
<MyLeadsClient>                                   (client.tsx; owns `strip`, `triage` state, filled from loadMyLeads/initialStrip)
  <CallNextStrip rows excluded hiddenCount snapshotAt canCall onCall onCallToday onNotToday onDeadNurture onToggleTriage triageCount>
    header: "Call next" · "{rows.length} of {n}" · "{hiddenCount} hidden today" · "{excluded.length} need a phone number" (collapsed list) · Triage chip
    <CallNextRow>*10  name · address · <ReasonChip reason reasonAt/> · temperature dot · Call button · menu (Call today | Not today | Dead / Nurture)
    <TriageList>      (when chip on) paged list of the same row component, "Load more" via loadTriage
  <MyLeadsQueue …/>                               (unchanged; sections, KPI tiles, timers untouched)
```
  `call-next-reason.ts` exports `reasonLabel(reason, reasonAt, now)`: plain-English single line ("Callback due 10:00 AM" / "Callback 2 days overdue" / "Texted you 2h ago" / "Needs an offer · waiting 1d" / "Offer follow-up 3d overdue" / "Hot, no touch in 4d" / "Warm, no touch in 5d" / "Pinned: call today" / "Longest since last touch · 12d"), America/Chicago via the existing `dateLabel` formatter in `adapter.ts`. Unit-tested table, including singular/plural and the null-`reasonAt` case. This is interface copy, not a business rule.
  `client.tsx` changes: (1) state `strip` from `initialStrip`, replaced by every `refresh` result (keep the previous strip if the new read is `null`); (2) render `<CallNextStrip>` immediately above `<MyLeadsQueue>` (`:1048`) only when `roster.settings.enabled` and the snapshot is loaded; (3) wiring: Call → `action("start-call", propertyId)` (the existing Dialpad/softphone entry, `action()` `:622-697`; Phase 2 swaps what it dispatches, not this button); Dead/Nurture → `action("handoff", propertyId)` (opens the existing handoff dialog with its required reason, `lifecycle-dialog.tsx:89-197`, unchanged); Call today / Not today → `setStripOverride` then `refresh(true)`; (4) `copiesFor`/`indexCopies` (`:156-176`) also read strip rows so `rawRow(id)` (`:568`, built on `findRow` `:407-416`) finds a strip lead that is not on a loaded section page, otherwise `action()` would return silently (`:628`); (5) Call and menu are disabled when `member !== viewer.userId` (owner viewing a rep's queue), matching the existing guard at `:632-635`; (6) the owner member selector already scopes `loadMyLeads({memberId: member})`, so the strip follows it with no extra code.
  Detail panel shows the strip reason (decision 1c, "Detail panel shows … the new strip reason"): `queue-row.tsx` and `detail-panel.tsx` accept `stripReason?: string`, computed in `client.tsx` from the lead's strip row via `reasonLabel`, rendered as "In Call next: <reason>" when present.
  `_components/types.ts`: add `MyLeadsStripProps`; leave `MyLeadAction` unchanged.
- Side effects checked: the strip is read-only derived data (never moves a lead between sections); accessibility: the menu uses the existing `dropdown-menu` primitive, the reason chip is text (not colour only); no change to `queue.tsx`/`queue-row.tsx` section rendering.
- Tests: RTL for strip (renders ≤10 rows in order, reason text, hidden/excluded counts, triage toggle), row (Call disabled for non-self, menu actions call handlers once, Dead/Nurture opens handoff through `onDeadNurture`), `client.test.tsx` additions (strip appears above sections, a strip-only lead opens its handoff dialog, refresh after Call today, a failed strip read leaves the sections working), `reason` table test; synthetic e2e `e2e/synthetic/my-leads-call-next.spec.ts` with harness `e2e/synthetic/fixtures/my-leads-call-next-harness.tsx` (pattern of `my-leads-sms-harness.tsx`): strip renders above sections, menu keyboard-operable, Call today moves the lead to the top. Extend `e2e/my-leads.local.spec.ts` with: seed a lead with an overdue appointment and one with an inbound text, assert order and reasons, Call today → top, Not today → gone, Dead/Nurture → handoff dialog.
- Rollback: revert files; the RPCs are additive and harmless without the UI.

### Acceptance (P1b)
- `npm run typecheck && npm run lint && npm run test && npm run test:rtl`; `npm run test:integration:local`; `npm run test:e2e:synthetic -- e2e/synthetic/my-leads-call-next.spec.ts`; `npx playwright test --config playwright.my-leads-local.config.ts e2e/my-leads.local.spec.ts` (loopback acceptance fixture, per the file header).
- Production (read-only) after merge: from the SQL tool as Jarrad (`set_config('request.jwt.claim.sub', :jarrad, true)`), `select public.fn_get_my_leads_call_next(:org, :jarrad)` returns ≤10 rows each with a reason; screenshot the live strip in the preview for the PR. Nothing is written until he clicks Call today / Not today.

### Risks and open questions (P1b)
- Tier 2 depends on message attribution by `property_id` or contact-only; a seller texting from a number not on the contact is invisible (same limit as the SMS history read).
- Until the Phase 2 matcher, Jarrad's native Dialpad calls are not touches (only attempts he logs, outbound texts, notes), so a lead he just called but did not log stays high in the strip. The post-call prompt (P1c) is what closes this loop.
- Tier 1 has no age cap (D3 "due or overdue") and sorts oldest due first. If production has many ancient open `callback`/`follow_up` rows past due (the retire preflight reports `openPastDueLegacy`), they will fill the strip and bury today's promises. Decide before P1b merges: complete/cancel them as a separate approved data step, or cap tier 1 overdue at N days (older ones then fall to tiers 4-5). [JARRAD]
- The strip is ten rows by decision; "Not today" is the pressure valve. If the 102 stale leads dominate tier 5, the Triage chip plus Dead/Nurture is the planned drain (one-time).

---

## Sub-PR P1c — Post-call prompt v1 (decisions D9 first half, 1c)

### Work items (ordered; each independently committable)

#### 1c.1 Database support: voicemail outcome, note idempotency, call references, attempt notes
- Files: create `supabase/migrations/20261005160000_post_call_prompt_support.sql`, rollback twin, `…post_call_prompt_support.integration.test.ts`.
- Change (each function is `create or replace` of the live body with only the stated diff; grants and owners are preserved):
  1. `fn_log_acquisition_attempt_without_sms_obligation(p_input jsonb)`: body of `20261003130000_my_leads_conflicts_non_retryable.sql:391-474`, outcome list at `:416` → `('reached','no_answer','wrong_number','voicemail')`.
  2. `fn_finalize_acquisition_attempt_without_sms_obligation(p_input jsonb)`: body of `…:1122-1172`, list at `:1142` → same four. (`not_logged` stays system-only; the CHECK that allows both new values is in P1e, `20261005110000`.) The public wrappers need no change: they create the no-answer SMS obligation only when `p_input->>'outcome'='no_answer'` (`20260917193000_recording_accountability.sql:170-195`, finalize wrapper `20260917100000_rep_sms_obligations.sql:974-995`), so `voicemail` is obligation-free. `RECORDING_REQUIRED` (`20260917193000:174`) is left exactly as is: it fires only for a manual DialPad log without a link.
  3. `alter table public.lead_notes add column idempotency_key uuid;` + `create unique index idx_lead_notes_org_idempotency on public.lead_notes (org_id, idempotency_key) where idempotency_key is not null;` (the table has no other uniqueness, `supabase/migrations/010_va_polish_seams.sql:48-63`).
  4. `fn_get_acquisition_call_references(p_org_id uuid, p_property_id uuid, p_member_id uuid)` (live body `20260929120000_dialpad_cti_call_projection.sql:496-515`): join `public.call_activities c on c.id = a.call_activity_id and c.org_id = a.org_id` and return `{id, occurredAt, callOutcome: c.outcome, talkSeconds: c.talk_duration_seconds, provider: c.provider}` per pending call (same filters, same limit 20).
  5. `my_leads_detail_rows(p_org uuid, p_property uuid, p_group text)`: the P1a-core body plus `'note', a.note` in the attempts fact so the detail panel can show attempt notes.
- Side effects checked: widening the two validators is safe because the column CHECK from P1e already admits `voicemail`; `my_leads_reconcile_call` (`20260912130000_acquisition_call_reconciliation.sql:9`) maps a Sandra softphone call outcome `voicemail` to attempt outcome `no_answer`; left unchanged on purpose (it only fills an empty outcome for Sandra softphone calls, not the prompt's explicit choice), flagged below; `lead_notes` insert RLS is unchanged.
- Tests: log and finalize accept `voicemail`, reject `bogus` and `not_logged`; a `voicemail` attempt creates no `rep_sms_obligations` row while `no_answer` still does; note unique index rejects a duplicate key and allows many null keys; call-reference JSON carries the three new fields; detail attempts fact includes `note`; the manual DialPad log without a link still raises `RECORDING_REQUIRED`.
- Rollback: rollback file restores prior bodies verbatim and drops the index/column (only safe while no note uses the key).

#### 1c.2 Outcome vocabulary in TypeScript
- Files: modify `src/lib/my-leads/types.ts:19-22`, `src/lib/my-leads/validation.ts:46`, `src/app/(dashboard)/my-leads/adapter.ts:73`, `src/app/(dashboard)/leads/[id]/acquisition-history.tsx:107`, `src/app/(dashboard)/leads/[id]/lead-call-summary.tsx:84`, `src/lib/integrations/slack/unfurl-blocks.ts:25`; create `src/lib/my-leads/outcome-suggestion.ts` and test.
- Change: add `"voicemail"` to `AcquisitionAttemptOutcome` and `ATTEMPT_OUTCOMES`; label maps get `voicemail: "Voicemail"` and `not_logged: "Not logged"`. `outcome-suggestion.ts` exports `suggestOutcome(ref: {provider: string; callOutcome: string | null; talkSeconds: number | null}): "reached" | "no_answer" | "voicemail" | null`: `voicemail`→`voicemail`; `connected_human`→`reached`; `no_answer`|`busy`→`no_answer`; provider `dialpad` with `callOutcome='unknown'` and `talkSeconds>0`→`reached` (the CTI projection writes `unknown` for a connected call, `20260930036000:93-97`); otherwise `null` (no prefill). Contact rate stays "reached / attempts" (`20260930031000:891`), so voicemail is not reached with no KPI SQL change.
- Tests: table-driven `suggestOutcome` (every `call_activities.outcome` the Sandra softphone and the CTI projection can write); `validation.test.ts` accepts voicemail; adapter/label snapshots.
- Rollback: revert.

#### 1c.3 Prompt component, extras, and hook plumbing
- Files: create `src/app/(dashboard)/my-leads/_components/post-call-prompt.tsx`, `no-answer-follow-up.tsx`, `src/lib/my-leads/quick-picks.ts`, tests; keep `src/app/(dashboard)/my-leads/_components/attempt-dialog.tsx` behind the `post_call_prompt` flag (it is deleted in p1a-retire, only after the flag has been on in production); modify `use-attempt-workflow.ts`, `types.ts`, `client.tsx`, `src/app/(dashboard)/my-leads/actions.ts`, `src/app/(dashboard)/leads/actions.ts` (`createLeadNote`), `detail-panel.tsx`, `queue-row.tsx`, `adapter.ts`, and the tests that import the old dialog (`dialogs.test.tsx`, `use-attempt-workflow.test.tsx`, `client.test.tsx`, `client-pin.test.tsx`, `queue.test.tsx`).
- Change, UI (`post-call-prompt.tsx`, same props contract as the old `AcquisitionAttemptDialog`, `attempt-dialog.tsx:69-82`, so `client.tsx:1197-1213` renders `<PostCallPrompt>` when the `post_call_prompt` flag is on and the old `<AcquisitionAttemptDialog>` otherwise; the flag is read server-side in `page.tsx` and passed down; a missing flag reads OFF):
  - Test ids (seam S4): `post-call-prompt` (root), `post-call-outcome`, `post-call-note`, `post-call-pick-tomorrow`, `post-call-pick-3-days`, `post-call-pick-next-week`, `post-call-pick-pick`.
  - Outcome: four segmented options Reached / No answer / Voicemail / Wrong number, prefilled by `suggestOutcome` when `initialCallActivityId` resolves in `callReferenceOptions` (the option list now carries `callOutcome`, `talkSeconds`, `provider`); the rep can change it.
  - One note field (optional). It is written to `lead_notes`, not to the hidden attempt note; the attempt payload sends `note: null`.
  - Quick next step: Tomorrow / 3 days / Next week / Pick (date and time in America/Chicago) creating a phone appointment. `quick-picks.ts` exports `quickPickDueAt(pick, now, opts?: {time?: string; timeZone?: string}): Date` built on `addDaysInZone` and `wallTimeToUtc` (`src/lib/time/zoned.ts:151,201`), default time `10:00` America/Chicago, Next week = +7 days; DST-safe (never `+24h`). Nothing is created unless a pick is made. If the lead has no open future step and a pick was not made, an inline non-blocking hint "No next step yet" shows; nothing blocks save (D9).
  - Buttons after save: Ready to make an offer (calls the existing `action("ready-for-offer")` path) and Dead / Nurture (existing `action("handoff")` dialog, same required reason). Send contract is not rendered in Phase 1 (it ships with Phase 3; no dead control).
  - Source and recording: the old three-way Source select collapses to a quiet "Where was this call?" row, default DialPad unless `initialCallActivityId` is set (then "Sandra call"). The recording link field renders only for manual DialPad and stays required there (server rule unchanged); the "When did it occur?" field renders only for manual sources and is omitted for linked calls (payload uses `occurredAt = now`; finalize ignores it, `20261003130000:1122-1172`).
  - Acquisitions manager: prefilled from the viewer's label in `roster.members` and remembered in `localStorage` key `my-leads:acquisitions-manager:<userId>` (reads/writes wrapped in try/catch; page works without storage). The no-answer follow-up section (`attempt-dialog.tsx:206-227` composition and `:445-550` markup) moves verbatim into `no-answer-follow-up.tsx`; only `no_answer` shows it, `voicemail` does not (D9: voicemail stops forcing the SMS flow).
  - After save: the existing drip picker (`StartDripPicker`, `attempt-dialog.tsx:312-321`) stays, plus receipt lines "Attempt saved · Note saved · Next step set for <date>" with a Retry button for whichever extra failed.
- Change, data flow. The attempt command is untouched (`submitMyLeadCommand("log-attempt", …)`, `actions.ts:316-476`, idempotency/recovery machinery in `use-attempt-workflow.ts`). Extras ride beside it:
  - `AcquisitionAttemptFormPayload` (`_components/types.ts:300-312`) gains `postCall?: { submissionId: string; note: string | null; nextStep: { pick: "tomorrow" | "three_days" | "next_week" | "custom"; dueAt: string } | null }` (`submissionId` = a UUID minted when the prompt opens).
  - `useAttemptWorkflow.submit` (`use-attempt-workflow.ts:~232`) destructures `postCall` out of the payload before building `nextInput` (so the command hash and the frozen replay pair never include it), stores it on the `Submission`, and `AttemptCommitted` gains `extras?: PostCallExtras`; the "already saved" recovery path (`:187-210`) passes the stored extras too.
  - `client.tsx` `onCommitted` (`:712-716`) additionally calls `savePostCallExtras` when `committed.extras` is present and keeps its result in per-opening state passed back to the prompt.
  - New server action in `my-leads/actions.ts`: `savePostCallExtras(input: {memberId: string; propertyId: string; submissionId: string; note: string | null; nextStep: {dueAt: string; pick: …} | null}): Promise<{ok: true; note: "saved"|"skipped"|"failed"; nextStep: "created"|"skipped"|"failed"; message?: string} | {ok: false; message: string}>`. It authorizes through `myLeadsViewer()` plus `getMyLeadsQueueRow` (the lead must be `found` in that member's queue, same single-row read every opening uses), then (1) note: `createLeadNote(propertyId, note, {idempotencyKey: submissionId})`; (2) next step: `createNextStep({kind: "appointment", mode: "phone", propertyId, contactId: row.contactId, assigneeId: memberId, dueAt, title: "Call " + row.address, idempotencyKey: submissionId, origin: "app"})`. The two parts are independent, each safe to retry (note by `lead_notes.idempotency_key`, appointment by `booking_idempotency_key`); partial success is reported, never rolled back, never blocks the saved attempt.
  - `createLeadNote(propertyId, body, opts?: {idempotencyKey?: string})` (`leads/actions.ts:2513`) inserts `idempotency_key`; on unique violation `23505` it selects and returns the existing id. **Readiness (`lead_note_idempotency`):** when `schemaReady('lead_note_idempotency')` is false the existing insert (no `idempotency_key` column) runs unchanged, and `savePostCallExtras` skips the idempotent-note path (`note: "skipped"`) instead of failing; the changed reads (`fn_get_acquisition_call_references` new fields, `my_leads_detail_rows` `note`) are tolerated as absent (`post_call_support`).
  - `loadMyLeadCallReferences` (`actions.ts:874-915`) maps the three new reference fields into each option (`AcquisitionCallReferenceOption` in `_components/types.ts` gains `callOutcome`, `talkSeconds`, `provider`, all nullable); the existing label (date/time) is unchanged.
  - Detail panel: the attempts list shows `note` (`MyLeadAttempt` gains `note?: string | null`, mapped in `adapter.ts:73`); `detail-panel.tsx` renders it under the outcome line.
- Side effects checked: the attempt RPC is unchanged apart from the outcome lists, so first-call clock, stage change to `contacted`, attempt dedupe and rep SMS obligations behave as today; creating the phone appointment does not set `booked_appointment` or pause the drip (default `applyBookingEffects=false`), so the drip picker after save still works (`src/lib/leads/outreach-dispo.ts:59` blocks drips only when the dispo is `booked_appointment`); `createNextStep` revalidates `/my-leads`, `/leads/<id>`, `/dashboard`, `/calendar`.
- Tests: against the preceding schema (no `lead_notes.idempotency_key`, old reference and detail functions) the prompt and `createLeadNote` take the legacy path without throwing; RTL `post-call-prompt.test.tsx` (flag off renders the old dialog, flag on renders the prompt; outcome prefill from a call reference, voicemail hides the SMS section, no-answer requires the follow-up fields as before, recording link required only for manual DialPad, linked call hides the occurred-at field, quick picks set the due date, nothing blocks save with only an outcome, drip picker appears after save, extras retry button); `quick-picks.test.ts` (Tomorrow/3 days/Next week across the 2026-11-01 fall-back and 2027-03-14 spring-forward boundaries, never lands on a non-existent local time); `use-attempt-workflow.test.tsx` (extras never reach `submitMyLeadCommand`, extras survive an "already saved" recovery, a retried submit does not run extras twice); `actions.test.ts` (`savePostCallExtras`: unauthorized lead, note-only, pick-only, both, note failure still creates the step, duplicate submissionId returns existing ids); `createLeadNote` idempotency test; existing `dialogs.test.tsx` cases ported to the new component (no-answer follow-up, reconciliation lock, recovery message).
- Rollback: turn `post_call_prompt` off (the old dialog is still in the tree until p1a-retire); the SQL additions are inert without the UI. Revert the PR for the code layer.

### Acceptance (P1c)
- `npm run typecheck && npm run lint && npm run test && npm run test:rtl`; `npm run test:integration:local`.
- Local acceptance: `npx playwright test --config playwright.my-leads-local.config.ts e2e/my-leads.local.spec.ts` extended with: open the prompt for a lead, choose Voicemail + a note + "3 days", save; assert the attempt (outcome `voicemail`, no SMS obligation), a `lead_notes` row, and an open phone appointment in My Leads, the lead page and the calendar; repeat with No answer and confirm the follow-up text section still appears and is required.
- Preview: the training lead path is unaffected (`assertNotTrainingTarget` in `createNextStep` blocks it); screenshot the prompt on desktop and phone widths.

### Risks and open questions (P1c)
- Auto-open on hangup is Phase 2; here the prompt opens manually exactly where the log dialog opens today (`client.tsx:1197`, `dialpad-panel.tsx` `onLogOutcome`).
- `my_leads_reconcile_call` still maps a Sandra softphone `voicemail` call to `no_answer`; the prompt's explicit choice wins whenever Jarrad finalizes, but an unfinalized softphone attempt is reconciled as `no_answer` (and then triggers no SMS only because the obligation is created in the RPC wrapper, not the reconcile). Leave, or map to `voicemail` [JARRAD]?
- "Next week" = +7 days and 10:00 Central are my defaults (see Inputs).

---

## Sub-PR P1c-2 — Seller morning-of reminder job (decision D9 second half)

### Work items (ordered; each independently committable)

#### 1c.4 Outbox, scheduling and claim functions
- Files: create `supabase/migrations/20261005170000_seller_appointment_reminders.sql`, rollback twin, `…seller_appointment_reminders.integration.test.ts`.
- Change:
```sql
begin;
create table public.seller_reminder_settings (
  org_id uuid primary key references public.organizations(id) on delete cascade,
  enabled boolean not null default false,
  send_hour_central smallint not null default 9 check (send_hour_central between 8 and 11),
  updated_at timestamptz not null default now());
create table public.seller_appointment_reminders (
  id uuid primary key default extensions.gen_random_uuid(),
  org_id uuid not null,
  task_id uuid not null,
  calendar_chain_id uuid not null,
  property_id uuid not null,
  contact_id uuid,
  due_at timestamptz not null,                      -- snapshot; any change cancels this row
  send_at timestamptz not null,
  send_local_date date not null,                    -- America/Chicago date of the appointment
  status text not null default 'pending'
    check (status in ('pending','claimed','sent','skipped','cancelled','failed','uncertain')),
  -- pending: waiting or re-queued after a retryable failure; claimed: leased; sent/skipped/cancelled: final;
  -- failed: final after 3 definitive provider failures; uncertain: final, delivery unknown, NEVER resent
  skip_reason text, attempts smallint not null default 0,
  send_key uuid not null default extensions.gen_random_uuid(),   -- persisted UUID v4 idempotency key for the SMS transport
  claim_token uuid, claimed_at timestamptz,
  message_id uuid references public.messages(id) on delete set null,
  sent_at timestamptz,
  created_at timestamptz not null default now(), updated_at timestamptz not null default now(),
  constraint seller_appointment_reminders_task_org_fkey
    foreign key (task_id, org_id) references public.tasks(id, org_id) on delete cascade,
  unique (task_id), unique (send_key),
  constraint seller_appointment_reminders_send_key_v4
    check (send_key::text ~ '^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$'));
-- one send per appointment (chain) per local day: a reschedule creates a new task row but not a second text
create unique index seller_appointment_reminders_one_send
  on public.seller_appointment_reminders (calendar_chain_id, send_local_date) where status in ('claimed','sent');
create index seller_appointment_reminders_due_idx on public.seller_appointment_reminders (send_at) where status in ('pending','claimed');
alter table public.seller_reminder_settings enable row level security;
alter table public.seller_appointment_reminders enable row level security;
revoke all on public.seller_reminder_settings, public.seller_appointment_reminders from public, anon, authenticated, service_role;
commit;
```
  Functions (service-only via `coalesce(auth.role(),'')='service_role'`, `security definer set search_path=''`):
  - `fn_schedule_seller_reminders(p_horizon interval default '36 hours', p_limit integer default 200) returns jsonb`: (a) insert one row per open phone appointment (`type='appointment' and mode='phone' and status='open'`, property linked, `due_at` in `(now(), now()+p_horizon]`, org has `seller_reminder_settings.enabled`, no row for the task) with `contact_id = coalesce(t.contact_id, p.homeowner_contact_id)`. Timing rule ("morning of in America/Chicago"): `local_day_open = (date_trunc('day', due_at at time zone 'America/Chicago') + interval '8 hours') at time zone 'America/Chicago'`; `target = least((date_trunc('day', due_at at time zone 'America/Chicago') + make_interval(hours => s.send_hour_central)) at time zone 'America/Chicago', due_at - interval '30 minutes')`; `target < local_day_open` → insert as `skipped`/`too_early_for_reminder`; `target < now()` → `send_at = now()` when `due_at - now() >= interval '30 minutes'`, else `skipped`/`created_too_late`; (b) cancel: pending/claimed rows whose task is no longer `open`, whose `due_at` differs from the snapshot, or whose `mode <> 'phone'` → `cancelled` with reason `task_changed`, and every pending/claimed row of an org whose `seller_reminder_settings.enabled` is false → `cancelled` with reason `reminders_disabled` (covers reschedule, cancel, complete and mode change; the reschedule successor is a new task and gets its own row on the next run). Returns counts.
  - `fn_claim_seller_reminders(p_limit integer default 1) returns table(...)`: `for update skip locked` over rows (joined to `seller_reminder_settings` with `enabled = true`, so a disabled org is never claimed) with `status='pending' and send_at <= now()` or `status='claimed' and claimed_at < now() - interval '10 minutes' and attempts < 3`; a stale claim with `attempts >= 3` is moved to `uncertain` (a send may have happened) and is never selected again; sets `status='claimed', claim_token=gen_random_uuid(), claimed_at=now(), attempts=attempts+1`; returns the row plus `send_key`, `property.state`, `property.outreach_dispo`, `contacts.do_not_contact`, `contacts.sms_opted_out`, task `title/due_at/status/mode`, contact first name.
  - `fn_finish_seller_reminder(p_id uuid, p_token uuid, p_status text, p_reason text default null, p_message_id uuid default null, p_retry_at timestamptz default null) returns boolean`: token-fenced (`where claim_token = p_token and status = 'claimed'`); `p_status in ('sent','skipped','cancelled','failed','uncertain','pending')`; `pending` + `p_retry_at` re-queues (quiet-hours deferral and **retryable** provider failures; the attempt count carries over, and the third failed attempt is finished as `failed`).
- Side effects checked: read-only against `tasks` (the sweep never touches `reminder_claimed_at`, so the existing rep reminder sweep, `fn_claim_appointment_reminders` `20260814200000:152-153`, is unchanged); the composite FK cascades with the task; table is service-only like `task_reminder_deliveries` (`20260814150000:529-534`).
- Tests (loopback): schedule inserts only open phone appointments in the horizon for enabled orgs; timing cases (10:15 appointment → 09:00; 09:20 appointment → `least` picks 08:50; 08:20 appointment → target 07:50 is before 08:00 so `too_early_for_reminder`; created at 14:00 for 14:20 → `created_too_late`; created at 08:00 for 14:20 → 09:00 target already passed only if after 09:00, else `send_at=09:00`), across a DST date; reschedule/cancel/complete/mode flip cancel the pending row and a reschedule successor gets a new one; unique-per-task and per-chain-per-day (second claim of the same chain/day cannot be `sent`); claim fencing (stale claim reclaimed after 10 minutes, stale token cannot finish); `p_limit`; anon/authenticated denied.
- Rollback: rollback file drops the three functions and two tables.

#### 1c.5 Cron route and dispatch
- Files: create `src/app/api/cron/seller-appointment-reminders/route.ts`, `handlers.ts`, `route.test.ts`, `src/lib/my-leads/seller-reminder.ts`, `src/lib/my-leads/seller-reminder.test.ts`, `src/lib/my-leads/seller-reminder-copy.ts`; modify `vercel.json` (add `{ "path": "/api/cron/seller-appointment-reminders", "schedule": "6-59/10 * * * *" }`, a minute not used by the other crons).
- Change: `route.ts` is the 3-line re-export pattern of `appointment-reminder-sweep/route.ts` (`export const maxDuration = 60; export { GET, POST } from "./handlers"`). `handlers.ts` follows `appointment-reminder-sweep/handlers.ts:300-350`: `CRON_SECRET` bearer check, `runMonitoredCron("sandra-seller-appointment-reminders", { schedule: { type: "crontab", value: "6-59/10 * * * *" }, checkinMargin: 2, maxRuntime: 1 }, …, cronResponseFailed)`, service-role client. Flow: (0) if the `seller_reminders` flag (`my_leads_feature_flags`, contract row) is off, or `schemaReady('seller_reminders')` is false, return `{ok:true, disabled:"flag_off"}`; if `SELLER_REMINDER_COPY === null` return `{ok:true, disabled:"copy_not_approved"}`; both before scheduling or claiming anything; (1) `fn_schedule_seller_reminders`; (2) budget loop (45 s, one `fn_claim_seller_reminders({p_limit:1})` per iteration, as the rep sweep does) running `dispatchSellerReminder(row)`:
  0. **Recheck the switch immediately before dispatch** (a row claimed before an operator disabled the job must not send): re-read `seller_reminder_settings.enabled` for the org and the `seller_reminders` flag at this moment; either off → finish `cancelled`/`reminders_disabled`, no send. The copy constant is re-read too (`null` → `cancelled`/`copy_not_approved`).
  1. Re-read at dispatch (never trust the claim snapshot): task still open, same `due_at`, `mode='phone'`; else finish `cancelled`/`task_changed`.
  2. Safety gates, in order: property not deleted, not `is_dnc_locked`, status not `closed|dead|dnc`; `evaluateSuppression({outreachDispo, consentState, doNotContact, smsOptedOut})` from `src/lib/messaging/suppression.ts` (NOT the automated variant, which would block `booked_appointment` by design, `suppression.ts:125-143`); `getConsentState(admin, contactId, "sms")` (`src/lib/messaging/consent.ts`): `opted_out` → `skipped`/`opted_out` (STOP re-checked at dispatch; `no_consent` is not a block, matching `send.ts:718-726`, because this is an informational message about an appointment, not marketing, `consent.ts:5-12`); `checkQuietHours(property.state)` (`src/lib/messaging/quiet-hours.ts:157-183`): `unknown_state` → `skipped`/`unknown_state`; `outside_window` → defer with `p_retry_at` = next 08:00 in the recipient zone (`getQuietHoursLocalTime(...).zone` + `wallTimeToUtc`) when that is at least 15 minutes before `due_at`, else `skipped`/`quiet_hours_missed`.
  3. Send through the existing transport so every remaining rule (provider on/off, line type, phone suppression, sender approval, STOP language handling) is reused: `sendSmsToContact(admin, { origin: "manual", contactId, propertyId, body, idempotencyKey: row.send_key, metadata: { kind: "seller_appointment_reminder", reminderId: row.id, taskId: row.task_id } })`. `origin: "manual"` is deliberate and documented in code: `origin: "automated"` re-checks `HUMAN_OWNED_DISPOS` and would always block (a booked appointment sets that dispo, `suppression.ts:100-104`), and the human did decide to send this reminder when he scheduled the call. Because it is a system send, the handler itself performs gates 1–2 first; `sendSmsToContact` repeats consent and quiet hours at send time (`send.ts:718-735`). Recipient = the appointment's contact (`tasks.contact_id`, else the property's homeowner), phone chosen by `selectBestSmsPhone`. The rep's own reminder phone is never used here.
  4. Map outcomes (the transport only accepts a UUID v4 key, `send.ts:528`; `row.send_key` is a persisted v4, and a literal such as `"seller-reminder:" + id` would be rejected as `db_error` "SMS idempotency key is invalid"): `sent` → `fn_finish_seller_reminder('sent', message_id)`; `blocked_*`, `blocked_landline`, `blocked_no_phone`, `blocked_terminal_dispo` → `skipped` with the status as reason; `blocked_quiet_hours` → defer as above; **reclaimable (retryable) failures**: `provider_failed`/`provider_deferred` (definitively not sent) → `fn_finish_seller_reminder('pending', p_retry_at := now() + attempts * interval '5 minutes')` so the claim query selects it again, and after the third attempt `failed` (terminal); **uncertain terminal**: `provider_unknown`/`db_error` after the provider may have accepted (a message id exists or the error followed the provider call) → `uncertain` with reason `unknown_delivery` and NO resend (`failed` is never reclaimed, `uncertain` is never reclaimed; the stable `send_key` makes a manual replay by an operator safe).
  `seller-reminder-copy.ts`: `export const SELLER_REMINDER_COPY: string | null = null;` with a comment that the exact text must be supplied verbatim by Jarrad; `seller-reminder.ts` exports `buildSellerReminderBody(copy: string, vars: {firstName: string | null; localTime: string}): string` (plain token replacement for `{first_name}`/`{time}`, 320 character cap, rejects an unknown token) and the pure `decideReminder(inputs)` gate used by the handler so the matrix is unit-testable. Enabling the org is a data change (`insert into seller_reminder_settings (org_id, enabled) values (:org, true)`) done by the operator after the copy is approved; not part of the PR.
- Side effects checked: new cron slot only; `appointment-reminder-sweep` (rep texts) is not edited; no change to `messages` schema (the `metadata.kind` tag lets Messages show the text as a reminder later); the outbound text is visible in the lead's SMS history and counts as an outbound touch for the strip; AI responder and sequences pause behavior unaffected (a reminder is not a drip step).
- Tests (`route.test.ts`, `seller-reminder.test.ts`, mocked service client and mocked `sendSmsToContact`, `E2E_QUIET_HOURS_NOW` for time, `quiet-hours.ts:108-114`): auth (missing/incorrect bearer, missing secret); copy null → no claims; gate matrix (opted out via `consent_events`, contact `do_not_contact`, `sms_opted_out`, DNC-locked property, closed/dead, quiet hours before 08:00 and from 21:00 local, unknown state, task rescheduled between claim and dispatch, mode flipped to in person); quiet-hours deferral computes the next 08:00 and skips when too close to the appointment; send args (origin `manual`, the persisted `send_key`, metadata); **transport-boundary test:** call the real `sendSmsToContact` with a mocked provider and assert `send_key` passes the UUID-v4 validation while a `"seller-reminder:"`-prefixed key returns `db_error` "SMS idempotency key is invalid"; **disable after claim:** claim a row, set `seller_reminder_settings.enabled=false` (and separately the flag off), run dispatch, assert no `sendSmsToContact` call and the row `cancelled`/`reminders_disabled`; outcome mapping table: `provider_failed` re-queues as `pending` and is claimed again, third failure → `failed`, `provider_unknown` → `uncertain` and not retried, a stale claim at 3 attempts → `uncertain`; recipient fallback to the homeowner contact; both recipients: a test asserts the seller job never sends to `user_integration_prefs.reminder_phone` and the rep sweep's own `route.test.ts` is untouched and green; budget exhaustion leaves unclaimed rows for the next run.
- Rollback: revert files and the `vercel.json` entry; SQL rollback drops outbox objects. With `enabled=false` and null copy the job already does nothing.

### Acceptance (P1c-2)
- `npm run typecheck && npm run lint && npm run test`; `npm run test:integration:local`; `node --test` is not needed.
- Production: merge is inert (disabled, null copy). To go live (operator, after Jarrad supplies the exact text): ship the copy constant in a one-line PR, then `insert into public.seller_reminder_settings (org_id, enabled) values (:org, true)`; first run: `select status, skip_reason, count(*) from public.seller_appointment_reminders group by 1,2;` and one seller text to an owner-controlled number before any real lead is scheduled.

### Risks and open questions (P1c-2)
- [JARRAD] Exact reminder wording and `send_hour_central` (default 9). No LLM may author it.
- Informational-vs-marketing: the job treats `no_consent` as sendable (as `send.ts` does) because Jarrad stated consent is on record (record, "TCPA for reminder texts"); STOP is always honored.
- `origin: "manual"` is a semantic stretch; the alternative is a new `origin: "appointment_reminder"` value touching `send.ts` internals (queue release, `resolveQueuedSendOrigin`, `send.ts:2405`). Not done to keep this PR out of `send.ts`.

---

## Sub-PR P1d — Hangup link capture (decision D5, 1d)

### Work items (ordered; each independently committable)

#### 1d.1 Columns, guard, projection, backfill
- Files: create `supabase/migrations/20261005180000_dialpad_hangup_link_capture.sql`, rollback twin, `…dialpad_hangup_link_capture.integration.test.ts`.
- Change:
  1. Columns and constraints:
```sql
alter table public.call_activities
  add column provider_recording_url text,
  add column provider_voicemail_url text,
  add column provider_voicemail_transcript text;
alter table public.call_activities add constraint call_activities_provider_links_check check (
  (provider_recording_url is null or (length(provider_recording_url) <= 4096 and provider_recording_url ~* '^https?://[^[:space:]@/]+(/[^[:space:]]*)?$'))
  and (provider_voicemail_url is null or (length(provider_voicemail_url) <= 4096 and provider_voicemail_url ~* '^https?://[^[:space:]@/]+(/[^[:space:]]*)?$'))
  and (provider_voicemail_transcript is null or length(provider_voicemail_transcript) <= 20000));
```
  2. Browser write guard: `my_leads_guard_call_metrics()` (live body `20260927023443_dialpad_cti_kpi_seller_speech.sql:19-37`; the older definition is `20260913100000_my_leads_metrics.sql:88-101`, trigger `acquisition_call_metrics_guard` `:102`; copy the live body, never the old one, or the seller-speech change reverts) is the existing "telemetry is not an editable claim" guard (call_activities has default table privileges plus RLS update, `058_dialer_and_call_activity.sql:160-167`, so the new columns would otherwise be browser-writable). `create or replace` the live body with the three columns added to both the INSERT and UPDATE disjuncts.
  3. Projection: `dialpad_cti_project_intent(p_intent_id uuid)` is the live body from `20260930036000_dialpad_training_projection.sql:12-180` with these diffs only. Declare `v_share text; v_admin text; v_vm_link text; v_vm_text text;`. After the final-hangup `h` statement (`:68-89`) and inside the same function, add a second statement reading the last-ending hangup per leg and taking, per field, the first non-null by `ended_ms desc` (so a multi-leg or transferred call uses the link from the leg that ended last and has one):
```sql
select (array_agg(l.share_link order by l.ended_ms desc nulls last) filter (where l.share_link is not null))[1],
       (array_agg(l.admin_url  order by l.ended_ms desc nulls last) filter (where l.admin_url  is not null))[1],
       (array_agg(l.vm_link    order by l.ended_ms desc nulls last) filter (where l.vm_link    is not null))[1],
       (array_agg(l.vm_text    order by l.ended_ms desc nulls last) filter (where l.vm_text    is not null))[1]
  into v_share, v_admin, v_vm_link, v_vm_text
from (select distinct on (e.provider_call_id)
        coalesce(public.dialpad_cti_payload_ms(e.payload, 'date_ended'), e.event_timestamp_ms) as ended_ms,
        nullif(btrim(e.payload ->> 'public_call_review_share_link'), '') as share_link,
        nullif(btrim(e.payload -> 'admin_recording_urls' ->> 0), '') as admin_url,
        nullif(btrim(e.payload ->> 'voicemail_link'), '') as vm_link,
        nullif(btrim(e.payload ->> 'transcription_text'), '') as vm_text
      from public.dialpad_call_events e
      where e.org_id = v_intent.org_id and e.matched_intent_id = v_intent.id
        and e.disposition = 'matched' and e.event_state = 'hangup'
      order by e.provider_call_id, e.event_timestamp_ms desc, e.id) l;
```
     then normalize: keep a URL only if it matches the same regex as the CHECK and length ≤ 4096 (else null); keep `v_vm_link`/`v_vm_text` only when `v_voicemail or v_vm_link is not null` (a connected call's `transcription_text`, if Dialpad ever sends one, is not a voicemail transcript; D5 says voicemail only), truncate the text to 20000; if `not v_ended` or `v_property.is_training` set all four to null (training keeps no recording URLs or transcripts, `20260930036000:182-183`). The `call_activities` upsert (`:100-119`) adds the three columns to the insert list and `provider_recording_url = coalesce(public.call_activities.provider_recording_url, excluded.provider_recording_url)` (same for the two voicemail columns) to `do update set`, so a value, once captured, is never replaced by a later or null event (replay-safe, monotonic). After the attempt block (`:122-170`, non-training only): `update public.acquisition_attempts set recording_url = v_share where org_id = v_intent.org_id and source = 'dialpad' and provider_attempt_key = v_key and recording_url is null and v_share is not null;` so a link the rep already pasted is never overwritten and a manually finalized link wins (finalize uses `coalesce(input link, existing)`, `20260929120000:487-488`). `RECORDING_REQUIRED` is untouched (D5): it lives in the manual wrapper (`20260917193000:174`) that the projection never calls.
  4. Backfill (operator step, not run by the merge; no separate audit table): `fn_my_leads_housekeeping_link_backfill(p_org uuid, p_apply boolean default false, p_expected_fingerprint text default null) returns jsonb` (service-only, shared apply contract 1e.1, run kind `link_backfill`, a subcommand `link-backfill` of `scripts/my-leads-housekeeping.mjs`; before- and after-images go to `my_leads_housekeeping_before_images`; every intent, event, attempt and activity read or write filters `org_id = p_org`; fingerprint over `[{intent_id, attempt_id, attempt.recording_url, activity_id, activity.provider_*}]` ordered by intent id): for each matched intent of the org that has a hangup event, take `pg_advisory_xact_lock(hashtextextended('dialpad-chain:' || org::text || ':' || public.dialpad_cti_chain_root(provider_call_id, payload), 0))` (the lock `fn_process_dialpad_call_event` takes, `20260929120000:365`, which `dialpad_cti_project_intent` requires its caller to hold), before-image the attempt's `recording_url` and the call activity's three `provider_*` columns, then `perform public.dialpad_cti_project_intent(intent_id)`. Preview returns the count of intents with a hangup and no captured link. The 5 stored production calls are the expected input. This migration copy-replaces `fn_my_leads_housekeeping_rollback` to add a `link_backfill` branch (restores the before-imaged values).
- Side effects checked: KPI `missingRecordings` (`20260930031000:913`) stops flagging a Dialpad attempt once `acquisition_attempts.recording_url` is non-empty; `recording_library_rows`/owner recording audit read the same column (`20260917193000` header comment), so captured links appear there; the recording-capture ledger (`dialpad_recording_*`) is not touched; `my_leads_guard_call_metrics` is non-definer and keyed on `current_user`, so the definer projection and `service_role` still write; the call transcript and AI Recap are NOT fetched here (they come later through the Phase 3 job, D5).
- Preview/rollback (backfill): preview `select count(distinct e.matched_intent_id) from public.dialpad_call_events e where e.disposition='matched' and e.event_state='hangup' and e.payload ? 'public_call_review_share_link';`. Rollback: `select public.fn_my_leads_housekeeping_rollback(:run)` restores a before-imaged `recording_url` or `provider_*` value only if the column still equals its after-image (a link a rep pasted or finalized since is preserved; others are listed in `summary.notRestored`) (the rollback file also ships a plain `update public.call_activities set provider_recording_url = null, provider_voicemail_url = null, provider_voicemail_transcript = null where provider = 'dialpad';` and drops the columns and the guard change for the schema rollback).
- Tests (local integration; extend the fixtures of `20260929120000_dialpad_cti_call_projection.integration.test.ts` with payload shapes copied from the 5 stored production events, secrets/PII scrubbed): hangup with `public_call_review_share_link` and `admin_recording_urls[0]` sets `acquisition_attempts.recording_url` and `call_activities.provider_recording_url`; replaying the same events is a no-op; a later hangup with a different link does not overwrite; a link already pasted by the rep is preserved; a voicemail call stores `voicemail_link` and transcript, a connected call with a stray `transcription_text` stores no voicemail transcript; multi-leg call takes the link from the last-ending leg that has one; an `is_training` lead stores nothing and still creates no attempt; a URL with userinfo or a non-http scheme stores null; `authenticated` update of any `provider_*` column fails with `PROVIDER_EVIDENCE_READ_ONLY`; `missingRecordings` KPI falls after capture; backfill preview writes nothing, apply fills the 5-row fixture with a `link_backfill` run row and before-images, rollback restores; replaying the whole projection leaves first-call clock and queue state unchanged (existing assertions).
- Rollback: rollback file restores the prior projection body (`20260930036000:12-180`) and the prior guard body (`20260927023443:19-37`), restores the previous `fn_my_leads_housekeeping_rollback`, drops the columns, constraint and the backfill function.

### Acceptance (P1d)
- `npm run typecheck && npm run lint && npm run test && npm run test:integration:local`; `npm run verify:migration-safety-unit`.
- Production: delivers value only after Phase 2 re-enables the connection (the projection has no events today, per the record). After merge run the backfill preview; applying the backfill to the 5 stored calls is optional and needs Jarrad's okay.

### Risks and open questions (P1d)
- Recording URLs may expire or need auth (Phase 0 spike item 1); storing them is harmless, using them is Phase 2/3.
- `public_call_review_share_link` is documented only on `call_transcription` events but present on all five production hangups (record, "Production disagrees and wins"); if Dialpad stops sending it the columns simply stay null.

---

## Phase 1 end-to-end acceptance (after P1b, P1c, P1c-2, P1d are merged; items 5 and 6 are re-run once P1a-retire has merged last)
1. Preview deploy against the test project. Seed (or use the isolated synthetic lead, not `is_training`): leads with an overdue appointment, an inbound text, a hot lead untouched 4 days, a needs-offer lead, a lead with no phone, a DNC-contact lead.
2. `/my-leads`: strip shows ≤10 rows in tier order with plain-English reasons; excluded leads are flagged, not listed; Call today pins, Not today hides until midnight Central, Dead/Nurture opens the existing handoff dialog; sections, KPI tiles and timers are unchanged.
3. Open the prompt for a lead: outcome prefilled when a call is known; save "Voicemail" + note + "Next week" → attempt with outcome `voicemail` and no SMS obligation, a note, one phone appointment visible identically in My Leads, the lead page, the dashboard and the calendar; the lead leaves tier 5 and the strip reason changes.
4. Log an offer: an "Offer follow-up" phone appointment exists, `follow_up_at` equals its due; reschedule it from the calendar → `follow_up_at` follows; cancelling it while the offer is pending is refused; recording the offer outcome closes it.
5. Create a next step from the lead widget, the board quick action and the dialer wrap-up; `select type, mode, count(*) from public.tasks where created_at > :deploy group by 1,2` shows only `appointment`/`custom`, and inserting a `callback` by SQL raises `TASK_TYPE_RETIRED`.
6. KPI tiles before and after the relabel agree on historical periods (the printed snapshot from P1a-retire).
7. Hangup (replay a stored hangup event on the test project): attempt `recording_url` and `call_activities.provider_recording_url` populate.
8. Seller reminder (still disabled): with a test org set `enabled=true` and null copy: `select * from public.fn_schedule_seller_reminders()` schedules rows for phone appointments, the cron returns `copy_not_approved`, and nothing is sent (while an org is disabled the schedule function inserts nothing, so this check needs the enabled test org).

## Phase 1 risks and open questions (consolidated, in priority order)
- [JARRAD] Every default listed under "Inputs needed before start". The ones that change visible behavior: 15-minute dialer callbacks, 10:00 quick-pick time, Next week = +7 days, eligible=false on reassigned episodes, offer follow-up auto-close outcome (`cancelled` vs `held`), KPI "appointments kept" now counting every phone next step.
- Production data changes in this phase, each previewed and reversible: reassign 15 leads and their open tasks (1e.2), close 137 attempts (1e.3), relabel open future callbacks/follow-ups (1a.5), offer follow-up backfill (1a.6), optional link backfill (1d.1). None runs from a migration; all run from `scripts/my-leads-housekeeping.mjs` or the named function after the pasted preview is approved. Existing leads are protected (AGENTS.md).
- The migration pipeline applies every merged migration to prod automatically (`db-migrate-test.yml` → `db-migrate-prod.yml`); each migration here is additive or a definer-function replace, with a rollback twin; the only table rewrite is the stored generated column in 1a.1 (size check first).
- Retiring `follow_up`/`callback` is the one change that can break a stale client; it merges last and only after P1a-writers has been live.
- The no-snooze rule removes the Snooze UI everywhere (lead page next-action card, dashboard task row); a rep who relied on it must reschedule instead (appointments) or complete (tasks).
- Slack "Mark done" on old task-assigned messages cannot complete a relabeled appointment (already true for appointments).
- Dialpad `custom_data`/native-call matching, auto-open of the prompt on hangup, click-to-dial through the API, callback alert, the transcript/AI Recap fetch job and `RECORDING_REQUIRED` exemptions are Phase 2/3 and are intentionally absent; the strip's Call button reuses today's `start-call` entry.


---

## Phase 2: Dialing and matching

**Goal.** Click-to-dial through the Dialpad API, exact-number matching of calls Jarrad dials natively, a durable post-call prompt, a callback-due alert and a hangup-triggered transcript/Recap fetch, with the Dialpad connection enabled last.
**Depends on.** Phase 1 through p1d (branch `claude/my-leads-p1d-link-capture`; p1a-retire merges later, last); Phase 0 findings note (decision doc "Phase 0 exit").
**Branch / PR.** Three stacked PRs: `claude/my-leads-p2-data-plane` (2.1–2.5, 2.9) based on `claude/my-leads-p1d-link-capture`, `claude/my-leads-p2-ui` (2.6–2.8, 2.10, 2.11) based on `claude/my-leads-p2-data-plane`, and `claude/my-leads-p2-acceptance` (the Phase 2 acceptance slice of Phase 4: the Dialpad fixture and stub-dial support, spec cases T0 (Phase 2 part), T3, T7 and T8, the phase-gated monitoring kit; no migration, no `src/` change) based on `claude/my-leads-p2-ui`. **The acceptance slice must merge before Phase 2's release step**, because the Phase 2 activation gate requires T8 green at the released SHA (4.0). PR titles: `My Leads Phase 2a: shared ledger key, intent timeout, phone table, native-call matching, artifact fetch (connection stays disabled)` and `My Leads Phase 2b: Dialpad API dial, durable post-call prompt, callback alert, redaction (connection stays disabled)`. Bodies state `Depends on: #<parent PR>`.
Worktree for all writes: `_claude_worktrees/my-leads-p2` (never the main checkout). Activation (2.11) is an operational step after merge, not part of the PR diff.

**Inputs needed before start.**
- Phase 0 outputs (each has a default if absent; the builder records which default it used in the PR body):
  - Which dial endpoint won: `initiate_call` or `POST /api/v2/call`. Default `initiate_call`.
  - How `custom_data` comes back on events for API-placed calls: bare string or `{"open_cti": "<token>"}`. Default: both, because `dialpad_cti_custom_data` already accepts exactly those two shapes (`20260929200000_dialpad_cti_custom_data.sql:29-44`). If Phase 0 shows any third shape, extend that function and add the captured payload as a fixture.
  - Whether natively dialed calls (desktop and mobile) fire events, and their `direction`, `external_number` (E.164 with `+1`?), `target.type`/`target.id`, and whether a `hangup` always follows `missed`. Default: same envelope as the five stored production calls (`+1` E.164, `target.type='user'`); `hangup` follows `missed`.
  - The exact AI Recap path, scope and rate limit, and the `GET /api/v2/transcripts/{call_id}` response field names. No default: the builder must not guess. Until Phase 0 supplies a captured sample, `artifact-fetch.ts` ships with the fetcher stubbed (returns `not_ready`) and the 2.10 parser tests marked `todo`.
  - Which stored key works and with which scopes. Default: the `Dialpad - API` key already mirrored into `DIALPAD_CTI_DIRECTORY_KEY_BMH` (`provisioning.ts:149`), used for dialing too, no new env var.
  - Subscription state after the 401 period (`GET /api/v2/subscriptions/call`).
  - REST `group_type` values for caller identities. Default map: `Office→office`, `OfficeGroup→department`, `CallCenter→callcenter` (confirm in the Dialpad reference; one table in `api-dial.ts`).
- Phase 1 merged, providing: `tasks.next_step_kind`, `tasks.mode`, `call_activities.provider_recording_url` / `provider_voicemail_url` / `provider_voicemail_transcript`, outcome `'voicemail'`, `post-call-prompt.tsx`, `_components/call-next-strip.tsx`. Phase 2 migrations sort after Phase 1's newest file; rename the `20261006…` stamps if needed.
- Read-only production checks (Supabase MCP or Management API, no writes), pasted into the PR body:
  - `select id,status,dialpad_company_id,directory_api_key_ref,recording_ingest_endpoint from public.dialpad_org_connections where org_id='00000000-0000-0000-0000-000000000bbb'`
  - `select dialpad_user_id,status,verification_kind from public.dialpad_member_bindings where org_id='00000000-0000-0000-0000-000000000bbb' and status<>'revoked'`
  - `select episode_kind,eligible,count(*) from public.acquisition_assignment_episodes where ended_at is null and assignee_user_id='<Jarrad id>' group by 1,2`. Dial authorization requires `eligible` (`20260929180000_dialpad_cti_dispatch.sql:159`); the 15 reassigned leads carry `eligible=false`, so 2.7 removes that requirement from both dial functions (contract row "Dial eligibility"); open episode and assignee are still required.
- [JARRAD] decisions, with defaults assumed:
  1. Approved: personal-call payloads captured once the connection is active (2.10) are redacted after 30 days.
  2. Outbound native call to a DNC number: ⭐ quarantine as `dnc_number`, no attempt, no prompt (never turns a DNC call into a touch). Alternative: log it as a flagged attempt. Default is the ⭐.
  3. The 5-minute-conversation KPI for Dialpad calls (see Risks). Default: leave unchanged, raise it.

**Affected files (for the release lease).** Every migration below also ships its rollback twin `supabase/rollbacks/<same timestamp>_<name>.sql` with the stated inverse, and a step in `.github/workflows/e2e.yml` for each new `*.integration.test.ts` (copying the `:201-207` steps).
New:
- `supabase/migrations/20261006100000_dialpad_ledger_keys_native_columns.sql` (+ `.integration.test.ts`)
- `supabase/migrations/20261006100100_dialpad_intent_timeout.sql` (+ test)
- `supabase/migrations/20261006100200_contact_phone_numbers.sql` (+ test)
- `supabase/migrations/20261006100300_dialpad_native_matching.sql` (+ test)
- `supabase/migrations/20261006100400_dialpad_native_assign_to_lead.sql` (+ test)
- `supabase/migrations/20261006100500_dialpad_artifact_fetches.sql` (+ test) (2.9, p2-data-plane)
- `supabase/migrations/20261006100600_call_prompt_acknowledgement.sql` (+ test) (2.6, p2-ui)
- `supabase/migrations/20261006100700_dialpad_api_dial_support.sql` (+ test) (2.7, p2-ui)
- `supabase/migrations/20261006100800_dialpad_unmatched_event_redaction.sql` (+ test)
- `supabase/migrations/20261006100900_my_leads_callbacks_due.sql` (+ test)
- `src/lib/dialpad-cti/api-dial.ts`, `api-dial.test.ts`
- `src/lib/dialpad-cti/artifact-fetch.ts`, `artifact-fetch.test.ts`
- `src/lib/dialpad-cti/fixtures/*.json` (sanitized Phase 0 captures)
- `src/lib/testing/dialpad-cti-fixtures.ts`
- `src/app/api/cron/dialpad-artifact-sweep/route.ts`
- `src/app/(dashboard)/my-leads/call-state-actions.ts` (+ test)
- `src/app/(dashboard)/my-leads/_components/dial-status.tsx`, `use-call-state-poll.ts`, `unassigned-calls-strip.tsx`, `callback-due-banner.tsx` (+ tests)
- `src/app/(dashboard)/my-leads/client-call-state.test.tsx` (replaces `client-dialpad.test.tsx`)

Modified:
- `src/lib/dialpad-cti/dispatch.ts` (+ `dispatch.test.ts`), `contracts.ts` (+ test), `directory.ts` (+ test), `event-processing.ts` (+ tests), `provisioning.ts`, `provisioning-adapters.ts`, `provisioning.test.ts`, `provisioning-adapters.test.ts`, `routes.test.ts`
- `scripts/provision-dialpad-cti.ts`
- `src/app/api/cron/dialpad-call-events-sweep/route.ts`
- `vercel.json` (one cron entry)
- `src/app/(dashboard)/my-leads/dialpad-actions.ts` (+ test), `page.tsx` (+ `page.test.tsx`), `client.tsx` (+ `client.test.tsx`)
- `src/lib/supabase/types.ts` (hand-add Args/Returns entries beside `fn_authorize_dialpad_dispatch`, `types.ts:6009`)
- `vitest.integration.config.ts` (add every new integration file to `exclude`, same list as lines 31-44 of that file) and `vitest.local-integration.config.ts` (add to `include`)

Deleted:
- `src/app/(dashboard)/my-leads/_components/dialpad-panel.tsx`, `dialpad-panel.test.tsx`, `dialpad-recording-actions.ts`, `dialpad-recording-actions.test.ts`, `client-dialpad.test.tsx`

Conflict watch with Phase 1 (rebase carefully): `client.tsx`, `page.tsx`, `dialpad_cti_project_intent` (Phase 1d edits the hangup branch), `fn_finalize_acquisition_attempt_without_sms_obligation` (Phase 1 adds `voicemail`). Phase 2 never copies those function bodies; it patches live definitions by anchored text replacement (2.1), the same technique as `20260929220000_dialpad_recording_transport_contract.sql:460-480`.

---

### Work items (ordered; each independently committable)

#### 2.1 Shared ledger-key helpers, intent columns, and replacement of every `dialpad-cti:` site (N7)
- Files: create `20261006100000_dialpad_ledger_keys_native_columns.sql` + `.integration.test.ts`; add `src/lib/testing/dialpad-cti-fixtures.ts`.
- Change.
  - Columns on `public.dialpad_call_intents`: `origin text not null default 'sandra' check (origin in ('sandra','native'))`, `direction text not null default 'outbound' check (direction in ('outbound','inbound'))`. The guard trigger compares `to_jsonb(new) - v_mutable` to the old row (`20260929180000_dialpad_cti_dispatch.sql:65`), so both new columns are immutable after insert without touching the trigger.
  - Helpers (pure; `grant execute` to `authenticated, service_role`, revoke from `public, anon`, because they are used in an index predicate and a CHECK):
    ```sql
    create or replace function public.dialpad_cti_is_ledger_key(p_key text) returns boolean
      language sql immutable parallel safe set search_path = ''
      as $$ select p_key like 'dialpad-cti:%' or p_key like 'dialpad-native:%' $$;
    create or replace function public.dialpad_cti_intent_key(p_origin text, p_intent_id uuid, p_provider_call_id text) returns text
      language sql immutable set search_path = ''
      as $$ select case when p_origin = 'native' then 'dialpad-native:' || p_provider_call_id
                        else 'dialpad-cti:' || p_intent_id::text end $$;
    ```
  - Site accounting. The decision doc says 14 sites; the code has 18 literal occurrences across 7 migrations. 12 are live, 6 are superseded or dead. Replacement per live site (all done in this one migration):

    | Live site (file:line) | What it is | Replacement |
    |---|---|---|
    | `20260929120000_dialpad_cti_call_projection.sql:85` | unique index `idx_call_activities_org_dialpad_cti_attempt` | create `idx_call_activities_org_dialpad_ledger_attempt` on `(org_id, jitter_attempt_id)` where `provider='dialpad' and public.dialpad_cti_is_ledger_key(jitter_attempt_id)`, then drop the old index (new first, so uniqueness is never unenforced) |
    | `:88` | unique index `idx_call_activities_org_dialpad_cti_call` | create `idx_call_activities_org_dialpad_ledger_call` on `(org_id, provider_call_id)` with the same predicate plus `provider_call_id is not null`, then drop old |
    | `:95` | check `acquisition_attempts_pending_outcome_check` | drop and re-add `NOT VALID` as `source='sandra' or outcome is not null or (source='dialpad' and coalesce(public.dialpad_cti_is_ledger_key(provider_attempt_key), false))`, then `VALIDATE CONSTRAINT` |
    | `:512` | `fn_get_acquisition_call_references` (live; no later redefinition) | anchored patch |
    | `20261003130000_my_leads_conflicts_non_retryable.sql:1158` | live `fn_finalize_acquisition_attempt_without_sms_obligation` (supersedes `…projection.sql:480`) | anchored patch |
    | `20260929210000_dialpad_recording_foundation.sql:435` | `fn_open_dialpad_recording_capture` (live) | anchored patch |
    | `20260930031000_dialpad_recording_provider_window_finalizer.sql:809,811` | live `fn_get_dialpad_call_status` (supersedes `…dispatch.sql:239,241`) | two anchored patches |
    | `20260930036000_dialpad_training_projection.sql:48` | live `dialpad_cti_project_intent` key | anchored patch |
    | `:113` | same function, `on conflict … where … like 'dialpad-cti:%'` | anchored patch (must textually equal the new index predicate so inference works) |
    | `20260930037000_dialpad_training_playback.sql:67` | `fn_dialpad_recording_library_sources` | anchored patch |
    | `:142` | `fn_dialpad_recording_playback_file` | anchored patch |

    Superseded or dead, no action: `…projection.sql:212,275,480`, `…dispatch.sql:239,241`, `…training_projection.sql:210` (one-shot canary correction block).
  - Anchored patches use the precedent technique: `DO` block, `pg_get_functiondef(oid)`, `position(anchor in def) > 0` assert, `replace`, assert the result differs, `execute`. Make each patch idempotent (skip if the new text is already present and the anchor is absent). Anchors, verbatim from the live bodies:
    - references and finalize: `and (source='sandra' or (source='dialpad' and provider_attempt_key like 'dialpad-cti:%'))` → `and (source='sandra' or (source='dialpad' and public.dialpad_cti_is_ledger_key(provider_attempt_key)))`
    - capture: `v_activity.jitter_attempt_id <> 'dialpad-cti:' || v_intent.id::text` → `v_activity.jitter_attempt_id <> public.dialpad_cti_intent_key(v_intent.origin, v_intent.id, v_intent.matched_provider_call_id)`
    - status: `jitter_attempt_id = 'dialpad-cti:' || v_intent.id::text` and `provider_attempt_key = 'dialpad-cti:' || v_intent.id::text` → `= public.dialpad_cti_intent_key(v_intent.origin, v_intent.id, v_intent.matched_provider_call_id)`
    - project: `v_key := 'dialpad-cti:' || v_intent.id::text;` → `v_key := public.dialpad_cti_intent_key(v_intent.origin, v_intent.id, v_intent.matched_provider_call_id);`; `on conflict (org_id, jitter_attempt_id) where provider = 'dialpad' and jitter_attempt_id like 'dialpad-cti:%'` → `… where provider = 'dialpad' and public.dialpad_cti_is_ledger_key(jitter_attempt_id)`
    - playback (both functions): `c.jitter_attempt_id='dialpad-cti:'||i.id::text` → `c.jitter_attempt_id=public.dialpad_cti_intent_key(i.origin,i.id,i.matched_provider_call_id)`
  - Capture and playback functions only ever see Sandra-origin intents (browser capture is deleted in 2.7, and native intents never get a capture row); they are patched so the "no literal outside the helpers" regression test is a clean invariant.
- Side effects checked.
  - Index swap holds a brief lock on `call_activities`; the table is small and the swap is create-then-drop. `VALIDATE` scans `acquisition_attempts` once.
  - The new predicates are supersets of the old, so rollback of code leaves old rows valid.
  - `acquisition_attempts_provider_key_idx` (`20260912090200_acquisition_attempt_offer_facts.sql:58`, unique `(org_id, source, provider_attempt_key)`) is key-agnostic and already enforces one attempt per `dialpad-native:<call_id>`.
  - The 120000-era `finalize` and `references` bodies remain superseded; nothing else defines them (`grep` of all migrations).
  - `rep_sms_no_answer_attempt` trigger (`20260917110000_rep_sms_obligation_read_models.sql:23`) fires only when the rep's finalize sets `no_answer`; the projection never sets an attempt outcome (`…training_projection.sql:122-134` inserts with no `outcome`), and native attempts follow the same rule, so no SMS obligation is created by telemetry.
- Tests (`…ledger_keys_native_columns.integration.test.ts`, local-only harness: loopback `pg` client, `service()`/`authenticated()` role helpers, per-test `begin`/`rollback`, copied from `20260929120000_dialpad_cti_call_projection.integration.test.ts:51-80,330-340`).
  - Regression: no live function (`prokind='f'`, excluding `dialpad_cti_is_ledger_key` and `dialpad_cti_intent_key`), `pg_indexes.indexdef` or `pg_constraint` definition contains `dialpad-cti:`.
  - Helper truth table: sandra/native/null/garbage keys.
  - Constraint accepts a pending (`outcome null`) attempt with a `dialpad-native:` key and a `dialpad-cti:` key, rejects `dialpad-foo:x` with null outcome.
  - Upsert path: `dialpad_cti_project_intent` still creates exactly one activity and one attempt for a Sandra intent and is idempotent on replay (proves `ON CONFLICT` inference with the new predicate).
  - Patch idempotency: run the migration file twice.
  - A native-keyed activity row and attempt row can be inserted by hand and are visible to `fn_get_acquisition_call_references` and finalizable by `fn_finalize_acquisition_attempt_without_sms_obligation`.
- Fixtures: seed from `20260929120000_dialpad_cti_call_projection.integration.test.ts:106-160` (`seedFixture`, `verifiedBinding`).
- Rollback: ships `supabase/rollbacks/20261006100000_dialpad_ledger_keys_native_columns.sql` (recreate the two old indexes and old constraint, `drop column origin, direction`, re-apply the old function bodies from their original files); only safe before any native row exists. Code is inert until 2.4 writes native keys. After native rows exist, do not revert the schema; turn the consumer flags off (`native_matcher`, `click_to_dial`).

#### 2.2 Intent timeout: 2 minutes with no event marks the intent failed, counts as no touch (D5, N8)
- Files: create `20261006100100_dialpad_intent_timeout.sql` + test; modify `src/lib/dialpad-cti/contracts.ts`, `event-processing.ts`, `src/app/api/cron/dialpad-call-events-sweep/route.ts`.
- Change.
  - Design choice (differs from adding a terminal `failed` status): `failed` is a **marker**, not a terminal status. Add `failed_at timestamptz` to `dialpad_call_intents`. A late event inside the intent's own window (`expires_at`, default 600 s, `fn_prepare_dialpad_call_intent` `p_ttl_seconds default 600`) must still match, because the call really happened; dropping it would lose a real touch. `status` stays `'prepared'` until an event matches, then `'matched'` with `failed_at` kept as audit.
  - Replace `public.dialpad_cti_guard_intent()` in full (small; base is `20260929180000_dialpad_cti_dispatch.sql:50-82`): add `'failed_at'` to `v_mutable`; INSERT requires `failed_at is null`; add rule `if new.failed_at is distinct from old.failed_at and (old.failed_at is not null or new.failed_at is null or old.dispatch_authorized_at is null or old.status <> 'prepared') then raise exception 'failed marker is set once, on a dispatched prepared intent' using errcode='42501'`.
  - New function:
    ```sql
    create or replace function public.fn_fail_stale_dialpad_intents(p_cutoff_seconds integer default 120, p_limit integer default 200)
    returns integer language plpgsql security definer set search_path = '' as $$
    declare v_n integer;
    begin
      if p_cutoff_seconds not between 30 and 900 or p_limit not between 1 and 1000 then
        raise exception 'INVALID_INPUT' using errcode = '22023'; end if;
      with due as (select id from public.dialpad_call_intents
        where status = 'prepared' and failed_at is null and dispatch_authorized_at is not null
          and dispatch_authorized_at <= now() - make_interval(secs => p_cutoff_seconds)
        order by dispatch_authorized_at limit p_limit for update skip locked)
      update public.dialpad_call_intents i set failed_at = now() from due where i.id = due.id;
      get diagnostics v_n = row_count; return v_n; end $$;
    revoke all on function public.fn_fail_stale_dialpad_intents(integer, integer) from public, anon, authenticated;
    grant execute on function public.fn_fail_stale_dialpad_intents(integer, integer) to service_role;
    ```
  - Patch `fn_get_dialpad_call_status` (anchors): `when v_intent.expires_at <= now() then 'expired'` → `when v_intent.failed_at is not null then 'failed' when v_intent.expires_at <= now() then 'expired'`; and add `'failedAt', v_intent.failed_at,` after `'expiresAt', v_intent.expires_at, 'dispatchAuthorizedAt', v_intent.dispatch_authorized_at,` (single occurrence in the return).
  - TS: `contracts.ts:` add `'failed'` to `DIALPAD_CALL_STATES` and `failedAt: string | null` to `DialpadCallStatus` / `parseDialpadCallStatus` (`nullableStr` already tolerates a missing key). `event-processing.ts`: add `failStaleIntents(cutoffSeconds: number): Promise<number>` to `DialpadCtiDb` and `createSupabaseDialpadCtiDb` (RPC above); export `failStaleDialpadIntents(db, cutoffSeconds = 120): Promise<number>`. Cron route `dialpad-call-events-sweep/route.ts`: call it first inside its own try/catch, include `failedIntents` in the JSON, then run the existing sweep. Update `routes.test.ts` mocks.
  - "Counts as no touch" is structural: attempts and call activities are created only by `dialpad_cti_project_intent`, which returns `intent_not_matched` for a non-matched intent (`…training_projection.sql:43`); dispatch (`fn_authorize_dialpad_dispatch`) writes only `dispatch_authorized_at`.
- Side effects checked: `fn_cancel_dialpad_call_intent` (`…foundation.sql:715`) still cancels a `prepared` failed intent; revoke functions cancel `prepared` intents regardless of `failed_at`; `fn_authorize_dialpad_dispatch` returns `already_dispatched` before any failed check, so a failed intent can never be re-dialed (retry needs a new idempotency key and a new intent).
- Tests (`…intent_timeout.integration.test.ts`; unit in `contracts.test.ts`, `routes.test.ts`):
  - Authorized intent with no event: not failed at 119 s, failed at 121 s (the test sets `dispatch_authorized_at = now() - interval '119 seconds'` or `'121 seconds'` with a direct update from null, which the guard allows once, `…dispatch.sql:65-72`).
  - Failed intent produces no `call_activities`, no `acquisition_attempts`, no episode `first_call_*`, no queue stage change; KPI `attempts` unchanged.
  - Late event inside the window after `failed_at`: matches, projects exactly once, `failed_at` retained, status function reports `ended`/`connected`, not `failed`.
  - Prepared but never authorized intent is never marked.
  - `failed_at` is set once; a second run returns 0; guard rejects clearing it.
  - Skip-locked: two concurrent runs never double-update.
  - Webhook-before-timeout: event matched before the cutoff is never marked.
  - Cron route returns `failedIntents`, still returns 200 when the timeout RPC throws (error reported, sweep still runs).
- Rollback: `drop function fn_fail_stale_dialpad_intents`; restore the old guard and status bodies from `…dispatch.sql:50` and `…finalizer.sql:786`; leave the nullable column. Remove the cron call.

#### 2.3 `contact_phone_numbers` and its maintaining trigger
- Files: create `20261006100200_contact_phone_numbers.sql` + test.
- Change.
  ```sql
  create table public.contact_phone_numbers (
    contact_id uuid not null references public.contacts(id) on delete cascade,
    slot smallint not null check (slot between 1 and 3),
    org_id uuid not null references public.organizations(id) on delete cascade,
    e164 text not null check (e164 ~ '^\+1[0-9]{10}$'),
    digits10 text not null generated always as (right(e164, 10)) stored,
    updated_at timestamptz not null default now(),
    primary key (contact_id, slot));
  create index contact_phone_numbers_org_digits_idx on public.contact_phone_numbers (org_id, digits10);
  alter table public.contact_phone_numbers enable row level security;
  revoke all on table public.contact_phone_numbers from public, anon, authenticated;   -- service role and definer functions only
  grant select on public.contact_phone_numbers to service_role;
  ```
  - Normalization reuses the existing immutable `public.dialpad_cti_normalize_us_phone(p_raw)` (`…foundation.sql:42-56`): 10 digits, or 11 digits starting `1`; anything else (extensions, non-US, partial) yields no row. This is the same normalizer dial authorization uses, so match and dial agree.
  - Sync function `public.contact_phone_numbers_sync() returns trigger` (`security definer set search_path = ''`, because `contacts` writers are `authenticated`): for each slot, `v := dialpad_cti_normalize_us_phone(new.phone_N)`; if `v is null` delete the `(contact_id, slot)` row else upsert `(contact_id, slot, org_id, v)`.
  - Trigger: `after insert or update of phone_1, phone_2, phone_3 on public.contacts for each row when (tg_op = 'INSERT' or old.phone_1 is distinct from new.phone_1 or old.phone_2 is distinct from new.phone_2 or old.phone_3 is distinct from new.phone_3)` (the `when` is written as two triggers, insert and update, because `OLD` is not available on insert).
  - Backfill is NOT in the migration (no data step in a migration): `public.fn_contact_phone_numbers_backfill(p_org uuid, p_apply boolean default false) returns jsonb` (service-only, run kind `phone_backfill`, subcommand `phone-backfill` of `scripts/my-leads-housekeeping.mjs`, preview then `--confirm`): one `insert … select … from public.contacts cross join lateral (values (1, phone_1), (2, phone_2), (3, phone_3)) …` with `on conflict (contact_id, slot) do update`, skipping null normalizations. Signature `fn_contact_phone_numbers_backfill(p_org uuid, p_apply boolean default false, p_expected_fingerprint text default null)` (shared apply contract, 1e.1; every contact and phone row filtered by `org_id = p_org`; fingerprint over `[{contact_id, slot, normalized e164, existing e164 or null}]` ordered by `(contact_id, slot)`). Because the upsert can **update an existing row** as well as insert, each row is imaged with `op` = `created` (no row existed; `before` null) or `updated` (`before` = `{e164, updated_at}`), with `row_id = md5(contact_id||':'||slot)::uuid` and the after-image `{e164, updated_at}`, and the preview reports the created/updated split. `fn_my_leads_housekeeping_rollback` is copy-replaced in this migration with a `phone_backfill` branch: an `updated` row is restored to its before-image only if it still equals the after-image; a `created` row is deleted only if it still equals the after-image (not touched by the maintaining trigger since) and no native `dialpad_call_intents` row references its contact; otherwise it is skipped and listed in `summary.notRestored`. Idempotent. The maintaining trigger still ships in the migration. The backfill must be applied before the connection is activated (2.11) or native matching finds no candidates.
  - `contacts.phone_digits` and its trigram index (`20260909000000_global_search.sql:20-29`) are untouched; global search keeps using them.
- Side effects checked: contacts writers (CSV import, skip-trace, `do_not_contact` toggles) fire the trigger only when a phone column changes; `contacts_reject_dnc_locked_property` and delete guards (`20260816110000_contact_delete_dnc_guard.sql`) are unaffected because the trigger writes a different table; contact delete cascades. Row count is at most 3 per contact; measure backfill time on the test project and report in the PR.
- Tests (`…contact_phone_numbers.integration.test.ts`):
  - Insert with three phones creates three rows; update one phone replaces only that slot; nulling a phone deletes its row; a no-op update (same value) writes nothing (`updated_at` unchanged).
  - Formats: `(816) 555-0142`, `816-555-0142`, `+1 816 555 0142`, `18165550142` normalize to the same `digits10`; `816555014`, `+44 20 7946 0958`, `816-555-0142 x2` produce no row.
  - Two contacts sharing a number both appear; `org_id` mirrors the contact.
  - Backfill function: preview writes nothing and reports created/updated counts; apply populates contacts present before the migration and writes a `phone_backfill` run row with images (including an `updated` case where a stale row exists); a stale fingerprint raises `HOUSEKEEPING_PREVIEW_STALE`; a second apply changes nothing; rollback removes exactly the created rows, restores the updated rows, and preserves a row the trigger rewrote after the run (a contact phone edited by a user).
  - Contact delete cascades; `authenticated` and `anon` cannot select; `service_role` can.
- Rollback: ships `supabase/rollbacks/20261006100200_contact_phone_numbers.sql` (`drop trigger` (both), `drop function fn_contact_phone_numbers_backfill`, `drop table public.contact_phone_numbers`, restore the prior rollback function); data layer: `fn_my_leads_housekeeping_rollback(run_id)` for a `phone_backfill` run; safe until 2.4 depends on it.

#### 2.4 Native-match branch in the projection (D4): one, several, none, inbound, DNC, training
- Files: create `20261006100300_dialpad_native_matching.sql` + test; modify `contracts.ts` (`DIALPAD_QUARANTINE_REASONS` add `'no_binding'`, `'no_lead_match'`, `'ambiguous_lead'`, `'dnc_number'`; `contracts.test.ts`).
- Change.
  - Wrapper, not a text patch: `alter function public.dialpad_cti_resolve_event(uuid) rename to dialpad_cti_resolve_event_legacy;` then create a new `dialpad_cti_resolve_event(p_event_id uuid) returns jsonb` that calls the legacy function (A1 match, then transfer-leg link, `20260929200000_dialpad_cti_custom_data.sql:118`) and only when the result is `quarantined` with reason `no_custom_data` calls `public.dialpad_cti_native_resolve(p_event_id)`. Every other result passes through unchanged, so an event that carries any `custom_data` (including an unknown token) never reaches native matching and cannot double-attribute a Sandra-dialed call. `fn_process_dialpad_call_event` (`…projection.sql:348`) calls `dialpad_cti_resolve_event` by name, so it needs no change except one anchored patch to its sibling replay list: `disposition_reason in ('no_custom_data', 'intent_already_matched', 'target_mismatch', 'outside_intent_window')` → add `'ambiguous_lead'`.
  - Candidate helper (service/definer only):
    ```sql
    create or replace function public.dialpad_cti_native_candidates(p_org uuid, p_user uuid, p_digits10 text)
    returns table(property_id uuid, contact_id uuid, slot smallint, episode_id uuid, is_training boolean, is_dnc boolean)
    language sql stable security definer set search_path = '' as $$
      select distinct on (p.id) p.id, cpn.contact_id, cpn.slot, e.id, p.is_training,
             (coalesce(p.is_dnc_locked,false) or p.status::text = 'dnc' or c.do_not_contact
              or exists (select 1 from public.global_phone_dnc_registry r where r.org_id = p_org and r.phone_e164 = cpn.e164))
      from public.contact_phone_numbers cpn
      join public.contacts c on c.id = cpn.contact_id and c.org_id = p_org
      join public.properties p on p.org_id = p_org and p.assigned_user_id = p_user and p.deleted_at is null
           and p.status::text not in ('closed','dead')
           and (p.homeowner_contact_id = c.id or exists (select 1 from public.property_contacts pc
                where pc.org_id = p_org and pc.property_id = p.id and pc.contact_id = c.id))
      join public.acquisition_assignment_episodes e on e.property_id = p.id and e.org_id = p_org
           and e.ended_at is null and e.assignee_user_id = p_user
      left join public.acquisition_queue_states q on q.property_id = p.id and q.org_id = p_org
      where cpn.org_id = p_org and cpn.digits10 = p_digits10 and q.archived_at is null
      order by p.id, cpn.slot;
    $$;
    ```
    The membership definition mirrors the queue's (`my_leads_queue_rows_for`, `20261003120000_my_leads_queue_row_lookup.sql:30-60`: open episode for the member, assigned, not deleted, not archived). It does not require `eligible`; the projection already gates stage and clock effects on eligibility (`…training_projection.sql:144-165`).
  - Resolver `public.dialpad_cti_native_resolve(p_event_id uuid) returns jsonb` (`security definer set search_path = ''`; same return shape as `fn_match_dialpad_call_event`: `eventId, disposition, intentId, reason, replayed`). Body, in order:
    0. Flag gate: when the org's `my_leads_feature_flags.native_matcher` is not true (a missing row reads false), return the event unchanged and still quarantined `no_custom_data`, so native matching is inert until the flag is turned on (kill switch).
    1. Lock the event `for update`. Only chain roots resolve here: if `public.dialpad_cti_chain_root(provider_call_id, payload) <> provider_call_id` (a leg of a call whose root has no intent yet), return it unchanged still quarantined `no_custom_data`; `fn_process`'s sibling loop re-resolves it once the root event matches (the loop already lists `no_custom_data`).
    2. Rep: `target.type` must be `user`; load the `verified` binding for `(org_id, dialpad_user_id = payload->'target'->>'id')` `for share`; require `dialpad_cti_member_is_active`, `memberships.acquisitions_enabled`, and `acquisition_org_settings.my_leads_enabled`. Else quarantine `no_binding`.
    3. `direction` in `('inbound','outbound')` and `external_number ~ '^\+1[0-9]{10}$'`, else quarantine `no_lead_match`. `v_digits := right(external_number, 10)`.
    4. Outbound only, Sandra-dialed fallback: if exactly one intent for this rep has `status='prepared'`, `origin='sandra'`, `dispatch_authorized_at is not null`, `destination_e164 = external_number`, and the event timestamp is within `[dispatch_authorized_at - 5 s, expires_at]`, bind that intent (same update the A1 matcher performs) and match the event. This only fires if the dial endpoint drops `custom_data` (Phase 0 contingency); it keeps the frozen contact, slot and grant. Zero or more than one open intent falls through.
    5. `select count(*) filter (where not is_dnc), count(*)` from `dialpad_cti_native_candidates(org, binding.user_id, v_digits)`:
       - `total = 0` → quarantine `no_lead_match` (also covers non-US and unknown numbers and other reps' leads).
       - `live = 0` (all candidates DNC) → quarantine `dnc_number`; outbound and inbound alike, no ledger rows.
       - `live > 1` → quarantine `ambiguous_lead`. DNC candidates are ignored when at least one live candidate exists.
       - `live = 1` → `dialpad_cti_native_bind(...)`, then update the event to `matched` with `matched_intent_id`, exactly as `fn_match_dialpad_call_event` does.
    Quarantine uses the same update the A1 matcher uses (`disposition='quarantined', disposition_reason=…, disposed_at=now()`); the event guard (`…projection.sql:45-76`) allows quarantined → quarantined/matched.
  - Binder (shared with 2.5): `public.dialpad_cti_native_bind(p_event_id uuid, p_binding_id uuid, p_property_id uuid, p_contact_id uuid, p_slot smallint) returns uuid`. Locks in the canonical order (binding `for share`, property `for share`, open episode `for share`), then inserts the synthetic intent as `prepared` and updates it to `matched` (the INSERT guard demands `prepared` with null match fields, `…dispatch.sql:56-64`):
    ```sql
    insert into public.dialpad_call_intents (org_id, connection_id, rep_user_id, binding_id, dialpad_user_id, property_id,
      contact_id, phone_slot, destination_e164, assignment_episode_id, custom_data, idempotency_key, request_hash,
      expires_at, origin, direction)
    values (v_event.org_id, v_event.connection_id, v_binding.user_id, v_binding.id, v_binding.dialpad_user_id, p_property_id,
      p_contact_id, p_slot, v_event.payload->>'external_number', v_episode.id,
      'sandra.dialpad.v1.' || encode(extensions.gen_random_bytes(24), 'hex'), extensions.gen_random_uuid(),
      encode(sha256(convert_to('dialpad-native:' || v_event.org_id || ':' || v_event.provider_call_id, 'utf8')), 'hex'),
      now() + interval '1 day', 'native', lower(v_event.payload->>'direction')) returning id into v_id;
    update public.dialpad_call_intents set status='matched', matched_provider_call_id = v_event.provider_call_id,
      matched_event_id = v_event.id, matched_at = now() where id = v_id;
    ```
    A `unique_violation` on `dialpad_call_intents_one_per_provider_call` (`…foundation.sql:203`) is caught and the existing intent id returned: one frozen match per (org, provider call id). No grant columns are set (`number_grant_id` and `caller_number_e164` both null satisfy the check).
  - After binding, the rest of the A3 pipeline runs unchanged: later events of the same call match through the existing `matched_provider_call_id` lookup in `fn_match_dialpad_call_event` (target and number checks still apply); transfer legs link through `master_call_id`.
  - Projection patches to `dialpad_cti_project_intent` (anchored, idempotent, in this migration; Phase 1d's hangup edits are unaffected):
    - Direction: `v_outcome, 'dialpad', v_intent.matched_provider_call_id, v_events, 'outbound', v_intent.destination_e164,` → `… v_events, v_intent.direction, v_intent.destination_e164,`.
    - Inbound creates an activity and never an attempt: `if not v_property.is_training then` (statement form; `case when not v_property.is_training` does not contain the `if ` prefix) → `if not v_property.is_training and v_intent.direction = 'outbound' then`. That block holds the attempt insert, first-call clock and queue/stage effects, so inbound calls leave stage, status and the first-call clock alone (the "tier-2 signal, not an attempt" rule).
    - Outcome mapping already yields what Phase 1b needs: unanswered inbound = `outcome 'no_answer'`, voicemail = `'voicemail'`, answered = `'unknown'` (`…training_projection.sql:93-98`); Phase 1b's tier-2 query reads `direction='inbound'` activities.
  - Training: a training property resolves like any other candidate and the existing projection writes `call_purpose='internal_training'` with `property_id`/`contact_id` null and no attempt (`…training_projection.sql:105-109,122`), so no prompt appears (the prompt query in 2.6 is attempt-based).
  - Concurrency, duplicates, ordering. The chain advisory lock taken at the top of `fn_process_dialpad_call_event` (`…projection.sql:365`, key `dialpad-chain:<org>:<root>`) serializes every event of one call; `fn_ingest_dialpad_call_event` already dedupes exact replays by payload hash and records conflicts. Out-of-order arrival: whichever event is processed first binds the call; the others match by call id. Reassignment during a call: the synthetic intent freezes property, contact, episode and rep from the first event; later events project onto that frozen episode, and stage/status effects are gated on the episode still being open and on first attempt creation only (`…training_projection.sql:144-165`), so a reassigned lead is not touched.
  - Matched native events are never replayed from quarantine for `no_lead_match` (a contact added later does not retroactively claim old calls); only `ambiguous_lead` is replayable (2.5).
- Side effects checked.
  - `acquisition_attempts` for native calls are created pending (`outcome null`), exactly like Sandra-placed ones, with `source='dialpad'`, `provider_attempt_key='dialpad-native:<call_id>'`; KPIs `attempts`, `pendingOutcomes`, first-call clock and Contacted stage move as for a Sandra-placed call (`20260927023443_dialpad_cti_kpi_seller_speech.sql:57`).
  - `fn_list_dialpad_call_events_for_processing` sweeps only `received` and matched-unprojected events (`…projection.sql:413-438`); quarantined native events are not re-driven every minute. That is why several-match is `quarantined/ambiguous_lead`, not `received` as the decision doc says (a `received` event would be re-processed by the one-minute cron indefinitely).
  - Recording library (`recording_library_rows`, `20260917193000_recording_accountability.sql:84-160`) lists the new activities with no files; harmless.
- Tests (`…native_matching.integration.test.ts`; payload and seed helpers from `src/lib/testing/dialpad-cti-fixtures.ts`, shape per `…call_projection.integration.test.ts:196-232`): every case below runs with `native_matcher=true` except case 0.
  0. Flag off (or no flags row): an event with no `custom_data` stays quarantined `no_custom_data`, no intent, no ledger rows.
  1. One match, outbound answered (calling, connected, hangup): one native intent (`origin='native'`, `status='matched'`), one activity keyed `dialpad-native:<call_id>`, one pending attempt, episode `first_call_started_at` set, stage `contacted`.
  2. Exact duplicate delivery and fully reversed order (hangup, connected, calling): identical ledger, one intent.
  3. Several matches (same contact on two assigned properties; two contacts sharing a number): every event quarantined `ambiguous_lead`, zero ledger rows.
  4. None: `no_lead_match`; non-US `external_number`, number on another rep's lead, number on a closed or dead lead, archived queue row.
  5. Inbound answered: activity `direction='inbound'`, no attempt, no first-call change, stage unchanged. Inbound missed: `outcome='no_answer'`.
  6. DNC: `contact.do_not_contact`, `properties.is_dnc_locked`, `status='dnc'`, and a `global_phone_dnc_registry` entry each produce `dnc_number` for outbound and inbound; a live plus a DNC candidate binds the live one.
  7. Training property: `internal_training` activity with null links, no attempt, no episode effect.
  8. No verified binding, revoked binding, inactive member, `acquisitions_enabled=false`, `my_leads_enabled=false`: `no_binding`.
  9. Events carrying an unknown `custom_data` stay `unknown_custom_data`; a Sandra-dialed call whose events lack `custom_data` binds the open authorized intent (no synthetic intent, one attempt); two open intents for the same number fall through to native candidates.
  10. Transfer leg (`master_call_id`) of a native call links to the same intent and creates no second attempt; a leg that arrives before its root stays quarantined, then resolves when the root matches.
  11. Reassignment mid-call: calling matched to rep A's lead, property reassigned to rep B, hangup arrives: attempt stays rep A's, no stage or status change for B.
  12. Concurrency: two `pg` clients process different events of one call at once: exactly one intent and one attempt.
  13. Replay safety: `fn_process_dialpad_call_event` run twice and via the sweep: no duplicate rows, `stage_entered_at` unchanged, `first_call_started_at` only moves earlier.
  14. A quarantined `no_lead_match` event is not picked up by `fn_list_dialpad_call_events_for_processing`.
  15. Existing suites (`…foundation`, `…call_projection`, `…dispatch`, `…custom_data`) pass in their own scratch DB.
- Rollback: restore the legacy name (`drop function dialpad_cti_resolve_event; alter function … rename dialpad_cti_resolve_event_legacy to dialpad_cti_resolve_event`), revert the two project patches. Native intents already created stay valid evidence. Connection is disabled until 2.11, so no native rows exist before activation.

#### 2.5 "Assign to lead" RPC and strip row
- Files: create `20261006100400_dialpad_native_assign_to_lead.sql` + test; create `call-state-actions.ts` (the assign action; the file is shared with 2.6, 2.8), `_components/unassigned-calls-strip.tsx`.
- Change.
  - Read RPC (authenticated, stable): `fn_list_ambiguous_native_calls(p_org_id uuid) returns jsonb`. Requires an active member (pattern of `fn_get_acquisition_call_references`, `20260912130000_acquisition_call_reconciliation.sql:109-124`). Returns the caller's own unresolved calls from the last 14 days: events with `disposition='quarantined' and disposition_reason='ambiguous_lead'` whose `target.id` equals the caller's verified `dialpad_user_id` and whose provider call id has no intent matched. Each item: `{providerCallId, startedAtMs, direction, numberLast4, candidates:[{propertyId, contactId, slot, address, city, homeownerName, stage}]}`. Candidates are recomputed live from `dialpad_cti_native_candidates`, not stored.
  - Write RPC (authenticated, `security definer set search_path=''`): `fn_assign_native_call_to_lead(p_org_id uuid, p_provider_call_id text, p_property_id uuid) returns jsonb`.
    1. `auth.uid()` must be an active member (`42501`). Find the earliest event **of any disposition** for `(org, p_provider_call_id)` whose target binding user is `auth.uid()`; none → `P0002` (so another user's call, or an unknown call, is refused before anything else).
    2. Take `pg_advisory_xact_lock(hashtextextended('dialpad-chain:' || org || ':' || dialpad_cti_chain_root(call, payload), 0))`, the same key `fn_process` uses, before any row lock.
    3. **Inspect the frozen existing match first (idempotent replay).** A successful assignment turns every ambiguous event of the call into `matched`, so a repeated request would find no `ambiguous_lead` event; therefore this check runs BEFORE requiring an unresolved event. Under the chain lock: if an intent of this `auth.uid()` rep is already matched to the call chain, then same property → return `{status:'already_assigned', attemptId, callActivityId}`; different property → raise `STALE_STATE` with errcode `MLS01` (the non-retryable My Leads conflict code, `20261003130000_my_leads_conflicts_non_retryable.sql:12-14`); an intent matched for a different rep → `P0002`.
    4. Only when no existing match exists: require at least one `ambiguous_lead` event of the call (none → `P0002`). `p_property_id` must be in the current candidate set (assigned, open episode, number on a contact of the property) else `STALE_ASSIGNMENT` errcode `42501` (the code `fn_get_acquisition_call_references` uses). DNC candidates are rejected `42501`.
    5. `dialpad_cti_native_bind(earliest_event, binding, property, contact, slot)`, then `perform public.fn_process_dialpad_call_event(<earliest event id>)`; its sibling loop (now including `ambiguous_lead`) resolves and projects every other event of the call in one pass. Return `{status:'assigned', intentId, attemptId, callActivityId}`.
    "Pins" in the decision doc means freezing the match, not strip pinning; the frozen intent is the pin.
  - Grants: both functions `revoke … from public, anon, service_role; grant execute … to authenticated`.
  - UI: `unassigned-calls-strip.tsx` renders above `call-next-strip.tsx`: one card per call ("Call at 2:14 PM, ends in ••42, 2 possible leads") with one button per candidate (address + name). Success refreshes the queue, and the new attempt appears through the 2.6 poll. Error copy for `MLS01`: "That call was already assigned. Refresh."
- Side effects checked: assigning projects the whole call, including stage and first-call clock effects of a first attempt (same as a unique match); `fn_process` re-entrancy on the same advisory lock within one session is allowed; no other reader consumes `ambiguous_lead`.
- Tests (`…native_assign_to_lead.integration.test.ts`; `unassigned-calls-strip.test.tsx`):
  - Assign picks A: one intent, one attempt, activity updated, all earlier quarantined events become matched; events arriving after assignment match by call id and attach.
  - Lost-response replay: after a successful assign (no `ambiguous_lead` event remains), the same request again returns `already_assigned` with the same ids and no second intent or attempt (never `P0002`). Same call, same property again: `already_assigned`, no duplicate. Different property: `MLS01`. Property not a candidate or reassigned to someone else after listing: `42501`. Another user's call: `P0002`/denied. DNC candidate: denied. Anonymous: denied.
  - Concurrent assign vs incoming hangup, and two concurrent assigns for different properties: exactly one winner, one intent.
  - List shows only the caller's own unresolved calls inside 14 days, excludes assigned and `no_lead_match` calls, and shows candidates as of now.
  - UI: renders candidates, calls the action with `(providerCallId, propertyId)`, disables while pending, shows the conflict copy, refreshes on success.
- Rollback: drop the two functions; remove the strip. `ambiguous_lead` events simply stay quarantined.

#### 2.6 Durable unacknowledged-call query and persisted acknowledgement (N6)
- Files: create `20261006100600_call_prompt_acknowledgement.sql` + test (+ rollback twin); modify `call-state-actions.ts`; create `_components/use-call-state-poll.ts`; modify `client.tsx`.
- Change.
  - Columns on `public.acquisition_attempts`: `prompt_acknowledged_at timestamptz`, `prompt_acknowledged_via text check (prompt_acknowledged_via in ('saved','skipped','dismissed'))`. The table has no immutability trigger beyond `rep_sms_no_answer_attempt` (verified: only trigger on it, `20260917110000_rep_sms_obligation_read_models.sql:23`), and the finalize function already updates it (`…non_retryable.sql:1156-1160`), so no guard change.
  - Legacy acknowledgement is NOT a migration step (no data step in a migration): `public.fn_my_leads_ack_legacy_call_prompts(p_org uuid, p_apply boolean default false, p_expected_fingerprint text default null) returns jsonb` (service-only, shared apply contract 1e.1, run kind `ack_legacy_prompts`, subcommand `ack-legacy-prompts` of `scripts/my-leads-housekeeping.mjs`, preview then `--confirm <fingerprint>`; fingerprint over `[{id, provider_attempt_key, prompt_acknowledged_at}]` ordered by id) runs `update public.acquisition_attempts set prompt_acknowledged_at = now(), prompt_acknowledged_via = 'dismissed' where org_id = p_org and id = … and prompt_acknowledged_at is null and public.dialpad_cti_is_ledger_key(provider_attempt_key)` (the `org_id = p_org` predicate the earlier draft omitted) with a before-image of each attempt (`prompt_acknowledged_at` null) and an after-image (`dismissed`, timestamp); rollback restores null only for a row still `dismissed` with the after-image timestamp, so the five canary calls from Sept 30 to Oct 1 never pop a prompt. It must run before the `auto_prompt` flag is turned on. Sandra softphone attempts are not touched (their keys do not match; they keep their own wrap-up flow).
  - Index: `create index acquisition_attempts_unacked_prompt_idx on public.acquisition_attempts (org_id, actor_user_id, occurred_at desc, id desc) where prompt_acknowledged_at is null and outcome is null and call_activity_id is not null and public.dialpad_cti_is_ledger_key(provider_attempt_key);`
  - Read RPC (authenticated, stable): `fn_list_unacknowledged_call_prompts(p_org_id uuid, p_limit integer default 20, p_before_ended timestamptz default null, p_before_id uuid default null, p_horizon interval default interval '14 days') returns jsonb`. Uses `auth.uid()` only (no member parameter; the prompt is personal) after the active-member check and `my_leads_require_read_scope(p_org_id, auth.uid())`. Rows: attempts with `actor_user_id = auth.uid()`, `source='dialpad'`, ledger key, `outcome is null`, `prompt_acknowledged_at is null`, joined to `call_activities c` with `c.ended_at is not null and c.call_purpose='customer'`, `c.ended_at > now() - p_horizon`, and to `properties p` with `p.assigned_user_id = auth.uid() and p.deleted_at is null` (a lead since reassigned cannot be acted on, so it is not offered). Order `c.ended_at desc, a.id desc`; keyset `(c.ended_at, a.id) < (p_before_ended, p_before_id)`; `p_limit` clamped 1..50. Item: `{attemptId, propertyId, callActivityId, endedAt, durationSeconds, talkDurationSeconds, origin ('sandra'|'native'), outcomeGuess, voicemail}` plus `nextCursor`. `outcomeGuess`: `'voicemail'` when `c.outcome='voicemail' or c.provider_voicemail_url is not null`; `'no_answer'` when `c.outcome='no_answer'`; `'reached'` when `c.outcome='unknown' and coalesce(c.talk_duration_seconds,0) > 0`; else null (rep decides). Inbound has no attempt so it never appears.
  - Ack RPC (authenticated): `fn_acknowledge_call_prompt(p_org_id uuid, p_attempt_id uuid, p_via text) returns jsonb`. Active member; attempt must belong to `auth.uid()` (`42501`); sets `prompt_acknowledged_at = coalesce(existing, now())`; idempotent; returns `{status:'acknowledged'|'already'}`. Outcome is never touched: skipping leaves `outcome null` and the touch still counts (D9).
  - Grants: `revoke … from public, anon, service_role; grant execute … to authenticated`.
  - Readiness (`ack_prompts`): the poll action returns empty prompts and the `auto_prompt` open is skipped unless `schemaReady('ack_prompts')` and the flag are both true, so the old manual log flow is untouched until the migration has landed.
  - Client. `use-call-state-poll.ts` exports `useCallStatePoll({ enabled, suspended })` returning `{ prompts, ambiguous, callbacksDue, refreshNow }`. It calls one server action, `pollMyLeadsCallStateAction()` in `call-state-actions.ts`, which fans out to the RPCs that exist at that commit (2.5 and 2.6 first; 2.8 adds the callbacks call so each commit stays green) with `myLeadsViewer().client` (same pattern as `loadMyLeadCallReferences`, `actions.ts:874`). Poll every 10 s only while `document.visibilityState === 'visible'`; fetch immediately on `visibilitychange` to visible and on mount; skip while `suspended` (any open dialog or `openingStatus`); on error keep last data and back off to 30 s. The cursor is requested only when the first page is full.
  - `client.tsx`: only when the `auto_prompt` flag is on (read server-side, a missing row reads OFF; with it off the poll still runs but nothing auto-opens), when `prompts.length > 0` and no dialog is open, call the existing `action('log-attempt', propertyId, callActivityId)` path (the same hand-off `onLogOutcome` used at `client.tsx:1033-1040`) for the oldest unacknowledged item, passing `outcomeGuess` as the prefilled outcome to Phase 1's `post-call-prompt.tsx`. Any close of the auto-opened prompt (save, skip, dismiss) calls `acknowledgeCallPromptAction(attemptId, via)`. A prompt opened for one attempt is not reopened while its ack is in flight. `listRecentDialpadCalls` and `listRecentIntentIds` (`dispatch.ts:169,542`, one-hour window, five intents) are deleted, with their action and tests.
- Side effects checked: the finalize path needs no change (a saved outcome removes the attempt from the query by `outcome is not null`); Phase 1's prompt save without an outcome must call the ack action (state this in the PR so the Phase 1 component exposes `onClose(via)`); the manual log dialog's `fn_get_acquisition_call_references` list is unaffected.
- Tests (`…call_prompt_acknowledgement.integration.test.ts`; `use-call-state-poll.test.tsx`; `call-state-actions.test.ts`; `client-call-state.test.tsx`):
  - SQL: only ended, outcome-null, unacknowledged, own, still-assigned, customer, ledger-key attempts are returned; 8 rows paginate correctly with `p_limit 3` (more than five calls); a call ended 2 days ago still returns (next-day reopen) and one ended 15 days ago does not; finalize with an outcome removes it; ack removes it; ack is idempotent; another user's attempt → `42501`; `fn_my_leads_ack_legacy_call_prompts` preview writes nothing and apply acknowledges pre-existing rows (with a run row and before-images; rollback restores null); training and inbound never appear; native and Sandra origins both appear; `anon` denied.
  - Poll hook (fake timers): 10 s cadence, no fetch while hidden, immediate fetch on becoming visible, no fetch while suspended, backoff on error, no overlapping requests.
  - Client: first load with two unacknowledged calls opens the oldest only; never opens over an open dialog; after close + ack opens the next; skip leaves the attempt visible in "pending outcomes" (no outcome change); stale poll after reassignment does not open a prompt.
- Rollback: turn `auto_prompt` off; ships `supabase/rollbacks/20261006100600_call_prompt_acknowledgement.sql` (drop the three functions and the index; leave the nullable columns); data layer: `fn_my_leads_housekeeping_rollback(run_id)` for an `ack_legacy_prompts` run. Remove the hook (the manual `log-attempt` flow keeps working).

#### 2.7 API dial: `api-dial.ts`, authorization payload, connection config, binding without the iframe (D4)
- Files: create `src/lib/dialpad-cti/api-dial.ts`, `api-dial.test.ts`, `20261006100700_dialpad_api_dial_support.sql` + test (+ rollback twin), `_components/dial-status.tsx`; modify `dispatch.ts`, `contracts.ts`, `directory.ts`, `dialpad-actions.ts`, `page.tsx`, `client.tsx`; delete `dialpad-panel.tsx`, `dialpad-recording-actions.ts` and their tests.
- Change (SQL, `…api_dial_support.sql`).
  - Dial eligibility patch (contract row "Dial eligibility", flagged for orchestrator review): two anchored patches (`DO` block, `pg_get_functiondef`, anchor asserted present, idempotent) remove the `eligible` requirement so reassigned leads (`eligible=false`) can be dialed while an open episode and the assignee are still required. `fn_prepare_dialpad_call_intent` (`20260929034021_dialpad_cti_foundation.sql:660`): `if not found or v_episode.assignee_user_id <> p_rep_user_id or not v_episode.eligible` → `if not found or v_episode.assignee_user_id <> p_rep_user_id`. `fn_authorize_dialpad_dispatch` (`20260929180000_dialpad_cti_dispatch.sql:159`): `elsif v_episode.id is null or v_episode.assignee_user_id <> p_rep_user_id or not v_episode.eligible` → `elsif v_episode.id is null or v_episode.assignee_user_id <> p_rep_user_id`. Tests: an `eligible=false` episode with the right assignee can be prepared and authorized; a missing/ended episode or another assignee is still `not_assigned_rep`; both functions' definitions contain no `eligible`.
  - `alter table public.dialpad_org_connections add column dial_endpoint text not null default 'initiate_call' check (dial_endpoint in ('initiate_call','call')), add column dial_api_key_ref text check (dial_api_key_ref is null or dial_api_key_ref ~ '^env:DIALPAD_CTI_DIAL_KEY_[A-Z0-9_]{1,120}$')`. The endpoint flag is per connection so Phase 0's choice is auditable and flips with one `update` plus no redeploy of logic; the key ref mirrors `directory_api_key_ref` (`…dispatch.sql:32-35`). Null `dial_api_key_ref` means reuse `directory_api_key_ref` (default assumption above). The non-secret column grant for `authenticated` (`…foundation.sql:907`) is column-listed, so the new columns stay service-only.
  - Patch `fn_authorize_dialpad_dispatch` (anchored): `'phoneNumber', v_intent.destination_e164,` → `'dialpadUserId', v_intent.dialpad_user_id, 'phoneNumber', v_intent.destination_e164,` so the server uses the frozen Dialpad user id.
  - New read-only `fn_dialpad_call_slots(p_org_id uuid, p_rep_user_id uuid, p_property_id uuid, p_contact_id uuid) returns jsonb` (service role): for slots 1..3 returns `{slot, callable, reason}` where `reason` is one of `property_dnc`, `contact_dnc`, `phone_dnc`, `invalid` (uses `dialpad_cti_normalize_us_phone` and `global_phone_dnc_registry`). This is the "server-side DNC check RPC" the plan asks for, as a pre-check only. Enforcement already exists and is not duplicated: `fn_prepare_dialpad_call_intent` denies `property_dnc_locked`, `contact_do_not_contact`, `phone_dnc` (`…foundation.sql:656-681`), and `fn_authorize_dialpad_dispatch` re-proves all three in the dispatch transaction (`…dispatch.sql:158-178`), cancelling the intent on denial. The strip and callback banner use the pre-check to pick the first callable slot and to grey the button with a reason.
- Change (TS).
  - Dial provider seam S1: `DIALPAD_DIAL_PROVIDER=stub|live` read in `api-dial.ts` (same idiom as `MESSAGING_PROVIDER`, `src/lib/messaging/registry.ts:20`). `stub` records the would-be request (phone, `custom_data`, caller id) in an in-process list readable through a test-only route/log the Phase 4 specs read, and returns `accepted` with no HTTP; `live` is the real dialer. The value is ignored (behaves as `live`) when `VERCEL_ENV=production`, with a unit test asserting that.
  - Kill switch and readiness (`api_dial`): `dialLeadAction` reads the `click_to_dial` flag server-side (`getMyLeadsFlag`) and `schemaReady('api_dial')` (the two connection columns and the patched dial functions); off, not ready, or a missing row/table makes it return `not_configured`, and `client.tsx` uses the existing Sandra-softphone branch exactly as when the `dialpad` bootstrap is null.
  - `contracts.ts`: `DialpadDialRelease` gains `dialpadUserId: string`; `parseDialpadDispatchAuthorization` validates it with `DIALPAD_CALL_ID_PATTERN` (digits only).
  - `dispatch.ts`: `DialpadConnectionView` gains `dialEndpoint: 'initiate_call' | 'call'`, `dialKeyRef: string | null` (and the `loadConnection` select, `dispatch.ts:88`); `DialpadDispatchDb` gains `loadDispatchLoad(orgId, userId, sinceIso): Promise<{ authorizedLastMinute: number; unmatchedLast20s: number }>` and `loadCallSlots(orgId, userId, propertyId, contactId)`. Replace `DialpadPanelBootstrap` with `DialpadCallingBootstrap { connectionId: string; binding: …; grants: … }` (no `allowedOrigins`, no `recording`) and rename `loadDialpadPanelBootstrap` → `loadDialpadCallingBootstrap` (`page.tsx:291-300` call site). `startDialpadCall` keeps its origin gate (`dispatch.ts:463`) and its JS-safe identity-id guard (`:476`); add an options bag `{ allowLargeIdentityIds?: boolean }` that skips the browser-only guard for the server path.
  - `directory.ts`: add `findDialpadDirectoryUserByEmail({ email, apiKey, fetchImpl }): Promise<DialpadDirectoryResult>` doing `GET /api/v2/users?email=<email>` and reusing `parseDialpadDirectoryUser` on the single returned item (`not_found` when none, `invalid_response` when more than one). Phase 0 confirms the `email` filter exists; if it does not, fall back to listing the company's users and filtering exactly.
  - `dispatch.ts`: add `ensureDialpadBinding(db, actor, identity, deps)`: if a verified binding exists return it; else resolve the key (`resolveDialpadDirectoryKey`), look the user up by the confirmed Sandra email, then call the existing `verifyDialpadBinding(db, actor, identity, foundUserId, deps)` unchanged, so every directory check (company, `state='active'`, listed email) still runs. Without the iframe there is no browser-claimed id, so this replaces `user_authentication`. Claim requires an active connection (`fn_claim_dialpad_member_binding` raises `connection_inactive`), so first-time binding happens after activation; if the prod binding is already `verified` (checked in Inputs) it is a no-op.
  - `api-dial.ts` exports:
    ```ts
    export type DialpadDialEndpoint = 'initiate_call' | 'call';
    export interface DialpadDialRequest { endpoint: DialpadDialEndpoint; apiKey: string; dialpadUserId: string;
      phoneNumber: string; customData: string; identity: { type: DialpadIdentityType; id: string } | null;
      outboundCallerId: string | null; }
    export type DialpadDialResult =
      | { kind: 'accepted'; status: number; providerCallId: string | null }
      | { kind: 'rejected'; status: number; reason: 'unauthorized' | 'forbidden' | 'not_found' | 'invalid' | 'rate_limited'; retryAfterSeconds: number | null }
      | { kind: 'unknown' };                                   // timeout, network error, 5xx: the call may have been placed
    export interface DialpadDialer { dial(request: DialpadDialRequest): Promise<DialpadDialResult>; }
    export function createDialpadHttpDialer(fetchImpl?: DialpadDirectoryFetch): DialpadDialer;   // POST, 10 s timeout, redirect:'error', cache:'no-store', never retries
    export function resolveDialpadDialKey(connection: Pick<DialpadConnectionView,'dialKeyRef'|'directoryKeyRef'>, env: DialpadDirectoryEnv): string | null;
    export function buildDialpadDialBody(request: DialpadDialRequest): string;                  // manual JSON text so int64 ids stay exact (pattern: provisioning.ts:837)
    export type DialpadApiDialInput = { propertyId: unknown; contactId: unknown; phoneSlot: unknown; idempotencyKey: unknown };
    export type DialpadApiDialOutcome =
      | { ok: true; intentId: string; state: 'awaiting_provider'; uncertain: boolean }
      | { ok: true; intentId: string; state: 'already_dispatched' }
      | { ok: false; code: DialpadFailureCode | 'rate_limited' | 'call_in_flight' | 'provider_rejected' | 'dialpad_unavailable'; message: string; retryAfterSeconds?: number; denial?: DialpadDenialDetail };
    export async function startDialpadApiCall(db: DialpadDispatchDb, dialer: DialpadDialer, actor: DialpadActor,
      input: DialpadApiDialInput, deps: { env: DialpadDirectoryEnv; now?: () => Date }): Promise<DialpadApiDialOutcome>;
    ```
  - `initiate_call` request: `POST https://dialpad.com/api/v2/users/{dialpadUserId}/initiate_call` (origin from `DIALPAD_API_ORIGIN`, `directory.ts:15`), body `{"phone_number": "+1…", "custom_data": "<intent token>", "outbound_caller_id": "+1…"}` or, for office/group/call-center identities, `"group_id": <int64 as number text>, "group_type": "<mapped>"` instead of `outbound_caller_id` (mutually exclusive, as `buildInitiateCallMessage` enforces for the CTI protocol, `protocol.ts:112-118`). `call` request: `POST /api/v2/call` with `user_id` added and the same fields; if the response carries `call_id` it is returned as `providerCallId` (informational). The token is the intent's `custom_data` (`sandra.dialpad.v1.<48 hex>`, within the 2000-char limit `protocol.ts:DIALPAD_CUSTOM_DATA_MAX`).
  - Caller id rule (replaces the chooser): `loadActiveGrants` (`dispatch.ts:117`, ordered `granted_at` ascending) → none: omit caller id (Dialpad uses the rep's own line, which is what keeps A-level attestation); one or more: first grant. Passed as `grantId` to `fn_prepare_dialpad_call_intent`.
  - `startDialpadApiCall` flow:
    1. Validate input (reuse the UUID/slot checks of `startDialpadCall`, `dispatch.ts:455-462`).
    2. Rate guard before preparing anything: `db.loadDispatchLoad(org, user, now-60s)`; `authorizedLastMinute >= 4` → `rate_limited` with `retryAfterSeconds` (limit 4, not 5, leaves one request of headroom for concurrent clicks; Dialpad's 5/min is per user target and shared with any other tool, so a Dialpad 429 is the backstop). `unmatchedLast20s > 0` → `call_in_flight` (stops a double click from dialing twice).
    3. `startDialpadCall(...)` (connection active, verified binding, `fn_prepare_dialpad_call_intent`, `fn_authorize_dialpad_dispatch`: DNC, assignment, grant and phone are re-proven in one transaction). `dispatched:false` (retry of the same key) → `already_dispatched`, no HTTP, so a retry can never dial twice. Denials map through `dialpadDenialMessage`.
    4. Resolve the key (`resolveDialpadDialKey`); unresolved → `cancelIntent`, `not_configured`.
    5. `dialer.dial(...)`: `accepted` → `{ok, state:'awaiting_provider', uncertain:false}`. `rejected` with `rate_limited` → `cancelIntent` (nothing was dialed, so this is a **proven non-dispatch rejection**), result `rate_limited` with `retryAfterSeconds` and `freshAttemptKey: true`. The cancelled intent can never dial again (`fn_authorize_dialpad_dispatch` returns `cancelled` for it, `20260929180000_dialpad_cti_dispatch.sql:130`), so the retry rule is: **a fresh intent and a fresh idempotency key are minted only after a proven non-dispatch rejection** (provider 429 and the pre-prepare rate guard); for `accepted`, `unknown` (uncertain) and `already_dispatched` the client keeps the same key, which can only ever return `already_dispatched`, never a second dial. Any other `rejected` → `cancelIntent`, `provider_rejected`, report with `tags.surface='dialpad_api_dial'` and no body text. `unknown` → do **not** cancel (the call may exist); return `{ok, uncertain:true}`; the 2.2 timeout marks it failed after two minutes if no event arrives, and a late event still matches.
    6. Webhook-before-response: if `cancelIntent` throws `intent_already_matched` (events beat the HTTP response and matched the intent), treat it as success: the call was placed.
    No attempt row is written here; the attempt is created by the projection on the first event (D5), unchanged.
  - Server action in `dialpad-actions.ts`: `dialLeadAction(input)` → `session()` → `startDialpadApiCall(db, createDialpadHttpDialer(), actor, input, { env: process.env })`, returns only `{ ok, intentId, state, uncertain }` or the failure; the dial payload and key never reach the browser. `ensureDialpadBindingAction()` wraps `ensureDialpadBinding`. Remove `verifyDialpadBindingAction`, `startDialpadCallAction`, `listRecentDialpadCallsAction` and `listDialpadCallTargetsAction`'s phone-chooser use (keep `getDialpadCallStatusAction` for the status bar).
  - UI: `dial-status.tsx` is a small status bar for the in-flight intent: polls `getDialpadCallStatusAction` every 3 s while the state is in `prepared, awaiting_provider, dialing, connected`; labels from the old `STATE_LABEL` plus `failed`: "Dialpad never confirmed this call. Nothing was logged. Is the Dialpad desktop app open?"; `rate_limited` shows a countdown and then makes one automatic retry that generates a **new idempotency key** (the previous intent was cancelled by the provider's 429, so the same key could never dial); this is the single-rep, human-paced "queue", no server-side queue is built because the rep cannot dial faster than the limit and the new key is only used after a proven non-dispatch rejection (call this out in the PR). An `uncertain` or `awaiting_provider` state never retries with a new key. `client.tsx` (the Call button carries `data-testid="call-button-<propertyId>"`, seam S4): at `action('start-call')` (`client.tsx:630`) replace the `DialpadCallRequest` / `<DialpadPanel>` path (`:1026-1042`) with `dialLeadAction`; the contact is `row.contactId`, the slot is the first `callable` slot from `loadCallSlots`; when `dialpad` bootstrap is null (connection disabled) the existing Sandra-softphone branch (`:645-664`) still applies. Delete `dialpad-panel.tsx` (iframe, binding claim, capture, chooser, recording status), `dialpad-recording-actions.ts`, and their tests. Leave `src/lib/dialpad-recording/*` and the CSP entries for `dialpad.com` in place (unused exports and the middleware allowance are a separate cleanup; changing CSP here widens review for no gain).
- Side effects checked: `fn_get_dialpad_call_status` consumers are the status bar and `fn_open_dialpad_recording_capture` (unused after deletion); `fn_prepare_dialpad_call_intent` TTL stays 600 s; revoke binding/grant still cancels prepared intents; nothing here writes to `acquisition_attempts`, `call_activities`, queue state or KPIs.
- Tests.
  - `api-dial.test.ts` (fake `DialpadDispatchDb`, fake `DialpadDialer`; pattern of `dispatch.test.ts`): `initiate_call` URL, headers, body (token, caller id vs group, int64 `group_id` rendered exactly); `call` endpoint body with `user_id`; success; retry with the same key returns `already_dispatched` and never dials; DNC added between prepare and authorize → `phone_dnc`, no HTTP; provider 429 → intent cancelled, `rate_limited` with `retryAfterSeconds` and `freshAttemptKey`, and the **complete sequence** 429 → countdown → retry with a new key → prepare a second intent → provider accepts → exactly two intents (first `cancelled`, second dispatched), one accepted dial, and no dial for the first key; the same-key retry after 429 returns `cancelled` and never calls the dialer; an `unknown` result followed by a retry with the same key returns `already_dispatched` (no new intent, no HTTP); provider 400/401/403 → cancelled, `provider_rejected`; 5xx and timeout → not cancelled, `uncertain:true`; webhook-before-response (`cancelIntent` raises `intent_already_matched`) → success; rate guard at 4 in 60 s → `rate_limited` before `prepareIntent` is called; in-flight guard; unresolved key → cancelled, `not_configured`; no key or response text in `reportError` payloads; unbound rep → `not_bound`; origin not allowed.
  - `dispatch.test.ts`: remove `listRecentDialpadCalls` cases; add `ensureDialpadBinding` (already verified, email lookup success, email mismatch, company mismatch, inactive, not found, ambiguous), `parseDialpadDispatchAuthorization` with `dialpadUserId`, `DialpadCallingBootstrap`.
  - `directory.test.ts`: `findDialpadDirectoryUserByEmail` statuses 200/404/401/5xx/invalid JSON/two users.
  - `…api_dial_support.integration.test.ts`: connection column checks (bad endpoint, bad key ref rejected; `authenticated` cannot select them), authorize returns `dialpadUserId`, `fn_dialpad_call_slots` flags each reason, and the DNC-after-prepare cancel path.
  - RTL: `dial-status.test.tsx` (labels per state including `failed`, rate-limit countdown and single retry, uncertain state), `client-call-state.test.tsx` (Call click uses `dialLeadAction`, not the panel; softphone fallback when `dialpad` is null; own-queue guard "Open your own queue to call with Dialpad.").
- Rollback: turn `click_to_dial` off so the client falls back to the softphone path (the connection stays active); schema via `supabase/rollbacks/20261006100700_dialpad_api_dial_support.sql` (drop the two connection columns, restore both dial function bodies). The 2.11 `deactivate` mode is the connection-level fallback only. Code revert restores the panel from git (the panel deletion is its own commit for that reason).

#### 2.8 Callback-due alert
- Files: create `20261006100900_my_leads_callbacks_due.sql` + test (+ rollback twin), `_components/callback-due-banner.tsx` (+ test; root element `data-testid="callback-due-banner"`, seam S4); modify `call-state-actions.ts`, `client.tsx`.
- Change.
  - `fn_my_leads_callbacks_due(p_org_id uuid, p_lookahead interval default interval '2 minutes', p_grace interval default interval '60 minutes') returns jsonb` (authenticated, stable; active-member check). Rows from `public.tasks t`: `t.assignee_id = auth.uid()`, `t.next_step_kind = 'appointment'`, `t.mode = 'phone'` (Phase 1a columns), `t.status = 'open'` (snooze is removed by D1 and ignored by the P1b ranking; the effective due is simply `t.due_at`), `t.due_at` within `[now() - p_grace, now() + p_lookahead]`, joined to `properties p` with `p.assigned_user_id = auth.uid()`, not deleted, not `is_dnc_locked`, status not in `closed, dead, dnc`, and an open episode for the member. Item: `{taskId, propertyId, dueAt, title, minutesLate}` ordered by due. Past the 60-minute grace the appointment stays tier 1 "overdue" in Phase 1's strip; the alert is only for "now".
  - `callback-due-banner.tsx`: a banner with the lead name, due time and a **Call** button that runs the same `dialLeadAction` path (2.7) with the first callable slot. `client.tsx` passes `callbacksDue` ids to Phase 1's `call-next-strip.tsx` so those rows sort first and carry the reason "Callback due now" (client-side override; no edit to `fn_get_my_leads_call_next`). No unattended dialing: the banner never calls on its own. The banner and notification render only when the `callback_alert` flag is on and `schemaReady('callbacks_due')` is true (server-side, a missing row reads OFF); the poll skips the callbacks RPC otherwise.
  - Browser notification: `Notification.requestPermission()` is requested only from an explicit "Enable alerts" button click, never on load; a notification is shown only when `Notification.permission === 'granted'`, at most once per `taskId + dueAt`, deduped through `localStorage` wrapped in try/catch with an in-memory fallback.
- Side effects checked: read-only; the two-minute lookahead matches the decision doc; the existing rep reminder sweep `appointment-reminder-sweep` (texts the rep within 30 minutes of due) is untouched.
- Tests: SQL (task due in 90 s returns; 3 min away does not; 59 min late returns, 61 min late does not; `in_person` excluded; other assignee excluded; completed/cancelled excluded; a snoozed row is ignored; DNC-locked and dead leads excluded; anon denied). RTL: banner appears from the poll with the Call button; click dials once and disables; no notification when permission is `default` or `denied`; one notification per task; hidden tab produces no poll and no notification.
- Rollback: turn `callback_alert` off; ships `supabase/rollbacks/20261006100900_my_leads_callbacks_due.sql` (drop the function); remove banner and strip override.

#### 2.9 Hangup-triggered transcript and AI Recap fetch with bounded retries (D5, NB1)
- Files: create `20261006100500_dialpad_artifact_fetches.sql` + test (+ rollback twin; this is the ONLY transcript/Recap fetch job in the plan, Phase 3 adds none), `src/lib/dialpad-cti/artifact-fetch.ts` + test, `src/app/api/cron/dialpad-artifact-sweep/route.ts`; modify `vercel.json`, `routes.test.ts`.
- Change.
  - Table:
    ```sql
    create table public.dialpad_call_artifact_fetches (
      id uuid primary key default extensions.gen_random_uuid(),
      org_id uuid not null references public.organizations(id) on delete cascade,
      call_activity_id uuid not null references public.call_activities(id) on delete cascade,
      provider_call_id text not null check (provider_call_id ~ '^[0-9]{1,20}$'),
      artifact text not null check (artifact in ('transcript','recap','recording_link')),
      state text not null default 'pending' check (state in ('pending','available','unavailable','denied','flagged')),
      attempts smallint not null default 0 check (attempts between 0 and 4),
      ended_at timestamptz not null,
      next_attempt_at timestamptz not null,
      lease_until timestamptz,
      last_attempt_at timestamptz,
      last_error text check (last_error is null or length(last_error) <= 64),
      ready_at timestamptz,
      created_at timestamptz not null default now(),
      unique (org_id, call_activity_id, artifact));
    create index dialpad_artifact_fetches_due_idx on public.dialpad_call_artifact_fetches (next_attempt_at) where state = 'pending';
    alter table … enable row level security; revoke all on table … from public, anon, authenticated; grant select on … to service_role;
    ```
    Readiness is per artifact (`state`/`ready_at`), exactly as D5 requires; the webhook subscription is untouched (`CALL_STATES`, `provisioning.ts:30`, validator `:424-426`), which is the NB1 resolution. Adding `call_transcription` or `recording` states stays a Phase 0 question.
  - Enqueue by trigger, so it is independent of Phase 1's edits to `dialpad_cti_project_intent`: `after insert or update of ended_at, talk_duration_seconds, outcome on public.call_activities for each row when (new.provider = 'dialpad' and new.ended_at is not null and new.provider_call_id is not null and new.call_purpose = 'customer' and (new.outcome in ('unknown','connected_human') or coalesce(new.talk_duration_seconds,0) > 0))` inserts `transcript` and `recap` rows (and `recording_link` when `new.direction='outbound'`) with `ended_at = new.ended_at`, `next_attempt_at = ended_at + 1 minute` (`recording_link`: `ended_at + 10 minutes`), `on conflict do nothing`. No row for no-answer, voicemail (its transcript is on the payload), or training calls.
  - Schedule: attempt n (1-based) is due at `ended_at + (1, 5, 15, 60) minutes`; the offsets are from hangup, not between attempts. `fn_record_dialpad_artifact_result` advances `next_attempt_at` to the next offset; after the fourth non-ready result the state is `unavailable` (terminal). `denied` (401/403: wrong scope or key) is terminal and surfaced; re-queue by hand with `update … set state='pending', attempts=0, next_attempt_at=now() where state='denied'` after the key is fixed.
  - Functions (service role only): `fn_claim_dialpad_artifact_fetches(p_limit integer default 10, p_lease_seconds integer default 120) returns jsonb` (`for update skip locked` on due `pending` rows with `lease_until is null or < now()`, sets `lease_until`, returns `id, org_id, artifact, provider_call_id, call_activity_id, attempts, ended_at`); `fn_record_dialpad_artifact_result(p_id uuid, p_outcome text, p_error text default null, p_text text default null, p_language text default null, p_summary text default null) returns jsonb` where `p_outcome in ('available','not_ready','denied','error')`.
    - Storage reuses the existing `public.call_transcripts` table (`text`, `language`, `summary`, `summary_status`, unique per activity, `20260823010000_jitter_call_artifact_writeback_hardening.sql:69-70`; summary columns `20260822220500_call_transcript_summary.sql`) instead of the new `provider_transcript` / `provider_summary` columns the decision doc names: the AFTER trigger `bump_call_activities_on_child_change` (`…hardening.sql:528-548`) already mirrors `transcript_status`/`summary_status` onto `call_activities`, which the recording library reads (`recording_library_rows`, `c.transcript_status='available'`). Transcript `available` upserts `call_transcripts(status='available', text, language)` keeping any existing summary; recap `available` sets `summary`, `summary_status='available'` on the same row (creating the row with `status='pending'` if the transcript has not landed). Updates are monotonic (never move `available` back to `failed`/`pending`). Phase 3 reads from here; tell the Phase 3 planner.
    - `recording_link`: no provider call. At its due time, if `acquisition_attempts.recording_url` is non-null (the hangup backfill from Phase 1d) → `available`; else → `flagged` (`last_error='missing_link'`) and the job reports it to Sentry. This is the D5 "10-minute sweep flags attempts still missing a link". The KPI `missingRecordings` already counts attempts older than five minutes with no `recording_url`/path, so nothing else changes.
  - TS `artifact-fetch.ts`:
    ```ts
    export interface ArtifactFetchRow { id: string; orgId: string; artifact: 'transcript'|'recap'|'recording_link'; providerCallId: string; callActivityId: string; attempts: number; endedAt: string }
    export interface DialpadArtifactDb { claim(limit: number): Promise<ArtifactFetchRow[]>;
      record(id: string, result: { outcome: 'available'|'not_ready'|'denied'|'error'; error?: string; text?: string; language?: string; summary?: string }): Promise<void>;
      loadKey(orgId: string): Promise<string | null>; }
    export async function fetchDialpadTranscript(input: { callId: string; apiKey: string; fetchImpl?: DialpadDirectoryFetch }): Promise<ArtifactFetchResult>;
    export async function fetchDialpadRecap(input: { callId: string; apiKey: string; fetchImpl?: DialpadDirectoryFetch }): Promise<ArtifactFetchResult>;
    export async function sweepDialpadArtifacts(db: DialpadArtifactDb, deps: { fetchImpl?: DialpadDirectoryFetch; limit?: number }): Promise<{ claimed: number; available: number; notReady: number; denied: number; errors: number }>;
    ```
    Transcript: `GET https://dialpad.com/api/v2/transcripts/{call_id}`. Recap: path from Phase 0 in one constant `DIALPAD_RECAP_PATH`. Parsing uses the Phase 0 captured fixtures; ids are digit-validated before URL construction; int64 ids are never parsed as numbers (same `INT64` quoting trick as `directory.ts:55`). 404 or an empty body → `not_ready`; 401/403 → `denied`; 429 → `not_ready` (backoff via schedule); 5xx, timeout, network → `error` (counts as an attempt, bounded). The key comes from `resolveDialpadDialKey` for the org's connection. Errors stored are status codes only, never bodies.
  - Cron `src/app/api/cron/dialpad-artifact-sweep/route.ts`: first reads the `artifact_fetch` flag and `schemaReady('artifact_fetch')` and returns `{ok:true, disabled:"flag_off"}` before claiming anything (the enqueue trigger is cheap and may fill rows meanwhile; nothing is fetched until the flag is on); same bearer-`CRON_SECRET` handler shape as `dialpad-call-events-sweep/route.ts`, `maxDuration = 60`, `limit` 10 per run, and its own route so a slow Dialpad API cannot starve the event sweep (the event sweep is the revenue-path correctness job and runs under 60 s budget). `vercel.json`: `{ "path": "/api/cron/dialpad-artifact-sweep", "schedule": "*/1 * * * *" }`.
- Side effects checked: `call_transcripts` has a unique index per activity and RLS reading by org members; the new rows are written by service role only; the Jitter writeback RPCs are provider-guarded (`v_activity.provider is distinct from 'jitter'` raises) and are unaffected; Jitter summary billing (broken since Sept 7) is unrelated.
- Tests.
  - SQL (`…artifact_fetches.integration.test.ts`): trigger enqueues for an ended answered outbound call, not for no-answer, voicemail, training, or inbound `recording_link`; a replay of the projection does not duplicate rows; claim respects `skip locked` with two clients and the lease; result recording: `available` writes `call_transcripts` and the activity's `transcript_status`/`summary_status` flip to `available`; `not_ready` advances to the 5, 15, 60-minute offsets and becomes `unavailable` after the fourth; `denied` terminal; monotonic updates; `recording_link` becomes `available` when the link exists at due time and `flagged` otherwise.
  - Unit (`artifact-fetch.test.ts`): status mapping 200/404/401/403/429/5xx/timeout; recap and transcript parse from fixtures (`it.todo` until Phase 0 supplies them); invalid call id never reaches `fetch`; no secret or body in thrown or reported errors; sweep summary counts.
  - Route test: 401 without bearer, 200 with it, hides internals on failure (same shape as `routes.test.ts:33-60`); flag off or schema not ready → no claim RPC call.
- Rollback: ships `supabase/rollbacks/20261006100500_dialpad_artifact_fetches.sql` (`drop trigger` on `call_activities`, drop the functions, drop the table); remove the cron entry and route. Already-written `call_transcripts` rows are valid data.

#### 2.10 Redaction of unmatched call payloads (privacy; required because enabling the subscription captures all of Jarrad's calls)
- Files: create `20261006100800_dialpad_unmatched_event_redaction.sql` + test; modify `event-processing.ts` (`redactUnmatched(olderThanDays)` port method), `dialpad-call-events-sweep/route.ts`.
- Change. The user-scoped subscription delivers every call Jarrad makes or receives, including personal ones; those become `quarantined/no_lead_match` rows whose payload (numbers, caller names, voicemail transcript) the event guard makes undeletable and immutable (`…projection.sql:45-76`: `payload` is outside the mutable list, DELETE raises). Add `redacted_at timestamptz`. Replace `dialpad_cti_guard_event()` in full (base `…projection.sql:45-76`) so `payload` may change only through the redaction function: allow a change of `payload` when `old.disposition='quarantined' and old.disposition_reason in ('no_lead_match','no_binding') and new.redacted_at is not null and old.redacted_at is null and current_setting('dialpad_cti.redact', true) = '1'`. `payload_sha256` is deliberately not recomputed, so a late redelivery of the same event still matches `dialpad_call_events_exact_replay` instead of becoming a conflict row. Function `fn_redact_dialpad_unmatched_events(p_older_than interval default interval '30 days', p_limit integer default 500) returns integer` (service role, sets the GUC with `set_config(…, true)` inside the call): sets `payload = jsonb_build_object('call_id', payload->'call_id', 'state', payload->'state', 'event_timestamp', payload->'event_timestamp', 'direction', payload->'direction', 'redacted', true)` and `redacted_at = now()` for matching rows older than the interval. Matched, ambiguous, DNC and conflict events are never redacted (they are ledger or compliance evidence).
- Side effects checked: the sibling replay list in `fn_process` excludes `no_lead_match`, so nothing reads a redacted payload; `fn_get_dialpad_call_status`, projection and KPIs read only `matched` events.
- Tests: redaction only touches quarantined `no_lead_match`/`no_binding` rows older than the interval; payload keeps only the five keys; matched and `ambiguous_lead` rows untouched; a direct `update … set payload` without the function is rejected; idempotent (second run returns 0); redelivery of a redacted event is detected as an exact replay (no conflict row); cron route calls it and survives failure.
- Rollback: ships `supabase/rollbacks/20261006100800_dialpad_unmatched_event_redaction.sql` (drop the function and restore the old guard); redacted rows stay redacted (intentional).

#### 2.11 Enable the connection last: exact steps with `scripts/provision-dialpad-cti.ts`, plus a `deactivate` mode
- Files: modify `src/lib/dialpad-cti/provisioning.ts`, `provisioning-adapters.ts`, `scripts/provision-dialpad-cti.ts`, `provisioning.test.ts`, `provisioning-adapters.test.ts`.
- Code change (rollback tooling, in the PR). The existing script has `prepare` and `activate` only (`provisioning.ts:849-905`); there is no way back except hand-edited SQL, and the original failure was a connection disabled while Dialpad kept delivering (401 storm, `event-processing.ts:163`). Add `mode: 'deactivate'`: plan steps `deactivate:subscription:<user>` (PATCH `enabled:false`, preserving target and states exactly as `applyActivate` does at `provisioning.ts:887`) executed **before** `deactivate:connection` (new `ConnectionDbPort.deactivateConnection(id, expected)` doing `update … set status='disabled' where id=… and status='active' and <same identity predicate as activateConnection>`), `--confirm-live-readiness <connection id>` required. Same digest, dry-run, refusal and post-check structure as activate.
- Recording endpoint blocker: if the production check in Inputs shows `recording_ingest_endpoint` is already a canonical value, leave `provisioning.ts:650` as is (zero risk). Only if it is null, drop that blocker (`provisioning.ts:650`, and the `recordingEndpointColumn` schema blocker at `:648`) and its tests (`provisioning.test.ts:681-688`, and the endpoint recheck test at `:689`), because the browser capture endpoint no longer has a consumer.
- If Phase 0 shows the directory key lacks dial scope and Jarrad supplies a separate key, add an optional `--dial-key-item` input that adds one `vercel:DIALPAD_CTI_DIAL_KEY_<suffix>` create step through the existing `addSensitiveProductionEnv` port and sets `dial_api_key_ref`; otherwise no change.
- Runbook (operational; do not run until the PR is merged, migrations are applied through the established prod migration workflow, and the Vercel production deploy is READY). All commands run in the Phase 2 worktree; 1Password is reached only through the `op` CLI with the BMH service account (never the SDK); no secret is printed.
  0. Operator data steps, before activation (each preview → Jarrad approves → `--confirm`): `phone-backfill` (2.3) and `ack-legacy-prompts` (2.6) via `scripts/my-leads-housekeeping.mjs`.
  1. Read-only preconditions (Inputs queries): connection row, binding row, episode eligibility. If the binding is not `verified` while the connection is `disabled`, note it: first-time binding needs an active connection (`fn_claim_dialpad_member_binding`), so it happens at step 6, right after activation.
  2. Dry run, prepare mode (expect every step `[reuse]`; a missing subscription shows `[create]`):
     `npx tsx scripts/provision-dialpad-cti.ts --org-id 00000000-0000-0000-0000-000000000bbb --company-id <connection.dialpad_company_id> --canary-user-id <binding.dialpad_user_id>`
     If a step is `[create]`: rerun with `--execute --expect-plan <digest>` (creates the missing object disabled).
  3. Dry run, activate mode: same arguments plus `--mode activate`. It must print no `BLOCKER`/`CONFLICT`; record the digest and the connection id.
  4. [JARRAD] approves the activation window (the script itself requires `--confirm-live-readiness <connection id>`, "after root live-readiness review", `provisioning.ts` run options).
  5. Turn `native_matcher` on first (`node scripts/my-leads-flags.mjs native_matcher on --org <uuid>`; the connection is still disabled, so no events exist yet to be mis-handled; every other consumer flag stays off), then execute: `… --mode activate --execute --expect-plan <digest> --confirm-live-readiness <connection id>`. The script enables each canary subscription, re-reads it, then flips the connection to `active`, then re-observes (`post-check: converged`).
  6. Bind (if needed): load My Leads as Jarrad; `ensureDialpadBindingAction` verifies against the Dialpad directory (2.7). Confirm `dialpad_member_bindings.status='verified'`.
  7. Canary calls, using only Jarrad-owned numbers and one isolated synthetic lead (never a real seller). **One ordered sequence; each consumer flag is enabled immediately before the attended test that needs it, and every test below fails closed if its flag is off.** (a) **Native tests** (`native_matcher` is already on from step 5): dial the synthetic number natively from the Dialpad desktop app, then from the Dialpad mobile app, then a Jarrad-owned non-lead number, then a training lead's number. Expected: native calls → attempt `dialpad-native:…` (the prompt is not yet armed); non-lead number → event `quarantined/no_lead_match`, nothing in the ledger; training lead → `internal_training` activity, no attempt, no prompt. (b) Turn `click_to_dial` on (`my-leads-flags.mjs click_to_dial on`), then Call from the strip once: intent matched, attempt `dialpad-cti:…`. (c) Turn `auto_prompt` on (after `ack-legacy-prompts` has been applied), then re-open `/my-leads` and confirm the prompt opens for the oldest unacknowledged call of (a)/(b) and a skipped prompt stays in "pending outcomes". (d) Turn `callback_alert` on, book a phone appointment due in 2 minutes on the synthetic lead, confirm the banner and one Call. Verify with `select disposition, disposition_reason, count(*) from public.dialpad_call_events where received_at > now() - interval '30 minutes' group by 1,2`.
  8. Compare KPI tiles before and after for Jarrad (`fn_get_acquisition_kpis`): only `attempts`, `pendingOutcomes`, first-call and stage counts for the canary lead change.
  9. Rollback at any step, two layers: first turn the consumer flags off (`callback_alert`, `auto_prompt`, `click_to_dial`, `native_matcher`) with `scripts/my-leads-flags.mjs`; then, only if the connection itself must go, the tested `--mode deactivate --execute --expect-plan <digest> --confirm-live-readiness <connection id>` (subscriptions first, then the connection). Never flip the connection alone, never hand-edit `status`, never run SQL against `dialpad_org_connections`. Each flag stays on only if its attended test in step 7 passed; a failed test turns that flag (and any flag after it) off before the next step.
- Side effects checked: `activateConnection` and its identity predicate (`provisioning-adapters.ts`, `activateConnection`) are untouched; the voice webhook returns 401 and stores nothing for a disabled connection (`event-processing.ts:163`), which is why `deactivate` disables Dialpad's subscription first; the plan digest and `--expect-plan` refusal logic is shared with activate.
- Tests (`provisioning.test.ts`, `provisioning-adapters.test.ts`): deactivate dry-run blockers and refusals; execution order (every subscription disabled and re-read before the connection flips); refusal when identity fields changed; idempotent on an already-disabled connection; post-check convergence; `deactivateConnection` SQL guards (only `active` → `disabled`, identity predicate); no secret in output (existing `noSecrets` helper). If the endpoint blocker is relaxed: the test at `provisioning.test.ts:681` is replaced by "activation proceeds without a recording endpoint".
- Rollback: this item is the rollback mechanism; code revert only removes the extra mode.

---

### Acceptance (what the builder runs before opening the PR)
Typecheck, lint, unit, RTL:
- `npm run typecheck` → 0 errors (includes the hand-added `types.ts` entries).
- `npm run lint` → clean.
- `npm test -- src/lib/dialpad-cti "src/app/(dashboard)/my-leads" src/app/api/cron` → all pass (`*.test.ts`; the Node-env suite excludes `*.test.tsx`).
- `npm run test:rtl -- "src/app/(dashboard)/my-leads"` → all pass (`dial-status`, `use-call-state-poll`, `unassigned-calls-strip`, `callback-due-banner`, `client-call-state`, updated `client.test.tsx`, `page.test.tsx`).
- No stale references: `git grep -nE "DialpadPanel|dialpad-panel|listRecentDialpadCalls|listRecentIntentIds|startDialpadCallAction|dialpad-recording-actions" src` → empty (outside git history).

Migration integration (local-only; the Dialpad integration files replay older SQL and each other, so use two scratch databases):
- Scratch DB A, freshly built from every file in `supabase/migrations` in order (no replay): run the Phase 2 files only:
  `TEST_SUPABASE_DB_URL=postgresql://postgres:postgres@127.0.0.1:54329/<scratch A> npm run test:integration:local -- supabase/migrations/20261006100000_dialpad_ledger_keys_native_columns.integration.test.ts supabase/migrations/20261006100100_dialpad_intent_timeout.integration.test.ts supabase/migrations/20261006100200_contact_phone_numbers.integration.test.ts supabase/migrations/20261006100300_dialpad_native_matching.integration.test.ts supabase/migrations/20261006100400_dialpad_native_assign_to_lead.integration.test.ts supabase/migrations/20261006100500_dialpad_artifact_fetches.integration.test.ts supabase/migrations/20261006100600_call_prompt_acknowledgement.integration.test.ts supabase/migrations/20261006100700_dialpad_api_dial_support.integration.test.ts supabase/migrations/20261006100800_dialpad_unmatched_event_redaction.integration.test.ts supabase/migrations/20261006100900_my_leads_callbacks_due.integration.test.ts`
  Expected: all pass; the 2.1 regression test proves no live definition contains a `dialpad-cti:` literal outside the two helpers.
- Scratch DB B (fresh): the legacy suites must still pass unmodified: `… npm run test:integration:local -- supabase/migrations/20260929034021_dialpad_cti_foundation.integration.test.ts supabase/migrations/20260929120000_dialpad_cti_call_projection.integration.test.ts supabase/migrations/20260929180000_dialpad_cti_dispatch.integration.test.ts supabase/migrations/20260929200000_dialpad_cti_custom_data.integration.test.ts supabase/migrations/20260929210000_dialpad_recording_foundation.integration.test.ts supabase/migrations/20260930031000_dialpad_recording_provider_window_finalizer.integration.test.ts supabase/migrations/20261003130000_my_leads_conflicts_non_retryable.integration.test.ts supabase/migrations/20260927023443_dialpad_cti_kpi_seller_speech.integration.test.ts` (these replay pre-Phase-2 function bodies in `beforeAll`, which is why they cannot share a database with the Phase 2 files).
- Apply the whole migration chain (Phase 1 plus Phase 2) to a fresh database once more with no tests, to prove ordering and idempotent patches: the two anchored-patch migrations must be re-runnable.
- Both new integration file lists are present in `vitest.integration.config.ts` `exclude` and `vitest.local-integration.config.ts` `include` (the hosted suite must not run them).

Canary / preview check (after merge; orchestrator-run; part of 2.11): the training-lead and synthetic-lead sequence in step 7 of the runbook, with expected results listed there. Phase 2 is not "done" until step 7 and step 8 pass or an issue is filed against the failing expectation. No real non-owned seller is ever called.

---

### Risks and open questions
- Size. Ten migrations and a UI rewrite exceed what one reviewer can verify, so Phase 2 ships as three stacked PRs (p2-data-plane: 2.1-2.5 and 2.9; p2-ui: 2.6-2.8, 2.10, 2.11), reviewed by commit group.
- KPI blind spot [JARRAD]. The live KPI counts a Dialpad call toward `conversationsOverFiveMinutes` only when `eligible_dialpad` finds a finalized browser-capture result (`20260930031000_dialpad_recording_provider_window_finalizer.sql:885`, aggregate `exists (select 1 from eligible_dialpad …)`). API-dialed and native calls have no browser capture (the panel and capture path are deleted by D4), so every Dialpad call after Phase 2 counts as zero toward that tile. D10 says KPIs are unchanged, but this makes the tile read zero for the only rep. Options: ⭐ (a) leave KPIs unchanged in this PR and ask Jarrad to approve basing the >5-minute count on Dialpad's own `talk_duration_seconds` for non-captured calls in a follow-up, because changing KPI semantics needs his sign-off; (b) change it now. Default is (a).
- Personal-call exposure. Enabling a user-scoped subscription ingests all of Jarrad's calls. 2.10 redacts unmatched payloads after 30 days (approved 2026-10-04). The event rows (id, call id, state, direction, timestamp) remain.
- Subscription health. Dialpad may have disabled the subscription after the Oct 1 to now 401s; the voice webhook returns 401 for a disabled connection and stores nothing (`event-processing.ts:163`). 2.11 step 2 reads the real state before anything is enabled; never enable the connection before the subscription is verified, and never disable the connection without disabling the subscription first (2.11 `deactivate`).
- Activation order conflicts with "dial before enable". Both `fn_prepare_dialpad_call_intent` and `fn_claim_dialpad_member_binding` require an `active` connection (`…foundation.sql:635`), so API dialing and first-time binding cannot be exercised in prod before activation. All pre-activation proof is local integration plus Phase 0. The PR merges with the connection disabled; the client falls back to the Sandra softphone branch until activation.
- `eligible` episodes. The 15 reassigned leads carry `eligible=false`, and both dial functions required `eligible` (`…foundation.sql:660`, `…dispatch.sql:159`). 2.7 now removes that requirement with anchored patches (open episode and assignee still required). This is a dial-authorization change: flagged for orchestrator review before 2.7 merges.
- Phase 0 contingencies built in but unverified: custom_data round-trip on API-placed calls (2.4 step 4 fallback); `POST /call` may ring all devices including the mobile phone and deskphone (add `device_id` to the request if Phase 0 shows it matters; the column `dial_endpoint='call'` is the switch); `missed` without a following `hangup` would leave an unanswered inbound call "not ended" (no tier-2 signal; adding `missed` as an end marker is a small project-function change if Phase 0 shows it).
- Guessed identifiers I did not verify and flagged for Phase 0: REST `group_type` names, the `email` filter on `GET /api/v2/users`, the AI Recap path, transcript field names. Each sits behind one constant or parser with a fixture test.
- Unresolved decision-doc discrepancies, resolved here without changing intent: 18 literal sites (12 live), not 14 (2.1); several-match uses `quarantined/ambiguous_lead`, not `received`, to avoid the one-minute sweep re-driving it (2.4); transcript and Recap land in the existing `call_transcripts` table, not new `provider_transcript`/`provider_summary` columns (2.9); `failed` is a marker, not a terminal status, so a late event still counts (2.2); "queue" for the 5/min limit is one client-side retry, not a server queue (2.7).
- Phase 1 coupling: the prompt component must expose a close callback so the auto-open can acknowledge on save, skip and dismiss (2.6); Phase 1d's hangup-link columns are read by the 2.6 `outcomeGuess` and 2.9 `recording_link` check (Phase 2 will not apply without them); the `client.tsx` and `page.tsx` edits will conflict textually and need a careful rebase.
- Not changed on purpose: `fn_log_acquisition_attempt` and `RECORDING_REQUIRED` (D5), the event subscription's six states, KPIs, `appointment-reminder-sweep`, `src/lib/dialpad-recording/*` and CSP entries (cleanup later), Telnyx.


---

## Phase 3: Comps, call screen, send-contract card

**Goal.** From one screen, show trustworthy comps and CLOSR anchors, run the Closer Lab script, and send a contract through the existing durable eSign lifecycle, with the offer logged exactly once and only after Dropbox Sign confirms.

**Depends on.** Phase 2 (dial + matching), Phase 1 (1a offer follow-up appointment inside the offer transaction; 1b strip + `fn_get_my_leads_call_next`; 1c `post-call-prompt.tsx`; 1d `call_activities.provider_*` evidence), and the Phase 0 ATTOM outcome (field map, thresholds, ARV method) plus Phase 0 Dropbox template audit (field sources). Buildable against fixtures when no ATTOM key exists (work item 3.2).

**Branch / PR.** Three stacked PRs in header order: `claude/my-leads-p3-comps` (3.1-3.4) based on `claude/my-leads-p2-acceptance` (which is based on `p2-ui`); `claude/my-leads-p3-call-screen` (3.10, with the contract and facts sections hidden) based on p3-comps; `claude/my-leads-p3-send-card` (3.5-3.9, 3.12, which mount them) based on p3-call-screen. PR titles `My Leads Phase 3a: comps provider, fixture, lead_comps`, `My Leads Phase 3b: call screen`, `My Leads Phase 3c: send-contract card, offer projection, AI facts`; each states `Depends on: #<parent PR>`.

**Inputs needed before start.**
- Phase 0 outputs (assumed defaults if absent): ATTOM field map from raw captures (builder uses the captures as test fixtures; until then the mapper in 3.2 is written against the documented ATTOM shape and flagged "unverified"); AVM confidence thresholds (default: `verify_first` when `fsd` > 15 % or fewer than 3 comps or no AVM); ARV method (default `none`: `arv_estimate` stays null, Phase 3 ships without it, D6/B4); Dropbox template audit (default: schema `novation-v1`, unsourced fields become required editable fields).
- Env: `COMPS_PROVIDER` = `attom` | `fixture` | `off` (seam S2; `off` or unset = feature off, mirrors `getSkipTraceProvider`, `src/lib/skip-trace/registry.ts:17-30`); `ATTOM_API_KEY` (absent → builder runs `fixture`); `ANTHROPIC_API_KEY` (already used by `src/lib/norma/callback-time-ai.ts:70`); Dropbox Sign test-mode key (exists in 1Password per decision doc; use the `op` service account only); Dialpad API key carrying `ai_recap` (Phase 0 finding; missing scope degrades to `blocked_scope`, never an error loop).
- Approved 2026-10-04: monthly ATTOM call cap `0` (comps disabled until he sets the Phase 0 spend ceiling); offer follow-up N = 3 days before closing at 09:00 America/Chicago, short-closing fallback below. [JARRAD] defaults assumed if absent: earnest $500; title companies and buyer entities start empty, which blocks Send with "Add a title company in Settings" (no invented defaults); rehab is typed by Jarrad on the call screen (ATTOM has no rehab data).
- Read first: `node_modules/next/dist/docs/01-app/03-api-reference/03-file-conventions/02-route-segment-config/maxDuration.md` (AGENTS.md: this Next 16.3.5 differs from training data); page `params` are Promises (`src/app/(dashboard)/my-leads/page.tsx:127-131` takes `searchParams: Promise<...>`).

**Affected files (for the release lease).**

New migrations (Phase 3 block `20261007100000`–`20261007199999`, sorting after Phase 2's last migration; applied only via the CI migrate workflows, never edit an applied file; each also ships a `supabase/rollbacks/<same timestamp>_<name>.sql` twin with its stated inverse):
- `supabase/migrations/20261007100000_lead_comps_foundation.sql` + `.integration.test.ts`
- `supabase/migrations/20261007110000_acquisition_contract_defaults.sql` + `.integration.test.ts`
- `supabase/migrations/20261007120000_acquisition_offer_projections.sql` + `.integration.test.ts`
- `supabase/migrations/20261007130000_call_facts.sql` + `.integration.test.ts`

New TS (all new):
- `src/lib/comps/{types.ts,index.ts,normalize.ts,anchors.ts,queue.ts,config.ts}`, `src/lib/comps/providers/{attom.ts,fixture.ts}` and `*.test.ts` beside each; `src/lib/comps/__fixtures__/*.json`
- `src/lib/my-leads/offer-projection.ts` (+ test), `src/lib/contract-defaults/{queries.ts,resolve.ts}` (+ tests)
- `src/lib/call-facts/{extract.ts,validate.ts}` (+ tests)
- `src/app/(dashboard)/my-leads/call/[propertyId]/{page.tsx,loaders.ts,actions.ts,call-screen.tsx,static-script-view.tsx,numbers-card.tsx,history-panel.tsx}` and `contract-card/{contract-prefill.ts,contract-card-actions.ts,contract-card.tsx,offer-recovery.tsx}` (+ tests)
- `src/app/(dashboard)/my-leads/_components/{comp-this-lead-button.tsx,offer-conflict-rows.tsx,call-fact-chips.tsx}` (+ tests)
- `src/app/(dashboard)/settings/contract-defaults/{page.tsx,actions.ts,form.tsx}` (+ tests)
- `src/app/api/cron/{comp-queue-drain,offer-projection-sweep,call-facts-sweep}/route.ts` (+ tests; the transcript/Recap fetch cron is Phase 2.9's `dialpad-artifact-sweep`, Phase 3 adds no fetch job)

Modified (all existing):
- `vercel.json` (3 crons), `.env.example` (`COMPS_PROVIDER`, `ATTOM_API_KEY`, `ATTOM_API_BASE_URL`), `vitest.integration.config.ts` (exclude list), `vitest.local-integration.config.ts` (include list), `.github/workflows/e2e.yml` (one step per new integration test, next to line 207)
- `src/lib/coach/script-cache.ts` (add `loadCachedCoachBundle`), `src/lib/supabase/types.ts` (regenerated or hand-added rows)
- `src/lib/my-leads/queries.ts:16`, `src/lib/my-leads/types.ts:27`, `src/app/(dashboard)/my-leads/_components/types.ts:74` (widen outcome union), `_components/queue-row.tsx:337,:526`, `_components/detail-panel.tsx:214` (superseded label)
- Phase 1 files, minimal prop/hook additions only: `_components/post-call-prompt.tsx` (`variant="dock"`, `facts` prop), `_components/call-next-strip.tsx` (render `OfferConflictRows`, add `after()` comp enqueue in its loader), and the one-line "Open call screen" link in `_components/queue-row.tsx` and `src/app/(dashboard)/leads/[id]/page.tsx` header actions.
- Not modified on purpose: `src/components/coach/coach-live-view.tsx`, `src/lib/esign/send-contract.ts`, `src/app/(dashboard)/leads/[id]/lead-esign-action-core.ts`, `lead-esign-bindings.ts`, `lead-esign-actions.ts`.

### Work items (ordered; each independently committable)

#### 3.1 Comps schema, cap ledger, RLS (migration `…_lead_comps_foundation.sql`)
- Files: create the migration and its `.integration.test.ts`; register the test in `vitest.local-integration.config.ts` (include), `vitest.integration.config.ts` (exclude, same as the 20261003120000 entries) and `.github/workflows/e2e.yml` (new step copying lines 201-207).
- Change (all `begin; … commit;`, `search_path = ''` for functions, service-role-only RPC pattern of `reserve_esign_live_send`, `20260902180000_esign_essentials_production_path.sql:1078`):
```sql
create table public.org_comp_settings (
  org_id uuid primary key references public.organizations(id) on delete cascade,
  provider text not null default 'attom' check (provider in ('attom','fixture')),
  auto_comp_enabled boolean not null default false,
  monthly_call_cap integer not null default 0 check (monthly_call_cap between 0 and 100000),
  calls_per_comp integer not null default 3 check (calls_per_comp between 1 and 10),
  est_cents_per_call integer not null default 0 check (est_cents_per_call >= 0),
  ttl_days integer not null default 30 check (ttl_days between 1 and 365),
  manual_refresh_min_hours integer not null default 24 check (manual_refresh_min_hours between 0 and 720),
  arv_method text not null default 'none' check (arv_method in ('none')),   -- ARV is Jarrad's own number (approved 2026-10-04); no derived ARV in v1
  verify_min_comps integer not null default 3,
  verify_max_fsd_pct numeric(5,2) not null default 15,
  updated_by uuid references auth.users(id), updated_at timestamptz not null default now());

create table public.comp_fetch_requests (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references public.organizations(id) on delete cascade,
  property_id uuid not null,
  trigger text not null check (trigger in ('top_ten','manual','repair')),
  requested_by uuid references auth.users(id),
  status text not null default 'queued'
    check (status in ('queued','running','ok','no_match','error','capped','cancelled')),
  reserved_calls integer not null default 0, billed_calls integer not null default 0,
  attempts integer not null default 0,
  error_code text check (error_code is null or error_code ~ '^[A-Z][A-Z0-9_]{0,63}$'),
  lead_comp_id uuid, created_at timestamptz not null default now(),
  started_at timestamptz, finished_at timestamptz,
  constraint comp_fetch_requests_property_org_fkey foreign key (property_id, org_id)
    references public.properties(id, org_id) on delete cascade);
create unique index comp_fetch_requests_open_idx on public.comp_fetch_requests (org_id, property_id)
  where status in ('queued','running');
create index comp_fetch_requests_queue_idx on public.comp_fetch_requests (status, created_at);

create table public.lead_comps (               -- append-only history, latest row wins
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references public.organizations(id) on delete cascade,
  property_id uuid not null,
  provider text not null check (provider in ('attom','fixture')),
  request_id uuid references public.comp_fetch_requests(id) on delete set null,
  fetched_at timestamptz not null default now(),
  as_is_value numeric(14,2) check (as_is_value is null or as_is_value > 0),
  as_is_low numeric(14,2), as_is_high numeric(14,2),
  confidence text check (confidence in ('high','medium','low')),
  confidence_score integer,
  verify_first boolean not null default true, verify_reasons text[] not null default '{}',
  arv_estimate numeric(14,2) check (arv_estimate is null or arv_estimate > 0), arv_method text,
  comps jsonb not null default '[]' check (jsonb_typeof(comps) = 'array'),
  owner_of_record text, legal_description text, legal_description_complete boolean not null default false,
  provider_property_id text, raw jsonb not null default '{}',
  constraint lead_comps_property_org_fkey foreign key (property_id, org_id)
    references public.properties(id, org_id) on delete cascade,
  constraint lead_comps_range_check check (as_is_low is null or as_is_high is null or as_is_low <= as_is_high));
create index lead_comps_property_fetched_idx on public.lead_comps (org_id, property_id, fetched_at desc);

create table public.lead_valuation_inputs (     -- Jarrad's typed ARV (when method none) and rehab
  org_id uuid not null references public.organizations(id) on delete cascade,
  property_id uuid not null, arv numeric(14,2) check (arv is null or (arv > 0 and arv <= 1e12)),
  rehab numeric(14,2) check (rehab is null or (rehab >= 0 and rehab <= 1e12)),
  set_by uuid not null references auth.users(id), set_at timestamptz not null default now(),
  primary key (org_id, property_id),
  foreign key (property_id, org_id) references public.properties(id, org_id) on delete cascade);
```
  - RPCs (service_role only unless noted; `revoke all … from public, anon, authenticated, service_role` then grant):
    - `fn_enqueue_comp_fetch(p_org_id uuid, p_property_id uuid, p_trigger text, p_requested_by uuid) returns jsonb` → `{status:'queued'|'in_flight'|'fresh'|'disabled'|'capped'|'unavailable'}`. Refuses `properties.is_training` and `deleted_at is not null` (`unavailable`); returns `fresh` when the newest `lead_comps` is younger than `ttl_days` (for `trigger='manual'`, younger than `manual_refresh_min_hours`); `disabled` when `monthly_call_cap = 0` or (`trigger='top_ten'` and not `auto_comp_enabled`); `on conflict` on `comp_fetch_requests_open_idx` returns `in_flight`.
    - `fn_claim_comp_fetches(p_limit integer) returns setof public.comp_fetch_requests`: `for update skip locked`, manual first. Per org under `pg_advisory_xact_lock(hashtextextended('comp-cap:' || org_id, 0))` sum `reserved_calls` for requests started in the current America/Chicago month (month start expression copied from `reserve_esign_live_send`, `…esign_essentials_production_path.sql:1086-1090`); if `used + calls_per_comp > monthly_call_cap` set `status='capped'` and skip; else set `running`, `started_at`, `attempts+1`, `reserved_calls = calls_per_comp`.
    - `fn_finish_comp_fetch(p_request_id uuid, p_status text, p_billed_calls integer, p_error_code text, p_lead_comp_id uuid) returns void` (true-up `reserved_calls` to `greatest(billed, 0)`; a timed-out request keeps its reservation).
    - `fn_reap_stuck_comp_fetches() returns integer` (`running` and `started_at < now() - interval '5 minutes'` → `error`/`TIMEOUT`).
    - `fn_set_lead_valuation_inputs(p_org_id uuid, p_property_id uuid, p_arv numeric, p_rehab numeric) returns jsonb` (authenticated; `public.my_leads_workflow_require_actor(p_org_id)`, `20260912120000_acquisition_workflow_commands.sql:24`; upsert).
  - RLS/grants (style of `20260829194500_esign_foundation.sql:666-717` and `20261002120000_norma_call_requests.sql:210-222`): enable RLS on all four tables, policy `for select to authenticated using (public.hugo_has_active_org_access(org_id))`; `revoke all … from public, anon, authenticated, service_role`; `grant select (every column except raw) on public.lead_comps to authenticated` (column grant, as `org_esign_integrations` at `…esign_foundation.sql:702`); `grant select` on the other three to authenticated; `grant select, insert, update, delete` to service_role. Client code must therefore list `lead_comps` columns explicitly (a `select('*')` fails by design).
- Side effects checked: no existing reader touches these tables; `properties.arv`/`repair_estimate` (`src/lib/supabase/types.ts:3216,3265`) are CSV-import columns (alias `avm` → `arv`, `src/lib/csv/aliases.ts:115`) and are NOT inputs to anchors; composite FK to `properties(id, org_id)` matches `acquisition_offers_property_org_fkey` (`…offer_facts.sql:89`); property deletes cascade.
- Tests (`…lead_comps_foundation.integration.test.ts`, loopback pattern of `20261003120000_my_leads_queue_row_lookup.integration.test.ts:12-30`): authenticated member of org A reads A's `lead_comps`, gets 0 rows for org B; selecting `raw` as authenticated is denied; authenticated cannot insert/update any of the tables; `fn_enqueue_comp_fetch` returns `disabled` at cap 0, `fresh` inside TTL, `unavailable` for `is_training`, `in_flight` on a second call; `fn_claim_comp_fetches` marks `capped` when `used + calls_per_comp > cap` and counts only the current Chicago month (insert an old-month row); two concurrent claims never reserve past the cap (two `pg` clients, advisory lock); `fn_set_lead_valuation_inputs` rejects a non-member and negative rehab.
- Rollback: ships `supabase/rollbacks/20261007100000_lead_comps_foundation.sql` (`drop table lead_valuation_inputs, lead_comps, comp_fetch_requests, org_comp_settings cascade` and drop the five functions; no other object references them); safe because nothing outside Phase 3 reads them.

#### 3.2 Comps library: `compLead`, providers, normalisation (TS)
- Files: create `src/lib/comps/{types.ts,config.ts,normalize.ts,queue.ts,index.ts}`, `providers/{attom.ts,fixture.ts}`, fixtures, tests.
- Change. Exported API:
```ts
// types.ts
export type CompProviderName = 'attom' | 'fixture';
export type CompTrigger = 'top_ten' | 'manual' | 'repair';
export type CompSubject = { propertyId: string; orgId: string; address: string; city: string | null; state: string;
  zip: string | null; attomId: string | null; fips: string | null; apn: string | null; sqft: number | null;
  beds: number | null; baths: number | null; yearBuilt: number | null; lat: number | null; lon: number | null };
export type CompSale = { address: string; saleDate: string; salePrice: number; sqft: number | null; beds: number | null;
  baths: number | null; yearBuilt: number | null; distanceMiles: number | null; providerId: string | null;
  renovatedHint: boolean | null };
export type ProviderCompResult = { providerPropertyId: string | null;
  asIs: { value: number | null; low: number | null; high: number | null; score: number | null; fsdPct: number | null };
  comps: CompSale[]; ownerOfRecord: string | null; legal: { text: string | null; complete: boolean };
  billedCalls: number; raw: Record<string, unknown> };
export class CompProviderError extends Error {
  constructor(readonly code: 'AUTH' | 'RATE_LIMIT' | 'NOT_FOUND' | 'TIMEOUT' | 'UPSTREAM' | 'INVALID_RESPONSE',
    readonly billedCalls: number, readonly retryAfterSec?: number) { super(code); } }
export interface CompProvider { readonly name: CompProviderName; readonly callsPerComp: number;
  fetch(subject: CompSubject, signal: AbortSignal): Promise<ProviderCompResult>; }
export type CompLeadResult =
  | { status: 'ready'; compId: string; cached: boolean } | { status: 'pending'; requestId: string }
  | { status: 'capped' } | { status: 'disabled' } | { status: 'no_match' }
  | { status: 'unavailable'; reason: 'training_lead' | 'missing_address' | 'not_found' }
  | { status: 'error'; code: string };
// index.ts
export async function compLead(propertyId: string,
  opts?: { trigger?: CompTrigger; requestedBy?: string | null; inline?: boolean; deps?: CompDeps }): Promise<CompLeadResult>;
export async function drainCompQueue(limit: number, deps?: CompDeps): Promise<{ claimed: number; ok: number; failed: number }>;
export function getCompProvider(env?: Record<string, string | undefined>): CompProvider | null;
```
  - `compLead` (server-only, admin client): load subject from `properties` (`attom_id`, `fips_code`, `apn` exist, `types.ts:3214,3218,3231`); `assertNotTrainingTarget(admin, { propertyId })` (`src/lib/leads/training.ts:33`) → `unavailable:'training_lead'`; call `fn_enqueue_comp_fetch`; map `fresh` → read newest `lead_comps` row (`ready`, `cached:true`); `queued` + `inline` → run `claimOne` immediately with a 25 s deadline and return `ready`/`pending`; otherwise return `pending`. `drainCompQueue` claims via `fn_claim_comp_fetches`, runs the provider with `AbortController` (provider timeout 20 s), then `normalizeProviderResult` → insert `lead_comps` → `fn_finish_comp_fetch`. Provider errors: `RATE_LIMIT` leaves the request `error` with `retryAfterSec` honoured by the next `repair` enqueue (no tight loop), `AUTH` sets `error` and `reportError` once per drain (missing/rotated key must be loud), `NOT_FOUND` → `no_match`.
  - `normalize.ts`: `normalizeProviderResult(r, settings): Omit<LeadCompRow,'id'|'org_id'|'property_id'|'request_id'>`. `confidence`: `high` when `fsdPct <= settings.verify_max_fsd_pct * 0.5`, `medium` up to `verify_max_fsd_pct`, else `low`; null AVM → `low`. `verify_first = true` with reasons `no_avm | wide_range | few_comps | legal_incomplete` per rule (default thresholds in `org_comp_settings`; Phase 0 supplies real numbers, put them in the migration defaults only after Jarrad sets them).
  - No ARV derivation: ARV is Jarrad's own number (approved 2026-10-04; ATTOM-derived ARV not attempted in v1), so there is no `arv.ts` and no `deriveArv`; `lead_comps.arv_estimate` is never written in v1 (stays null) and `org_comp_settings.arv_method` only admits `'none'`. A test asserts `arv_estimate` is null for every stored row.
  - `providers/attom.ts`: `createAttomProvider({ apiKey, baseUrl, fetchImpl }): CompProvider`; header `apikey`, `accept: application/json`; ordered calls: property detail (by `attomid`, else address1/address2), AVM detail, sales comparables; each wrapped in `AbortSignal.any([signal, AbortSignal.timeout(8000)])`; counts `billedCalls` per HTTP request actually sent (including failed ones that were billed); 401/403 → `AUTH`, 429 → `RATE_LIMIT` (with `Retry-After`), 404/empty → `NOT_FOUND`, 5xx → `UPSTREAM`, bad JSON/shape → `INVALID_RESPONSE`. `legal.complete` is `true` only when the legal string is more than a subdivision name (rule decided in Phase 0; default: contains a lot/block/tract token AND length >= 25) — Assigns shows subdivision-only legals (`DECISIONS-2026-10.md` "Assigns.com" pre-read), so this must be conservative.
  - `providers/fixture.ts`: deterministic by `hash(propertyId)`; rows stored with `provider='fixture'`. `getCompProvider` throws `ConfigurationError` when `COMPS_PROVIDER=fixture` and `process.env.VERCEL_ENV === 'production'` with no override (never show invented numbers to the rep); the UI shows a "SAMPLE DATA" ribbon for `provider='fixture'`, and contract prefill ignores fixture legal descriptions.
  - `queue.ts`: `enqueueTopTenComps(orgId: string, propertyIds: readonly string[], trigger: 'top_ten'): Promise<void>` (loops `fn_enqueue_comp_fetch`, ignores non-`queued` outcomes, never throws).
  - Cron `src/app/api/cron/comp-queue-drain/route.ts` (copy the auth/maxDuration shape of `src/app/api/cron/coach-scripts-sync/route.ts:9-27`): first reads the `comp_queue` flag and `schemaReady('lead_comps')` and returns `{ok:true, disabled:"flag_off"}` without claiming anything when either is false; then `fn_reap_stuck_comp_fetches()` then `drainCompQueue(3)`; add `{ "path": "/api/cron/comp-queue-drain", "schedule": "*/2 * * * *" }` to `vercel.json`.
- Side effects checked: provider keys server-only (`import 'server-only'` in `index.ts`/`attom.ts`, never in client bundles); vendor is never on the assignment path (D6); `reportError` from `src/lib/errors/report.ts:15`; mock provider switch mirrors the skip-trace precedent (`registry.ts`).
- Tests: `getCompProvider` returns null for `COMPS_PROVIDER=off` and unset (seam S2); `providers/attom.test.ts` (recorded Phase 0 captures when available, else hand-written fixtures; cases: happy path normalises value/range/comps, 401→AUTH, 429→RATE_LIMIT+retryAfter, timeout aborts and reports billedCalls, malformed JSON→INVALID_RESPONSE, subdivision-only legal → `complete=false`, no AVM → `confidence=low, verify_first`); `index.test.ts` with injected `deps` (supabase admin + provider mocked: fresh cache short-circuits with zero provider calls, cap respected, training lead refused, `fixture` refused in production env, ARV null by default); `normalize.test.ts` (threshold table).
- Rollback: unset `COMPS_PROVIDER` (feature off), remove the cron; code is additive.

#### 3.3 CLOSR anchors with suppression (NN2)
- Files: create `src/lib/comps/anchors.ts` + `anchors.test.ts`.
- Change: `calculateClosr` turns every missing input into 0 (`src/lib/calculators/closr-v1.ts:49` `const n = (key) => i[key] ?? 0`; with `arv = null`, `arv70 = 0` and `offers.feeNNNN = -rehab - NNNN`), so anchors never read its ARV-dependent outputs unless the inputs exist.
```ts
export type AnchorValue = { status: 'ok'; value: number } |
  { status: 'unavailable'; reason: 'no_as_is' | 'no_arv' | 'arv_invalid' | 'no_rehab' };
export type ClosrAnchors = {
  asIsDependent: Record<'equity' | 'family' | 'secure' | 'rapid', AnchorValue>;
  arvDependent: Record<'arv70' | 'investor' | 'fee40000' | 'fee30000' | 'fee20000' | 'fee10000', AnchorValue>;
  verifyFirst: boolean };
export function computeAnchors(i: { asIs: number | null; arv: number | null; rehab: number | null; verifyFirst: boolean }): ClosrAnchors;
```
  Rules: as-is anchors need `asIs > 0` (reason `no_as_is`); ARV-dependent need `arv` finite, `0 < arv <= 1e12` (same bounds as `src/lib/calculators/validation.ts:15`) and `arv >= asIs` when `asIs` is known (else `arv_invalid`), and `rehab != null` (an explicit 0 is a valid entry; null is `no_rehab`). Build `CalculatorInputs = { ...DEFAULT_INPUTS, asIs, arv, rehab }` (`closr-v1.ts:5`), call `calculateClosr` once, then copy only the allowed fields. `arv` source order: `lead_valuation_inputs.arv` (typed) → `lead_comps.arv_estimate` (Phase 0 method) → null. `rehab` only from `lead_valuation_inputs.rehab`. Never from `properties.arv` / `repair_estimate`.
- Side effects checked: pure; no writes; "Open in calculator" link reuses `/calculators` (access `src/lib/calculators/access.ts`) with the lead attached, no snapshot is saved from the call screen.
- Tests: `arv=null` → all `arvDependent` entries `unavailable/no_arv` and none are numbers (explicit assertion that `0` never appears); `rehab=null` with valid arv → `no_rehab`; `arv < asIs` → `arv_invalid`; with all inputs present each value equals `calculateClosr(...)` output for the same inputs (use `src/lib/calculators/worksheet-fixtures.json` rows); the two anchor groups are tested separately: `asIs=null` with a valid `arv` and `rehab` → every as-is anchor `unavailable/no_as_is` while the ARV-dependent anchors are numbers (they only need `arv` and `rehab`, `arv >= asIs` being checked only when `asIs` is known), and `asIs=null, arv=null` → every anchor unavailable.
- Rollback: delete file (unused elsewhere until 3.10).

#### 3.4 Triggers: strip enqueue and "Comp this lead"
- Files: create `src/app/(dashboard)/my-leads/_components/comp-this-lead-button.tsx`, `src/app/(dashboard)/my-leads/call/[propertyId]/actions.ts` (`compLeadAction`); modify the Phase 1b strip loader and `_components/detail-panel.tsx`, `leads/[id]/page.tsx` header (button only).
- Change: `compLeadAction(propertyId: string): Promise<{ ok: true; result: CompLeadResult } | { ok: false; message: string }>` — `myLeadsViewer()` (`src/lib/my-leads/queries.ts:39`) for auth, verify the property is visible through the user's RLS client, then `compLead(propertyId, { trigger: 'manual', requestedBy: viewer.userId, inline: true })`. Strip: in the Phase 1b strip loader call (only when the `comp_queue` flag is on) `after(() => enqueueTopTenComps(viewer.orgId, rowsPropertyIds))` (Next `after`, doc `01-app/03-api-reference/04-functions/after.md`) so the vendor call never blocks the strip render; ten ids per refresh is idempotent (`comp_fetch_requests_open_idx` + TTL). Enqueue only from the `page.tsx` initial load and `refresh(true)`; the 30-second poll passes `enqueueComps:false` (so there is no "first load of a new top-ten membership" to detect; the TTL check makes repeats free). The comp button carries `data-testid="comp-this-lead-<propertyId>"` (seam S4).
- Readiness (`lead_comps`): `compLeadAction` and the comp loaders return the disabled state unless `schemaReady('lead_comps')` is true. Side effects checked: the cap RPC is the only spend control; nothing in the Phase 1b strip SQL changes.
- Tests: `comp-this-lead-button.test.tsx` (pending → polls `loadComps` every 5 s, shows "comps pending", then numbers; capped/disabled copy); `actions.test.ts` (non-member rejected, training lead refused, `inline` result mapping).
- Rollback: remove the `after()` line and the button.

#### 3.5 Contract defaults schema + settings UI (migration `…_acquisition_contract_defaults.sql`)
- Readiness (`contract_defaults`): the settings page and `resolve.ts` return empty defaults (Send stays blocked) unless `schemaReady('contract_defaults')` is true.
- Files: migration + integration test (register as in 3.1); `src/lib/contract-defaults/{queries.ts,resolve.ts}`; `src/app/(dashboard)/settings/contract-defaults/{page.tsx,actions.ts,form.tsx}`.
- Change (DDL):
```sql
create table public.acquisition_contract_title_companies (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references public.organizations(id) on delete cascade,
  name text not null check (btrim(name) <> ''),
  closing_agent_name text not null, closing_agent_phone text, closing_agent_address text, closing_agent_email text,
  is_active boolean not null default true, created_at timestamptz not null default now(),
  constraint acquisition_contract_title_companies_id_org_key unique (id, org_id));
create table public.acquisition_contract_buyer_entities (
  id uuid primary key default gen_random_uuid(), org_id uuid not null references public.organizations(id) on delete cascade,
  name text not null check (btrim(name) <> ''), phone text, email text, attorney_in_fact text,
  is_active boolean not null default true, created_at timestamptz not null default now(),
  constraint acquisition_contract_buyer_entities_id_org_key unique (id, org_id));
create table public.acquisition_contract_settings (
  org_id uuid primary key references public.organizations(id) on delete cascade,
  earnest_money_cents bigint not null default 50000 check (earnest_money_cents >= 0),
  follow_up_days_before_closing integer not null default 3 check (follow_up_days_before_closing between 1 and 60),
  follow_up_hour_central smallint not null default 9 check (follow_up_hour_central between 0 and 23),
  default_title_company_id uuid, default_buyer_entity_id uuid,
  template_field_defaults jsonb not null default '{}'::jsonb check (jsonb_typeof(template_field_defaults) = 'object'),
  updated_by uuid references auth.users(id), updated_at timestamptz not null default now(),
  foreign key (default_title_company_id, org_id) references public.acquisition_contract_title_companies(id, org_id),
  foreign key (default_buyer_entity_id, org_id) references public.acquisition_contract_buyer_entities(id, org_id));
create table public.acquisition_contract_title_market_defaults (
  org_id uuid not null references public.organizations(id) on delete cascade,
  market text not null check (market in ('Kansas City','St. Louis','Dayton','Lake of the Ozarks')), -- properties.market domain, 001_initial.sql:143
  state_code text check (state_code is null or state_code ~ '^[A-Z]{2}$'),                         -- KS vs MO side of Kansas City
  title_company_id uuid not null,
  foreign key (title_company_id, org_id) references public.acquisition_contract_title_companies(id, org_id));
create unique index acquisition_contract_title_market_defaults_key
  on public.acquisition_contract_title_market_defaults (org_id, market, coalesce(state_code, ''));
```
  RLS/grants: all four enable RLS; `select` to authenticated `using (public.hugo_has_active_org_access(org_id))`; insert/update/delete to authenticated `using/with check (public.esign_is_active_org_owner(org_id))` (exactly `org_esign_integrations_*`, `…esign_foundation.sql:666-679`); `revoke all … from public, anon` then `grant select, insert, update, delete … to authenticated`; service_role all. `template_field_defaults` keys are validated in TS against `ESIGN_NOVATION_FIELD_NAMES`/`ESIGN_RESIDENTIAL_FIELD_NAMES` (`src/lib/esign/contracts.ts:31-45`), not in SQL.
  - `resolve.ts`: `resolveTitleCompany(defaults, { market, state }): TitleCompany | null` order = exact (market, state) → (market, null) → `default_title_company_id` → null (picker required). Inactive companies are excluded from pickers but remain referenced by historical requests (they snapshot values in `esign_requests.merge_value_snapshot`).
  - Settings page: owner-only (`getSingleActiveMembership().role === 'owner'`, same gate idea as `settings/esign-templates`), CRUD for the three lists, market-default grid, earnest cents, follow-up N/hour, and a validated JSON-lines editor for `template_field_defaults`.
- Side effects checked: nothing reads these before 3.9; no change to `org_esign_integrations`.
- Tests (integration): non-owner member can select but cannot insert/update/delete; cross-org isolation; composite FKs reject a title company from another org; the market-default unique index treats `state_code null` once. Unit: `resolve.test.ts` (4 resolution tiers, inactive excluded), `actions.test.ts` (non-owner rejected, invalid field-name key rejected).
- Rollback: ships `supabase/rollbacks/20261007110000_acquisition_contract_defaults.sql` (drop the four tables); UI route removal.

#### 3.6 Offer projection, `superseded`, recovery RPCs (migration `…_acquisition_offer_projections.sql`)
This is the correctness core (D8, B3). Design points the builder must not change without review:
1. One table, keyed on the eSign request, but the row is created BEFORE the request exists (the request id is generated inside `create_esign_request`, `lead-esign-bindings.ts:541`), so it carries `send_intent_id` and is linked to `esign_requests.id` by trigger on insert. A thrown `SEND_UNKNOWN` result does not return the request id (`lead-esign-action-core.ts:586-593`), so linking by intent is the only reliable join.
2. `esign_requests.delivery_state` reaches `'sent'` through several writers (`reconcile_esign_request_delivery`, `20260902010000_esign_dialog_seller_email_authority.sql:431`; positive resolution `20260902030000_esign_send_unknown_positive_resolution.sql:206`; bounce recovery `20260902111000_esign_email_bounce_recovery.sql:432`), so the hook is a trigger, never code in `send()`. The trigger only flips `awaiting_send → pending`; it must NEVER call the offer RPC, otherwise an offer rejection would roll back the eSign confirmation.
3. `fn_log_acquisition_offer` requires `auth.uid()` (`my_leads_workflow_require_actor`, `20260912120000_acquisition_workflow_commands.sql:24-44`), and cron/service code has no user session. The runner is a service-role-only `security definer` function that sets `request.jwt.claim.sub` to the stored actor for the duration of the transaction (the same GUC the existing integration tests use, `20261003120000_my_leads_queue_row_lookup.integration.test.ts:32`) and restores it. The actor must still pass the offer RPC's own active-membership, owner-or-assignee, DNC and stage checks.
4. CAS values (episode, queue version, shared status) are read INSIDE the runner after locking property → queue state → episode (same order as `fn_log_acquisition_offer`, `20261003130000_my_leads_conflicts_non_retryable.sql:700-745`) instead of reusing the values captured at Send click. Between Send and `sent` (minutes, or hours via `send_unknown`) the queue version legitimately moves (attempt logged, note, etc.); replaying stale CAS would manufacture permanent `STALE_STATE` conflicts. Real conflicts (reassigned away from a non-owner, terminal status, a pending offer, DNC) are still raised by the offer RPC itself.
- Files: migration + integration test (register as in 3.1).
- Change.
  - Widen the outcome (superseded). `20260912090200_acquisition_attempt_offer_facts.sql:101-105`:
```sql
alter table public.acquisition_offers drop constraint acquisition_offers_outcome_check;
alter table public.acquisition_offers add constraint acquisition_offers_outcome_check check (
  (outcome = 'pending' and outcome_at is null and outcome_by is null)
  or (outcome in ('accepted','declined','superseded') and outcome_at is not null and outcome_by is not null)) not valid;
alter table public.acquisition_offers validate constraint acquisition_offers_outcome_check;
```
    `acquisition_offers_pending_property_idx` (`…offer_facts.sql:111`) is partial on `outcome = 'pending'`, so superseding frees the slot with no index change. `fn_decline_acquisition_offer` / `fn_record_acquisition_contract` both require `outcome = 'pending'` (`20261003130000…:886,:965`) so a superseded offer can never be accepted or declined afterwards.
  - Table and state machine:
```sql
create table public.acquisition_offer_projections (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references public.organizations(id) on delete cascade,
  property_id uuid not null,
  actor_user_id uuid not null references auth.users(id) on delete restrict,
  send_intent_id uuid not null,
  request_hash text not null,                 -- sha256 of the canonical send payload (template, signers, merge values, price, date, motivation, temperature); a replay must match it
  esign_request_id uuid,
  amount_cents bigint not null check (amount_cents > 0),
  closing_date date not null,
  motivation_kind text check (motivation_kind in ('specified','no_motivation')), motivation_text text,
  temperature text check (temperature in ('hot','warm','cold')),
  state text not null default 'awaiting_send'
    check (state in ('awaiting_send','pending','logged','conflict','failed','cancelled')),
  resolution text check (resolution in ('auto','superseded_prior_offer','reassigned','contract_cancelled','send_failed','never_claimed')),
  conflict_code text, attempts integer not null default 0, next_attempt_at timestamptz, last_error_code text,
  sent_at timestamptz, follow_up_at timestamptz, offer_id uuid references public.acquisition_offers(id) on delete set null,
  logged_at timestamptz, resolved_by uuid references auth.users(id), resolved_at timestamptz, alerted_at timestamptz,
  created_at timestamptz not null default now(), updated_at timestamptz not null default now(),
  foreign key (property_id, org_id) references public.properties(id, org_id) on delete cascade,
  foreign key (esign_request_id, org_id) references public.esign_requests(id, org_id),
  check (state <> 'logged' or offer_id is not null),
  check (state <> 'conflict' or conflict_code is not null),
  check (state <> 'pending' or (esign_request_id is not null and sent_at is not null)));
create unique index acquisition_offer_projections_intent_idx on public.acquisition_offer_projections (org_id, send_intent_id);
create unique index acquisition_offer_projections_request_idx on public.acquisition_offer_projections (org_id, esign_request_id) where esign_request_id is not null;
create unique index acquisition_offer_projections_open_property_idx on public.acquisition_offer_projections (org_id, property_id)
  where state in ('awaiting_send','pending','conflict');
```
    State map (decision doc "pending → logged | conflict" plus the pre-sent and terminal-failure states): `awaiting_send` (intent recorded; request sending/`send_unknown`) → `pending` (request `sent`) → `logged` | `conflict`; `conflict` → `logged` (supersede / reassign+retry) | `cancelled` (signature request voided); `awaiting_send` → `failed` (request `failed`, or never claimed after 15 min) . The open-per-property index means a second contract cannot be sent while one is awaiting, pending or unreconciled, and a `send_unknown` request keeps blocking until the existing reconciliation resolves it (never re-sent).
  - Triggers on `public.esign_requests`, both `security definer set search_path = ''` and each body wrapped in `begin … exception when others then raise warning 'offer projection trigger: %', sqlerrm; end` so a bug here can never block an eSign transition:
    - `trg_offer_projection_link` AFTER INSERT: `update … set esign_request_id = new.id where org_id = new.org_id and send_intent_id = new.send_intent_id and esign_request_id is null`; if no row matched and `new.retry_of_request_id is not null`, insert a copy of the parent's projection when the parent projection is `failed`/`send_failed` (state `awaiting_send`, `send_intent_id = new.send_intent_id`, `actor_user_id = new.created_by`) so lead-page Retry (`retry()`, `lead-esign-action-core.ts:651`) of a card-originated send still logs its offer.
    - `trg_offer_projection_state` AFTER UPDATE OF delivery_state, status, void_requested_at: `new.delivery_state = 'sent'` → `awaiting_send → pending` (`sent_at = new.sent_at`, `next_attempt_at = now()`); `new.delivery_state = 'failed'` → `awaiting_send → failed/send_failed`; `(new.void_requested_at is not null or new.status = 'voided')` → `pending|conflict → cancelled/contract_cancelled`. `logged` rows are never touched (the offer stays; the rep declines it normally).
  - Pure helper `public.contract_follow_up_at(p_closing date, p_sent_at timestamptz, p_days integer, p_hour smallint) returns timestamptz` (immutable): `target = (closing − days) at hour, Central`; if `target <= p_sent_at`, the next calendar day 09:00 Central after `p_sent_at` (the approved wording). This satisfies `follow_up_at > sent_at` (`20261003130000…:682`) and N9's N/fallback.
  - `fn_create_offer_projection(p_org_id uuid, p_property_id uuid, p_actor uuid, p_send_intent_id uuid, p_request_hash text, p_amount_cents bigint, p_closing_date date, p_motivation_kind text, p_motivation_text text, p_temperature text) returns uuid` — service_role only; verifies actor is an active member (`memberships` predicate as `my_leads_workflow_require_actor`), property in org and not `is_training`; an existing row for the same `(org, send_intent_id)` returns its id only if actor, `request_hash`, amount and date match, else `raise exception 'IDEMPOTENCY_CONFLICT' using errcode = '40001'`; a `23505` on `…open_property_idx` is allowed to surface (caller maps it to `OPEN_CONTRACT_EXISTS`).
  - Runner `public.fn_offer_projection_run(p_projection_id uuid, p_actor uuid, p_persist_conflict boolean) returns jsonb` (no grants; only the wrappers below call it). Key body:
```sql
select * into v_p from public.acquisition_offer_projections where id = p_projection_id for update;
if v_p.state in ('logged','cancelled','failed') then return jsonb_build_object('state', v_p.state, 'offerId', v_p.offer_id); end if;
if v_p.state = 'awaiting_send' then return jsonb_build_object('state','awaiting_send'); end if;
if v_p.state = 'conflict' and p_persist_conflict then return jsonb_build_object('state','conflict','code',v_p.conflict_code); end if;
select * into v_req from public.esign_requests where id = v_p.esign_request_id and org_id = v_p.org_id;
if v_req.delivery_state <> 'sent' or v_req.sent_at is null or v_req.sign_request_id is null then
  update … set state = 'awaiting_send' …; return jsonb_build_object('state','awaiting_send'); end if;
if v_req.void_requested_at is not null or v_req.status = 'voided' then … set state='cancelled', resolution='contract_cancelled' … end if;
-- amount guard: never log an amount that differs from the document that was sent
v_doc_cents := (regexp_replace(v_req.merge_value_snapshot ->> 'offer_price', '[^0-9.]', '', 'g')::numeric * 100)::bigint;
if v_doc_cents is distinct from v_p.amount_cents then … conflict 'AMOUNT_MISMATCH' end if;
select * into v_prop from public.properties where id = v_p.property_id and org_id = v_p.org_id for update;      -- lock order
select * into v_queue from public.acquisition_queue_states where org_id = v_p.org_id and property_id = v_p.property_id for update;
select * into v_episode from public.acquisition_assignment_episodes where org_id = v_p.org_id and property_id = v_p.property_id and ended_at is null for update;
if not found then conflict 'STALE_ASSIGNMENT'; end if;
v_prev := current_setting('request.jwt.claim.sub', true);
perform set_config('request.jwt.claim.sub', p_actor::text, true);
begin
  v_result := public.fn_log_acquisition_offer(v_p.org_id, v_p.property_id, v_episode.id, coalesce(v_queue.version, 0),
    v_prop.status, v_p.id, v_p.amount_cents, 'dropbox_sign', v_req.sent_at, v_follow, v_p.motivation_kind,
    v_p.motivation_text, v_p.temperature);   -- 13-arg overload; idempotency key = projection id
exception when others then
  perform set_config('request.jwt.claim.sub', coalesce(v_prev, ''), true);
  v_code := sqlerrm;
  if v_code in ('STALE_STATE','STALE_ASSIGNMENT','PENDING_OFFER_EXISTS','DNC_LOCKED','FORBIDDEN','FEATURE_DISABLED',
                'NOT_FOUND','INVALID_INPUT','UNAUTHENTICATED','IDEMPOTENCY_CONFLICT') then
    if not p_persist_conflict then raise; end if;
    update … set state = 'conflict', conflict_code = v_code, last_error_code = v_code, updated_at = now() …; return conflict;
  end if;
  if not p_persist_conflict then raise; end if;   -- atomic recovery mode: a transient failure rethrows too
  update … set attempts = attempts + 1, last_error_code = left(v_code, 64),
    next_attempt_at = now() + (least(attempts + 1, 10) * interval '1 minute'),
    state = case when attempts + 1 >= 12 then 'conflict' else state end,
    conflict_code = case when attempts + 1 >= 12 then 'PROJECTION_RETRY_EXHAUSTED' end … ; return pending/conflict;
end;
perform set_config('request.jwt.claim.sub', coalesce(v_prev, ''), true);
update … set state = 'logged', offer_id = (v_result ->> 'offerId')::uuid, logged_at = now(),
  follow_up_at = v_follow, resolution = coalesce(resolution, 'auto') …;
```
    **Atomic recovery mode (`p_persist_conflict = false`, used only by the supersede wrapper):** every unsuccessful outcome rethrows and nothing is persisted: the listed business errors (above), every transient error (the handler line above), and every early return that is not `logged` (`awaiting_send`, `pending`-but-not-sent, `cancelled`, `failed`, `conflict`) which raises `PROJECTION_NOT_LOGGED` (errcode `40001`). The caller therefore receives a result only when the state is `logged`, and the surrounding transaction rolls back the supersession and the task cancellation on any other path. `v_follow` is computed once from `acquisition_contract_settings` (defaults 3 / 9 if no row) and stored in `follow_up_at` on the first attempt so retries replay identical arguments. `set local lock_timeout = '3s'` at the top. The `exception` sub-block rolls back everything the offer RPC did; the projection update lives in the outer transaction, so "offer written but projection not updated" is impossible.
    Phase 1a contract (cross-phase): Phase 1a amends `fn_log_acquisition_offer` to create the "Offer follow-up" appointment from `p_follow_up_at` in the same transaction (decision doc Phase 1a). Plpgsql binds the call by name at run time, so this migration is correct against any Phase 1a body as long as the 13-arg signature is kept; if Phase 1a changes the argument list, adapt only the single call above.
  - Wrappers: `fn_project_acquisition_offer(p_projection_id uuid) returns jsonb` (service_role; actor = `actor_user_id`, `p_persist_conflict = true`); `fn_retry_offer_projection(p_org_id uuid, p_projection_id uuid) returns jsonb` (authenticated; caller must be owner or the lead's current assignee; sets `conflict → pending`, `attempts = 0`, runs with `auth.uid()` as actor); `fn_offer_projection_repair() returns integer` (service_role; flips `awaiting_send` rows whose request is already `sent`/`failed`, abandons unlinked rows older than 15 minutes as `failed/never_claimed`); `fn_offer_projection_due(p_limit integer) returns setof uuid` (pending and `next_attempt_at <= now()`, `for update skip locked`).
  - Recovery 1 (supersede): `fn_supersede_offer_and_log(p_org_id uuid, p_projection_id uuid, p_idempotency_key uuid) returns jsonb` (authenticated; `my_leads_workflow_require_actor`; owner or lead assignee else `FORBIDDEN`). Body: replay via `my_leads_workflow_replay(p_org_id, 'supersede_acquisition_offer', key, actor, hash)`; lock projection, require `state='conflict' and conflict_code='PENDING_OFFER_EXISTS'` else `raise exception 'STALE_STATE' using errcode = 'MLS01'`; lock property, then the pending offer; require `pending.sent_at < projection.sent_at` (never supersede an offer made after the contract was sent); `update acquisition_offers set outcome='superseded', outcome_at=statement_timestamp(), outcome_by=actor, updated_at=statement_timestamp()`; no task call is made: setting `outcome='superseded'` fires 1a.6 trigger 3, which cancels the stale offer's chain open task (`cancelled/cancelled`); `v_run := fn_offer_projection_run(p_projection_id, actor, false)` and **require `v_run ->> 'state' = 'logged'` before anything else is committed** (otherwise `raise exception 'PROJECTION_NOT_LOGGED' using errcode = '40001'`); a second conflict, a transient failure or any non-logged state therefore re-raises and rolls back the supersession and the stale offer's task cancellation, so the old offer can never be superseded without its replacement logged; insert `acquisition_commands` (`operation='supersede_acquisition_offer'`, same pattern as `20260912150000_acquisition_workflow_stress_guards.sql:73-80`), `my_leads_workflow_append_event`, set `resolution='superseded_prior_offer'`, `resolved_by`, `resolved_at`. Returns `{ok, duplicate, offerId, supersededOfferId}`.
  - Recovery 2 (reassign and log): TS composition in 3.7 (`updateLeadAssignee(propertyId, projection.actor)` at `src/app/(dashboard)/leads/actions.ts:2293`, which already enforces DNC and active-assignee rules and writes the lead event) followed by `fn_retry_offer_projection`; idempotent because `updateLeadAssignee` is a no-op when already assigned and the retry is a no-op once `logged`. Sets `resolution='reassigned'` when it logs.
  - Recovery 3 (cancel the signature request): existing `voidContractAction` → `requestVoid` (`lead-esign-action-core.ts:979`); `trg_offer_projection_state` then moves the row to `cancelled`. No new RPC.
  - `fn_list_offer_conflicts(p_org_id uuid, p_member_id uuid) returns jsonb` (authenticated, `my_leads_workflow_require_actor`; owner sees all, a member only leads assigned to them): rows `{projectionId, propertyId, address, conflictCode, requestId, sentAt}` for the strip.
  - RLS/grants: enable RLS; `select` to authenticated `using (public.hugo_has_active_org_access(org_id))`; no direct writes for authenticated; service_role all. All functions `revoke all … from public, anon, authenticated, service_role` then explicit grants (authenticated: the three recovery/read RPCs; service_role: create/project/repair/due).
- Side effects checked: offer readers that pass `outcome` through — `20260912110000_acquisition_read_model.sql:69`, `20261003120000_my_leads_queue_row_lookup.sql:52`, `20260912113000_acquisition_detail.sql:12`, `20260913230000_lead_acquisition_history.sql:20` (they select the latest offer by `sent_at`; after a supersede the new offer is latest because the guard above forces `new.sent_at > stale.sent_at`); KPI `offersSent` counts rows by `actor_user_id`/`sent_at` (`20260912111000_acquisition_kpis.sql:57`) so a superseded stale offer AND the new offer both count (both were real sends) — default, no KPI SQL change [JARRAD to confirm]; `acquisition_offers` has no mutation triggers (grep: none); rollback guard in `20260912140000_acquisition_launch_commands.sql:749` counts offers per launch episode, unaffected; `esign_requests` writers keep working because the triggers swallow their own errors.
- Tests (`…offer_projections.integration.test.ts`; copy fixture setup from `20261003130000_my_leads_conflicts_non_retryable.integration.test.ts`: org, owner, enabled rep, property with episode and queue state at `needs_offer`, an `esign_templates` + `esign_requests` row via the SQL the esign foundation tests use):
  - `superseded` insert passes; `superseded` without `outcome_by` fails; `accept`/`decline` RPC on a superseded offer raises `STALE_STATE`.
  - offer-logged-after-sent: create projection (`awaiting_send`), insert request `sending` → linked, no `acquisition_offers` row; call `reconcile_esign_request_delivery` as service role → projection `pending`; `fn_project_acquisition_offer` → `logged`, exactly one offer with `sent_via='dropbox_sign'`, `sent_at = esign_requests.sent_at`, property `offer_sent`, queue stage `offer_sent`; second call returns the same offer (idempotent, `count(*) = 1`).
  - send_unknown path: request `send_unknown` → still `awaiting_send`, zero offers; resolve to sent via the positive-resolution function → `pending` → logged once.
  - failed path: request `failed` → projection `failed/send_failed`, zero offers, open-property slot freed; retry request insert copies the projection.
  - concurrent mutation (two `pg` clients): client A locks the property row and sets status `closed`, commits; runner → `conflict/STALE_STATE`; separate cases for pre-existing pending offer (`PENDING_OFFER_EXISTS`), rep reassigned away and actor non-owner (`STALE_ASSIGNMENT`), DNC lock (`DNC_LOCKED`), and a queue-version bump between Send and `sent` that must still log successfully (CAS re-read).
  - atomic supersede under failure: inject a transient failure (a stubbed `fn_log_acquisition_offer` that raises a non-listed error) after the stale offer has been set `superseded` inside `fn_supersede_offer_and_log`: the call raises, the stale offer is still `pending`, its follow-up task is still open, no `acquisition_commands` row exists, the projection is still `conflict`; a runner state other than `logged` does the same.
  - recovery without resend: from `PENDING_OFFER_EXISTS`, `fn_supersede_offer_and_log` → old offer `superseded`, new offer `pending`, projection `logged/superseded_prior_offer`, the stale offer's open "Offer follow-up" task is `cancelled` with outcome `cancelled` (fired by the 1a.6 trigger, not by a helper call), exactly one `esign_requests` row whose `delivery_state`, `sign_request_id` and `updated_at` did not change; replay with the same key returns `duplicate:true`; supersede as a non-owner non-assignee → `FORBIDDEN`; supersede when `pending.sent_at >= projection.sent_at` → `STALE_STATE`; reassign path (`fn_retry_offer_projection` after changing `assigned_user_id`) logs; void marks `cancelled`.
  - impersonation hygiene: `current_setting('request.jwt.claim.sub')` is restored after the runner; a runner failure inside the sub-block leaves no `acquisition_commands` row; retry exhaustion (12 transient failures simulated by a renamed function stub) → `conflict/PROJECTION_RETRY_EXHAUSTED`.
  - `contract_follow_up_at` table test: normal case, closing too soon (fallback next morning), closing tomorrow, closing today, DST boundary (2026-11-01 and 2027-03-14 Chicago).
  - RLS: other-org member selects 0 rows; authenticated cannot insert/update; non-service role cannot call `fn_project_acquisition_offer`.
- Rollback: ships `supabase/rollbacks/20261007120000_acquisition_offer_projections.sql` (drop triggers, functions, then the projection table); restore the original outcome check only if no `superseded` rows exist (`update` them to `declined` is NOT allowed: supersession is never recorded as a decline), otherwise leave the widened constraint (additive and harmless).

#### 3.7 Offer projection server library, sweep cron, `superseded` in TS
- Files: create `src/lib/my-leads/offer-projection.ts`, `src/app/api/cron/offer-projection-sweep/route.ts` (+ tests); modify `src/lib/my-leads/queries.ts:16`, `src/lib/my-leads/types.ts:27`, `_components/types.ts:74`, `_components/queue-row.tsx:337,:526`, `_components/detail-panel.tsx:214`, `vercel.json`.
- Change. Signatures (server-only, admin client except where noted):
```ts
export type OfferPrecheck =
  | { ok: true; queueVersion: number; episodeId: string; motivationRecorded: boolean }
  | { ok: false; code: 'NOT_IN_QUEUE' | 'STALE_STATE' | 'PENDING_OFFER_EXISTS' | 'DNC_OR_UNAVAILABLE' | 'FEATURE_DISABLED' | 'OPEN_CONTRACT_EXISTS'; message: string };
export async function precheckOffer(viewer: { userId: string; orgId: string; client: SupabaseClient }, propertyId: string): Promise<OfferPrecheck>;
export type ExistingOfferIntent = { projectionId: string; actorUserId: string; requestHash: string; state: 'awaiting_send' | 'pending' | 'logged' | 'conflict' | 'failed' | 'cancelled'; esignRequestId: string | null; offerId: string | null };
/** Resolve a supplied send intent BEFORE any new-send precheck: null when it is genuinely new. */
export async function resolveOfferIntent(viewer: { userId: string; orgId: string; isOwner: boolean; client: SupabaseClient }, sendIntentId: string): Promise<ExistingOfferIntent | null>;
export async function createOfferIntent(input: { orgId: string; propertyId: string; actorUserId: string; sendIntentId: string; requestHash: string;
  amountCents: number; closingDate: string; motivation: AcquisitionMotivationResponse | null; temperature: AcquisitionTemperature }): Promise<{ projectionId: string } | { error: 'OPEN_CONTRACT_EXISTS' | 'IDEMPOTENCY_CONFLICT' | 'FAILED' }>;
export async function projectOfferNow(projectionId: string): Promise<{ state: 'awaiting_send' | 'pending' | 'logged' | 'conflict' | 'failed' | 'cancelled'; offerId?: string; code?: string }>;
export async function sweepOfferProjections(limit?: number): Promise<{ repaired: number; projected: number; conflicts: number }>;
```
  `precheckOffer` is for **genuinely new intents only**: it must never run for a send intent that already has a projection, because that projection (open, or the pending offer it produced) would itself make it return `OPEN_CONTRACT_EXISTS` or `PENDING_OFFER_EXISTS` and a lost-response replay could never reach the durable eSign replay path. `precheckOffer` uses `getMyLeadsQueueRow({ memberId: viewer.userId, propertyId })` (`queries.ts:82`): `status:'unavailable'` → `NOT_IN_QUEUE`/`DNC_OR_UNAVAILABLE` per `reason`; `row.sharedStatus` in `offer_declined|under_contract|closed|dead` or `row.stage === 'under_contract'` → `STALE_STATE`; `row.offer?.outcome === 'pending'` → `PENDING_OFFER_EXISTS`; `row.motivationKind == null` → `motivationRecorded:false` (the offer RPC raises `INVALID_INPUT` without a motivation response, `…non_retryable.sql:765`, so the card must collect one); an open projection (select via RLS client) → `OPEN_CONTRACT_EXISTS`. `FEATURE_DISABLED` from `MyLeadsReadError`. These mirror the RPC's own rejections (`STALE_STATE`, `STALE_ASSIGNMENT`, `PENDING_OFFER_EXISTS`, `DNC_LOCKED`) so most never happen after Send; the runner still handles them.
  `sweepOfferProjections`: first the `offer_projection` flag and `schemaReady('offer_projection')` (off or not ready → `{repaired:0, projected:0, conflicts:0, disabled:'flag_off'}` with no RPC call), then `fn_offer_projection_repair()`, then `fn_offer_projection_due(10)` → `fn_project_acquisition_offer` each (separate transactions); `reportError` once per conflict older than 60 min (`alerted_at` set) with tag `surface: 'offer_projection_conflict'`. Cron route copies `coach-scripts-sync/route.ts:9-27`; `vercel.json` `{ "path": "/api/cron/offer-projection-sweep", "schedule": "*/2 * * * *" }`.
  Type widening: `QueueRow.offer.outcome` and `AcquisitionOfferOutcome` and the `_components/types.ts` union become `'pending' | 'accepted' | 'declined' | 'superseded'`; `capitalize(row.offer.outcome)` already renders "Superseded"; `client.tsx:1241` compares only `=== 'pending'`, unchanged.
- Side effects checked: `adapter.ts:42` passes `outcome` through; detail rows are plain strings (`DetailFact.outcome`, `queries.ts:112`).
- Tests: `offer-projection.test.ts` (injected rpc mocks: precheck mapping table for every `reason`; `createOfferIntent` maps `23505` on the open index to `OPEN_CONTRACT_EXISTS`; `projectOfferNow` returns `awaiting_send` without calling the offer RPC; `resolveOfferIntent` returns the stored projection for a known intent and null for a new one, and refuses an actor who is neither the projection's actor nor an owner); `route.test.ts` (401 without `CRON_SECRET`, summary shape, alert only once); `queue-row`/`detail-panel` snapshot with `superseded`.
- Rollback: remove cron + library; the type widening is harmless.

#### 3.8 Contract prefill mapper and review line
- Files: create `src/app/(dashboard)/my-leads/call/[propertyId]/contract-card/contract-prefill.ts` + `contract-prefill.test.ts` (with `__snapshots__`).
- Change: pure function, no I/O:
```ts
export type PrefillSource = 'lead' | 'public_record' | 'org_default' | 'title_company' | 'buyer_entity' | 'rep' | 'computed' | 'unsourced';
export type PrefillInput = {
  schemaVersion: 'legacy-v1' | 'residential-v1' | 'novation-v1'; fieldNames: readonly EsignMergeFieldName[];
  lead: { sellerName: string; sellerEmail: string; sellerPhone: string | null; street: string; city: string; state: string; zip: string; fullAddress: string };
  comp: { legalDescription: string | null; legalComplete: boolean; confidence: 'high' | 'medium' | 'low' | null; fetchedAt: string | null; provider: 'attom' | 'fixture' | null; ownerOfRecord: string | null } | null;
  settings: { earnestMoneyCents: number; templateFieldDefaults: Record<string, string> };
  titleCompany: TitleCompany | null; buyerEntity: BuyerEntity | null;
  rep: { priceCents: number; closingDate: string; overrides: Partial<Record<EsignMergeFieldName, string>> };
  todayCentral: string };
export type PrefillResult = { values: ContractMergeValues; sources: Record<string, PrefillSource>; missing: EsignMergeFieldName[];
  review: { sellerNames: string; legalDescription: string | null; price: string; closingDate: string | null; ownerOfRecordWarning: string | null };
  blocked: boolean };
export function buildContractPrefill(i: PrefillInput): PrefillResult;
```
  Mapping (novation-v1 names from `src/lib/esign/contracts.ts:31-45`; residential-v1 `:23-29`; legacy `:15-21`; address rule copies `defaultsFor`, `send-for-signature.tsx:636-652`, i.e. residential uses street plus city/state/zip, novation keeps the joined address and `property_state`):
  - lead: `seller_name` (contact entity or first+last), `seller_email`, `seller_phone`, `property_address`, `property_city/state/zip`.
  - rep (card inputs): `offer_price` and `cash_balance` via `formatDollars` (`closr-v1.ts:64`), `closing_date` (ISO), `earnest_money` (settings default, editable).
  - title company: `earnest_money_holder`, `closing_agent_name/phone/address`. buyer entity: `buyer_name`, `buyer_phone`, `buyer_email`, `attorney_in_fact`.
  - computed: `agreement_date` = `todayCentral`.
  - org default (`template_field_defaults`): `seller_closing_cost_cap`, `due_diligence_days`, `access_days_per_week`, `access_hours_per_visit`, `offer_expiration`, `acceptance_date`, `release_date`, `additional_terms` (optional). Phase 0's template audit sets which of these have a rule; any field with no source is `unsourced`, stays editable in a "More fields" disclosure, and blocks Send until non-empty (except `additional_terms`, as in the existing dialog, `send-for-signature.tsx` `fieldsComplete`).
  - `legal_description`: ONLY from `comp.legalDescription` when `comp.legalComplete && comp.confidence !== 'low' && comp.provider === 'attom' && age <= 90 days`; otherwise `''` + `unsourced` + blocked (D8: never prefill legal/vesting from a low-confidence source). The review line shows "Legal description: needed" in that case.
  - `ownerOfRecordWarning`: set when the normalised (uppercase, punctuation stripped) `ownerOfRecord` shares no surname token with `lead.sellerName` — a visible warning on the review line, not a block (default; [JARRAD] may want it to block).
  - `rep.overrides` may replace an allow-listed value (an edit flips its tag to `rep`, which is allowed because it is a human-typed value shown in the review line), **except the economic fields**: `offer_price`, `cash_balance`, `closing_date` and `earnest_money` can never be overridden separately; they are produced only from the dedicated `rep.priceCents`, `rep.closingDate` and `settings.earnestMoneyCents` inputs, so there is exactly one source for each. The result carries `economics: { priceCents, closingDate, earnestMoneyCents }` **derived from the final canonical merged `values`** (parsed back from `values.offer_price`, `values.closing_date`, `values.earnest_money` with the same formatter), and a dev assertion fails if a value differs from its dedicated input.
- Side effects checked: never reads `properties.arv`/`repair_estimate`; output keys are validated against `getEsignFieldSchema` (`contracts.ts:48`) so the later `assertExactRuntimeSendShape` (`lead-esign-action-core.ts:1193`) cannot reject extras.
- Tests: snapshot of `values`/`sources`/`missing` for three fixtures (novation-v1 complete, novation-v1 low-confidence legal, residential-v1); low-confidence/old/fixture legal → blocked; unsourced field blocks; owner-of-record mismatch warns; `additional_terms` never blocks; overrides honoured and tagged `rep`; an override of `offer_price`, `cash_balance`, `closing_date` or `earnest_money` is rejected; `economics` equals what is parsed from the merged values for conflicting price, closing-date and earnest-money inputs.
- Rollback: delete files (unused until 3.9).

#### 3.9 Send-contract card on the existing orchestration (NOT `send-contract.ts`)
- Files: create `…/contract-card/{contract-card-actions.ts,contract-card.tsx,offer-recovery.tsx}` + tests; modify `src/lib/esign/dropbox-sign.ts` (seam S3) + its test.
- Change. Seam S3: `createDropboxSignProvider` (`dropbox-sign.ts:39-60`) honours `DROPBOX_SIGN_API_BASE_URL` only when `VERCEL_ENV !== 'production'` (a unit test asserts production ignores it; confirm the `@dropbox/sign` constructor accepts a base path). `contract-card-actions.ts` (`"use server"`):
```ts
export type SendContractCardInput = { propertyId: string; templateId: string; sendIntentId: string; priceCents: number;
  closingDate: string; titleCompanyId: string; buyerEntityId: string; earnestMoneyCents: number;
  signers: readonly SignerAssignment[]; overrides: Partial<Record<EsignMergeFieldName, string>>;
  motivation: AcquisitionMotivationResponse | null; temperature: AcquisitionTemperature };
export type SendContractCardResult =
  | { status: 'sent'; requestId: string; offer: 'logged' | 'pending' | 'conflict'; code?: string }
  | { status: 'unconfirmed'; projectionId: string }                       // send_unknown / send in progress: never re-send
  | { status: 'blocked'; code: string; message: string }                 // precheck / OPEN_CONTRACT_EXISTS / missing fields
  | { status: 'failed'; message: string };                               // definitive: nothing logged
export async function loadContractCard(propertyId: string): Promise<ContractCardState>;
export async function sendContractCardAction(input: SendContractCardInput): Promise<SendContractCardResult>;
export async function retryOfferProjectionAction(projectionId: string): Promise<…>;
export async function supersedeOfferAction(projectionId: string, idempotencyKey: string): Promise<…>;
export async function reassignAndLogOfferAction(projectionId: string): Promise<…>;     // updateLeadAssignee + fn_retry_offer_projection
export async function cancelContractAction(requestId: string): Promise<…>;             // wraps voidContractAction
```
  `sendContractCardAction` flow: (1) `authenticateLeadEsignActor()` (`lead-esign-bindings.ts:36`) + `myLeadsViewer()`; (2) **resolve the supplied intent first**: `resolveOfferIntent(viewer, sendIntentId)`. If a projection already exists for it: authorize (the viewer must be the projection's actor or an owner), recompute `requestHash` from the submitted payload and require it to equal the stored one (a different price, date, template, signers or motivation under the same intent returns `{status:'blocked', code:'IDEMPOTENCY_CONFLICT'}`), then **skip `precheckOffer` and `createOfferIntent`** and go straight to step (5) with the same `sendIntentId`; the core's `resolveExistingIntent` returns the durable state without a provider call, so a lost response after a successful send reaches the replay path even though the lead now has an open projection and a pending offer; `logged`/`conflict`/`pending` projection states are returned as the durable result. Nothing existing is ever abandoned. (3) For a genuinely new intent only: `precheckOffer` fresh (not the browser's copy); (4) load title company/buyer/settings/latest comp server-side and recompute `buildContractPrefill` (the browser contributes only ids, price, date, earnest, signers and allow-listed non-economic overrides; unknown keys and any economic override key are rejected); `blocked` → `{status:'blocked'}`; validate closing date >= tomorrow America/Chicago, `priceCents > 0`; **take the projection's `amountCents`, `closingDate` and earnest money from `prefill.economics` (the final canonical merged values that will be sent), and reject with `blocked/ECONOMICS_MISMATCH` if they differ from the typed `priceCents`/`closingDate`/`earnestMoneyCents`**, so the document, the projection and the follow-up date cannot diverge; compute `requestHash`; `createOfferIntent` (projection `awaiting_send`); (5) `createBoundLeadEsignCore().send({ propertyId, templateId, sendIntentId, signers, mergeValues })` (`lead-esign-actions.ts:25`; this is the live path `claimSend → dispatchClaimed → provider.sendWithTemplate (:580) → reconcileSent (:634)`, with `markUnknown` `:1427` on timeout or DB failure after provider success); (6) result mapping: ok → `projectOfferNow(projectionId)`; `err.code` `SEND_UNKNOWN`, `SEND_IN_PROGRESS` → `{status:'unconfirmed'}` (NO second `send`, NO offer); any other `err` → `{status:'failed', message}` (the request, if one was claimed, is already `failed` and the trigger closes the projection; if the error happened before any claim, call `fn_offer_projection_repair()` equivalent `abandonOfferIntent(projectionId)` so the open slot is released); (7) `revalidatePath('/my-leads')` and `/leads/${propertyId}`. The card never imports `send-contract.ts#sendContractWithTemplate` (not the live path) nor anything from `website-template-registration.ts` (its helpers write template state; decision N10).
  - The page that hosts these actions exports `export const maxDuration = 300` (3.10): a server action inherits the page's limit (`maxDuration.md` "Server Actions") and the core's 4-minute provider abort plus outcome write needs it (`lead-esign-action-core.ts:44-47`, same export at `leads/[id]/page.tsx:116`).
  - UI `contract-card.tsx` (root `data-testid="send-contract-card"`; the review line `contract-review-line`, price input `contract-price`, closing date input `contract-closing-date`, Send button `contract-send`, state copy `contract-status`; seam S4): the card renders only when the `contract_card` flag is on and `sendContractCardAction` returns `blocked/FEATURE_DISABLED` when it is off or when `schemaReady('offer_projection')` is false (read server-side, a missing row reads OFF; the existing eSign dialog stays the only send path until then); editable price, closing date (no default; the rep types it); pickers for title company (preselected by `resolveTitleCompany` with the lead's `market`/`state`) and buyer entity (default); earnest default `formatDollars(500)`; motivation fields only when `precheck.motivationRecorded === false`; "More fields" disclosure for unsourced fields; read-only review line (seller name(s), legal description, price, closing date; each shows `needed` in red when missing, plus the owner-of-record warning); one **Send contract** button, disabled while blocked or pending. `sendIntentId` is a `useRef(crypto.randomUUID())` kept stable across double-clicks and timeouts (so a lost response re-uses the same idempotent intent, `resolveExistingIntent` `lead-esign-action-core.ts:1252-1256`) and rotated only after a definitive `failed`/`blocked`, or an edit while no send is in flight. Test mode banner and live-mode banner copy reuse `preflight.testMode` wording from the dialog.
  - Status polling (every 5 s while visible, via `loadContractCard`) maps state to copy: `awaiting_send` + request `send_unknown` → "Send unconfirmed. Sandra is checking with Dropbox Sign. Do not send again." (no button); `pending` → "Contract sent. Logging the offer…"; `logged` → "Contract sent. Offer logged. Follow-up {date}."; `conflict` → red banner "Contract sent, offer needs reconciling" with the recovery actions below; `failed` → error + "Try again" (new intent); `cancelled` → "Contract cancelled."
  - `offer-recovery.tsx`: shown on the call screen card, the lead page and `OfferConflictRows` in the strip (`fn_list_offer_conflicts`). Actions by `conflict_code`: `PENDING_OFFER_EXISTS` → **Supersede stale offer and log this one** (confirm dialog listing both amounts) and **Cancel signature request**; `STALE_ASSIGNMENT` → **Reassign to me and log** and **Cancel**; `STALE_STATE`/`DNC_LOCKED`/`AMOUNT_MISMATCH` → **Cancel** and "Open lead" (no automatic log); transient/exhausted → **Retry logging**. Policy text on screen: "The contract was sent. Sandra never sends it again."
- Side effects checked: `claimSend` blocks on live-send fuse (`reserve_esign_live_send`, `20260902180000_esign_essentials_production_path.sql:1078`, `live_send_monthly_limit between 1 and 40` at `:19`) and Dropbox remaining <= 10 (`lead-esign-action-core.ts:547`); those surface as ordinary `blocked/failed` results with nothing logged. The existing `esign-send-reconciliation` cron (`vercel.json`, every 5 min) is what turns `send_unknown` into `sent`/`failed`; the trigger then drives the projection, no card involvement.
- Tests (`contract-card-actions.test.ts`, vitest with injected `createBoundLeadEsignCore`, repository and projection mocks; reuse the fakes style of `lead-esign-action-core.test.ts:1-217`):
  - replay after success (lost response): first call sends and the offer is logged (pending offer and projection now exist); the same `sendIntentId` and payload again returns the durable `sent`/`logged` result without `precheckOffer`, without `createOfferIntent` and with `sendWithTemplate` still called once; a replay with a changed price returns `IDEMPOTENCY_CONFLICT`; a replay by a different non-owner user is refused.
  - economics: an override of `offer_price`/`closing_date`/`earnest_money` is rejected; conflicting top-level price, closing date and earnest money versus the merged values return `ECONOMICS_MISMATCH` before any intent exists; the projection's amount and closing date equal the values in the sent document.
  - timeout: core returns `SEND_UNKNOWN` (use the abort-ignoring provider pattern at `lead-esign-action-core.test.ts:754`) → `{status:'unconfirmed'}`, `projectOfferNow` not called, provider `sendWithTemplate` called exactly once even if the action is invoked again with the same intent.
  - provider success then DB failure: `reconcileSent` throws → core marks `send_unknown` → card `unconfirmed`, no offer; later simulate the projection turning `pending` and the sweep logging it once.
  - definitive failure (`SEND_FAILED`) → `{status:'failed'}`, no `fn_log` call.
  - concurrent lead mutation: `precheckOffer` ok then `projectOfferNow` returns `conflict` → card returns `sent`, `offer:'conflict'`, never calls `send` again.
  - recovery without resend: `supersedeOfferAction`, `reassignAndLogOfferAction`, `cancelContractAction` never touch `provider.sendWithTemplate` (spy count 0); non-owner non-assignee rejected.
  - static guard test: read the card module sources and assert none import `send-contract` or `website-template-registration`.
  - `contract-card.test.tsx` (RTL): review line shows `needed` for missing legal; Send disabled until complete; `unconfirmed` hides the Send button; conflict banner renders the right actions per code; intent id stable across double click.
- Rollback: remove the card from the call screen; server actions are inert without callers; projection rows already created stay valid.

#### 3.10 Call screen route, loaders, layout
- Files: create `src/app/(dashboard)/my-leads/call/[propertyId]/{page.tsx,loaders.ts,actions.ts,call-screen.tsx,static-script-view.tsx,numbers-card.tsx,history-panel.tsx}` + tests; modify `src/lib/coach/script-cache.ts`; entry-point links (see Affected files).
- Change.
  - `page.tsx` (server): `export const dynamic = 'force-dynamic'; export const maxDuration = 300;` (see 3.9). Signature `export default async function CallScreenPage({ params }: { params: Promise<{ propertyId: string }> })`. Guards copied from `my-leads/page.tsx:126-165`: `getCallerMembershipsOrThrow`, exactly one membership, `getAcquisitionRoster`, `canViewMyLeads`, `roster.settings.enabled`; invalid UUID → `notFound()`; unavailable states reuse `MY_LEAD_ROW_REASON_COPY` (`src/lib/my-leads/row-reasons.ts`). The screen is the signed-in user's own queue only (a URL never grants access, same rule as `page.tsx:193`). The route renders only when the `call_screen` flag is on (read server-side, a missing row reads OFF); off returns `notFound()`. In p3-call-screen the `contract` and `facts` sections are hidden (the loader returns `{ ok: false }` for them and the layout omits the slots); p3-send-card mounts them.
  - `loaders.ts`: `loadCallScreen(propertyId: string): Promise<CallScreenData>`; every section is independent and degrades alone so the page always renders ("never blocks lead visibility"):
```ts
type Section<T> = { ok: true; data: T } | { ok: false; message: string };
export type CallScreenData = {
  viewer: { userId: string; orgId: string; isOwner: boolean };
  lead: { propertyId: string; address: string; city: string | null; state: string; zip: string | null; market: string | null;
          homeowner: { contactId: string | null; name: string; email: string; phones: { slot: 1 | 2 | 3; value: string; type: string }[] } };
  queueRow: QueueRow;                                                     // getMyLeadsQueueRow (queries.ts:82), required
  script: Section<{ ref: { slug: string; revision: number; digest: string }; bundle: ScriptBundle; context: CoachCallContext }>;
  comps: Section<{ latest: LeadCompPublic | null; request: { status: string; trigger: string } | null;
                   settings: { enabled: boolean; capped: boolean }; valuation: { arv: number | null; rehab: number | null } }>;
  notes: Section<Note[]>; messages: Section<Message[]>;
  contract: Section<ContractCardState>; facts: Section<LeadCallFactsView | null>; };
```
    Sources: lead/contact via `properties` + `contacts` select (columns as `loadLeadSendContext`, `lead-esign-bindings.ts:409-448`, plus `market`); `script` = new `loadCachedCoachBundle('closr-outbound')` (slug `closr-outbound`, `VALID_COACH_SCRIPT_SLUGS`, `src/lib/dialer/jitter-server.ts:49`) + `loadCoachCallContext({ propertyId, sellerPhoneE164, repPhoneE164 })` (`src/lib/coach/coach-context-actions.ts:47`); `comps` via the user's RLS client with an explicit column list (no `raw`) + latest `comp_fetch_requests`; `notes` = `lead_notes` newest 50 (`leads/[id]/page.tsx:450-456` pattern); `messages` = the same `or()` query as `leads/[id]/page.tsx:345-366`, limit 50; `contract` = `loadContractCard`; `facts` = newest `lead_call_facts` for the lead. Do NOT call `markMessagesReadForProperty` (`leads/actions.ts`, called at `leads/[id]/page.tsx:338`): it clears `has_unread_inbound`, which feeds ranking tier 2, and reading a screen the rep did not scroll is not an acknowledgement (open question below).
  - `script-cache.ts` addition: `export async function loadCachedCoachBundle(slug: string, admin = createAdminClient() as unknown as CacheAdmin): Promise<{ ref: Pick<ScriptRef,'slug'|'revision'|'digest'>; bundle: ScriptBundle } | null>` — same checks as `bindDirectCoachCall` (`src/lib/direct-calling/coach.ts:28-45`): joins `coach_script_defaults` to `coach_script_revisions(slug, revision, bundle, import_status)`, requires `import_status === 'reviewed'`, `assertValidScriptBundle`, recomputed digest equals stored digest; returns null otherwise (no fallback, matching `loadCachedCoachDefault`'s contract, `script-cache.ts:116`). The 15-minute `coach-scripts-sync` cron (`vercel.json`) keeps it fresh; no change to it.
  - Script rendering (D7: static scroll, no live follow): `static-script-view.tsx` iterates `getCoachSections(bundle)` (`src/lib/coach/section-manifest.ts`), calls `buildCoachSectionScriptBlock(bundle, section.id, tokens, selectCtx, branchOverrides, null)` (`src/lib/coach/script-block.ts:5`) with `selectCtx = { leadSource, occupancy }` from the coach context, and renders `say` lines bold and `note` lines muted using `resolveDisplayText` segments (text / token chip / tone chip). Token slots (from `@biginkc/coach@0.3.2`, `package.json:57`: `COACH_TOKENS = seller_name, rep_name, property_address, motivation, dream_outcome, rep_phone, file_number, cold_caller_name, year_built, closing_date, offer_price, net_to_seller`; entry tokens `motivation, dream_outcome, cold_caller_name, closing_date, offer_price, net_to_seller`): host tokens come from `loadCoachCallContext`; `tokens = resolveCoachTokens(bundle.script.tokens, context, entryFields)` with `entryFields = { ...EMPTY_ENTRY_FIELDS, offer_price, closing_date, motivation }` derived from the card's price/date inputs (editing an entry chip in the script and the card field share one state) and from the queue row / accepted facts for `motivation`; `net_to_seller`, `dream_outcome`, `cold_caller_name` stay placeholder chips until a rule defines them [JARRAD: say which CLOSR anchor, if any, is "net to seller"]. Placeholders render as the existing "missing" chip. Per-branch variant switcher is local state only. A sticky section rail jumps between sections. Do not touch `coach-live-view.tsx` (its `ScriptPanel`/`TokenChip` are private and covered by realtime tests); copy the chip styling only.
  - Layout (`call-screen.tsx`, client): header = lead name, address, stage chip, **Call** (`data-testid="call-button-<propertyId>"`; Phase 2 `dialLeadAction` with the first callable slot, `my-leads/dialpad-actions.ts`) and "Back to My Leads"; ≥ 1024 px two columns: left (60 %) `StaticScriptView` in its own scroll container; right (40 %) stacked: `NumbersCard` → `ContractCard` → `HistoryPanel` (tabs Notes | Texts, reusing `useLeadNotes`, `NoteEventCard`, `AddNoteComposer` from `leads/[id]/notes-feed.tsx:24,:167,:89` and `MessagesThread` from `leads/[id]/messages-thread.tsx:84`, read-only texts) → docked `PostCallPrompt variant="dock"` (Phase 1c component) pinned to the bottom of the right column with `CallFactChips`. Below 1024 px: single column in the order header, numbers, script, contract, history, prompt.
  - `NumbersCard` (root `data-testid="numbers-card"`, the verify chip `numbers-verify-first`, the typed-ARV field `numbers-arv`; seam S4): as-is value with range and confidence badge; "Verify first" chip with `verify_reasons`; ARV value or "ARV unavailable"; comps table (top 6 by recency/distance, `CompSale`); `ownerOfRecord` and legal-description completeness; anchors from `computeAnchors` (3.3), ARV-dependent block shows "unavailable: needs ARV and rehab" with inline fields for typed ARV (shown only when `arv_method='none'`) and rehab saved through `fn_set_lead_valuation_inputs`; "Comp this lead" button (3.4); "comps pending" skeleton while a request is `queued|running`; "capped"/"disabled" copy; fixture ribbon. Never gates the rest of the screen.
- Side effects checked: read-only except the explicit actions; `lead_notes` Realtime subscription of `useLeadNotes` works unchanged on this route; the Dialpad calling bootstrap (`loadDialpadCallingBootstrap`) is NOT mounted here (Phase 2 removed the iframe path; Call uses the action); training leads (`is_training`) show the screen but comps are refused and `lead_comps` never written; no KPI, stage or clock is touched by merely opening the screen.
- Tests: `loaders.test.ts` (each section failing alone still returns the others; no `raw` column requested; not-in-queue maps to the shared unavailable copy; `markMessagesReadForProperty` never called); `static-script-view.test.tsx` (token resolution from a fixture bundle: offer_price entry chip updates when the card price changes, placeholders render "missing"); `numbers-card.test.tsx` (ARV null → ARV-dependent anchors "unavailable", no `$0.00`; low confidence → "Verify first"; fixture ribbon); `call-screen.test.tsx` (RTL: layout order, mobile order, contract card mounted, prompt docked); `script-cache.test.ts` additions (`loadCachedCoachBundle` rejects unreviewed, rejects digest mismatch, returns null when absent).
- Rollback: delete the route; entry-point links are one-liners.

#### 3.11 (removed)
The transcript and AI Recap fetch job is Phase 2.9 (`20261006100500_dialpad_artifact_fetches`, cron `/api/cron/dialpad-artifact-sweep`), the only fetch job in the plan; Phase 3 adds no fetch table, no `provider_transcript`/`provider_summary` columns, no `call-artifacts.ts` and no artifact cron.

#### 3.12 Call facts (AI proposals) and prefill chips
- Files: create `supabase/migrations/20261007130000_call_facts.sql` (the tables below and their functions) + `.integration.test.ts` + rollback twin `supabase/rollbacks/20261007130000_call_facts.sql`; `src/lib/call-facts/{extract.ts,validate.ts}` + tests; `src/app/(dashboard)/my-leads/_components/call-fact-chips.tsx` + test; `src/app/api/cron/call-facts-sweep/route.ts` (+ test; `vercel.json` `{ "path": "/api/cron/call-facts-sweep", "schedule": "*/2 * * * *" }`), which only claims and extracts and returns `{ok:true, disabled:"flag_off"}` while `facts_job` is off; it fetches nothing.
- Change (DDL):
```sql
create table public.lead_call_facts (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references public.organizations(id) on delete cascade,
  property_id uuid not null, call_activity_id uuid not null,
  source text not null default 'dialpad_ai_recap' check (source in ('dialpad_ai_recap')),
  status text not null default 'proposed' check (status in ('proposed','partially_accepted','dismissed','no_facts')),
  summary_note_id uuid references public.lead_notes(id) on delete set null,
  facts jsonb not null default '{}'::jsonb,       -- { field: { value, evidence } } for motivation, timeline, condition, mortgage, asking_price, next_step
  accepted jsonb not null default '{}'::jsonb,
  model text, extracted_at timestamptz not null default now(), updated_at timestamptz not null default now(),
  processing_state text not null default 'claimed' check (processing_state in ('claimed','done','failed')),  -- durable job state, separate from the human-facing `status`
  claim_token uuid, lease_until timestamptz, attempts smallint not null default 0 check (attempts between 0 and 5),
  unique (org_id, call_activity_id),
  foreign key (call_activity_id, property_id, org_id) references public.call_activities(id, property_id, org_id) on delete cascade);
```
    RLS: select for active org members; writes only through service_role (job) and `fn_accept_call_fact(p_org_id uuid, p_fact_id uuid, p_field text, p_value text) returns jsonb` (authenticated; `my_leads_workflow_require_actor`; field allow-list; records `accepted[field]`, appends a `lead_notes` row "From call summary - <label>: <value>" authored by `auth.uid()`, sets `partially_accepted`) and `fn_dismiss_call_facts(p_org_id uuid, p_fact_id uuid)`.
  - Job (durable processing state, lease and reclaim, one completion transaction): `fn_claim_call_facts(p_limit integer, p_lease_seconds integer default 300)` considers activities whose Phase 2.9 `dialpad_call_artifact_fetches` rows for `transcript` and `recap` are all terminal (`state in ('available','unavailable','denied')`) with at least one `available`, property not `is_training`, and **either no `lead_call_facts` row, or a row with `processing_state = 'claimed' and lease_until < now() and attempts < 5`** (a reservation whose worker crashed is reclaimed; a row in `done` or `failed` is never selected). It inserts or re-leases the row (`processing_state='claimed'`, new `claim_token`, `lease_until = now() + lease`, `attempts = attempts + 1`, `on conflict (org_id, call_activity_id) do update` only for an expired lease) and returns `{fact_id, claim_token, call_activity_id, summary, transcript}`, reading the input from `call_transcripts.text` and `call_transcripts.summary` (the 2.9 storage), never from new provider columns. A row that expires at `attempts = 5` is set `processing_state='failed'` with one Sentry alert. **Step 1, outside any transaction:** run the extractor (below). **Step 2, one completion transaction** `fn_complete_call_facts(p_fact_id uuid, p_claim_token uuid, p_facts jsonb, p_status text, p_model text)` (service role): verify the token and that the lease has not expired (else raise, the result is discarded and the activity is reclaimed later); create the summary note with a **deterministic identity**, `lead_notes.idempotency_key = md5('call_facts_summary:' || call_activity_id)::uuid` (the column and unique index from P1c, `insert … on conflict (org_id, idempotency_key) do nothing`, then select the id), `author_user_id = null`, body `Dialpad call summary` + date + `call_transcripts.summary`, only when `summary` is non-null (action items are not stored by 2.9, so they are not used); set `summary_note_id`, `facts`, `status` (`proposed` or `no_facts`), `model`, `extracted_at` and `processing_state='done'` in the same transaction. Nothing is visible until the transaction commits and a replay of the completion is a no-op, so there is no state in which the note exists without facts or in which a crashed worker leaves the activity unprocessable. **Readiness:** the cron reads the `facts_job` flag and `schemaReady('call_facts')` first.
  - `extract.ts`: `createFactsExtractor(client: Pick<Anthropic,'messages'>): FactsExtractor` following `src/lib/norma/callback-time-ai.ts:36-80` (injected client, forced tool call `submit_call_facts`, `temperature: 0`, model constant `claude-haiku-4-5-20251001` as the neighbours use). Input is only the summary text and the seller-line transcript text (no name/address/phone). Output per field `{ value: string | null, evidence: string | null }`. `validate.ts` enforces, in code and never in the prompt: the `evidence` string must appear verbatim (case-insensitive, whitespace-collapsed) in the input text or the field is dropped; `asking_price`/`mortgage` must parse to a positive dollar amount; `next_step` must parse to a future date via the existing parser pattern or is dropped; unknown fields dropped. Zero surviving fields → status `no_facts` (the summary note still exists). The extractor is skipped (summary note only) when `ANTHROPIC_API_KEY` is unset or `FACTS_PROMPT_V1` is null.
  - Rule discipline (CLAUDE.md "no LLM touches a rule"): the extraction system prompt and tool description are rule-like text: `export const FACTS_PROMPT_V1: string | null = null;` ships null, and the extractor stays off (summary note only) until Jarrad's verbatim text lands (pending Jarrad's verbatim approval); the builder must not write or paraphrase it, and the text goes in as one fenced constant approved in the PR. Facts are proposals only; nothing is written to the lead until a human taps accept.
  - `call-fact-chips.tsx`: renders one chip per proposed field (label, value, evidence tooltip) with Accept / Dismiss; accepting `motivation` pre-fills the motivation fields of `PostCallPrompt` and the card (written to the queue only through the existing ready-for-offer / log-offer commands, not directly); `asking_price`, `condition`, `timeline`, `mortgage` land as accepted facts and the lead note above and are shown on the numbers card (asking next to AVM; condition as a rehab hint); `next_step` accept calls Phase 1's `createNextStep({ kind: 'appointment', mode: 'phone', … })`. No `properties` column is written (import-owned columns such as `mortgage_balance`, `listing_price`, `types.ts:3247,3243`, stay untouched) — [JARRAD] to say if `asking`/`mortgage` should ever update lead fields.
- Side effects checked: new `lead_notes` rows appear live through the existing Realtime channel (`notes-feed.tsx`); `lead_notes.author_user_id` null renders as unknown author in `NoteEventCard`, so add the "Dialpad call summary" label in the card when the body starts with that prefix (small change in the new `history-panel.tsx` wrapper, not in `notes-feed.tsx`).
- Tests: `validate.test.ts` (evidence must be verbatim; price parsing; future-date rule; unknown field dropped); `extract.test.ts` (injected fake client: tool-call parsing, malformed output → no facts, no key → summary only); integration (claim only when artifacts terminal; **crash after reservation**: claim, never complete, advance past `lease_until`, the activity is claimed again and completes once; **crash after note creation**: complete once, simulate a second worker completing the same activity with an expired token (rejected) and with a replay (no second note, one facts row); one facts row and one note per call under a replayed job; attempts exhausted → `failed` with an alert; `fn_accept_call_fact` authz + note insert, field allow-list, cross-org isolation); `call-fact-chips.test.tsx`.
- Rollback: ships `supabase/rollbacks/20261007130000_call_facts.sql` (drop `lead_call_facts` and the functions); remove the `call-facts-sweep` cron; notes already written stay (they are ordinary notes).

#### 3.13 Wiring, config and generated types
- Files: `vercel.json`, `.env.example`, `vitest.integration.config.ts`, `vitest.local-integration.config.ts`, `.github/workflows/e2e.yml`, `src/lib/supabase/types.ts`, entry-point links.
- Change: add the three crons (`comp-queue-drain` `*/2` gated by `comp_queue`, `offer-projection-sweep` `*/2` gated by `offer_projection`, `call-facts-sweep` `*/2` gated by `facts_job`; each returns `disabled: "flag_off"` before claiming anything; existing patterns `vercel.json` use `*/N` and offset schedules); list each new `*.integration.test.ts` in the local include list and the hosted exclude list (they replay DDL, so the hosted suite must not select them, per the comment block in `vitest.integration.config.ts`), plus an e2e.yml step per test copying `e2e.yml:201-207`; regenerate `src/lib/supabase/types.ts` against a local stack once the four migrations exist (the repo narrow-casts pre-regen tables, see the comment in `src/lib/dialer/jitter-server.ts:103-108`; prefer regenerating over casts); add "Open call screen" links (queue row, strip row, lead page header) pointing at `/my-leads/call/${propertyId}`.
- Tests: `npm run typecheck` is the guard for the types; the e2e.yml steps are exercised by CI.
- Rollback: revert the files; crons removed with `vercel.json`.

### Acceptance (what the builder runs before opening the PR)
- `npm run typecheck` → 0 errors. `npm run lint` → 0 new warnings. `npm run test` → all unit suites green including the new `src/lib/comps/**`, `src/lib/my-leads/offer-projection.test.ts`, `src/lib/call-facts/**`, contract-card action tests, the static import-guard test, and the existing `lead-esign-action-core.test.ts` and `src/lib/coach/script-cache.test.ts` untouched. `npm run test:rtl` → green including the call screen, numbers card, contract card, chips.
- Against the disposable local DB (`node scripts/provision-e2e-local-database.mjs`, as `e2e.yml:172`): `npx vitest run --config vitest.local-integration.config.ts supabase/migrations/20261007100000_lead_comps_foundation.integration.test.ts supabase/migrations/20261007110000_acquisition_contract_defaults.integration.test.ts supabase/migrations/20261007120000_acquisition_offer_projections.integration.test.ts supabase/migrations/20261007130000_call_facts.integration.test.ts` → all pass, including the offer-logged-after-sent, send_unknown, failed, concurrent-mutation, recovery-without-resend, RLS and follow-up-date cases listed in 3.6. Also re-run `…20261003130000_my_leads_conflicts_non_retryable.integration.test.ts` and `…20261003120000_my_leads_queue_row_lookup.integration.test.ts` (they read the offer outcome column) → green.
- `npm run verify:migration-safety-unit` → green; confirm the four filenames sort after the last Phase 2 migration (`ls supabase/migrations | tail -8`).
- Preview deploy with `COMPS_PROVIDER=fixture` (never `production`): the synthetic non-training lead from the decision doc's Verification step 1 opens `/my-leads/call/<id>`; "Comp this lead" returns fixture numbers with the SAMPLE ribbon; ARV and ARV-dependent anchors show "unavailable"; entering rehab alone keeps them unavailable until ARV is typed; the script renders statically with `offer_price` chip tied to the card. With the Dropbox Sign TEST-mode key: Send contract → request `sent` → offer logged within one sweep interval (≤ 2 min) → stage Offer Sent and an "Offer follow-up" appointment exists (Phase 1a). Then, on a second synthetic lead, create a pending offer manually first, Send → conflict banner appears on the card, the lead page and the strip; **Supersede** logs the new offer, the old offer shows "Superseded", and the Dropbox Sign request count is still 1. Cancel path: void request → projection `cancelled`. Record screenshots under `docs/design/screenshots/` per the repo's convention.
- With a real ATTOM trial key (when Phase 0 grants it): one `compLead` for a known KC lead; confirm `comp_fetch_requests.billed_calls` equals the number of HTTP calls in the provider log and that the monthly cap blocks the next request when set to the current usage.
- Human-feel browser check of the call screen layout and latency (AGENTS.md "Browser checks vs Playwright checks"); a Playwright spec for the contract card flow against the preview is optional and goes to `e2e/` disabled-by-default like the canary specs.

### Risks and open questions
- Runner impersonation (3.6 point 3): a service-role function that sets `request.jwt.claim.sub` to the stored actor is the least invasive way to reuse `fn_log_acquisition_offer` unchanged, but it is the part Codex should attack hardest. Alternative if rejected: a user-session-only runner (post-send action + "Log offer now" on the lead page), which loses unattended completion for `send_unknown` that reconciles later.
- CAS re-read inside the runner (3.6 point 4) deliberately bypasses the card's click-time version; the strongest counter-argument is that it weakens the compare-and-swap contract. Mitigation: the offer RPC still re-checks assignment, terminal status, pending offer and DNC under row locks; the amount guard refuses to log a different amount than the document sent.
- Phase 1a coupling: this plan assumes `fn_log_acquisition_offer` keeps its 13-argument overload and creates the "Offer follow-up" appointment from `p_follow_up_at`; supersede needs no task call (1a.6 trigger 3 cancels the chain's open task when the outcome becomes `superseded`). If Phase 1a's final signature differs, 3.6 changes in exactly one call site. Confirm with the Phase 1 plan before building.
- Legal description completeness is the likely bottleneck: Assigns showed subdivision-only legals for a KC lead, and D8 forbids prefilling from low-confidence sources, so if Phase 0 completeness is low the "one-call close" degrades to a typed legal description on most leads. The card is correct either way, but [JARRAD] should treat the Phase 0 completeness threshold as a go/no-go for the one-click promise.
- Live-send fuse: `org_esign_integrations.live_send_monthly_limit` is capped at 40 by a check (`20260902180000_esign_essentials_production_path.sql:19`); the card shares it, plus the "Dropbox remaining <= 10" fail-closed rule. At ~5 leads a day offers could hit it; raising it is a Jarrad decision outside this phase. [JARRAD]
- Counter-offers: precheck blocks Send while an offer is pending (the RPC would raise `PENDING_OFFER_EXISTS`). A revised price after a seller counter therefore needs decline/outcome first. Adding a "Revised offer" mode that supersedes before sending is a scope question. [JARRAD] default: blocked.
- KPI: `offersSent` will count both a stale offer and its superseding contract offer (3.6 side effects). Default left as is to avoid editing four KPI function generations that Phase 1 also touches. [JARRAD]
- Title company list, buyer entity list, market defaults and the `template_field_defaults` (due diligence days, access terms, offer expiration, etc.) are unknown: Send stays blocked until they exist. [JARRAD]
- "Net to seller" token and which anchor it maps to is undefined; left as placeholder. [JARRAD]
- Facts extraction: the extraction prompt must be approved verbatim (CLAUDE.md rule on LLM-authored rule text) and Haiku is assumed; if Jarrad prefers no LLM step, ship the summary note and chips from `purposes/action_items` only. [JARRAD]
- Reading texts on the call screen intentionally does not clear unread-inbound; if Jarrad expects viewing to count, say so and add a mark-read call guarded by an explicit "I've read these" button. [JARRAD]
- Dialpad `ai_recap` scope and 12/min limit are unproven until Phase 0; the job degrades to `blocked_scope` with one alert, and the call screen still shows the transcript-less state. Transcript id keying (leg vs master) is a Phase 0 question.
- Fixture provider safety: `COMPS_PROVIDER=fixture` is refused in production; a mistakenly seeded `fixture` row must never reach contract prefill (3.8 enforces `provider === 'attom'` for legal text).
- PR size: four migrations plus UI is large; Phase 3 ships as the three stacked PRs in the header (comps, call screen, send card).


---

## Phase 4: End-to-end verification and release

**Goal.** Prove the Phase 0-3 flow works end to end on a synthetic lead, ship each phase to production with a before-image, a rollback and a kill switch, and watch it for 48 hours.
**Depends on.** Phase 3 and p1a-retire for the full-flow spec and runbook (stacked, merge last). Two slices land earlier: the KPI parity harness, lease manifest and monitor (`p4-before-image`, no migration), because Phase 1 cannot go to production without a KPI baseline, and the Phase 2 acceptance slice (`p2-acceptance`, no migration), because Phase 2's release gate needs its T8 and fixtures (see 4.0).
**Branch / PR.** Main PR: `claude/my-leads-p4-acceptance` → base `claude/my-leads-p1a-retire` (the header stack, merged last); title `test(my-leads): end-to-end acceptance, release runbook, rollback kit and 48h monitoring`; `Depends on: #<p1a-retire PR>`.
Phase 2 slice (header order 11): `claude/my-leads-p2-acceptance` → base `claude/my-leads-p2-ui`; title `test(my-leads): phase 2 acceptance slice (Dialpad fixtures, stub dial, T3/T7/T8)`; `Depends on: #<p2-ui PR>`; merges before Phase 2's release step. Early slice (header order 1): `claude/my-leads-p4-before-image` → base `claude/my-leads-one-call-close-decisions` (#791, `main` once merged); title `chore(my-leads): release kit (KPI parity harness, lease manifest, 48h monitor; no migration)`; `Depends on: #791`. It carries no migration and no before-image table: Phase 1e's housekeeping run/before-image tables are the only before-image store. The monitor (formerly slice 4c) is folded into this branch.

**Inputs needed before start.**
- Credentials, only through the BMH service-account `op` path (never the app vault, never echoed): `Dropbox Sign - Sandra eSign Test Mode` (API key, client id, callback secret; exists 2026-08-30 per decision doc "1Password" pre-read); the live Dialpad key Phase 0 identifies (`Dialpad - API` or `DialPad Sandra API key`, both with empty notes); `CRON_SECRET` (Vercel env, needed to invoke crons by hand because crons do not run on previews); the ATTOM key is in the vault as `ATTOM - API` (free trial, trial spend hard-capped at $20; production monthly cap stays 0 until Jarrad sets it after the verdict).
- Jarrad decisions, with the default assumed if absent:
  - [JARRAD] An owned phone number to be the synthetic lead's seller number. Default: none; the attended spec refuses to run without it.
  - [JARRAD] Which Supabase project Vercel Preview points at (listed under "Still owed by Jarrad"). Default assumed: the hosted test project `ncsngxlcyxylaeskiteu` (`src/lib/prod-canary/env.ts:6`). If Preview points at production, the preview lane obeys every production rule below. Check with `vercel env ls preview --scope jarrad-5416s-projects` (read-only) before 4.4.
  - Approved: the 137 stale attempts close as `not_logged` (nothing deleted; never `no_answer`, see F6).
  - [JARRAD] Whether the synthetic acceptance attempts may touch his KPI tiles for the run. Default: yes, then run the retire script (4.7) to remove them.
  - Approved 2026-10-04: offer follow-up 3 days before closing at 09:00 America/Chicago, next morning 09:00 if sooner (needed by test T6).
- Test seams from Phases 1-3 listed in 4.1. If one is missing, file it as a blocking defect against the owning phase; do not work around it inside Phase 4.

**Affected files (for the release lease).**
New:
- `docs/my-leads/RELEASE-RUNBOOK.md` (the "Release runbook" section below, verbatim)
- `e2e/my-leads-close.spec.ts`
- `e2e/support/my-leads-close-fixture.ts`
- `e2e/support/provider-stub-server.ts`
- `e2e/prod-canary/my-leads-close-attended.spec.ts`
- `scripts/rehearse-next-step-relabel-kpi.mjs`
- `scripts/my-leads-close/kpi-snapshot.mjs`, `kpi-compare.mjs`, `kpi-rules.mjs`
- `scripts/my-leads-close/lease-manifest.mjs`
- `scripts/my-leads-close/monitor.mjs`, `monitor.sql`
- `scripts/my-leads-close/rollback/retire-synthetic-lead.sql` (the only rollback SQL Phase 4 owns; data rollbacks are `fn_my_leads_housekeeping_rollback(run_id)` from Phase 1e)
- No migration: Phase 4 adds no before-image table.

Modified:
- `playwright.config.ts` (webServerEnv `:93`, add stub `webServer` entry beside `:183-191`)
- `.github/workflows/e2e.yml` (shard grep-invert `:99-101`, new dedicated step beside `:85-109`, new step in `search-local-suites` beside `:201-208`)
- `vitest.config.ts` (add `"scripts/my-leads-close/**/*.test.ts"` and `"e2e/support/**/*.test.ts"` to the `include` list at `:9`; it includes only `src/**` and three script paths today, so `npm test -- scripts/my-leads-close` otherwise finds no files)
- `package.json` (three scripts)
- `e2e/prod-canary/README.md` (append coverage entry)

No file under `src/` changes in this phase.

---

### Facts from the repo that shape this phase

- **F1. Evidence rows can never be deleted.** `dialpad_call_intents` rejects DELETE (`supabase/migrations/20260929034021_dialpad_cti_foundation.sql:364`) and `dialpad_call_events` rejects DELETE (`:394`). Intents reference `properties` with no cascade (`:162-196`). So a synthetic lead that placed one Dialpad call cannot be hard-deleted. "Cleanup" for it means soft-retire (`properties.deleted_at`, the queue read excludes it: `20260912110000_acquisition_read_model.sql:71`) plus deleting only the rows that are deletable. The existing canary helper `deleteCanaryPropertiesByAddress` (`e2e/prod-canary/support.ts:860`) would fail on such a lead.
- **F2. Training leads are guarded.** `is_training` rows are service-role-only inserts, immutable marker, undeletable (`20260908120000_training_lead_guards.sql:16-52`). The Dialpad projection writes an `internal_training` call activity with null property and no attempt row for them (`20260930036000_dialpad_training_projection.sql:105-122`). The acceptance lead must be a non-training lead.
- **F3. The live KPI function counts only `type='appointment'` for the warning tiles.** `fn_get_acquisition_kpis` (`20260930031000_dialpad_recording_provider_window_finalizer.sql:885-921`) uses `t.type='appointment'` for `contactWithoutFollowUp` (`:894`) and `appointmentsOverdue` (`:895`); `appointmentsDue/Held` join `acquisition_appointment_attribution` (`:919`). So the relabel is expected to change the current-state tiles and must not change closed historical windows. "KPI tiles agree" has to be split into those two classes (4.6).
- **F4. KPIs and queue reads need a JWT identity.** `my_leads_require_read_scope` requires `auth.uid()` to be the member or an owner, the feature on, and the member designated or holding an eligible episode (`20260912110000_acquisition_read_model.sql:19-37`). Operator SQL must `set_config('request.jwt.claim.sub', <owner uid>, true); set local role authenticated;` (pattern: `scripts/verify-my-leads-metrics.mjs:19`).
- **F5. Acquisition tables are closed to `service_role`.** `acquisition_attempts` revokes all from `service_role` (`20260912090200_acquisition_attempt_offer_facts.sql:69-70`). Seeding and reading them in tests and monitoring uses a direct Postgres connection (the local My Leads spec does the same, `e2e/my-leads.local.spec.ts:5,292`), not PostgREST.
- **F6. Closing stale attempts as `no_answer` would text reps.** `rep_sms_no_answer_attempt` fires on insert/update-to-`no_answer` (`20260917110000_rep_sms_obligation_read_models.sql:22-25`). The close-out must use a different outcome or the Phase 1 builder must prove the trigger is bypassed. The runbook asserts `rep_sms_obligations` count is unchanged after close-out.
- **F7. Production migration pipeline.** Push to `main` touching `supabase/migrations/**` runs `Apply Supabase migrations to test` (`db-migrate-test.yml`), serialised in the `e2e-shared-test-project` concurrency group (`:70-73`). Its success triggers `db-migrate-prod.yml` via `workflow_run` (`:100-103`), job uses `environment: Production` (`:113`); as of the 2026-10-04 `gh api` check that environment had no required reviewers and admin bypass off (the reviewer `biginkc` claim in the header comment at `:91-98` is stale), so the migration applied automatically about a minute after a merge; this is an operator-verified release precondition, not a repository fact: every release slot re-reads `gh api repos/biginkc/sandra/environments/Production` and the timing of the last prod-migration run and records them in the lease; timeout 5 min (`:110`). Steps: `check-migration-safety-cli.mjs --target=sandra-production` (`:194`), `supabase db push --include-all --dry-run` (`:197`), `supabase db push --include-all` (`:200`). The safety gate refuses any pending migration older than history's high-water mark (`scripts/check-migration-safety.mjs:826,942`), so stacked PRs must merge in timestamp order and any rename happens before merge. Both workflows run the same migrations against the test project and prod; data movement inside a schema migration would run there too with no per-statement preview.
- **F8. Vercel production follows `main`** (`docs/my-leads/plan/DEPLOYMENT-READINESS.md`, "Publication guard"). So new code can serve for the minutes before its migration has run. Every phase PR's flag-off path must not reference a new column or RPC (feature-flag contract row: a missing table or row reads OFF).
- **F9. Crons do not run on previews.** Crons are declared in `vercel.json:2-71`; Vercel runs them for production only. Cron routes accept `Authorization: Bearer $CRON_SECRET` (`src/app/api/cron/dialpad-call-events-sweep/route.ts:15-18`), so preview/test runs advance them by hand.
- **F10. `provision-dialpad-cti.ts --mode activate` is shaped for the abandoned panel.** Activation plans `set connection status=active with endpoint <recordingIngestEndpoint>` (`src/lib/dialpad-cti/provisioning.ts:667-668`) and the mode list is only `prepare|activate` (`:123-124`). Phase 2 must supply a webhook-only activation path; Phase 4 must not hand-edit `status` except as the documented emergency revert.
- **F11. The webhook 401s and stores nothing when the connection is disabled** (`src/lib/dialpad-cti/event-processing.ts:163`, decision doc pre-reads). Disabling the connection is therefore lossy; the preferred revert keeps it active and turns the consumers off.
- **F12. Precedent for operator-run data moves.** `fn_preview_acquisition_launch` / `fn_apply_acquisition_launch` with a cohort fingerprint, settings revision, idempotency key and captured prior values, driven by `scripts/my-leads-launch.ts`, rollback refused if any lead was worked (`docs/my-leads/plan/LAUNCH-RUNBOOK.md`). Phase 1 data moves should follow it.

---

### Work items (ordered; each independently committable)

#### 4.0 Delivery slices (decide first)
- Files: none; this item fixes where each artifact ships.
- Change:
  - **Early slice `p4-before-image` (header order 1, no migration):** `scripts/my-leads-close/{kpi-snapshot,kpi-compare,kpi-rules,lease-manifest}.mjs`, `scripts/my-leads-close/monitor.mjs` + `monitor.sql` (queries guarded by `@requires` so they run before Phase 2/3 tables exist), `scripts/rehearse-next-step-relabel-kpi.mjs`, `package.json` scripts, the `vitest.config.ts` include additions. Reason: a KPI baseline must exist before the first mutation; the before-image capture itself is Phase 1e's.
  - **Slice `p2-acceptance` (header order 11, no migration, no `src/` change; must merge before Phase 2's release step):** the Phase 2 half of the fixture module (`e2e/support/my-leads-close-fixture.ts`: `assertLaneSafe`, `createSyntheticLead`, `seedFeatureFlags`, `seedDialpadForRep`, `signDialpadWebhook`, `dialpadEventPayload`, `postDialpadEvent`, `retireSyntheticLead`), `e2e/my-leads-close-phase2.spec.ts` with cases T0 (Phase 1-2 seam preflight), T3, T7 and T8 (described in 4.3), the matching `playwright.config.ts` webServerEnv entries (`DIALPAD_DIAL_PROVIDER`, `DIALPAD_CTI_WEBHOOK_SECRET_E2E`, a dummy Dialpad key), a dedicated `.github/workflows/e2e.yml` step and grep-invert token `my-leads-close-phase2`, and the phase-gated monitoring blocks for Phases 1-2 (4.9). Phase 2's activation gate (2.11, Release 2) runs T8 from this branch at the released SHA; the slice is based on `p2-ui` so it imports exactly what exists at Phase 2.
  - **Main PR `p4-acceptance` (merged last):** `docs/my-leads/RELEASE-RUNBOOK.md`, the rest of the fixture module (`createSyntheticLead` comps variants, `provider-stub-server.ts`), `e2e/my-leads-close.spec.ts` (T1, T2, T4, T5, T6, T9 and the Phase 3 cases), `e2e/prod-canary/my-leads-close-attended.spec.ts`, the Phase 3 monitoring blocks, `retire-synthetic-lead.sql`, config/workflow edits for the CI lane (the Dropbox stub `webServer` entry, `my-leads-close` grep-invert token and step).
- Side effects checked: Phase 4 has no migration, so no timestamp reservation. The lease manifest checks the real merge order of every Phase 1-3 migration with `node scripts/check-migration-safety-cli.mjs --target=sandra-production` (needs PG env; the dry check also runs in CI on main).
- Tests: n/a. Rollback: n/a.

#### 4.1 Test-seam contract required from Phases 1-3
- Files: none in Phase 4; this is a checklist the Phase 4 builder verifies by grep before writing specs. Missing item = blocking defect on the owning phase.
- Change: required seams (names marked "proposed" are the Phase PR's to choose; the contract is the behaviour):

| # | Owner | Seam | Behaviour Phase 4 relies on |
|---|---|---|---|
| S1 | P2 | Dial provider switch, proposed `DIALPAD_DIAL_PROVIDER=stub\|live` (same idiom as `MESSAGING_PROVIDER`, `src/lib/messaging/registry.ts:20`) | `stub`: server dial code records the would-be `initiate_call` request (phone, `custom_data`, caller id) in a table/log the spec can read and returns success without HTTP. `live`: real Dialpad. When `VERCEL_ENV=production` the switch is ignored and the code behaves as `live` (no override exists). |
| S2 | P3 | Comps provider switch, proposed `COMPS_PROVIDER=fixture\|attom\|off` | `fixture` returns deterministic values keyed by property id suffix: normal (AVM 200000, range 190000-210000, high confidence, ARV null) and low-confidence variant. Writes `lead_comps` with `provider='fixture'`. |
| S3 | P3 | Dropbox Sign base-URL override, proposed `DROPBOX_SIGN_API_BASE_URL` | Honoured by `createDropboxSignProvider` (`src/lib/esign/dropbox-sign.ts:39-60`) only when `VERCEL_ENV!=='production'`. Confirm the SDK constructor accepts a base path (`node_modules` was not installed when this plan was drafted; check `@dropbox/sign` `SignatureRequestApi` types). The CI lane points it at the local stub; the attended lane leaves it unset and uses the test-mode key. |
| S4 | P1/P2/P3 | Data attributes | `data-testid` values below, plus on every next-step render `data-next-step-id`, `data-next-step-due-at` (ISO), `data-next-step-kind` on: My Leads row/detail, lead page, calendar agenda and month cell, dashboard `tasks-panel` row (`src/app/(dashboard)/dashboard/_components/tasks-panel.tsx:268`). |
| S5 | P1 | Exported pure helper for the quick picks: `quickPickDueAt(pick, now, opts)` in `src/lib/my-leads/quick-picks.ts` (Phase 1c.3) | The spec uses it as the oracle for "Next week"; it does not re-implement the rule. |
| S6 | P2 | A `window`-free way to force the prompt/alert polls | Tests use `page.clock` (already used: `e2e/global-search-redesign.spec.ts:46-47`), so polls must use `setInterval`/`setTimeout`, not `requestAnimationFrame` or web-socket-only paths. |
| S7 | P1/P2/P3 | Kill switches | Each user-visible surface and job gated by its `my_leads_feature_flags` column (contract row; thirteen columns including `seller_reminders`, `artifact_fetch`, `facts_job`, `offer_projection`, `comp_queue`), read server-side at request time; a missing table, row or column reads OFF. Default off. |
| S9 | P3 | eSign provider timeout override | `ESIGN_PROVIDER_TIMEOUT_MS`, read by the lead-eSign core in place of its 4-minute provider abort constant (`lead-esign-action-core.ts:44`) only when `VERCEL_ENV !== 'production'` (unit test: production ignores it). The CI lane sets 5000 so a stub `slow_then_abort` run finishes inside the test timeout. |
| S8 | P1 | Relabel marker | The relabel writes `acquisition_appointment_attribution.source='relabel_2026_10'` (decision doc D1/1a); the KPI rehearsal discovers the relabel migration by that string. |

Required `data-testid` contract (each phase's UI): `call-next-strip`, `call-next-row-<propertyId>`, `call-next-reason-<propertyId>`, `call-next-action-call-today|not-today|dead-nurture-<propertyId>`, `comp-this-lead-<propertyId>`, `numbers-card`, `numbers-verify-first`, `numbers-arv`, `call-button-<propertyId>`, `post-call-prompt`, `post-call-outcome`, `post-call-note`, `post-call-pick-tomorrow|3-days|next-week|pick`, `callback-due-banner`, `send-contract-card`, `contract-review-line`, `contract-price`, `contract-closing-date`, `contract-send`, `contract-status`. Existing ids reused as-is: `my-lead-row-<propertyId>` (`e2e/my-leads.local.spec.ts:164`), `kpi-*`, `book-appointment-calendar`.
- Side effects checked: S1/S3 are test-only branches in production code paths; each must be unreachable in production (unit test in the owning phase asserting production ignores it). Phase 4's runbook smoke includes `curl`-free proof: the production env has none of `DIALPAD_DIAL_PROVIDER=stub`, `COMPS_PROVIDER=fixture`, `DROPBOX_SIGN_API_BASE_URL`, `E2E_AUTH_BYPASS`, `E2E_QUIET_HOURS_NOW` (`playwright.config.ts:107,115`) via `vercel env ls production`.
- Tests: grep script in 4.3 acceptance step ("seam preflight").
- Rollback: n/a.

#### 4.2 Fixture and stub module
- Files: create `e2e/support/my-leads-close-fixture.ts`, `e2e/support/provider-stub-server.ts`.
- Change: exported signatures.

```ts
// e2e/support/my-leads-close-fixture.ts
import type { Pool } from "pg";

export type CloseLane = "ci" | "preview" | "production";

/** Throws unless the lane's safety preconditions hold. ci: E2E_DISPOSABLE_DATABASE==='1' and
 *  requireLoopbackPostgresUrl(dbUrl) (src/lib/testing/loopback-postgres-url.ts). preview/production:
 *  RUN_PROD_CANARIES==='1', owned phone in MY_LEADS_CLOSE_OWNED_PHONES, label includes PROD-CANARY
 *  (assertCanaryOwned, e2e/prod-canary/support.ts:142). production also assertProdSupabaseUrl. */
export function assertLaneSafe(lane: CloseLane): void;

export type SyntheticLead = {
  propertyId: string; contactId: string; address: string; phoneE164: string;
  episodeId: string; runTag: string;                     // `PROD-CANARY <runId>` in every text field
};

/** Non-training lead (is_training=false), not DNC-locked, one callable owned/fake phone, state MO,
 *  assigned to repUserId so observe_my_leads_property_assignment opens a live episode
 *  (20260912090100_acquisition_queue_episodes.sql:180), queue stage 'contacted', last touch
 *  `lastTouchDaysAgo` days ago via a manual outreach attempt (so ranking tier 5 and a deterministic reason). */
/** Also seeds what the stubbed flow needs and the lead alone does not give it: the org's `org_comp_settings` row
 *  (provider 'fixture', auto_comp_enabled true, monthly_call_cap 100), a title company, a buyer entity and the
 *  contract defaults, and the typed legal-description text the spec enters (fixture comps are never a legal source,
 *  3.8), so Send is not blocked for missing data. */
export function createSyntheticLead(db: Pool, input: {
  orgId: string; repUserId: string; runTag: string; phoneE164: string;
  lastTouchDaysAgo?: number;   // default 20
  compsVariant?: "normal" | "low_confidence";
}): Promise<SyntheticLead>;

/** All lanes: no deletion path. Appointments cannot be deleted even by the owner connection (the delete guard,
 *  20260814150000_appointments_schema.sql:449) and intents/events are permanent (F1), so cleanup is
 *  retireSyntheticLead (lifecycle cancellation + soft retirement); immutable evidence is retained and the
 *  report lists the retained inventory. The disposable CI database is destroyed by the workflow anyway. */
export function cleanupSyntheticLead(db: Pool, lead: SyntheticLead, lane: CloseLane): Promise<CleanupReport>;

/** Soft retire: open appointments cancelled through fn_cancel_appointment (lifecycle, never delete); properties.deleted_at=now();
 *  queue row archived; contact kept (intent FK restrict, :174). Returns the retained inventory
 *  {attempts, offers, notes, intents, events, cancelledTasks, openTasks:0}. */
export function retireSyntheticLead(db: Pool, lead: SyntheticLead): Promise<CleanupReport>;

/** All lanes: upsert the org's my_leads_feature_flags row with exactly the named flags true
 *  (call_next_strip, post_call_prompt, click_to_dial, native_matcher, auto_prompt, callback_alert,
 *  call_screen, contract_card, seller_reminders, artifact_fetch, facts_job, offer_projection, comp_queue); the CI spec turns them all on, the runbook turns them on one at a time. */
export function seedFeatureFlags(db: Pool, orgId: string, on: readonly string[]): Promise<void>;

/** CI only: active dialpad_org_connections row with webhook_secret_ref
 *  'env:DIALPAD_CTI_WEBHOOK_SECRET_E2E' (webhook-secret.ts:12 REF_PATTERN), a verified
 *  dialpad_member_bindings row (dialpad_user_id '4242424242'), one active dialpad_number_grants row. */
export function seedDialpadForRep(db: Pool, input: { orgId: string; repUserId: string }): Promise<{ connectionId: string }>;

/** HS256 compact JWT of the raw payload text, same construction as event-processing.test.ts:26-29. */
export function signDialpadWebhook(payloadText: string, secret: string): string;

/** Payload text with call_id as an unquoted integer literal (the verifier keeps int64 ids intact,
 *  webhook-jwt.ts header comment) and event_timestamp 13 digits (foundation migration ingest, :765-767). */
export function dialpadEventPayload(i: {
  callId: string; state: "calling" | "connected" | "hangup"; at: number; customData?: string;
  direction?: "outbound" | "inbound"; externalNumber: string; targetUserId: string;
  shareLink?: string; adminRecordingUrl?: string;
}): string;

export function postDialpadEvent(baseUrl: string, connectionId: string, jwt: string): Promise<Response>;
// POST `${baseUrl}/api/webhooks/dialpad/voice/${connectionId}` (src/app/api/webhooks/dialpad/voice/[connectionId]/route.ts)
```

```ts
// e2e/support/provider-stub-server.ts  (run via playwright webServer, fixed port 3461)
// Dropbox Sign stub: POST /v3/signature_request/send_with_template -> 200 {signature_request:{signature_request_id}}
//   modes by header-less switch: GET/POST /__mode?send=ok|slow_then_abort|reject  (default ok)
// Records every request: GET /__calls -> [{path, method, body, at}], POST /__reset
// The Dialpad dial path uses S1=stub (no HTTP), so no Dialpad HTTP stub is needed.
```
- Side effects checked: the Playwright default config truncates tenant tables per spec via `resetTenantTables` (`e2e/fixtures.ts:56`); the close spec must not call it mid-file (it would remove the lead); call it once in `beforeAll`. Seeding writes `acquisition_*` through `pg` (F5). `pg` is already a devDependency (`package.json:116`).
- Tests: the fixture is exercised by 4.3; add `e2e/support/my-leads-close-fixture.test.ts` (vitest, pure parts only): `signDialpadWebhook` round-trips through `verifyDialpadWebhookJwt` (`src/lib/dialpad-cti/webhook-jwt.ts`); `dialpadEventPayload` keeps a 19-digit `call_id` unquoted and `event_timestamp` is 13 digits.
- Rollback: delete the files.

#### 4.3 CI acceptance spec (decision-doc verification items 1 and 2b, stubbed providers)
- Files: create `e2e/my-leads-close.spec.ts`; modify `playwright.config.ts`, `.github/workflows/e2e.yml`. Cases T0 (Phase 1-2 part), T3, T7 and T8 physically live in `e2e/my-leads-close-phase2.spec.ts`, delivered earlier by the `p2-acceptance` slice (4.0) and gating Phase 2's release; the remaining cases are in this file; both use the same fixture module and each re-seeds in its own `beforeAll`.
- Change:
  - `playwright.config.ts`: in `webServerEnv` (`:93`) add `DIALPAD_DIAL_PROVIDER: "stub"`, `COMPS_PROVIDER: "fixture"`, `DROPBOX_SIGN_API_BASE_URL: "http://127.0.0.1:3461"`, `DIALPAD_CTI_WEBHOOK_SECRET_E2E: "e2e-dialpad-secret-0123456789"`, a dummy Dialpad API key under the name Phase 2 chose, and `E2E_DISPOSABLE_DATABASE`/`E2E_CI_SUPABASE_DB_URL` passthrough for the spec (they are already GitHub-env published by `scripts/provision-e2e-local-database.mjs`). Turn `webServer` (`:183-191`) into an array and add `{ command: "npx tsx e2e/support/provider-stub-server.ts", url: "http://127.0.0.1:3461/__calls", reuseExistingServer: false }`.
  - `.github/workflows/e2e.yml`: add the unique token `my-leads-close` to the three shard grep-invert patterns (`:99-101`) so shards skip it, and add a dedicated step after `:109`: `npm run test:e2e -- e2e/my-leads-close.spec.ts` (fresh server, same reasoning as the thread-panel step comment at `:86-88`). Test titles in the file all start with `my-leads-close:`.
  - Spec shape: one `test.describe.serial("my-leads-close: ...")`, `test.setTimeout(120_000)`, `page.clock.install()` in each test that needs deterministic polls.

Tests (each is one `test`, in order; data are the 4.2 fixtures; "rep" = the seeded e2e user, owner membership in org `00000000-0000-0000-0000-000000000bbb`, `acquisitions_enabled=true`, `acquisition_org_settings.my_leads_enabled=true`):

| ID | Case | Assertions |
|---|---|---|
| T0 | seam preflight | greps the repo for the S1-S8 names and `data-testid` list; fails with the missing seam named. Also asserts `assertLaneSafe("ci")`. |
| T1 | synthetic lead + strip reason | Lead is `is_training=false`. Strip (`call-next-strip`) shows the lead; row text under `call-next-reason-<id>` equals the `reason` returned by the strip RPC called through the rep's authenticated client (`fn_get_my_leads_call_next(p_org_id, p_member_id)`, Phase 1b) and `tier` is 5 for the seeded lead; a second seeded lead with an unanswered inbound text ranks above it with a tier-2 reason; DNC-locked leads are absent (not flagged); no-phone leads are absent from `rows` and listed in `excluded`. |
| T2 | Comp this lead (fixture) | Click `comp-this-lead-<id>`: `numbers-card` shows as-is 200000 and range; `numbers-arv` shows "unavailable" (never 0; `calculateClosr` zero-fills missing ARV, `src/lib/calculators/closr-v1.ts:49`); `lead_comps` has one row `provider='fixture'`. Low-confidence variant lead shows `numbers-verify-first`. A second click does not add a second `lead_comps` row inside the cache window. Comps never block visibility: with `COMPS_PROVIDER` call failing (stub variant) the row still renders "comps pending". |
| T3 | Dial (stub) → hangup → prompt | Click `call-button-<id>`: exactly one stub dial record whose `custom_data` equals `dialpad_call_intents.custom_data` for that lead and whose phone equals `destination_e164`; double-click sends one (idempotency + 5/min guard). Spec posts signed `calling`, `connected`, `hangup` events (4.2) with the intent's `custom_data`; hangup carries `public_call_review_share_link` and `admin_recording_urls[0]`. Then: one `acquisition_attempts` row for the lead, `recording_url` = share link; `call_activities.provider_recording_url` set; intent `status='matched'`. `page.clock.runFor(10_000)` makes `post-call-prompt` open, outcome pre-set to reached. Re-posting the same events (replay) creates no second attempt. Prompt does not open while another dialog is open; it opens after that dialog closes. |
| T4 | "Next week" → one appointment everywhere | Type a note in `post-call-note`, click `post-call-pick-next-week`. DB: one `tasks` row type `appointment`, mode `phone`, `end_at = due_at + 15 min`, due equal to `quickPickDueAt(now,'next_week')` (S5); one `lead_notes` row with the note. Surfaces: My Leads row/detail, `/leads/<id>`, `/calendar?view=agenda` and month cell, `/dashboard` `tasks-panel`: each exposes `data-next-step-id` = the task id and `data-next-step-due-at` = the DB `due_at` ISO, and the visible label equals the shared formatter. A second rep's dashboard does not show it (viewer-scoped, unchanged). No `follow_up`/`callback` row exists for the lead (`select count(*) from tasks where type in ('follow_up','callback') and related_property_id=$1` = 0). |
| T5 | Callback due alert and pin | Book a phone appointment due in 90 s through `fn_create_next_step` (phone) as the rep. Within the poll, `callback-due-banner` shows and the lead is rank 1 in the strip with the "Callback due now" reason; click Call: second stub dial record. Appointment not yet due (e.g. +10 min) shows no banner. "Call today" pins to rank 1 until midnight Central (assert `my_leads_strip_overrides.pinned_until` is the next Central midnight); "Not today" hides it until midnight Central. Expiry is database-time (SQL `now()`), which `page.clock` cannot move, so the spec drives it through the fixture: `expireStripOverride(db, propertyId)` sets `pinned_until`/`hidden_until` to one minute ago, and the next refresh must show the pin gone and the hidden lead back. |
| T6 | Send contract (stub Dropbox Sign) | Org e-sign integration seeded `test_mode=true`. Fill price and closing date, review line (`contract-review-line`) shows seller name(s), legal description, price, closing date. Click `contract-send`. Before the stub returns: no `acquisition_offers` row. With stub `ok`: `esign_requests.delivery_state='sent'` (enum `esign_delivery_state`, `20260829194500_esign_foundation.sql:43-45`), then exactly one `acquisition_offers` row keyed on that request id, stage `offer_sent`, and an "Offer follow-up" appointment due at closing minus N days, strictly after `sent_at` (`follow_up_at > sent_at` check, `20260912090200_acquisition_attempt_offer_facts.sql:100`). Stub `slow_then_abort`: `contract-status` shows "send unconfirmed", no offer row, stub receives exactly one POST even after reload and after invoking `/api/cron/esign-send-reconciliation` with the bearer secret, never a second send. Stub `reject`: no offer row, error shown, no follow-up appointment. Pending offer inserted by the fixture **after** Send has passed the card's precheck and before the stub answers (stub mode `slow` holds the response about 5 s; a pending offer that already existed at click time is correctly stopped by the precheck and is not this case): contract reaches `sent`, projection row status `conflict` (`PENDING_OFFER_EXISTS`) visible on lead and strip, nothing re-sent. Timeout case: the CI lane sets `ESIGN_PROVIDER_TIMEOUT_MS=5000` (seam S9) so `slow_then_abort` completes within the 120 s test timeout; the real 4-minute provider abort is covered by the core's own unit test. Comp settings, the title company, the buyer entity and the typed legal-description text come from the fixture (4.2), never from fixture comps. |
| T7 | Training isolation | Seed a training lead (service-role insert, `is_training=true`, dedicated contact, `status='new_lead'`, per the guard `20260908120000_training_lead_guards.sql:20-31`), dial via stub, post the three events. Expect: `call_activities.call_purpose='internal_training'`, `property_id is null`, zero `acquisition_attempts` for it, no prompt even after `page.clock.runFor(30_000)`. |
| T8 | Native-call match and no-match (stubbed events) | With the `native_matcher` flag on (seeded by the fixture): post a hangup for an event with no `custom_data` and `external_number` equal to the synthetic lead's phone, target = bound dialpad user: attempt with `provider_attempt_key='dialpad-native:<call_id>'`, prompt on next poll. Number on two leads assigned to the rep: disposition `quarantined`/`ambiguous_lead`, strip shows "Assign to lead". Unknown number: `quarantined`/`no_lead_match`. Phase 2 owns the exact reason strings; assert against its exported constants. |
| T9 | Retire | `retireSyntheticLead`: open appointments cancelled through the lifecycle function, property `deleted_at` set, no open task remains; assert the **retained inventory** (attempts, offers, notes, intents, events and the cancelled tasks are still present and counted in the report), not zero rows. No deletion is attempted. |

- Side effects checked: the default suite runs with `retries: 2` in CI (`playwright.config.ts:153`); T3-T6 are not idempotent, so the describe is `serial` and `beforeAll` truncates + reseeds, and each test begins by asserting its precondition rows instead of assuming a prior retry's state. `workers:1` (`:148`). The e2e job's wall clock is already near its 45-min cap (`e2e.yml:21`); the new step runs one extra server, budget about 6 minutes.
- Tests: the spec is the test. Run locally `TEST_SUPABASE_URL=... npm run test:e2e -- e2e/my-leads-close.spec.ts` against a disposable local stack (`supabase start` in a throwaway workdir; the global guard refuses non-disposable targets, `src/lib/supabase/e2e-target-safety`).
- Rollback: revert the PR; remove the workflow step and grep-invert token.

#### 4.4 Attended real-provider acceptance (preview and production)
- Files: create `e2e/prod-canary/my-leads-close-attended.spec.ts`; append a coverage paragraph to `e2e/prod-canary/README.md`.
- Change: gated like every canary: `requireProdCanaryEnv()` throws unless `RUN_PROD_CANARIES=1` (`e2e/prod-canary/support.ts:60-70`), and the default config ignores `**/prod-canary/**` (`playwright.config.ts:137-146`). Run: `RUN_PROD_CANARIES=1 MY_LEADS_CLOSE_LANE=production MY_LEADS_CLOSE_OWNED_PHONES=+1XXXXXXXXXX PROD_HUGO_STORAGE_STATE=<captured Hugo state of Jarrad> npx playwright test --config playwright.canary.config.ts e2e/prod-canary/my-leads-close-attended.spec.ts --headed`. Jarrad's own session is required: the Dialpad binding is verified against his Dialpad user email, so the unattended Hugo canary identity cannot place the call. The spec is `serial`, headed, with `expect.poll` timeouts up to 180 s for steps that wait on the human.
  - Lane `preview`: Vercel preview of the Phase PR, hosted test project, `DIALPAD_DIAL_PROVIDER=stub`, `COMPS_PROVIDER=fixture` (set as Preview-scoped env vars), real Dropbox Sign test-mode key on the preview org's integration (`org_esign_integrations.test_mode=true`). Covers T1-T7 equivalents plus real test-mode contract send: asserts `esign_requests.test_mode=true`, `sign_request_id` present, `delivery_state='sent'`, offer logged once; ends by voiding the request through the app's void action. The hosted test project is shared; queue behind the `e2e-shared-test-project` group (add the same `concurrency:` block as `db-migrate-test.yml:70-73` to any workflow that drives it).
  - Lane `production`: real Dialpad, `COMPS_PROVIDER=attom` (only after Jarrad approves the trial verdict and spend ceiling, else `fixture` is not available in prod, so skip step "Comp" and record it as not run), contract card exercised only up to the review line and `Send` disabled/blocked because production eSign is live mode and no test-mode org exists with a Dialpad connection. The contract send is proven in the `preview` lane; record that split in the receipt.
  - Steps in the production spec (each `test.step`): (1) guard: owned phone in allowlist, label `PROD-CANARY <runId>`, `assertProdSupabaseUrl`; (2) create synthetic non-training lead assigned to Jarrad (service client for `properties`/`contacts` as `insertCanaryProspect` does, `support.ts:732`; acquisition rows through the app's own assignment observer, same note as `my-leads-queue.spec.ts:44`); (3) strip shows it with a reason; (4) **ATTENDED** click Call, Jarrad answers on the owned phone and speaks about 20 seconds then hangs up; (5) poll DB (via `PROD_SUPABASE_DB_URL`, read-only role) until attempt, share link on `acquisition_attempts.recording_url`, `provider_recording_url`; (6) prompt opens prefilled; (7) click "Next week", assert the four-surface identity of T4; (8) Dialpad transcript/AI summary: poll `call_transcripts.status` / `call_transcripts.summary_status` and `dialpad_call_artifact_fetches.ready_at` up to 10 min, record minutes-to-ready per artifact (informational, feeds the monitoring thresholds); (9) callback alert: book due in 2 min, wait, banner + pin; **ATTENDED** click Call once; (10) retire: `retireSyntheticLead` (F1: lifecycle cancellation and soft retirement; immutable evidence is retained), run `rollback/retire-synthetic-lead.sql` in dry-run and attach its retained-inventory counts.
- Side effects checked: every dial reaches only an allowlisted owned number (guard pattern: `requireCanarySmsRecipient`, `support.ts:156-180`); the synthetic attempts count toward Jarrad's KPI tiles until retired (F3/F5), hence the retire script; Dialpad `initiate_call` is rate-limited 5/min per user (decision doc pre-reads), the spec issues at most 3 dials; production real calls cost phone minutes only.
- Tests: spec compiles in `npm run typecheck`; a dry run without `RUN_PROD_CANARIES` must throw the existing "Production canaries are disabled" error (assert in a vitest guard test `e2e/support/my-leads-close-fixture.test.ts`).
- Rollback: delete spec; `retire-synthetic-lead.sql` for rows already created.

#### 4.5 Mobile native-dial check (manual runbook step, attended, no code)
Recorded in the runbook as step M (below). It cannot be automated: the Dialpad mobile app is not drivable from CI. The spec in 4.4 does not cover it; step M's evidence queries are in the runbook.

#### 4.6 KPI before/after relabel comparison
- Files: create `scripts/rehearse-next-step-relabel-kpi.mjs`, `scripts/my-leads-close/kpi-snapshot.mjs`, `scripts/my-leads-close/kpi-compare.mjs`, `scripts/my-leads-close/kpi-rules.mjs`; modify `package.json` (`"verify:next-step-kpi-parity": "LC_ALL=C node scripts/rehearse-next-step-relabel-kpi.mjs"`, `"my-leads-close:kpi-snapshot": "node scripts/my-leads-close/kpi-snapshot.mjs"`, `"my-leads-close:kpi-compare": "node scripts/my-leads-close/kpi-compare.mjs"`) and `.github/workflows/e2e.yml` (last step of `search-local-suites`, before "Destroy disposable database" at `:242`).
- Change:
  - `kpi-rules.mjs` exports `RULES`: for each key returned by `fn_get_acquisition_kpis` (list at `20260930031000_...finalizer.sql:921`) a class.
    - `EQUAL_IN_CLOSED_WINDOWS` (before === after for every member and every window whose `p_end` is at or before the migration's applied time): `attempts, reached, offersSent, firstCallSamples, firstCallPending, firstCallElapsedSeconds (abs diff < 1e-6), appointmentsDue, appointmentsHeld, orgAppointmentsUnattributed, missingRecordings, recordingExpectationUnknown, averageTalkSeconds, talkTimeSamples, talkTimeUnknown, conversationsOverFiveMinutes`.
    - `EQUAL_UNLESS_CLOSEOUT`: `pendingOutcomes` equals before, or before minus the number of closed-out attempts whose `occurred_at` falls in the window (computed independently from `my_leads_housekeeping_before_images` rows of the `close_attempts` run).
    - `CURRENT_STATE_MAY_CHANGE` (not compared to before; compared to an independent recomputation, see below): `staleLeads, contactWithoutFollowUp, needsOffers, appointmentsOverdue, lastAttemptAt, asOf, lastAttemptClockVersion`.
  - Independent oracle for the current-state tiles (not the same function twice): after-value of `contactWithoutFollowUp` must equal `before - n` where `n` = number of Contacted queue leads whose only open future next step was a `callback`/`follow_up` (read from Phase 1e's `my_leads_housekeeping_before_images` joined to `my_leads_housekeeping_runs` where `kind='relabel'`, the only before-image store; the 1a.5 before-image carries `related_property_id`) and which now have an open future `appointment`. SQL:
```sql
-- before-image: my_leads_housekeeping_before_images, table_name='tasks', row_id = task id,
-- before = {type,status,due_at,snoozed_until,end_at,calendar_chain_id,mode,related_property_id}; run kind='relabel'
select count(distinct (b.before->>'related_property_id')) as expected_drop
from public.my_leads_housekeeping_before_images b
join public.my_leads_housekeeping_runs r on r.id = b.run_id and r.kind = 'relabel' and r.id = :'run_id'
join public.acquisition_queue_states q on q.property_id = (b.before->>'related_property_id')::uuid and q.stage='contacted'
where b.table_name='tasks'
  and b.before->>'type' in ('callback','follow_up')
  and b.before->>'status' in ('open','snoozed')
  and (b.before->>'due_at')::timestamptz > :'migration_applied_at'
  and not exists (select 1 from public.tasks t0 where t0.related_property_id=(b.before->>'related_property_id')::uuid
        and t0.type='appointment' and t0.status in ('open','snoozed') and t0.due_at > :'migration_applied_at'
        and t0.id <> b.row_id and t0.created_at < :'migration_applied_at');
```
  - Attribution invariants (SQL, must return 0 rows): (a) `select * from acquisition_appointment_attribution where source='relabel_2026_10' and task_id in (select id from tasks where due_at <= :'migration_applied_at')` (history was not converted, D1); (b) `select task_id from acquisition_appointment_attribution group by 1 having count(*)>1`; (c) converted rows with `end_at is distinct from due_at + interval '15 minutes'` or `calendar_chain_id is null`; (d) any `offer_backfill` attribution row whose task `due_at <= :'migration_applied_at'` (a backfilled follow-up must never fall inside a closed historical window, so `appointmentsDue` stays equal there).
  - `kpi-snapshot.mjs`: read-only, refuses any non-`SELECT` (`set default_transaction_read_only = on`), refuses a database whose project ref is not `copflsklaefwzipsrjqz` (same guard idea as `scripts/export-sandra-cleanup-packet.mjs` `EXPECTED_PROJECT_REF`), env `SANDRA_PRODUCTION_DATABASE_URL` (existing name, `export-sandra-cleanup-packet.mjs:24`). Per member (Jarrad, Maria, Mel) × windows (every completed Central day from 2026-09-12, plus `[2026-09-01, 2026-10-01)`, plus `[2026-09-12, start of migration day Central)`), inside one transaction per call:
```sql
begin read only;
select set_config('request.jwt.claim.sub', :'owner_uid', true);
set local role authenticated;
select public.fn_get_acquisition_kpis(:'org'::uuid, :'member'::uuid, :'s'::timestamptz, :'e'::timestamptz) as kpi;
rollback;
```
    A member the function rejects (`NOT_FOUND`/`FORBIDDEN`, F4) is recorded as `{error: code}` and compared as equal-to-itself, not skipped silently. Output `kpi-<label>.json` with `{capturedAt, migrationAppliedAt?, rows:[{member,window,kpi}]}`; also records `select max(version) from supabase_migrations.schema_migrations`.
  - `kpi-compare.mjs before.json after.json --run-id <relabel run uuid> --closeout-count <n>`: applies `RULES`, prints a table, exit 1 on any violation or on a missing row.
  - `rehearse-next-step-relabel-kpi.mjs` (disposable DB only: requires `GITHUB_ACTIONS=true` or `E2E_DISPOSABLE_DATABASE=1`, loopback DB, same pattern as `scripts/provision-e2e-local-database.mjs:9-11`): (1) find the relabel migration = first file in `supabase/migrations` containing `relabel_2026_10`; if none, print `SKIP: pre-Phase 1` and exit 0; (2) `supabase db reset --local --version <largest version < relabel version> --workdir "$E2E_LOCAL_WORKDIR" --no-seed` (flag exists in CLI 2.117: "Reset up to the specified version"); assert `max(version)` equals it; (3) seed three members, ~30 leads in assorted stages, tasks of every type and status (open future, open past, completed held, no_show, cancelled, rescheduled, snoozed), attempts over 20 days, offers **including an overdue pending offer (follow-up 20 days past, no chain) and a not-yet-due pending offer**; legacy `callback`/`follow_up` rows open and closed, direct SQL insert as superuser (guard allows INSERT; attribution trigger runs, `20260912111000_acquisition_kpis.sql:13-26`); (4) snapshot A; (5) `supabase migration up --local --workdir ...`, then call the Phase 1e housekeeping functions directly as service role (`fn_my_leads_housekeeping_reassign`, `fn_my_leads_housekeeping_close_attempts`, `fn_my_leads_relabel_open_next_steps`, `fn_my_leads_backfill_offer_follow_ups`, each preview, then `p_apply := true` with the fingerprint that preview returned; no SQL file needs to be filled by anyone; the overdue offer's backfilled appointment must be due at the next 09:00 Central, with attribution source `offer_backfill`); (6) snapshot B; (7) compare; (8) invariants. Runs as the last step of the `search-local-suites` job because the reset leaves the DB fully migrated again.
- Side effects checked: the live function reads `my_leads_queue_rows(...)` current state, so the "before" snapshot must be taken the same day as the migration (windows are closed, current-state tiles are not compared to before). Reassigning Maria/Mel leads changes per-member current-state tiles by design; historical `attempts/offers/appointments*` are keyed to `actor_user_id`/attribution captured at insert (`20260912111000_acquisition_kpis.sql:13-26`) and do not move.
- Tests: the rehearsal is the test; plus vitest `scripts/my-leads-close/kpi-rules.test.ts` (rules table covers every key in the function's `jsonb_build_object`; a key missing from `RULES` fails, so a future KPI addition forces a classification).
- Rollback: delete scripts; revert the e2e.yml step.

#### 4.7 Retire script for the synthetic acceptance lead (lifecycle cancellation and soft retirement; no before-image kit, no deletion)
- Files: create `scripts/my-leads-close/rollback/retire-synthetic-lead.sql`. There is no migration and no before-image table in Phase 4: Phase 1e's `my_leads_housekeeping_runs` / `my_leads_housekeeping_before_images` (`20261005100000`) are the only before-image store, and data rollback is `node scripts/my-leads-housekeeping.mjs rollback --run <uuid>` (`fn_my_leads_housekeeping_rollback`), which refuses rows worked since capture (precedent: launch rollback blocked on activity, F12).
- Change: a psql script, `psql "$SANDRA_PRODUCTION_DATABASE_URL" -v run_tag='PROD-CANARY <runId>' -v owner_uid=<owner uid> -v commit=no -f scripts/my-leads-close/rollback/retire-synthetic-lead.sql`. It starts with `\set ON_ERROR_STOP on`, `begin;`, prints the inventory, and ends with `rollback;` unless `-v commit=yes`. It **deletes nothing**: appointments cannot be deleted (the owner-connection delete guard, `20260814150000_appointments_schema.sql:449`) and intents/events are permanent evidence (F1). Cleanup is lifecycle cancellation plus soft retirement, and any canary-only deletion path would need its own separately authorized design and is not built.
```sql
-- rollback/retire-synthetic-lead.sql  psql -v run_tag='PROD-CANARY <runId>' -v owner_uid=<uuid>
create temp table _p as select id from public.properties where address like :'run_tag' || '%';
select set_config('request.jwt.claim.sub', :'owner_uid', true);
-- 1. open appointments: lifecycle cancellation (never delete); an in-flight calendar sync must finish first (see below)
select public.fn_cancel_appointment(t.id) from public.tasks t
 where t.related_property_id in (select id from _p) and t.type = 'appointment' and t.status = 'open';
update public.tasks set status = 'cancelled', updated_at = now()
 where related_property_id in (select id from _p) and type <> 'appointment' and status in ('open','snoozed');
-- 2. soft retirement of the lead (the queue read excludes deleted properties)
update public.properties set deleted_at = now(), assigned_user_id = null where id in (select id from _p);
-- 3. the retained inventory the receipt records (immutable evidence stays)
select (select count(*) from _p) as properties_retired,
       (select count(*) from public.tasks where related_property_id in (select id from _p) and status in ('open','snoozed')) as open_tasks_left,   -- must be 0
       (select count(*) from public.acquisition_attempts where property_id in (select id from _p)) as attempts_kept,
       (select count(*) from public.acquisition_offers where property_id in (select id from _p)) as offers_kept,
       (select count(*) from public.lead_notes where property_id in (select id from _p)) as notes_kept,
       (select count(*) from public.dialpad_call_intents where property_id in (select id from _p)) as intents_kept;
```
  Run with `-v commit=no` first and attach the inventory; the receipt notes the KPI delta of the kept attempts and offers instead of forcing their removal.
- Side effects checked: no row is deleted, so no FK or guard can refuse the run; `fn_cancel_appointment` queues a Google `cancel` only for rows that carry an event (1a.4b), and a still-pending calendar mutation must be allowed to finish first, hence the pre-check (`select count(*) from public.task_calendar_mutations m join public.tasks t on t.id = m.source_task_id where t.related_property_id in (select id from _p) and m.phase in ('pending','provider_done')` must be 0). The kept attempts and offers stay in Jarrad's KPI tiles; the receipt states the delta.
- Tests: a dry-run of the script against the disposable DB seeded with a synthetic lead (reports `open_tasks_left = 0` and the kept counts, then rolls back); a commit run leaves every evidence row in place.
- Rollback: delete the script.

#### 4.8 Release runbook document
- Files: create `docs/my-leads/RELEASE-RUNBOOK.md`; content = the "Release runbook" section of this plan, verbatim, with PR numbers and SHAs filled in as each phase ships (a living file; each release appends a dated receipt block, modelled on `docs/my-leads/plan/ACCEPTANCE-RECEIPT.md`).
- Tests: `scripts/my-leads-close/lease-manifest.mjs` (below) is exercised by `scripts/my-leads-close/lease-manifest.test.mjs` (`node --test`): given a fixture git repo it lists changed files, migration versions in order, flags a migration older than the newest on main, and lists `vercel.json` cron diffs.
- Change for `lease-manifest.mjs <pr-number>`: uses `gh pr view <n> --json headRefOid,baseRefName,files,statusCheckRollup` and `git diff --name-only origin/main...<sha>`; prints the lease request block (below); exit 1 if checks are red, head is not the approved SHA (`--approved-sha`), a migration version sorts before `origin/main`'s newest, or another open PR touches the same paths (`gh pr list --state open --json number,files`).
- Rollback: delete files.

#### 4.9 Monitoring pack
- Files: create `scripts/my-leads-close/monitor.sql`, `scripts/my-leads-close/monitor.mjs`; modify `package.json` (`"my-leads-close:monitor": "node scripts/my-leads-close/monitor.mjs"`).
- Change: `monitor.mjs [--since 48h] [--expect-phase <1|2|3>]` reads `SANDRA_PRODUCTION_DATABASE_URL`, refuses any non-prod project ref, sets `default_transaction_read_only = on`, runs each query block in `monitor.sql` separated by `-- @name`, `-- @phase <n>`, `-- @requires <objects>`, `-- @threshold <expr>` headers. `@requires` takes tables **and columns** (`schema.table` or `schema.table.column`, resolved through `information_schema`), so a block that reads `dialpad_call_intents.failed_at` or `acquisition_attempts.prompt_acknowledged_at` is SKIPPED, not failed, on a schema that lacks the column. A block whose requirements are absent prints `SKIPPED (not deployed)`; `--expect-phase n` turns SKIPPED into failure only for blocks tagged `@phase` n or lower (`--expect-all` is an alias for `--expect-phase 3`), so the Phase 2 release does not demand Phase 3 tables. Exit code 1 if any threshold breaches. Queries are in "Monitoring (first 48 hours)" below.
- Side effects checked: read-only role; uses `public.*` tables closed to `service_role` (F5), so the connection must be the owner connection already used by `export-sandra-cleanup-packet.mjs` (`DATABASE_URL_ENV`, `:24`).
- Tests: `scripts/my-leads-close/monitor.test.mjs` (`node --test`): parser handles the four headers including column requirements; run against three fixture schemas, **pre-Phase-1, Phase-1 and Phase-2**: no block errors, blocks beyond the schema are SKIPPED, and `--expect-phase 2` passes on the Phase-2 schema while `--expect-phase 3` fails only on the Phase 3 blocks; `--expect-phase n` fails on a SKIPPED block of phase n or lower; a non-prod ref is refused; a statement beginning with anything but `select|with` is refused.
- Rollback: delete files.

---

## Release runbook (copy verbatim into `docs/my-leads/RELEASE-RUNBOOK.md`)

### Ground rules
1. One shared release queue. No merge, migration, deploy or domain promotion without the root orchestrator's exact-SHA lease, overnight included: Jarrad's authorization covers the content, root's slot covers the timing. This supersedes the "merge immediately once both approvals are in" habit (decision recorded in `shared-release-queue` memory, 2026-10-03). A PR is reported "ready, awaiting release lease" until then.
2. A PR is offered for merge only after Claude review and Codex `APPROVE_MERGE: YES` at its current head. Re-verify the head SHA equals the approved SHA immediately before merging.
3. Credentials only through the BMH service-account `op` path, minimum fields, never printed, never pasted into argv logs.
4. Real calls and provider writes in production are allowed only against canary-tagged synthetic leads and owned numbers (AGENTS.md "pre-user production-canary autonomy"). Contacting real leads, spending beyond the ceiling, applying migrations outside the pipeline below, and merging into another owner's branch still need approval.
5. `main` is never touched by a stacked child before its parent. Verify `gh pr view <child> --json baseRefName` equals the parent branch until the parent merges and its head branch is deleted.

### Lease request template (post to root before every merge)
```
LEASE REQUEST  phase: <0|1|2|3|4>  PR: #<n>  base: <branch>
candidate SHA: <40 hex>      (approved by: Claude <sha>, Codex APPROVE_MERGE: YES <sha>, raw verdict file <path>)
CI at this SHA: Playwright golden paths ✔, Search RPC… (disposable DB) ✔, Typecheck and unit/RTL tests ✔, Hugo lifecycle migrations on PostgreSQL 17 ✔
affected files (from `node scripts/my-leads-close/lease-manifest.mjs <n> --approved-sha <sha>`):
  migrations (ordered, with versions):
  src/app routes / server actions:
  src/lib:
  vercel.json (cron diff):
  workflows / scripts / docs:
shared-file overlap with open PRs: <none | #n: paths>
env / flags needed before merge: <none | names, scope>   after merge: <names, scope, who flips>
data operations to run after merge: <none | op, preview fingerprint, housekeeping run id>
rollback: <flag to flip first | rollback script | forward fix>
people required at merge time: none if the Production environment still has no required reviewers (operator-verified at this slot: paste `gh api repos/biginkc/sandra/environments/Production` protection rules and the timing of the last prod-migration run here; do not rely on this document)
estimated window: merge → migrations applied ≈ 10-15 min (test run, then the automatic prod apply about a minute later)
```

### Per-phase pipeline (identical mechanics, every phase)
1. Lease granted. Re-check: `gh pr view <n> --json headRefOid,mergeable,baseRefName`; `git fetch origin main`; `node scripts/check-migration-safety-cli.mjs --target=sandra-production` is run by CI, locally only with PG env; the manifest script already compares versions to `origin/main`.
2. Merge (`gh pr merge <n> --squash` unless the repo's merge style says otherwise; stacked children first retarget when the parent head branch is deleted).
3. Two things start automatically: Vercel production deploy of `main` (F8; its flag-off path is inert until the migration run, per the feature-flag row) and `Apply Supabase migrations to test` (`db-migrate-test.yml`, queued in group `e2e-shared-test-project`). Watch: `gh run list --repo biginkc/sandra --workflow "Apply Supabase migrations to test" --limit 3`.
4. On test success, `Apply Supabase migrations to prod` starts by itself (`workflow_run`; the `Production` environment has no required reviewers as of 2026-10-04, so there is no approval step and it finishes about a minute later; if Jarrad restores a reviewer the run pauses and `gh api repos/biginkc/sandra/actions/runs/<run_id>/pending_deployments` shows it). Do not enable any flag before this finishes.
5. Verify migrations landed (read-only, Supabase MCP `execute_sql` on project `copflsklaefwzipsrjqz`, or psql with the owner URL):
```sql
select version, name from supabase_migrations.schema_migrations where version >= '20261004' order by version;
```
   Every version in the lease manifest must be present, in order, and nothing older than the previous high-water was inserted. The prod job's log must show the safety gate pass, the dry-run list equal to the manifest, then the push.
6. Verify Vercel: latest production deployment is READY and built from the merged SHA (`vercel ls sandra --scope jarrad-5416s-projects --prod` then `vercel inspect <url>`; confirm flag names with `vercel --help` if the CLI version differs).
7. Smoke with flags **off** (the code must be dormant): `curl -s -o /dev/null -w "%{http_code}\n" https://sandra.bmhgroupkc.com/login` is 200; run the existing canary `RUN_PROD_CANARIES=1 npx playwright test --config playwright.canary.config.ts e2e/prod-canary/my-leads-queue.spec.ts e2e/prod-canary/lead-management.spec.ts` (uses `PROD_*` secrets, as `canary-leads-browser.yml` does, dispatch-only today); the My Leads page loads for Jarrad with the five sections and nine KPI tiles unchanged.
8. Enable flags in the order given per phase below, one at a time, smoke after each (Jarrad opens `/my-leads` himself where noted).
9. Bake window per phase (below) with `npm run my-leads-close:monitor` every 2 h; abort criteria in "Abort and revert".
10. Append the receipt block to this file: PR, SHA, migrations applied (versions), deployment id, flags state, data-op ids and counts, canary results, KPI comparison result, limitations. Preview and production outcomes recorded separately.

### Flags and environment (set per phase)
Rule: kill switches live in the database, in `my_leads_feature_flags` (contract row; created in P1a-core `20261005120000`), so reverting is instant and auditable; flip them with `node scripts/my-leads-flags.mjs <flag> <on|off> --org <uuid>`. Vercel env vars are for secrets and provider selection, and changing one needs a redeploy (set with `vercel env add NAME production --scope jarrad-5416s-projects`, secret values piped from `op` without echo; the Dialpad provisioning script already uses sensitive production env names, `src/lib/dialpad-cti/provisioning.ts` header). Never set in production: `E2E_AUTH_BYPASS`, `E2E_QUIET_HOURS_NOW`, `DIALPAD_DIAL_PROVIDER=stub`, `COMPS_PROVIDER=fixture`, `DROPBOX_SIGN_API_BASE_URL` (S1 and S3 are ignored in production anyway); verify with `vercel env ls production`. Every revert has two layers (contract row "Revert"): (1) the flag off, (2) the before-image rollback (`fn_my_leads_housekeeping_rollback(run_id)`) and the `supabase/rollbacks/` twin for the schema.

| Phase | Flag / env | Default | Set when | Revert effect |
|---|---|---|---|---|
| 1 | next-step writers use unified path (code, not a flag; the reject trigger is the last migration, `20261008100000`) | n/a | n/a | n/a |
| 1 | `call_next_strip` | off | after 1b smoke and Jarrad's visual check | strip hidden, sections unchanged |
| 1 | `post_call_prompt` | off | after 1c smoke | old attempt dialog returns (it stays in the tree until p1a-retire) |
| 1 | Seller morning-of reminders: flag `seller_reminders` AND `seller_reminder_settings.enabled` + cron route in `vercel.json` | off | last, after a dry-run of the job against the synthetic lead and Jarrad's verbatim text | no texts sent; queued rows cancelled; a row already claimed is cancelled at dispatch |
| 2 | Dialpad dial key env (`DIALPAD_CTI_DIAL_KEY_*`), only if Phase 0 shows the directory key lacks dial scope | unset | before `click_to_dial` | Call button falls back to the softphone |
| 2 | `click_to_dial` | off | after env + smoke | button falls back to the softphone path |
| 2 | `native_matcher` | off | **before** connection activation | events quarantined `no_custom_data` as today |
| 2 | `auto_prompt`, `callback_alert` | off | after matcher | manual prompt only |
| 2 | `artifact_fetch` (gates the `dialpad-artifact-sweep` cron, 2.9) | off | after the first attended call | job idle |
| 2 | Dialpad connection `status='active'` | disabled | last (see Release 2) | see revert |
| 3 | `COMPS_PROVIDER=attom`, `ATTOM_API_KEY`, monthly cap, `org_comp_settings.auto_comp_enabled` | `off` / false | after Jarrad's trial verdict and spend ceiling | no pulls; "comps pending" |
| 3 | `call_screen`, `contract_card`, `offer_projection` (gates the projection sweep; on with `contract_card`), `comp_queue` (gates the comp queue drain and the strip enqueue; on with `COMPS_PROVIDER=attom`) | off | after Phase 3 smoke | existing eSign dialog; sweeps idle |
| 3 | `facts_job` (gates the `call-facts-sweep` cron) and AI-facts extraction (`FACTS_PROMPT_V1`) | off / null (summary note only) | `facts_job` after the Phase 2 artifact fetch has run; extraction after Jarrad's verbatim text lands | extractor off |

### Release 0: Phase 0 spike window (no merge)
Uses Phase 0's own scripts (`scripts/my-leads-phase0/`, see Phase 0 in TECH-PLAN-2026-10.md); Phase 4 adds only the independent before/after checks.
1. Present: **[JARRAD]** (he answers calls and approves the typed confirmation phrases).
2. Read-only first: `npx tsx scripts/my-leads-phase0/dialpad-key-probe.ts --org-id <uuid>` (reads the user-scoped subscription state and picks the live key).
3. Independent "before" evidence (do not rely on the script's own state file): `select id, status, updated_at from public.dialpad_org_connections;` must show `disabled`; `select count(*), max(received_at) from public.dialpad_call_events;` recorded.
4. Open the window with the script (`dialpad-live-test.ts open-window ... --i-am-present`, typed phrase `OPEN WINDOW <first 8 of connection id>`), run the calls, then `close-window`. The window self-closes at its cap (default 60 min, max 90).
5. Independent "after" evidence: `select status from public.dialpad_org_connections;` is `disabled`; `dialpad-live-test.ts verify-clean --run-id <slug>` exits 0; events stored during the window are the only replay candidates: `select disposition, disposition_reason, count(*) from public.dialpad_call_events where received_at >= '<window start>' group by 1,2;`. If anything is not `disabled`, rerun `dialpad-live-test.ts close-window --run-id <slug>` (restores the subscription first, then the guarded one-row flip) and `verify-clean`; do not run hand-written SQL against `dialpad_org_connections`.
6. Exit receipt: findings under `docs/my-leads/phase0/findings/` and the section appended to the decision doc (Phase 0 deliverable).

### Release 1: Phase 1 (sub-releases in order)
**R1.0 Kit.** Merge `p4-before-image` (lease; KPI parity harness, lease manifest and monitor; no migration, no behaviour). Verify the harness runs: `LC_ALL=C node scripts/rehearse-next-step-relabel-kpi.mjs` prints `SKIP: pre-Phase 1`.

**R1.1 Baseline capture (read-only, same day as R1.3, T-1 h).**
- `npm run my-leads-close:kpi-snapshot -- --out /private/tmp/kpi-before.json` (members: Jarrad, Maria, Mel; windows per 4.6). Keep the file off-repo; record sha256 and row counts in the lease. It contains no seller PII, but treat as internal.
- Pre-capture counts that the later receipt must reproduce:
```sql
select count(*) filter (where assigned_user_id = :'maria') as maria_leads, count(*) filter (where assigned_user_id = :'mel') as mel_leads
  from public.properties where org_id = :'org' and deleted_at is null;
select count(*) from public.tasks where org_id = :'org' and status in ('open','snoozed') and assignee_id in (:'maria', :'mel');
select count(*) from public.tasks where org_id = :'org' and status in ('open','snoozed') and type in ('callback','follow_up') and due_at > now();
select count(*) from public.acquisition_attempts where org_id = :'org' and source = 'sandra' and outcome is null and occurred_at < now() - interval '7 days';
select count(*) from public.rep_sms_obligations where org_id = :'org';          -- must not change in R1.3 (F6)
select version from supabase_migrations.schema_migrations order by version desc limit 1;
```
- Jarrad flags in-person appointments by hand later (`fn_set_next_step_mode`); it is not a gate before R1.5.

**R1.2 Merge P1e** (housekeeping tables and functions; additive, no behaviour). Standard pipeline. Verify the tables exist and are closed: `select has_table_privilege('service_role','public.my_leads_housekeeping_runs','select');` is `false`.

**R1.3 Run the P1e data operations (reassign leads and open tasks, close stale attempts), service role via the script.**
- Present: **[JARRAD]** approves each pasted preview and its `--confirm` fingerprint (reassign: eligible=false episodes by contract; close-out: `not_logged`).
- Preview: `node scripts/my-leads-housekeeping.mjs reassign --org <uuid> --target <jarrad> --owner <owner>` and `… close-attempts --org <uuid>` (no `--apply`). Compare counts against R1.1; a mismatch aborts.
- Apply: `… --apply --confirm <fingerprint printed by the preview>` (validated inside the RPC under row locks; a changed candidate set raises `HOUSEKEEPING_PREVIEW_STALE` and nothing is written); each apply writes a `my_leads_housekeeping_runs` row and its before-images in the same transaction as the mutation; reassigning open appointments goes through `fn_reassign_appointment` (calendar ledger).
- Verify (the run summary is the source of truth, not the script's own state file):
```sql
select kind, status, summary from public.my_leads_housekeeping_runs where id = :'run_id';   -- counts equal the preview
select table_name, count(*) from public.my_leads_housekeeping_before_images where run_id = :'run_id' group by 1;
select count(*) from public.rep_sms_obligations where org_id=:'org';   -- unchanged from R1.1
select count(*) from public.acquisition_attempts where org_id=:'org' and source='sandra' and outcome is null and occurred_at < now() - interval '7 days';  -- 0 after the close-out
```
  `calendar-mutation-sweep` runs every 5 minutes (`vercel.json:39-42`); after 10 minutes `select phase, count(*) from public.task_calendar_mutations where created_at > :'op_started' group by 1;` shows no `pending`/`provider_done`/`failed` residue.
- Rollback: `node scripts/my-leads-housekeeping.mjs rollback --run <uuid>` (preview first; `fn_my_leads_housekeeping_rollback` refuses rows worked since capture), after Jarrad's go.

**R1.4 Merge P1a-core and P1a-writers (lease each), then relabel and the offer backfill (after R1.3 so attribution lands on Jarrad, N2).**
- After P1a-writers is deployed: `node scripts/my-leads-housekeeping.mjs relabel --org <uuid>` (preview), then `--apply --confirm <fingerprint>`; then `offer-backfill` the same way (overdue offers get their appointment at the next 09:00 Central, never in the past). Each is its own run row with before-images (the relabel before-image carries `related_property_id`).
- Verify with `npm run my-leads-close:kpi-snapshot -- --out /private/tmp/kpi-after.json` then `npm run my-leads-close:kpi-compare -- /private/tmp/kpi-before.json /private/tmp/kpi-after.json --run-id <relabel run id> --closeout-count <n>` exit 0; invariant SQL from 4.6 returns 0 rows; `select type, mode, count(*) from tasks where status in ('open','snoozed') and due_at > now() group by 1,2;` shows no open future `callback`/`follow_up`.
- Rollback: default is forward (flags off; appointment rows are valid to old code). `… rollback --run <relabel run id>` only after its own preview (rows since completed are reported `notRestored`).

**R1.5 Merge P1b, P1c, P1c-2, P1d** (strip, prompt, seller reminders, link capture; each its own lease). Pipeline; flags in order: `call_next_strip` → `post_call_prompt` → seller reminders. After each, **[JARRAD]** opens `/my-leads` and confirms; Claude runs the canary spec and `monitor`. The optional link backfill is `… link-backfill` (preview, approval, apply).
**R1.6 Retire (last).** Phases 2 and 3 release between R1.5 and R1.6 (below); the reject trigger `20261008100000` merges after the ≥24 h bake with a `post_call_prompt` flag already on in production (so the old attempt dialog can be deleted in the same PR). Prove zero legacy writers since the code deploy time `<t>`:
```sql
select count(*) from public.tasks where type in ('follow_up','callback') and created_at > :'t';   -- must be 0
```
Only then merge the retire PR (own lease; it also runs `fn_my_leads_next_step_retire_preflight`, which must report `openFutureLegacy = 0`). Its rollback is `drop trigger` (its `supabase/rollbacks/` twin).
Phase 1 bake: 24 h; thresholds in monitoring below.

### Release 2: Phase 2 (dialing and matching), connection enabled last
Preconditions, all true and recorded: `native_matcher` tested on the synthetic lead through stub-signed events (T8 of `e2e/my-leads-close-phase2.spec.ts`, shipped by the `claude/my-leads-p2-acceptance` slice that merged before this release, green at this SHA) and turned on in production immediately before activation (nothing to match until then); `contact_phone_numbers` backfilled with `phone-backfill` and the trigger live; `ack-legacy-prompts` applied; `dialpad_call_events` has no `received` rows older than 5 min; Phase 0 findings confirm whether natively dialed calls (desktop, mobile) fire events with the user-scoped subscription.
1. Env: the Dialpad dial key env (`DIALPAD_CTI_DIAL_KEY_*`) only if Phase 0 shows the directory key lacks dial scope; `DIALPAD_DIAL_PROVIDER` is never set in production (the S1 stub is ignored there). Redeploy if an env changed. Smoke: `click_to_dial` still off.
2. Subscription state: `GET /api/v2/subscriptions/call` shows the user-scoped subscription `enabled` for Jarrad's Dialpad user (the provisioning plan at `provisioning.ts:450-476` models canary users and `wrong_states`). If Dialpad auto-disabled it after the 401 period (decision doc pre-reads), re-enable through the Phase 2 activation script, not by hand.
3. **Activate:** dry-run the Phase 2 webhook-only activation path (F10): `npx tsx scripts/provision-dialpad-cti.ts --mode activate --org-id 00000000-0000-0000-0000-000000000bbb --company-id <id> --canary-user-id <jarrad dialpad id>` prints the plan digest; **[JARRAD] present**; turn `native_matcher` on, then apply with `--execute --expect-plan <digest> --confirm-live-readiness <connection id>`. Before: `select id,status from public.dialpad_org_connections;` After: `status='active'`.
4. Immediately: the attended sequence of 2.11 step 7, in its order, each consumer flag enabled right before the test that needs it: native calls (`native_matcher` already on); then `click_to_dial` on and one Call from the strip (4.4 steps 4-7); then `auto_prompt` on and the prompt check; then `callback_alert` on and the banner check. `select disposition, disposition_reason, count(*) from public.dialpad_call_events where received_at > now() - interval '15 minutes' group by 1,2;` shows `matched` for the dialed call and, for Jarrad's other habit calls, `quarantined / no_lead_match`, never a pile of `no_custom_data`.
5. Artifact fetch: turn `artifact_fetch` on only after the first attended call, then the artifact fetch cron `dialpad-artifact-sweep` (2.9) shipped with Phase 2 and idles while `artifact_fetch` is off; after the first attended call and the flag flip invoke it once with the bearer secret and read the summary JSON.
- **Revert (preferred, lossless):** turn off `callback_alert`, `auto_prompt`, `click_to_dial`, `native_matcher`, `artifact_fetch` in that order (layer 1; layer 2 is the before-image/rollback twin where data or schema must go); the connection stays active so events keep being stored and can be replayed later (F11). **Revert (full):** only the tested `npx tsx scripts/provision-dialpad-cti.ts --mode deactivate --org-id 00000000-0000-0000-0000-000000000bbb --company-id <id> --canary-user-id <jarrad dialpad id> --execute --expect-plan <digest> --confirm-live-readiness <connection id>` (dry-run first for the digest; it disables each subscription and re-reads it BEFORE flipping the connection). Never `update public.dialpad_org_connections` by hand. Warning: while disabled the webhook returns 401 and nothing is stored (F11), which is why the subscriptions go first; plan to re-enable at the next activation. Verify `select status from public.dialpad_org_connections;`.
- Bake 48 h with the monitor at 15 min, 1 h, 2 h, then every 4 h.

### Release 3: Phase 3 (comps, call screen, contract card)
1. Preconditions: Jarrad's ATTOM verdict, written thresholds and the production monthly cap he sets after the verdict (the $20 trial spend is separate and already approved). Without them, ship with `COMPS_PROVIDER=off` and say so in the receipt.
2. `ATTOM_API_KEY` (item `ATTOM - API`, `op` → `vercel env add`), monthly cap (still `0` until Jarrad sets it after the trial verdict), and after the verdict `org_comp_settings.auto_comp_enabled=true` (it defaults false and nothing else turns it on, so the automatic top-ten pull needs this step) and the `comp_queue` flag, redeploy, `COMPS_PROVIDER=attom`. Smoke: one **Comp this lead** on the synthetic lead only; `select provider, fetched_at, confidence from public.lead_comps order by fetched_at desc limit 5;` shows `attom`; check the vendor usage count against the cap.
3. `call_screen` on, then `offer_projection` and `contract_card` on (the projection sweep must run before any contract send). Contract card live-mode send is **not** part of this release: production eSign is live (`org_esign_integrations.test_mode` false would send a real, billable, legally binding request); the first live send needs Jarrad's separate go on a real offer. The test-mode send was proven in the preview lane (4.4).
4. The facts cron `call-facts-sweep` (idle until `facts_job` is on; turn it on after the Phase 2 artifact fetch has produced transcripts) (the only cron Phase 3 adds besides comps and offer projection; transcripts and Recap are Phase 2.9's `dialpad-artifact-sweep`). Preview cannot prove it (F9), so after merge invoke once: `curl -s -H "Authorization: Bearer $CRON_SECRET" https://sandra.bmhgroupkc.com/api/cron/call-facts-sweep` with the secret from `op`, and read the summary JSON. The extractor stays off (summary note only) until `FACTS_PROMPT_V1` has Jarrad's verbatim text.
5. Full verification (decision doc "Verification" 1-3) is the exit gate for the program: preview lane green, production attended spec green (minus the live contract send), mobile step M, KPI comparison on file.

### Step M: mobile native-dial check (attended, **[JARRAD]** with his phone)
Preconditions: Phase 2 released through step 4, `native_matcher` on, synthetic lead present with the owned phone as its seller number and assigned to Jarrad, Dialpad mobile app signed in as Jarrad.
1. From the Dialpad mobile app dial the synthetic lead's number; let it ring, answer on the owned phone, speak 15 s, hang up.
2. Within 2 min:
```sql
select id, provider_call_id, event_state, disposition, disposition_reason, matched_intent_id
from public.dialpad_call_events where received_at > now() - interval '10 minutes' order by received_at;
select a.id, a.source, a.provider_attempt_key, a.recording_url, a.occurred_at
from public.acquisition_attempts a where a.property_id = :'synthetic_property' order by a.recorded_at desc limit 3;
```
   Expect events for `calling/connected/hangup`; an attempt with `provider_attempt_key like 'dialpad-native:%'`; `recording_url` set once the link arrives (≤ 10 min, else flagged by the sweep).
3. Close the Sandra tab, reopen `/my-leads` 5 minutes later: post-call prompt opens prefilled (acknowledgement is persisted, so it survives reopening).
4. Negative checks: dial a number belonging to no lead → `quarantined/no_lead_match`; dial the training lead's number → `internal_training` activity, no attempt, no prompt; put the synthetic number on a second lead assigned to Jarrad and redial → `ambiguous_lead`, "Assign to lead" appears; assign, confirm one attempt on the chosen lead only; remove the duplicate.
5. Outcome: if step 2 shows no events for mobile calls, record it, withdraw the "mobile covered" claim in D4, keep the desktop path, and file a Phase 2 defect.
6. Retire the synthetic lead (`rollback/retire-synthetic-lead.sql`).

### Abort and revert (any phase)
| Condition | Action |
|---|---|
| `dialpad_call_events` `received` older than 10 min, or sweep route returning 500 | `native_matcher` off; keep connection active; run `/api/cron/dialpad-call-events-sweep` by hand with the bearer secret; investigate |
| More than 20 quarantines/hour for 2 consecutive hours that match a lead (unexplained query below) | `native_matcher` off |
| Any attempt created for a training lead, or any DNC phone dialed | All dial flags (`click_to_dial`, `native_matcher`, `auto_prompt`, `callback_alert`) off immediately; page Jarrad |
| Duplicate seller reminder, or a reminder outside 08:00-21:00 property-local, or to a STOP contact | Seller reminders off, cancel pending rows |
| Dialpad API 429s or intent failures above 10% over 1 h | `click_to_dial` off (manual dial remains) |
| `rep_sms_obligations` count rises after close-out | Stop; roll back the close-out with `node scripts/my-leads-housekeeping.mjs rollback --run <close-attempts run id>`; investigate trigger |
| KPI compare fails on a closed window | Stop at R1.4; forward-fix or `rollback --run <relabel run id>` (refuses rows worked since) |
| Migration job fails (it runs automatically about a minute after merge) | Do not retry blindly: read the job log; the safety gate failing means history drifted. Never run `db push` by hand against production |

---

## Monitoring (first 48 hours of each production phase)

Run `npm run my-leads-close:monitor -- --since 48h` at T+15 min, T+1 h, T+2 h, then every 4 h; `--expect-phase 1` for the Phase 1 release, `--expect-phase 2` from the Phase 2 release, `--expect-phase 3` from the Phase 3 release. Operator: the session holding the lease. Also read Sentry for tags `surface` in `dialpad_cti_webhook_project`, `dialpad_cti_webhook_persist`, `dialpad_cti_event_sweep`, `cron_dialpad_call_events_sweep` (from `src/lib/dialpad-cti/event-processing.ts` and the sweep route) and the cron monitor `sandra-appointment-reminder-sweep` (`src/app/api/cron/appointment-reminder-sweep/handlers.ts:314`). `monitor.sql` contents (blocks separated as shown; table names for Phase 2/3/1-reminder objects come from the decision doc and must be reconciled with the merged migrations; the `@requires` header makes a wrong name show as SKIPPED, and `--expect-phase` makes that a failure for the phases already released):

```sql
-- @name inbox_stuck
-- @phase 2
-- @requires public.dialpad_call_events
-- @threshold stuck_received = 0
select count(*) filter (where disposition = 'received' and received_at < now() - interval '5 minutes') as stuck_received,
       count(*) filter (where disposition = 'conflict' and received_at > now() - interval '48 hours') as conflicts_48h
from public.dialpad_call_events;

-- @name quarantine_by_reason_hourly
-- @phase 2
-- @requires public.dialpad_call_events
select date_trunc('hour', received_at) as hour, disposition_reason, count(*) as n
from public.dialpad_call_events
where disposition = 'quarantined' and received_at > now() - interval '48 hours'
group by 1, 2 order by 1 desc, 3 desc;

-- @name quarantine_count_48h
-- @phase 2
-- @requires public.dialpad_call_events
-- @threshold no_custom_data_after_matcher = 0
select count(*) filter (where disposition_reason = 'no_custom_data') as no_custom_data_after_matcher,   -- pre-matcher reason (foundation :847); must be 0 once the matcher is on
       count(*) filter (where disposition_reason = 'no_lead_match') as no_lead_match,
       count(*) filter (where disposition_reason = 'ambiguous_lead') as ambiguous_lead
from public.dialpad_call_events where disposition = 'quarantined' and received_at > :matcher_on_at;      -- monitor.mjs binds :matcher_on_at (flag-flip time recorded in the receipt)

-- @name quarantine_unexplained   (a quarantined native call whose number IS a known lead contact)
-- @phase 2
-- @requires public.dialpad_call_events, public.contact_phone_numbers
-- @threshold n = 0
select count(*) as n
from public.dialpad_call_events e
join public.contact_phone_numbers c on c.digits10 = right(regexp_replace(coalesce(e.payload->>'external_number',''), '\D', '', 'g'), 10)
join public.properties p on p.homeowner_contact_id = c.contact_id and p.deleted_at is null and p.assigned_user_id is not null
where e.disposition = 'quarantined' and e.disposition_reason = 'no_lead_match' and e.received_at > now() - interval '48 hours';

-- @name intents_hourly
-- @phase 2
-- @requires public.dialpad_call_intents
select date_trunc('hour', prepared_at) as hour, status, count(*) as n
from public.dialpad_call_intents where prepared_at > now() - interval '48 hours' group by 1, 2 order by 1 desc;

-- @name intent_timeouts
-- @phase 2
-- @requires public.dialpad_call_intents.failed_at, public.dialpad_call_intents.dispatch_authorized_at
-- @threshold overdue_prepared = 0
-- @threshold failed_ratio_1h <= 0.10
-- 'failed' is a marker (failed_at), not a status (contract "Intent timeout"); Phase 2 sets it 2 min after dispatch with no event
select count(*) filter (where status = 'prepared' and failed_at is null and dispatch_authorized_at < now() - interval '3 minutes') as overdue_prepared,   -- >3 min means the sweeper is not running
       round((count(*) filter (where failed_at is not null and prepared_at > now() - interval '1 hour'))::numeric
             / nullif(count(*) filter (where prepared_at > now() - interval '1 hour'), 0), 3) as failed_ratio_1h
from public.dialpad_call_intents;

-- @name recording_link_missing
-- @phase 2
-- @requires public.acquisition_attempts.recording_url, public.acquisition_attempts.provider_attempt_key
-- @threshold missing_link_10m = 0
select count(*) as missing_link_10m
from public.acquisition_attempts
where provider_attempt_key like 'dialpad-%' and recording_url is null
  and occurred_at between now() - interval '48 hours' and now() - interval '10 minutes';   -- D5 sweep window

-- @name unacknowledged_prompts
-- @phase 2
-- @requires public.acquisition_attempts.prompt_acknowledged_at, public.acquisition_attempts.provider_attempt_key
select count(*) as unacknowledged_over_1d
from public.acquisition_attempts
where provider_attempt_key like 'dialpad-%' and prompt_acknowledged_at is null and occurred_at < now() - interval '1 day';

-- @name transcript_fetch_jobs        -- Phase 2.9 hangup-triggered fetch job
-- @phase 2
-- @requires public.dialpad_call_artifact_fetches
-- @threshold failed_final = 0
select artifact, state, count(*) as n, max(attempts) as max_attempts, min(next_attempt_at) as oldest_due,
       count(*) filter (where state in ('unavailable','denied','flagged')) as failed_final   -- retries are 1, 5, 15, 60 min (D5)
from public.dialpad_call_artifact_fetches where created_at > now() - interval '48 hours' group by 1, 2 order by 1, 2;

-- @name rep_reminders
-- @phase 1
-- @requires public.task_reminder_deliveries
-- @threshold stuck_pending = 0
select channel, status, count(*) as n, max(attempts) as max_attempts,
       count(*) filter (where status = 'pending' and created_at < now() - interval '10 minutes') as stuck_pending
from public.task_reminder_deliveries where created_at > now() - interval '48 hours' group by 1, 2;

-- @name seller_reminders   -- Phase 1 seller-reminder job (D9)
-- @phase 1
-- @requires public.seller_appointment_reminders.send_local_date, public.seller_appointment_reminders.calendar_chain_id
-- @threshold duplicate_per_appointment = 0
-- @threshold outside_window = 0
select count(*) filter (where dupes.n > 1) as duplicate_per_appointment,
       count(*) filter (where extract(hour from (r.sent_at at time zone 'America/Chicago')) not between 8 and 20) as outside_window   -- QUIET_HOURS_OPEN_HOUR 8, CLOSE 21 (quiet-hours.ts:10-11); America/Chicago is the reminder timezone (1c.4)
from public.seller_appointment_reminders r
join lateral (select count(*) n from public.seller_appointment_reminders x
              where x.calendar_chain_id = r.calendar_chain_id and x.send_local_date = r.send_local_date and x.status = 'sent') dupes on true   -- one send per (chain, local day)
where r.status = 'sent' and r.sent_at > now() - interval '48 hours';

-- @name esign_states
-- @phase 1
-- @requires public.esign_requests
-- @threshold stuck_sending = 0
select delivery_state, count(*) as n,
       count(*) filter (where delivery_state = 'sending' and delivery_state_entered_at < now() - interval '5 minutes') as stuck_sending,
       count(*) filter (where delivery_state = 'send_unknown' and delivery_state_entered_at < now() - interval '30 minutes') as stale_unknown
from public.esign_requests where created_at > now() - interval '48 hours' group by 1;

-- @name offer_conflicts   -- Phase 3 pending-offer projection in state 'conflict'
-- @phase 3
-- @requires public.acquisition_offer_projections
-- @threshold open_conflicts = 0
select count(*) as open_conflicts from public.acquisition_offer_projections where state = 'conflict';

-- @name closeout_side_effects
-- @phase 1
-- @requires public.rep_sms_obligations
select count(*) as rep_sms_obligations_total, max(created_at) as newest from public.rep_sms_obligations;     -- compare to the R1.1 count

-- @name legacy_next_step_writers   -- must stay 0 after the Phase 1 code deploy (@since = deploy time)
-- @phase 1
-- @requires public.tasks
-- @threshold n = 0
select count(*) as n from public.tasks where type in ('follow_up','callback') and created_at > :code_deployed_at;

-- @name queue_health
-- @phase 1
-- @requires public.acquisition_queue_states
select count(*) filter (where stage = 'contacted') as contacted,
       (select count(*) from public.acquisition_attempts where source = 'sandra' and outcome is null and occurred_at < now() - interval '7 days') as stale_pending_attempts
from public.acquisition_queue_states where archived_at is null;
```

Thresholds and responses summarised: stuck inbox, unexplained quarantine, legacy writers, duplicate/out-of-window seller reminders, `send_unknown`/`sending` older than the reconcile windows, and final fetch-job failures are page-now; quarantine volume by reason, intent failure ratio above 10%, unacknowledged prompts older than a day and a rising `stale_pending_attempts` are investigate-within-4-hours. Normal volumes to expect: every native call Jarrad makes to a non-lead number lands as `no_lead_match` after the matcher is on, so absolute quarantine counts are meaningful only as a trend against his call volume and through `quarantine_unexplained`.

---

### Acceptance (what the builder runs before opening each Phase 4 PR)
- Early slice `p4-before-image` (no migration): `npm run typecheck`; `npm test -- scripts/my-leads-close` (finds files only after the `vitest.config.ts` include additions in this slice); `node --test scripts/my-leads-close/lease-manifest.test.mjs`; `LC_ALL=C node scripts/rehearse-next-step-relabel-kpi.mjs` prints `SKIP: pre-Phase 1` before Phase 1 exists and passes after; `node --test scripts/my-leads-close/monitor.test.mjs`; `npm run my-leads-close:monitor -- --since 48h` against production in read-only mode prints SKIPPED for not-yet-deployed blocks and exits 0 on the current state (Phase 0 baseline: `inbox_stuck` zero rows, `esign_states` counts).
- Main PR `p4-acceptance`: `npm run typecheck && npm test && npm run test:rtl`; `npm run test:e2e -- e2e/my-leads-close.spec.ts` green on a disposable stack, three consecutive runs (it is `serial` and non-idempotent, so re-run to prove the reset); the full `Playwright golden paths` job green with the new step and the grep-invert token; `Search RPC… (disposable DB)` green including the two new steps; `Typecheck and unit/RTL tests` and `Hugo lifecycle migrations on PostgreSQL 17` unaffected.
- Preview/canary check: `RUN_PROD_CANARIES=1 MY_LEADS_CLOSE_LANE=preview npx playwright test --config playwright.canary.config.ts e2e/prod-canary/my-leads-close-attended.spec.ts` on the Vercel preview of the Phase 3 PR, with the receipt of every step; the production lane runs only after Phase 3 is released and Jarrad is present.
- No file under `src/` appears in `git diff --name-only <base>...HEAD`.

### Risks and open questions
- [JARRAD] Which Supabase project Vercel Preview uses (inputs). If it is production, the "stub" lane is not isolated from production data and must use canary-tagged rows and the retire script.
- [JARRAD] Synthetic acceptance traffic is Jarrad's own: attempts, a held/overdue appointment and possibly an offer touch his KPI tiles until retired (F3, F5). Decide before the first attended run whether that is acceptable or whether he wants the retire script run the same day.
- Intents and events from the synthetic call are permanent (F1). Each attended run leaves one soft-deleted property, a contact, intents, events and a call activity in production. Keep the number of production runs to the minimum (one full run plus step M).
- The preview lane's real Dropbox Sign test-mode send needs an org with an e-sign integration in test mode on the hosted test project; the shared-project concurrency queue (`db-migrate-test.yml:70-73`) means a run can wait behind a migration.
- Seam dependence (4.1): if Phase 2 cannot offer a stub dial provider that production provably ignores, the CI lane cannot assert the dial request; fall back to a local HTTP stub plus a base-URL override with the same production guard, and say so in the PR.
- `supabase db reset --version` in the KPI rehearsal assumes the CLI used in CI (2.116.0, `e2e.yml:49-52`) matches 2.117's flag; confirm with `supabase db reset --help` in the job and fall back to the full-schema-replay pattern in `scripts/verify-my-leads-full-schema.mjs` if not.
- Reject-trigger timing (R1.6): any older browser tab or cached client that still posts `callback`/`follow_up` will start failing the moment the trigger lands; the 24 h zero-writers proof reduces but does not remove this.
- Tools that were not installed while drafting: `node_modules` is absent in the worktree, so SDK constructor signatures (S3), `pg` typings and Playwright versions (`@playwright/test ^1.59.1`, `package.json:101`, `page.clock` supported) were taken from `package.json` and existing specs, not from installed packages.
- The monitoring table names are the real ones from this plan (`contact_phone_numbers`, `dialpad_call_artifact_fetches` with `state`/`attempts`, `seller_appointment_reminders`, `acquisition_offer_projections` with `state`, `acquisition_attempts.prompt_acknowledged_at`, `dialpad_call_intents.failed_at`); each `@requires` must still be reconciled with the merged migrations, and `--expect-phase` makes any mismatch in a released phase fail loudly instead of silently skipping.


---

