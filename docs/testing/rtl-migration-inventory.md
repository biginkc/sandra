# RTL Migration Inventory

Generated: 2026-04-29
Total specs: 21
- MIGRATE: 1
- STAY: 11
- GRAY: 9

## Summary

The Sandra E2E suite is dominated by integration-shaped specs that exercise the full webhook → DB → server-rendered UI loop, and most of them genuinely need a real browser. Eleven specs (cockpit reply/triage flows, qualify/revert, kanban drag, notifications, the import wizard, the Twilio round-trip, all the cross-route parity tests) lean on Server Actions writing DB state, Supabase Realtime, file uploads/downloads, clipboard, dnd-kit pointer events, or cross-route navigation — they should stay as Playwright. Only one spec (`prospects-page`) is a clean MIGRATE today because it just asserts a single Client Component renders without crashing. The remaining nine are GRAY: most are single-page, but they touch query-string URL state, render Server Components whose only meaningful assertions are on a child Client Component, fire native `window.confirm()` dialogs, or mix one quick DB-state check into an otherwise UI-only flow. Each GRAY entry is solvable — the question is whether we want to refactor the source components (extract the Client Component, swap `confirm()` for a real dialog, mock the Server Action) before migrating, or leave them in Playwright until the source naturally moves.

## Inventory

