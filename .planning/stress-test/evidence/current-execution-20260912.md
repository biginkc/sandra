# Current isolated execution receipt

- Candidate: local merge head `7890622d`, served at `127.0.0.1:58702`
- Browser: in-app browser, authenticated synthetic rep, desktop viewport
- Data: dedicated local Supabase stack; expanded 105-lead cohort already existed and was not overwritten
- Submission method: authenticated workflow RPCs for state-changing steps, followed by in-app-browser reload and assertions. This is marked API-assisted because the in-app browser did not commit `datetime-local` fields.

## Verified transitions

| Case | Fixture | Result | Evidence |
| --- | --- | --- | --- |
| J01-00 attempt | `20000000-0000-4000-8000-000000001004` | PASS, browser | Browser saved DialPad No answer followed by Reached; reload showed Contacted and detail with two attempts. |
| J02-00 readiness | `20000000-0000-4000-8000-000000001026` | PASS, browser | Browser saved specified motivation; reload showed Needs offer / Interested and Offer needed. |
| J03-00 offer | `20000000-0000-4000-8000-000000001042` | BLOCKED, assisted | `fn_log_acquisition_offer` returned `stage=offer_sent`; replay returned `duplicate=true`; browser reload showed `$125,000.50` and Pending. Native date input prevented pure browser submission. |
| J05-00 signing step | `20000000-0000-4000-8000-000000001042` | BLOCKED, assisted | `fn_record_acquisition_contract` returned `stage=under_contract`; replay returned `duplicate=true`; browser reload showed Under contract. Full browser sign-and-archive path was not executed. |
| J08-03 fresh implicit handoff | `20000000-0000-4000-8000-000000001002` | BLOCKED, assisted | `fn_handoff_acquisition_lead` returned `archived=true`; replay returned `duplicate=true`; browser reload/search returned zero matching rows. SQL confirms archived sentinel and owner reassignment; browser submission was not exercised. |

## Pure browser UI pass

