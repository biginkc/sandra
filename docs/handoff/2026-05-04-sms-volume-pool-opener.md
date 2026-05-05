# Session Handoff: SMS Volume — Template Pool + Auto-Enroll + Bulk Send

**Date:** 2026-05-04  
**Branch:** main (all changes unstaged/untracked — nothing committed yet)  
**Prod URL:** https://sandra-sooty.vercel.app

---

## Current state

Mid-implementation of a three-part SMS volume feature. Nothing committed yet. The core library layer is done; the UI + workflow + cron layers are not.

Working tree:
- **Modified:** `src/app/api/cron/sequence-tick/route.ts` (added org_id to enrollment select)
- **Modified:** `src/lib/messaging/send.ts` (added scheduledFor to SendSmsInput + queueForLater INSERT)
- **Modified:** `src/lib/sequences/tick.ts` (added org_id to EnrollmentRow, template_category to step select + resolution branch, pickFromPool import)
- **Modified:** `src/lib/supabase/types.ts` (added scheduled_for to messages, template_category to sequence_steps)
- **Untracked:** `src/lib/templates/pool.ts` (new pickFromPool utility)
- **Untracked:** `supabase/migrations/041_template_category_and_message_scheduling.sql`
- **Untracked:** `supabase/migrations/042_seed_opener_templates.sql`

TypeScript passes clean (`pnpm tsc --noEmit` exits 0).

---

## What shipped this session

Nothing merged/committed yet. All changes are in working tree. Commit as one PR at the end.

---

## Key infrastructure changes

### Migration 041: `supabase/migrations/041_template_category_and_message_scheduling.sql`
- `sequence_steps` gains `template_category text` (nullable)
- XOR constraint updated: `send_sms` steps must have exactly one of `template_id`, `template_body`, OR `template_category`
- `messages` gains `scheduled_for timestamptz` (nullable)
- Partial index `idx_messages_queued_scheduled` on `messages(scheduled_for) WHERE status='queued'`

### Migration 042: `supabase/migrations/042_seed_opener_templates.sql`
- Inserts 15 opener templates for BMH Group with `category='Opener - Homeowner'`
- All are ownership-verification Touch-1 only — no sell/buy/offer/looking keywords
- Uses pipe-fallbacks: `{{first_name | there}}` etc.
- `ON CONFLICT (org_id, name) DO NOTHING` — idempotent

### New utility: `src/lib/templates/pool.ts`
- `pickFromPool(supabase, orgId, category, seed): Promise<PoolTemplate | null>`
- SHA-256 of seed → uint32 → mod pool size → deterministic index
- Pool sorted by `id` for stable ordering

### Modified: `src/lib/sequences/tick.ts`
- `EnrollmentRow` now includes `org_id: string`
- Step select now includes `template_category`
- Resolution block: `else if (step.template_category)` branch added before `else { template_body }`. Calls `pickFromPool(client, enrollment.org_id, step.template_category, enrollment.id)`. Pauses with `step_misconfigured` if pool is empty.

### Modified: `src/lib/messaging/send.ts`
- `SendSmsInput` gains `scheduledFor?: Date | null`
- `queueForLater` INSERT includes `scheduled_for: input.scheduledFor?.toISOString() ?? null`

### Modified: `src/app/api/cron/sequence-tick/route.ts`
- Enrollment select now includes `org_id`

---

## Memory updates

No memory files written this session (context ran short). Update these in next session:
- Add project memory: "SMS volume feature in flight — migrations 041+042, pool.ts done, wizard+bulk+cron pending"

---

## What's in flight (pick up here)

### 1. Import wizard — sequence selection on import

**Goal:** Add a sequence picker to the import Confirm step so newly imported consented contacts auto-enroll.

Files to modify:
- `src/app/(dashboard)/import/wizard.tsx:159-212` — add `sequenceId: string | null` to `WizardState`, reducer case `SET_SEQUENCE_ID`
- `src/app/(dashboard)/import/steps/step-confirm.tsx` — add sequence picker below SMS consent checkbox (only renders when `state.smsConsent === true`). Use existing `listSequences()` action for the dropdown.
- `src/app/(dashboard)/import/actions.ts` — `createImportJob()` accept `sequenceId`, thread to workflow params
- `src/workflows/csv-import.ts` — add `enrollInSequenceStep` AFTER `recordConsentStep`. Query `job_items` for succeeded propertyIds, loop `enrollLead()`, aggregate to `job.result_summary.sequence_enrollment_summary`

