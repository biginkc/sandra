# SMS Template Research — Features & Patterns

**Date:** 2026-04-29
**Domain:** Real Estate CRM SMS Templates

## Industry Standard: Variable Syntax

Every major player uses `{{variable_name}}` double-curly-brace syntax:
- **GoHighLevel**: `{{contact.first_name}}`, `{{contact.email}}` — dot-notation with object prefix
- **BatchLeads**: `{{first_name}}`, `{{property_address}}` — flat variable names
- **Salesforce/SMS-Magic**: `{{Contact.FirstName}}` — PascalCase with object prefix
- **Podio**: `[[firstname]]` or `{{item:field-name}}` — varies by integration

**Sandra recommendation:** Use `{{first_name}}` flat syntax (BatchLeads style). Simpler, no object prefix needed since all our variables come from the property/contact context. The curly-brace convention is universal and familiar.

## Variable Interpolation — Fallback Handling

- **GoHighLevel**: NO fallback support. Empty fields render as blank space. Major pain point.
- **BatchLeads**: Recommends "backup messages" but no inline fallback syntax.
- **Salesforce**: Some plugins support `{{Contact.FirstName | there}}` pipe syntax.

**Sandra recommendation:** Support inline fallbacks with pipe syntax: `{{first_name | there}}`. This is a differentiator — GoHighLevel doesn't have it. Default global fallbacks for common fields (first_name → "there", address → "your property").

## Available Variables (v1 scope)

From Sandra's existing data model:
| Variable | Source | Example |
|----------|--------|---------|
| `{{first_name}}` | contacts.first_name | "John" |
| `{{last_name}}` | contacts.last_name | "Smith" |
| `{{full_name}}` | computed | "John Smith" |
| `{{address}}` | properties.address | "123 Main St" |
| `{{city}}` | properties.city | "Dallas" |
| `{{state}}` | properties.state | "TX" |
| `{{zip}}` | properties.zip | "75201" |
| `{{company_name}}` | global setting | "Big Ink Consulting" |

## Category Systems

- **Salesforce**: Folder hierarchy (Folders > Sub-folders) + tag-based categories
- **GoHighLevel**: Flat list with search, no formal categories
- **Best practice**: Categories (not folders) for v1. Flat is simpler, tags enable filtering.

**Sandra recommendation:** Category field on each template. Preset categories: "Cold Outreach", "Follow Up", "Appointment", "General". User can create custom categories later.

## UX Patterns — Template Management

### Character Counter (Critical)
- Standard SMS = 160 chars (GSM-7 encoding)
- With emoji/unicode = 70 chars (UCS-2 encoding)
- Must show: current count, segment count, encoding warning
- Must estimate merged variable lengths (use average or max)

### Template Editor
- Side-by-side: editor left, preview right
- Variable picker button (dropdown grouped by field type)
- Live preview with sample data populated

### Template List
- Table view: Name, Category, Preview snippet, Last Updated
- Search across name + content
- Filter by category
- Bulk actions (delete, move category)

## Anti-Patterns to Avoid

1. **No fallback handling** (GoHighLevel's biggest complaint)
2. **Manual variable typing** — always use a picker/inserter
3. **No character count** — users accidentally send multi-segment messages
4. **No preview** — users can't see what the final message looks like
5. **Complex folder nesting** — overkill for SMS templates, categories are enough

## Key Takeaways for Sandra v1

1. `{{variable}}` syntax with `| fallback` support
2. Category-based organization (not folders)
3. Real-time character counter with segment indicator
4. Variable picker UI (don't make users type variable names)
5. Live preview with sample data
6. Integration into both compose box and sequences