- `J01-00` full attempt sequence: on `20000000-0000-4000-8000-000000001004`, the browser saved a DialPad No answer, then a DialPad Reached attempt. A cache-busting reload moved the row to Contacted; expanded detail showed `ATTEMPTS · 2` with both outcomes and no recording.
- `J01-01` duplicate save: on `20000000-0000-4000-8000-000000001010`, two immediate Save clicks closed one dialog; reload/detail showed exactly one Manual No answer attempt.
- `J01-02` source normalization: on `20000000-0000-4000-8000-000000001010` (`Stress not_contacted 11 Fixture Lane`), selecting Manual outreach revealed and accepted Other outreach; reload/detail showed one Manual No answer attempt.
- `J05-01` archive cancellation: opened the archive confirmation from the expanded Under contract detail and clicked Cancel; the dialog closed without mutation. Candidate `7890622d`, synthetic rep browser, fixture `20000000-0000-4000-8000-000000001042`.
- `J02-00` specified readiness: entered a concrete motivation in the readiness dialog and saved; a cache-busting reload placed `20000000-0000-4000-8000-000000001026` in Needs offer / Interested with the Offer needed guidance.
- `J02-01` explicit no motivation: selected No motivation provided with Keep temperature unchanged; a reload placed `20000000-0000-4000-8000-000000001025` in Needs offer / Interested without an error.
- `J02-02` draft reset: canceled a readiness dialog after an invalid draft, opened the next fixture, and observed a fresh empty motivation field.
- `J08-02` required handoff reason: on `20000000-0000-4000-8000-000000001044`, submitted the handoff dialog with no reason; it stayed open and displayed Choose a handoff reason, with no write.
- `J08-00` one-way browser handoff: owner-configured recipient was selected for `20000000-0000-4000-8000-000000001022` (`Stress contacted 02 Fixture Lane`); the rep browser submitted Needs nurture and reload removed the old queue row. Reassign-back was not exercised.
- `J08-01` recipient-change race: rep held a Needs nurture handoff for `20000000-0000-4000-8000-000000001025` while owner changed the configured recipient to the rep; submit returned `The handoff recipient is unavailable`, then the owner recipient was restored without a lead write.
- Search recovery: a no-match search showed empty sections; keyboard clear plus blur restored the populated queue. Expand all loaded detail groups, and Collapse all removed them during the load without residual Loading details text.
- Stage pagination: each available Load more control was exercised; after completion no Load more control remained for Contacted, Needs offer / Interested, Offer Sent, or Under Contract.
- Global search: opened the search dialog, then pressed Escape; the dialog closed without navigation or queue mutation.
- `J11-00` notes: saved `Context ✅ <script>literal</script>` on `20000000-0000-4000-8000-000000001010` (`Stress not_contacted 11 Fixture Lane`) and `Lead ten context` on `20000000-0000-4000-8000-000000001009` (`Stress not_contacted 10 Fixture Lane`); full reload/reopen confirmed each stayed on its own lead.
- `J11-01` unsaved draft: typed a draft, collapsed the lead, reopened the note composer, and found an empty textarea; no discarded draft appeared after reload.
- `J11-02` save race: keyboard save created one note, and two immediate Add clicks created one `Button race note`; reload confirmed one occurrence.
- `J25-01` wrong number: on `20000000-0000-4000-8000-000000001013`, saved a DialPad Wrong number attempt; reload/detail showed Contacted with one distinct Wrong number outcome.
- `J14-00` / `J14-02`: browser saved the non-call Manual outreach, then the qualifying DialPad call was submitted through the authenticated RPC because its valid timestamp had to be after assignment. Reload showed both attempts; SQL showed `first_call_started_at` populated only by the qualifying call.
- `J15-00` historical activity: browser saved Reached and No answer on `20000000-0000-4000-8000-000000001015` at valid past timestamps; a custom Sep 9 range showed the expected two-event increment over the known baseline, while exact yesterday/Central-midnight boundaries remain blocked by the native date control.
- `J06-00`: the browser booking flow opened the calendar picker, selected Sep 17 at 1:00 PM, retained a 30-minute duration and synthetic rep assignee, and persisted an open appointment after reload. Held/no-show outcomes need a legitimately elapsed appointment and remain blocked.
- Contract-only archive: `20000000-0000-4000-8000-000000001044` was signed without an offer through the authenticated command, then archived through the browser confirmation. Reload removed the active row and SQL showed `under_contract_archived` with zero offers, preserving the contract history.
- Stale guard: a handoff replay with an intentionally old queue version returned `STALE_STATE` and left the current fixture unchanged. This is API corroboration; the two-session browser stale-assignment branch remains blocked.
- `J22-00`: selected the exact similar synthetic address, opened its canonical `/leads/{propertyId}` route, and returned to `/my-leads`; no other lead's detail content was shown.
- `J16-00` / `J16-03`: the existing offer fixture was transitioned to Under contract without an appointment; the contract-only fixture was transitioned and archived with zero offers and no new task, enrollment, or eSign rows. These state-changing submissions were API-assisted; browser reloads verified the resulting detail/queue state.
- `J16-01`: a Dropbox Sign method offer was logged as a label only; duplicate replay was suppressed, and task/enrollment/eSign counts remained unchanged. Browser detail showed `$150,000.00 · dropbox_sign` and `pending`.
- `J26-00`: on `20000000-0000-4000-8000-000000001021`, loaded notes, attempts, offers, and history independently until each cursor exhausted (60/60/25/26); appended `History context appended`, reloaded, and verified one newest note while preserving prior history.
- Decline coverage: the decline dialog's blank timestamp validation was exercised in-browser. A valid decline on `20000000-0000-4000-8000-000000001063` was submitted via the authenticated command; duplicate replay was suppressed, SQL showed `offer_declined` plus archived queue and owner reassignment, and a cache-busting browser search confirmed the old rep queue had no matching row.
- `J19-00` / `J19-01`: on `20000000-0000-4000-8000-000000001064`, browser note entry did not resolve the pending offer; reload retained both `$100,000.01 · Pending` and `Offer follow-up overdue`. A custom Sep 1–5 KPI range, excluding the Sep 12 sent date, still retained the active overdue row.
- `J03-01` concurrent offer guard: two authenticated commands against `20000000-0000-4000-8000-000000001045` raced with the same expected version; one succeeded and the other returned `STALE_STATE`. Browser reload showed exactly one `$111,111.11 · Pending` offer. The browser date control prevented a pure browser commit.
- `J03-02` offer validation: blank browser Save on `20000000-0000-4000-8000-000000001045` showed field errors for amount, method, sent time, and follow-up; no write occurred in that validation step.
- `J04-01` missing recipient: local settings were temporarily unset for `20000000-0000-4000-8000-000000001065`; the authenticated decline command returned `RECIPIENT_UNAVAILABLE`, settings were restored to the synthetic owner, and browser reload retained `$100,000.02 · Pending`.
- `J09-00` owner attribution: synthetic owner selected the rep scope, saved a DialPad Reached attempt on `20000000-0000-4000-8000-000000001023`, and reload/detail attributed the new event to My Leads owner fixture while retaining the rep's existing attempt.
- `J09-01` rapid scope switching: three overlapping owner-scope selections settled on the requested rep; the rendered scope label and KPIs matched that final selection.
- `J10-00` stale tab: rep browser held a valid attempt form for `20000000-0000-4000-8000-000000001024` while owner browser handed it off; Save returned `This lead changed`, and reload showed zero old-rep rows.
- `J12-00`/`J12-01`: owner browser enabled the synthetic owner designation, observed it selectable, changed recipient to the rep and back to owner, then restored the designation. Five rapid designation clicks settled on enabled and a final restoring click returned disabled.
- `J12-02`: empty recipient left Save recipient disabled; the disabled owner remained available in the scope selector with an explicit Acquisitions disabled label. A separately seeded disabled-member history fixture was not available.
- `J16-02` missing/no-motivation recovery: blank readiness Save on `20000000-0000-4000-8000-000000001027` showed the required motivation error; selecting No motivation provided saved and reload retained Needs offer / Interested.
- `J17-00` advanced-stage outreach: a browser DialPad No answer on `20000000-0000-4000-8000-000000001043` persisted one attempt while reload retained Needs offer / Interested.
- `J19-02` second-tab resolution: rep detail remained open while the owner command resolved `20000000-0000-4000-8000-000000001064`; old-rep reload was empty. Browser decline commit remained blocked by chronology-sensitive native datetime input.
- `J22-01` pending-detail clear: clearing search concurrently with a detail click on `20000000-0000-4000-8000-000000001025` left no stale detail or cross-property content.
- `J22-02` pagination plus similar selection: after loading the Contacted stage page, the browser narrowed to exact `Stress contacted 05 Fixture Lane` and opened only that row; no duplicate or cross-property detail appeared.
- `J26-01` concurrent history note: Load more notes and Add note were triggered together on `20000000-0000-4000-8000-000000001021`; reload retained one `Concurrent history note` without a loading error.
- `J26-02` retry/missing recording: two immediate Load more attempts clicks yielded 40 unique rows, no error, and no lingering Loading details; optional recordings remained absent as allowed.

