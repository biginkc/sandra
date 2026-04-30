# Roadmap: SMS Templates v1

**Milestone:** SMS Templates v1
**Created:** 2026-04-29
**Revised:** 2026-04-29 (reduced from 5 → 3 phases after discovering existing interpolation engine)
**Granularity:** Coarse (3 phases)

## Existing Code Being Leveraged

| File | Reuse |
|------|-------|
| `src/lib/sequences/render.ts` | Full `{{variable}}` + `{{#if}}` engine — add `| fallback` pipe syntax |
| `src/lib/sequences/template-vars.ts` | `loadTemplateVars()` already fetches all v1 variables from DB |
| `src/lib/sequences/render.test.ts` | 10 existing tests — extend with fallback tests |
| `src/app/(dashboard)/leads/[id]/inline-reply.tsx` | Compose box with `body`/`setBody`, char counter, Cmd+Enter |

## Phase Overview

| Phase | Name | Requirements | Depends on |
|-------|------|-------------|------------|
| 1 | Schema + Engine Upgrade | DATA-01–04, INTERP-01–05 | — |
| 2 | Templates Management UI | UI-01–09 | Phase 1 |
| 3 | Compose Box + Sequence Integration | COMP-01–03, SEQ-01–03 | Phase 1, Phase 2 |

## Phases

### Phase 1: Schema + Engine Upgrade

**Goal:** Create the `sms_templates` table and upgrade the existing interpolation engine with fallback support.

**Scope:**
- Supabase migration for `sms_templates` table (id, name, content, category, user_id, org_id, created_at, updated_at, deleted_at)
- Category support (preset: Cold Outreach, Follow Up, Appointment, General + custom)
- RLS policies (authenticated users within org)
- Soft delete via `deleted_at` column
- Move `render.ts` + `template-vars.ts` to shared `src/lib/templates/` location
- Add `{{var | fallback}}` pipe syntax to existing `renderTemplate()`
- Update existing sequence imports to point to new shared location
- Extend existing test suite with fallback + error cases

**What's NEW vs what's a MOVE:**
- NEW: Migration, RLS, pipe-fallback regex (~15 LOC), new tests
- MOVE: `render.ts` → `src/lib/templates/render.ts`, `template-vars.ts` → `src/lib/templates/vars.ts`
- EXISTING (untouched): `{{variable}}` substitution, `{{#if}}` conditionals, `loadTemplateVars()`

**Requirements:** DATA-01–04, INTERP-01–05

**UAT:**
- [ ] Migration applies cleanly
- [ ] RLS prevents unauthenticated access
- [ ] CRUD operations work via Supabase client
- [ ] Soft delete sets deleted_at without removing row
- [ ] `{{first_name}}` resolves to contact's first name (existing behavior preserved)
- [ ] `{{first_name | there}}` returns "there" when first_name is null/empty (NEW)
- [ ] `{{#if first_name}}` conditionals still work (regression check)
- [ ] Existing sequence tests still pass after the file move
- [ ] Unknown variables produce clear error / render as blank (existing behavior)

---

### Phase 2: Templates Management UI

**Goal:** Full CRUD management page for SMS templates with character counting, variable picker, and live preview.

**Scope:**
- `/templates` page under `(dashboard)` layout using `PageHeader` component
- Add "Templates" nav item to `DashboardSidebar` ITEMS array
- Server Actions for create, update, delete, list (in `templates/actions.ts`)
- Template list with Shadcn `Table`, search `Input`, category `Select` filter
- Create/Edit form (Shadcn `Dialog` or dedicated page) with:
  - Name input, category selector, content `Textarea`
  - Real-time character counter (GSM-7 vs UCS-2 segment display)
  - Variable picker using existing `Command` (cmdk) component
  - Live preview panel using `renderTemplate()` with sample data
- Delete with Shadcn `Dialog` confirmation

**Requirements:** UI-01–09

**UAT:**
- [ ] "Templates" appears in sidebar navigation with correct active state
- [ ] Templates page loads and lists existing templates
- [ ] Can create a template with name, category, and content
- [ ] Search filters by name and content
- [ ] Category filter shows only matching templates
- [ ] Character counter updates in real-time and shows segment count
- [ ] Variable picker inserts `{{variable}}` at cursor position
- [ ] Preview panel shows interpolated sample data via `renderTemplate()`
- [ ] Delete requires confirmation
- [ ] Design matches existing Sandra warm-paper palette and component patterns

---

### Phase 3: Compose Box + Sequence Integration

**Goal:** Add template picker to InlineReply compose box and allow sequence steps to reference templates.

**Scope — Compose Box:**
- Template picker component (reuse `Command` cmdk, grouped by category)
- Add picker button to existing `InlineReply` component (next to Send)
- On template select: call `loadTemplateVars()` for current lead, run `renderTemplate()`, call `setBody()` with result
- User can freely edit the interpolated text before sending

**Scope — Sequences:**
- Add optional `template_id` foreign key to sequence step schema (migration)
- Modify sequence step editor to offer "Use Template" toggle (radio: custom vs template)
- When template selected, show preview with unresolved `{{variables}}`
- At send time (`tick.ts`), if step has `template_id`: fetch template content, run through existing `renderTemplate()` + `loadTemplateVars()` pipeline

**Requirements:** COMP-01–03, SEQ-01–03

**UAT:**
- [ ] Template picker button appears in InlineReply compose box
- [ ] Selecting a template auto-fills with interpolated content for current lead
- [ ] User can edit the filled text before sending
- [ ] Sequence step can toggle between custom message and template reference
- [ ] At sequence send time, template content is fetched and interpolated
- [ ] Editing a template affects future sequence sends (not already-sent)
- [ ] All existing InlineReply and sequence tests still pass

---

## Progress

| Phase | Status |
|-------|--------|
| 1 | ○ Pending |
| 2 | ○ Pending |
| 3 | ○ Pending |

---
*Roadmap created: 2026-04-29*
*Last updated: 2026-04-29 — reduced from 5 to 3 phases after code audit*
