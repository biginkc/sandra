---
type: prd
status: consolidated-for-review
version: "0.2"
created: 2026-09-11
updated: 2026-09-11
owner: Jarrad Henry
tags: [sandra, prd, my-leads, acquisitions]
---

# Sandra My Leads — Acquisitions queue and KPIs

**Version 0.2 — consolidated from Jarrad’s feasibility interview.** This specifies the agreed product behavior; it is not an implementation or deployment approval. Maria is the initial Acquisitions user. Jarrad is the owner and receives leads needing sequence follow-up.

## 1. Authority and scope

This revision supersedes conflicting requirements in the original PRD v0.1, BUILD-PROMPT.md, README.md, draft SOPs 66–74, and static mockup. Preserve those source files. The mockup remains the visual reference for the shell, rows, cards, colors, and dialogs, with the functional and labeling changes below. The original build prompt must be revised before it is used to implement this feature.

Deliver `/my-leads` as an additional workspace over Sandra’s existing lead records. Help Acquisitions staff prioritize outreach, qualify sellers, record offers, and secure a signed contract, ideally during the first call. Do not introduce artificial appointment or stage prerequisites that prevent a first-call agreement.

Both My Leads and the existing Leads page use the same properties, assignees, motivation information, notes, calls, appointments, and offer activity. My Leads queue stages are distinct from the shared sales status. Only the specified milestone actions synchronize the shared status. Do not redesign the Leads board or introduce a global `attempted` status.

No automatic appointments, tasks, sequence enrollments, contract sends, or new dialer/provider behavior are included. Owner inspection of individual Acquisitions queues and KPIs is included at launch; aggregate team dashboards and quotas are not.

## 2. Users and access

- Keep the existing `owner` and `member` access roles.
- Add a separate **Acquisitions** designation, which an owner can enable or disable per team member. It does not replace or grant access roles.
- Maria is the initial designated Acquisitions member. First-call response timing applies to new Acquisitions assignments, not every assignment in Sandra.
- A rep views their own assigned active queue. An owner can select an Acquisitions member and inspect that member’s queue and KPIs at launch.
- Use the same KPI calculation for the rep and owner. Viewing another rep must not change attribution or count the owner’s visit as rep activity.
- Preserve organization membership checks, existing assignment guards, and existing Leads access. Enforce the new page’s selection and mutation scope server-side; hiding a control is not authorization.

## 3. Queue sections and transitions

Render exactly five sections in this order:

| Section | Meaning | Progression |
|---|---|---|
| **Not contacted** | A new queue lead has no qualifying outreach attempt yet. | An actual placed call or recorded outreach attempt advances it to Contacted. |
| **Contacted** | At least one outreach attempt occurred, or the lead was initialized here at launch. Includes all follow-up work. | Rep manually selects **Ready to make an offer**, or logs an offer directly. |
| **Needs offer / Interested** | Rep has decided the seller is ready for an offer. | Log the offer to enter Offer Sent. |
| **Offer Sent** | An offer has been made and logged. | Manually mark Contract signed, or record Offer declined. |
| **Under Contract** | Rep has manually recorded a signed contract. | Remains visible until deliberately archived. |

There is no separate Follow-up section and no Won label. “Contacted” means **any attempt to reach out**, not necessarily a successful conversation. The Contact rate KPI still means reached outcomes divided by counted attempts.

Stages may be skipped when the real work happens during one call. Maria can qualify, log an offer, and record a signed contract without booking another meeting or stepping through each intermediate screen. A later call must not move an advanced lead back to Contacted.

Entering Needs offer / Interested is an explicit rep decision, not an automatic consequence of a call or appointment. Require a recorded motivation response for this action and when logging an offer directly. **No motivation provided** is a valid explicit response; it is distinct from an unanswered field. Preserve existing hot/warm/cold motivation values rather than inventing a temperature for that response. Allow the rep to specify the seller’s motivation in text and reuse it in the lead’s shared context.

Within each section, prioritize warning/overdue leads, then newest assignment. Warning timers and assignment timing are separate from the selected KPI period.

## 4. Shared milestones and data ownership

| Action in My Leads | My Leads result | Shared Leads result |
|---|---|---|
| First outreach attempt / actual call placed | Contacted, unless already further along | Contacted, without regressing an existing later or terminal status. |
| Ready to make an offer | Needs offer / Interested | Interested. |
| Log offer | Offer Sent | Offer Sent. |
| Contract signed, manually recorded | Under Contract | Under Contract. |
| Offer declined | Leaves rep’s active queue; offer outcome recorded | Offer Declined; apply Needs sequence and reassign to Jarrad. |
| Not interested / nurture handoff | Leaves rep’s active queue | Apply Needs sequence and reassign to Jarrad; do not automatically mark Dead. |
| Deliberately archive Under Contract | Leaves active queue; history retained | Archiving alone does not mean Closed or Dead. |

