-- Addresses advisor performance flag `unindexed_foreign_keys`.
-- Covering indexes for every FK column that wasn't already indexed.

create index idx_agent_details_org on agent_details (org_id);
create index idx_cass_cache_org on cass_cache (org_id);
create index idx_contacts_org on contacts (org_id);
create index idx_counties_org on counties (org_id);
create index idx_csv_imports_org on csv_imports (org_id);
create index idx_csv_imports_user on csv_imports (user_id) where user_id is not null;
create index idx_homeowner_details_org on homeowner_details (org_id);
create index idx_jobs_org on jobs (org_id);
create index idx_messages_org on messages (org_id);
create index idx_properties_county on properties (county_id) where county_id is not null;
create index idx_properties_org on properties (org_id);
create index idx_property_merges_merged_by on property_merges (merged_by) where merged_by is not null;
create index idx_property_merges_org on property_merges (org_id);
create index idx_zip_county_xref_fips on zip_county_xref (fips_code);
