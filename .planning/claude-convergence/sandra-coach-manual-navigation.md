# Sandra Coach Manual Navigation - Convergence Ledger

## Goal

- Goal ID: `sandra-coach-manual-navigation`
- Outcome: Replace speech-driven script position with PDF-aligned manual Back/Next navigation, keep the verbatim script continuously visible, and add isolated transcript-grounded automatic recommendations plus an on-demand Follow-up Questions action.
- Plan source: Jarrad-approved plan in the active Codex thread on 2026-08-27.
- Original baseline: Sandra `origin/main` at `c8b24a9a8a16bb4506dbb94b88067d1362959ff0`.
- Final integration baseline: cleanly rebased onto Sandra `origin/main` at `8e5d313d3e2f1d824235651b773cedd912e76367`; upstream-only changes were unrelated Messages work.
- Authority profile: Production-authorized. On 2026-08-28 Jarrad explicitly authorized exhaustive browser/audio testing, in-scope fixes, PR creation/merge, deployment, provider-backed controlled QA calls, and production verification without another human gate. Compliance rules and unrelated-customer/data boundaries remain mandatory.
- Dependencies: none. Open PRs #424, #418, #408, and #337 do not supply code required by this implementation.

## Plan alignment

- Manual section position is Sandra-owned and changes only through explicit navigation.
- Claude Design is a visual reference only; script content and PDF-aligned boundaries remain Codex-owned.
- Automatic recommendations and the Follow-up Questions button read finalized transcript context but never control navigation.
- Jitter cleanup follows Sandra acceptance; this branch does not remove Jitter producers.
- Objection handling, recap, What Should I Say, and verbatim-compliance grading are excluded.

## Acceptance gates

- [x] Versioned manifest references stable verbatim script lines and validates full required-content coverage.
- [x] Back, Next, phase jump, next preview, collapse/reopen persistence, and new-call reset work independently of Realtime events.
- [x] Transcript, legacy phase/cursor, recommendation, and reconnect events cannot move the active section.
- [x] Script remains visible during recommendations, loading, errors, and listener degradation.
- [x] Automatic suggestions use meaningful finalized seller turns only and are debounced.
- [x] Follow-up Questions returns exactly three distinct transcript-grounded questions.
- [x] Server boundary authenticates the user, verifies call ownership, bounds transcript input, and excludes phone numbers.
- [x] Focused unit/RTL tests, typecheck, lint for changed files, synthetic responsive/contrast tests, and full repository verification pass.
- [ ] Exhaustive Codex manual review and Claude adversarial review are clean for the final head.
- [x] Fresh visible Chrome proof covers desktop and mobile layout without a real outbound call.
- [ ] Exhaustive click-driven Chrome proof covers all manual sections, known token population, dynamic audio-shaped transcript events, recommendation timing/failure/staleness, persistence/reset, responsive layout, reconnect states, and call controls.
- [ ] Production-configured proof confirms Runtime Cache permits real recommendation generation instead of failing closed.
- [ ] A controlled QA robot call with deterministic browser-microphone audio proves both speaker tracks, Deepgram finals/interims, private Realtime delivery, automatic advice, exactly three follow-ups, manual-only navigation, call controls, wrap-up, and new-call reset in production.

## Tool preflight

- Claude Desktop: unavailable; no running Claude process was present.
- Claude Code fallback: available and authenticated (`2.1.247`).
- GitHub CLI: available and authenticated.
- Chrome: installed; shared-control indicator available.
- Browser proof: available through Chrome control after the orange-border handoff.
- Next.js local docs: located under an existing dependency installation; Server Action guidance reviewed, including mandatory action-level authentication and authorization.

## Iterations

### Iteration 0 - preflight and scope review

- Claude verdict: `NEXT_STEP` with high confidence.
- Claude action: implement stable script-line IDs, the section manifest/validator, and persistent manual section state before changing the UI.
- Claude valid correction: automatic generation needs a hard per-call cap and an in-flight guard in addition to debounce.
- Claude rejected correction: it characterized removal of the five legacy guidance event surfaces as a new user decision. The approved plan explicitly removes the existing tips overlay, gates, counters, timers, and keyword objection UI; no new approval is needed. Their wire shapes remain temporarily parseable for compatibility, but they will not render or navigate.
- Event disposition for the Sandra-first cutover:
  - `transcript`: keep live; continues to update transcript state and listener liveness.
  - `phase`: parse as compatibility traffic; may update listener health only; never navigates.
  - `cursor`: parse as compatibility traffic; may update listener health only; never navigates.
  - `objection`, `counter`, `gate`, `timer`, `coach_note`: parse temporarily so Jitter can deploy independently; do not render, navigate, or compete with the new recommendation surface.
