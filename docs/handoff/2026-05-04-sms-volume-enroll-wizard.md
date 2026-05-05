# Session Handoff: SMS Volume — Enroll Batch + Import Wizard + AI Responder Fix

**Date:** 2026-05-04 (session 2)  
**Branch:** main (all changes unstaged/untracked — nothing committed yet)  
**Prod URL:** https://sandra-sooty.vercel.app

---

## Current state

Continuing the SMS volume feature from `docs/handoff/2026-05-04-sms-volume-pool-opener.md`. Library layer + tests + import wizard are now done. Two layers remain: bulk send and cron drain.

Working tree:
- **Modified:** `src/app/(dashboard)/import/actions.ts` — `sequenceId` threaded to workflow
- **Modified:** `src/app/(dashboard)/import/steps/step-confirm.tsx` — sequence picker added
- **Modified:** `src/app/(dashboard)/import/wizard.tsx` — `sequenceId` in WizardState + reducer
- **Modified:** `src/app/api/cron/sequence-tick/route.ts` — org_id added to enrollment select (from session 1)
- **Modified:** `src/lib/ai-responder/classify.ts` — consent gate relaxed (see bug fix below)
- **Modified:** `src/lib/ai-responder/classify.test.ts` — tests updated for relaxed gate
- **Modified:** `src/lib/messaging/send.ts` — scheduledFor added to SendSmsInput (session 1)
- **Modified:** `src/lib/sequences/tick.ts` — template_category + pickFromPool (session 1)
- **Modified:** `src/lib/supabase/types.ts` — scheduled_for + template_category (session 1)
- **Modified:** `src/workflows/csv-import.ts` — `enrollJobBatch` + `enrollInSequenceStep` + `sequenceId` param
- **Untracked:** `docs/handoff/2026-05-04-sms-volume-pool-opener.md` (session 1 handoff)
- **Untracked:** `src/lib/templates/pool.test.ts` — 8 unit tests, all green
- **Untracked:** `src/lib/templates/pool.ts` — `pickFromPool` utility (session 1)
- **Untracked:** `src/workflows/csv-import.enroll.integration.test.ts` — 5 integration tests, all green
- **Untracked:** `supabase/migrations/041_template_category_and_message_scheduling.sql`
- **Untracked:** `supabase/migrations/042_seed_opener_templates.sql`

TypeScript passes clean (`pnpm tsc --noEmit` exits 0).

---

## What shipped this session

Nothing committed yet. All changes in working tree.

---

## Key infrastructure changes

### New: `enrollJobBatch` + `enrollInSequenceStep` in `src/workflows/csv-import.ts`
- Exported `enrollJobBatch(supabase, { jobId, sequenceId }): Promise<EnrollBatchResult>` — queries `job_items` for `status='success'` rows, calls `enrollLead()` per property, returns `{ enrolled, skipped, failed }`
- `enrollInSequenceStep` wraps it as a workflow step (fires after `recordConsentStep` when `params.sequenceId` is set)
- `CsvImportWorkflowParams` gains `sequenceId?: string | null`

### Bug fix: `job_items.status` — `"success"` not `"succeeded"`
- **CRITICAL:** `recordConsentStep` and the new `enrollJobBatch` were both querying `.eq("status", "succeeded")` — the constraint only allows `'success'`. This means `recordConsentStep` was silently recording consent for NO contacts in every import. Fixed in this session (both now use `"success"`).

### Bug fix: AI responder consent gate
- `src/lib/ai-responder/classify.ts` — gate changed from `consentState !== "can_send_marketing"` → `consentState === "opted_out"`. Cold outreach contacts (no consent events) were getting silently skipped by the AI responder. With the outbound consent gate already removed, this was a mismatch — fixed.

### Import wizard: sequence picker
- `wizard.tsx` — `sequenceId: string | null` in `WizardState`, `SET_SEQUENCE_ID` action, reducer case; `SET_SMS_CONSENT` resets `sequenceId` to null when unchecked
- `step-confirm.tsx` — sequence picker `<select>` below consent checkbox, renders only when `smsConsent=true`, loads active non-archived sequences via `listSequences()` on mount
- `actions.ts` — `sequenceId` in `CreateImportJobParams`, threaded to workflow `start()`

---

## Memory updates

No memory files written this session. Consider adding:
- Update `project_bmh_crm_architecture.md` with SMS volume feature progress

---

## What's in flight (pick up here)

### 1. Bulk send from prospects table

**Goal:** Bulk SMS action on `/properties` prospects-table — select N rows, pick a template pool, queue paced messages.