| Spec | Classification | Rationale | Effort | Target Components/Hooks |
|------|----------------|-----------|--------|-------------------------|
| e2e/admin-webhooks.spec.ts | GRAY | Single `/admin/webhooks` page, but the test reload-then-assert-plaintext-gone is verifying a server-rendered re-render, plus the action writes admin-config DB rows. Migration would need to test the dialog + table client components in isolation and lose the "plaintext only lives in success state" guarantee. | M | src/app/(dashboard)/admin/webhooks/page.tsx (RSC), create-consumer-dialog.tsx, row-actions.tsx, actions.ts |
| e2e/bulk-add-to-list.spec.ts | GRAY | Single `/properties` page; the value of the test is "Server Action writes property_lists rows for the multi-select." The UI portion (Actions menu + nested submenu) is portable; the DB assertion is the load-bearing one. Could split into RTL (menu opens, calls action) + Vitest (action behavior). | M | src/app/(dashboard)/properties/prospects-table.tsx, src/app/(dashboard)/leads/actions.ts (bulk add-to-list action) |
| e2e/cockpit-assignment.spec.ts | GRAY | Single `/messages` page across all 5 tests, but every assertion is on `properties.assigned_user_id` after a Server Action. Mockable but you'd be testing the optimistic UI path, not the action itself. The "Mine/Unassigned chips filter" tests are pure URL+filter logic and would migrate cleanly; the assign/unassign tests would lose meaningful coverage. | L | src/app/(dashboard)/messages/cockpit-view.tsx, inbox-thread-list.tsx, inbox-filters.tsx, assign-dropdown.tsx, inbox-detail.tsx |
| e2e/cockpit-inbox-shell.spec.ts | GRAY | Single page; tests cover tab active state, URL preservation, empty state, sort order, and Outbox cadence-controls render. The empty-state and sort-order tests are clean MIGRATE candidates; the URL-preservation tests assert on `page.waitForURL`, which is router.replace behavior — mockable but you lose the "URL stays in sync" guarantee. | M | src/app/(dashboard)/messages/cockpit-view.tsx, inbox-thread-list.tsx, queue-panel.tsx |
| e2e/cockpit-lead-detail-parity.spec.ts | STAY | Explicitly walks `/messages?thread=...` → `/leads/<propertyId>` and asserts the reply written on one surface appears on the other after cross-route nav. Navigation is the assertion. | n/a | (cross-route, not a migration target) |
| e2e/cockpit-realtime.spec.ts | STAY | POSTs to `/api/webhooks/dialpad/sms` and waits for the resulting INSERT to push to the browser via Supabase Realtime. Real backend round-trip is the entire point of the test. | n/a | (real backend, not a migration target) |
| e2e/cockpit-reply.spec.ts | STAY | Server Action `sendSmsToContact` writes a `messages` row with `external_id` matching `/^mock_/`, plus consent-block and quiet-hours guards that depend on real DB state and the system clock. Mocking strips the test of its meaning. | n/a | (server-action coverage; not a migration target) |
| e2e/cockpit-tabs-deeplink.spec.ts | GRAY | Single page, two tests, both pure URL-driven: `?tab=outbox` selects a tab, `?thread=<id>` pre-selects a side panel. Could migrate cleanly with a router mock; the question is whether we want this guarantee in JSDOM or keep it in browser to also catch search-params hydration issues. | S | src/app/(dashboard)/messages/cockpit-view.tsx, inbox-detail.tsx |
| e2e/cockpit-thread-panel.spec.ts | GRAY | 5 tests in one file: 4 are pure UI (panel renders, ESC closes, switching threads updates panel, bubble colors) — clean MIGRATE. The 5th (test 19) asserts `read_at` is stamped on inbound messages after opening a thread, which is a Server Action side-effect. Worth splitting the file: 4 tests migrate, 1 stays. | M | src/app/(dashboard)/messages/inbox-detail.tsx, inbox-thread-list.tsx |
| e2e/cockpit-unknown-triage-v2.spec.ts | STAY | Every test ends in a multi-table DB assertion (homeowner_details + agent_details + properties FK) following dialog-driven Server Actions that fan out across 3-4 tables. Mocking erases the contract being tested. | n/a | (DB schema/FK coverage; not a migration target) |
| e2e/cockpit-unknown-triage.spec.ts | STAY | Same shape as v2 — match/create/dismiss flows asserting on multi-table FK behavior. Plus uses native `dialog` events for confirm. | n/a | (DB schema/FK coverage; not a migration target) |
| e2e/dialpad-to-twilio-roundtrip.spec.ts | STAY | `test.skip`'d Tier-1 carrier-delivery probe — sends via Dialpad, polls Twilio's inbound webhook landing in `test_sms_log`. Real-backend round-trip is the entire reason it exists. | n/a | (carrier coverage; not a migration target) |
| e2e/import-update-wizard.spec.ts | STAY | Multiple disqualifiers: real CSV file upload via `setInputFiles`, CSV download via `page.waitForEvent("download")`, clipboard read via `navigator.clipboard.readText()` after `context.grantPermissions`, plus a background-job-runs-and-DB-statuses-update step. JSDOM doesn't do any of these well. | n/a | (file-IO heavy; not a migration target) |
| e2e/job-retry.spec.ts | GRAY | Renders a Server Component (`/jobs/[id]/page.tsx`) but every meaningful assertion is on a Client Component (`retry-skip-trace-button.tsx`) — button label, dialog open/close, error-class badge text, button hidden when terminal. Refactor target: feed the button props directly in RTL, drop the page-level seed. | M | src/app/(dashboard)/jobs/[id]/page.tsx, retry-skip-trace-button.tsx (Client Component, the refactor target) |
| e2e/kanban-drag.spec.ts | STAY | dnd-kit's PointerSensor needs real `pointermove` events with movement crossing a 4px activation constraint. JSDOM's pointer events don't reliably trigger dnd-kit collision detection, and the test explicitly uses `page.mouse.move` with `steps: 5/15`. | n/a | (real-pointer dependency; not a migration target) |
| e2e/notifications.spec.ts | STAY | Real Supabase Realtime handshake + INSERT broadcast to bell badge. Plus cross-route nav (bell click → `/leads/<id>`). The Realtime path is the contract under test. | n/a | (Realtime coverage; not a migration target) |
| e2e/prospects-page.spec.ts | MIGRATE | Two tests, both single-page, single-component: page renders without crashing into the error boundary, Actions button toggles disabled/enabled on row check. The original bug it guards against is a Base-UI `Dropdown*Label` runtime context error — which would surface in JSDOM render too. | S | src/app/(dashboard)/properties/prospects-table.tsx (Client Component) |
| e2e/qualify-flow.spec.ts | STAY | Walks `/properties` → `/leads` and `/leads/<id>` → `/properties`, with both ends of the round-trip being part of the assertion. Plus a native `window.confirm()` on the revert path. | n/a | (cross-route; not a migration target) |
| e2e/sequences-flows.spec.ts | GRAY | 8 tests, mixed: tests 2/3/4 (add-step modal validation, delay unit picker, delete step) are clean MIGRATE candidates against the editor's Client Components. Tests 1/5/6/7/8 cross between create-redirect-to-edit, lead-detail enroll widget, native `confirm()` dialogs with assertion-on-message, and full sidebar nav across 7 routes — all STAY. Worth splitting. | L | src/app/(dashboard)/sequences/[id]/edit/* (whatever the editor's client components are), src/app/(dashboard)/leads/[id]/enroll-widget.tsx |
| e2e/sequences.spec.ts | GRAY | Two tests: index renders starter library (Server Component reading DB — could refactor if we extract the list), and new-sequence form submit redirects to `/sequences/<uuid>/edit` and writes a DB row. Form-submit-then-redirect-then-DB is the canonical GRAY case. | S | src/app/(dashboard)/sequences/page.tsx, src/app/(dashboard)/sequences/new/page.tsx, actions.ts |
| e2e/sms-roundtrip.spec.ts | STAY | Inbound webhook POST + auto-qualify Server Action stamps `qualified_by = system:inbound_reply` + lead-detail Server Component renders the inbound. Cross-route, real DB, full webhook chain. | n/a | (webhook + RSC coverage; not a migration target) |