Milestone actions must not silently regress later or terminal shared states. Use existing consistency and concurrency protections. The offer-decline transition is deliberate and distinct from generic status regression.

Do not implement blanket reverse synchronization from arbitrary Leads-board status edits into My Leads stages. Both views share underlying facts and current lead status, but their stage controls are not interchangeable. Queue-specific state such as stage-entry time and archival state stays separate. Assignment changes from either existing surface must correctly change queue ownership.

Calls, notes, appointments, offers, and reassignment history remain associated with the original property. Neither page creates a second lead store. No activity or timestamps may be fabricated to make the two views appear aligned.

## 5. Actions

### Calls and attempts

Reuse the existing Sandra call flow and Live Coach behavior, preselecting the lead when started from its row. Use **Sandra** as the UI source name, not Center. Coordinate with existing call work before changing shared components.

Opening a dialog does not count as a call. The first-call clock stops when a call **actually starts**; an attempted UI action that fails before dialing must not stop it. The implementation must bind this to the existing call lifecycle’s authoritative initiation event, not seller answer or call completion.

Attempt logging supports No answer, Reached, and Wrong number, source Sandra or DialPad, occurrence time, optional recording link, and note. Recording links are optional, including DialPad. External calls can be recorded with their actual occurrence time; saving a log is not itself the call-start timestamp. Reuse existing provider records when available, linking the manual outcome to the same attempt. Do not count one call twice because both automatic and manual records exist.

DialPad v1 is manual external-call logging; a new voice API or automatic recording import is not required. Non-call outreach may establish Contacted but cannot satisfy the first-call clock. Unanswered calls count as attempted contact; unsuccessful setup before dialing does not.

### Ready to make an offer

Manual rep action. Collect the required motivation response, including No motivation provided. No completed appointment is required. Apply the Interested milestone and start the offer-needed timer.

### Appointments and callbacks

Users deliberately schedule, reschedule, and complete callbacks or appointments using Sandra’s existing records and actions. Reuse the existing appointment lifecycle (`held`, `no_show`, and other supported lifecycle operations); do not replace it with a new qualification vocabulary.

A scheduled future callback or appointment satisfies the Contacted next-step indicator. An elapsed, cancelled, or completed appointment does not count as a future next step. Completing an appointment does not automatically qualify a seller or create another task. Missing or overdue follow-up generates an indicator only.

### Log offer

Record amount, method (Dropbox Sign, verbal, email/text), sent date/time, and **required follow-up date/time**. Require motivation if not already answered. This records an offer already made; it does not send a contract or trigger eSign. Selecting Dropbox Sign is a method label, not a send instruction.

Logging moves the lead to Offer Sent and updates the shared milestone. Offer follow-up is stored with the offer; requiring that field must not silently create a task or calendar appointment.

### Contract signed and offer declined

Maria manually marks Contract signed, recording the signed event and applying Under Contract. Retain it until a user deliberately archives it, independent of KPI date-range changes. Do not treat contract signing as a completed closing.

Offer declined records that outcome, sets the shared status to Offer Declined, applies the existing **Needs sequence** disposition (`needs_sequence`), and reassigns to Jarrad. No automatic enrollment, appointment, task, or further action follows.

### Needs sequence, reassignment, notes, and DNC

For Not interested / needs-nurture handoff, use the existing Needs sequence disposition and reassign to Jarrad. Remove the lead from Maria’s active queue while retaining all history. Do not use a fictional “Sandra nurture” assignee or automatically mark the lead Dead.

General reassignment uses existing active-member validation. Keep past activity credit with the original rep. Identify Jarrad by the organization’s verified member identity, not a guessed account or display-name match at mutation time.

Notes use the existing append-only feed, author, and timestamps. Templates prefill text only and do not change status. Retain useful qualification fields from the original template, such as reason for selling, deadline, condition, mortgage, net needed, and next step.

Preserve Sandra’s existing DNC, wrong-number, and opt-out protections and meanings. This feature does not redefine phone-wide suppression or weaken permanent DNC locks. Reuse existing supported actions; do not implement sequential note/assignment writes that bypass a compliance lock. The Needs sequence decision is not a substitute for a genuine DNC request.

## 6. Timers and warnings

