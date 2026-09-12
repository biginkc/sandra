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
