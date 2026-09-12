---
type: research
status: implementation-plan-input
version: "0.1"
updated: 2026-09-11
owner: Codex
scope: my-leads
---

# My Leads UI, KPI, and time implementation research

This note is bounded to the revised PRD v0.2 and the verified main snapshot at `8c7053e7024433f46791eac1b186c1b7a7cf10ec`. It is research only. It does not approve migrations, cohort initialization, provider changes, or deployment.

## Decisions carried from PRD v0.2

The implementation must add `/my-leads` as a second view over `properties`; it must not create a lead copy or alter the existing Leads board vocabulary (`docs/my-leads/PRD.md:15-23`). The queue has exactly five sections—Not contacted, Contacted, Needs offer / Interested, Offer Sent, Under Contract—and may skip milestones during one call (`docs/my-leads/PRD.md:34-50`). Only the specified milestone actions synchronize shared status (`docs/my-leads/PRD.md:54-70`).

The owner/member role remains unchanged. Acquisitions is a separate per-member designation, and an owner may inspect a designated member’s queue and KPIs. The selected rep, period, and organization must be authorized server-side; viewing another rep must not attribute activity to the viewer (`docs/my-leads/PRD.md:25-32`). The initial BMH enablement is organization-scoped (`docs/my-leads/PRD.md:204-208`).

The six KPI tiles have distinct time rules: Attempts, Contact rate, Assign → first call, Appointments kept, Offers sent, and current Stale leads (`docs/my-leads/PRD.md:136-151`). The first-call warning uses accumulated Monday–Friday 09:00–17:00 `America/Chicago` working minutes; the Assign → first call KPI remains elapsed duration (`docs/my-leads/PRD.md:116-134,144-151`).

## Runtime and documentation baseline

The direct dependency declarations are Next `16.2.4`, React/React DOM `19.2.4`, `date-fns` `^4.1.0`, `@supabase/ssr` `^0.10.2`, and `@supabase/supabase-js` `^2.104.0` (`package.json:43-70`). The resolved lockfile versions are Next `16.2.4`, React `19.2.4`, React DOM `19.2.4`, `date-fns` `4.1.0`, `@date-fns/tz` `1.5.0`, `@supabase/ssr` `0.10.2`, and `@supabase/supabase-js` `2.104.0` (`package-lock.json`, resolved with the lockfile package entries). `@date-fns/tz` is transitive; it is not a direct dependency and should not be imported without an explicit dependency decision.