| Section / condition | Indicator rule |
|---|---|
| Not contacted / eligible assignment awaiting its first call | Warn at **30 accumulated working minutes** without an actual call start. |
| Contacted | Red indicator whenever no future callback or appointment is scheduled; no multi-day grace period. |
| Needs offer / Interested | Timer begins on entry; turns red at **12 elapsed hours** without a logged offer. |
| Offer Sent | Warn when required follow-up date/time passes with no recorded outcome. |
| Under Contract | No new stage-age warning specified. |

Working time is **Monday–Friday, 9 a.m.–5 p.m., America/Chicago**, with daylight saving changes. Only the first-call warning uses this calendar. Do not use first login, first visit, or daily app presence. Pause working-time accumulation outside the window; resume the same assignment clock during the next window rather than reset it each day. No holiday calendar is specified for v1.

Example: assignment Friday 4:50 p.m. reaches 30 working minutes Monday 9:20 a.m. An assignment after hours begins accumulating at the next working window. Calls started outside the window still stop the clock.

The offer-needed threshold is 12 elapsed hours, not 12 working hours. A simple “offer needed” state may appear immediately, but red age-based escalation begins at the threshold. All warnings are display/query behavior, not scheduling automation.

The first-call clock belongs to an eligible Acquisitions assignment period, so an old call by a previous assignee cannot satisfy a new eligible assignment. Keep the stopped-clock evidence even after the lead advances. The stale KPI includes eligible outstanding first-call warnings even if other outreach has already advanced the lead to Contacted; count each lead only once.

Thresholds and working hours should be centralized configuration. This does not require a new configuration UI in v1.

## 7. KPI definitions and attribution

Use Day / Week / Month and a date-range selector, interpreted in America/Chicago. Preserve six KPI tiles:

| KPI | Calculation |
|---|---|
| Attempts | Count unique recorded attempts occurring in the selected period for the rep who performed them. |
| Contact rate | Reached attempts divided by all counted attempts in that period. |
| Assign → first call | Average verified elapsed assignment-to-actual-first-call duration for eligible assignment periods beginning in the selected range and having a first call; exclude launch-initialized existing leads and unknown values. |
| Appointments kept | Held appointments divided by appointments due in the selected period, using existing canonical lifecycle records. |
| Offers sent | Logged offers with sent time in the selected period, attributed to the original rep who made them. |
| Stale leads | Current count of distinct leads with applicable warning conditions in the selected member’s active queue; independent of the period selector. |

Preserve original-rep credit after reassignment. Store event-time attribution rather than joining all historical events to the current assignee. For appointments, preserve accountable rep information for the appointment event rather than retroactively moving historic credit with the lead. A later owner viewing the queue does not become the event performer.

The working-hours rule was agreed specifically for first-call warning accumulation. The assignment-to-call KPI retains elapsed-duration semantics from the original definition; label it clearly and do not silently present business minutes as elapsed hours. Show pending/unknown first calls separately or as unavailable, never as zero-duration calls. Zero-denominator rates display unavailable rather than a misleading success rate.

## 8. UI changes from the original mockup

- Preserve the existing dashboard shell. Add only the My Leads link between Leads and Jobs and its current-user Not contacted count badge.
- Use the five section labels in §3 throughout rows, ladder graphics, dialog copy, and counts. Owner-selected content is labeled with that member; the sidebar badge remains the signed-in user’s badge.
- Add an owner-only member selector at launch. Use Acquisitions terminology instead of Closer.
- Keep expandable rows, search by name/address/phone, and expand/collapse controls. Bound list retrieval and detail loading to avoid slowing existing lead/message surfaces.
- Show assignment age in collapsed and expanded rows, with unknown/imported timing labeled honestly. Show the first-call state, stage needs, attempts, offer details, and newest-first shared notes.
- Use motivation colors/dots and border treatment from the mockup; do not force No motivation provided into hot/warm/cold.
- Move callback/appointment indicators into Contacted. Remove the separate Move to Follow-up action and mandatory appointment gate.
- Replace Won with Under Contract. Archive is deliberate and does not follow the date selector.
- Keep Open lead and reuse Sandra’s existing Zillow behavior. The removed outreach-origin block stays removed; shared conversation history remains available through existing lead surfaces.
- The static HTML has not yet been revised to these requirements. Do not treat its old six sections or timing examples as acceptance authority.

## 9. Data and implementation constraints

Reuse `properties`, membership/access checks, `lead_notes`, existing call activities, task-backed appointments, existing disposition actions, and the lead event/history conventions. Keep global status vocabulary unchanged.

