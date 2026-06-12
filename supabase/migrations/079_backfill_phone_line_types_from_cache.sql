-- 079: backfill phone line types from cached skip-trace results, then
-- promote a known-mobile into slot 1 where slot 1 is a landline.
--
-- skip_trace_cache rows hold the full provider result JSON including
-- per-phone `type` ("Mobile"/"Landline"). The June 2026 batch run
-- (12,225 rows) is all in there, so this backfill classifies every
-- skip-traced number at zero provider cost. Contacts whose phones never
-- went through skip trace stay 'unknown'.
--
-- Idempotent: re-running re-derives the same types; the promotion step
-- only fires while a landline sits in slot 1 with a mobile behind it.

-- Stage the distinct number→type map once. Last-10-digit matching:
-- contacts store E.164 ("+18165551234"), the cache stores the raw
-- 10-digit form Tracerfy returns.
create temporary table _cache_line_types on commit drop as
select distinct on (num10) num10, line_type
from (
  select right(ph->>'number', 10) as num10,
         lower(ph->>'type')       as line_type
  from skip_trace_cache,
       jsonb_array_elements(
         jsonb_path_query_array(result, '$.persons[*].phones[*]')
       ) as ph
  where ph->>'type' in ('Mobile', 'Landline')
) src
order by num10, line_type;  -- deterministic on conflicting labels ('landline' < 'mobile' = safe side)

create index on _cache_line_types (num10);

update contacts c
set phone_1_type = t.line_type
from _cache_line_types t
where c.phone_1 is not null
  and t.num10 = right(c.phone_1, 10)
  and c.phone_1_type = 'unknown';

update contacts c
set phone_2_type = t.line_type
from _cache_line_types t
where c.phone_2 is not null
  and t.num10 = right(c.phone_2, 10)
  and c.phone_2_type = 'unknown';

update contacts c
set phone_3_type = t.line_type
from _cache_line_types t
where c.phone_3 is not null
  and t.num10 = right(c.phone_3, 10)
  and c.phone_3_type = 'unknown';

-- Promote a mobile into slot 1 where slot 1 is a confirmed landline.
-- Everything sends to phone_1, so without this the contact is
-- untextable even though we KNOW a mobile for them.
--
-- Guards: contacts.phone_1 has a global unique index, so swap only when
-- the promoted number isn't already someone else's phone_1 and no other
-- row would promote the same number in this statement.

-- slot 2 → slot 1
update contacts c
set phone_1 = c.phone_2, phone_1_type = c.phone_2_type,
    phone_2 = c.phone_1, phone_2_type = c.phone_1_type
where c.phone_1_type = 'landline'
  and c.phone_2_type = 'mobile'
  and not exists (
    select 1 from contacts o
    where o.id <> c.id and o.phone_1 = c.phone_2
  )
  and not exists (
    select 1 from contacts o2
    where o2.id <> c.id
      and o2.phone_1_type = 'landline'
      and o2.phone_2_type = 'mobile'
      and o2.phone_2 = c.phone_2
  );

-- slot 3 → slot 1 (only when slot 2 wasn't a mobile)
update contacts c
set phone_1 = c.phone_3, phone_1_type = c.phone_3_type,
    phone_3 = c.phone_1, phone_3_type = c.phone_1_type
where c.phone_1_type = 'landline'
  and c.phone_2_type <> 'mobile'
  and c.phone_3_type = 'mobile'
  and not exists (
    select 1 from contacts o
    where o.id <> c.id and o.phone_1 = c.phone_3
  )
  and not exists (
    select 1 from contacts o2
    where o2.id <> c.id
      and o2.phone_1_type = 'landline'
      and o2.phone_2_type <> 'mobile'
      and o2.phone_3_type = 'mobile'
      and o2.phone_3 = c.phone_3
  );
