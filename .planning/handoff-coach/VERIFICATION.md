# Steel-blue coach restyle verification

Branch: `coach/steel-blue-restyle`.
Base: `origin/main` at `14001b24`.

## Delivered

The full-screen coach now uses dialog-scoped shadcn palette overrides, the connected phase stepper, transcript bubbles, 27px script text, four-column spoken paths, an up-next block, a section counter, recommendation cards, and the bottom call dock. The reference HTML was opened and visually inspected in the browser. The implementation preview was inspected at 1440 × 900, including phase navigation into Offer.

No coach session, reducer, script-block, recommendation implementation, script JSON, manifest, feature flag, server action, or event changes. The objection card and gate chips remain absent. The below-xl stacking behavior remains in place.

## Checks

- `npx vitest run src/lib/coach src/components/coach`: 289 passed.
- `npx vitest run --config vitest.rtl.config.ts src/components/coach src/lib/coach`: 76 passed, including the unchanged coach-live-view.test.tsx.
- `npx playwright test --config playwright.synthetic.config.ts coach-live-contrast.spec.ts coach-live-responsive-layout.spec.ts coach-live-user-journey.spec.ts`: 37 passed.
- Targeted ESLint on the changed TS/TSX files: passed.
- `git diff --check`: passed.
- Contrast checks verify the approved token values in both surrounding app themes, all 28 palette text/surface combinations, rendered script/tokens/status/action colors, and negative controls for the pixel probe. Lowest measured product text contrast: 4.80:1, white on red Hang up.
- Responsive checks cover the existing 375px cases, 1279px stacked behavior, and 1280px/1440px desktop layouts. Desktop rail widths are asserted at 380px and 320px, with a 60px top bar.
- Browser journeys cover all sections, spoken paths, recommendations, call continuity, entry editing, collapse/reopen, and DTMF protection. Component tests cover Escape and focus return.
- Full-project `npx tsc --noEmit` could not pass against the reused local dependency installation: missing packages/types include `pg` and `tus-js-client`, with errors outside the changed files. No successful full-project typecheck or production build is claimed.

## Spec adaptations

No product-scope deviations from PROMPT.md. These compatibility and verification details are intentional:

- Keep the current phase text and purpose as screen-reader-only content to preserve their existing test hooks. The eyebrow's title hook remains on its title span, with the phase name beside it.
- The visible placeholder pill remains “missing”; its actual placeholder value is also retained as screen-reader-only content. Three unchanged file-number tests require the em dash. Baseline testing confirmed they previously passed incidentally because a removed branch heading contained an em dash.
- The section counter uses the manifest as required: Offer is section 23 of 26, rather than the illustrative mock's 24 of 26. Existing spoken-path wording and editable token behavior are preserved.
- The call timer retains its existing “On hold” state and the Live pill retains its existing held-call visibility. HoldTimer receives only scoped styling.
- Scoped button rules neutralize the shared translucent destructive and dark outline styles, keeping the specified solid red action and opaque text surfaces. Disabled controls retain disabled behavior with readable opaque colors.
- Two existing browser fixtures now compile the real globals.css, including the coach stylesheet, instead of generic Tailwind alone. This is necessary to verify the actual layout and palette.
