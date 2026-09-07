# Dialer coach switch verification

Branch: `coach/dialer-switch`. Stacked on PR #488 (`coach/steel-blue-restyle`), including parent commit `721d04b6`.

## Delivered

- Default-off coach preference and single-script picker immediately below CallerIdControl, gated by both calling and coach UI flags.
- JSON `{ enabled, scriptId }` saved under `sandra.softphone.coach.v1`; unavailable or malformed storage defaults off. Unknown script IDs fall back to `closr-outbound`.
- `startTarget` sets the initial collapsed state from the preference for manual, suggestion, recent, and lead-button calls. Reopen opts in; collapse and reset do not change the preference.
- Coach session subscriptions and transcript processing continue while hidden. The same preference also controls the initial view when recovering an active call after reload.
- Single-entry metadata registry derives title/version from the existing script. No multi-script loader, backend change, migration, or package addition.
- Exact head-crop SVG, accessible switch, Base UI Select, and 150ms height/opacity transition.

## Verification

- TypeScript check: passed.
- Full unit suite: 320 files / 3,597 tests passed.
- Full component suite: 108 files / 1,159 tests passed before the three additional recovery/reset cases; the final provider suite passes all 62 tests.
- Browser checks: 15 passed (two dialer layout/selection/contrast cases at 1440px and 375px, plus 13 existing coach audio acceptance cases).
- Changed-file ESLint and `git diff --check`: passed.
- Opened both the supplied reference and an isolated preview rendering the production SoftphoneProvider. Visually inspected off, on, and expanded script menu with Inter/Geist Mono and the real mascot asset. Synthetic actions prevent provider calls or production data changes.
- Browser assertions prove the picker is clickable above the dialer, stays within its bounds, naturally pushes down the input, and both headline/subtext colors exceed 4.5:1 against #0c1426.
- `npm run verify` cannot complete: its unrelated eSign rehearsal requires `SUPABASE_LOCAL_DB_URL` or `LOCAL_REHEARSAL_DATABASE_URL`, neither configured here. Its preceding atomic-packet tests passed. The typecheck/unit/component stages were run separately.

## Adaptations and limitations

- The revised ZIP's DIALER-SWITCH-PROMPT.md ends after dropdown styling and contains no test list. Coverage follows the explicit user requirements plus the earlier handoff's call-entry/persistence/contrast cases and the new picker, storage-failure, reset, and recovery scenarios.
- On narrow screens the headline truncates instead of overlapping the switch. Full text remains in the DOM for accessibility and in a title tooltip. Desktop copy and specified font size are unchanged.
- Added an optional `positionerClassName` prop to the shared SelectContent wrapper, used only here to put its portal above the dialer's z-index. Other select defaults remain unchanged.
- Active-call recovery honors the saved preference because that path bypasses startTarget; this prevents an unwanted auto-open after a reload.
- The exact requested storage key is browser-profile-local, not keyed by authenticated rep. It does not sync across devices or isolate accounts sharing a browser profile.
- Legacy scalar values such as "1"/"0" are treated as invalid and default off; this implements the revised JSON/default-off contract rather than reviving the superseded default-on behavior.
- Verification uses real UI components with synthetic transport/action boundaries; no authenticated deployment or real provider call is claimed.
