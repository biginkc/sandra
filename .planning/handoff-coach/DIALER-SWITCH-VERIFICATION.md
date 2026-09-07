# Dialer coach switch verification

Branch: `coach/dialer-switch`, rebased onto `main` after PR #488 merged as `b1b2fd4e`. PR #489 contains only the coach switch and subsequent user-requested mascot update.

## Delivered

- Default-off coach preference and single-script picker immediately below CallerIdControl, gated by both calling and coach UI flags.
- JSON `{ enabled, scriptId }` saved under `sandra.softphone.coach.v1`; unavailable or malformed storage defaults off. Unknown script IDs fall back to `closr-outbound`.
- `startTarget` sets the initial collapsed state from the preference for manual, suggestion, recent, and lead-button calls. Reopen opts in; collapse and reset do not change the preference.
- Coach session subscriptions and transcript processing continue while hidden. The same preference also controls the initial view when recovering an active call after reload.
- Single-entry metadata registry derives title/version from the existing script. No multi-script loader, backend change, migration, or package addition.
- User-authorized artwork update: standing Sandra writes checkmarks on a checklist. `mascot-writing.png` replaces the head-circle in the UI and spans the headline through the enabled dropdown. OFF uses contain so antenna and feet remain visible; ON fills the full-height area. The original requested head SVG is retained. Accessible switch, Base UI Select, and 150ms height/opacity transition remain.

## Verification

- TypeScript check: passed.
- Full unit suite: 320 files / 3,597 tests passed.
- Full component suite: 108 files / 1,162 tests passed, including all 62 provider cases.
- Browser checks: 15 passed (two dialer layout/selection/contrast cases at 1440px and 375px, plus 13 existing coach audio acceptance cases).
- Changed-file ESLint and `git diff --check`: passed.
- Opened both the supplied reference and an isolated preview rendering the production SoftphoneProvider. Visually inspected off, on, and expanded script menu with Inter/Geist Mono and the real mascot asset. Synthetic actions prevent provider calls or production data changes.
- Browser assertions prove the picker is clickable above the dialer, stays within its bounds, naturally pushes down the input, and both headline/subtext colors exceed 4.5:1 against #0c1426.
- Full `npm run verify` now passes using an isolated, run-owned PostgreSQL 17 instance: atomic-packet tests, local eSign rehearsal, TypeScript, all 3,597 unit tests, and all 1,162 component tests. Real lockfile dependencies installed with `npm ci`; no shared dependency symlink remains.

## Adaptations and limitations

- The revised ZIP's DIALER-SWITCH-PROMPT.md ends after dropdown styling and contains no test list. Coverage follows the explicit user requirements plus the earlier handoff's call-entry/persistence/contrast cases and the new picker, storage-failure, reset, and recovery scenarios.
- On narrow screens the headline truncates instead of overlapping the switch. Full text remains in the DOM for accessibility and in a title tooltip. Desktop copy and specified font size are unchanged.
- Added an optional `positionerClassName` prop to the shared SelectContent wrapper, used only here to put its portal above the dialer's z-index. Other select defaults remain unchanged.
- Active-call recovery honors the saved preference because that path bypasses startTarget; this prevents an unwanted auto-open after a reload.
- The exact requested storage key is browser-profile-local, not keyed by authenticated rep. It does not sync across devices or isolate accounts sharing a browser profile.
- Legacy scalar values such as "1"/"0" are treated as invalid and default off; this implements the revised JSON/default-off contract rather than reviving the superseded default-on behavior.
- Pre-merge browser verification uses real UI components with synthetic transport/action boundaries. Production results are recorded separately after release. No real provider/customer call is required or claimed.

## Formal review and approval

Three independent read-only manual review lanes covered behavior/contracts, UI/accessibility/assets, and tests/documentation. Accepted fixes: OFF-state full-body crop, narrow-menu title/version/checkmark collision, and accidental unrelated manifest-title validation. Updated tests verify actual image loading, OFF containment, full-height layout, and nonoverlap measured in one browser frame. Browser menu screenshots are taken before selection; closed-state screenshots wait for unmount.

FABLE_ADVISORY_REVIEW: model `claude-fable-5-1`, verdict APPROVED for the final corrected source. No additional defects. Fable requires committed mascot asset, green build/CI, exact final picker browser checks, and authenticated production flag/default/picker/reload/PNG verification. It explicitly accepted this production scope without real calls. Fable did not edit files or operate production.
