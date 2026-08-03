-- Keep both genuinely unbounded lookups in Postgres.  The old page fetched
-- every cache address and every unread message, then sent large ID lists back
-- to PostgREST.  These views keep both joins server-side.
create view public.leads_board
with (security_invoker = true)
as
select
  p.id,
  p.address,
  p.city,
  p.state,
  p.zip,
  p.market,
  p.status,
  p.is_vacant,
  p.cass_status,
  p.absentee_flag,
  p.assigned_user_id,
  p.motivation_level,
  p.outreach_dispo,
  p.deleted_at,
  p.created_at,
  case when hc.id is null then null else jsonb_build_object(
    'first_name', hc.first_name,
    'last_name', hc.last_name,
    'entity_name', hc.entity_name
  ) end as homeowner,
  exists (
    select 1
    from public.messages m
    where m.property_id = p.id
      and m.direction = 'inbound'
      and m.read_at is null
  ) as has_unread
from public.properties p
left join public.contacts hc on hc.id = p.homeowner_contact_id
;

create view public.leads_unskip_traced
with (security_invoker = true)
as
select b.*
from public.leads_board b
where not exists (
  select 1
  from public.skip_trace_cache st
  -- This deliberately fixes the old page's broken comparison.  The old
  -- page compared st.address_normalized (the skip-trace writer's
  -- street|city|state[|zip] key) directly with properties.address_normalized
  -- (the ingest/CASS writer's free-form address string), so it excluded no
  -- normally written leads.  Rebuild the cache key from the property
  -- columns, matching normalizeAddress(): lowercase, trim, omit blank
  -- components, then join with '|'.  Therefore this filter intentionally
  -- changes the operator's "Not skip-traced" board: leads with a matching
  -- cache row now disappear from that board, and leads without one remain.
  where st.address_normalized = concat_ws(
    '|',
    nullif(lower(trim(b.address)), ''),
    nullif(lower(trim(b.city)), ''),
    nullif(lower(trim(b.state)), ''),
    nullif(lower(trim(b.zip)), '')
  )
);
