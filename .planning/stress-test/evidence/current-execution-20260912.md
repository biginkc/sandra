# Current isolated execution receipt

- Candidate: local merge head `5342cc96`, served at `127.0.0.1:58702`
- Browser: in-app browser, authenticated synthetic rep, desktop viewport
- Data: dedicated local Supabase stack; expanded 105-lead cohort already existed and was not overwritten
- Submission method: authenticated workflow RPCs for state-changing steps, followed by in-app-browser reload and assertions. This is marked API-assisted because the in-app browser did not commit `datetime-local` fields.

## Verified transitions

| Case | Fixture | Result | Evidence |
| --- | --- | --- | --- |
| J01-00 attempt | `20000000-0000-4000-8000-000000001000` | PARTIAL, assisted | `fn_log_acquisition_attempt` returned `stage=contacted`; browser reload showed Contacted, one attempt, No answer, DialPad, and follow-up guidance. The later reached step was not executed. |
| J02-00 readiness | `20000000-0000-4000-8000-000000001001` | PARTIAL, assisted | `fn_ready_acquisition_offer` returned `stage=needs_offer`; replay returned `duplicate=true`; browser search showed one Needs offer row and zero attempts. |
| J03-00 offer | `20000000-0000-4000-8000-000000001042` | PARTIAL, assisted | `fn_log_acquisition_offer` returned `stage=offer_sent`; replay returned `duplicate=true`; browser reload showed `$125,000.50` and Pending. |
| J05-00 signing step | `20000000-0000-4000-8000-000000001042` | PARTIAL, assisted | `fn_record_acquisition_contract` returned `stage=under_contract`; replay returned `duplicate=true`; browser reload showed Under contract. The archive submission was not executed. |
| J08-03 fresh implicit handoff | `20000000-0000-4000-8000-000000001002` | PARTIAL, assisted | `fn_handoff_acquisition_lead` returned `archived=true`; replay returned `duplicate=true`; browser reload/search returned zero matching rows. SQL confirms archived sentinel and owner reassignment. |

## Pure browser UI pass

- `J05-01` archive cancellation: opened the archive confirmation from the expanded Under contract detail and clicked Cancel; the dialog closed without mutation. Candidate `5342cc96`, synthetic rep browser, fixture `20000000-0000-4000-8000-000000001042`.

## Limits and triage

- The native date/time control could not be committed through this in-app browser surface, so these are persisted browser-verification passes rather than pure browser-submission passes.
- No confirmed product defect was discovered in these transitions. The incorrect recipient UUID used during setup was a fixture-input error and produced `RECIPIENT_UNAVAILABLE`; correcting it succeeded without a source change.
- Historical receipts in `RESULTS.md` cover the prior browser campaign and remain separate evidence; they are not silently counted as current submissions.
