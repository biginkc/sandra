# Requirements: Sandra — SMS Templates v1

**Defined:** 2026-04-29
**Core Value:** Ensure all outbound communication is consistent, compliant, and personalized with minimal effort.

## v1 Requirements

### Schema & Data

- [ ] **DATA-01**: Templates table with fields: id, name, content, category, created_at, updated_at
- [ ] **DATA-02**: Category field supports preset values (Cold Outreach, Follow Up, Appointment, General) and custom user-created categories
- [ ] **DATA-03**: RLS policies restrict templates to authenticated users within the organization
- [ ] **DATA-04**: Soft delete support for templates (recoverable from admin)

### Interpolation Engine

- [ ] **INTERP-01**: Parse `{{variable_name}}` syntax in template content and replace with actual contact/property data
- [ ] **INTERP-02**: Support inline fallback values via pipe syntax: `{{first_name | there}}`
- [ ] **INTERP-03**: Support these v1 variables: first_name, last_name, full_name, address, city, state, zip, company_name
- [ ] **INTERP-04**: Return clear error when a variable name is unrecognized (don't silently render `{{bad_var}}`)
- [ ] **INTERP-05**: Interpolation function is pure, testable, and reusable across compose box and sequences

### Templates Management UI

- [ ] **UI-01**: Templates list page at `/templates` showing name, category, preview snippet, last updated
- [ ] **UI-02**: Search templates by name and content
- [ ] **UI-03**: Filter templates by category
- [ ] **UI-04**: Create new template with name, category, and content fields
- [ ] **UI-05**: Edit existing template (inline or modal)
- [ ] **UI-06**: Delete template with confirmation
- [ ] **UI-07**: Real-time character counter showing count, SMS segment count, and encoding warning for emoji/unicode
- [ ] **UI-08**: Variable picker dropdown (grouped by type) that inserts `{{variable}}` at cursor position
- [ ] **UI-09**: Live preview panel showing template with sample data populated

### Compose Box Integration

- [ ] **COMP-01**: Template picker in the 1-to-1 message compose box (dropdown or command palette)
- [ ] **COMP-02**: Selecting a template auto-fills compose box with interpolated content using current lead's data
- [ ] **COMP-03**: User can edit the interpolated content before sending

### Sequence Integration

- [ ] **SEQ-01**: Sequence step type can reference a template by ID instead of inline content
- [ ] **SEQ-02**: When a sequence step fires, interpolate template variables with the target lead's data
- [ ] **SEQ-03**: Template changes reflect in future sequence sends (not retroactive to already-sent messages)

## v2 Requirements

### Analytics

- **ANALYTICS-01**: Track which template was used per outbound message
- **ANALYTICS-02**: Display usage count per template
- **ANALYTICS-03**: Calculate and display response rate per template

### Advanced Interpolation

- **ADV-01**: Conditional blocks (if/else within templates)
- **ADV-02**: Date formatting variables (e.g., `{{today | format:MM/DD}}`)

### Email

- **EMAIL-01**: Email template type with HTML rendering
- **EMAIL-02**: Shared variable system across SMS and email templates

## Out of Scope

| Feature | Reason |
|---------|--------|
| A/B testing | Requires statistical infrastructure, defer to v2+ |
| Template marketplace / sharing | Single-org product, no multi-tenant sharing needed |
| Rich media (MMS templates) | SMS-only for v1, MMS adds carrier complexity |
| Template versioning / history | Over-engineering for v1, soft delete is sufficient |
| Approval workflows | No team hierarchy requiring template approval |

## Traceability

| Requirement | Phase | Status |
|-------------|-------|--------|
| DATA-01 | Phase 1 | Pending |
| DATA-02 | Phase 1 | Pending |
| DATA-03 | Phase 1 | Pending |
| DATA-04 | Phase 1 | Pending |
| INTERP-01 | Phase 2 | Pending |
| INTERP-02 | Phase 2 | Pending |
| INTERP-03 | Phase 2 | Pending |
| INTERP-04 | Phase 2 | Pending |
| INTERP-05 | Phase 2 | Pending |
| UI-01 | Phase 3 | Pending |
| UI-02 | Phase 3 | Pending |
| UI-03 | Phase 3 | Pending |
| UI-04 | Phase 3 | Pending |
| UI-05 | Phase 3 | Pending |
| UI-06 | Phase 3 | Pending |
| UI-07 | Phase 3 | Pending |
| UI-08 | Phase 3 | Pending |
| UI-09 | Phase 3 | Pending |
| COMP-01 | Phase 4 | Pending |
| COMP-02 | Phase 4 | Pending |
| COMP-03 | Phase 4 | Pending |
| SEQ-01 | Phase 5 | Pending |
| SEQ-02 | Phase 5 | Pending |
| SEQ-03 | Phase 5 | Pending |

**Coverage:**
- v1 requirements: 24 total
- Mapped to phases: 24
- Unmapped: 0 ✓

---
*Requirements defined: 2026-04-29*
*Last updated: 2026-04-29 after initial definition*