Add only the durable data missing for these behaviors: Acquisitions designation, separate queue state and stage-entry/archival timestamps, eligible assignment-period history and actual first-call evidence, deduplicated attempts with original actor/occurrence time and optional call reference, and offer records with required follow-up time and original actor. An explicit No motivation provided response must remain distinguishable from missing input.

This is a behavior/data contract, not a mandate to duplicate an existing table. Final schema design must validate current-main structures and existing work. Historical events must survive current-assignee changes. A single mutable assignment timestamp is insufficient for preserving previous rep metrics.

Read queue rows, counts, and KPIs with bounded, organization-scoped server queries and appropriate assignee/stage/event-time indexes. Preserve authoritative RLS and assignment/lifecycle/DNC protections. Related milestone, disposition, offer-outcome, and reassignment writes must have transactional or equivalently recoverable consistency and must not duplicate on retry.

## 10. Launch treatment for Maria’s existing leads

- Initialize existing eligible active assigned leads in **Contacted** without inventing calls, attempts, or call-start timestamps.
- Update earlier shared statuses to Contacted while preserving advanced/terminal statuses, including Offer Sent and Under Contract.
- Preserve corresponding later queue milestones when initializing advanced leads. Do not resurrect Closed, Dead, archived, or DNC-ineligible leads into active outreach merely because they remain assigned.
- Mark the launch cohort explicitly and exclude it from assignment-to-first-call KPI/timing for that initial assignment. Do not substitute `updated_at` for an unknown actual assignment time.
- New Acquisitions assignments after launch receive eligible clocks. Reassignment history and original activity attribution remain intact.
- Initialization is idempotent and must be reviewed against the actual assigned cohort before execution; this PRD is not an instruction to mutate that cohort now.

## 11. Acceptance criteria

1. Owner can toggle Acquisitions independently of Owner/Member permissions; eligible timing applies only to new Acquisitions assignments.
2. Owner can view Maria’s queue/KPIs at launch; the same selected rep/period yields the same results as the rep’s view. Cross-organization and unauthorized rep selection are rejected.
3. The five sections render in the agreed order; there is no separate Follow-up or Won section and no new global attempted status.
4. Opening or cancelling the call dialog does not stop the clock. Actual initiation does, including an unanswered placed call. Log outcomes without duplicate attempts; DialPad recording links are optional.
5. First outreach advances Contacted and its shared milestone without regressing advanced leads. A non-call outreach attempt does not fabricate a first call.
6. Ready to make an offer is manual; motivation is required and No motivation provided is accepted. A completed appointment is not required.
7. A rep can log an offer and record a signed contract during the first call without walking through every stage. Offer logging requires motivation and follow-up date/time; it sends nothing.
8. Contract signed manually produces Under Contract in both milestone contexts; it stays visible through date-range changes until deliberately archived.
9. Offer declined records Offer Declined, Needs sequence, and reassignment to Jarrad. Not-interested handoff applies Needs sequence and reassignment without marking Dead. Neither creates enrollment, calls, messages, appointments, or tasks.
10. Fixture clocks prove 30 working minutes, Friday-to-Monday carryover, after-hours assignment, and daylight-saving-aware Central boundaries. Login activity has no effect.
11. Contacted with no valid future appointment/callback shows red immediately; a future scheduled next step clears it. Nothing schedules automatically.
12. Needs offer / Interested starts timing on entry and becomes red at 12 elapsed hours. Offer Sent warns after its required follow-up timestamp.
13. Stale is a deduplicated current count independent of the KPI date range. Original-rep activity credit survives reassignment; historical unknowns and pending first calls are not counted as zero.
14. Maria’s initial cohort enters Contacted or retains later milestones, without fake activity, status regression, terminal-lead resurrection, or first-call KPI inclusion.
15. Existing Leads, notes, appointments, calling, eSign, assignment guards, and DNC protections retain their behavior. No blanket reverse stage synchronization is introduced.
16. Validate queue transitions and KPI math with known fixtures, then verify authenticated UI including the owner selector, dialogs, warnings, and narrow-screen/zoom behavior under the existing test/release process.

## 12. Delivery boundary

Enable behind an organization-scoped feature gate for BMH initially. This document consolidates product decisions only. Implementation, mockup revision, BUILD-PROMPT/SOP alignment, schema migrations, cohort initialization, and deployment are separate work and must use the existing Sandra ownership, review, test-admission, and release process.

Feasibility assessment used GitHub main `8c7053e7024433f46791eac1b186c1b7a7cf10ec`; revalidate against current main and pending call/assignment work before coding. Exact live data coverage and provider configuration were not established by that assessment.
