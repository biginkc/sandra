# Sandra lead-detail v2 visual-fidelity fix

- Goal ID: `sandra-lead-detail-v2-fidelity-fix-20260824`
- Goal: Make the implemented lead-detail page visually match the contained ZIP prototype without adding, removing, or changing lead-page behavior.
- ZIP contract: `docs/Sandra Leads page redesign.zip` (`PROMPT.md`, `PARITY.md`, and `Sandra Lead Detail v2.dc.html`).
- Initial implementation baseline: `origin/main` at `cb9b779dba7c47b9c556a1b07d92511ed93cf19a` (PR #393).
- Refreshed implementation baseline: `origin/main` at `c7fe232` (PR #395, Street View address-resolution fix).
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
- 2026-08-24: `npm run typecheck` passes from a clean generated-type state; the full unit suite passes 2,399/2,399 and the full RTL suite passes 808/808. A production bundle compiles but inherits Next route-export validation failures from unchanged main files (first reported at `campaigns/page.tsx`).
- 2026-08-24: a later responsive rerun was invalidated by a concurrently running Playwright suite from another Sandra worktree resetting the same shared E2E tenant. The seeded property was verified deleted during the failing run. No retry workaround was retained; rerun after the shared tenant is free.

## Status

`REVIEWING`
