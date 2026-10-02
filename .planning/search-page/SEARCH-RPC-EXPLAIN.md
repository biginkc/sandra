# search_properties plans (volume-seeded sandbox, authenticated role)

Sandbox `sandra-search-e2e` (54322, identity checked), PG 17.6, 50k properties / 60k contacts / 250k SMS, all four
migrations (110000, 110050, 110055, 110100). Run as `supabase_admin` with `set role authenticated` and JWT claims for
the seeded owner; `auto_explain` (log_nested_statements, log_analyze, log_buffers) notices captured from the client
(the plans of the dynamic EXECUTE inside the plpgsql function). `select count(*) from search_properties(q, true)`, warm.

| query | branch / index used | rows | time |
|---|---|---|---|
| `1500 vol st` | properties_search_text_gin (bitmap); contacts/messages branches empty | 5 | 5.3 ms |
| `Smith` | contacts_search_text_gin (1200 contacts) -> idx_properties_homeowner_contact; final join is a Seq Scan of properties (hash semi-join, 13 ms) | 1000 | 24.6 ms |
| `(816) 000-0100` | contacts_phone_digits_gin (structured phone), BitmapOr with contacts_search_text_gin | 1 | 3.1 ms |
| `roofing` | messages_fts_gin (2600 hits); final join Seq Scan of properties | 1270 | 27.6 ms |

Observation: every text branch uses its trigram/FTS GIN index. When the candidate set is large (>1k) the planner
finishes with a hash semi-join over a Seq Scan of properties (about 12 ms at 50k rows); that scan is the floor for
broad matches and grows with table size.

## Raw plans (excerpts, full captured output below)

