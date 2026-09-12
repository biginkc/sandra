# Residential purchase contract rollout

The website registration and lead send paths support two exact field schemas:

- Legacy v1: seller_name, property_address, offer_price, closing_date, earnest_money.
- Residential v1: seller_name, buyer_name, property_address, property_city, property_state, property_zip, legal_description, offer_price, earnest_money_holder, earnest_money, cash_balance, closing_date, additional_terms.

Residential `property_address` is the street portion. The form prefills street/city/state/ZIP independently and leaves contractual details for sender review. All residential fields except additional_terms are required. Required flags are attested against the provider; additional_terms must remain optional. Legacy embedded creation remains unchanged.

The app validates the payload against the selected template. The forward migration enforces the same rule, rejects schema changes on re-registration of an existing provider template, and checks stored fields against provider attestation before offering a template. Historical values and legacy send-intent hash ordering remain unchanged. Residential hashes include all thirteen fields.

## Verification and rollout

`npm run verify` includes a disposable local PostgreSQL rehearsal for registration, invalid field sets, provider account/schema drift, payload mismatch, optional terms, replay conflicts, retry snapshots, rollback and reapply. Set LOCAL_REHEARSAL_DATABASE_URL to an explicitly local database. UI coverage verifies the complete thirteen-field submission with separate address defaults.

Deploy via the normal PR and test-to-production migration workflows. Leave mode and sending controls as configured; this change does not activate live sending. After app and schema deploy, register and revalidate the correct residential website template. Remove the incorrect employment-letter test asset from selectable purchase choices while preserving history.

Before operational activation, separately verify the acquisitions shared address and Dropbox Sign account identity, account/app callback configuration and authentication, an authorized internal signing test, stored final PDF/audit, paid API entitlement and an authorized harmless live canary. Neither a unit-test pass nor a saved provider template proves live delivery. If rollout fails, disable new sends while retaining callbacks and existing requests; do not blindly replay uncertain sends.

## Verified shared signature allowances

Some accounts have a billing allowance shared by API, website and add-ons. The
provider account response has no documented plan discriminator. Do not infer a
shared plan from `is_paid_hs`, a zero API counter, or a positive document counter.

For an independently verified shared plan, set server-only
`DROPBOX_SIGN_QUOTA_POLICIES` to a JSON object keyed by exact provider account ID.
Each entry requires `basis: "shared_signature_requests"`, the verified `plan`
label, positive integer `allowance`, and ISO `verifiedAt`/`validUntil` timestamps.
Reverify billing and refresh the attestation before the next billing boundary;
windows longer than 32 days are rejected. Never record keys or passwords here.
An account email change does not transfer policy to a different provider account.

Live checks fetch the account afresh and require its ID to match the stored ID.
An attested account uses `documents_left`; other accounts use the API counter.
Malformed or expired configured attestations fail closed. Balances must be
nonnegative safe integers and cannot exceed the attested allowance. The existing
10-request reserve, monthly 40-request fuse and test/live controls remain active.
Configuration does not authorize a live request or a subscription change.
