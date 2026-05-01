-- Backfill casing on all human-readable display fields that were stored
-- raw (all-caps) from DealMachine / PropStream exports.
-- Uses initcap() for text fields, lower() for email.
-- WHERE clauses make each statement idempotent on re-run.

UPDATE properties
SET address = initcap(address)
WHERE address IS NOT NULL
  AND address != initcap(address);

UPDATE properties
SET city = initcap(city)
WHERE city IS NOT NULL
  AND city != initcap(city);

UPDATE homeowner_details
SET mailing_address = initcap(mailing_address)
WHERE mailing_address IS NOT NULL
  AND mailing_address != initcap(mailing_address);

UPDATE homeowner_details
SET mailing_city = initcap(mailing_city)
WHERE mailing_city IS NOT NULL
  AND mailing_city != initcap(mailing_city);

UPDATE contacts
SET entity_name = initcap(entity_name)
WHERE entity_name IS NOT NULL
  AND entity_name != initcap(entity_name);

UPDATE contacts
SET email = lower(email)
WHERE email IS NOT NULL
  AND email != lower(email);
