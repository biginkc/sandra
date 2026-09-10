# Pre-call setup implementation checklist

- [x] Fable plan approval (4 requests; 3 substantive verdicts; final APPROVE, claude-fable-5-1; see FABLE-PLAN.md)
- [x] Read-only target inspection and typed setup contract implemented; focused action tests passed, final review pending
- [x] Initial accordion UI, prefill, draft isolation and file number implemented; browser matrix exposed/fixed dropdown layering and collapse retention; final accessibility/layout review pending
- [x] First-render handoff implemented; focused hook tests pass. Latest focused regression 90/90 passed, plus 6/6 authenticated boundary tests.
- [ ] Exhaustive branch matrix: initial 8-profile browser preparation/edit/opener isolation PASS; 517 frozen-source matrix tests PASS:160 individual-choice cases,128 opener/occupancy,64 offer/closing,165 value-pairs across all8profiles; each verifies26sections forward and backward. Eight browser profiles also passed all selectors and26Next/Back.
- [ ] Stress: seed515 100 browser cycles PASS (36.8s); seed20260910 100 browser cycles PASS (36.7s). Total 200/200 ordinary switching/edit/toggle/close cycles passed; evidence in tmp/precall-matrix-preview/stress-*.json. Four negative controls detected and restored (edit precedence, target isolation, branch handoff, greeting layout). Expanded browser failure injection remains pending.
- [ ] Native full verify PASS:12 atomic tests, disposable PostgreSQL17 eSign rehearsal, typecheck,4218 unit tests,1241 RTL tests. Subsequent sticky-footer change passed affected4viewport+keyboard browser checks; final regression refresh pending. Visible browser review performed and found/fixed nested scrolling; independent code review lanes still pending.
- [ ] Bounded paid call runner and preview calls (currently blocked: cost/duration proof)
- [ ] Exact-commit Fable approval and green CI
- [ ] Production identity, four production calls, final Fable release verdict

Hard limits: 24 attempted calls total, $20 aggregate, 300 seconds maximum per call. 16 preview +4 production +4 reserve. No calls until a durable exclusive ledger, all-service cost upper bound, and external-to-browser termination are verified. Training destination only; no real homeowner calls. Attempts to date: 0. Spend: $0.

Current worktree: coach/precall-setup, based on merged PR515 (8c7053e7).

Plan corrections: 20 selector choices, not19. Preserve file-number ID case and final6characters. Existing training context has no leadID and must stay unavailable. Existing prepare actions pause sequences, so pre-call inspection must be read-only. Freeze authoritative identity at Call; dirty whitelist excludes identity. No script wording edits or provider payload expansion. Local drafts partitioned by opaque repID+target, clear current rep on signout; missing storage nonblocking.


## Current material findings and limitations
- Browser dropdown layer blocked pointer selection: fixed and regression passed.
- Sign-out did not reliably enumerate/remove current-rep draft keys: fixed and regression passed.
- Pending context could drop branch edits or omit early edits from the call snapshot: fixes implemented; further matrix verification ongoing.
- Closing/toggling used to reset compact mode: state moved to setup controller;200 ordinary disruption cycles passed.
- Visible review found nested scrolling and offscreen Call; switched coaching setup to one scrolling body with a persistent Call footer.4viewport/keyboard checks passed afterward.
- No source-script JSON changes; approved two-part greeting and PR515 correction retained.
- No feature commit/PR yet. Work is dirty and has NOT received code-level Fable approval or independent manual review. No merge/deployment authorized by coordinator yet (MERGE_ONLY admission hold).
- Paid lane remains blocked on verified all-service maximum rates and independent 300-second termination. No paid calls placed.


## Review candidate update
- Combined browser matrix:15/15 PASS (2.5min), including200cycles,8live profiles and4layout sizes after the scrolling fix.
- Extra browser fault case PASS: late A-B-A responses and failed retry retain explicit edits and still permit calling.
- Live Coach rendered contrast14/14 PASS; new setup text/hint contrast case PASS across all4groups.
- Negative controls4/4 detected; byte-for-byte source restoration and green reruns verified.
- Source inspection found an existing absentee-to-tenant inference. Removed that inference to satisfy the explicit plan; absentee targets now default Unknown and reps can choose Tenant-occupied.23context tests pass.
- Late context after successful disposition could resurrect a draft: pending requests now invalidated at clear, with regression coverage.
- Local PostgreSQL17 rehearsal instance on55488 was stopped after native full verify passed; no shared database or production data touched.
- Fallow incremental analysis: one new unused constant export removed; negative-control runner registered as package script. Remaining pre-existing unused token export/dependency observations are outside this feature. No unresolved imports/cycles reported.
- Independent exact-head manual review and Fable code review are next. This is a review candidate, not a release approval. Paid budget remains0calls/$0.
