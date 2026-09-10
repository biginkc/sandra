# Outbound script duplication review — 2026-09-10

## Scope and source

Reviewed all 26 navigation sections, 21 branches / 31 remaining variants, and 11 authored objection entries against their flow and the current Outbound Script - Official CLOSR Sales Process (Google Doc 1ab9k0VIUQ4kkSTmdR5XV7qeuiRe2-czgmKGouM-lCag, fetched 2026-09-10). The outbound document refers objection handling to a separate training guide; objection entries were reviewed for internal issues, not certified verbatim against that separate guide.

The user explicitly authorized removing All openers and the duplicated introduction purpose, then clarified that both greetings are intentional and must remain verbatim, with the initial question on its own line. No paraphrasing or additions are authorized.

## Changes

- Removed the combined All openers variant and its section references. The four individual openers remain selectable. Unknown lead sources fall back to the first individual option (Cold call), following the existing selection rule. A stale `default` override is ignored and the normal source selection/fallback applies.
- Removed the inbound file-assignment paragraph from each outbound opener. Its concluding purpose repeated the qualification frame on screen 2. The fetched outbound document does not contain that imported paragraph.
- Preserved `Hey {seller_name}? Hey {seller_name}, this is {rep_name}!` exactly. The existing sentence renderer produces two separate paragraphs. Browser assertions cover their text, count, and vertical separation for all four openers.
- Preserved the qualification frame and every other retained authored line byte-for-byte, including ids/types. Compared retained line objects against base 825af54a; only 14 deleted line objects (10 combined-opener lines and four inbound additions), no additions or modifications.
- Bumped script and manifest versions together to 1.2.3; updated fidelity, selector, version and browser contracts.

## Remaining observations — no unauthorized copy edits

- Reveal entry asks why the homeowner is selling, and Motivation later probes why now. Both are present in the outbound source and have distinct conversational purposes; retained.
- Tenant entry and the Investor probe can revisit whether there are tenants. These are selectable alternatives and source-authored questions, not duplicated navigation references; retained.
- Assessment asks roof/HVAC condition; the later underwriting section asks age. These ask for different information; retained.
- Anchor repeats that the comparison is not an offer three times across two lines. The source repeats this emphasis; retained.
- Good news and They accept both congratulate and describe agreement next steps. The repetition is in the source; retained rather than guessing which to delete.
- The source contains grammar/wording issues such as `segway`, `since its built`, `tube and knob`, and `better position then`. Retained exactly under the user's no-paraphrasing instruction.
- Conditional rep directions such as `If nowhere:` and `(repeat back their situation)` occur within spoken lines. This is a presentation concern, not authorization to rewrite or invent branches.
- The spouse objection contains literal `x:xx` scheduling markers; these are not resolved coach tokens. The Zillow objection is a worked example with fixed amounts, and its note explicitly requires substituting actual numbers. The right-price/straight-to-offer objection overcome fields contain rep directions. These are flagged for separate source/behavior decisions, not silently changed.
- Prior approved app-specific email-once and e-sign adaptations differ from the outbound document. Existing regression tests identify and preserve them; this fix does not restore duplicate email requests or obsolete signing instructions.
- No evidence of an additional copied inbound paragraph or duplicated manifest line reference elsewhere. Source-authored repetition is not classified as a defect merely because it repeats words.

## Verification

- Coach unit suite: 315 passed.
- Coach/session and softphone RTL: 139 passed.
- Typecheck: passed.
- Synthetic user-journey/dialer switch checks: 22 passed.
- Synthetic contrast/responsive checks: 25 passed.
- Full unit suite: 3,683 passed.
- No customer/provider call is required for this script-only change.

The earlier pre-call setup request (including Mel and missing profile fields) is separate from this scoped script correction and is not implemented by this change.
