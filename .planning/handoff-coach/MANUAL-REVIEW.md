# Manual review — steel-blue coach

Review base: 14001b24. Initial reviewed head: 203a9f9d.

## Findings

P2 — The pinned Up next/navigation footer covered nearly the entire script when the keypad was open at 1280 × 600. The script panel was only 256px high while the footer occupied about 232px. Accepted and fixed: an actual-height container query retains only sticky navigation at panel heights of 380px or less. Up next scrolls normally in that constrained case. Normal desktop panels retain the requested combined sticky preview/navigation. The regression verifies visible spoken text using hit testing, not just bounding boxes, and verifies the preview remains reachable at the end.

## Review coverage

- Independent layout/accessibility reviewer: original P2 above; fix re-review pending.
- Independent behavior/contracts/tests reviewer: no actionable findings. Entry editing, Escape, focus return, DTMF and session navigation callbacks preserved; all listed hooks retained; proposal UI absent.
- Root review: scoped CSS, shadcn overrides, responsive rules, production import boundary, test duplication and secret/config inventory. Only the existing public feature-flag name is referenced; no new credentials or integrations. No secret-bearing changes require new 1Password storage.
- Fallow audit against 14001b24: unused dependency leads are inherited package references and outside this visual change. Duplication leads are existing harness setup, independent input-edge regressions, and deliberately parallel DTMF guards. They do not justify changing shared call behavior. Complexity leads concern existing recommendation/dock logic and the contrast probe; no additional actionable defect established.
- Next.js local CSS documentation was consulted. No server/provider integration behavior changed.
- Human visual review adds value: Jarrad reviewed the interactive sandbox and requested sticky navigation and then sticky Up next. The short-panel fallback preserves readable script when available space is insufficient.

## Verification and external review

- Own lockfile dependency installation completed with npm ci; full-project typecheck passes.
- 10 responsive browser tests pass after the P2 fix.
- Earlier final coach verification: 289 unit, 76 component, and 37 browser tests passed; subsequent sticky changes: 25 component and 21 contrast/responsive tests passed.
- Local npm run verify reached the database rehearsal and stopped because no explicit local rehearsal database URL was configured. CI provisions PostgreSQL for that gate.
- Full non-database suites and FABLE_ADVISORY_REVIEW are in progress. Approval is not claimed until the final reviewed source is approved.

## Review fixes and independent confirmation

- Layout reviewer independently confirmed the short-panel fix resolves the original P2; all 10 responsive cases passed on re-review.
- Fable initial verdict: CHANGES_REQUIRED, model claude-fable-5-1. Accepted the primary/pressed hover inconsistency, disabled override precedence, and focus-under-sticky-overlay findings. Primary and pressed buttons now retain their white treatment on hover. Disabled coach controls receive consistent opaque styling, without assigning that background to PhoneKeypad keys.
- The script panel now measures the pinned footer with ResizeObserver and sets scroll-padding-bottom to its actual height. The short-panel display:contents case measures navigation alone. Keyboard Tab coverage checks hit-test visibility of script controls. Removing scroll padding makes that regression fail; restoring it passes.
- Added explicit min-width:0 on call identity for truncation.
- Verified the font variables against app/layout.tsx and HoldTimer's existing testid against hold-timer.tsx; neither requires production-code changes. Added real held-countdown pixel coverage plus hovered primary/pressed and disabled action coverage.
- Rejected selected-tab border unification: 2px selected versus 1px unselected is explicit in the approved spec. Existing stacked scrolling is retained per scope; no new mobile layout was introduced. Short viewport concerns are handled by the accepted panel-height fallback.
- Full local npm run verify now passes against an isolated, run-owned PostgreSQL instance: database rehearsal, typecheck, 3,595 unit and 1,143 component tests. Full synthetic browser suite is running on the corrected source. PR: https://github.com/biginkc/sandra/pull/488.

- Fable second pass found a concrete specificity issue in the refined generic hover rule: it could override Hang up red. Accepted and fixed by explicitly excluding Hang up from the neutral hover rule; the pixel suite now asserts its hovered red background and contrast. Fable confirmed the other source fixes and accepted deployed-artifact visual proof plus authenticated production smoke as sufficient for this visual-only release; no live robot call or quiet-hours bypass is required. HoldTimer's uniform amber styling follows the approved palette; its countdown behavior is unchanged.

### CI countdown capture correction

Final-head CI exposed a contrast-probe race: the live hold countdown changed glyphs between its four screenshot-mask passes. The held-call contrast test now fixes `Date` before mounting; browser timers and animations continue normally. The production HoldTimer is unchanged, and its separate acceptance test continues to prove ticking and expiry. Independent contract re-review approved this test-only correction; no contrast thresholds, pixel masks, or assertions were weakened.
