# PR489 manual review

Review base: merged PR488 `b1b2fd4e`. Review source: `9f5d0783` plus accepted fixes in this commit. User authorized merge and production verification after manual review and Fable approval.

## Findings resolved

- P2: square standing mascot with object-cover cropped the antenna/feet in default OFF state. Fixed OFF to object-contain while retaining full-height enabled layout. Fresh desktop and mobile browser evidence confirms full body.
- P2: Base UI ItemText is a div with an inherited unshrinkable nowrap layout; narrow menu title/version collided with selection indicator. Coach-only first-child shrinking/min-width and title truncation reserve version/indicator space. Both viewport tests now verify nonoverlap from a single layout snapshot and visually show a readable version/checkmark.
- P3: broad edit added script-title validation to the unrelated section-manifest validator. Removed; optional title remains only in ClosrScript.
- P3: historical verification notes omitted subsequent mascot change. Updated with current source, formal review, and new verification evidence.

## Coverage

- Behavior/contracts reviewer: provider state/storage, all entry paths, recovery, session ownership and script schema/registry. No actionable defects.
- UI reviewer: provider UI, shared Select, assets, handoff, synthetic visual tests. Both original P2 findings confirmed resolved after code and fresh screenshot re-review.
- Tests reviewer: all changed tests/fixtures, schema, documentation accuracy, duplicate coverage. Behavioral component tests and browser geometry/portal tests add distinct signal; no redundant suites removed.
- Root: consolidated findings, verified each against code or rendered UI, implemented fixes, reviewed test sensitivity, and inspected updated browser preview.
- Queue: no stale agents existed before review; all three reviewers completed. UI reviewer reused for fix confirmation; no active delegated work remains.

## Integrations and secrets

Consulted official Base UI Select and Collapsible docs, React useState docs, and installed Next use-client/public-environment docs. Existing provider/session behavior unchanged. Links: https://base-ui.com/react/components/select ; https://base-ui.com/react/components/collapsible ; https://react.dev/reference/react/useState .

No secret values, credentials, new backend integrations, or new production environment variables introduced. Existing public coach/transport flags and synthetic fixture tokens only. Local rehearsal used a run-owned localhost database. No new or modified secret-bearing configuration requires a 1Password item; no secret values accessed for this review.

## Static analysis

`fallow audit --base origin/main --format compact`: leads triaged rather than auto-fixed. Shared exported Select helpers/useSoftphone and unused package references predate this PR. Complexity is dominated by existing provider and script validators; new guarded preference parsing is bounded. Duplication is inherited synthetic setup or distinct call-path assertions. No additional concrete defect established. Fallow excluded 93 inherited gate findings; no fallow fix executed.

## Verification and human review

Own `npm ci` installation. Full `npm run verify` passes against isolated PostgreSQL17: database rehearsal, TypeScript,3597 unit tests,1162 component tests. Thirteen coach-audio browser cases pass; both final desktop/mobile dialer cases pass after the selector fix. Changed-file lint and exact diff whitespace checks pass.

Human browser review adds value for the compact mascot/checklist and menu readability. Reviewed localhost:8795/tmp/dialer-switch-preview/index.html with actual production components, synthetic actions, Inter/Geist fonts. Off/on/menu flows at1440 and375 widths: verify complete silhouette, height spanning headline to dropdown, title/version/checkmark separation and natural expansion. Authenticated production idle preference/picker persistence is the post-merge acceptance flow; no call or customer record change is necessary.

## FABLE_ADVISORY_REVIEW

Claude Code model `claude-fable-5-1` reviewed the secret-free diff and full provider context with tools disabled. Verdict: APPROVED (source only). No defects survived independent/adversarial review. Preconditions: committed mascot asset, green build, final Playwright result. Postdeployment: authenticated flag, default-off, picker title/version, reload persistence, PNG200. Fable accepted that production scope; did not claim browser verification or perform mutations.

## Final spacing follow-up

The user requested less blank space on either side of the mascot. Reduced the mascot column from 56px to 40px and the adjacent gap from 10px to 6px; fresh 1440px and 375px browser checks pass and the actual preview was visually inspected. Fable (`claude-fable-5-1`) reviewed the final delta and returned APPROVED for source with no defects. Release still requires final-head CI and authenticated production verification.

A later full commit-hook run had one ProspectsTable menu timing failure outside the changed files; all 40 tests in that file passed on isolated recheck. The final commit reruns the complete hook. Existing remote-head golden-path CI failed with missing `org_esign_integrations.live_send_monthly_limit` on the dedicated CI database; investigation and schema alignment remain release work, not a waived gate.
