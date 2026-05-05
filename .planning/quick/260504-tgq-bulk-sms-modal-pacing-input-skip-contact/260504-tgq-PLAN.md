---
phase: 260504-tgq
plan: 01
type: execute
wave: 1
depends_on: []
files_modified:
  - src/app/(dashboard)/properties/actions.ts
  - src/app/(dashboard)/properties/actions.bulk-sms.integration.test.ts
  - src/app/(dashboard)/properties/bulk-sms-modal.tsx
  - src/app/(dashboard)/properties/bulk-sms-modal.test.tsx
  - src/app/(dashboard)/messages/actions.ts
  - src/app/(dashboard)/messages/actions.queue-stats.test.ts
  - src/app/(dashboard)/messages/queue-stats-banner.tsx
  - src/app/(dashboard)/messages/queue-stats-banner.test.tsx
  - src/app/(dashboard)/messages/cockpit-view.tsx
  - src/app/(dashboard)/messages/page.tsx
autonomous: true
requirements:
  - QUICK-260504-tgq-pacing
  - QUICK-260504-tgq-skip-contacted
  - QUICK-260504-tgq-queue-stats
must_haves:
  truths:
    - "Bulk SMS modal exposes a pacing input ([number] [seconds|minutes ▾]) defaulting to 18 seconds."
    - "Bulk SMS modal exposes a 'Skip prospects already contacted (N)' checkbox where N is the live count from countAlreadyContacted."
    - "Skip-contacted defaults to true when propertyIds.length > 50, false otherwise."
    - "Submitting the modal passes paceSeconds (resolved from value+unit) and skipIfContacted into bulkQueueSms."
    - "bulkQueueSms with skipIfContacted=true skips any property that already has an outbound message (preserving consent/opt-out checks)."
    - "/messages?tab=outbox renders a stats banner above QueuePanel showing queued / sent today / failed today / next release / drain ETA."
    - "Stats banner refreshes every 30s while the document is visible and pauses polling when hidden."
  artifacts:
    - path: "src/app/(dashboard)/properties/actions.ts"
      provides: "bulkQueueSms with skipIfContacted opt + countAlreadyContacted server action"
      contains: "skipIfContacted"
    - path: "src/app/(dashboard)/properties/bulk-sms-modal.tsx"
      provides: "Pacing input + skip-contacted checkbox + countAlreadyContacted fetch on open"
      contains: "paceUnit"
    - path: "src/app/(dashboard)/messages/actions.ts"
      provides: "getQueueStats server action returning queued/sentToday/failedToday/nextScheduledFor/lastScheduledFor"
      contains: "getQueueStats"
    - path: "src/app/(dashboard)/messages/queue-stats-banner.tsx"
      provides: "Live-polling client banner for the Outbox tab"
      contains: "visibilityState"
    - path: "src/app/(dashboard)/messages/queue-stats-banner.test.tsx"
      provides: "RTL coverage for render, ETA computation, polling, and visibility-pause"
    - path: "src/app/(dashboard)/properties/bulk-sms-modal.test.tsx"
      provides: "RTL coverage for pacing default, unit conversion, skip default, validation, submit payload"
  key_links:
    - from: "bulk-sms-modal.tsx"
      to: "bulkQueueSms"
      via: "callAction with { templateCategory, paceSeconds, skipIfContacted }"
      pattern: "skipIfContacted"
    - from: "bulk-sms-modal.tsx (on open)"
      to: "countAlreadyContacted"
      via: "useEffect fetch when modal opens"
      pattern: "countAlreadyContacted"
    - from: "cockpit-view.tsx (Outbox tab)"
      to: "queue-stats-banner.tsx"
      via: "<QueueStatsBanner initialStats={...} /> rendered above <QueuePanel>"
      pattern: "QueueStatsBanner"
    - from: "page.tsx Promise.all"
      to: "getQueueStats"
      via: "initial fetch so first paint has stats"
      pattern: "getQueueStats"
---

<objective>
Ship three durable improvements to the bulk SMS workflow so Jarrad can queue ~2,509 first-touch messages and watch them drain:

