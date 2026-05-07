# Phase 05: Agent Outreach — Context

**Drafted:** 2026-05-07
**Status:** Pre-discuss (strategy locked, ready for `/gsd-discuss-phase 05` to fill in implementation decisions)

---

## Plain-English Summary

Today, every messaging flow in Sandra is hard-wired to text the **homeowner** of a property. The database already stores agent contact info (it's imported from CSVs and saved on the property record), but no part of the app ever actually messages an agent.

This phase flips the switch: the same SMS plumbing — composer, bulk send, sequences, templates, inbound triage — gains the ability to address either the homeowner *or* the listing agent on a per-property basis, with the user (or a sequence) choosing the recipient explicitly.

The core architectural move is small: introduce a single helper, `resolvePropertyRecipients(propertyId, role)`, and route every place that currently looks up `homeowner_contact_id` through it. The data model needs almost no change — the agent contact link already exists.

---

## Phase Boundary

**In scope:**
1. **Recipient resolution helper** — one function that takes a property and a role, returns the right contact + phone
2. **Lead detail SMS composer** — recipient picker (Homeowner / Agent), shows agent contact card alongside homeowner card
3. **Bulk SMS** — role filter ("Send to homeowners", "Send to agents", or "Send to both")
4. **Sequences** — `target_role` column; enrollment respects role
5. **Templates** — recipient-aware variables (`{{recipient.first_name}}` instead of `{{homeowner.first_name}}`)
6. **Inbound triage** — incoming SMS from a known agent number routes to the correct property thread, labeled "from agent"

**Strictly out of scope (deferred):**
- Absentee-owner-as-third-role (`owner_moved_at` is data-only today; treat homeowner = owner)
- Multi-agent / co-listing (one agent per property is enough for V1)
- Agent-as-app-user / agent OAuth (agents are recipients, not logged-in users)
- Handoff flows between agent and homeowner threads on the same property
- Per-agent consent tracking separate from homeowner consent (agent uses the same `contacts.sms_opted_out` semantics)

---

## Why this isn't a fundamental rewrite

The user feared this was an architectural mistake. It isn't. Here's what's already in place:

| Already exists | Where |
|---|---|
| `contacts` table is role-agnostic (no homeowner-specific fields) | `supabase/migrations/001_initial.sql:40` |
| `agent_details` sidecar table (brokerage, license info) | `supabase/migrations/001_initial.sql:98` |
| `properties.agent_contact_id` FK column + index | `supabase/migrations/001_initial.sql:176, :210` |
| CSV ingest already parses + saves agent contacts | `src/lib/csv/ingest.ts:382-486` |
| Core SMS function takes a generic `contactId`, not a homeowner ID | `src/lib/messaging/send.ts:89` |

What's homeowner-coupled is the **callers** (the places in the app that decide who to send to), not the foundation. We don't need new tables. We need a recipient-resolution layer and updates to a handful of UI + backend files.

---

## Strategy: Five Incremental Slices

The phase ships value at the end of each slice. Slice 1 alone proves the pattern and unblocks manual agent outreach.

### Slice 1 — Manual agent SMS from the lead detail page (smallest viable)
**Outcome:** A user opens a lead, sees both Homeowner and Agent contact cards, picks one, types a message, sends. Conversation thread renders the message correctly.
- Build `src/lib/recipients/resolve.ts` — `resolvePropertyRecipients(propertyId, role)`
- Refactor `src/app/(dashboard)/leads/[id]/sms-composer.tsx` to take a recipient prop, not homeowner-only props
- Refactor `src/app/(dashboard)/leads/actions.ts:sendSmsFromLead` to accept a role
- Add an Agent card alongside the Homeowner card on the lead detail page

### Slice 2 — Bulk agent SMS
**Outcome:** Bulk SMS UI lets the user pick "Homeowners / Agents / Both" before sending.
- Extend `src/app/(dashboard)/properties/actions.ts:bulkQueueSms` with a role filter
- Update the bulk action UI

### Slice 3 — Sequences targeting agents
**Outcome:** A sequence can be configured as "agent" (or "homeowner"); enrollment puts the right recipient on each message.
- Add `target_role` column to the `sequences` table
- Update `src/lib/sequences/enrollment.ts` to enroll the right contact per role
- Sequence editor UI gets a role selector

### Slice 4 — Recipient-aware templates
**Outcome:** Templates use `{{recipient.first_name}}` and substitute correctly for whichever role the message targets.
- Template render layer reads from the resolved recipient, not from a hard-coded homeowner shape
- Optional: a `template.recipient_role` tag so the UI can show "this template is for agents" hints

### Slice 5 — Inbound triage for agent replies
**Outcome:** When an agent texts back, the message lands on the right property thread and is labeled "from agent."
- Update `src/lib/messages/triage.ts` to match incoming SMS against `agent_contact_id` as well as `homeowner_contact_id`
- Inbox UI shows a small role badge on each conversation participant

---

## Decisions Locked

- **D-01:** Keep the existing FK columns (`homeowner_contact_id`, `agent_contact_id`) on `properties`. Do **not** migrate to a join table now. Reason: one homeowner + one agent per property covers V1; a join table is the right move only when multi-agent or multi-owner becomes real.
- **D-02:** Treat homeowner = owner for V1. The `owner_moved_at` field stays display-only; absentee-as-third-role is a future phase if/when the operations team needs to text owners at a different mailing address.
- **D-03:** A single recipient role per outbound message. No "send to both at once" as a single message — bulk "Both" sends two separate messages (one to each role) with separate consent + thread state.
- **D-04:** Reuse existing consent semantics on `contacts` (`sms_opted_out`, quiet hours via property state). Do not introduce per-role consent rules.
- **D-05:** Naming convention: the helper is `resolvePropertyRecipients` and returns `{ role, contact, phone }`. Role values: `'homeowner' | 'agent'` (string union, easy to extend later).

---

## Decisions Open (for `/gsd-discuss-phase 05`)

- Exact UI shape for the recipient picker (radio buttons inline with composer? Tab switcher? Two visible buttons "Send to homeowner" / "Send to agent"?)
- How to render an Agent contact card on the lead detail page — match Homeowner card styling, or visually distinguish?
- Sequence editor: dropdown vs. radio for `target_role`?
- Should bulk "Both" be a single click or require two separate sends? (D-03 covers semantics, not UX)
- Inbox role badge — text label, color chip, icon?
- Backfill for properties imported before this phase: do we backfill any role mapping or rely on imports going forward?

---

## Top Files Touched (refactor blast radius)

| File | Change |
|---|---|
| `src/lib/recipients/resolve.ts` | **NEW** — recipient resolution helper |
| `src/app/(dashboard)/leads/[id]/sms-composer.tsx` | Recipient-aware props |
| `src/app/(dashboard)/leads/[id]/page.tsx` | Render Agent card alongside Homeowner card |
| `src/app/(dashboard)/leads/actions.ts` | `sendSmsFromLead` accepts role |
| `src/app/(dashboard)/properties/actions.ts` | `bulkQueueSms` accepts role filter |
| `src/lib/sequences/enrollment.ts` | Resolve recipient per role |
| `src/lib/messages/triage.ts` | Match inbound on agent contact too |
| `supabase/migrations/05?_sequence_target_role.sql` | **NEW** — adds `target_role` column to `sequences` |

---

## Success Criteria

The phase is complete when all of the following are true:

1. From a lead detail page, a user can choose Homeowner or Agent as the SMS recipient (when both are present), send a message, and see it correctly attributed in the conversation thread.
2. Bulk SMS supports a recipient-role filter; messages reach only contacts in that role; no homeowner gets an agent-tone message and vice versa.
3. Sequences can be configured to target homeowners or agents; enrollment populates the correct contact for each message.
4. Templates render `{{recipient.first_name}}` correctly for both roles, with no broken substitutions in existing homeowner templates.
5. An inbound SMS from an agent's known phone number lands on the correct property thread and is visually labeled as agent-originated.
6. CI green: typecheck + unit + RTL + Playwright golden paths (including a new agent-SMS e2e test).
7. No regression: every existing homeowner SMS flow still works exactly as before.

---

## Dependencies

- **Blocks:** None. The data model (`agent_contact_id`, `agent_details`) is already in place.
- **Blocked by:** Nothing. Can start as soon as Phase 04 ships (or sooner — there's no overlap).

---

## Suggested Next Steps

1. Run `/gsd-discuss-phase 05` to surface the open UI decisions and lock implementation specifics
2. Run `/gsd-plan-phase 05` to break the five slices into executable sub-plans with task lists
3. Begin with Slice 1 — it's the smallest viable cut and proves the recipient-resolution pattern before the rest cascades

---

*Phase 05: Agent Outreach*
*Strategy drafted: 2026-05-07*