- Status: implementation steps 1-3 authorized.
- Evidence delta: isolated worktree created at the baseline; dependency and tool preflight completed.
- Blockers: none.

### Iteration 1 - manual navigation foundation

- Evidence delta:
  - Added stable IDs to all 114 authored script lines without changing any existing `type` or `text` value.
  - Added a reference-only 26-section manifest covering each authored line exactly once across Introduction, Reveal, Assessment, Secure Positioning, Offer, and Close.
  - Added session-owned `activeSectionId`, Back, Next, direct section selection, and phase-to-first-section operations. Realtime phase events remain navigation-inert.
  - New-call identity changes reset section and branch state; collapse/reopen persistence remains provider-owned and will receive full UI-level coverage in the integration slice.
- Manual review findings and disposition:
  - Accepted/fixed: conditional variants could be split across sections and produce blank selected content.
  - Accepted/fixed: adjacent same-phase sections could be reordered without validation failure.
  - Accepted/fixed: duplicate branch panels inside a section could pass validation.
  - Accepted/fixed: the responsive harness lacked the new navigation contract and broke typecheck.
  - Accepted/fixed: an unknown direct section ID could strand navigation.
  - Accepted/fixed: realtime-independence and new-call-reset assertions were weaker than the product contract.
  - Deferred to integration slice: provider-level exact-section collapse/reopen proof requires the new visible navigation controls.
  - Independent re-review confirmed all completed fixes closed with no introduced regression.
- Verification:
  - 100/100 manifest, schema, and script-block tests pass.
  - 9/9 manual session RTL tests pass.
  - Typecheck passes.
  - Changed-file lint and `git diff --check` pass.
- Automatic recommendation guardrails selected for the implementation slice:
  - Meaningful finalized seller turns only; 1.5-second debounce; one in-flight request; maximum 40 automatic requests per call.
  - Follow-up Questions remains explicit and one-click/one-request, with a maximum 20 requests per call.
  - Prior valid recommendations survive later request failures.
- Status: awaiting Claude iteration review before UI and recommendation integration.
- Blockers: none.

### Iteration 1 Claude review

- Claude verdict: `NEXT_STEP`; high confidence in the foundation and medium confidence in a combined UI-plus-AI slice.
- Valid correction accepted for UI cutover: phase rail must derive entirely from the active manual section; legacy phase events must not alter any rendered rail state; remove the old display override path.
- Valid correction accepted for manifest safety: require spoken content in every selectable variant, not just somewhere in the section.
- Valid corrections held as hard recommendation gates:
  - Enforce request ceilings server-side as well as client-side and show an explicit cap-reached state.
  - Redact phone-number digit runs from transcript text, not only omit phone context fields.
- Nonblocking/rejected:
  - Mutually exclusive Offer and Close tracks appearing within one section match the approved conditional-alternative contract.
  - Cursor resolution helpers may remain until the post-acceptance compatibility cleanup.
- Claude next action: proceed with UI cutover first, then recommendations as a separately reviewed slice.
- Status: UI cutover authorized.

### Iteration 2 - manual UI cutover

- Evidence delta:
  - Replaced phase/cursor-driven presentation with the active manifest section and its next-section preview.
  - Current section title and every selected authored line render openly; no disclosure click and no word-for-word grading surface.
  - Added Back/Next boundary controls and routed phase rail clicks to the first manual section in that phase.
  - Phase rail state, completion state, phase badge, script, and preview now derive only from `activeSectionId`.
  - Kept the transcript visible at every supported width; desktop shows transcript, dominant script, and recommendations as three columns, while narrow layouts stack them.
  - Removed the rendered cursor line, guidance takeover, objection/nudge cards, probe counter, gate badges, legacy hold timer, and script-version mismatch warning. Legacy events remain parseable in the compatibility reducer but cannot render or navigate.
  - Preserved call timer/status, reconnect notice, context retry, token/variant behavior, mute, keypad, hold, hangup, collapse, focus, and DTMF editor safeguards.
  - Added the recommendations shell; generation remains disabled until the separately reviewed authenticated AI slice.
- Verification:
  - 14/14 focused CoachLiveView RTL tests pass.
  - 34/34 SoftphoneProvider RTL tests pass, including exact-section and transcript persistence through collapse/reopen.
  - 15/15 hydrated Chromium responsive/contrast tests pass across 375x667, 375x812, and 1440x900, light/dark modes, DTMF/editor collision, and manual/legacy phase separation.
  - Typecheck and changed-file lint pass.
