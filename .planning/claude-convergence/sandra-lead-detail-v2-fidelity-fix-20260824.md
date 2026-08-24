# Sandra lead-detail v2 visual-fidelity fix

- Goal ID: `sandra-lead-detail-v2-fidelity-fix-20260824`
- Goal: Make the implemented lead-detail page visually match the contained ZIP prototype without adding, removing, or changing lead-page behavior.
- ZIP contract: `docs/Sandra Leads page redesign.zip` (`PROMPT.md`, `PARITY.md`, and `Sandra Lead Detail v2.dc.html`).
- Initial implementation baseline: `origin/main` at `cb9b779dba7c47b9c556a1b07d92511ed93cf19a` (PR #393).
- Refreshed implementation baseline: `origin/main` at `c7fe232` (PR #395, Street View address-resolution fix).
- Final refreshed baseline: `origin/main` at `16e5618` (PR #397, signed static Street View plus deterministic image fallback).
- Latest refreshed baseline: `origin/main` at `216bbd6` (PR #398, ultrawide static-hero sizing).
- Merge refreshed baseline: `origin/main` at `a83dbca` (PRs #399/#400 plus the assignment-label update).
- Final merge baseline: `origin/main` at `9573dbf` (PR #401, final hero bottom-edge anchor).
- Branch: `codex/sandra-lead-detail-v2-fidelity-fix` in an isolated worktree.
- Scope: presentation and responsive layout only. Existing DNC, consent, communications, task, appointment, enrichment, activity-source, and load-failure behavior remains authoritative.

## Acceptance gates

- The ZIP is treated as the visual contract only; its demo state and sample data do not authorize new functionality.
- Header/hero, deal strip, compact working-state bar, open timeline, compact composer, and dossier match the prototype's visual hierarchy at 1440px.
- The extra visible Back action is removed because the existing Leads breadcrumb is the prototype's Back-to-Leads control.
- The next action is a compact inline chip rather than a standalone card.
- Activity rows render directly on the workspace surface rather than inside a second large card.
- Add note remains the same shipped action but collapses to the prototype's compact affordance.
- Dossier sections use compact cards rather than table panels, while every field and control remains present.
- 1280px retains the two-column activity/dossier layout; 1024px stacks it; 390px and 320px have no horizontal page overflow.
- Flat-media and imagery headers carry the same controls and wrap safely.
- Permanent-DNC early return, SMS restrictions, queue-only inline reply, Send-now modal, isolated activity failures, and load-failure states remain unchanged.
- Focused unit/RTL tests, typecheck, lint, production build, responsive browser checks, adversarial review, and fresh visible-Chrome proof pass without placing a real call or message.

## Evidence log

- 2026-08-24: refreshed `origin/main`; confirmed PR #393 is the merged implementation at the baseline above.
- 2026-08-24: rendered the contained standalone prototype at 1440x900 and 390x844.
- 2026-08-24: seeded the existing safe E2E test tenant and captured the merged page at 1440px. The structural E2E passed, but visual comparison rejected the oversized working-state card, boxed activity workspace, side-by-side Add-note panel, table-like dossier, and extra Back button.
- 2026-08-24: implemented the first fidelity pass and rebased it cleanly onto PR #395. The newer main commit only changes the media resolver and its tests; no visual file or behavior in this fix conflicted.
- 2026-08-24: focused typecheck, unit/RTL contracts, the seeded unified-timeline E2E, and a new 1280/1024/390/320 responsive E2E pass. The responsive pass proves the 1280 dossier is beside activity, the smaller widths stack, mobile route controls remain at least 36px tall, and document overflow is zero.
- 2026-08-24: adversarial component and runtime review found one real parity regression: timeline presentation hid delivery/provider/STOP/Sandra metadata and labeled every outbound message as `You`. Fixed by preserving the shipped metadata footer and using `Sandra` or neutral `Outbound` attribution; direct timeline tests now cover queued, failed, AI-generated, and STOP-keyword rows.
- 2026-08-24: strengthened the browser contract so it asserts the compact next-action variant, integrated Add-note control, missing redundant Back action, open timeline presentation, compact dossier sections, responsive column boundary, mobile control height, and media-overlay containment when imagery is available. The Street View and aerial variants share the same hero DOM/CSS; the direct Street View component contract now also locks wrapping, responsive heights, and attribution-safe bottom padding. A provider-backed Street View frame still requires preview configuration and remains part of visible-browser review rather than a deterministic shared-tenant test.
- 2026-08-24: `npm run typecheck` passes from a clean generated-type state. After the final main refresh, the full unit suite passes 2,397/2,397 and the full RTL suite passes 812/812. A production bundle compiles but inherits Next route-export validation failures from unchanged main files (first reported at `campaigns/page.tsx`).
- 2026-08-24: a later responsive rerun was invalidated by a concurrently running Playwright suite from another Sandra worktree resetting the same shared E2E tenant. The seeded property was verified deleted during the failing run. No retry workaround was retained; rerun after the shared tenant is free.
- 2026-08-24: independent Claude review at `d980594` returned `BLOCKING: NO` and verified the timeline safety fix plus parity-critical DNC, consent, load-failure, and Add-note paths. Merge approval remains withheld only for a clean current-head browser rerun. Its two low polish findings were addressed: CASS enum text is humanized, and the mobile touch-target check now includes compact action links (with a direct compact-appointment test).
- 2026-08-24: rebased onto PR #397 and resolved the media-hero conflict by retaining its signed static images, responsive source set, Street View→aerial→flat failure chain, uncropped Google attribution, and 210px mobile attribution clearance while preserving the prototype-aligned header/actions treatment.
- 2026-08-24: clean Chrome-channel `cockpit-design-fidelity` pass after rebase: 1440 structural contract plus 1280/1024/390/320 responsive resize checks, compact action links included, zero document overflow, and all screenshots captured. The responsive loop now resizes the already-rendered page instead of reloading the shared fixture at every breakpoint, eliminating an unrelated database-reset race.
- 2026-08-24: rebased cleanly onto PR #398. Its wider static-image source is retained; the redesign continues to preserve the signed Street View→aerial→flat fallback and Google attribution clearance.
- 2026-08-24: final merge refresh rebased onto `a83dbca`. The only conflict was the media action treatment; resolved in favor of main's newer bottom-edge alignment and white-control treatment while retaining the redesign's responsive layout and flat fallback.
- 2026-08-24: post-refresh unit 2,397/2,397, RTL 812/812, typecheck, focused lint, and diff checks pass. A local responsive retry authenticated successfully but was invalidated by the shared E2E tenant deleting the just-seeded property before navigation (captured page is an authenticated 404); the branch's GitHub Playwright check is the final serialized browser gate for this head.
- 2026-08-24: rebased cleanly onto PR #401 with no conflict; its final hero action anchoring remains authoritative.
- 2026-08-24: exact-head Claude review found one merge blocker: compact open-task Done/Snooze/Retry controls were 24px tall on mobile, and the responsive fixture only exercised the no-task branch. Raised all three to the 36px mobile floor, added direct compact-task/retry sizing coverage, and seeded an open task into the browser contract so mobile control measurement exercises the real task branch.

## Status

`REVIEWING`