```
#### street name (properties_search_text_gin) q="1500 vol st" rows=5 wall_ms=7
duration: 0.016 ms  plan:
Query Text: 
  select case when bool_or(length(token) >= 3)
    then to_tsquery('simple', string_agg(token || ':*', ' & ' order by ordinal))
    else null end
  from (
    select token, ordinal
    from regexp_split_to_table(regexp_replace(lower(coalesce(q,'')), '[^[:alnum:]]+', ' ', 'g'), ' +') with ordinality as tokens(token, ordinal)
    where token <> ''
    order by ordinal
    limit 6
  ) words;

Query Parameters: $1 = '1500 vol st'
Aggregate  (cost=0.16..0.42 rows=1 width=32) (actual time=0.015..0.016 rows=1 loops=1)
  ->  Limit  (cost=0.01..0.08 rows=6 width=40) (actual time=0.006..0.007 rows=3 loops=1)
        ->  Function Scan on regexp_split_to_table tokens  (cost=0.01..12.51 rows=995 width=40) (actual time=0.006..0.006 rows=3 loops=1)
              Filter: (token <> ''::text)
duration: 0.014 ms  plan:
Query Text: 
  select case when bool_or(length(token) >= 3)
    then to_tsquery('simple', string_agg(token || ':*', ' & ' order by ordinal))
    else null end
  from (
    select token, ordinal
    from regexp_split_to_table(regexp_replace(lower(coalesce(q,'')), '[^[:alnum:]]+', ' ', 'g'), ' +') with ordinality as tokens(token, ordinal)
    where token <> ''
    order by ordinal
    limit 6
  ) words;

Query Parameters: $1 = '1500 vol st'
Aggregate  (cost=0.16..0.42 rows=1 width=32) (actual time=0.013..0.013 rows=1 loops=1)
  ->  Limit  (cost=0.01..0.08 rows=6 width=40) (actual time=0.006..0.007 rows=3 loops=1)
        ->  Function Scan on regexp_split_to_table tokens  (cost=0.01..12.51 rows=995 width=40) (actual time=0.006..0.007 rows=3 loops=1)
              Filter: (token <> ''::text)
duration: 1.097 ms  plan:
Query Text: 
  with visible_orgs as (
    select m.org_id from public.memberships m
    where m.user_id = auth.uid() and m.access_status = 'active'
      and m.deletion_prepared_at is null
      and (m.access_expires_at is null or m.access_expires_at > now())
  ), bounds as not materialized (
    select rtrim(left(btrim(regexp_replace(coalesce($1,''), '\s+', ' ', 'g')),100)) as q
  ), input as not materialized (
    select bounds.q,
      (length(regexp_replace(bounds.q,'[^0-9]','','g')) >= 3
        and 10 * length(regexp_replace(bounds.q,'[^0-9]','','g'))
            >= 7 * length(regexp_replace(bounds.q,'\s','','g'))) as is_structured,
      case when regexp_replace(bounds.q,'[^0-9]','','g') ~ '^1[0-9]{10}$'
        then substr(regexp_replace(bounds.q,'[^0-9]','','g'), 2)
        else regexp_replace(bounds.q,'[^0-9]','','g') end as qd,
      replace(replace(replace(lower(bounds.q), E'\\', E'\\\\'), '%', E'\\%'), '_', E'\\_') as q_like,
      public.search_prefix_tsquery(bounds.q) as tsq
    from bounds where length(bounds.q) >= 3
  ), property_ids as (
    select p.id
    from public.properties p cross join input i
    where p.org_id in (select org_id from visible_orgs) and p.deleted_at is null
      and p.search_text ilike '%' || i.q_like || '%' escape E'\\'
  ), contact_ids as (
    select c.id, c.org_id
    from public.contacts c cross join input i
    where c.org_id in (select org_id from visible_orgs) and (
      c.search_text ilike '%' || i.q_like || '%' escape E'\\'
      or (i.is_structured and length(i.qd) >= 3 and c.phone_digits ilike '%' || i.qd || '%')
    )
  ), contact_property_ids as (
    select p.id
    from contact_ids c
    join public.properties p
      on p.org_id = c.org_id
     and (p.homeowner_contact_id = c.id or p.agent_contact_id = c.id)
    where p.org_id in (select org_id from visible_orgs) and p.deleted_at is null
  ), message_property_ids as (
    select mp.id
    from public.messages m
    join public.properties mp on mp.id = m.property_id and mp.org_id = m.org_id
    cross join input i
    where $2 is true
      and mp.org_id in (select org_id from visible_orgs) and mp.deleted_at is null
      and m.org_id in (select org_id from visible_orgs)
      and i.tsq is not null and m.channel = 'sms'
      and m.conversation_id is not null and m.property_id is not null
      and m.fts @@ i.tsq
  ), candidate_ids as (
    select id from property_ids
    union select id from contact_property_ids
    union select id from message_property_ids
  )
  select p.*
  from public.properties p
  where p.id in (select id from candidate_ids)
    and p.org_id in (select org_id from visible_orgs)
    and p.deleted_at is null;
  
Query Parameters: $1 = '1500 vol st', $2 = 't'
Hash Semi Join  (cost=798.71..874.34 rows=7 width=1170) (actual time=1.071..1.091 rows=5 loops=1)
  Hash Cond: (p.org_id = visible_orgs.org_id)
  Buffers: shared hit=216
  CTE visible_orgs
    ->  Index Scan using idx_memberships_user_id on memberships m_1  (cost=0.17..8.20 rows=1 width=16) (actual time=0.014..0.015 rows=1 loops=1)
          Index Cond: (user_id = (COALESCE(NULLIF(current_setting('request.jwt.claim.sub'::text, true), ''::text), ((NULLIF(current_setting('request.jwt.claims'::text, true), ''::text))::jsonb ->> 'sub'::text)))::uuid)
          Filter: ((deletion_prepared_at IS NULL) AND (access_status = 'active'::text) AND ((access_expires_at IS NULL) OR (access_expires_at > now())))
          Buffers: shared hit=2
  ->  Nested Loop  (cost=790.48..866.01 rows=9 width=1170) (actual time=1.037..1.056 rows=5 loops=1)
        Buffers: shared hit=214
        ->  Unique  (cost=790.07..790.11 rows=9 width=16) (actual time=1.029..1.033 rows=5 loops=1)
              Buffers: shared hit=194
              ->  Sort  (cost=790.07..790.09 rows=9 width=16) (actual time=1.028..1.032 rows=5 loops=1)
                    Sort Key: p_1.id
                    Sort Method: quicksort  Memory: 25kB
                    Buffers: shared hit=194
                    ->  Append  (cost=94.70..789.93 rows=9 width=16) (actual time=0.967..1.027 rows=5 loops=1)
                          Buffers: shared hit=194
                          ->  Hash Semi Join  (cost=94.70..114.15 rows=4 width=16) (actual time=0.966..0.977 rows=5 loops=1)
                                Hash Cond: (p_1.org_id = visible_orgs_1.org_id)
                                Buffers: shared hit=169
                                ->  Bitmap Heap Scan on properties p_1  (cost=94.67..114.06 rows=5 width=32) (actual time=0.959..0.969 rows=5 loops=1)
                                      Recheck Cond: (search_text ~~* '%1500 vol st%'::text)
                                      Rows Removed by Index Recheck: 1
                                      Filter: (deleted_at IS NULL)
                                      Heap Blocks: exact=6
                                      Buffers: shared hit=169
                                      ->  Bitmap Index Scan on properties_search_text_gin  (cost=0.00..94.67 rows=5 width=0) (actual time=0.948..0.948 rows=6 loops=1)
                                            Index Cond: (search_text ~~* '%1500 vol st%'::text)
                                            Buffers: shared hit=163
                                ->  Hash  (cost=0.02..0.02 rows=1 width=16) (actual time=0.004..0.005 rows=1 loops=1)
                                      Buckets: 1024  Batches: 1  Memory Usage: 9kB
                                      ->  CTE Scan on visible_orgs visible_orgs_1  (cost=0.00..0.02 rows=1 width=16) (actual time=0.000..0.001 rows=1 loops=1)
                          ->  Nested Loop  (cost=95.83..150.74 rows=3 width=16) (actual time=0.035..0.036 rows=0 loops=1)
                                Buffers: shared hit=21
                                ->  Hash Semi Join  (cost=90.60..113.74 rows=4 width=64) (actual time=0.035..0.035 rows=0 loops=1)
                                      Hash Cond: (c.org_id = visible_orgs_2.org_id)
                                      Buffers: shared hit=21
                                      ->  Nested Loop  (cost=90.57..113.65 rows=5 width=48) (actual time=0.032..0.033 rows=0 loops=1)
                                            Join Filter: (c.org_id = visible_orgs_3.org_id)
                                            Buffers: shared hit=21
                                            ->  HashAggregate  (cost=0.02..0.03 rows=1 width=16) (actual time=0.002..0.003 rows=1 loops=1)
                                                  Group Key: visible_orgs_3.org_id
                                                  Batches: 1  Memory Usage: 24kB
                                                  ->  CTE Scan on visible_orgs visible_orgs_3  (cost=0.00..0.02 rows=1 width=16) (actual time=0.000..0.000 rows=1 loops=1)
                                            ->  Bitmap Heap Scan on contacts c  (cost=90.55..113.54 rows=6 width=32) (actual time=0.029..0.029 rows=0 loops=1)
                                                  Recheck Cond: (search_text ~~* '%1500 vol st%'::text)
                                                  Buffers: shared hit=21
                                                  ->  Bitmap Index Scan on contacts_search_text_gin  (cost=0.00..90.55 rows=6 width=0) (actual time=0.027..0.027 rows=0 loops=1)
                                                        Index Cond: (search_text ~~* '%1500 vol st%'::text)
                                                        Buffers: shared hit=21
                                      ->  Hash  (cost=0.02..0.02 rows=1 width=16) (actual time=0.000..0.001 rows=1 loops=1)
                                            Buckets: 1024  Batches: 1  Memory Usage: 9kB
                                            ->  CTE Scan on visible_orgs visible_orgs_2  (cost=0.00..0.02 rows=1 width=16) (actual time=0.000..0.000 rows=1 loops=1)
                                ->  Bitmap Heap Scan on properties p_2  (cost=5.22..9.24 rows=1 width=64) (never executed)
                                      Recheck Cond: ((homeowner_contact_id = c.id) OR (agent_contact_id = c.id))
                                      Filter: ((deleted_at IS NULL) AND (c.org_id = org_id))
                                      ->  BitmapOr  (cost=5.22..5.22 rows=1 width=0) (never executed)
                                            ->  Bitmap Index Scan on idx_properties_homeowner_contact  (cost=0.00..4.42 rows=1 width=0) (never executed)
                                                  Index Cond: (homeowner_contact_id = c.id)
                                            ->  Bitmap Index Scan on idx_properties_agent_contact  (cost=0.00..0.80 rows=1 width=0) (never executed)
                                                  Index Cond: (agent_contact_id = c.id)
                          ->  Nested Loop Semi Join  (cost=500.49..524.99 rows=2 width=16) (actual time=0.011..0.012 rows=0 loops=1)
                                Join Filter: (mp.org_id = visible_orgs_5.org_id)
                                Buffers: shared hit=4
                                ->  Nested Loop Semi Join  (cost=500.49..524.93 rows=2 width=64) (actual time=0.011..0.012 rows=0 loops=1)
                                      Join Filter: (mp.org_id = visible_orgs_4.org_id)
                                      Buffers: shared hit=4
                                      ->  Nested Loop  (cost=500.49..524.88 rows=2 width=48) (actual time=0.011..0.011 rows=0 loops=1)
                                            Buffers: shared hit=4
                                            ->  Bitmap Heap Scan on messages m  (cost=500.08..508.01 rows=2 width=32) (actual time=0.011..0.011 rows=0 loops=1)
                                                  Recheck Cond: (fts @@ '''1500'':* & ''vol'':* & ''st'':*'::tsquery)
                                                  Filter: ((conversation_id IS NOT NULL) AND (property_id IS NOT NULL) AND (channel = 'sms'::text))
                                                  Buffers: shared hit=4
                                                  ->  Bitmap Index Scan on messages_fts_gin  (cost=0.00..500.08 rows=2 width=0) (actual time=0.004..0.004 rows=0 loops=1)
                                                        Index Cond: (fts @@ '''1500'':* & ''vol'':* & ''st'':*'::tsquery)
                                                        Buffers: shared hit=4
                                            ->  Index Scan using properties_id_org_id_key on properties mp  (cost=0.41..8.43 rows=1 width=32) (never executed)
                                                  Index Cond: ((id = m.property_id) AND (org_id = m.org_id))
                                                  Filter: (deleted_at IS NULL)
                                      ->  CTE Scan on visible_orgs visible_orgs_4  (cost=0.00..0.02 rows=1 width=16) (never executed)
                                ->  CTE Scan on visible_orgs visible_orgs_5  (cost=0.00..0.02 rows=1 width=16) (never executed)
        ->  Index Scan using properties_id_org_id_key on properties p  (cost=0.41..8.43 rows=1 width=1170) (actual time=0.004..0.004 rows=1 loops=5)
              Index Cond: (id = p_1.id)
              Filter: (deleted_at IS NULL)
              Buffers: shared hit=20
  ->  Hash  (cost=0.02..0.02 rows=1 width=16) (actual time=0.017..0.017 rows=1 loops=1)
        Buckets: 1024  Batches: 1  Memory Usage: 9kB
        Buffers: shared hit=2
        ->  CTE Scan on visible_orgs  (cost=0.00..0.02 rows=1 width=16) (actual time=0.015..0.016 rows=1 loops=1)
              Buffers: shared hit=2
duration: 5.331 ms  plan:
Query Text: select count(*) from public.search_properties($1, true)
Query Parameters: $1 = '1500 vol st'
Aggregate  (cost=12.75..12.76 rows=1 width=8) (actual time=5.328..5.328 rows=1 loops=1)
  Buffers: shared hit=322
  ->  Function Scan on search_properties  (cost=0.25..10.25 rows=1000 width=0) (actual time=5.325..5.325 rows=5 loops=1)
        Buffers: shared hit=322
#### surname (contacts_search_text_gin) q="Smith" rows=1000 wall_ms=30
duration: 0.022 ms  plan:
Query Text: 
  select case when bool_or(length(token) >= 3)
    then to_tsquery('simple', string_agg(token || ':*', ' & ' order by ordinal))
    else null end
  from (
    select token, ordinal
    from regexp_split_to_table(regexp_replace(lower(coalesce(q,'')), '[^[:alnum:]]+', ' ', 'g'), ' +') with ordinality as tokens(token, ordinal)
    where token <> ''
    order by ordinal
    limit 6
  ) words;

Query Parameters: $1 = 'Smith'
Aggregate  (cost=0.16..0.42 rows=1 width=32) (actual time=0.021..0.021 rows=1 loops=1)
  ->  Limit  (cost=0.01..0.08 rows=6 width=40) (actual time=0.011..0.011 rows=1 loops=1)
        ->  Function Scan on regexp_split_to_table tokens  (cost=0.01..12.51 rows=995 width=40) (actual time=0.010..0.010 rows=1 loops=1)
              Filter: (token <> ''::text)
duration: 0.007 ms  plan:
Query Text: 
  select case when bool_or(length(token) >= 3)
    then to_tsquery('simple', string_agg(token || ':*', ' & ' order by ordinal))
    else null end
  from (
    select token, ordinal
    from regexp_split_to_table(regexp_replace(lower(coalesce(q,'')), '[^[:alnum:]]+', ' ', 'g'), ' +') with ordinality as tokens(token, ordinal)
    where token <> ''
    order by ordinal
    limit 6
  ) words;

Query Parameters: $1 = 'Smith'
Aggregate  (cost=0.16..0.42 rows=1 width=32) (actual time=0.006..0.007 rows=1 loops=1)
  ->  Limit  (cost=0.01..0.08 rows=6 width=40) (actual time=0.003..0.004 rows=1 loops=1)
        ->  Function Scan on regexp_split_to_table tokens  (cost=0.01..12.51 rows=995 width=40) (actual time=0.003..0.003 rows=1 loops=1)
              Filter: (token <> ''::text)
duration: 24.581 ms  plan:
Query Text: 
  with visible_orgs as (
    select m.org_id from public.memberships m
    where m.user_id = auth.uid() and m.access_status = 'active'
      and m.deletion_prepared_at is null
      and (m.access_expires_at is null or m.access_expires_at > now())
  ), bounds as not materialized (
    select rtrim(left(btrim(regexp_replace(coalesce($1,''), '\s+', ' ', 'g')),100)) as q
  ), input as not materialized (
    select bounds.q,
      (length(regexp_replace(bounds.q,'[^0-9]','','g')) >= 3
        and 10 * length(regexp_replace(bounds.q,'[^0-9]','','g'))
            >= 7 * length(regexp_replace(bounds.q,'\s','','g'))) as is_structured,
      case when regexp_replace(bounds.q,'[^0-9]','','g') ~ '^1[0-9]{10}$'
        then substr(regexp_replace(bounds.q,'[^0-9]','','g'), 2)
        else regexp_replace(bounds.q,'[^0-9]','','g') end as qd,
      replace(replace(replace(lower(bounds.q), E'\\', E'\\\\'), '%', E'\\%'), '_', E'\\_') as q_like,
      public.search_prefix_tsquery(bounds.q) as tsq
    from bounds where length(bounds.q) >= 3
  ), property_ids as (
    select p.id
    from public.properties p cross join input i
    where p.org_id in (select org_id from visible_orgs) and p.deleted_at is null
      and p.search_text ilike '%' || i.q_like || '%' escape E'\\'
  ), contact_ids as (
    select c.id, c.org_id
    from public.contacts c cross join input i
    where c.org_id in (select org_id from visible_orgs) and (
      c.search_text ilike '%' || i.q_like || '%' escape E'\\'
      or (i.is_structured and length(i.qd) >= 3 and c.phone_digits ilike '%' || i.qd || '%')
    )
  ), contact_property_ids as (
    select p.id
    from contact_ids c
    join public.properties p
      on p.org_id = c.org_id
     and (p.homeowner_contact_id = c.id or p.agent_contact_id = c.id)
    where p.org_id in (select org_id from visible_orgs) and p.deleted_at is null
  ), message_property_ids as (
    select mp.id
    from public.messages m
    join public.properties mp on mp.id = m.property_id and mp.org_id = m.org_id
    cross join input i
    where $2 is true
      and mp.org_id in (select org_id from visible_orgs) and mp.deleted_at is null
      and m.org_id in (select org_id from visible_orgs)
      and i.tsq is not null and m.channel = 'sms'
      and m.conversation_id is not null and m.property_id is not null
      and m.fts @@ i.tsq
  ), candidate_ids as (
    select id from property_ids
    union select id from contact_property_ids
    union select id from message_property_ids
  )
  select p.*
  from public.properties p
  where p.id in (select id from candidate_ids)
    and p.org_id in (select org_id from visible_orgs)
    and p.deleted_at is null;
  
Query Parameters: $1 = 'Smith', $2 = 't'
Hash Semi Join  (cost=11633.53..14820.76 rows=2566 width=1170) (actual time=7.052..23.814 rows=1000 loops=1)
  Hash Cond: (p.org_id = visible_orgs.org_id)
  Buffers: shared hit=10737
  CTE visible_orgs
    ->  Index Scan using idx_memberships_user_id on memberships m_1  (cost=0.17..8.20 rows=1 width=16) (actual time=0.011..0.012 rows=1 loops=1)
          Index Cond: (user_id = (COALESCE(NULLIF(current_setting('request.jwt.claim.sub'::text, true), ''::text), ((NULLIF(current_setting('request.jwt.claims'::text, true), ''::text))::jsonb ->> 'sub'::text)))::uuid)
          Filter: ((deletion_prepared_at IS NULL) AND (access_status = 'active'::text) AND ((access_expires_at IS NULL) OR (access_expires_at > now())))
          Buffers: shared hit=2
  ->  Hash Join  (cost=11625.30..14775.56 rows=3207 width=1170) (actual time=7.033..23.532 rows=1000 loops=1)
        Hash Cond: (p.id = p_1.id)
        Buffers: shared hit=10735
        ->  Seq Scan on properties p  (cost=0.00..3019.00 rows=50000 width=1170) (actual time=0.006..12.872 rows=50000 loops=1)
              Filter: (deleted_at IS NULL)
              Buffers: shared hit=2519
        ->  Hash  (cost=11585.21..11585.21 rows=3207 width=16) (actual time=7.006..7.017 rows=1000 loops=1)
              Buckets: 4096  Batches: 1  Memory Usage: 79kB
              Buffers: shared hit=8216
              ->  HashAggregate  (cost=11553.14..11585.21 rows=3207 width=16) (actual time=6.863..6.945 rows=1000 loops=1)
                    Group Key: p_1.id
                    Batches: 1  Memory Usage: 177kB
                    Buffers: shared hit=8216
                    ->  Append  (cost=34.36..11545.13 rows=3207 width=16) (actual time=0.297..6.625 rows=1000 loops=1)
                          Buffers: shared hit=8216
                          ->  Hash Semi Join  (cost=34.36..53.81 rows=4 width=16) (actual time=0.016..0.018 rows=0 loops=1)
                                Hash Cond: (p_1.org_id = visible_orgs_1.org_id)
                                Buffers: shared hit=7
                                ->  Bitmap Heap Scan on properties p_1  (cost=34.32..53.72 rows=5 width=32) (actual time=0.015..0.015 rows=0 loops=1)
                                      Recheck Cond: (search_text ~~* '%smith%'::text)
                                      Filter: (deleted_at IS NULL)
                                      Buffers: shared hit=7
                                      ->  Bitmap Index Scan on properties_search_text_gin  (cost=0.00..34.32 rows=5 width=0) (actual time=0.013..0.013 rows=0 loops=1)
                                            Index Cond: (search_text ~~* '%smith%'::text)
                                            Buffers: shared hit=7
                                ->  Hash  (cost=0.02..0.02 rows=1 width=16) (actual time=0.000..0.001 rows=1 loops=1)
                                      Buckets: 1024  Batches: 1  Memory Usage: 9kB
                                      ->  CTE Scan on visible_orgs visible_orgs_1  (cost=0.00..0.02 rows=1 width=16) (actual time=0.000..0.000 rows=1 loops=1)
                          ->  Nested Loop  (cost=35.48..90.40 rows=3 width=16) (actual time=0.280..6.493 rows=1000 loops=1)
                                Buffers: shared hit=8207
                                ->  Hash Semi Join  (cost=30.26..53.40 rows=4 width=64) (actual time=0.265..2.513 rows=1200 loops=1)
                                      Hash Cond: (c.org_id = visible_orgs_2.org_id)
                                      Buffers: shared hit=1207
                                      ->  Nested Loop  (cost=30.23..53.31 rows=5 width=48) (actual time=0.259..2.340 rows=1200 loops=1)
                                            Join Filter: (c.org_id = visible_orgs_3.org_id)
                                            Buffers: shared hit=1207
                                            ->  HashAggregate  (cost=0.02..0.03 rows=1 width=16) (actual time=0.002..0.004 rows=1 loops=1)
                                                  Group Key: visible_orgs_3.org_id
                                                  Batches: 1  Memory Usage: 24kB
                                                  ->  CTE Scan on visible_orgs visible_orgs_3  (cost=0.00..0.02 rows=1 width=16) (actual time=0.000..0.001 rows=1 loops=1)
                                            ->  Bitmap Heap Scan on contacts c  (cost=30.20..53.20 rows=6 width=32) (actual time=0.255..2.207 rows=1200 loops=1)
                                                  Recheck Cond: (search_text ~~* '%smith%'::text)
                                                  Heap Blocks: exact=1200
                                                  Buffers: shared hit=1207
                                                  ->  Bitmap Index Scan on contacts_search_text_gin  (cost=0.00..30.20 rows=6 width=0) (actual time=0.137..0.137 rows=1200 loops=1)
                                                        Index Cond: (search_text ~~* '%smith%'::text)
                                                        Buffers: shared hit=7
                                      ->  Hash  (cost=0.02..0.02 rows=1 width=16) (actual time=0.001..0.001 rows=1 loops=1)
                                            Buckets: 1024  Batches: 1  Memory Usage: 9kB
                                            ->  CTE Scan on visible_orgs visible_orgs_2  (cost=0.00..0.02 rows=1 width=16) (actual time=0.000..0.000 rows=1 loops=1)
                                ->  Bitmap Heap Scan on properties p_2  (cost=5.22..9.24 rows=1 width=64) (actual time=0.003..0.003 rows=1 loops=1200)
                                      Recheck Cond: ((homeowner_contact_id = c.id) OR (agent_contact_id = c.id))
                                      Filter: ((deleted_at IS NULL) AND (c.org_id = org_id))
                                      Heap Blocks: exact=1000
                                      Buffers: shared hit=7000
                                      ->  BitmapOr  (cost=5.22..5.22 rows=1 width=0) (actual time=0.002..0.002 rows=0 loops=1200)
                                            Buffers: shared hit=6000
                                            ->  Bitmap Index Scan on idx_properties_homeowner_contact  (cost=0.00..4.42 rows=1 width=0) (actual time=0.001..0.001 rows=1 loops=1200)
                                                  Index Cond: (homeowner_contact_id = c.id)
                                                  Buffers: shared hit=3600
                                            ->  Bitmap Index Scan on idx_properties_agent_contact  (cost=0.00..0.80 rows=1 width=0) (actual time=0.000..0.000 rows=0 loops=1200)
                                                  Index Cond: (agent_contact_id = c.id)
                                                  Buffers: shared hit=2400
                          ->  Hash Join  (cost=4290.73..11384.89 rows=3200 width=16) (actual time=0.025..0.028 rows=0 loops=1)
                                Hash Cond: ((m.property_id = mp.id) AND (m.org_id = mp.org_id))
                                Buffers: shared hit=2
                                ->  Hash Join  (cost=521.73..7599.09 rows=3200 width=64) (actual time=0.024..0.026 rows=0 loops=1)
                                      Hash Cond: (m.org_id = visible_orgs_4.org_id)
                                      Buffers: shared hit=2
                                      ->  Hash Semi Join  (cost=521.68..7552.04 rows=4000 width=48) (actual time=0.013..0.014 rows=0 loops=1)
                                            Hash Cond: (m.org_id = visible_orgs_5.org_id)
                                            Buffers: shared hit=2
                                            ->  Bitmap Heap Scan on messages m  (cost=521.65..7494.39 rows=5000 width=32) (actual time=0.008..0.009 rows=0 loops=1)
                                                  Recheck Cond: (fts @@ '''smith'':*'::tsquery)
                                                  Filter: ((conversation_id IS NOT NULL) AND (property_id IS NOT NULL) AND (channel = 'sms'::text))
                                                  Buffers: shared hit=2
                                                  ->  Bitmap Index Scan on messages_fts_gin  (cost=0.00..520.40 rows=5000 width=0) (actual time=0.006..0.006 rows=0 loops=1)
                                                        Index Cond: (fts @@ '''smith'':*'::tsquery)
                                                        Buffers: shared hit=2
                                            ->  Hash  (cost=0.02..0.02 rows=1 width=16) (actual time=0.004..0.004 rows=1 loops=1)
                                                  Buckets: 1024  Batches: 1  Memory Usage: 9kB
                                                  ->  CTE Scan on visible_orgs visible_orgs_5  (cost=0.00..0.02 rows=1 width=16) (actual time=0.000..0.000 rows=1 loops=1)
                                      ->  Hash  (cost=0.03..0.03 rows=1 width=16) (actual time=0.005..0.006 rows=1 loops=1)
                                            Buckets: 1024  Batches: 1  Memory Usage: 9kB
                                            ->  HashAggregate  (cost=0.02..0.03 rows=1 width=16) (actual time=0.004..0.004 rows=1 loops=1)
                                                  Group Key: visible_orgs_4.org_id
                                                  Batches: 1  Memory Usage: 24kB
                                                  ->  CTE Scan on visible_orgs visible_orgs_4  (cost=0.00..0.02 rows=1 width=16) (actual time=0.001..0.001 rows=1 loops=1)
                                ->  Hash  (cost=3019.00..3019.00 rows=50000 width=32) (never executed)
                                      ->  Seq Scan on properties mp  (cost=0.00..3019.00 rows=50000 width=32) (never executed)
                                            Filter: (deleted_at IS NULL)
  ->  Hash  (cost=0.02..0.02 rows=1 width=16) (actual time=0.013..0.014 rows=1 loops=1)
        Buckets: 1024  Batches: 1  Memory Usage: 9kB
        Buffers: shared hit=2
        ->  CTE Scan on visible_orgs  (cost=0.00..0.02 rows=1 width=16) (actual time=0.011..0.012 rows=1 loops=1)
              Buffers: shared hit=2
duration: 29.068 ms  plan:
Query Text: select count(*) from public.search_properties($1, true)
Query Parameters: $1 = 'Smith'
Aggregate  (cost=12.75..12.76 rows=1 width=8) (actual time=29.064..29.065 rows=1 loops=1)
  Buffers: shared hit=10843
  ->  Function Scan on search_properties  (cost=0.25..10.25 rows=1000 width=0) (actual time=28.990..29.030 rows=1000 loops=1)
        Buffers: shared hit=10843
#### full phone (contacts_phone_digits_gin) q="(816) 000-0100" rows=1 wall_ms=4
duration: 0.022 ms  plan:
Query Text: 
  select case when bool_or(length(token) >= 3)
    then to_tsquery('simple', string_agg(token || ':*', ' & ' order by ordinal))
    else null end
  from (
    select token, ordinal
    from regexp_split_to_table(regexp_replace(lower(coalesce(q,'')), '[^[:alnum:]]+', ' ', 'g'), ' +') with ordinality as tokens(token, ordinal)
    where token <> ''
    order by ordinal
    limit 6
  ) words;

Query Parameters: $1 = '(816) 000-0100'
Aggregate  (cost=0.16..0.42 rows=1 width=32) (actual time=0.021..0.021 rows=1 loops=1)
  ->  Limit  (cost=0.01..0.08 rows=6 width=40) (actual time=0.013..0.013 rows=3 loops=1)
        ->  Function Scan on regexp_split_to_table tokens  (cost=0.01..12.51 rows=995 width=40) (actual time=0.012..0.012 rows=3 loops=1)
              Filter: (token <> ''::text)
              Rows Removed by Filter: 1
duration: 0.010 ms  plan:
Query Text: 
  select case when bool_or(length(token) >= 3)
    then to_tsquery('simple', string_agg(token || ':*', ' & ' order by ordinal))
    else null end
  from (
    select token, ordinal
    from regexp_split_to_table(regexp_replace(lower(coalesce(q,'')), '[^[:alnum:]]+', ' ', 'g'), ' +') with ordinality as tokens(token, ordinal)
    where token <> ''
    order by ordinal
    limit 6
  ) words;

Query Parameters: $1 = '(816) 000-0100'
Aggregate  (cost=0.16..0.42 rows=1 width=32) (actual time=0.010..0.010 rows=1 loops=1)
  ->  Limit  (cost=0.01..0.08 rows=6 width=40) (actual time=0.006..0.006 rows=3 loops=1)
        ->  Function Scan on regexp_split_to_table tokens  (cost=0.01..12.51 rows=995 width=40) (actual time=0.006..0.006 rows=3 loops=1)
              Filter: (token <> ''::text)
              Rows Removed by Filter: 1
duration: 0.305 ms  plan:
Query Text: 
  with visible_orgs as (
    select m.org_id from public.memberships m
    where m.user_id = auth.uid() and m.access_status = 'active'
      and m.deletion_prepared_at is null
      and (m.access_expires_at is null or m.access_expires_at > now())
  ), bounds as not materialized (
    select rtrim(left(btrim(regexp_replace(coalesce($1,''), '\s+', ' ', 'g')),100)) as q
  ), input as not materialized (
    select bounds.q,
      (length(regexp_replace(bounds.q,'[^0-9]','','g')) >= 3
        and 10 * length(regexp_replace(bounds.q,'[^0-9]','','g'))
            >= 7 * length(regexp_replace(bounds.q,'\s','','g'))) as is_structured,
      case when regexp_replace(bounds.q,'[^0-9]','','g') ~ '^1[0-9]{10}$'
        then substr(regexp_replace(bounds.q,'[^0-9]','','g'), 2)
        else regexp_replace(bounds.q,'[^0-9]','','g') end as qd,
      replace(replace(replace(lower(bounds.q), E'\\', E'\\\\'), '%', E'\\%'), '_', E'\\_') as q_like,
      public.search_prefix_tsquery(bounds.q) as tsq
    from bounds where length(bounds.q) >= 3
  ), property_ids as (
    select p.id
    from public.properties p cross join input i
    where p.org_id in (select org_id from visible_orgs) and p.deleted_at is null
      and p.search_text ilike '%' || i.q_like || '%' escape E'\\'
  ), contact_ids as (
    select c.id, c.org_id
    from public.contacts c cross join input i
    where c.org_id in (select org_id from visible_orgs) and (
      c.search_text ilike '%' || i.q_like || '%' escape E'\\'
      or (i.is_structured and length(i.qd) >= 3 and c.phone_digits ilike '%' || i.qd || '%')
    )
  ), contact_property_ids as (
    select p.id
    from contact_ids c
    join public.properties p
      on p.org_id = c.org_id
     and (p.homeowner_contact_id = c.id or p.agent_contact_id = c.id)
    where p.org_id in (select org_id from visible_orgs) and p.deleted_at is null
  ), message_property_ids as (
    select mp.id
    from public.messages m
    join public.properties mp on mp.id = m.property_id and mp.org_id = m.org_id
    cross join input i
    where $2 is true
      and mp.org_id in (select org_id from visible_orgs) and mp.deleted_at is null
      and m.org_id in (select org_id from visible_orgs)
      and i.tsq is not null and m.channel = 'sms'
      and m.conversation_id is not null and m.property_id is not null
      and m.fts @@ i.tsq
  ), candidate_ids as (
    select id from property_ids
    union select id from contact_property_ids
    union select id from message_property_ids
  )
  select p.*
  from public.properties p
  where p.id in (select id from candidate_ids)
    and p.org_id in (select org_id from visible_orgs)
    and p.deleted_at is null;
  
Query Parameters: $1 = '(816) 000-0100', $2 = 't'
Hash Semi Join  (cost=959.19..1060.17 rows=10 width=1170) (actual time=0.298..0.302 rows=1 loops=1)
  Hash Cond: (p.org_id = visible_orgs.org_id)
  Buffers: shared hit=103
  CTE visible_orgs
    ->  Index Scan using idx_memberships_user_id on memberships m_1  (cost=0.17..8.20 rows=1 width=16) (actual time=0.010..0.010 rows=1 loops=1)
          Index Cond: (user_id = (COALESCE(NULLIF(current_setting('request.jwt.claim.sub'::text, true), ''::text), ((NULLIF(current_setting('request.jwt.claims'::text, true), ''::text))::jsonb ->> 'sub'::text)))::uuid)
          Filter: ((deletion_prepared_at IS NULL) AND (access_status = 'active'::text) AND ((access_expires_at IS NULL) OR (access_expires_at > now())))
          Buffers: shared hit=2
  ->  Nested Loop  (cost=950.96..1051.79 rows=12 width=1170) (actual time=0.284..0.287 rows=1 loops=1)
        Buffers: shared hit=101
        ->  Unique  (cost=950.54..950.60 rows=12 width=16) (actual time=0.277..0.281 rows=1 loops=1)
              Buffers: shared hit=97
              ->  Sort  (cost=950.54..950.57 rows=12 width=16) (actual time=0.277..0.280 rows=1 loops=1)
                    Sort Key: p_1.id
                    Sort Method: quicksort  Memory: 25kB
                    Buffers: shared hit=97
                    ->  Append  (cost=116.19..950.33 rows=12 width=16) (actual time=0.244..0.275 rows=1 loops=1)
                          Buffers: shared hit=97
                          ->  Hash Semi Join  (cost=116.19..135.64 rows=4 width=16) (actual time=0.030..0.031 rows=0 loops=1)
                                Hash Cond: (p_1.org_id = visible_orgs_1.org_id)
                                Buffers: shared hit=25
                                ->  Bitmap Heap Scan on properties p_1  (cost=116.16..135.55 rows=5 width=32) (actual time=0.027..0.028 rows=0 loops=1)
                                      Recheck Cond: (search_text ~~* '%(816) 000-0100%'::text)
                                      Filter: (deleted_at IS NULL)
                                      Buffers: shared hit=25
                                      ->  Bitmap Index Scan on properties_search_text_gin  (cost=0.00..116.16 rows=5 width=0) (actual time=0.025..0.025 rows=0 loops=1)
                                            Index Cond: (search_text ~~* '%(816) 000-0100%'::text)
                                            Buffers: shared hit=25
                                ->  Hash  (cost=0.02..0.02 rows=1 width=16) (actual time=0.001..0.001 rows=1 loops=1)
                                      Buckets: 1024  Batches: 1  Memory Usage: 9kB
                                      ->  CTE Scan on visible_orgs visible_orgs_1  (cost=0.00..0.02 rows=1 width=16) (actual time=0.000..0.001 rows=1 loops=1)
                          ->  Nested Loop  (cost=177.79..289.64 rows=6 width=16) (actual time=0.213..0.236 rows=1 loops=1)
                                Buffers: shared hit=68
                                ->  Hash Semi Join  (cost=172.91..218.31 rows=8 width=64) (actual time=0.205..0.227 rows=1 loops=1)
                                      Hash Cond: (c.org_id = visible_orgs_2.org_id)
                                      Buffers: shared hit=62
                                      ->  Nested Loop  (cost=172.87..218.16 rows=10 width=48) (actual time=0.203..0.224 rows=1 loops=1)
                                            Join Filter: (c.org_id = visible_orgs_3.org_id)
                                            Buffers: shared hit=62
                                            ->  HashAggregate  (cost=0.02..0.03 rows=1 width=16) (actual time=0.002..0.002 rows=1 loops=1)
                                                  Group Key: visible_orgs_3.org_id
                                                  Batches: 1  Memory Usage: 24kB
                                                  ->  CTE Scan on visible_orgs visible_orgs_3  (cost=0.00..0.02 rows=1 width=16) (actual time=0.000..0.000 rows=1 loops=1)
                                            ->  Bitmap Heap Scan on contacts c  (cost=172.85..217.98 rows=12 width=32) (actual time=0.198..0.219 rows=1 loops=1)
                                                  Recheck Cond: ((search_text ~~* '%(816) 000-0100%'::text) OR (phone_digits ~~* '%8160000100%'::text))
                                                  Rows Removed by Index Recheck: 4
                                                  Heap Blocks: exact=4
                                                  Buffers: shared hit=62
                                                  ->  BitmapOr  (cost=172.85..172.85 rows=12 width=0) (actual time=0.193..0.193 rows=0 loops=1)
                                                        Buffers: shared hit=58
                                                        ->  Bitmap Index Scan on contacts_search_text_gin  (cost=0.00..107.91 rows=6 width=0) (actual time=0.020..0.020 rows=0 loops=1)
                                                              Index Cond: (search_text ~~* '%(816) 000-0100%'::text)
                                                              Buffers: shared hit=23
                                                        ->  Bitmap Index Scan on contacts_phone_digits_gin  (cost=0.00..64.93 rows=6 width=0) (actual time=0.172..0.172 rows=5 loops=1)
                                                              Index Cond: (phone_digits ~~* '%8160000100%'::text)
                                                              Buffers: shared hit=35
                                      ->  Hash  (cost=0.02..0.02 rows=1 width=16) (actual time=0.001..0.001 rows=1 loops=1)
                                            Buckets: 1024  Batches: 1  Memory Usage: 9kB
                                            ->  CTE Scan on visible_orgs visible_orgs_2  (cost=0.00..0.02 rows=1 width=16) (actual time=0.000..0.000 rows=1 loops=1)
                                ->  Bitmap Heap Scan on properties p_2  (cost=4.89..8.91 rows=1 width=64) (actual time=0.008..0.009 rows=1 loops=1)
                                      Recheck Cond: ((homeowner_contact_id = c.id) OR (agent_contact_id = c.id))
                                      Filter: ((deleted_at IS NULL) AND (c.org_id = org_id))
                                      Heap Blocks: exact=1
                                      Buffers: shared hit=6
                                      ->  BitmapOr  (cost=4.89..4.89 rows=1 width=0) (actual time=0.005..0.005 rows=0 loops=1)
                                            Buffers: shared hit=5
                                            ->  Bitmap Index Scan on idx_properties_homeowner_contact  (cost=0.00..4.42 rows=1 width=0) (actual time=0.004..0.004 rows=1 loops=1)
                                                  Index Cond: (homeowner_contact_id = c.id)
                                                  Buffers: shared hit=3
                                            ->  Bitmap Index Scan on idx_properties_agent_contact  (cost=0.00..0.47 rows=1 width=0) (actual time=0.001..0.001 rows=0 loops=1)
                                                  Index Cond: (agent_contact_id = c.id)
                                                  Buffers: shared hit=2
                          ->  Nested Loop Semi Join  (cost=500.49..524.99 rows=2 width=16) (actual time=0.006..0.007 rows=0 loops=1)
                                Join Filter: (mp.org_id = visible_orgs_5.org_id)
                                Buffers: shared hit=4
                                ->  Nested Loop Semi Join  (cost=500.49..524.93 rows=2 width=64) (actual time=0.006..0.006 rows=0 loops=1)
                                      Join Filter: (mp.org_id = visible_orgs_4.org_id)
                                      Buffers: shared hit=4
                                      ->  Nested Loop  (cost=500.49..524.88 rows=2 width=48) (actual time=0.006..0.006 rows=0 loops=1)
                                            Buffers: shared hit=4
                                            ->  Bitmap Heap Scan on messages m  (cost=500.08..508.01 rows=2 width=32) (actual time=0.006..0.006 rows=0 loops=1)
                                                  Recheck Cond: (fts @@ '''816'':* & ''000'':* & ''0100'':*'::tsquery)
                                                  Filter: ((conversation_id IS NOT NULL) AND (property_id IS NOT NULL) AND (channel = 'sms'::text))
                                                  Buffers: shared hit=4
                                                  ->  Bitmap Index Scan on messages_fts_gin  (cost=0.00..500.08 rows=2 width=0) (actual time=0.003..0.003 rows=0 loops=1)
                                                        Index Cond: (fts @@ '''816'':* & ''000'':* & ''0100'':*'::tsquery)
                                                        Buffers: shared hit=4
                                            ->  Index Scan using properties_id_org_id_key on properties mp  (cost=0.41..8.43 rows=1 width=32) (never executed)
                                                  Index Cond: ((id = m.property_id) AND (org_id = m.org_id))
                                                  Filter: (deleted_at IS NULL)
                                      ->  CTE Scan on visible_orgs visible_orgs_4  (cost=0.00..0.02 rows=1 width=16) (never executed)
                                ->  CTE Scan on visible_orgs visible_orgs_5  (cost=0.00..0.02 rows=1 width=16) (never executed)
        ->  Index Scan using properties_id_org_id_key on properties p  (cost=0.41..8.43 rows=1 width=1170) (actual time=0.004..0.004 rows=1 loops=1)
              Index Cond: (id = p_1.id)
              Filter: (deleted_at IS NULL)
              Buffers: shared hit=4
  ->  Hash  (cost=0.02..0.02 rows=1 width=16) (actual time=0.012..0.012 rows=1 loops=1)
        Buckets: 1024  Batches: 1  Memory Usage: 9kB
        Buffers: shared hit=2
        ->  CTE Scan on visible_orgs  (cost=0.00..0.02 rows=1 width=16) (actual time=0.010..0.011 rows=1 loops=1)
              Buffers: shared hit=2
duration: 3.101 ms  plan:
Query Text: select count(*) from public.search_properties($1, true)
Query Parameters: $1 = '(816) 000-0100'
Aggregate  (cost=12.75..12.76 rows=1 width=8) (actual time=3.099..3.099 rows=1 loops=1)
  Buffers: shared hit=210
  ->  Function Scan on search_properties  (cost=0.25..10.25 rows=1000 width=0) (actual time=3.098..3.098 rows=1 loops=1)
        Buffers: shared hit=210
#### message word (messages_fts_gin) q="roofing" rows=1270 wall_ms=31
duration: 0.016 ms  plan:
Query Text: 
  select case when bool_or(length(token) >= 3)
    then to_tsquery('simple', string_agg(token || ':*', ' & ' order by ordinal))
    else null end
  from (
    select token, ordinal
    from regexp_split_to_table(regexp_replace(lower(coalesce(q,'')), '[^[:alnum:]]+', ' ', 'g'), ' +') with ordinality as tokens(token, ordinal)
    where token <> ''
    order by ordinal
    limit 6
  ) words;

Query Parameters: $1 = 'roofing'
Aggregate  (cost=0.16..0.42 rows=1 width=32) (actual time=0.016..0.016 rows=1 loops=1)
  ->  Limit  (cost=0.01..0.08 rows=6 width=40) (actual time=0.007..0.007 rows=1 loops=1)
        ->  Function Scan on regexp_split_to_table tokens  (cost=0.01..12.51 rows=995 width=40) (actual time=0.006..0.006 rows=1 loops=1)
              Filter: (token <> ''::text)
duration: 0.006 ms  plan:
Query Text: 
  select case when bool_or(length(token) >= 3)
    then to_tsquery('simple', string_agg(token || ':*', ' & ' order by ordinal))
    else null end
  from (
    select token, ordinal
    from regexp_split_to_table(regexp_replace(lower(coalesce(q,'')), '[^[:alnum:]]+', ' ', 'g'), ' +') with ordinality as tokens(token, ordinal)
    where token <> ''
    order by ordinal
    limit 6
  ) words;

Query Parameters: $1 = 'roofing'
Aggregate  (cost=0.16..0.42 rows=1 width=32) (actual time=0.005..0.005 rows=1 loops=1)
  ->  Limit  (cost=0.01..0.08 rows=6 width=40) (actual time=0.003..0.003 rows=1 loops=1)
        ->  Function Scan on regexp_split_to_table tokens  (cost=0.01..12.51 rows=995 width=40) (actual time=0.002..0.002 rows=1 loops=1)
              Filter: (token <> ''::text)
duration: 27.573 ms  plan:
Query Text: 
  with visible_orgs as (
    select m.org_id from public.memberships m
    where m.user_id = auth.uid() and m.access_status = 'active'
      and m.deletion_prepared_at is null
      and (m.access_expires_at is null or m.access_expires_at > now())
  ), bounds as not materialized (
    select rtrim(left(btrim(regexp_replace(coalesce($1,''), '\s+', ' ', 'g')),100)) as q
  ), input as not materialized (
    select bounds.q,
      (length(regexp_replace(bounds.q,'[^0-9]','','g')) >= 3
        and 10 * length(regexp_replace(bounds.q,'[^0-9]','','g'))
            >= 7 * length(regexp_replace(bounds.q,'\s','','g'))) as is_structured,
      case when regexp_replace(bounds.q,'[^0-9]','','g') ~ '^1[0-9]{10}$'
        then substr(regexp_replace(bounds.q,'[^0-9]','','g'), 2)
        else regexp_replace(bounds.q,'[^0-9]','','g') end as qd,
      replace(replace(replace(lower(bounds.q), E'\\', E'\\\\'), '%', E'\\%'), '_', E'\\_') as q_like,
      public.search_prefix_tsquery(bounds.q) as tsq
    from bounds where length(bounds.q) >= 3
  ), property_ids as (
    select p.id
    from public.properties p cross join input i
    where p.org_id in (select org_id from visible_orgs) and p.deleted_at is null
      and p.search_text ilike '%' || i.q_like || '%' escape E'\\'
  ), contact_ids as (
    select c.id, c.org_id
    from public.contacts c cross join input i
    where c.org_id in (select org_id from visible_orgs) and (
      c.search_text ilike '%' || i.q_like || '%' escape E'\\'
      or (i.is_structured and length(i.qd) >= 3 and c.phone_digits ilike '%' || i.qd || '%')
    )
  ), contact_property_ids as (
    select p.id
    from contact_ids c
    join public.properties p
      on p.org_id = c.org_id
     and (p.homeowner_contact_id = c.id or p.agent_contact_id = c.id)
    where p.org_id in (select org_id from visible_orgs) and p.deleted_at is null
  ), message_property_ids as (
    select mp.id
    from public.messages m
    join public.properties mp on mp.id = m.property_id and mp.org_id = m.org_id
    cross join input i
    where $2 is true
      and mp.org_id in (select org_id from visible_orgs) and mp.deleted_at is null
      and m.org_id in (select org_id from visible_orgs)
      and i.tsq is not null and m.channel = 'sms'
      and m.conversation_id is not null and m.property_id is not null
      and m.fts @@ i.tsq
  ), candidate_ids as (
    select id from property_ids
    union select id from contact_property_ids
    union select id from message_property_ids
  )
  select p.*
  from public.properties p
  where p.id in (select id from candidate_ids)
    and p.org_id in (select org_id from visible_orgs)
    and p.deleted_at is null;
  
Query Parameters: $1 = 'roofing', $2 = 't'
Hash Semi Join  (cost=11672.39..14859.61 rows=2566 width=1170) (actual time=12.724..27.029 rows=1270 loops=1)
  Hash Cond: (p.org_id = visible_orgs.org_id)
  Buffers: shared hit=6418
  CTE visible_orgs
    ->  Index Scan using idx_memberships_user_id on memberships m_1  (cost=0.17..8.20 rows=1 width=16) (actual time=0.010..0.010 rows=1 loops=1)
          Index Cond: (user_id = (COALESCE(NULLIF(current_setting('request.jwt.claim.sub'::text, true), ''::text), ((NULLIF(current_setting('request.jwt.claims'::text, true), ''::text))::jsonb ->> 'sub'::text)))::uuid)
          Filter: ((deletion_prepared_at IS NULL) AND (access_status = 'active'::text) AND ((access_expires_at IS NULL) OR (access_expires_at > now())))
          Buffers: shared hit=2
  ->  Hash Join  (cost=11664.16..14814.42 rows=3207 width=1170) (actual time=12.706..26.835 rows=1270 loops=1)
        Hash Cond: (p.id = p_1.id)
        Buffers: shared hit=6416
        ->  Seq Scan on properties p  (cost=0.00..3019.00 rows=50000 width=1170) (actual time=0.007..11.283 rows=50000 loops=1)
              Filter: (deleted_at IS NULL)
              Buffers: shared hit=2519
        ->  Hash  (cost=11624.07..11624.07 rows=3207 width=16) (actual time=12.696..12.704 rows=1270 loops=1)
              Buckets: 4096  Batches: 1  Memory Usage: 92kB
              Buffers: shared hit=3897
              ->  HashAggregate  (cost=11592.00..11624.07 rows=3207 width=16) (actual time=12.511..12.605 rows=1270 loops=1)
                    Group Key: p_1.id
                    Batches: 1  Memory Usage: 177kB
                    Buffers: shared hit=3897
                    ->  Append  (cost=51.72..11583.98 rows=3207 width=16) (actual time=10.221..12.280 rows=2600 loops=1)
                          Buffers: shared hit=3897
                          ->  Hash Semi Join  (cost=51.72..71.17 rows=4 width=16) (actual time=0.010..0.011 rows=0 loops=1)
                                Hash Cond: (p_1.org_id = visible_orgs_1.org_id)
                                Buffers: shared hit=11
                                ->  Bitmap Heap Scan on properties p_1  (cost=51.69..71.08 rows=5 width=32) (actual time=0.008..0.008 rows=0 loops=1)
                                      Recheck Cond: (search_text ~~* '%roofing%'::text)
                                      Filter: (deleted_at IS NULL)
                                      Buffers: shared hit=11
                                      ->  Bitmap Index Scan on properties_search_text_gin  (cost=0.00..51.69 rows=5 width=0) (actual time=0.007..0.007 rows=0 loops=1)
                                            Index Cond: (search_text ~~* '%roofing%'::text)
                                            Buffers: shared hit=11
                                ->  Hash  (cost=0.02..0.02 rows=1 width=16) (actual time=0.001..0.001 rows=1 loops=1)
                                      Buckets: 1024  Batches: 1  Memory Usage: 9kB
                                      ->  CTE Scan on visible_orgs visible_orgs_1  (cost=0.00..0.02 rows=1 width=16) (actual time=0.000..0.000 rows=1 loops=1)
                          ->  Nested Loop  (cost=56.97..111.89 rows=3 width=16) (actual time=0.016..0.019 rows=0 loops=1)
                                Buffers: shared hit=11
                                ->  Hash Semi Join  (cost=51.75..74.89 rows=4 width=64) (actual time=0.016..0.018 rows=0 loops=1)
                                      Hash Cond: (c.org_id = visible_orgs_2.org_id)
                                      Buffers: shared hit=11
                                      ->  Nested Loop  (cost=51.72..74.80 rows=5 width=48) (actual time=0.014..0.015 rows=0 loops=1)
                                            Join Filter: (c.org_id = visible_orgs_3.org_id)
                                            Buffers: shared hit=11
                                            ->  HashAggregate  (cost=0.02..0.03 rows=1 width=16) (actual time=0.002..0.002 rows=1 loops=1)
                                                  Group Key: visible_orgs_3.org_id
                                                  Batches: 1  Memory Usage: 24kB
                                                  ->  CTE Scan on visible_orgs visible_orgs_3  (cost=0.00..0.02 rows=1 width=16) (actual time=0.000..0.000 rows=1 loops=1)
                                            ->  Bitmap Heap Scan on contacts c  (cost=51.69..74.69 rows=6 width=32) (actual time=0.011..0.012 rows=0 loops=1)
                                                  Recheck Cond: (search_text ~~* '%roofing%'::text)
                                                  Buffers: shared hit=11
                                                  ->  Bitmap Index Scan on contacts_search_text_gin  (cost=0.00..51.69 rows=6 width=0) (actual time=0.010..0.010 rows=0 loops=1)
                                                        Index Cond: (search_text ~~* '%roofing%'::text)
                                                        Buffers: shared hit=11
                                      ->  Hash  (cost=0.02..0.02 rows=1 width=16) (actual time=0.000..0.001 rows=1 loops=1)
                                            Buckets: 1024  Batches: 1  Memory Usage: 9kB
                                            ->  CTE Scan on visible_orgs visible_orgs_2  (cost=0.00..0.02 rows=1 width=16) (actual time=0.000..0.000 rows=1 loops=1)
                                ->  Bitmap Heap Scan on properties p_2  (cost=5.22..9.24 rows=1 width=64) (never executed)
                                      Recheck Cond: ((homeowner_contact_id = c.id) OR (agent_contact_id = c.id))
                                      Filter: ((deleted_at IS NULL) AND (c.org_id = org_id))
                                      ->  BitmapOr  (cost=5.22..5.22 rows=1 width=0) (never executed)
                                            ->  Bitmap Index Scan on idx_properties_homeowner_contact  (cost=0.00..4.42 rows=1 width=0) (never executed)
                                                  Index Cond: (homeowner_contact_id = c.id)
                                            ->  Bitmap Index Scan on idx_properties_agent_contact  (cost=0.00..0.80 rows=1 width=0) (never executed)
                                                  Index Cond: (agent_contact_id = c.id)
                          ->  Hash Join  (cost=4290.73..11384.89 rows=3200 width=16) (actual time=10.194..12.130 rows=2600 loops=1)
                                Hash Cond: ((m.property_id = mp.id) AND (m.org_id = mp.org_id))
                                Buffers: shared hit=3875
                                ->  Hash Join  (cost=521.73..7599.09 rows=3200 width=64) (actual time=0.408..1.986 rows=2600 loops=1)
                                      Hash Cond: (m.org_id = visible_orgs_4.org_id)
                                      Buffers: shared hit=1356
                                      ->  Hash Semi Join  (cost=521.68..7552.04 rows=4000 width=48) (actual time=0.395..1.756 rows=2600 loops=1)
                                            Hash Cond: (m.org_id = visible_orgs_5.org_id)
                                            Buffers: shared hit=1356
                                            ->  Bitmap Heap Scan on messages m  (cost=521.65..7494.39 rows=5000 width=32) (actual time=0.391..1.540 rows=2600 loops=1)
                                                  Recheck Cond: (fts @@ '''roofing'':*'::tsquery)
                                                  Filter: ((conversation_id IS NOT NULL) AND (property_id IS NOT NULL) AND (channel = 'sms'::text))
                                                  Heap Blocks: exact=1353
                                                  Buffers: shared hit=1356
                                                  ->  Bitmap Index Scan on messages_fts_gin  (cost=0.00..520.40 rows=5000 width=0) (actual time=0.315..0.315 rows=2600 loops=1)
                                                        Index Cond: (fts @@ '''roofing'':*'::tsquery)
                                                        Buffers: shared hit=3
                                            ->  Hash  (cost=0.02..0.02 rows=1 width=16) (actual time=0.000..0.001 rows=1 loops=1)
                                                  Buckets: 1024  Batches: 1  Memory Usage: 9kB
                                                  ->  CTE Scan on visible_orgs visible_orgs_5  (cost=0.00..0.02 rows=1 width=16) (actual time=0.000..0.000 rows=1 loops=1)
                                      ->  Hash  (cost=0.03..0.03 rows=1 width=16) (actual time=0.011..0.012 rows=1 loops=1)
                                            Buckets: 1024  Batches: 1  Memory Usage: 9kB
                                            ->  HashAggregate  (cost=0.02..0.03 rows=1 width=16) (actual time=0.011..0.011 rows=1 loops=1)
                                                  Group Key: visible_orgs_4.org_id
                                                  Batches: 1  Memory Usage: 24kB
                                                  ->  CTE Scan on visible_orgs visible_orgs_4  (cost=0.00..0.02 rows=1 width=16) (actual time=0.010..0.010 rows=1 loops=1)
                                ->  Hash  (cost=3019.00..3019.00 rows=50000 width=32) (actual time=9.730..9.730 rows=50000 loops=1)
                                      Buckets: 65536  Batches: 1  Memory Usage: 3637kB
                                      Buffers: shared hit=2519
                                      ->  Seq Scan on properties mp  (cost=0.00..3019.00 rows=50000 width=32) (actual time=0.002..5.955 rows=50000 loops=1)
                                            Filter: (deleted_at IS NULL)
                                            Buffers: shared hit=2519
  ->  Hash  (cost=0.02..0.02 rows=1 width=16) (actual time=0.012..0.012 rows=1 loops=1)
        Buckets: 1024  Batches: 1  Memory Usage: 9kB
        Buffers: shared hit=2
        ->  CTE Scan on visible_orgs  (cost=0.00..0.02 rows=1 width=16) (actual time=0.010..0.011 rows=1 loops=1)
              Buffers: shared hit=2
duration: 30.403 ms  plan:
Query Text: select count(*) from public.search_properties($1, true)
Query Parameters: $1 = 'roofing'
Aggregate  (cost=12.75..12.76 rows=1 width=8) (actual time=30.399..30.399 rows=1 loops=1)
  Buffers: shared hit=6524
  ->  Function Scan on search_properties  (cost=0.25..10.25 rows=1000 width=0) (actual time=30.306..30.356 rows=1270 loops=1)
        Buffers: shared hit=6524
```