1. Pacing input on the Bulk SMS modal (`[number] [seconds|minutes ▾]`, default 18s) so the operator picks the drain rate per run instead of relying on a hardcoded constant.
2. "Skip prospects already contacted (N)" checkbox on the Bulk SMS modal, defaulting to ON for >50 selections, that excludes any property that already has an outbound message.
3. Live queue stats banner above the Outbox table on `/messages?tab=outbox` showing queued / sent today / failed today / next release time / drain ETA, refreshing every 30s while visible.

Purpose: turn a one-off shell-script outreach into a repeatable in-app workflow with operator-controlled pacing and progress visibility.

Output: extended `bulkQueueSms` + new `countAlreadyContacted` + new `getQueueStats` server actions; modal UI extensions; new live-polling stats banner; full RTL test coverage.
</objective>

<execution_context>
@/Users/jarradhenry/Sites/Sandra/.claude/get-shit-done/workflows/execute-plan.md
@/Users/jarradhenry/Sites/Sandra/.claude/get-shit-done/templates/summary.md
</execution_context>

<context>
@.planning/STATE.md
@/Users/jarradhenry/.claude/plans/ready-with-my-real-harmonic-emerson.md

# Read-only references — already in plan, do not modify
@src/app/(dashboard)/properties/actions.ts
@src/app/(dashboard)/properties/bulk-sms-modal.tsx
@src/app/(dashboard)/messages/actions.ts
@src/app/(dashboard)/messages/page.tsx
@src/app/(dashboard)/messages/cockpit-view.tsx
@src/app/(dashboard)/messages/queue-panel.tsx
@src/lib/messaging/send.ts

<interfaces>
<!-- Existing contracts the executor will extend or consume. Verified against the codebase. -->

From src/lib/errors/result.ts:
```typescript
export type Result<T> =
  | { ok: true; data: T }
  | { ok: false; error: { code: string; message: string } };
export function ok<T>(data: T): Result<T>;
export function errFromUnknown(e: unknown, code: string): Result<never>;
```

From src/app/(dashboard)/properties/actions.ts (current signature — being extended):
```typescript
export async function bulkQueueSms(
  propertyIds: string[],
  opts: {
    body?: string;
    templateCategory?: string;
    paceSeconds?: number;
    // skipIfContacted?: boolean;  ← Task 1 adds this
  },
): Promise<Result<BulkSmsOutcome>>;

export type BulkSmsOutcome = {
  succeeded: number;
  skipped: number;
  failed: { propertyId: string; message: string }[];
};
```

From src/app/(dashboard)/messages/cockpit-view.tsx (current Props):
```typescript
type Props = {
  activeTab: "inbox" | "outbox";
  filter: InboxFilter;
  threads: Thread[];
  queued: QueuedRow[];
  threadDetail: InboxDetailData | null;
  unknownSenders: UnknownSender[];
  unknownActiveCount: number;
  assigneeEmails: Record<string, string>;
  currentUserId: string | null;
  // queueStats: QueueStats;  ← Task 3 adds this
};
```

From src/app/(dashboard)/messages/queue-panel.tsx — `QueuedRow` already exported; banner sits above the existing `<QueuePanel>` element.

From src/app/(dashboard)/messages/page.tsx line 66 — existing `Promise.all` block where `getQueueStats()` will join.

Test convention (verified by listing existing files): sibling `.test.tsx` / `.test.ts` files alongside the source — NOT `__tests__/` subdirs. The existing extension target is `src/app/(dashboard)/properties/actions.bulk-sms.integration.test.ts`.
</interfaces>
</context>

<tasks>

