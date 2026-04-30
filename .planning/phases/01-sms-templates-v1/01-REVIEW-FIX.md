---
status: all_fixed
findings_in_scope: 15
fixed: 15
skipped: 0
iteration: 1
phase: 01-sms-templates-v1
fixed_at: 2026-04-29
review_path: .planning/phases/01-sms-templates-v1/01-REVIEW.md
---

# Phase 01: Code Review Fix Report — SMS Templates v1

**Fixed at:** 2026-04-29
**Source review:** `.planning/phases/01-sms-templates-v1/01-REVIEW.md`
**Iteration:** 1

**Summary:**
- Findings in scope: 15 (2 BLOCKER + 13 WARNING)
- Fixed: 15
- Skipped: 0

All in-scope BLOCKER and WARNING findings were applied successfully. Each
fix was committed atomically with the pre-commit hook running the full
typecheck + Vitest suite (408 tests, all passing) on every commit.

INFO findings (IN-01 through IN-09) were intentionally out of scope for
this fix iteration per the workflow config (`fix_scope: critical_warning`).

## Fixed Issues

### BL-01: Migration 034 idempotency

**Files modified:** `supabase/migrations/034_sms_templates.sql`
**Commit:** `4113397`
**Applied fix:** Added `if not exists` to both indexes; swapped policy
and trigger to drop-then-create so a second `supabase db push` doesn't
fail on `42P07` / `42710`. Edited 034 in place since the migration is
unmerged (PR #71). Combined with WR-01 + WR-13 in the same commit (all
touch the same file).

### BL-02: sequence_steps inline-XOR-template DB constraint

**Files modified:** `supabase/migrations/035_sequence_step_template_ref.sql`, `src/lib/sequences/tick.ts`
**Commit:** `368b633`
**Applied fix:** Added `sequence_steps_send_sms_body_xor` CHECK
constraint to migration 035 (drop-then-create for re-runnability). For
`action_type = send_sms` rows, exactly one of (`template_id`,
`template_body`) must be populated, and `template_body` (when chosen)
must be non-empty after trim. Added defense-in-depth empty-body guard
in `tick.ts` after `bodySource` resolution: if blank, mark the run as
`provider_failed`, pause the enrollment with `step_misconfigured`, and
return early instead of sending an empty SMS. Edited 035 in place
rather than creating 036 since 035 is also unmerged.

### WR-01: Authenticated-user RLS policy has no org scoping on `sms_templates`

**Files modified:** `supabase/migrations/034_sms_templates.sql`
**Commit:** `4113397`
**Applied fix:** Added a multi-line TODO comment above the policy
documenting the deferred multi-tenant scope tightening, the prescribed
target (`org_id in (select org_id from org_members where user_id =
auth.uid())`), and the reason for deferral (every other table in this
repo follows the same pattern; coordinated migration is the only sane
path). Did NOT change the policy itself per review and config guidance.

### WR-02: `loadLeadVars` bypasses RLS via service-role client

**Files modified:** `src/lib/sequences/template-vars.ts`, `src/app/(dashboard)/leads/actions.ts`
**Commit:** `4cb9335`
**Applied fix:** Added an optional `adminClient` parameter to
`loadTemplateVars`. When supplied, it is used exclusively for
`resolveUserFirstName` (`auth.admin.getUserById`); the property /
contact / organization reads run on the caller-supplied session
client. `loadLeadVars` now passes `supabase` (session) for data reads
and `adminClient` only for the user-name resolver. Cron tick keeps
working: it passes the same service-role client as `client` (no
`adminClient` arg), which `auth.admin.getUserById` still resolves
correctly.

### WR-03: `template-picker` overwrites the user's typed reply without confirmation

**Files modified:** `src/app/(dashboard)/leads/[id]/inline-reply.tsx`
**Commit:** `a6242a7`
**Applied fix:** Added a `window.confirm("Replace your draft with this
template?")` early-return when `body.trim().length > 0` before kicking
off the `loadLeadVars` fetch.

### WR-04: `template-picker` race — clicking template B before A's `loadLeadVars` resolves

**Files modified:** `src/app/(dashboard)/leads/[id]/inline-reply.tsx`
**Commit:** `a6242a7`
**Applied fix:** Introduced a `templateRequestToken` ref incremented on
every selection. The resolved `loadLeadVars` promise compares its
captured `requestId` against the latest token and discards its result
if a newer pick has happened. Mirrors the existing `cancelled` pattern
used at lines 47-57 for `listFromNumbers`.

### WR-05: `template-picker` swallows `listTemplates` errors