- React review:
  - No new client data-fetch waterfall or effect-driven derived state was introduced.
  - Section blocks are derived during render from persistent session state; existing call-control effects remain isolated.
- Status: independent manual review running before Claude iteration review.
- Blockers: none.

### Iteration 2 manual review

- Review lane 1: no findings; confirmed full-section rendering, manual-only navigation, legacy-event inertness, responsive composition, and failure-state script visibility.
- Review lane 2 findings and disposition:
  - Accepted/fixed: a successful Realtime reconnect set the gap notice but could leave degraded status true until another utterance. `SUBSCRIBED` now clears degraded and starts a fresh 15-second liveness window; a focused test proves error, recovery, grace window, and renewed silence behavior.
  - Accepted/fixed: restored compact two-speaker transcript coverage proving final seller and interim rep rendering separately.
  - Rejected: recommendation-shell copy was characterized as unapproved automatic behavior. The approved plan explicitly includes automatic contextual recommendations plus on-demand Follow-up Questions. The button remains disabled only inside this unshipped intermediate slice and must be enabled before PR readiness.
- Re-review: both accepted findings confirmed closed; no remaining code findings.
- Residual acceptance: production-connected real Chrome proof remains a final gate after recommendations are integrated.
- Status: ready for Claude iteration review.

### Iteration 2 Claude review

- Claude verdict: `NEXT_STEP`; high confidence after independently rerunning 101 unit, 85 RTL, 15 synthetic Chromium, typecheck, and lint checks.
- Valid recommendation-slice corrections:
  - Request ceilings must also be enforced at the authenticated server boundary.
  - Transcript is doubly untrusted: seller speech may contain instruction-shaped text and an authenticated client may submit arbitrary strings. It must be delimited as data, ignored as instructions, bounded/redacted, never persisted, and only produce rep-scoped ephemeral output.
  - The disabled Follow-up Questions control is a hard no-PR gate; it must become functional in the recommendation slice.
- Cap-store decision under the approved no-migration constraint:
  - Use Vercel Runtime Cache as an ephemeral, project/environment/region-scoped server ceiling keyed by owner, call, and request mode, plus an in-process key lock for same-instance concurrency.
  - Retain the client caps and one-in-flight guard as the first layer.
  - Runtime Cache is intentionally ephemeral and may evict; this is proportionate for the approved v1 scale and avoids inventing a database migration or new infrastructure for a transient coaching feature.
- Nonblocking: legacy reducer/cursor helpers remain for the Sandra-first compatibility window; preview may show only the first branch of a multi-track next section.
- Status: recommendation slice authorized.

### Iteration 3 - authenticated recommendations

- Evidence delta:
  - Added automatic suggestions after a meaningful finalized seller turn with a 1.5-second debounce, plus a working Follow-up Questions control that renders exactly three distinct questions.
  - Added an authenticated server action that verifies the Sandra user owns the call, loads the approved section and safe lead/property context server-side, bounds finalized transcript context to 40 lines / 12,000 characters, removes phone-number digit runs, and validates structured provider output.
  - Transcript and script excerpts are explicitly treated as untrusted quoted data; provider failures are not logged because provider errors may echo transcript content.
  - Added client and Runtime Cache request ceilings, one-current-context in-flight behavior, stale call/section/request rejection, and prior-valid-output failure isolation. Recommendations cannot dispatch navigation actions.
  - Follow-up Questions stays disabled until finalized seller speech exists; rep-only transcript cannot unlock it.
- Adversarial findings and disposition:
  - Accepted/fixed: manual Back/Next initially cleared the seller-turn fingerprint and regenerated from the same homeowner sentence. The per-call fingerprint now survives section changes and collapse/reopen.
  - Accepted/fixed: a hung request from an abandoned section initially occupied the current section's request slot. Context changes now invalidate that token immediately; the stale completion cannot clear or replace the current result.
  - Accepted/fixed: overlapping tracks can finalize a seller line in place before a later rep line in array order. Automatic detection now finds the newest meaningful finalized seller line independent of the array tail, with client/server regression coverage.
  - Accepted/fixed: the synthetic browser harness accidentally initialized the server-only cache/provider module. Its bundle now aliases that server action to an inert test boundary while still injecting representative UI results.