<task type="auto" tdd="true">
  <name>Task 1: Server actions — skipIfContacted opt + countAlreadyContacted + getQueueStats</name>
  <files>
    src/app/(dashboard)/properties/actions.ts,
    src/app/(dashboard)/properties/actions.bulk-sms.integration.test.ts,
    src/app/(dashboard)/messages/actions.ts,
    src/app/(dashboard)/messages/actions.queue-stats.test.ts
  </files>
  <behavior>
    properties/actions.ts — bulkQueueSms (extended):
      - opts gains optional `skipIfContacted?: boolean`
      - When `skipIfContacted === true`, before the existing consent check, query `messages` for any row where `property_id = propertyId AND direction = 'outbound'` (limit 1). If a row exists, increment `skipped` and `continue` BEFORE consent and template work.
      - When `skipIfContacted` is falsy/absent, behavior is identical to today (no extra query, no scope reduction).
      - All existing checks (no homeowner_contact_id, opted_out, no phone, template pool) remain in place and run in their current order otherwise.

    properties/actions.ts — countAlreadyContacted (NEW):
      - Signature: `countAlreadyContacted(propertyIds: string[]): Promise<Result<number>>`
      - Selects `property_id` from `messages` where `property_id IN (propertyIds)` AND `direction = 'outbound'`.
      - Returns `ok(distinctCount)` where `distinctCount` is the size of `new Set(rows.map(r => r.property_id))`.
      - Returns `{ ok: false, error: { code: 'COUNT_CONTACTED_FAILED', message } }` on supabase error.
      - Empty `propertyIds` short-circuits to `ok(0)` without a DB call.

    messages/actions.ts — getQueueStats (NEW):
      - Signature: `getQueueStats(): Promise<Result<{ queued: number; sentToday: number; failedToday: number; nextScheduledFor: string | null; lastScheduledFor: string | null }>>`
      - Computes `todayStart` as the start of the current UTC day (`new Date(); setUTCHours(0,0,0,0)`).
      - Five aggregates against `messages`:
          1. `queued` = count where `status = 'queued'`
          2. `sentToday` = count where `status = 'sent'` AND `created_at >= todayStart`
          3. `failedToday` = count where `status = 'failed'` AND `updated_at >= todayStart`
          4. `nextScheduledFor` = min(`scheduled_for`) where `status = 'queued'` (null if no queued rows)
          5. `lastScheduledFor` = max(`scheduled_for`) where `status = 'queued'` (null if no queued rows)
      - Use Supabase head+count requests for the three counts (`select('*', { count: 'exact', head: true })`).
      - For min/max use `.order('scheduled_for', { ascending: true/false }).limit(1)`.
      - Returns `{ ok: false, error: { code: 'QUEUE_STATS_FAILED', message } }` on any supabase error.

    Tests — properties/actions.bulk-sms.integration.test.ts (extend existing file):
      - "skipIfContacted=true skips a property that has a prior outbound message and queues the rest"
      - "skipIfContacted=false (or omitted) queues all eligible prospects regardless of prior messages (current behavior preserved)"
      - "countAlreadyContacted returns the distinct property count from prior outbound messages"
      - "countAlreadyContacted returns 0 for empty propertyIds without hitting the DB"

    Tests — messages/actions.queue-stats.test.ts (NEW sibling test file, matches convention):
      - "getQueueStats returns 0/0/0/null/null when no messages exist"
      - "queued counts only status='queued' rows"
      - "sentToday counts only status='sent' rows with created_at >= todayStart UTC"
      - "failedToday counts only status='failed' rows with updated_at >= todayStart UTC"
      - "nextScheduledFor / lastScheduledFor return min/max scheduled_for of queued rows"
      - "supabase error in any sub-query surfaces as { ok: false, code: 'QUEUE_STATS_FAILED' }"
  </behavior>
  <action>
    AGENTS.md gate: run `ls node_modules/next/dist/docs/ 2>/dev/null` first. If files exist, scan for any guidance on server actions / `"use server"` semantics relevant to this Next.js version before writing code. Do NOT assume training-data Next.js patterns.

    1. RED — write the test cases first.
       - Extend `src/app/(dashboard)/properties/actions.bulk-sms.integration.test.ts` with the four bulk-sms cases above. Mirror the existing mock setup in that file (do not invent a new mocking style).
       - Create `src/app/(dashboard)/messages/actions.queue-stats.test.ts` as a sibling to `actions.ts` (per existing convention — no __tests__/ dir). Mock `@/lib/supabase/server` `createClient` the same way the existing properties integration test does.
       - Run `npm test -- bulk-sms.integration` and `npm test -- queue-stats` and confirm RED (new cases fail because functionality is missing). Commit: `test(260504-tgq): add failing tests for skipIfContacted, countAlreadyContacted, getQueueStats`.

    2. GREEN — implement minimally.
       - In `properties/actions.ts`:
         a. Add `skipIfContacted?: boolean` to the `opts` parameter type on `bulkQueueSms` (around line 60-64).
         b. Inside the per-prospect loop, immediately AFTER the `propertyMap.get` / `homeowner_contact_id` guard (around line 102) and BEFORE the `getConsentState` call (around line 103), insert the skip-contacted block exactly as specified in the locked plan:
            ```ts
            if (opts.skipIfContacted) {
              const { data: prior } = await supabase
                .from("messages")
                .select("id")
                .eq("property_id", propertyId)
                .eq("direction", "outbound")
                .limit(1);
              if (prior && prior.length > 0) {
                skipped++;
                continue;
              }
            }
            ```
         c. Append `countAlreadyContacted` as a new exported `"use server"` function at the bottom of the file. Use the same `createClient` / `ok` / `errFromUnknown` / `reportError` patterns the rest of the file uses. Short-circuit on empty `propertyIds`.
       - In `messages/actions.ts`:
         a. Append `getQueueStats` as a new exported function at the bottom. Use `createClient` from `@/lib/supabase/server` (matches existing imports). Use `select('*', { count: 'exact', head: true })` for the three counts and `.order(...).limit(1)` for the min/max queries.
         b. Wrap the body in try/catch and call `reportError(e, { tags: { surface: 'get_queue_stats' } })` on catch (matches the existing error-reporting pattern in this file).
       - Run the tests again and confirm GREEN. Commit: `feat(260504-tgq): implement skipIfContacted opt + countAlreadyContacted + getQueueStats`.

    3. Type-check: `npx tsc --noEmit` must be clean. If it isn't, fix before moving on.
  </action>
  <verify>
    <automated>npm test -- bulk-sms.integration queue-stats &amp;&amp; npx tsc --noEmit</automated>
  </verify>
  <done>
    - `bulkQueueSms` accepts `skipIfContacted` and skips prior-contacted properties when true.
    - `countAlreadyContacted(propertyIds)` exported and returns distinct count.
    - `getQueueStats()` exported and returns the five-field stats object.
    - All new + existing tests in the two test files pass; tsc clean.
    - Two atomic commits (RED then GREEN) recorded.
  </done>
