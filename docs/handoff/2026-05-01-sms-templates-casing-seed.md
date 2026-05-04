# Handoff: SMS Templates + Data Casing Fixes
**Date:** 2026-05-01 (afternoon session)
**Branch:** gsd/phase-01-cross-table-ux (all work merged to main)

---

## 1. Current state

- Branch: `gsd/phase-01-cross-table-ux`, all PRs merged to main
- Working tree: 22 uncommitted untracked files (`.claude/`, `docs/`, `scripts/`, `graphify-out/`) — none are code, all safe to ignore
- Prod URL: `https://sandra-sooty.vercel.app`
- Migrations 036–040 applied to prod + test via CI (db-migrate.yml)

---

## 2. What shipped this session

| PR # | Title | Effect |
|------|-------|--------|
| #90 | fix: title-case contact names at ingest + backfill | `normalizeName()` added; contacts.first_name/last_name backfilled via migration 036 |
| #91 | fix: holistic display-field casing + duplicate mailing address | `normalizeName()` applied to entity_name, mailing_address, mailing_city, city; email lowercased; mailing address display bug fixed (no more double city/state/zip); migration 037 |
| #92 | fix: uppercase 2-letter tokens in address fields | `normalizeDisplayAddress()` added for address/city fields — uppercases 2-letter tokens (MO, NW, ST etc.); migration 038 corrects initcap-lowercased abbreviations |
| #93 | feat: 43 BMH SMS templates seeded | migrations 039 (system_managed col + unique constraint) + 040 (43-row seed); server-action guards; System badge UI; delete disabled on system rows; 497 unit + 106 RTL tests |

---

## 3. Key infrastructure changes

**New normalizers in `src/lib/csv/normalize.ts`:**
- `normalizeName(raw)` — title-case for person names (first_name, last_name, entity_name)
- `normalizeDisplayAddress(raw)` — title-case + uppercase 2-letter tokens; used for address, city, mailing_address, mailing_city

**Applied in:**
- `src/lib/csv/ingest.ts` — all human-readable text fields
- `src/lib/leads/create.ts` — city, first_name, last_name

**Database migrations applied (prod + test):**
- 036 — backfill contacts.first_name/last_name via initcap()
- 037 — backfill properties.address/city, homeowner_details.mailing_address/city, contacts.entity_name/email
- 038 — fix 2-letter abbreviations left by initcap() (Mo→MO, Nw→NW)
- 039 — sms_templates: add system_managed boolean + UNIQUE(org_id, name) constraint
- 040 — seed 43 BMH Group SMS templates with system_managed=true

**sms_templates schema delta:**
- New column: `system_managed boolean NOT NULL DEFAULT false`
- New constraint: `sms_templates_org_name_unique UNIQUE (org_id, name)`
- `reset_tenant_tables()` updated to preserve system-managed templates

**New files:**
- `scripts/build-sms-template-seed.ts` — regenerable seed builder
- `src/lib/templates/seed-builder.ts` — parse/validate logic (exported for tests)
- `src/lib/templates/seed-builder.test.ts` — 3 unit tests

**TemplateRow type** now includes `system_managed: boolean` (actions.ts + types.ts).

---

## 4. Memory updates

No new memory files written this session. Existing memories remain current.

---

## 5. What's in flight

**Phase 1.5 — Sandra Design System Retrofit** is planned (5 plans, 2 waves) in `.planning/phases/01.5-sandra-design-system-retrofit/`. No execution has started. This is the natural next phase.

STATE.md shows it as "planned."

---

## 6. Known not-done

- `supabase gen types typescript` should be re-run after migrations 039/040 land — the `system_managed` field was manually added to `src/lib/supabase/types.ts` by the agent; an official regen would be cleaner. Not urgent.
- Multi-org SMS template seeding is out of scope — only BMH Group seeded. Future orgs need a separate mechanism.
- Template preview rendering in the /templates UI is deferred (out of scope per original spec).
- The E2E tests on the main branch CI were already failing before this session — pre-existing, not caused by this work.

---

## 7. Test credentials

- Jarrad's test phone: +13107540662 (SMS smoke — never smoke real leads)
- Twilio test receiver: +18148097074 (inbound-only canary — never a sender)

---

## 8. Verification scripts

```bash
# Confirm migrations applied
gh run list --branch main --limit 5 --json status,name,conclusion

# Confirm 43 system-managed templates in prod DB (run via Supabase MCP or psql)
# select count(*) from public.sms_templates where system_managed = true;
# Expected: 43

# Run full test suite
npm run typecheck && npm run test && npm run test:rtl

# Regenerate Supabase types (do this when convenient)
npx supabase gen types typescript --project-id <prod-project-id> > src/lib/supabase/types.ts
```

---

## 9. Critical learnings

- **2-letter token uppercase rule:** `normalizeDisplayAddress()` uppercases any 2-letter alphabetic word (MO, NW, ST, etc.). `normalizeName()` is pure title-case only — don't use it for address fields or "Jo" → "JO" problem recurs.
- **initcap() limitation:** Postgres `initcap()` turns "MO" → "Mo". Always follow an initcap() backfill with the 2-letter fix (migration 038 pattern) for address fields.
- **Mailing address display bug pattern:** DealMachine exports "Primary Mailing Address" as a full combined string. The display component now checks for commas to detect full strings and skips appending separate city/state/zip.
- **system_managed guard pattern:** Pre-fetch the row's `system_managed` flag before any mutating action. Return `code: "SYSTEM_MANAGED_TPL"` with a clear message. Mirror from `archiveList` in lists/actions.ts.
- **Migration-only for prod DB:** Never use Supabase MCP `apply_migration` against prod — only `.sql` files via `db-migrate.yml` CI workflow.
