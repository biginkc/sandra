---
status: findings
phase: 01-sms-templates-v1
reviewed: 2026-04-29
depth: standard
files_reviewed: 21
diff_base: origin/main
findings:
  critical: 2
  warning: 13
  info: 9
  total: 24
---

# Phase 01: Code Review Report — SMS Templates v1

**Reviewed:** 2026-04-29
**Depth:** standard
**Files Reviewed:** 21
**Status:** issues_found

## Summary

The work delivers a competent slice — a clean Mustache-with-pipe-fallback engine, idiomatic Server Actions, and a well-structured templates UI. Tests cover the engine. The interpolation surface is small and free of `eval` / `innerHTML` / `dangerouslySetInnerHTML`, so injection risk into the React tree is low.

That said, the diff has **two BLOCKERS** in the data-loss / cross-tenant-leak category, plus a cluster of WARNINGS around migration idempotency, schema integrity (no inline-XOR-template DB constraint), silent data clobbering in the pickers, and the project-memory-flagged "useState mirror of server props" anti-pattern showing up again. RLS is on-pattern for this repo (every prior table uses `for all to authenticated using (true)`) but that pattern itself is the larger latent issue — flagged here so it's tracked, even if the fix is out of scope for V1.

Counts: **2 BLOCKER · 13 WARNING · 9 INFO**

---

## BLOCKERS

### BL-01: Migration 034 is not safely re-runnable — second apply will fail

**File:** `supabase/migrations/034_sms_templates.sql:17-25, 44-46`

`create table if not exists` is correctly idempotent, but the following four statements are not, and Postgres will throw `42P07` / `42710` if migration 034 runs twice (e.g. partial-apply recovery, supabase db reset against a stale state, replay of the migration in a branch DB):

```sql
create index idx_sms_templates_org ...           -- no IF NOT EXISTS
create index idx_sms_templates_category ...      -- no IF NOT EXISTS
create policy sms_templates_authenticated_all ...-- no IF NOT EXISTS (PG ≥ 14 supports this; older needs DROP first)
create trigger trg_sms_templates_updated_at ...  -- no OR REPLACE (PG ≥ 14 supports CREATE OR REPLACE TRIGGER)
```

Compare with the existing convention in 035 which uses `add column if not exists` and `create index if not exists`. The risk is concrete: the first PR-#70 deploy could partial-apply (e.g. the table created, the policy halfway through), and the next supabase db push fails on the index, leaving prod in a partly-migrated state until someone hand-repairs. Given the project memory explicitly calls out review focus #7 ("Idempotent? Reversible?"), this is a release-blocker.

**Fix:**
```sql
create index if not exists idx_sms_templates_org
  on public.sms_templates(org_id) where deleted_at is null;
create index if not exists idx_sms_templates_category
  on public.sms_templates(org_id, category) where deleted_at is null;

drop policy if exists sms_templates_authenticated_all on public.sms_templates;
create policy sms_templates_authenticated_all on public.sms_templates
  for all to authenticated using (true) with check (true);

drop trigger if exists trg_sms_templates_updated_at on public.sms_templates;
create trigger trg_sms_templates_updated_at
  before update on public.sms_templates
  for each row execute function public.set_updated_at();
```

---

### BL-02: Schema does not enforce inline-XOR-template on `sequence_steps` — data integrity relies entirely on JS

**File:** `supabase/migrations/035_sequence_step_template_ref.sql:13-15` (with corroborating logic at `src/app/(dashboard)/sequences/actions.ts:316-346` and `src/lib/sequences/tick.ts:159-187`)

Migration 035 adds `template_id` as a nullable FK and that's it. The only thing that prevents a row from having BOTH `template_body` populated AND `template_id` set is the comment in `upsertSequenceStep` and the JS branching that nulls one when the other is supplied. `tick.ts` then implements a **silent precedence rule**: "template_id wins over template_body" (line 160). That rule is invisible to anyone reading the schema.

