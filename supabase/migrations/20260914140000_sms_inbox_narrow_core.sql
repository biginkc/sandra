-- Sandra Messages inbox query latency fix (Implementation Spec v6 + S19/S19.5
-- join-strategy round, FABLE-RULINGS.md S18/S19/S19.5).
--
-- Replaces the function defined at
-- supabase/migrations/20260909080000_messages_search.sql:8-469. That
-- definition's `core` / `ready` / `classified` CTEs are three separate
-- `AS MATERIALIZED` CTEs, each holding the same ~64,643-row WIDE result
-- (every column of `grouped` plus the full contacts/properties join
-- output, including display-only strings). EVIDENCE-RESULTS-S17.md
-- (auto_explain capture against the real function, real auth context)
-- showed this costs ~164MB of temp: ~116MB (71%) is a hash-join spill
-- over the FULL contacts (308k rows) and properties (184k rows) tables;
-- ~48MB (29%) is the same ~64,643-row wide result being materialized
-- three times over (`core`, `ready`, `classified`).
--
-- Round 1 fix (S18.1 + S18.2, PR #604 first pass): collapsed
-- `core`/`ready`/`classified` into one narrow `classified_narrow` CTE.
-- GATE-RESULTS.md showed this alone is INSUFFICIENT: temp 17,370 blk /
-- 1,000ms (down from 20,958 / 1,538, ~35% faster) but contacts/properties
-- were STILL hash-built from the full 308k/184k tables (contacts
-- Batches: 8, properties Batches: 4; Hash Left Join est 5,118 rows vs
-- actual 64,642 — a 12x misestimate). GATE-RESULTS.md also caught a
-- migration bug (this file previously referenced a nonexistent
-- `p.property_status` column; the base `properties` table column is
-- `status`, aliased `as property_status` — fixed below, S19.0).
--
-- Round 2 fix (S19.3 E1 + S19.5.2/S19.5.3 E2, this migration):
--
-- E1 (S19.3, "narrow the join input"): the join's PROBE side was still
-- `grouped` itself (wide relative to what contacts/properties joins
-- need, and the UNION ALL of recent_grouped/old_review_grouped gives the
-- planner a bad row-count estimate for it). A new `keys` MATERIALIZED CTE
-- is introduced between `grouped` and the contacts/properties join,
-- projecting ONLY: org_id, conversation_id, contact_id, property_id,
-- last_message_direction, last_message_at, latest_from, latest_to,
-- unread_count, has_inbound, has_recent. The ONE column of `grouped`
-- dropped here is `last_message_id` — it is not needed by any
-- classification predicate, count, filter, or ORDER BY key; it is only
-- ever used to join back to `public.messages` for `last_message_body`,
-- so it is now hydrated AFTER paging, in `page_rows`, via a join back to
-- `grouped` (already materialized) on (org_id, conversation_id) — the
-- same org-scoped, cardinality-preserving pattern used for the other
-- page-time joins.
--
-- E2 (S19.5.2/S19.5.3, "share the single contacts access"): the OLD
-- search predicate filtered directly inside the CTE that performs the
-- contacts join (`... or c.search_text ilike ... or exists(...)`), i.e.
-- a filter on the nullable side of a LEFT JOIN, sitting inside the same
-- CTE. Astra/Fable's diagnosis: this both misleads the row-estimate and
-- can block the planner from choosing a narrow-build hash/side-swap.
-- Fix: `classified_narrow` now only PROJECTS a boolean `contact_hit`
-- column from that same single contacts join (no filtering there); the
-- actual search filter (`p_search is null OR contact_hit OR
-- exists(messages FTS)`) is applied one CTE downstream, in `classified`.
-- A missing/RLS-invisible contact yields `contact_hit = null`, which
-- behaves as `false` in the `OR` chain and falls through correctly to
-- the messages EXISTS check — contacts are still accessed exactly once
-- on every path (search or not), matching S19.4's "at most once" rule.
-- The escaping (`escape E'\\'`), ≥3-digit phone rule, `channel = 'sms'`
-- restriction, FTS scope, and the ABSENCE of a recent-cutoff on the
-- message FTS subquery are copied character-for-character from
-- 20260909080000_messages_search.sql:282-293 (S19.5.3).
--
-- Non-negotiable bounds carried forward unchanged (S17b/S18/S19/AB3):
-- function signature and JSON document/shape unchanged; exact counts
-- (S7, no bounded/floor counts); ORDER BY `last_message_at DESC,
-- conversation_id` restated verbatim in both `page_core` and the
-- `jsonb_agg` (non-blocking fix 2); every existing SET clause plus
-- SECURITY INVOKER re-declared verbatim (full CREATE OR REPLACE); no
-- #521 files touched; no changes to src/lib/messages/list-threads.ts or
-- inbox-detail-data.ts (S18.4 is a separate PR); no planner GUC hacks
-- (no `enable_hashjoin`, `enable_seqscan`, no `plan_cache_mode` per
-- S16.3, S18.1, S19 architect notes).
--
-- BLOCKING (Fable spec review, v6): the header below is the VERBATIM
-- named-argument, DEFAULT-bearing signature from
-- 20260909080000_messages_search.sql:8 — required so PostgREST's
-- named-argument resolution and list-threads.ts's omitted-argument call
-- sites (which rely on p_include_thread_id/p_assignee_id/p_search
-- defaulting) keep working. A positional/default-less header would
-- compile and pass a naive equivalence test while silently breaking
-- every real call site that omits an argument.
--
-- Round 3 fix (S20.1/S21.1 E5, this migration): the E1/E2 narrowing
-- above still built the contacts/properties hash tables from the FULL
-- base tables inside `classified_narrow` — narrowing the PROBE side
-- (`keys`) does not narrow the BUILD side. Two new MATERIALIZED CTEs,
-- `contacts_in_window` and `properties_in_window`, semi-join-prefilter
-- each table down to only the rows `keys` can reference before
-- `classified_narrow` joins against them.
--
-- Round 4 fix (Astra gate on #604, 2026-09-17): 32MB was picked on a
-- small dev-scale fixture and never re-measured at a representative
-- in-window row count. docs/performance/2026-09-17-inbox-work-mem-remeasurement.md
-- (owned PG17 fixture, ~65k in-window conversations / 20k contacts / 15k
-- properties, matching the ~64,643-row scale this function actually
-- operates over post-E5) shows the disk-spill threshold is 18MB, not
-- 32MB: 16MB spills ~26MB temp (+~250ms), 17MB spills ~18MB temp, 18MB
-- and above clear `temp_bytes` delta 0 (Batches: 1) with execution time
-- flat from 18MB through 32MB (~1.0-1.09s on the fixture's hardware,
-- vs ~1.29-1.33s still-spilling at 8-16MB). The function-scoped
-- `SET work_mem TO '20MB'` below ships the measured minimum plus a
-- small margin, not the unmeasured 32MB. Capacity is NOT fully resolved:
-- every isolated fresh-backend single-call measurement (7 across all
-- four filter shapes) shows 0-10MB per-call growth, but a real
-- 15-concurrent-connection test OOM-crashed the test instance four
-- times (confounded by that container's 512MiB cap and cold/unpooled
-- connections -- both harsher than the real 4GB production tier with
-- PostgREST/Supavisor pooling). See that doc for the full picture; this
-- is an open tier/verification decision for Jarrad, not something this
-- migration resolves. No `plan_cache_mode` or other planner GUC is set,
-- per S16.3/S18.1/S19.
--
-- Reviewability: see the companion migration
-- 20260914140000_sms_inbox_narrow_core.integration.test.ts for the
-- pg_get_function_arguments(oid) pre/post equality assertion, the
-- per-setting proconfig assertion, the rehearsed-rollback test, and the
-- S19.5.5 equivalence/mutation coverage (missing/RLS-invisible contact,
-- old body-only FTS match, inner-search-join / cutoff-on-FTS /
-- escape-dropped / is_test_traffic-deferred mutation kills).

set lock_timeout = '5s';
set statement_timeout = '120s';

CREATE OR REPLACE FUNCTION public.sms_inbox_thread_page_snapshot(
  p_cutoff timestamp with time zone,
  p_filter text DEFAULT 'all'::text,
  p_assignee_id uuid DEFAULT NULL::uuid,
  p_include_thread_id uuid DEFAULT NULL::uuid,
  p_hide_noise boolean DEFAULT true,
  p_limit integer DEFAULT 200,
  p_offset integer DEFAULT 0,
  p_search text DEFAULT NULL::text
)
 RETURNS jsonb
 LANGUAGE sql
 STABLE SECURITY INVOKER
 SET search_path TO ''
 SET statement_timeout TO '15s'
 SET work_mem TO '20MB'
AS $function$
  with search_input as (
    select case when length(btrim(p_search)) >= 3
      then left(btrim(p_search), 100) else null end as q
  ), search_bounds as (
    select q,
      replace(replace(replace(lower(q), E'\\', E'\\\\'), '%', E'\\%'), '_', E'\\_') as q_like,
      regexp_replace(q, '[^0-9]', '', 'g') as digits,
      public.search_prefix_tsquery(q) as tsq
    from search_input
  ), bounds as (
    select
      greatest(
        coalesce(p_cutoff, statement_timestamp() - interval '365 days'),
        statement_timestamp() - interval '365 days'
      ) as cutoff,
      least(greatest(coalesce(p_limit, 200), 1), 500) as page_limit,
      greatest(coalesce(p_offset, 0), 0) as requested_offset,
      case
        when p_filter in ('all', 'mine', 'unassigned', 'unread', 'escalated', 'dispo', 'needs_outcome')
          then p_filter
        else 'all'
      end as active_filter
  ),
  visible_orgs as materialized (
    select membership.org_id
    from public.memberships membership
    where current_user = 'authenticated'
      and membership.user_id = auth.uid()
      and membership.access_status = 'active'
      and membership.deletion_prepared_at is null
      and (
        membership.access_expires_at is null
        or membership.access_expires_at > statement_timestamp()
      )
  ),
  pending_reviews as materialized (
    select
      review.id,
      review.org_id,
      review.property_id,
      review.conversation_id,
      review.source_inbound_message_id,
      review.disposition,
      review.ai_reason,
      review.status,
      review.created_at
    from public.ai_disposition_reviews review
    where review.status = 'pending'
      and (
        current_user <> 'authenticated'
        or review.org_id in (select visible.org_id from visible_orgs visible)
      )
  ),
  recent_eligible as not materialized (
    select
      m.id,
      m.org_id,
      m.conversation_id,
      m.contact_id,
      m.property_id,
      m.direction,
      m.read_at,
      m.created_at,
      m.from_address,
      m.to_address,
      row_number() over (
        partition by m.org_id, m.conversation_id
        order by m.created_at desc, m.id desc
      ) as latest_rank
    from public.messages m
    where m.channel = 'sms'
      and m.contact_id is not null
      and m.conversation_id is not null
      and m.status not in ('queued', 'paused')
      and m.created_at >= (select cutoff from bounds)
      and (
        current_user <> 'authenticated'
        or m.org_id in (select visible.org_id from visible_orgs visible)
      )
  ),
  recent_grouped as materialized (
    select
      e.org_id,
      e.conversation_id,
      (array_agg(e.id) filter (where e.latest_rank = 1))[1] as last_message_id,
      (array_agg(e.contact_id) filter (where e.latest_rank = 1))[1] as contact_id,
      coalesce(
        (array_agg(e.property_id order by e.created_at desc, e.id desc)
          filter (where e.property_id is not null))[1],
        (
          select review.property_id
          from pending_reviews review
          where review.org_id = e.org_id
            and review.conversation_id = e.conversation_id
          order by review.created_at desc, review.id desc
          limit 1
        )
      ) as property_id,
      count(*) filter (
        where e.direction = 'inbound' and e.read_at is null
      )::integer as unread_count,
      bool_or(e.direction = 'inbound') as has_inbound,
      true as has_recent,
      max(e.direction) filter (where e.latest_rank = 1) as last_message_direction,
      max(e.created_at) filter (where e.latest_rank = 1) as last_message_at,
      max(e.from_address) filter (where e.latest_rank = 1) as latest_from,
      max(e.to_address) filter (where e.latest_rank = 1) as latest_to
    from recent_eligible e
    group by e.org_id, e.conversation_id
  ),
  old_review_conversations as materialized (
    select review.*
    from pending_reviews review
    where not exists (
      select 1
      from recent_grouped recent
      where recent.org_id = review.org_id
        and recent.conversation_id = review.conversation_id
    )
  ),
  old_review_eligible as materialized (
    select
      m.id,
      m.org_id,
      m.conversation_id,
      m.contact_id,
      m.property_id,
      review.property_id as review_property_id,
      m.direction,
      m.read_at,
      m.created_at,
      m.from_address,
      m.to_address,
      row_number() over (
        partition by m.org_id, m.conversation_id
        order by m.created_at desc, m.id desc
      ) as latest_rank
    from old_review_conversations review
    join public.messages m
      on m.org_id = review.org_id
      and m.conversation_id = review.conversation_id
    where m.channel = 'sms'
      and m.contact_id is not null
      and m.status not in ('queued', 'paused')
  ),
  old_review_grouped as materialized (
    select
      e.org_id,
      e.conversation_id,
      (array_agg(e.id order by e.created_at desc, e.id desc))[1] as last_message_id,
      (array_agg(e.contact_id order by e.created_at desc, e.id desc))[1] as contact_id,
      (array_agg(e.review_property_id order by e.created_at desc, e.id desc))[1] as property_id,
      count(*) filter (
        where e.direction = 'inbound' and e.read_at is null
      )::integer as unread_count,
      bool_or(e.direction = 'inbound') as has_inbound,
      false as has_recent,
      max(e.direction) filter (where e.latest_rank = 1) as last_message_direction,
      max(e.created_at) filter (where e.latest_rank = 1) as last_message_at,
      max(e.from_address) filter (where e.latest_rank = 1) as latest_from,
      max(e.to_address) filter (where e.latest_rank = 1) as latest_to
    from old_review_eligible e
    group by e.org_id, e.conversation_id
  ),
  grouped as materialized (
    select recent.*
    from recent_grouped recent

    union all

    select review.*
    from old_review_grouped review
  ),
  conversation_ambiguities as (
    select case
      when current_user = 'authenticated'
        and (select count(*) from visible_orgs) <= 1
      then 0
      else (
        select count(*)::integer
        from (
          select m.conversation_id
          from public.messages m
          where m.channel = 'sms'
            and m.conversation_id in (
              select grouped_thread.conversation_id from grouped grouped_thread
            )
            and (
              current_user <> 'authenticated'
              or m.org_id in (select visible.org_id from visible_orgs visible)
            )
          group by m.conversation_id
          having count(distinct m.org_id) > 1
        ) collisions
      )
    end as ambiguity_count
  ),
  -- S19.3 E1: the join's probe/build side, narrowed to ONLY the columns
  -- the contacts/properties join, classification, counts, ORDER BY, and
  -- page_rows join keys need. Dropped from `grouped`: `last_message_id`
  -- (name it explicitly per S19.5.1 — it is the only column of `grouped`
  -- not carried forward here; it is not read by any predicate/count/
  -- filter/ORDER BY, only by the page-time message-body join, which now
  -- hydrates it after paging via a join back to `grouped` in page_rows).
  keys as materialized (
    select
      g.org_id,
      g.conversation_id,
      g.contact_id,
      g.property_id,
      g.last_message_direction,
      g.last_message_at,
      g.latest_from,
      g.latest_to,
      g.unread_count,
      g.has_inbound,
      g.has_recent
    from grouped g
  ),
  -- S18.1/S18.2/S19.3 E1: ONE narrow MATERIALIZED CTE, joined from
  -- `keys` (not `grouped` directly, per E1) to contacts/properties/
  -- message_threads/consent/suppression/pending_reviews. Carries only:
  --   - join keys / ids needed downstream (org_id, conversation_id,
  --     contact_id, property_id)
  --   - columns the verbatim predicates, counts/active_* filters,
  --     ORDER BY, or page_rows join keys reference: has_recent,
  --     has_inbound, unread_count, last_message_direction,
  --     last_message_at, property_status, outreach_dispo, is_dnc_locked,
  --     assigned_user_id, ai_responder_status, ai_disposition_review_id/
  --     status/disposition (NOT reason/created_at/
  --     source_inbound_message_id -- those are display-only, hydrated in
  --     page_rows)
  --   - thread_customer_phone / thread_business_phone (returned JSON
  --     fields, not display-only per the spec floor list)
  --   - the boolean is_test_traffic, is_opted_out (computed here,
  --     verbatim predicates, so the underlying display strings
  --     `contact_name`/`property_address` can be read and discarded
  --     without leaving the narrow projection)
  --   - S19.5.2 E2: the boolean `contact_hit` (the contact-side search
  --     match), PROJECTED here (not filtered here) from the SAME single
  --     contacts join used for is_test_traffic/is_opted_out -- contacts
  --     are still accessed exactly once, on every path.
  -- Contact_name/property_address are read here ONLY to derive
  -- is_test_traffic and contact_hit, then dropped from the projection.
  -- No WHERE clause filters on the nullable (contacts) side of any join
  -- in this CTE (S19.5.2) -- the search filter is applied one CTE
  -- downstream, in `classified`.
  --
  -- S20.1/S21.1 E5 (semi-join prefilter): `keys` is at most ~64,643 rows
  -- across at most that many distinct (contact_id, org_id) /
  -- (property_id, org_id) pairs, but the OLD join built its hash table
  -- from the FULL `public.contacts` (308k rows) and `public.properties`
  -- (184k rows) tables, spilling to disk (EVIDENCE-RESULTS-S17.md,
  -- GATE-RESULTS.md). These two MATERIALIZED CTEs pre-filter each table
  -- down to only the rows `keys` can actually reference (via `exists`
  -- against `keys`, org-scoped) before the hash build in
  -- `classified_narrow` ever runs, so the planner builds its hash table
  -- from a narrow, correctly-estimated row set instead of the full
  -- table. Column lists carry exactly the columns `classified_narrow`
  -- reads from `c.*`/`p.*` (verified against every downstream c./p.
  -- reference in this CTE) plus `p.address`/`p.city`/`p.state`, which
  -- `classified_narrow` reads to derive `is_test_traffic`. Display-only
  -- hydration in `page_rows` (contact_name, property_address,
  -- needs_human_attention, last_ai_escalation_reason) is untouched by
  -- this change and continues to join `public.contacts`/
  -- `public.properties` directly, since it only ever touches the
  -- page's <=200 rows.
  contacts_in_window as materialized (
    select c.id, c.org_id, c.do_not_contact, c.sms_opted_out, c.entity_name, c.first_name, c.last_name, c.search_text, c.phone_digits
    from public.contacts c
    where exists (select 1 from keys k where k.contact_id = c.id and k.org_id = c.org_id)
  ),
  properties_in_window as materialized (
    select p.id, p.org_id, p.status, p.outreach_dispo, p.is_dnc_locked, p.assigned_user_id, p.address, p.city, p.state
    from public.properties p
    where exists (select 1 from keys k where k.property_id = p.id and k.org_id = p.org_id)
  ),
  classified_narrow as materialized (
    select
      k.org_id,
      k.conversation_id,
      k.contact_id,
      k.property_id,
      k.unread_count,
      k.has_inbound,
      k.has_recent,
      k.last_message_direction,
      k.last_message_at,
      case when k.last_message_direction = 'inbound' then k.latest_from else k.latest_to end as thread_customer_phone,
      case when k.last_message_direction = 'inbound' then k.latest_to else k.latest_from end as thread_business_phone,
      p.status as property_status,
      p.outreach_dispo,
      p.is_dnc_locked,
      p.assigned_user_id,
      mt.ai_responder_status,
      review.id as ai_disposition_review_id,
      review.status as ai_disposition_review_status,
      review.disposition as ai_disposition_review_disposition,
      (
        coalesce(c.do_not_contact, false)
        or coalesce(c.sms_opted_out, false)
        or (suppression.phone_e164 is not null)
        or coalesce(ce.event_type in ('opt_out', 'provider_auto_opt_out'), false)
      ) as is_opted_out,
      (
        lower(trim(coalesce(coalesce(c.entity_name, nullif(concat_ws(' ', c.first_name, c.last_name), '')), ''))) like 'canary canary-%%'
        or lower(trim(coalesce(nullif(concat_ws(', ', p.address, p.city, p.state), ''), ''))) like 'jitter %%'
        or lower(trim(coalesce(nullif(concat_ws(', ', p.address, p.city, p.state), ''), ''))) like 'jitter-%%'
      ) as is_test_traffic,
      (
        c.search_text ilike '%' || search.q_like || '%' escape E'\\'
        or (length(search.digits) >= 3 and c.phone_digits ilike '%' || search.digits || '%')
      ) as contact_hit
    from keys k
    left join contacts_in_window c on c.id = k.contact_id and c.org_id = k.org_id
    left join properties_in_window p on p.id = k.property_id and p.org_id = k.org_id
    left join pending_reviews review
      on review.org_id = k.org_id
      and review.conversation_id = k.conversation_id
      and review.property_id = k.property_id
    left join public.message_threads mt on mt.conversation_id = k.conversation_id and mt.org_id = k.org_id
    left join lateral (
      select consent.event_type
      from public.consent_events consent
      where consent.contact_id = k.contact_id
        and consent.org_id = k.org_id
        and consent.channel = 'sms'
        and consent.event_type in (
          'opt_in_marketing_written',
          'opt_in_informational',
          'opt_in_confirmed',
          'opt_out',
          'provider_auto_opt_out'
        )
      order by consent.occurred_at desc, consent.id desc
      limit 1
    ) ce on true
    left join lateral (
      select case
        when length(phone.digits) = 11 and left(phone.digits, 1) = '1'
          then '+' || phone.digits
        when length(phone.digits) = 10
          then '+1' || phone.digits
        else null
      end as phone_e164
      from (
        select regexp_replace(
          coalesce(case when k.last_message_direction = 'inbound' then k.latest_from else k.latest_to end, ''),
          '[^0-9]',
          '',
          'g'
        ) as digits
      ) phone
    ) normalized_phone on true
    left join public.sms_phone_suppressions suppression
      on suppression.org_id = k.org_id
      and suppression.channel = 'sms'
      and suppression.phone_e164 = normalized_phone.phone_e164
    cross join search_bounds search
  ),
  -- S19.5.2 E2: the search filter applied here, one CTE downstream of the
  -- single contacts join. `contact_hit` is null when the contacts join
  -- missed (missing/RLS-invisible contact org-scoped mismatch), which
  -- behaves as false in the OR chain and falls through to the messages
  -- EXISTS check -- exactly the OLD function's per-row semantics, just
  -- evaluated downstream instead of as a join-side filter.
  classified as materialized (
    select
      n.org_id,
      n.conversation_id,
      n.contact_id,
      n.property_id,
      n.unread_count,
      n.has_inbound,
      n.has_recent,
      n.last_message_direction,
      n.last_message_at,
      n.thread_customer_phone,
      n.thread_business_phone,
      n.property_status,
      n.outreach_dispo,
      n.is_dnc_locked,
      n.assigned_user_id,
      n.ai_responder_status,
      n.ai_disposition_review_id,
      n.ai_disposition_review_status,
      n.ai_disposition_review_disposition,
      n.is_opted_out,
      n.is_test_traffic,
      n.property_id is not null
        and n.has_inbound
        and n.outreach_dispo is null
        and not n.is_opted_out
        and n.property_status in ('prospect', 'new_lead', 'contacted') as needs_outcome,
      coalesce(n.is_dnc_locked, false) or n.is_opted_out or n.is_test_traffic as is_noise
    from classified_narrow n
    cross join search_bounds search
    where (
      search.q is null
      or n.contact_hit
      or exists (
        select 1 from public.messages matching_message
        where matching_message.org_id = n.org_id
          and matching_message.conversation_id = n.conversation_id
          and matching_message.channel = 'sms'
          and matching_message.fts @@ search.tsq
      )
    ) -- messages_search_predicate (E2: downstream of the single contacts join, S19.5.2)
  ),
  counts as (
    select
      count(*) filter (where c.has_recent and (not p_hide_noise or not c.is_noise))::integer as all_count,
      count(*) filter (where c.has_recent and (not p_hide_noise or not c.is_noise) and c.property_status is not null and c.property_status <> 'prospect' and p_assignee_id is not null and c.assigned_user_id = p_assignee_id)::integer as mine_count,
      count(*) filter (where c.has_recent and (not p_hide_noise or not c.is_noise) and c.property_status is not null and c.property_status <> 'prospect' and p_assignee_id is not null and c.assigned_user_id is null)::integer as unassigned_count,
      count(*) filter (where c.has_recent and (not p_hide_noise or not c.is_noise) and c.unread_count > 0)::integer as unread_count,
      count(*) filter (where c.has_recent and (not p_hide_noise or not c.is_noise) and c.ai_responder_status = 'escalated')::integer as escalated_count,
      count(*) filter (where c.ai_disposition_review_id is not null and not c.is_test_traffic)::integer as dispo_count,
      count(*) filter (where c.has_recent and (not p_hide_noise or not c.is_noise) and c.needs_outcome)::integer as needs_outcome_count
    from classified c
  ),
  active_unhidden as materialized (
    select c.*
    from classified c
    cross join bounds b
    where case b.active_filter
      when 'mine' then c.has_recent and c.property_status is not null and c.property_status <> 'prospect' and p_assignee_id is not null and c.assigned_user_id = p_assignee_id
      when 'unassigned' then c.has_recent and c.property_status is not null and c.property_status <> 'prospect' and p_assignee_id is not null and c.assigned_user_id is null
      when 'unread' then c.has_recent and (c.unread_count > 0 or c.conversation_id = p_include_thread_id)
      when 'escalated' then c.has_recent and c.ai_responder_status = 'escalated'
      when 'dispo' then c.ai_disposition_review_id is not null
      when 'needs_outcome' then c.has_recent and c.needs_outcome
      else c.has_recent
    end
  ),
  active_filtered as materialized (
    select active.*
    from active_unhidden active
    cross join bounds b
    where case b.active_filter
      -- Compliance outcomes are still actionable review work. Test fixtures
      -- never are, even when the caller asks to show ordinary hidden noise.
      when 'dispo' then not active.is_test_traffic
      else not p_hide_noise or not active.is_noise
    end
  ),
  page_meta as (
    select
      count(*)::integer as total_count,
      coalesce((select count(*) from active_unhidden), 0)::integer
        - count(*)::integer as hidden_count
    from active_filtered
  ),
  effective_page as (
    select
      b.page_limit,
      case
        when meta.total_count = 0 then 0
        else least(
          b.requested_offset,
          ((meta.total_count - 1) / b.page_limit) * b.page_limit
        )
      end as page_offset
    from bounds b cross join page_meta meta
  ),
  -- ORDER BY restated verbatim (non-blocking fix 2): must match the
  -- jsonb_agg ORDER BY in `document` below exactly.
  page_core as materialized (
    select active.*
    from active_filtered active
    order by active.last_message_at desc, active.conversation_id
    limit (select page_limit from effective_page)
    offset (select page_offset from effective_page)
  ),
  -- Join-back for display strings (S18.1/AB2) AND for `last_message_id`
  -- (S19.3 E1 -- dropped from `keys`, hydrated here instead): org-scoped,
  -- cardinality-preserving LEFT JOINs only, for the page's <=200 rows.
  -- The `grouped` join-back is 1:1 on (org_id, conversation_id) since
  -- `grouped` is itself grouped by that pair. The AI disposition review
  -- join hydrates the EXACT ai_disposition_review_id already selected in
  -- classified_narrow (never re-derived independently here).
  page_rows as (
    select
      page.*,
      coalesce(c.entity_name, nullif(concat_ws(' ', c.first_name, c.last_name), '')) as contact_name,
      nullif(concat_ws(', ', p.address, p.city, p.state), '') as property_address,
      p.needs_human_attention,
      p.last_ai_escalation_reason,
      review.ai_reason as ai_disposition_review_reason,
      review.created_at as ai_disposition_review_created_at,
      review.source_inbound_message_id as ai_disposition_review_source_inbound_message_id,
      last_message.body as last_message_body,
      thread.ai_responder_reason,
      thread.ai_responder_status_at,
      thread.ai_last_delivery_status,
      thread.ai_last_delivery_error
    from page_core page
    left join grouped g2 on g2.org_id = page.org_id and g2.conversation_id = page.conversation_id
    left join public.contacts c on c.id = page.contact_id and c.org_id = page.org_id
    left join public.properties p on p.id = page.property_id and p.org_id = page.org_id
    left join pending_reviews review
      on review.id = page.ai_disposition_review_id
      and review.org_id = page.org_id
    join public.messages last_message
      on last_message.id = g2.last_message_id
      and last_message.org_id = page.org_id
      and last_message.conversation_id = page.conversation_id
    left join public.message_threads thread
      on thread.conversation_id = page.conversation_id
      and thread.org_id = page.org_id
  ),
  document as (
    select coalesce(jsonb_agg(
      jsonb_build_object(
        'thread_id', row.conversation_id,
        'contact_id', row.contact_id,
        'contact_name', row.contact_name,
        'thread_customer_phone', row.thread_customer_phone,
        'thread_business_phone', row.thread_business_phone,
        'property_id', row.property_id,
        'property_address', row.property_address,
        'property_status', row.property_status,
        'outreach_dispo', row.outreach_dispo,
        'is_dnc_locked', coalesce(row.is_dnc_locked, false),
        'assignee_id', row.assigned_user_id,
        'last_message_body', row.last_message_body,
        'last_message_direction', row.last_message_direction,
        'last_message_at', row.last_message_at,
        'unread_count', row.unread_count,
        'has_inbound', row.has_inbound,
        'needs_human_attention', coalesce(row.needs_human_attention, false),
        'escalation_reason', case when row.needs_human_attention then row.last_ai_escalation_reason else null end,
        'is_opted_out', row.is_opted_out,
        'is_test_traffic', row.is_test_traffic,
        'needs_outcome', row.needs_outcome,
        'ai_responder_status', row.ai_responder_status,
        'ai_responder_reason', row.ai_responder_reason,
        'ai_responder_status_at', row.ai_responder_status_at,
        'ai_last_delivery_status', row.ai_last_delivery_status,
        'ai_last_delivery_error', row.ai_last_delivery_error,
        'ai_disposition_review_id', row.ai_disposition_review_id,
        'ai_disposition_review_status', row.ai_disposition_review_status,
        'ai_disposition_review_disposition', row.ai_disposition_review_disposition,
        'ai_disposition_review_reason', row.ai_disposition_review_reason,
        'ai_disposition_review_created_at', row.ai_disposition_review_created_at,
        'ai_disposition_review_source_inbound_message_id', row.ai_disposition_review_source_inbound_message_id
      ) order by row.last_message_at desc, row.conversation_id
    ), '[]'::jsonb) as rows
    from page_rows row
  )
  select case
    when ambiguities.ambiguity_count > 0 then jsonb_build_object(
      '__error', 'cross_org_conversation_id_ambiguity',
      'count', ambiguities.ambiguity_count
    )
    else jsonb_build_object(
      'rows', document.rows,
      'counts', jsonb_build_object(
        'all', counts.all_count,
        'mine', counts.mine_count,
        'unassigned', counts.unassigned_count,
        'unread', counts.unread_count,
        'escalated', counts.escalated_count,
        'dispo', counts.dispo_count,
        'needs_outcome', counts.needs_outcome_count
      ),
      'total', meta.total_count,
      'hidden_count', meta.hidden_count,
      'limit', page.page_limit,
      'offset', page.page_offset
    )
  end
  from conversation_ambiguities ambiguities
  cross join counts
  cross join page_meta meta
  cross join effective_page page
  cross join document;
$function$
;

alter function public.sms_inbox_thread_page_snapshot(timestamptz, text, uuid, uuid, boolean, integer, integer, text) set statement_timeout = '15s';
revoke all on function public.sms_inbox_thread_page_snapshot(timestamptz, text, uuid, uuid, boolean, integer, integer, text) from public, anon;
grant execute on function public.sms_inbox_thread_page_snapshot(timestamptz, text, uuid, uuid, boolean, integer, integer, text) to authenticated, service_role;
notify pgrst, 'reload schema';
