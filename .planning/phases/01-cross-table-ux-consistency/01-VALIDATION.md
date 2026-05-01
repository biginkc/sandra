---
phase: 01-cross-table-ux-consistency
slug: cross-table-ux-consistency
status: ready
nyquist_compliant: true
wave_0_complete: true
created: 2026-04-30
filled: 2026-05-01
---

# Phase 1 — Validation Strategy

> Per-phase validation contract for feedback sampling during execution.

---

## Test Infrastructure

| Property | Value |
|----------|-------|
| **Framework** | vitest@4.1.5 (node + jsdom configs) |
| **Config files** | `vitest.config.ts` (node, `*.test.ts`), `vitest.rtl.config.ts` (jsdom, `*.test.tsx`) |
| **Quick run command** | `npm run test` (node unit, ~1s) |
| **RTL run command** | `npm run test:rtl` (jsdom, ~3s) |
| **Full suite command** | `npm run verify` (typecheck + node + rtl) |
| **Estimated runtime** | ~5s for `verify`, ~1s for quick unit |

---

## Sampling Rate

- **After every task commit:** Run the task's `<automated>` command (typically <2s)
- **After every plan:** Run `npm run verify` (typecheck + node + rtl, ~5s)
- **Before `/gsd-verify-work`:** Full suite must be green
- **Max feedback latency:** 5s

---

## Per-Task Verification Map

| Task ID  | Plan | Wave | Requirement(s)                                  | Threat | Test Type           | Automated Command                                                                                                | File Exists                                  | Status     |
|----------|------|------|-------------------------------------------------|--------|---------------------|------------------------------------------------------------------------------------------------------------------|----------------------------------------------|------------|
| 01-01-01 | 01   | 1    | TABLE-04, TABLE-07                              | —      | typecheck           | `npx tsc --noEmit src/components/table/use-table-url-state.ts`                                                   | created in this task                         | ⬜ pending |
| 01-01-02 | 01   | 1    | TABLE-04                                        | —      | unit                | `npx vitest run src/components/table/use-table-url-state.test.ts`                                                | created in this task                         | ⬜ pending |
| 01-01-03 | 01   | 1    | TABLE-06, TABLE-07                              | —      | typecheck+unit      | `npx tsc --noEmit && npx vitest run src/components/table/use-table-url-state.test.ts`                            | extends Task 01-01-01                        | ⬜ pending |
| 01-01-04 | 01   | 1    | TABLE-04, TABLE-05, TABLE-06                    | —      | rtl-hook            | `npx vitest run --config vitest.rtl.config.ts src/components/table/use-table-url-state.hook.test.tsx`            | created in this task                         | ⬜ pending |
| 01-01-05 | 01   | 1    | (planning artifact)                             | —      | doc-grep            | `grep -c "npx vitest run" .planning/phases/01-cross-table-ux-consistency/01-VALIDATION.md`                       | this file                                    | ⬜ pending |
| 01-02-01 | 02   | 2    | TABLE-01, TABLE-02, TABLE-03, TABLE-07          | —      | typecheck           | `npx tsc --noEmit`                                                                                               | `src/components/table/table-toolbar.tsx`     | ⬜ pending |
| 01-02-02 | 02   | 2    | TABLE-01, TABLE-02, TABLE-03                    | —      | rtl                 | `npx vitest run --config vitest.rtl.config.ts src/components/table/table-toolbar.test.tsx`                       | created in this task                         | ⬜ pending |
| 01-02-03 | 02   | 2    | TABLE-01, TABLE-07                              | —      | typecheck           | `npx tsc --noEmit`                                                                                               | `src/components/table/sortable-header.tsx`   | ⬜ pending |
| 01-02-04 | 02   | 2    | TABLE-01                                        | —      | rtl                 | `npx vitest run --config vitest.rtl.config.ts src/components/table/sortable-header.test.tsx`                     | created in this task                         | ⬜ pending |
| 01-03-01 | 03   | 3    | TABLE-04, TABLE-07                              | —      | unit (regression)   | `npx vitest run src/app/\(dashboard\)/properties/prospects-query.test.ts`                                        | modifies existing                            | ⬜ pending |
| 01-03-02 | 03   | 3    | TABLE-01, TABLE-02, TABLE-03, TABLE-05, TABLE-06| —      | rtl (regression)    | `npx vitest run --config vitest.rtl.config.ts src/app/\(dashboard\)/properties/prospects-table.test.tsx`         | modifies existing                            | ⬜ pending |
| 01-03-03 | 03   | 3    | TABLE-01..TABLE-07                              | —      | full suite          | `npm run verify`                                                                                                 | n/a                                          | ⬜ pending |
| 01-04-01 | 04   | 4    | TABLE-04, TABLE-06                              | —      | typecheck           | `npx tsc --noEmit`                                                                                               | modifies `src/app/(dashboard)/lists/page.tsx`| ⬜ pending |
| 01-04-02 | 04   | 4    | TABLE-01, TABLE-02, TABLE-03, TABLE-05, TABLE-06| —      | typecheck           | `npx tsc --noEmit`                                                                                               | `src/app/(dashboard)/lists/lists-table.tsx`  | ⬜ pending |
| 01-04-03 | 04   | 4    | TABLE-01, TABLE-02, TABLE-03, TABLE-05, TABLE-06| —      | rtl                 | `npx vitest run --config vitest.rtl.config.ts src/app/\(dashboard\)/lists/lists-table.test.tsx`                  | created in this task                         | ⬜ pending |
| 01-05-01 | 05   | 4    | TABLE-04, TABLE-06                              | —      | typecheck           | `npx tsc --noEmit`                                                                                               | modifies `src/app/(dashboard)/jobs/page.tsx` | ⬜ pending |
| 01-05-02 | 05   | 4    | TABLE-01, TABLE-02, TABLE-03, TABLE-05, TABLE-06| —      | typecheck           | `npx tsc --noEmit`                                                                                               | modifies `src/app/(dashboard)/jobs/jobs-list.tsx` | ⬜ pending |
| 01-05-03 | 05   | 4    | TABLE-01, TABLE-02, TABLE-03, TABLE-05, TABLE-06| —      | rtl                 | `npx vitest run --config vitest.rtl.config.ts src/app/\(dashboard\)/jobs/jobs-list.test.tsx`                     | created in this task                         | ⬜ pending |
| 01-06-01 | 06   | 4    | TABLE-04, TABLE-06                              | —      | typecheck           | `npx tsc --noEmit`                                                                                               | modifies `src/app/(dashboard)/templates/page.tsx`| ⬜ pending |
| 01-06-02 | 06   | 4    | TABLE-01, TABLE-02, TABLE-03, TABLE-05, TABLE-06| —      | typecheck           | `npx tsc --noEmit`                                                                                               | modifies `src/app/(dashboard)/templates/templates-list.tsx` | ⬜ pending |
| 01-06-03 | 06   | 4    | TABLE-01, TABLE-02, TABLE-03, TABLE-05, TABLE-06| —      | rtl                 | `npx vitest run --config vitest.rtl.config.ts src/app/\(dashboard\)/templates/templates-list.test.tsx`           | created in this task                         | ⬜ pending |