Failure modes this enables today:
1. A direct SQL fix (`update sequence_steps set template_id = '...'`) on a row with existing `template_body` leaves both populated. The next tick fires the *template* and silently discards the inline copy the author thought was authoritative.
2. A future code path (bulk import? AI-generated step? scripts/* utility?) that doesn't know about the precedence rule will be free to write both.
3. The check that catches "neither populated" is only in `upsertSequenceStep` (`hasInline || hasRef`). A direct SQL insert with both null is permitted — `tick.ts:186` then renders `bodySource = ""` and tries to send an empty SMS, which the provider may accept and bill for, or reject silently into `provider_failed`.

**Fix:** Add a check constraint in 035 (or a follow-up 036) and a defense-in-depth NULL/empty guard in tick.ts.

```sql
alter table public.sequence_steps
  add constraint sequence_steps_send_sms_body_xor
  check (
    action_type <> 'send_sms'
    or (
      (template_id is not null and template_body is null)
      or (template_id is null and template_body is not null
          and length(trim(template_body)) > 0)
    )
  );
```

And in `tick.ts:186`:
```ts
} else {
  bodySource = step.template_body ?? "";
}
if (!bodySource.trim()) {
  await markRunSkipped(client, claim.id, "provider_failed");
  await pauseEnrollment(client, enrollment.id, "step_misconfigured", false);
  return { status: "paused", enrollmentId: enrollment.id, reason: "step_misconfigured" };
}
```

---

## WARNINGS

### WR-01: Authenticated-user RLS policy has no org scoping on `sms_templates`

**File:** `supabase/migrations/034_sms_templates.sql:23-25`

`for all to authenticated using (true) with check (true)` — every signed-in user can read, update, soft-delete, and insert any template in any org. Today this matches the rest of the codebase (`001_initial.sql` and every migration since), and per project memory the CRM is single-org with no prod users yet, so this is a deferred-multi-tenant risk rather than a today-shipping bug. **However**, when the eventual multi-org cutover happens, every table that follows this pattern needs migrating in lockstep, and `sms_templates` (which carries hand-written customer copy and is referenced by sequences that fire to specific contacts) is a higher-leverage leak than most.

**Fix (defer if multi-tenant is post-V1):** Track a follow-up migration that switches all `_authenticated_all` policies to `using (org_id in (select org_id from org_members where user_id = auth.uid()))`. At minimum add a TODO comment on this policy noting the deferred scope tightening so the next reviewer doesn't grandfather it.

---

### WR-02: `loadLeadVars` / `loadTemplateVars` bypasses RLS via service-role client after a single property-existence check

**File:** `src/app/(dashboard)/leads/actions.ts:1173-1220` (calling `src/lib/sequences/template-vars.ts:24-78`)

`loadLeadVars` queries `properties` once with the user's session client to confirm the row exists, then constructs `createAdminClient()` and hands it to `loadTemplateVars`, which uses that admin client to query `properties`, `contacts`, and `organizations` again — bypassing RLS entirely on the second pass. The reason is `auth.admin.getUserById` (template-vars.ts:90), which needs service role.

In a single-org world, the prefix property-existence check makes this acceptable. In a multi-org world, RLS would deny on the first check and short-circuit; today, the first check passes for any property the user can see, and then admin-client queries fan out and pull `contacts.first_name/last_name`, `organizations.name`, and `properties.address/city/state/zip/market` with no further authorization. If WR-01's policy ever tightens, this server action is the leak escape hatch.

**Fix:** Split the admin path so only the user-id resolution uses admin; everything else stays on the session client.
```ts
const propertyVars = await loadPropertyVars(supabase, ...);  // session client
const userFirstName = params.enrolledByUserId
  ? await resolveUserFirstName(adminClient, params.enrolledByUserId)
  : null;
return { ...propertyVars, my_first_name: userFirstName };
```

---

### WR-03: `template-picker` overwrites the user's typed reply without confirmation

**File:** `src/app/(dashboard)/leads/[id]/inline-reply.tsx:135-144`

`handleTemplateSelect` calls `setBody(...)` unconditionally. A VA typing a reply, then clicking "Templates" to peek at options, blows away their work the moment they click any template. There is no "Are you sure?" and no append-mode option.

**Fix:** Either prompt before overwrite when `body.trim().length > 0`, or change the semantics to insert-at-cursor (consistent with the dialog's variable picker behavior). Cheapest fix:
```ts
const handleTemplateSelect = (template: TemplateRow) => {
  if (body.trim() && !window.confirm("Replace your draft with this template?")) return;
  loadLeadVars(propertyId).then(...);
};
```

---

### WR-04: `template-picker` race — clicking template B before A's `loadLeadVars` resolves can leave B's text overwritten by A

**File:** `src/app/(dashboard)/leads/[id]/inline-reply.tsx:135-144`

`handleTemplateSelect` fires `loadLeadVars(propertyId)` per click and the resolved `setBody` callback has no guard against being stale. Two quick clicks → two in-flight requests; the slower one wins. Same anti-pattern fixed elsewhere in this file with the `cancelled` flag at line 47-57.

**Fix:** Add an effect-scoped or click-scoped cancellation token, or capture `template.id` in a ref and ignore stale resolutions whose template doesn't match the current one. A simpler fix: cache the vars (one fetch on mount, like `listFromNumbers`) and render synchronously.

---

### WR-05: `template-picker` swallows `listTemplates` errors and shows "No templates yet" forever

**File:** `src/app/(dashboard)/templates/template-picker.tsx:33-40`

```ts
listTemplates().then((result) => {
  if (result.ok) setTemplates(result.data);
  setLoaded(true);  // sets loaded=true even on the failure branch
});
```

If the action fails (network blip, RLS drift, expired session), the picker shows the empty-state copy with no surfaced error and `loaded=true` ensures it never retries. The user has no way to distinguish "no templates exist" from "fetch failed". No `toast.error`, no retry button.

**Fix:** Track an error state and render a "Couldn't load templates — retry" button. Also reset `loaded` after a configurable freshness window so re-opening the picker after creating a template in another tab gets the new entry.

---

### WR-06: `template-picker` cache never busts → deleted/edited templates remain visible until full page reload

**File:** `src/app/(dashboard)/templates/template-picker.tsx:33-40`

`loaded` is set true on first open and never reset. If a user (or a teammate) deletes a template, the picker keeps offering it; selecting it interpolates and inserts text from a now-deleted template. Worse: if the user picks a deleted template and sends, today's `sendSmsFromLead` doesn't re-validate against the templates table (it just sends the body), so this works — but it's now hard to audit "which template did this go through" since the row may be soft-deleted.

**Fix:** Either re-fetch on every open (cheap; templates are small), or invalidate the in-memory cache on a focus event / a template-mutation event. Cheapest:
```ts
useEffect(() => {
  if (open) {
    listTemplates().then(...);  // always refresh
  }
}, [open]);
```

---

### WR-07: `updateTemplate` skips the input validation that `createTemplate` enforces

**File:** `src/app/(dashboard)/templates/actions.ts:127-167`

`createTemplate` validates name presence, name length ≤120, and content presence before hitting the DB. `updateTemplate` does none of that — it just `.trim()`s and lets the DB CHECK constraints reject. That surfaces a raw Postgres error (`new row for relation "sms_templates" violates check constraint "sms_templates_name_check"`) to the toast via `error.message`. UX inconsistency, and the error string leaks the constraint name to the client.

**Fix:** Hoist the validation block out of `createTemplate` into a shared helper and run it in both create and update paths.

---

### WR-08: `updateTemplate` and `deleteTemplate` silently succeed when the row doesn't exist or is already soft-deleted

**File:** `src/app/(dashboard)/templates/actions.ts:147-159, 177-189`

Both use `.update().eq("id", ...).is("deleted_at", null)` with no `.select()` or row-count check. If `templateId` is wrong (stale from a stale picker, intentional probe, or already deleted), Supabase returns `error: null` with zero rows affected and the action returns `ok(null)`. The UI toasts "Template deleted" / "Template updated" for a no-op. This makes "is my delete actually deleting" hard to debug and lets a user think they soft-deleted a stale template that's already gone.

**Fix:**
```ts
const { error, count } = await supabase.from("sms_templates")
  .update(update, { count: "exact" })
  .eq("id", templateId)
  .is("deleted_at", null);
if (!error && (count ?? 0) === 0) {
  return { ok: false, error: { code: "TPL_NOT_FOUND", message: "Template not found or already deleted." } };
}
```

---

### WR-09: Soft-deleting a template doesn't warn the user about referenced sequence steps

**File:** `src/app/(dashboard)/templates/delete-template-button.tsx:19-31` and `src/app/(dashboard)/templates/actions.ts:173-198`

The confirm dialog says "Delete X? This can be recovered by an admin." It does not say "this template is referenced by N sequence steps; deleting will pause those enrollments next time they fire." `tick.ts:175-183` correctly handles this with `template_missing` pause, so prod won't silently misbehave — but the *author* gets zero feedback, and active enrollments stop dripping until someone notices the paused state.

**Fix:** Pre-flight count of `sequence_steps` references in `deleteTemplate`, and surface it back so the button can refuse / warn:
```ts
const { count } = await supabase.from("sequence_steps")
  .select("id", { count: "exact", head: true })
  .eq("template_id", templateId);
if ((count ?? 0) > 0) {
  return { ok: false, error: { code: "TPL_IN_USE",
    message: `Used by ${count} sequence step(s). Detach them first.` } };
}
```

---

### WR-10: Editor's "Use template" radio destructively wipes the custom body with no undo

**File:** `src/app/(dashboard)/sequences/[id]/edit/editor.tsx:251-258`

```ts
const setMode = (next) => {
  if (next === "custom") setTemplateId(null);
  else { setBody(""); setTemplateId(templates[0]?.id ?? null); }
};
```

A user with a half-written custom body who toggles "Use template" to peek loses their draft. Toggling back leaves both empty. Same data-loss class as WR-03.

**Fix:** Don't clear `body` on mode switch — only clear at save time when `mode === "template"`. The save action already nulls the unused field at line 379-381 / 519-521.

---

### WR-11: Editor doesn't surface that the currently-selected template was soft-deleted

**File:** `src/app/(dashboard)/sequences/[id]/edit/editor.tsx:259, 305-326`

`templates` prop is the live list from `listTemplates()` (filters `deleted_at IS NULL`). `step.template_id` may reference a soft-deleted template — `selected = templates.find(t => t.id === templateId)` returns `undefined`, the `<select>` shows nothing useful, but `templateId` state is still set to the dead id. On save, the FK still resolves (035 uses `on delete set null` only on hard-delete — soft-delete preserves the row), so the upsert succeeds and the next tick pauses with `template_missing`.

**Fix:** When `templateId` is set but `selected` is `undefined`, render a destructive banner: "Referenced template no longer exists. Pick a new one or switch to custom."

---

### WR-12: `formatRelative` in TemplatesList uses `Date.now()` at render → React hydration mismatch warning when fresh rows are present

**File:** `src/app/(dashboard)/templates/templates-list.tsx:155-166`

`templates-list.tsx` is a `"use client"` component, but it's rendered initially on the server with the parent Page's server pass (page.tsx is async). The server's `Date.now()` at render and the client's `Date.now()` at hydration differ enough to flip a "just now" / "1m ago" boundary, producing a React hydration mismatch warning in the console.

**Fix:** Render the absolute timestamp on first paint and swap to relative in a `useEffect`-driven state. Or use a tiny `<time suppressHydrationWarning>` wrapper.

---

### WR-13: `set_updated_at()` function created without `set search_path = ''`

**File:** `supabase/migrations/034_sms_templates.sql:33-39`

Supabase's standard hardening recommendation for SECURITY DEFINER and trigger functions is to pin `search_path`. Without it, a malicious schema-shadowing attack can hijack `now()` or any unqualified function call inside the trigger.

**Fix:**
```sql
create function public.set_updated_at()
returns trigger
language plpgsql
set search_path = ''
as $fn$ begin new.updated_at = now(); return new; end; $fn$;
```

---

## INFO

### IN-01: `useState` mirrors of server props in `template-dialog`, `editor` SequenceEditor + StepEditor

**Files:** `template-dialog.tsx:65-67`, `editor.tsx:129-132, 500-506`

Per project memory, useState initialized from props freezes against `router.refresh()`. Current usage works because dialogs are unmounted/remounted between edits, but it's a footgun.

**Fix:** Key components by id (`<TemplateDialog key={template.id} ... />`) so prop changes force remount.

### IN-02: `renderTemplate` `isTruthy` treats `0` as falsy but substitution renders `0`

**File:** `src/lib/templates/render.ts:42-47, 69-76`

Asymmetry: `{{#if order_count}}` with 0 renders nothing; `{{order_count}}` renders "0". Theoretical for V1 (all vars are strings) but document or normalize.

### IN-03: `renderTemplate` pipe-fallback regex tolerates `{` inside the fallback

**File:** `src/lib/templates/render.ts:39-40`

`[^}]*?` matches `{`. So `{{x | {{y}}}}` matches messily. Add a regression test, or tighten to `[^|}{]*?`.

### IN-04: `template-dialog` Select onValueChange has dead defensive `?? "General"`

**Files:** `template-dialog.tsx:153`, `templates-list.tsx:63`

Unreachable defensive branches; signals author wasn't sure of contract.

### IN-05: `set_updated_at` "if not exists" doesn't guard against a function with the same name but different signature

**File:** `034_sms_templates.sql:28-42`

Use `create or replace function` instead — idempotent, schema-pinned, signature-stable.

### IN-06: `createTemplate` / `createSequence` org lookup is unordered and non-deterministic

**Files:** `templates/actions.ts:86-90`, `sequences/actions.ts:175-179`

`select id from organizations limit 1` with no `order by`. Add `.order("created_at").limit(1)` or derive from a user→org_members lookup.

### IN-07: `editor.tsx` doc-string lists `opt_out` as a template variable, but it's not in `TEMPLATE_VARIABLES`

**File:** `editor.tsx:295-297`, `variables.ts:19-34`

The "Variables: ... opt_out" hint is misleading — `{{opt_out}}` substitutes to empty string. Remove the mention or add to registry.

### IN-08: `category` is not validated server-side against a whitelist

**File:** `templates/actions.ts:51-115`

Server action accepts any string. Lock down with a Zod enum.

### IN-09: `template-vars.ts` and `templates/render.ts` live under different module roots

**Files:** `src/lib/sequences/template-vars.ts` vs `src/lib/templates/render.ts`

Move `template-vars.ts` to `@/lib/templates/` for cohesion.

---

## Files reviewed

`src/app/(dashboard)/leads/[id]/inline-reply.tsx`, `src/app/(dashboard)/leads/actions.ts`, `src/app/(dashboard)/sequences/[id]/edit/editor.tsx`, `src/app/(dashboard)/sequences/[id]/edit/page.tsx`, `src/app/(dashboard)/sequences/actions.ts`, `src/app/(dashboard)/templates/actions.ts`, `src/app/(dashboard)/templates/delete-template-button.tsx`, `src/app/(dashboard)/templates/new-template-button.tsx`, `src/app/(dashboard)/templates/page.tsx`, `src/app/(dashboard)/templates/template-dialog.tsx`, `src/app/(dashboard)/templates/template-picker.tsx`, `src/app/(dashboard)/templates/templates-list.tsx`, `src/components/dashboard-sidebar.tsx`, `src/lib/sequences/render.ts`, `src/lib/sequences/tick.ts`, `src/lib/supabase/types.ts`, `src/lib/templates/render.test.ts`, `src/lib/templates/render.ts`, `src/lib/templates/variables.ts`, `supabase/migrations/034_sms_templates.sql`, `supabase/migrations/035_sequence_step_template_ref.sql`