</task>

<task type="auto" tdd="true">
  <name>Task 2: Bulk SMS modal — pacing input + skip-contacted checkbox + count fetch</name>
  <files>
    src/app/(dashboard)/properties/bulk-sms-modal.tsx,
    src/app/(dashboard)/properties/bulk-sms-modal.test.tsx
  </files>
  <behavior>
    bulk-sms-modal.tsx UI additions (between the existing template-category section and the footer):

    1. Pacing field — labeled "Pacing":
       - State: `paceValue: number` (default `18`), `paceUnit: 'seconds' | 'minutes'` (default `'seconds'`).
       - Renders a `type="number"` input (min=1) for the value and a `<select>` with two options (`seconds`, `minutes`) for the unit. Per the human-readable-UI rule this is `[number] [seconds|minutes ▾]` — never raw seconds.
       - Helper function `resolvePaceSeconds(value, unit)` returns `value * (unit === 'minutes' ? 60 : 1)`.
       - Validation: resolved seconds must be >= 10 and <= 600. When out of range, render an inline error directly under the field AND block submit (do not call `bulkQueueSms`).
       - Helper text below the field reads: `"Messages release at <X>-second intervals. Cron drains the queue honoring quiet hours."` where `<X>` is the resolved seconds value, recomputed on every render.

    2. Skip-contacted checkbox — labeled `"Skip prospects already contacted (N)"`:
       - State: `skipContacted: boolean`. Default initialized from `propertyIds.length > 50`.
       - State: `contactedCount: number | null` (null while loading, number once fetched).
       - When the modal opens (existing `useEffect` block already keyed on `[open]`), in addition to the existing `listSmsTemplateCategories` call, fire `countAlreadyContacted(propertyIds)` and store the result in `contactedCount`. While `null`, show the label as `"Skip prospects already contacted (…)"`; once loaded, render the actual number.
       - Re-fetch when `propertyIds` reference changes (add `propertyIds` to the dep list — be careful not to re-fetch on every parent re-render; the parent already passes a stable array reference per the existing pattern, but if it does not, memoize in the parent OR derive a stable key like `propertyIds.join(',')`).

    3. Submit handler:
       - Modify the existing `opts` object construction to always include both new fields:
         ```ts
         const opts = mode === 'category'
           ? { templateCategory: selectedCategory, paceSeconds: resolvePaceSeconds(paceValue, paceUnit), skipIfContacted: skipContacted }
           : { body: customBody.trim(), paceSeconds: resolvePaceSeconds(paceValue, paceUnit), skipIfContacted: skipContacted };
         ```
       - Add a guard at the top of `handleSend` that returns early (with `toast.error('Pacing must be between 10 seconds and 10 minutes.')`) if validation fails.

    Tests — bulk-sms-modal.test.tsx (NEW sibling test file, follows the convention used by `prospects-table.test.tsx`):

      Mock `./actions` so `bulkQueueSms`, `listSmsTemplateCategories`, and `countAlreadyContacted` are jest mocks. Mock `sonner` `toast` like the existing tests do.

      Cases:
      - "Pacing input defaults to 18 with seconds unit"
      - "Selecting 'minutes' and entering 5 submits paceSeconds=300"
      - "Pacing of 5 seconds shows inline validation error and submit does not call bulkQueueSms"
      - "Pacing of 11 minutes shows inline validation error and submit does not call bulkQueueSms"
      - "Skip-contacted checkbox is checked by default when propertyIds.length is 51"
      - "Skip-contacted checkbox is unchecked by default when propertyIds.length is 50"
      - "Modal open fires countAlreadyContacted with the given propertyIds and renders the returned count in the checkbox label"
      - "Submit passes paceSeconds AND skipIfContacted to bulkQueueSms"
      - "Helper text reflects current pace value (e.g. '5-second intervals' when paceValue=5, '300-second intervals' when 5 minutes)"
  </behavior>
  <action>
    AGENTS.md gate: this file is a `"use client"` component. Before relying on training-data React/Next patterns for client components, scan `node_modules/next/dist/docs/` for any version-specific guidance on client components / hooks. Heed deprecation notices.

    1. RED:
       - Create `src/app/(dashboard)/properties/bulk-sms-modal.test.tsx` with all nine cases above. Use `@testing-library/react` + the existing test setup conventions in `prospects-table.test.tsx` (read that file once before writing to match imports, render helpers, and mock style — do not re-read after).
       - Run `npm test -- bulk-sms-modal.test` and confirm RED (file does not yet have pacing/skip features).
       - Commit: `test(260504-tgq): add failing tests for bulk SMS modal pacing + skip-contacted`.

    2. GREEN:
       - Add the new state hooks (`paceValue`, `paceUnit`, `skipContacted`, `contactedCount`).
       - Add `resolvePaceSeconds` helper as a top-level function in the file (NOT inside the component).
       - In the existing `useEffect` keyed on `[open]`, add the `countAlreadyContacted(propertyIds)` call. Update the dep list — use `propertyIds.join(',')` as a stable key in deps to avoid stale-array re-fetch loops (or wrap in `useMemo` of join'd key).
       - Add the pacing field + skip checkbox JSX between the existing template-category section and the `<DialogFooter>`. Match the existing styling (the file uses `space-y-4 py-2` containers and `border` / `rounded-md` / `text-sm` Tailwind utilities — keep the same palette).
       - Update `handleSend` to compute resolved pace, run validation, surface inline error + early return on failure, and pass both new fields into `bulkQueueSms`.
       - Run `npm test -- bulk-sms-modal.test` and confirm GREEN.
       - Commit: `feat(260504-tgq): bulk SMS modal pacing input + skip-contacted checkbox`.

    3. `npx tsc --noEmit` must remain clean.
  </action>
  <verify>
    <automated>npm test -- bulk-sms-modal.test &amp;&amp; npx tsc --noEmit</automated>
  </verify>
  <done>
    - Modal renders pacing input (18/seconds default), unit dropdown, helper text, and skip-contacted checkbox with live count.
    - Out-of-range pacing blocks submit and shows inline error.
    - Submit payload includes `paceSeconds` and `skipIfContacted`.
    - Two atomic commits (RED then GREEN); all tests pass; tsc clean.
  </done>
</task>

<task type="auto" tdd="true">
  <name>Task 3: Outbox stats banner — new component + cockpit insert + initial fetch</name>
  <files>
    src/app/(dashboard)/messages/queue-stats-banner.tsx,
    src/app/(dashboard)/messages/queue-stats-banner.test.tsx,
    src/app/(dashboard)/messages/cockpit-view.tsx,
    src/app/(dashboard)/messages/page.tsx
  </files>
  <behavior>
    queue-stats-banner.tsx (NEW client component):
      - `"use client"` directive at top.
      - Props: `{ initialStats: QueueStats }` where `QueueStats` is the return shape of `getQueueStats` (export the type from messages/actions.ts in Task 1's GREEN step if it isn't already; if not, declare locally and keep in sync).
      - State: `stats: QueueStats` initialized from props.
      - `useEffect` sets up a 30s interval that calls `getQueueStats()` and updates state ONLY when `document.visibilityState === 'visible'`.
      - Also subscribes to `document` `visibilitychange`: when the doc becomes visible, fire one immediate refresh (so a tab returning from background catches up without waiting up to 30s).
      - Cleanup: clear interval and remove visibilitychange listener on unmount.
      - Render:
        - Top row: `"<queued> queued · <sentToday> sent today · <failedToday> failed today"`.
        - Bottom row: `"Next release: <relative> · drain ETA: <humanized>"`.
        - "Next release" relative is computed from `nextScheduledFor`: if null → `"none queued"`; if past → `"now"`; else `"in <N>s"` for <60s, `"in <N>m"` otherwise.
        - "Drain ETA" computed from `lastScheduledFor`: if null → `"—"`; else `humanizeDuration(lastScheduledFor - now)` formatted like `"12h 32m"` (hours+minutes; if <1h render `"<N>m"`; if <1m render `"<1m"`).
        - Container: bordered card matching the existing Sandra warm-paper theme used elsewhere on `/messages` (e.g., `rounded-xl border bg-card p-4` or whatever the existing `QueuePanel` uses — read once and match).

    cockpit-view.tsx changes:
      - Import `QueueStatsBanner` and the `QueueStats` type.
      - Add `queueStats: QueueStats` to `Props`.
      - Inside the Outbox `<TabsContent value="outbox">`, render `<QueueStatsBanner initialStats={queueStats} />` directly above the existing `<QueuePanel>`. No other Outbox layout changes.

    page.tsx changes:
      - Import `getQueueStats` from `./actions`.
      - Add `getQueueStats()` to the existing `Promise.all` block (around line 66-85). Destructure into `queueStatsResult`.
      - After the Promise.all, derive `queueStats = queueStatsResult.ok ? queueStatsResult.data : { queued: 0, sentToday: 0, failedToday: 0, nextScheduledFor: null, lastScheduledFor: null }` (graceful default — the banner still renders, polling will retry).
      - Pass `queueStats={queueStats}` to `<CockpitView>`.

    Tests — queue-stats-banner.test.tsx (NEW sibling test file):
      Mock `../actions` so `getQueueStats` is a jest mock returning a controllable Result. Use `jest.useFakeTimers()` and `act` to advance time. Use `Object.defineProperty(document, 'visibilityState', { value, configurable: true })` + `document.dispatchEvent(new Event('visibilitychange'))` to simulate visibility transitions.

      Cases:
      - "Renders queued / sent today / failed today counts from initialStats"
      - "Renders 'none queued' when nextScheduledFor is null"
      - "Renders 'in Xs' / 'in Xm' relative time for nextScheduledFor in the future"
      - "Renders drain ETA as 'Xh Ym' when lastScheduledFor is hours away"
      - "Polls getQueueStats every 30s when document is visible (advance 30s twice → 2 calls)"
      - "Does NOT poll while document is hidden"
      - "Fires one immediate refresh when document transitions hidden → visible"
      - "Clears interval and removes visibilitychange listener on unmount"
  </behavior>
  <action>
    AGENTS.md gate: this is a Next.js client component being inserted into a server-component page; type alignment between server-action return + client-component prop matters. Before writing, scan `node_modules/next/dist/docs/` for any version-specific guidance on passing data from server pages to client components in this Next version. Heed deprecation notices.

    1. RED:
       - Create `src/app/(dashboard)/messages/queue-stats-banner.test.tsx` with all eight cases. Read `src/app/(dashboard)/messages/cockpit-view.test.tsx` once for the existing test bootstrap conventions, then write.
       - Run `npm test -- queue-stats-banner.test` and confirm RED.
       - Commit: `test(260504-tgq): add failing tests for queue stats banner`.

    2. GREEN:
       - Create `queue-stats-banner.tsx` implementing the contract above. Keep the visibility/interval logic small and pure — no useReducer, no extra abstractions.
       - Modify `cockpit-view.tsx`: import + add to Props + render in the Outbox TabsContent above `<QueuePanel>`. Touch nothing else.
       - Modify `page.tsx`: add `getQueueStats()` into the existing `Promise.all`, derive `queueStats` with safe fallback, pass into `<CockpitView>`.
       - If `cockpit-view.test.tsx` or `cockpit-shell.test.tsx` break because the new required `queueStats` prop is missing, fix the existing tests by adding a default `queueStats` fixture — do not regress existing coverage.
       - Run full test suite for the messages dir: `npm test -- src/app/\(dashboard\)/messages` and confirm GREEN.
       - Commit: `feat(260504-tgq): live queue stats banner on Outbox tab`.

    3. `npx tsc --noEmit` clean.

    4. Final phase-level verification:
       - `npm test` (full suite) passes.
       - `npx tsc --noEmit` clean.
       - `npm run lint` clean (or current project equivalent — match the existing `package.json` scripts).
  </action>
  <verify>
    <automated>npm test -- src/app/\(dashboard\)/messages &amp;&amp; npx tsc --noEmit &amp;&amp; npm test</automated>
  </verify>
  <done>
    - `/messages?tab=outbox` server-renders the banner with first-paint stats from `getQueueStats`.
    - Banner refreshes every 30s while visible; pauses when hidden; immediately refreshes on becoming visible.
    - Cockpit + page wiring complete; existing tests still pass.
    - Two atomic commits (RED then GREEN); full `npm test` + `tsc` + `lint` clean.
  </done>
</task>

</tasks>

<verification>
End-to-end automated verification:
- `npm test` — all suites pass, including the four new/extended test files.
- `npx tsc --noEmit` — clean.
- `npm run lint` — clean.

Manual smoke (deferred to Jarrad after merge — NOT part of this plan):
- `/properties` → select 1 prospect → open Bulk SMS → confirm pacing input renders at `[18] [seconds ▾]` and skip-contacted shows live count.
- Set `[60] [seconds]` → check skip-contacted → queue → confirm `messages` row has `scheduled_for ≈ now + 60s` and toast shows succeeded/skipped.
- `/messages?tab=outbox` → confirm stats banner renders above the queue table; wait 30s → confirm Network tab shows the poll fire.
</verification>

<success_criteria>
- Three atomic commit pairs (test → implementation) per task = 6 commits across the three tasks.
- Zero changes to: opt-out / consent / phone-existence checks in `bulkQueueSms`; `SELECT_ALL_HARD_CAP`; any migration; any other route or component.
- Pacing UI is human-readable per the user's locked rule (number + unit dropdown, never raw seconds).
- Skip-contacted defaults follow the >50 / ≤50 split exactly.
- Stats banner polls only when visible (battery + network respect).
- Tests live as siblings of the source they cover (matches existing convention; no new __tests__/ subdirs).
</success_criteria>

<output>
After completion, create `.planning/quick/260504-tgq-bulk-sms-modal-pacing-input-skip-contact/260504-tgq-SUMMARY.md` documenting:
- Commits shipped (6 total across 3 tasks).
- Final test counts added to each touched test file.
- Any deviations from the locked plan (should be none — flag if any emerged during implementation).
- Manual verification checklist for Jarrad to run before launching the 2,509-prospect outreach.
</output>