- Verification so far:
  - 22/22 focused recommendation server, client, and limiter tests pass.
  - 86/86 focused CoachLiveView, SoftphoneProvider, session, and Realtime RTL tests pass.
  - 15/15 hydrated Chromium responsive/contrast tests pass at 375x667, 375x812, and 1440x900 in light/dark modes.
  - Typecheck, scoped lint, and `git diff --check` pass.
  - Full unit suite passes: 255 files / 2,775 tests. The first full RTL run had one unrelated existing Prospects-table menu timing failure; focused rerun and final full verification remain pending before PR readiness.
- Status: recommendation re-review and final repository/browser gates in progress.

### Iteration 3 final verification

- Independent re-review: no remaining findings across server security, client timing/continuity, transcript overlap, manual-navigation isolation, script fidelity, or responsive acceptance.
- Final automated evidence:
  - Unit: 255 files / 2,780 tests pass.
  - RTL: 92 files / 912 tests pass. One unrelated Prospects menu timing failure occurred on the first run; its isolated rerun and the complete rerun both passed.
  - Synthetic Chromium: 15/15 pass after waiting for the finite dialog opening animation before geometry measurements. The responsive six-test slice also passed twice consecutively.
  - Typecheck, changed-file lint, and `git diff --check` pass.
- Repository baseline evidence:
  - Whole-repository `npm run lint` remains red on 364 errors in unchanged bundled `.claude/get-shit-done`, legacy Jitter integration tests/routes, and other pre-existing files; every changed file is lint-clean.
  - Default Turbopack build rejects the isolated worktree's external `node_modules` symlink. Webpack compilation reaches the existing unchanged `src/app/(dashboard)/campaigns/page.tsx` invalid-page-export error (`CAMPAIGNS_SORTABLE_COLUMNS`) after compiling the feature; the coach slice adds no build/type error.
- Fresh visible Chrome acceptance (no call/provider use):
  - Desktop showed the real three-surface layout: two-speaker transcript, dominant current script, next preview, recommendations, and fixed call controls.
  - Clicking Next changed only the script from `Open the call` to `Set the qualification frame`; next preview advanced to `Explain how BMH works`.
  - One Follow-up Questions click displayed three separate questions and did not move the script.
  - At 375x812, transcript, script, next preview/navigation, recommendations, three follow-ups, and call controls stacked and remained reachable. Browser console had zero warnings/errors.
- Status: awaiting final Claude exact-state review. Human-call acceptance remains separately user-authorized.

### Iteration 3 Claude final review - blocked and corrected

- Claude verdict: `BLOCKED`; `APPROVE_PR: NO`.
- Accepted/fixed server-cap finding: `@vercel/functions` Runtime Cache swallows transport failures as null reads/silent writes, so a catch-only fail-closed path was not real. The limiter now verifies the stored count with a read-after-write before permitting provider use. A regression test models the real swallowed-failure behavior and proves denial.
- Accepted/fixed call-isolation finding: recommendation continuity was created once and cleared in a passive effect, allowing seller A's suggestions to appear on seller B's first paint. The render-time new-call reset now replaces continuity synchronously, `CoachLiveView` is explicitly keyed by call identity, and the new-call test seeds prior output and proves it is absent immediately after identity reset.
- Post-fix verification:
  - Recommendation server/client/limiter: 24/24 pass.
  - Coach session, live view, and SoftphoneProvider RTL: 59/59 pass.
  - Typecheck, focused lint, and `git diff --check` pass after removing stale build-generated `.next/types` artifacts.
- Targeted independent re-reviews: no remaining findings in the Runtime Cache limiter, recommendation boundary, or cross-call continuity. Claude then returned `FINDINGS: none`, `VERDICT: NEXT_STEP`, and `APPROVE_PR: YES` for the corrected pre-rebase tree.
- That approval was deliberately invalidated when `origin/main` advanced. The feature commit was cleanly rebased with no conflicts onto `8e5d313d3e2f1d824235651b773cedd912e76367`.
- Post-rebase verification:
  - Full `npm run verify`: typecheck, 255 unit files / 2,780 tests, and 92 RTL files / 912 tests pass.
  - Synthetic Chromium: 15/15 responsive, keypad/editor isolation, and WCAG contrast tests pass.
  - Changed-file lint and `git diff origin/main...HEAD --check` pass; worktree is clean.
- Status: final Claude exact-head re-review pending. The pre-rebase approval is supporting evidence only and cannot authorize the PR by itself.

### Iteration 4 - exhaustive browser and production acceptance expansion

