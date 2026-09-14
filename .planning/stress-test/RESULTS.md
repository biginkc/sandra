# Browser execution ledger

Original candidate65c58eb0; fixed candidate retests are recorded below.

| Probe | Result | Evidence |
|---|---|---|
| Production owner self-selection | PASS | Jarrad self queue selected; no Maria mutation |
| Production sequential search typing | FAIL | BUG-001 |
| Fixed candidate search refresh | PASS | Synthetic owner session retained focus and returned the matching row |
| Local rep authenticated queue | PASS | Native login; five stages; owner selector absent |
| Manual outreach default Kind Call | FAIL | BUG-002 |
| Fixed candidate source normalization | PASS | Manual outreach selected Other outreach automatically |
| Manual outreach Other outreach succeeds | PASS | UI Contacted and refresh; DB receipt |
| Readiness whitespace rejected | PASS | Field-specific error |
| Readiness Escape/reopen draft reset | PASS | Draft empty on reopened dialog |
| Explicit no-motivation/no appointment readiness | PASS | Needs offer, unchanged temperature, DB receipt |
| Offer malformed amounts0,-1,1.001,1e6,$1,000,unsafe integer | PASS | Six field-invalid results |
| Offer follow-up equal sent time | PASS | Field-specific after-offer error |
| One-cent historical overdue DropboxSign offer | PASS | UI saved; DB1cent, pending, exact times |
| Logged offer creates no task/enrollment/eSign | PASS |14check read-only DB receipt |
| Offer history after save/collapse | FAIL | BUG-003; full reload resolves |
| Fixed candidate appointment detail refresh | PASS | Sep13 10:00 synthetic appointment appeared immediately in expanded detail |

Native date input fill required keyboard edit to commit value; automation limitation excluded from product bugs.

| Contract blank signing time rejected | PASS | Field-specific error |
| Contract malformed offer ID rejected | PARTIAL | Generic server error lacks field guidance |
| Contract without offer ID succeeds | PASS | UnderContract persisted, second DB receipt |
| UnderContract retained across period switch | PASS | Browser This month selection |
| Archive requires confirmation, resets on cancel | PASS | Checkboxfalse on reopen; unchecked submission rejected |
| Archive preserves UnderContract and history | PASS | Second DB receipt |
| Decline before offer sent | FAIL | BUG-004 |
| Fixed candidate decline chronology guard | PASS | Earlier timestamp raised INVALID_INPUT with no offer/property mutation |
| Handoff missing reason | PASS | Field-specific validation |
| Fresh NotContacted handoff | FAIL | BUG-005, repeated after reload |
| Fixed candidate fresh NotContacted handoff | PASS | Synthetic leads1006 and1008 left the rep queue; SQL confirmed assignment/status, archived handoff sentinel, and no eligible recipient episode |

| Note whitespace blocked | PASS | Add disabled |
| Keyboard note save, multiline/emoji/literal markup | PASS | Single new note rendered literally |
| Appointment23:45 +90min | PASS | UI ended01:15AM; DB task stored 2026-09-15 04:45–06:15 UTC for synthetic property102 |
| Future appointment clears next-step warning | PASS | Summary updates |
| Appointment expanded history after booking | FAIL | BUG-003 extension |
| Contacted reached guidance after no-answer | FAIL | BUG-006 |
| Fixed candidate contacted guidance | PASS | Corrected follow-up guidance shown; reached checkmark absent |

| Owner/rep same-period KPI equality | PASS | All6displayed values identical on current fixture ledger |
| Owner handoff of materialized NeedsOffer lead | PASS initial | Synthetic103 leaves rep queue |
| Two-user stale handoff | PASS initial | Rep opened first; owner completed; rep stale submit rejected |

| Stage pagination20→full | PASS | NotContacted23,Contacted23,NeedsOffer21,OfferSent21,UnderContract22;unique labelcounts equal rowcounts |
| Detail pagination independent groups | PASS |60notes(allunique),60attempts,25offers,26history; all next-page controls exhausted |

Expanded cohort seed receipt: evidence/expanded-fixture-manifest.json.105 additional leads, no external destinations; existing4principals unchanged. Stage/timer facts synthetic; no automated transport/provider proof implied.

| Expand all with collapsed section | PARTIAL | Contacted remains collapsed despite Expand all; potentially confusing semantics, not new defect classified |
| Collapse all during queued detail loads | PASS initial | Zero expanded rows, no browser console errors |
| Synthetic designation off/on | PASS | Existing rep queue stays accessible; checkbox restoredtrue |
|390px attempt modal | PASS visual | Actual ownerTabwidth390;height844;documentwidth375; all fields/footer visible; evidence/attempt-mobile-390.png |

Viewport-tool correction: initial override did not affect repTab5 but did affect ownerTab6. Mobile is not blocked; verify actual per-tab dimensions before claiming results. Reset requested after capture; testowner may retain its per-tab390viewport. Production remained1634x854, rep1280x720.
