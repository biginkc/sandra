# Sandra Lead Detail v2 convergence ledger

- Goal ID: `sandra-lead-detail-v2-20260823`
- Goal: Implement the ZIP-authored lead-detail v2 layout on refreshed `origin/main` while preserving every production control and behavior.
- Plan source: Jarrad's approved "Sandra Lead Detail v2 — Prototype-Parity Implementation" plan and `docs/Sandra Leads page redesign.zip` (`PROMPT.md` + `PARITY.md`).
- Initial audited baseline: `origin/main` at `7c63673104630884548ad4b7f5a2da0d53cb353c`.
- Refreshed implementation baseline: `origin/main` at `2855df36bccb570aab99b6746334b9c4ce79a616` (PR #392 merged while implementation was running).
- Branch: `codex/sandra-lead-detail-v2` in isolated worktree.
- Dependency: `none` after inspecting open PRs #392 and #337; existing softphone integration is retained without depending on #392.
- External authority: Claude desktop/app first; authenticated Claude CLI is the fallback. Codex owns implementation; Claude provides independent review.

## Acceptance gates

- Official interactive Google Street View hero with computed heading; aerial fallback; flat fallback; Google controls and attribution unobstructed.
- Final section order: hero, snapshot, working state, warnings, activity/dossier workspace.
- Permanent-DNC early return remains unchanged.
- All `PARITY.md` controls retained, including both SMS gates and guarded deletion.
- Messages, notes, and calls remain independently bounded and independently failure-tolerant.
- Unified deterministic oldest-to-newest timeline preserves realtime updates and call-artifact recovery.
- Queue-only reply appears after the timeline; note composer appears beside/below it.
- No schema or public behavior changes.
- Typecheck, focused tests, full relevant suites, build, focused E2E, manual review, preview deploy, and fresh visible Chrome/DevTools acceptance pass.
- No real call or message is placed during verification.

## Transport and tool preflight

- Claude desktop process: reachable.
- Claude CLI: installed and authenticated; fallback only.
- Chrome: running and available for final visible acceptance.
- GitHub CLI, Vercel CLI, and Google Cloud CLI: installed.
- Google Cloud account: authenticated as `jarrad@bmhgroupkc.com`; dedicated project `sandra-crm-maps` is active with billing enabled.
- Existing dirty checkout: preserved; implementation worktree created from refreshed baseline.

## Evidence log

- 2026-08-23: fetched `origin`; audited baseline remained the ZIP-audited commit.
- 2026-08-23: open PR inspection found no code/schema dependency for this route redesign.
- 2026-08-23: recorded Google authentication as an infrastructure gate, not a blocker to local implementation.
- 2026-08-23: Claude pre-implementation review returned `BLOCKED` with 16 challenges. The resolution contract below is now part of the target and is used for implementation review.
- 2026-08-23: Google official documentation confirmed Maps Embed uses `strict-origin-when-cross-origin`, Street View metadata is free and consumes no image quota, and URL signing is recommended server-side.
- 2026-08-23: refreshed `origin/main` advanced by the dynamic-company-caller-ID softphone merge (#392). It changes only shared softphone/provider code, not the lead-detail route or parity surface. The branch is rebased onto it and the guarded `SoftphoneLeadButton` remains the single call action.
- 2026-08-23: full local verification before the refresh: 228 unit files / 2,381 tests, 85 RTL files / 790 tests, typecheck, focused ESLint, diff check, and Next production build passed. The build emitted the repository's pre-existing dynamic `/templates` diagnostics but completed successfully.
- 2026-08-23: PR #393 opened at `564e8f459aff3ee6b64fefe37495075bf58569e7`; Vercel preview reached Ready. GitHub Actions did not start because the GitHub account is locked by a billing issue; every failed job has zero steps and the provider annotation states the billing lock.
- 2026-08-23: exhaustive read-only review lanes covered Google Maps/security/config, activity/realtime/data correctness, and ZIP parity/responsive/accessibility/safety. Accepted findings were fixed: iframe pointer access, mandatory signed metadata, malformed-address validation, exact referrer documentation, lead-mode SMS association, truthful unknown-note authorship, mark-read/query ordering, production-hook realtime tests, call-window ordering, 1280/1024 grid behavior, 320px reply wrapping, 36px compact call target, Full Record homeowner status rows, and the dossier booking entry point.
- 2026-08-23: post-review verification passed: 228 unit files / 2,388 tests, 86 RTL files / 802 tests, typecheck, focused ESLint, diff check, hardcoded-secret pattern scan, and Next production build. Fallow has no changed-file unused exports; remaining leads are inherited dependencies, deliberate subscription similarity, and complexity in tested route/resolver/rendering functions.
- 2026-08-23: approved 1Password service-account read returned `403 Forbidden`; storage/category verification remains a residual review gap. No GUI or biometric 1Password path was attempted.
- 2026-08-24: created the organization-owned `sandra-crm-maps` project, linked the existing BMH billing account, and enabled only API Keys API, Maps Embed API, and Street View Static API. Billing and a live metadata probe are healthy.
- 2026-08-24: created separate browser Embed and server metadata keys. The browser key is restricted to Maps Embed API plus exact production, branch-preview, localhost, and loopback referrers; the server key is restricted to Street View Static API. Google unexpectedly printed the first key pair during creation, so both were immediately revoked and replaced before use.
- 2026-08-24: rotated the URL-signing secret after visual inspection exposed the retired value, installed the replacement in Vercel Production/Preview as Sensitive and Development as encrypted, cleared the clipboard, and permanently removed every temporary screenshot that displayed the retired secret.
- 2026-08-24: verified a replacement-secret signed Street View metadata request returns HTTP 200 / `OK`. Added a zero daily consumer quota override for unsigned Street View requests; an unsigned Static Street View image probe now returns HTTP 403 while signed metadata remains healthy.
- 2026-08-24: Vercel now reports all three required Google variables in Production, Preview, and Development without reading their values. A fresh full RTL run passes 87 files / 802 tests.
- 2026-08-24: added the exact stable branch-preview callback to the Sandra Supabase authentication allowlist through the Management API. A temporary branch-only Hugo flag proved that Hugo still returns preview sign-in to the production callback, so the flag was removed; the final preview retains Sandra's existing password/magic-link path.
- 2026-08-24: a focused Chrome-channel E2E run found one stale test assertion for the removed standalone `MessagesThread` wrapper. The acceptance test now targets the unified activity timeline, verifies four message rows, preserves the queue-only reply assertions, and proves the timeline precedes the composer. Setup plus both design-fidelity scenarios pass (3/3).

## Claude challenge resolution contract

1. **Missing coordinates:** use Maps Embed API `place` mode with the complete address; incomplete or malformed address falls to the flat header. Never invent a geocoding API call or use `0,0` as an address substitute.
2. **Queue-only wording:** `InlineReply` was already queue-only in production (`queueOnly=true`); it stays queue-only and is only repositioned. The separate SMS modal retains its existing Queue and Send now behavior. This is layout parity, not a messaging behavior change.
3. **Credential gate:** use an honest intermediate `CODE_COMPLETE_PENDING_MAPS_CREDENTIALS` state if Google reauthentication/MFA blocks infrastructure. Preview, five-width browser proof, and attribution/network gates remain mandatory before merge and cannot be waived.
4. **Permanent DNC:** the unchanged DNC early return executes before media resolution, so no metadata request or property imagery is emitted for a locked record.
5. **Bounded merge trust:** preserve the user-locked 200 message / 200 note / 20 call windows. When any source reaches its bound, compute the newest bounded cutoff as the trust floor, render an explicit boundary, and visually de-emphasize older cross-source rows without dropping valid bounded records or adding pagination.
6. **Canonical timestamps:** message `created_at`; note `created_at`; call `started_at ?? created_at`. Sort by raw ISO timestamp ascending, then source rank `message`, `note`, `call`, then ID. Do not truncate through `Date`, so PostgreSQL microseconds remain ordered.
7. **Scroll/unread:** the approved plan explicitly forbids auto-jump and scroll preservation. Retain unread highlighting and mark-read-on-open, but do not introduce Claude's suggested pin-to-bottom or moving unread-anchor behavior.
8. **Source renderers:** preserve dedicated message/note/call renderers and hooks. Call artifact recovery remains inside the call hook; author resolution remains one batched team lookup plus the current user's identity, never per-note requests.
9. **Google allowlist:** only `maps.googleapis.com/maps/api/streetview/metadata`, Maps Embed API `streetview`, Maps Embed API `view` satellite, and Maps Embed API `place` satellite are accepted. Static images and unofficial URLs are rejected.
10. **Key separation:** browser Embed key and server-only metadata key are distinct. The metadata key and signing secret must not appear in client code, output, or preview page source.
11. **Metadata resilience:** 50-meter radius, outdoor source, four-second timeout, 15-minute best-effort in-memory cache keyed by rounded coordinates, and aerial fallthrough. No table or migration.
12. **Misconfiguration vs coverage:** `ZERO_RESULTS`/`NOT_FOUND` are no coverage; `REQUEST_DENIED`, non-OK HTTP, malformed response, timeout, and fetch errors are metadata failures. Log only the status, never credentials. Preview renders a configuration diagnostic for metadata failure so an all-aerial broken deployment cannot pass.
13. **Heading:** calculate pano-to-property bearing. If pano and property are within three meters, use stable north (`0`) because the bearing is undefined at effectively the same point.
14. **Dossier stacking:** the ZIP's viewport contract is authoritative: `minmax(0,1fr) + 340px` begins at 1280px and stacks at 1024px. A viewport breakpoint is required because Sandra's sidebar makes the route content width effectively equal at those two global navigation states.
15. **Attribution:** overlays are allowed but the gradient ends 36px above the bottom and content has 48px bottom clearance. Five-width visible acceptance must still prove the Google logo and terms are unobstructed.
16. **No-live-contact verification:** preview inspection is read-only. Do not click Call, Queue SMS, Send now, or submit an appointment. Focused automation must fail if it observes a calling or messaging mutation request; manual acceptance inspects presence/disabled/gated states without invoking them.

Items 5 and 7 deliberately preserve Jarrad's explicit limits and no-auto-jump instruction where Claude's first suggestion conflicted with the approved plan.

## Status

`PROVIDER_CONFIGURED_PENDING_FINAL_PREVIEW_AND_BROWSER`
