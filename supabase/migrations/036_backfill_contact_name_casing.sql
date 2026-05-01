-- Backfill first_name / last_name on contacts to title-case.
-- Uses Postgres initcap() which uppercases the first letter of each word.
-- WHERE clause skips rows that are already correct or NULL so re-running is safe.

UPDATE contacts
SET first_name = initcap(first_name)
WHERE first_name IS NOT NULL
  AND first_name != initcap(first_name);

UPDATE contacts
SET last_name = initcap(last_name)
WHERE last_name IS NOT NULL
  AND last_name != initcap(last_name);