- Jarrad expanded the acceptance requirement after the corrected implementation review: drive the feature through the browser as a user, emulate the audio path, populate every placeholder backed by known call/lead/property data, fix all in-scope issues, and continue through production verification without another human gate.
- Exact-head Claude review at `5ab887d2795901f2f7ea785d1eb6bd679c28c972` returned `NEXT_STEP` / `APPROVE_PR: YES` and independently reconfirmed the two prior blocking fixes. It also found:
  - A medium regression-coverage gap: the production call-identity key was not directly protected by a remount test.
  - A medium production-only uncertainty: Runtime Cache must prove immediate read-after-write freshness and latency in Vercel rather than merely in local fallback tests.
  - A low usability issue: an in-flight automatic request disabled the deliberate Follow-up Questions action.
  - Two non-actionable observations: mutually exclusive offer/close tracks intentionally remain together per the approved section contract, and spelled-out phone digits are an obscure input Deepgram does not currently emit.
- Accepted fixes in progress:
  - Extract the exact keyed production view boundary and regression-test call-identity remounting.
  - Let deliberate Follow-up Questions supersede background automatic advice while preserving stale-response isolation and single-manual-request behavior.
- Browser proof plan:
  - Durable click-driven Playwright harness for the full 26-section walk, all phase jumps, known token resolution and editable deal values, dynamic rep/seller interim/final transcript events, recommendation debounce/failure/staleness/caps, legacy-event inertness, persistence/new-call reset, reconnect/context failures, responsive layout, and call controls.
  - Fresh visible Chrome walkthrough using the same user-facing controls; external event injection is allowed only to emulate audio/provider/fault inputs.
  - Production telephony proof uses a deterministic WAV as Chrome's real WebRTC microphone plus Jitter's owned proof-answer QA robot as the homeowner leg. This exercises Telnyx both-track capture, stream-wide ordering, Deepgram, private Realtime, Sandra, and the real recommendation boundary.
- Release constraints/evidence:
  - PR previews do not receive the production-only coach/Jitter flags and cannot prove the live call path.
  - A production-configured `--prod --skip-domain` deployment is the safest pre-merge provider surface; canonical production still requires exact merged-SHA verification.
  - The current rollback deployment is `dpl_5rLoCHJUrGqis6s3h5GcRhpnAVyv` at Sandra SHA `8e5d313d3e2f1d824235651b773cedd912e76367`; re-record immediately before merge because main may advance.
  - The owned robot must be attached only to clearly labeled QA data. No compliance quiet-hour bypass is permitted; at 01:25 CDT the earliest ordinary Eastern-time call window was 07:00 CDT.
- Status: expanded browser harness and accepted fixes in progress. The prior exact-head approval is invalidated by these changes.

### Iteration 5 - browser-runtime hardening and known placeholder population

- Known values now populate before the rep has to type anything:
  - Trusted server-loaded lead/rep context remains authoritative.
  - The already-prepared call target fills a missing homeowner/address on the first live paint, while lookup is still loading, and during a retryable context-load failure.
  - Manual-dial sentinel labels, raw phone values, and formatted phone labels are explicitly rejected as homeowner names.
  - Motivation and cold-caller name use trusted context when present; otherwise they become session-owned editable chips. Offer price, net, and closing date remain deliberately live-entered.
  - Prepared-target state is replaced on call identity changes and is never sent through the recommendation request or trusted AI server boundary.
- Accepted exact-head review fixes are complete:
  - The production call-identity keyed boundary has a mutation-proven remount regression.
  - Follow-up Questions remains available during background automatic advice, supersedes it, rejects duplicate manual requests, and ignores the stale automatic completion.
- Click-driven browser testing exposed a Chrome-only crash that unit/jsdom tests missed: native browser timer functions had been detached onto a plain object, so meaningful finalized seller speech threw `Illegal invocation` when starting the 1.5-second debounce. The default timer API now calls bound `globalThis` wrappers.
- Final local verification after those fixes:
  - `npm run verify`: 2,788/2,788 unit tests and 920/920 RTL browser-component tests pass; typecheck passes.
  - Full synthetic Playwright suite: 33/33 passes, including the 10 new user-journey cases.
  - The new browser journey walks all 26 sections both directions, every phase jump, populated known tokens, editable live values, transcript final/interim semantics, recommendation debounce/failure/staleness, follow-up supersession/exactly-three results, legacy-event inertness, collapse/reopen/new-call reset, reconnect/context degradation, call controls, and desktop/mobile ordering.
  - The user-facing actions are real browser clicks. A small harness bridge is limited to external audio/provider/network stimuli so the coach stays mounted exactly as it does during a live call.
