# Phase 03: Operational Visibility Surfaces - Discussion Log

> **Audit trail only.** Do not use as input to planning, research, or execution agents.
> Decisions are captured in CONTEXT.md — this log preserves the alternatives considered.

**Date:** 2026-05-05
**Phase:** 03-Operational Visibility Surfaces
**Areas discussed:** Notification preview format, Skip-trace widget (DASH-01), Unread filter badge count

---

## Gray Area Selection

| Area | Selected for discussion |
|------|------------------------|
| Notification preview format (NOTIF-01) | ✓ (via freeform) |
| Skip-trace widget — migration vs verify (DASH-01) | ✓ (via freeform — user unfamiliar with widget name) |
| Unread filter badge count (MSG-01) | ✓ (via freeform) |

**User's response (combined):** "I thought we had this figured out already. Just add the preview below the address. I don't know what you mean by skip tricks widget, and all the chips should be consistent."

---

## Notification Preview Format (NOTIF-01)

| Option | Description | Selected |
|--------|-------------|----------|
| Replace address line | Show only the SMS text in the body | |
| Below the address | SMS preview appears as a second line beneath the address | ✓ |
| Inline after address | SMS text appended on the same line as the address | |

**User's choice:** Preview below the address
**Notes:** User indicated this felt already-decided ("I thought we had this figured out already"). Confirmed: second-line format, address line preserved. Truncation length (80 chars) set by Claude to match activity-feed pattern.

---

## Skip-Trace Widget Scope (DASH-01)

**User's response:** Unfamiliar with the term "skip-trace widget" — referred to it as "skip tricks widget."

**Claude's analysis:** The `dashboard_summary()` RPC (migration 028) already counts all non-deleted properties with no status filter for both numerator and denominator. No new migration needed. The issue is the click-through link from the coverage donut (`/leads?skip_traced=false`), which surfaces leads only. That link needs updating to show all properties without skip-trace data.

**Decision:** Verify existing RPC is correct (no migration) + update click-through link. Claude decides the exact link destination.

---

## Unread Filter Badge Count (MSG-01)

| Option | Description | Selected |
|--------|-------------|----------|
| No badge | Label-only chip (no count) | |
| Count badge | Show number of unread conversations (consistent with Unknown chip) | ✓ |

**User's choice:** Count badge — "all the chips should be consistent"
**Notes:** Unknown chip already shows a badge count. Unread should match. Count derived from `listThreads` unreadCount computation (no new DB query needed).

---

## Claude's Discretion

- NOTIF-01 truncation length: 80 chars (matches activity-feed preview in dashboard_summary RPC)
- NOTIF-01 exact body format: address line + newline + quoted/truncated SMS text
- DASH-01 link destination: planner chooses best `/properties` filter URL
- MSG-01 THREAD_FILTERS set: add "unread" to render the thread list (not the unknown-sender list)

## Deferred Ideas

None.