Key existing functions:
- `enrollLead()` at `src/lib/sequences/enrollment.ts:24`
- `recordConsentStep()` at `src/workflows/csv-import.ts:240` — mirror this pattern for `enrollInSequenceStep`
- `listSequences()` at `src/app/(dashboard)/sequences/actions.ts`

### 2. Bulk send from prospects table

**Goal:** Bulk SMS action on `/properties` prospects-table — select N rows, pick a template pool, queue paced messages.

Files to create/modify:
- `src/app/(dashboard)/properties/actions.ts` — add `bulkQueueSms(propertyIds, { templateCategory?, templateId?, body?, paceSeconds = 18 })`
  - Per property: load homeowner contact + phone, render template (via `renderTemplate` + `loadTemplateVars`), call `sendSmsToContact({ queueOnly: true, scheduledFor: new Date(now + i * paceSeconds * 1000) })`
  - Skip `opted_out` contacts
  - Returns `BulkOutcome { succeeded, skipped, failed }` (mirror `applyTagBulk` shape at line 549)
- `src/app/(dashboard)/properties/bulk-sms-modal.tsx` (NEW) — modal with pool dropdown (lists `sms_templates.category` values + count) + Send button
- `src/app/(dashboard)/properties/prospects-table.tsx` — add "Bulk SMS" button to existing bulk action toolbar

### 3. Cron drain of scheduled queued messages

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

### 4. Tests (TDD — write before or alongside implementation above)

Test files per the approved plan:
- `src/lib/templates/pool.test.ts` — unit tests for `pickFromPool`
- `src/lib/sequences/tick.pool.test.ts` — pool-aware tick integration tests
- `src/workflows/csv-import.enroll.test.ts` — auto-enroll integration tests
- `src/app/(dashboard)/properties/actions.bulk-sms.test.ts` — bulk queue tests
- `src/app/api/cron/sequence-tick/route.queue.test.ts` — cron drain tests

---

## Known not-done

- Pool unit tests (`pool.test.ts`) — not written yet
- Import wizard UI — not started
- Bulk send server action + modal + prospects-table button — not started
- Cron drain extension — not started
- Nothing committed or pushed yet

---

## Test credentials

- Jarrad's test phone: **+13107540662** — for SMS smoke tests only, never real leads
- Twilio test receiver: **+18148097074** — inbound-only canary, never a sender
- Prod org name: `BMH Group` (used in migration 042 seed lookup)

---

## Verification scripts

```bash
# 1. Check migrations exist
ls supabase/migrations/04{1,2}*

# 2. Type check
pnpm tsc --noEmit

# 3. After migrations applied via CI, check pool templates exist
# (use Supabase MCP on TEST project only, not prod):
# select name, category from sms_templates where category = 'Opener - Homeowner';

# 4. After full implementation, run tests
pnpm test src/lib/templates/pool.test.ts
pnpm test src/workflows/csv-import.enroll.test.ts
```

---

## Critical learnings

1. **Carrier filter list:** `docs/sms-templates.md` has the authoritative A2P 10DLC filter word list. Touch-1 openers MUST NOT contain: `interested, selling, offer, property, cash, local investor, purchase, looking, mortgage, loan, insurance, debt, lend, buy, buying, sell`. The 15 seeded templates comply. Any new opener templates must be audited against this list.

2. **Template category ≠ sequence category:** Existing seeded templates use `'Outreach - Homeowner'` for ALL homeowner templates (Touch 1 through 5). New opener pool uses a DISTINCT category `'Opener - Homeowner'` to avoid pool contamination from follow-up templates.

3. **Template seed is build-script managed:** `supabase/migrations/040_seed_bmh_sms_templates.sql` is auto-generated from `docs/sms-templates.md` via `scripts/build-sms-template-seed.ts`. Do NOT edit migration 040. New templates go in new migrations (042+).

4. **Migration numbering:** Latest migration before this session was `040_seed_bmh_sms_templates.sql`. This session added `041` and `042`. Next migration is `043`.

5. **Pipe fallbacks required on `first_name`:** `{{first_name | there}}` not bare `{{first_name}}` — cold lists have missing names and bare renders as "Hi ,".

6. **User vocabulary:** Jarrad uses "leads table" to mean the `/properties` prospects page, not the `/leads` Kanban. Bulk send UI lives on `prospects-table.tsx`.