## MIGRATE — target component map

### `src/app/(dashboard)/properties/prospects-table.tsx` (Client Component)

- **e2e/prospects-page.spec.ts** — both tests (renders without crashing, Actions button toggles on row select)

This is the single clean MIGRATE today. The page-level Server Component (`/properties/page.tsx`) just queries Supabase and renders `<ProspectsTable rows={...} />`; the table itself owns all the interactive state (selection, Actions menu open/closed, disabled state). RTL test feeds rows directly as props, asserts the Base-UI dropdown mounts without throwing and that the Actions button reads "Actions" → "Actions (1)" when a checkbox flips. Should kill the dependency on `seedProspects` + admin client entirely.

## GRAY — open questions

1. **e2e/admin-webhooks.spec.ts** — The test's load-bearing claim is "plaintext secret only lives in the success state, never in server-rendered output." If we migrate to RTL we test the dialog component in isolation and lose the post-reload assertion. Are you OK leaving that guarantee uncovered, or should this stay Playwright?

2. **e2e/bulk-add-to-list.spec.ts** — Should we split this into two tests (UI: menu opens, action handler called with right ids → RTL; Action: `addToList` writes correct property_lists rows → Vitest server-action test), or keep the end-to-end as one Playwright spec?

3. **e2e/cockpit-assignment.spec.ts** — Five tests, two ("Mine chip filter", "Unassigned chip filter") are URL/filter logic that migrates cleanly; three (avatar render, assign-to-me click, unassign+reassign) need DB state assertions. Split per-test, or keep the file as one Playwright spec?

4. **e2e/cockpit-inbox-shell.spec.ts** — Tests 7/8/13 are tab/cadence UI that migrates cleanly; tests 9/10/11/12 mix URL preservation + DB-seeded thread sorting. Want to split, or all-in/all-out?

5. **e2e/cockpit-tabs-deeplink.spec.ts** — Both tests are pure URL → UI state with seeded DB rows. Are search-params hydration issues something we want browser coverage on, or are we comfortable with a JSDOM router mock here?

6. **e2e/cockpit-thread-panel.spec.ts** — Tests 14/15/16/17 are pure client-side panel behavior (clean MIGRATE); test 19 needs the Server Action's `read_at` stamp. Split the file?

7. **e2e/job-retry.spec.ts** — All three tests would be cleaner as RTL tests on `<RetrySkipTraceButton>` with props fed in. Are you up for that refactor, or keep it as a thin browser smoke that exercises the page-level data fetching too?

8. **e2e/sequences-flows.spec.ts** — 8 tests, mixed (see inventory). Worth splitting the file into `sequences-flows-editor.test.ts` (RTL, tests 2/3/4) and `sequences-flows.spec.ts` (Playwright, tests 1/5/6/7/8)?

9. **e2e/sequences.spec.ts** — The new-sequence test is the canonical "form submit → server action → redirect → DB row" GRAY shape. Mocking the action gives us a UI-only assertion (form submits, navigation called); the DB assertion is what makes the test load-bearing today. Are you OK splitting (RTL for form interaction, Vitest for the action) or keeping as Playwright?