**Files modified:** `src/app/(dashboard)/templates/template-picker.tsx`
**Commit:** `6c7068a`
**Applied fix:** Replaced the boolean `loaded` with a discriminated
`LoadState` union (`idle | loading | ready | error`). On the error
branch, the popover renders the error message + a Retry button that
re-runs `listTemplates`.

### WR-06: `template-picker` cache never busts

**Files modified:** `src/app/(dashboard)/templates/template-picker.tsx`
**Commit:** `6c7068a`
**Applied fix:** Re-fetch on every open by depending only on `[open]`
in the effect (and tearing down via the `cancelled` flag mirrored from
the inline-reply pattern). Templates are small; a fresh read on each
click is cheaper than the bug class of "stale picker shows a deleted
template".

### WR-07: `updateTemplate` skips input validation

**Files modified:** `src/app/(dashboard)/templates/actions.ts`
**Commit:** `0c55dbb`
**Applied fix:** Hoisted name + content validation into a shared
`validateTemplateInput` helper. `createTemplate` calls it with
`requireAll: true`; `updateTemplate` calls it with `requireAll: false`
so partial patches (e.g. category-only) skip name/content checks. Both
paths now return typed `VALIDATION` errors with consistent copy and
never leak Postgres CHECK constraint names to the toast.

### WR-08: `updateTemplate` and `deleteTemplate` silently succeed on missing rows

**Files modified:** `src/app/(dashboard)/templates/actions.ts`
**Commit:** `0c55dbb`
**Applied fix:** Both actions now use `{ count: "exact" }` and check
the returned count. Zero rows affected → return `{ ok: false, error: {
code: "TPL_NOT_FOUND", message: "Template not found or already
deleted." } }` instead of the previous false-success
`ok(null)`.

### WR-09: Soft-deleting a template doesn't warn about referenced sequence steps

**Files modified:** `src/app/(dashboard)/templates/actions.ts`
**Commit:** `0c55dbb`
**Applied fix:** Pre-flight `select id from sequence_steps where
template_id = ?` with `count: exact, head: true` before the soft-delete
update. If the count is greater than zero, refuse with `{ code:
"TPL_IN_USE", message: "Used by N sequence step(s)..." }` so the UI
can prompt the author to detach first. tick.ts still handles the
mid-flight missing-template case via `template_missing` pause; this
adds an author-facing guardrail at delete time.

### WR-10: Editor's "Use template" radio destructively wipes custom body

**Files modified:** `src/app/(dashboard)/sequences/[id]/edit/editor.tsx`
**Commit:** `9dd8eb3`
**Applied fix:** Removed the `setBody("")` call from the
`setMode("template")` branch in `MessageBodyEditor`. Both modes now
preserve their respective fields; the upsert action already nulls the
inactive field at write time (lines 379-381 / 519-521), so no
behavior change at save.

### WR-11: Editor doesn't surface that the currently-selected template was soft-deleted

**Files modified:** `src/app/(dashboard)/sequences/[id]/edit/editor.tsx`
**Commit:** `9dd8eb3`
**Applied fix:** In `MessageBodyEditor`, derive
`referencedTemplateMissing = mode === "template" && templateId !==
null && selected === undefined`. When true, render a destructive
banner above the template `<select>` instructing the author to pick a
different template or switch to custom mode and noting that saving
as-is will pause hitting enrollments.

### WR-12: `formatRelative` causes hydration mismatch

**Files modified:** `src/app/(dashboard)/templates/templates-list.tsx`
**Commit:** `d2f3036`
**Applied fix:** Extracted `<UpdatedAt>` component that renders an
absolute UTC timestamp on first paint (`formatAbsolute(iso)` — no
`Date.now()`, server- and client-stable), then swaps to relative form
in `useEffect`. A 60-second `setInterval` keeps the relative label
fresh on long-lived list views. The wrapping `<time
suppressHydrationWarning dateTime={iso}>` covers the narrow window
between server output and the first effect tick. Title attribute
exposes the absolute timestamp on hover.

### WR-13: `set_updated_at()` function created without `set search_path = ''`

**Files modified:** `supabase/migrations/034_sms_templates.sql`
**Commit:** `4113397`
**Applied fix:** Added `set search_path = ''` to the `create function
public.set_updated_at()` declaration inside the existing `do $$ ...
$$` guard, plus a comment explaining the Supabase hardening rationale
(prevents schema-shadowing attacks on `now()` or any unqualified call
inside the trigger).

## Skipped Issues

None — all 15 in-scope findings were fixed.

---

_Fixed: 2026-04-29_
_Fixer: Claude (gsd-code-fixer)_
_Iteration: 1_
