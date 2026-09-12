# Fable code review record

Round 1 reviewed exact commit `9c96379e999a6d2e02d87f460e169a3826783c67` against base `8c7053e7024433f46791eac1b186c1b7a7cf10ec` with the full diff, runtime context, plan and design handoff. Authenticated Claude CLI model metadata includes `claude-fable-5-1`; receipt: evidence/precall-fable-code-1.json. No browser screenshots or test execution were directly inspected by Fable.

Counters: 1 request, 1 substantive verdict, 0 approvals. Verdict: **CHANGES_REQUIRED**.

## Reconciliation in the working tree (renewed approval pending)

1. Accordion finding contradicted installed Base UI 1.4.1 source: AccordionRoot defaults `multiple = false`. Added supported explicit `multiple={false}` and a single-open assertion; did not add the suggested nonexistent `openMultiple` property.
2. Guard preparation against recovered active calls. Regression passes.
3. Clear pending manual inspection on number invalidation. Regression passes.
4. Assert transport/disposition identity excludes edited spoken values; add panel contract tests. Checks pass; exhaustive provider/browser coverage is still tracked separately.
5. Invalidate pending setup on a new sign-in even when previous operator identity is unknown. Regression passes.
6. Remember authenticated session identity before setup loads so sign-out clears that rep’s persisted drafts. Regression passes.
7. Replace blur-driven progression with explicit Continue, preserving editing focus and moving focus to the next group only on that action. Regression passes.
8. Show friendly opener and named remaining fields in compact receipt. Regression passes.
9. Preserve original coach-off lead-button label; coach-on label describes setup.
10. Catch cleanup rejection after target mismatch so the refused attempt can reset and retry. Regression passes.
11. Correct stale status/counts and retain portable evidence here.
12. Retain all remaining release gates: independent review, exact-head Fable approval, zoom/failure coverage, bounded actual calls, deployment and production assessment.

No claim of approval is made for either the reviewed commit or subsequent edits.
