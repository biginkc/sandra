-- 078: per-slot phone line types on contacts.
--
-- Tracerfy (skip trace) and PropStream (CSV import) both label every
-- phone as Mobile or Landline; until now both ingest paths dropped the
-- label, so SMS campaigns texted landlines (~50% of the first live
-- campaign couldn't deliver). These columns persist the label per slot.
--
-- 'unknown' = number was never classified (legacy CSV imports). The
-- send path hard-blocks 'landline'; bulk SMS additionally excludes
-- 'unknown' unless the operator opts in at the audience-assessment step.

alter table contacts
  add column if not exists phone_1_type text not null default 'unknown'
    check (phone_1_type in ('mobile', 'landline', 'unknown')),
  add column if not exists phone_2_type text not null default 'unknown'
    check (phone_2_type in ('mobile', 'landline', 'unknown')),
  add column if not exists phone_3_type text not null default 'unknown'
    check (phone_3_type in ('mobile', 'landline', 'unknown'));

comment on column contacts.phone_1_type is
  'Line type of phone_1: mobile | landline | unknown. Source: skip-trace provider or CSV vendor label. SMS sends are blocked for landline.';
