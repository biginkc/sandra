# Sandra CRM

**What This Is:** A wholesale real-estate CRM (BMH Group internal) for triaging cold prospects → qualifying leads → running drip outreach → closing deals. Property-centric: every contact, message, and pipeline stage hangs off a `properties` row. Built on Next.js App Router + Supabase + Vercel Functions.

**Core Value:** Get the right message to the right property owner at the right time — with VAs and the AI responder doing the boring parts.

**Last updated:** 2026-05-05 (after v2.1 milestone start)

**Current state:** v2.0 shipped 2026-05-06 — cross-table UX consistency + market refactor. 16 plans across 3 phases. Closed with documented tech debt (Phase 01 + Phase 02 lack VERIFICATION.md; DS-05 visual regression check pending; see `.planning/milestones/v2.0-MILESTONE-AUDIT.md`).

---

## Context

- **Operator:** Jarrad Henry (BMH Group, wholesale RE investor across 4 markets)
- **Users:** Jarrad + 1-2 VAs; AI responder handles the bulk of cold-message replies
- **Production status:** Live (`https://sandra-sooty.vercel.app`) but not yet onboarding real prospects at scale; safe window for breaking changes is closing
- **Current scale:** ~1,400 prospects in prod, ~100 leads in pipeline
- **Vendor stack:** Twilio (SMS), Tracerfy (skip-trace), SmartyStreets (CASS), Anthropic (AI responder)

---

## Validated Capabilities (shipped through milestone v1)

| # | Capability |
|---|---|
| 1 | CSV import wizard (DealMachine, PropStream) — Add + Update modes, CASS auto-trigger |
| 2 | Property data lake — `/properties` (rebuilt 2026-04-30 with engagement pills, search, sort, filters) |
| 3 | Tags + custom journey markers |
| 4 | Lead pipeline kanban (`/leads`) with assignment, motivation, drag-and-drop status |
| 5 | Sequences V1 — drip campaigns with pause-on-reply |
| 6 | AI responder — auto-replies safe inbound, escalates ambiguous |
| 7 | Notifications — bell with realtime + relative timestamps + clear-all |
| 8 | Dashboard `/dashboard` — leads-pipeline summary cards |
| 9 | Manual lead intake + per-consumer webhook auth |
| 10 | Skip-trace V1 — Tracerfy provider, three surfaces, request-and-approve |
| 11 | SMS templates v1 — schema, UI, lead-reply picker, sequence integration (PR #71) |

---

## Current Milestone: v2.1 — Operational Visibility

**Goal:** Surface the right signals at a glance — skip-trace coverage across all contacts, SMS reply previews in notifications, and an unread filter on the properties table.

**Target features:**
- Dashboard: skip-trace coverage widget counts all properties (prospects + leads combined)
- Notifications: "New SMS reply" items show a text preview of the actual reply
- Messages inbox: "Unread" filter tab/pill on `/messages` to surface only conversations with unread messages

---

## Key Decisions

- **Property-centric data model.** Contacts attach to properties; messages key off `property_id`. Means every CRM surface filters/sorts on the same primary entity.
- **Vendor abstraction.** Every external service (Twilio, Tracerfy, SmartyStreets, Anthropic) goes through a common interface with swappable adapters; schema stays vendor-agnostic.
- **Sandra migrations are CI-only.** Files in `supabase/migrations/`; the `db-migrate.yml` workflow auto-applies on merge to main. Never `apply_migration` against prod via MCP.
- **Cost-bearing actions need explicit opt-in.** Paid vendor calls (skip-trace, CASS verify) require checkbox/button; never auto-fire from a related action.
- **TCPA/A2P compliance** is enforced at the Twilio adapter (opt-out keywords, 8am-9pm window per timezone).

---

## Evolution

This document evolves at phase transitions and milestone boundaries.

**After each phase transition** (via `/gsd-transition`):
1. Requirements invalidated? → Move to Out of Scope with reason
2. Requirements validated? → Move to Validated with phase reference
3. New requirements emerged? → Add to Active
4. Decisions to log? → Add to Key Decisions
5. "What This Is" still accurate? → Update if drifted

**After each milestone** (via `/gsd-complete-milestone`):
1. Full review of all sections
2. Core Value check — still the right priority?
3. Audit Out of Scope — reasons still valid?
4. Update Context with current state
