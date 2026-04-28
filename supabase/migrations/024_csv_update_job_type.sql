-- Extend jobs.type with `csv_update` so the import wizard's Update mode
-- can write its background job under a distinct type from `csv_import`.
-- Same job-row shape, same `after()` runner pattern; the type is the
-- only thing that differs and downstream filters (e.g., /jobs UI, canary
-- queries) rely on it being explicit.

alter table jobs drop constraint jobs_type_check;
alter table jobs add constraint jobs_type_check check (type = any (array[
  'csv_import'::text,
  'csv_update'::text,
  'cass_dsf2_ncoa'::text,
  'cass_refresh'::text,
  'ncoa_refresh'::text,
  'agent_lookup'::text,
  'regrid_lookup'::text,
  'skip_trace'::text,
  'direct_mail_campaign'::text,
  'bulk_sms'::text,
  'data_export'::text,
  'property_merge'::text,
  'sweeper'::text,
  'send_sms'::text,
  'send_email'::text
]));
