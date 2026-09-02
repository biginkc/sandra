-- A valid normalized phone must survive single-lead intake even when the
-- optional carrier lookup is unconfigured, temporarily unavailable, or
-- unable to identify the line type. The type stays `unknown` until it can be
-- enriched later; existing call/SMS eligibility rules remain authoritative.
--
-- CSV import keeps its stricter bulk guard in `compactTypedPhones()`, which
-- drops unlabeled numbers before any contacts write and is covered by focused
-- ingest tests. A global trigger is therefore both too broad and redundant for
-- the bulk path it was created to protect.

drop trigger if exists contacts_phone_type_required on public.contacts;
drop function if exists public.enforce_phone_type_on_write();