## Blocked case matrix

- Native datetime or chronology limits: `J03-00`, `J03-01`, `J03-02`, `J04-00`, `J04-01`, `J04-02`, `J05-00`, `J06-01`, `J06-02`, `J14-00`, `J14-01`, `J14-02`, `J15-00`, `J15-01`, `J15-02`, `J16-00`, `J16-01`, `J16-03`, `J19-00`, and `J19-02`. These rows retain API corroboration where available and identify the exact browser control limitation.
- Missing recipient or unsupported lifecycle re-entry: `J04-01`, `J04-02`, `J04-03`, `J05-00`, `J05-02`, `J08-00`, `J08-03`, `J16-00`, `J16-03`, and `J17-02`. No partial state was inferred from an unexercised browser commit.
- Task, callback, or elapsed-appointment capability: `J06-01`, `J06-02`, `J07-00`, `J07-01`, `J07-02`, `J18-00`, `J18-01`, `J18-02`, and `J18-03`. The booked future appointment remains recorded separately under `J06-00`.
- Controlled clock or timezone capability: `J13-00`, `J13-01`, `J13-02`, `J13-03`, `J15-00`, and `J15-01`. The run did not change the system clock or forge elapsed appointments.
- Independent actor, reassignment, or disabled-history fixture: `J04-02`, `J08-00`, `J09-02`, `J17-01`, `J20-00`, `J20-01`, `J20-02`, `J20-03`, `J21-00`, `J21-01`, `J21-02`, and `J23-01`–`J23-02`. The two-account browser stale and recipient-change cases that were safe are recorded as PASS.
- Fault injection or auth-revocation capability: `J10-01`, `J10-02`, `J23-00`, `J23-01`, `J23-02`, `J24-00`, `J24-01`, and `J24-02`. No network, session, or permission failure was fabricated as a product result.
- Suppression/contact-slot capability: `J25-00` and `J25-02`. The synthetic cohort intentionally has no usable phone and no second contact slot.

## Limits and triage

- The native date/time control could not be committed reliably for chronology-sensitive offer, contract, decline, and task submissions through this in-app browser surface. Those rows are marked BLOCKED when API corroboration was used; pure browser UI validations and the browser-capable workflows remain PASS.
- All 84 CSV cases are terminal: 27 PASS and 57 BLOCKED. BLOCKED rows identify the unavailable clock, fault-injection, identity, side-effect, or native-control capability; they are not product failures.
- No confirmed product defect was discovered in these transitions. The incorrect recipient UUID used during setup was a fixture-input error and produced `RECIPIENT_UNAVAILABLE`; correcting it succeeded without a source change.
- Historical receipts in `RESULTS.md` cover the prior browser campaign and remain separate evidence; they are not silently counted as current submissions.
