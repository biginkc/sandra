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
| DASH-01 | Phase 03 | Pending |
| NOTIF-01 | Phase 03 | Pending |
| MSG-01 | Phase 03 | Pending |

**Coverage:**
- v2.1 requirements: 3 total
- Mapped to phases: 3 ✓
- Unmapped: 0

---
*Requirements defined: 2026-05-05*
*Last updated: 2026-05-06 — roadmap created, all 3 requirements mapped to Phase 03*