Files to create/modify:
- `src/app/(dashboard)/properties/actions.ts` — add `bulkQueueSms(propertyIds, { templateCategory?, templateId?, body?, paceSeconds = 18 })`
  - Per property: load homeowner contact + phone, render template (via `renderTemplate` + `loadTemplateVars`), call `sendSmsToContact({ queueOnly: true, scheduledFor: new Date(now + i * paceSeconds * 1000) })`
  - Skip `opted_out` contacts
  - Returns `BulkOutcome { succeeded, skipped, failed }` (mirror `applyTagBulk` shape at line 549)
- `src/app/(dashboard)/properties/bulk-sms-modal.tsx` (NEW) — modal with pool dropdown (lists `sms_templates.category` values + count) + Send button
- `src/app/(dashboard)/properties/prospects-table.tsx` — add "Bulk SMS" button to existing bulk action toolbar

### 2. Cron drain of scheduled queued messages

**Goal:** `sequence-tick` cron also releases queued messages where `scheduled_for <= now()`.

File to modify: `src/app/api/cron/sequence-tick/route.ts`

Inside `runSequenceTick()`, after the enrollment processing loop, add:
```typescript
// Drain scheduled queued messages
const { data: dueMessages } = await supabase
  .from("messages")
  .select("id")
  .eq("status", "queued")
  .lte("scheduled_for", nowIso)
  .not("scheduled_for", "is", null)
  .limit(50);

for (const msg of dueMessages ?? []) {
  await releaseQueuedMessage(supabase, msg.id);
}
```

Import `releaseQueuedMessage` from `@/lib/messaging/send`.

### 3. Tests still needed (TDD — write before implementation)

- `src/app/(dashboard)/properties/actions.bulk-sms.test.ts` — bulk queue tests
- `src/app/api/cron/sequence-tick/route.queue.test.ts` — cron drain tests

---

## Known not-done

- All changes still uncommitted — will need one PR for the full SMS volume feature
- Pool unit tests written and green, enroll integration tests written and green
- Bulk send UI + action not started
- Cron drain not started

---

## Test credentials

- Jarrad's test phone: **+13107540662** — for SMS smoke tests only, never real leads
- Twilio test receiver: **+18148097074** — inbound-only canary, never a sender
- Prod org name: `BMH Group` (used in migration 042 seed lookup)

---

## Verification scripts

```bash
# 1. Check all modified/untracked files are present
git status

# 2. Type check
pnpm tsc --noEmit

# 3. Run pool unit tests
pnpm test src/lib/templates/pool.test.ts

# 4. Run enroll integration tests
npx vitest run --config vitest.integration.config.ts src/workflows/csv-import.enroll.integration.test.ts

# 5. Run classify unit tests (AI responder gate fix)
pnpm test src/lib/ai-responder/classify.test.ts
```

---

## Critical learnings

1. **`job_items.status` is `'success'` not `'succeeded'`** — The initial migration (`001_initial.sql`) defines the constraint as `status in ('pending','success','no_match','error','skipped')`. Never use `"succeeded"`. This was a silent bug that caused consent recording to silently no-op for every import.

2. **AI responder consent gate vs outbound gate mismatch** — When the outbound consent gate was removed (`feat(sms): remove consent gate`), the AI responder's `classifyAiSkip` gate was not updated. Cold outreach contacts with no consent events had the AI responder silently skip every inbound reply. Gate is now `opted_out`-only.

3. **`jobs.type` is required** — When seeding `jobs` in integration tests, `type` has no default and is NOT nullable. Must pass e.g. `type: "csv_import"`. Test error message is generic "job seed failed" — add error propagation to seed helpers.

4. **`jobs.status` check constraint** — Valid values (from migration 021): `'pending_approval'`, `'queued'`, `'running'`, `'completed'`, `'failed'`. Not `'succeeded'`.

5. **Integration tests must be `*.integration.test.ts`** — The `@tests` path alias and the real Supabase connection are only wired up in `vitest.integration.config.ts`, which uses the glob `src/**/*.integration.test.ts`. Plain `*.test.ts` names won't resolve `@tests/integration/client`.

6. **Real reply arrived** — Debra Ulberg at 811 NW Heatherwood DR, Kansas City MO replied "What is BMH" about 1h after the opener blast. Thread is at `/messages?thread=4807d5ff-4a69-4b03-8985-a4a7840bbec8`. AI responder was silently skipping (no_consent); fix deployed will handle future replies.