*Status: ⬜ pending · ✅ green · ❌ red · ⚠️ flaky*

**Total tasks:** 21 across 6 plans (Plan 01 = 5, Plan 02 = 4, Plan 03 = 3, Plan 04 = 3, Plan 05 = 3, Plan 06 = 3).

---

## Wave 0 Requirements

Test files created during plan execution (each one becomes the verify gate for its plan):

- [x] `src/components/table/use-table-url-state.test.ts` — created in Plan 01 Task 2 (12 unit tests)
- [x] `src/components/table/use-table-url-state.hook.test.tsx` — created in Plan 01 Task 4 (11 jsdom hook tests)
- [ ] `src/components/table/table-toolbar.test.tsx` — created in Plan 02 Task 2
- [ ] `src/components/table/sortable-header.test.tsx` — created in Plan 02 Task 4
- [ ] `src/app/(dashboard)/lists/lists-table.test.tsx` — created in Plan 04 Task 3
- [ ] `src/app/(dashboard)/jobs/jobs-list.test.tsx` — created in Plan 05 Task 3
- [ ] `src/app/(dashboard)/templates/templates-list.test.tsx` — created in Plan 06 Task 3

Plan 03 (`/properties` migration) adds NO new test files — the existing 26 RTL + 35 unit tests on prospects are the regression gate that locks in byte-identical behavior.

Existing infrastructure (vitest@4.1.5, both `vitest.config.ts` and `vitest.rtl.config.ts`, `vitest.rtl.setup.ts`) covers every Phase 1 requirement; no framework install needed.

---

## Manual-Only Verifications

| Behavior | Requirement | Why Manual | Test Instructions |
|----------|-------------|------------|-------------------|
| Skeleton flash visibility on `/jobs` and `/templates` (the 150ms floor making client-mode skeletons visible) | TABLE-06 | Visual perception of a 150ms flash; automated test confirms `navPending=true` >150ms but the actual skeleton DOM swap is verified at the route level | After Plan 05 / 06 lands, manually visit `/jobs` and `/templates`, type into search, observe skeleton rows briefly replacing content |
| Visual continuity across `/properties`, `/lists`, `/jobs`, `/templates` after migration | TABLE-01 | Visual consistency check: rounded-card toolbar shape, padding, border, search-pill styling should match across all four pages | After Plan 06 lands, manually screenshot each route; compare side-by-side; only intended Phase-1 changes (new search/filter pills on `/lists`, `/jobs`, `/templates`) should appear |

---

## Validation Sign-Off

- [x] All tasks have `<automated>` verify or Wave 0 dependencies
- [x] Sampling continuity: no 3 consecutive tasks without automated verify
- [x] Wave 0 covers all MISSING references
- [x] No watch-mode flags (every command uses `vitest run`, not `vitest watch`)
- [x] Feedback latency <5s
- [x] `nyquist_compliant: true` set in frontmatter

**Approval:** ready-for-execution