- Build evidence:
  - The normal local Turbopack build cannot follow this worktree's shared `node_modules` symlink.
  - A webpack fallback compiled the application successfully, then stopped at an existing `campaigns/page.tsx` invalid Page export on unchanged `origin/main`. This branch does not modify that page. CI and the production-configured Vercel candidate remain the release authority.
- Production preflight found the Jitter stream-wide both-track fix already deployed and healthy, with prior post-deploy rep and seller finals and zero active taps. One cross-service acceptance risk remains under review: production coaching currently has a 60-minute stream cap while normal calls may exceed one hour.
- Final current-diff adversarial re-review found no remaining code findings after the first-paint placeholder fix. Production-only Runtime Cache and real audio/Realtime behavior remain acceptance gaps.
- Status: local implementation and browser suites are clean; the long-call cap fix, exact committed-head Claude review, PR/CI, candidate deployment, and production browser/audio proof remain.

### Iteration 6 - exact-main rebase and review-gap closure

- Rebasing onto Sandra `origin/main` at `77afb648fafdd3ab470b51981b8ed91d3ef6e68f` completed without conflicts after PR #424 merged. No earlier SHA approval is being reused.
- Exact-head review approved the implementation but surfaced one material browser-proof gap and three small product weaknesses. All actionable findings are closed:
  - The synthetic Chrome harness now mounts the real `useCoachSession`, Realtime channel hook, and reducer. Only external context I/O, transport, audio, and provider inputs are stubbed.
  - Prepared homeowner/address values are proven on deferred first paint, context failure/retry, trusted-context replacement, and synchronous new-call replacement.
  - Late responses carry real call/section identity and are proven unable to overwrite newer visible advice; this cannot pass merely because navigation clears the panel.
  - Twenty Follow-up Questions clicks produce twenty provider requests; the twenty-first is blocked client-side without an extra request.
  - Whitespace-only trusted motivation/caller values no longer shadow typed entries.
  - A hung recommendation request now times out after 20 seconds, preserves prior valid output, releases the busy slot, and permits retry.
  - Exhausted per-call request-cap state remains visible across section navigation.
- The review's phone-redaction false-positive observation was not expanded into speculative parsing logic. Phone exclusion remains fail-safe, and no approved-flow test demonstrated a defect.
- Final post-rebase local evidence:
  - Sequential `npm run verify` passes: typecheck, 256 unit files / 2,791 tests, and 93 RTL files / 924 tests.
  - Full synthetic Chromium passes 37/37, including all 14 coach user journeys, responsive layout, keypad/editor isolation, and WCAG contrast.
  - One Prospects menu timing test failed only while full RTL and Playwright ran concurrently. The exact test passed on clean `origin/main`, passed on this branch, and the sequential full verification passed 924/924; release evidence uses the clean sequential run.
  - Typecheck, scoped lint, and `git diff --check` pass.
- Shared telephony readiness is tracked in Jitter PR #227. Its exact tree passed 93 focused tests, all typechecks, independent exact-head review, GitHub verification, database/audio safety, and a Vercel preview build. Railway `coach-ingest` is staged at `COACH_MAX_CALL_MINUTES=120` with no deployment/restart; the live service remains unchanged until merge.
- Status: exact final Claude review, Sandra PR/CI, production-configured candidate, merges, and controlled short plus over-60-minute production calls remain.

### Iteration 7 - production rep-name placeholder correction

- Final exact-head review correctly blocked the first PR head because the live Hugo-provisioned rep identity had no display-name metadata and a single-token email fallback would have rendered only `Jarrad`, not the known full rep name `Jarrad Henry`.
- The correction remains deliberately v1-sized:
  - Nonblank Auth `user_metadata.display_name` stays authoritative.
  - BMH's explicit server-only v1 roster supplies `Jarrad Henry` for the known pre-metadata production identity.
  - Unknown single-token email locals now fail safe to the visible placeholder instead of pretending a likely first name is complete.
  - Clearly delimited two-part email locals remain a safe last fallback.
- The misleading comment that reps already had a self-service display-name UI was removed; Sandra has no such UI or separate profile table today.
- Focused evidence: 21/21 coach-context tests pass, including case-insensitive known-rep population and the unknown single-token fail-safe. Typecheck, focused lint, and `git diff --check` pass.
- Status: full verification and fresh exact-head reviews required; the blocked head must not merge.
