# New-lead decision from the 120-case human review

The reviewer identified four cases (C028, C063, C079, C080) that should become new leads. Jev had called all four nurture with confidence 0.90–1.00. The old taxonomy could not represent this outcome; a higher confidence cutoff would not fix it.

`new_lead` now means actionable seller interest, a requested/accepted call or appointment, or a seller-provided time to discuss the property. An outbound invitation, unrelated time, declined call, or wrong contact does not qualify. Latest explicit stop/legal requests override earlier interest. A requested call does not create a booking.

## Implementation

- The TypeSafe request uses the documented question map with instructions and category definitions, replacing the previous array of bare option names.
- The model is pinned to `jev-1.13.0`; schema version 2 and policy version `2026-09-20-new-lead-review` separate this rubric from the historical seven-category results.
- Native outcome confidence is preserved separately from probabilities in the audit decision. Missing/invalid confidence is unknown, not 1.0.
- In automatic classifier mode, `new_lead` follows the existing human-attention escalation path (`call_request` or `hot_lead`), without applying nurture, writing an appointment, sending a reply, or auto-accepting a disposition review. Shadow mode remains audit-only.
- No Jev promotion threshold is selected here. The existing independent inbound Haiku qualification path is unchanged, so this patch does not claim to be the complete replacement of lead promotion. Jev classification still runs inside responder eligibility gates.
- Other disposition thresholds and the planned separate review UI remain future work. Existing deterministic STOP and DNC handling remain in place.

## Verification boundaries

Unit/dispatch tests use mocked provider answers to verify transport, confidence parsing, audit versioning, and routing. They do not establish that Jev will classify the examples correctly.

Twelve synthetic/paraphrased evaluation cases cover the four reviewed patterns and negative controls. Private seller messages and identifiers are not committed. Generate requests offline with:

```
npx tsx scripts/prepare-jev-new-lead-eval.ts /absolute/path/to/new-file.json
```

This script never calls a provider. An authorized bounded run on 2026-09-20 matched all 12 expected outcomes (14,234 input tokens; estimated $0.000598). All five positive cases returned new_lead, while seven negative/exception controls retained their expected outcomes. This is a small development smoke test, not a calibrated accuracy result. The old 120-case review is development evidence, not an independent validation set for the new category. Final automatic promotion requires validated thresholds and conflict/consent checks; it is not enabled by this change.

API reference: https://docs.typesafe.ai/primitives/choice
