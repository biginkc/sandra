# Roadmap: SMS Templates v1

**Milestone:** SMS Templates v1
**Created:** 2026-04-29
**Granularity:** Standard (5 phases)

## Phase Overview

| Phase | Name | Requirements | Depends on |
|-------|------|-------------|------------|
| 1 | Database Schema & Migration | DATA-01, DATA-02, DATA-03, DATA-04 | — |
| 2 | Interpolation Engine | INTERP-01 through INTERP-05 | Phase 1 |
| 3 | Templates Management UI | UI-01 through UI-09 | Phase 1, Phase 2 |
| 4 | Compose Box Integration | COMP-01, COMP-02, COMP-03 | Phase 2, Phase 3 |
| 5 | Sequence Integration | SEQ-01, SEQ-02, SEQ-03 | Phase 2, Phase 4 |

## Phases

### Phase 1: Database Schema & Migration

**Goal:** Create the `sms_templates` table and seed preset categories.

**Scope:**
- Supabase migration for `sms_templates` table (id, name, content, category, user_id, created_at, updated_at, deleted_at)
- Category CHECK constraint or enum for preset values + custom support
- RLS policies (authenticated users within org)
- Soft delete via `deleted_at` column

**Requirements:** DATA-01, DATA-02, DATA-03, DATA-04

**UAT:**
- [ ] Migration applies cleanly
- [ ] RLS prevents unauthenticated access
- [ ] CRUD operations work via Supabase client
- [ ] Soft delete sets deleted_at without removing row

---

### Phase 2: Interpolation Engine

**Goal:** Build a pure, testable function that resolves `{{variable | fallback}}` syntax against a lead/property context.

**Scope:**
- `src/lib/templates/interpolate.ts` — core interpolation function
- Regex-based parser for `{{var}}` and `{{var | fallback}}` patterns
- Variable registry mapping variable names to data accessors
- Error handling for unrecognized variables
- Comprehensive Vitest unit tests

**Requirements:** INTERP-01, INTERP-02, INTERP-03, INTERP-04, INTERP-05

**UAT:**
- [ ] `{{first_name}}` resolves to contact's first name
- [ ] `{{first_name | there}}` returns "there" when first_name is null/empty
- [ ] Unknown variables produce a clear error (not silently rendered)
- [ ] Function is pure (no side effects, no DB calls)
- [ ] 100% branch coverage in unit tests

---

### Phase 3: Templates Management UI

**Goal:** Full CRUD management page for SMS templates with character counting, variable picker, and live preview.

**Scope:**
- `/templates` page under `(dashboard)` layout
- Server Actions for create, update, delete, list
- Template list with search and category filter
- Create/Edit form with:
  - Name, category selector, content textarea
  - Real-time character counter (GSM-7 vs UCS-2 segment display)
  - Variable picker dropdown that inserts at cursor
  - Live preview panel with sample data
- Delete with confirmation dialog

**Requirements:** UI-01 through UI-09

**UAT:**
- [ ] Templates page loads and lists existing templates
- [ ] Can create a template with name, category, and content
- [ ] Search filters by name and content
- [ ] Category filter shows only matching templates
- [ ] Character counter updates in real-time and shows segment count
- [ ] Variable picker inserts variable at cursor position
- [ ] Preview panel shows interpolated sample data
- [ ] Delete requires confirmation

---

### Phase 4: Compose Box Integration

**Goal:** Add a template picker to the 1-to-1 message compose box that auto-fills interpolated content.

**Scope:**
- Template picker component (dropdown or command palette style)
- Integration into existing compose box component
- Auto-interpolate using current lead's contact/property data
- Allow editing interpolated text before sending

**Requirements:** COMP-01, COMP-02, COMP-03

**UAT:**
- [ ] Template picker appears in compose box
- [ ] Selecting a template fills compose box with interpolated content
- [ ] Variables resolve using the current lead's actual data
- [ ] User can freely edit the filled text before sending

---

### Phase 5: Sequence Integration

**Goal:** Allow sequence steps to reference templates by ID, interpolating at send time.

**Scope:**
- Add optional `template_id` field to sequence step schema
- Modify sequence step editor to offer "Use Template" option
- At send time, fetch template content and interpolate with target lead's data
- Template edits apply to future sends only

**Requirements:** SEQ-01, SEQ-02, SEQ-03

**UAT:**
- [ ] Sequence step can reference a template
- [ ] At send time, template content is fetched and interpolated
- [ ] Editing the original template affects future sends
- [ ] Already-sent messages are unaffected by template edits

---

## Progress

| Phase | Status |
|-------|--------|
| 1 | ○ Pending |
| 2 | ○ Pending |
| 3 | ○ Pending |
| 4 | ○ Pending |
| 5 | ○ Pending |

---
*Roadmap created: 2026-04-29*
*Last updated: 2026-04-29 after initial creation*
