# Requirements: Sandra CRM — v2.1

**Defined:** 2026-05-05
**Core Value:** Get the right message to the right property owner at the right time — with VAs and the AI responder doing the boring parts.

## v2.1 Requirements

### Dashboard

- [ ] **DASH-01**: Skip-trace coverage widget counts all properties regardless of pipeline status (prospects + leads combined)

### Notifications

- [ ] **NOTIF-01**: "New SMS reply" notification items display a truncated text preview of the actual SMS reply body beneath the property address

### Messages

- [ ] **MSG-01**: The messages inbox includes an "Unread" filter that surfaces only conversations with at least one unread inbound message

### Tasks (V1 — shipped via PR #112)

- [x] **FOLL-01**: Follow-ups set via the dispo popover (nurture / callback_requested) are stored as task rows in the `tasks` table with the actor or chosen assignee, due_at, and related property.
- [x] **FOLL-02**: The dashboard renders a "My Tasks" panel showing the current viewer's open tasks, split into Today and Upcoming buckets, with inline Done + Snooze (1d / 3d / 1w) actions.

### Tasks Integrations (V2 — Phase 04)

- [ ] **SLACK-01**: When a task is assigned to a user other than the actor, that user receives a Slack DM with task title, property address, due date, and a one-click "Mark Done" button. Clicking the button updates the task in the CRM and the Slack message reflects the new state.
- [ ] **CAL-01**: When a task is created or its due_at changes, a corresponding 30-minute event lands on the assignee's Google Calendar (their primary calendar, in their stored timezone). Task completion does not delete the event (accepted tradeoff to avoid sync loops).
- [ ] **INTEG-01**: Each user can connect / disconnect Slack and Google Calendar in `/settings/integrations` and toggle each delivery channel on/off independently. OAuth refresh tokens are stored encrypted; never logged.

## Future Requirements

Deferred to a future milestone. Tracked but not in current roadmap.

### Admin

- **ADMIN-01**: `/admin/skip-trace-settings` page — configure skip-trace provider settings in UI
- **ADMIN-02**: `/admin/counties` page — add/manage BMH markets without a migration

## Out of Scope

| Feature | Reason |
|---------|--------|
| `/leads` table sort/search | Different UX (kanban), has its own pattern — deferred |
| Playwright retries 1→2 | Single-line config bump — `/gsd-fast` |
| 46-property CASS recovery | Operational task, no code |

## Traceability

| Requirement | Phase | Status |
|-------------|-------|--------|
| DASH-01 | Phase 03 | Shipped |
| NOTIF-01 | Phase 03 | Shipped |
| MSG-01 | Phase 03 | Shipped |
| FOLL-01 | (V1, PR #112) | Shipped |
| FOLL-02 | (V1, PR #112) | Shipped |
| SLACK-01 | Phase 04 | Pending |
| CAL-01 | Phase 04 | Pending |
| INTEG-01 | Phase 04 | Pending |

**Coverage:**
- v2.1 requirements: 8 total
- Mapped to phases: 8 ✓
- Unmapped: 0
- Shipped: 5 (Phase 03 + V1 Tasks substrate)
- Pending: 3 (Phase 04 — Slack + Calendar bundle)

---
*Requirements defined: 2026-05-05*
*Last updated: 2026-05-06 — Phase 04 (V2 integrations) added; FOLL-01/02 marked shipped via PR #112; SLACK-01, CAL-01, INTEG-01 pending discuss-phase*