No local `node_modules/next/dist/docs` guide was present in this worktree. The relevant official guidance is the [Next.js App Router documentation](https://nextjs.org/docs/app), which describes file-system routes, layouts, Server Components, and client-side navigation; [Supabase’s SSR client guidance](https://supabase.com/docs/guides/auth/server-side/creating-a-client), which separates server and client clients and warns about cookie refresh; and [Supabase RPC guidance](https://supabase.com/docs/reference/javascript/rpc), which supports calling a typed Postgres function with named arguments and read-only `get` options. The existing repo already follows that shape in `src/lib/supabase/server.ts:1-53` and uses RPCs in `src/app/(dashboard)/leads/board-actions.ts:121-152`.

The [Supabase database-functions guidance](https://supabase.com/docs/guides/database/functions) recommends the default `SECURITY INVOKER`; if a function is intentionally `SECURITY DEFINER`, it requires `search_path = ''` and schema-qualified relation names. The final `CONTRACTS.md` should assign each tenant/selected-rep check to an explicit server-action and/or database-function layer rather than treating a blanket “RLS or server auth” statement as sufficient. [Supabase Realtime](https://supabase.com/docs/guides/realtime/subscribing-to-database-changes) is an optional later invalidation path; the initial queue can use server revalidation after mutations and must not require a live subscription for correctness.

## Existing seams and constraints

**Shell and navigation.** `src/app/(dashboard)/layout.tsx:34-35,59-61,76-105` keeps `SoftphoneProvider`, global search, the fixed header, and the dashboard shell mounted around route content. Add a single `/my-leads` item between Leads and Jobs in `src/components/dashboard-sidebar.tsx:51-63`. The current sidebar is a client component with a static `ITEMS` list and no badge input (`:78-109`); the mobile nav reuses that list but has its own active-path helper (`:111-139`). The smallest seam is a server-resolved, signed-in-user badge value passed through a narrow shell prop or a small client badge provider. Do not make the sidebar fetch all queue rows.

**Existing Leads performance.** The Leads page loads memberships, rosters, and organization names in parallel (`src/app/(dashboard)/leads/page.tsx:47-90`) and uses `fetchLeadBoardData` (`:122-132`). The existing query uses 20 rows plus one cursor sentinel per shared status (`src/app/(dashboard)/leads/board-query.ts:16,102-149`), runs status pages in parallel, and fetches optional decorations in chunks (`:322-359`). This is a useful pattern, but My Leads should use one queue-specific bounded read model because its stages are not `properties.status` and its aggregates depend on event-time attribution. Server Components are appropriate for the initial queue/KPI snapshot; the expandable row should remain a small Client Component and load detail only on expansion.

**Calls and actual initiation.** The current target helper stamps `startedAt` while preparing a target (`src/lib/dialer/actions.ts:62-74`), before the provider start handshake. The softphone starts its state machine at `src/components/softphone/softphone-provider.tsx:470-495`, prepares the target, then stores `result.data.startedAt` before constructing and starting the transport (`:533-585`). The Jitter path validates the sealed intent and sends the start request at `src/lib/dialer/jitter-server.ts:181-229,306-319`; its successful response is the earliest existing authoritative initiation boundary. The plan must not use target-preparation time as `first_call_at`. Prefer a durable first-call evidence event tied to the successful provider start response/call activity, with idempotency keyed by the existing call token. A manual DialPad attempt may record an occurrence time and outcome but cannot satisfy the first-call clock unless the user explicitly records that the external call actually began (`docs/my-leads/PRD.md:74-82`).

**Appointments and shared detail.** Appointment lifecycle is already task-backed and supports `held`, `no_show`, `rescheduled`, and `cancelled`; the PRD explicitly requires reuse (`docs/my-leads/PRD.md:88-92`). The lead detail already loads bounded notes, lead events, calls, and open tasks/appointments (`src/app/(dashboard)/leads/[id]/page.tsx:253-261,397-460`). Reuse those records and actions for expanded details; do not make the queue query join full message bodies, transcripts, or notes.

**Time utilities.** `src/lib/time/zoned.ts:1-8` documents the project’s deliberate choice to use `Intl.DateTimeFormat` rather than adding `date-fns-tz`. Its `getDayBoundsInZone` derives each local midnight independently (`:132-159`), `normalizeTimeZone` safely falls back to `America/Chicago` (`:162-179`), and `wallTimeToUtc` rejects nonexistent DST wall times (`:184-234`). Existing tests cover Chicago spring-forward/fall-back and zone fallback (`src/lib/time/zoned.test.ts:67-108,126-155`). Extend this utility family with a pure working-minute calculator instead of introducing a second timezone library.

**Acquisitions setting.** The existing Team page is an administrator surface, not an organization-owner surface: it gates access with `isAdminEmail` (`src/app/(dashboard)/admin/users/page.tsx:34-43`), enumerates global Auth users with the admin client (`:45-65`), and renders role/access controls (`:99-160`). Its role action also checks `isAdminEmail`, uses the fixed `SANDRA_ORG_ID`, and updates only `owner | member` (`src/app/(dashboard)/admin/users/actions.ts:10-15,68-121`); it deliberately does not create memberships. Do not broaden or reuse this global admin page for per-organization Acquisitions management. Acquisitions must be a separate field/table and action, with an owner-only same-organization server check, because the PRD says the designation neither replaces nor grants access (`docs/my-leads/PRD.md:25-32`). The smallest UI integration is a Manage Acquisitions dialog under My Leads, or a narrow My Leads settings route, backed by the caller’s active membership/owner role and a same-organization roster. `src/lib/auth/memberships.ts:29-45` is an existing caller-membership seam, but the final owner authorization and roster query remain contract decisions.

## Proposed bounded read model and API contract

Everything in this section is a proposal subordinate to the final `docs/my-leads/CONTRACTS.md`; it is not an approved schema or API. Use a queue-specific Postgres function, exposed through the existing server Supabase client. Supabase’s RPC contract supports named arguments and set-returning functions; keep explicit tenant and selected-rep authorization at the layer assigned by that final contract. The function should return bounded per-stage pages and one aggregate object so the initial render needs a predictable number of round trips.

Suggested server action input:

```ts
type MyLeadStage =
  | "not_contacted"
  | "contacted"
  | "needs_offer"
  | "offer_sent"
  | "under_contract";

type QueueCursor = { sortKey: string; propertyId: string };

type MyLeadsQueryInput = {
  orgId: string;
  selectedRepId?: string; // defaults to caller; owner-only override
  period: "day" | "week" | "month";
  rangeStart: string; // ISO instant, normalized to America/Chicago boundary
  rangeEnd: string;   // ISO instant, exclusive
  search?: string;    // bounded length, name/address/phone token search
  cursorByStage?: Partial<Record<MyLeadStage, QueueCursor | null>>;
  limitPerStage?: number; // server-clamped, e.g. 20 or 50
};
```

Suggested output:

```ts
type MyLeadsQueryOutput = {
  viewer: { userId: string; orgId: string; selectedRepId: string; canInspectOthers: boolean };
  rowsByStage: Record<MyLeadStage, MyLeadQueueRow[]>;
  nextCursorByStage: Record<MyLeadStage, QueueCursor | null>;
  hasMoreByStage: Record<MyLeadStage, boolean>;
  kpis: {
    attempts: number;
    reachedAttempts: number;
    contactRate: number | null;
    assignToFirstCallAvgSeconds: number | null;
    appointmentsDue: number;
    appointmentsHeld: number;
    appointmentsKeptRate: number | null;
    offersSent: number;
    staleLeads: number;
  };
  counts: Record<"not_contacted" | "contacted" | "needs_offer" | "offer_sent" | "under_contract", number>;
  timing: { timeZone: "America/Chicago"; workingWindow: { startHour: 9; endHour: 17; weekdays: 1 | 2 | 3 | 4 | 5 } };
};

type MyLeadQueueRow = {
  propertyId: string;
  address: string;
  homeownerName: string | null;
  phone: string | null;
  assignedAt: string | null;
  assignmentTiming: "eligible" | "launch_initialized" | "unknown";
  queueStage: "not_contacted" | "contacted" | "needs_offer" | "offer_sent" | "under_contract";
  stageEnteredAt: string | null;
  firstCallState: "pending" | "started" | "unavailable";
  warning: "first_call" | "missing_next_step" | "offer_needed" | "offer_follow_up" | null;
  attemptsCount: number;
  motivation: {
    temperature: "hot" | "warm" | "cold" | null;
    motivationResponseKind: "provided" | "no_motivation_provided" | "unanswered";
    text: string | null;
  };
  nextAppointment: { id: string; dueAt: string; assigneeId: string } | null;
  offer: { amount: number | null; method: string; sentAt: string; followUpAt: string } | null;
};
```

The page shape deliberately uses one cursor per queue stage, matching the existing Leads query’s per-status paging pattern. A single global cursor could fill the first sections and hide late-stage rows; a stage-filtered global endpoint would be an alternative only if the final `CONTRACTS.md` explicitly selects it.

The output intentionally separates `selectedRepId` from the viewer. The server must reject a selected rep outside the caller’s active organization or a non-owner override. The sidebar badge should call a smaller `get_my_leads_badge(org_id, viewer_id)` function returning `{ notContactedCount: number }`; it must always use the signed-in user, even when `/my-leads` is inspecting another rep.

The queue function should page a narrow property/stage workset first, then join only the row-level fields required by the collapsed card. Detail retrieval should be a separate `get_my_lead_detail(property_id, selected_rep_id)` action with the existing DNC and membership checks. The detail output may include bounded newest-first notes, attempts, offers, appointment summaries, and shared event history. Do not return transcripts or full message history in the queue response.

## KPI and time calculations

### Working-minute warning clock

Implement a pure function with this shape:

```ts
type WorkingSchedule = {
  timeZone: "America/Chicago";
  startMinute: 9 * 60;
  endMinute: 17 * 60;
  weekdays: readonly [1, 2, 3, 4, 5];
};

function accumulatedWorkingMinutes(
  assignmentStart: Date,
  end: Date,
  schedule: WorkingSchedule,
): number;
```

The algorithm must walk local calendar dates in `America/Chicago`, intersect each weekday’s `[09:00,17:00)` wall interval with the assignment-to-end interval, and convert the interval endpoints through the existing DST-safe helpers. It must never add 24-hour milliseconds to step days. The clock stops at the verified actual first-call instant; before that, it accumulates through the next open window, including Friday-to-Monday carryover. Calls outside the window still stop the clock (`docs/my-leads/PRD.md:116-130`). No holiday table is needed for v1. Centralize the schedule and 30-minute threshold in a module constant/config object (`docs/my-leads/PRD.md:132-134`).

Fixture requirements are directly specified: 30 minutes within one day, Friday 16:50 → Monday 09:20, after-hours assignment, spring-forward and fall-back Central boundaries, and no effect from login activity (`docs/my-leads/PRD.md:185-199`). Add unit tests beside the time helper; do not test through browser timers.

### Assign → first call KPI

Use elapsed seconds between an eligible assignment-period start and the durable actual first-call instant. Filter by assignment-period start in the selected range, exclude launch-initialized rows, exclude unknown/pending calls, and average only verified completed pairs. Preserve the original rep and assignment-period id on each event; a mutable `properties.assigned_at` cannot support reassignment history (`docs/my-leads/PRD.md:136-151,166-174`). The UI should render unavailable for a zero denominator or no verified pairs, never zero.

This KPI must remain wall-clock elapsed time even though the warning timer uses business minutes. Label the tile/help text accordingly. A test that reuses the working-minute function for this average would be a product bug.

### Other aggregates

- **Attempts / Contact rate:** count deduplicated attempt records by occurrence time and original actor. Reached is a subset of counted attempts; an owner viewing another queue never becomes actor. Existing `call_activities` can be linked when the provider record exists, but manual DialPad records need their own occurrence/actor identity (`docs/my-leads/PRD.md:74-82,140-143`).
- **Appointments kept:** count canonical task appointments due in the selected range, and held outcomes among them. Preserve the accountable rep on the appointment event; do not reattribute by current lead owner (`docs/my-leads/PRD.md:88-92,145,149`).
- **Offers sent:** count offer rows by their required `sentAt` and original rep, not by current property status or eSign send activity. Follow-up overdue is row warning state, not a task creation (`docs/my-leads/PRD.md:94-98,146`).
- **Needs offer warning:** stage-entry time starts the 12 elapsed-hour threshold. It is not a working-hours timer and should not be affected by the selected KPI period (`docs/my-leads/PRD.md:120-130,198`).
- **Stale:** count distinct leads currently in the selected member’s active queue with any applicable warning, independent of date range. A lead may have an outstanding first-call warning even after it has advanced to Contacted, but deduplicate it once (`docs/my-leads/PRD.md:130-151,199`).

## UI implementation packets

These are deliberately small Luna-sized packets with explicit dependencies.

### Packet A — access, designation, and navigation

**Files:** a new My Leads Manage Acquisitions dialog or narrow settings route/action over the same-organization roster, a new designation helper/action module, `src/components/dashboard-sidebar.tsx`, the dashboard layout prop seam, and the existing `src/lib/supabase/types.ts` if schema changes require its generated database shape to be refreshed. Do not modify the global admin Team page for this feature.

**Work:** add an organization/member Acquisitions designation with same-organization owner-only mutation; expose only designated members in the owner selector; add the `/my-leads` link and signed-in-user badge; enforce route/action authorization server-side.

**Depends on:** designation schema/authorization contract. The badge RPC can be wired with Packet C; this packet must not depend on queue UI implementation.

**Meaningful tests:** unit tests for the new My Leads designation authorization and owner/non-owner selection; RTL sidebar tests for badge/link/mobile behavior; a focused integration test for cross-org and unauthorized rep rejection. Once the proposed action path exists, run `npm run test -- 'src/app/(dashboard)/my-leads/manage-acquisitions-actions.test.ts'`, `npm run test:rtl -- 'src/components/dashboard-sidebar.test.tsx'`, then the relevant integration file through `npm run test:integration -- <path>` when the migration exists.

### Packet B — time and KPI math

**Files:** `src/lib/time/zoned.ts` or a new adjacent `src/lib/time/working-minutes.ts`, unit tests, and a KPI calculation module with no UI imports.

**Work:** implement the Central working-minute accumulator, elapsed Assign → first call calculation, 12-hour stage warning, follow-up overdue, unavailable/unknown handling, and zero-denominator rates.

**Depends on:** only the event/attempt/offer type contract, not database wiring or UI.

**Meaningful tests:** `npm run test -- src/lib/time/zoned.test.ts <new-kpi-test-file>`; include DST spring/fall, Friday-to-Monday, after-hours, actual-call stop, launch cohort exclusion, reassignment attribution, pending/unknown exclusion, and no denominator. No external provider or database is needed.

### Packet C — queue read model and aggregates

**Files:** a new `src/app/(dashboard)/my-leads/queries.ts` and server action, a new migration/RPC, indexes, and the existing `src/lib/supabase/types.ts` only if the schema/RPC change requires a type refresh.

**Work:** implement the bounded per-stage queue pages, current counts, KPI aggregates, stale deduplication, selected-rep authorization, per-stage cursor validation, and badge query. Keep row selection narrow and details separate.

**Depends on:** Packet A designation contract and Packet B pure calculation/type contract; it can land before the client board.

**Meaningful tests:** migration/RPC integration fixtures for tenant scope, per-stage cursor stability (including visibility of late stages), original-rep attribution, launch cohort exclusion, distinct stale count, and zero-denominator KPI output. Run the focused integration file with `npm run test:integration -- <path>`; the integration config is serial and resets a shared test database (`vitest.integration.config.ts:20-39`).

### Packet D — queue UI and lazy detail

**Files:** new `src/app/(dashboard)/my-leads/page.tsx`, query/row/section client components, dialogs, and focused RTL tests; reuse existing lead detail/action modules where safe.

**Work:** render five sections, search, owner selector, KPI period controls, warning ordering, assignment-age honesty, expandable rows, and lazy detail fetch. Starting a call must pass the row’s lead into the existing softphone flow; do not duplicate provider UI. Keep collapsed cards usable if detail fails.

**Depends on:** Packets A–C and the PRD v0.2 contract. The static mockup remains a visual reference, but a revised mockup or build prompt is not a prerequisite for this packet. It should not alter `src/app/(dashboard)/leads/kanban.tsx`.

**Meaningful tests:** `npm run test:rtl -- <new-my-leads-tests>` for section order, selectors, unavailable KPI states, expansion loading/error, and dialogs. Add one authenticated E2E spec only after the queue RPC/fixtures exist; the default Playwright config is single-worker and ignores prod-only suites (`playwright.config.ts:126-173`). The current tester gate permits at most four total accounts, so reuse fixture identities rather than creating a per-packet account matrix.

### Packet E — optional reference and contract alignment

**Files:** the static My Leads mockup, `BUILD-PROMPT.md`, and SOP alignment docs; no production source.

**Work:** optional follow-up documentation alignment: replace the old six-section/Follow-up/Won vocabulary with five sections, Acquisitions terminology, current-rep badge behavior, working-minute versus elapsed KPI copy, actual call-start wording, owner selector, no mandatory appointment gate, and lazy detail expectations (`docs/my-leads/PRD.md:153-164`). The PRD and static reference are sufficient to implement the feature; this packet may follow UI work and is not a release or implementation prerequisite.

**Depends on:** PRD v0.2 only. Keep its changes separate from product implementation and subordinate to the final `CONTRACTS.md` where terminology or API copy overlaps.

## Minimal product/implementation decisions still needed

1. The PRD says the actual provider initiation event is authoritative, but the current softphone target carries a preparation timestamp. Confirm the exact event/row that may create the durable first-call evidence, including failed/ambiguous provider starts.
2. Define whether “recorded outreach attempt” includes non-call outreach in the same attempt table and exactly which outcomes count as Reached. The queue stage can advance on any qualifying attempt, while the first-call clock must require actual dialing (`docs/my-leads/PRD.md:40-46,76-82`).
3. Choose the designation schema shape and whether the BMH organization feature gate belongs in the same org-settings surface or a separate feature table. The existing Team page is a global admin surface, so the owner-controlled setting should live in the My Leads Manage Acquisitions dialog or a narrow same-organization route; no current Acquisitions field exists.
4. Confirm the RPC output’s handling of unknown historical assignment periods and pending first calls. The PRD requires honest unavailable/pending states and forbids substituting `updated_at` (`docs/my-leads/PRD.md:176-183,199`).

The recommended default is an append-only assignment-period/attempt/offer model, a separate Acquisitions designation, one server-side bounded queue RPC plus one detail RPC, and pure time/KPI functions tested independently of Supabase.
