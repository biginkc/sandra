-- ============================================================================
-- Dashboard summary RPC — single round-trip for the /dashboard landing page.
--
-- Returns one jsonb object with every count the dashboard renders:
--   · KPI tiles: total_leads, new_this_week, assigned breakdown, not_in_drip,
--     hot_leads, skip_trace_coverage
--   · "Needs attention" strip: escalated_unhandled, stale_conversations,
--     sequence_ended_no_followup, unassigned
--   · Right-rail panels: threads_needing_attention[], recent_activity[]
--
-- Function is `security invoker` — runs as the calling user so existing RLS
-- on properties / messages / sequence_enrollments / etc. continues to scope
-- the result. Single-org V1 means one matching org per session anyway.
--
-- Definitions (locked in docs/design/dashboard-plan.md):
--   · Hot leads        = status in ('interested','offer_sent')
--   · Non-terminal     = status not in ('closed','dead')
--   · Funnel base      = status not in ('closed','dead','prospect')
--   · Skip-traced      = ANY skip_trace_cache row for property's
--                        address_normalized (regardless of match_count)
--   · Not in drip      = no sequence_enrollments row with status='active'
--   · Escalated unhand = needs_human_attention AND last_ai_escalation_at
--                        more than 1h old AND no outbound message since
--   · Stale            = last inbound > 7d, status non-terminal,
--                        no outbound message since last inbound
--   · Seq-ended        = enrollment.status='completed', completed_at >24h,
--                        no outbound message to property since completed_at
-- ============================================================================

create or replace function dashboard_summary()
returns jsonb
language plpgsql
security invoker
set search_path = public, pg_temp
as $$
declare
  v_total_leads integer;
  v_new_this_week integer;
  v_not_in_drip integer;
  v_hot_num integer;
  v_funnel_base integer;
  v_traced_num integer;
  v_traced_den integer;
  v_assigned jsonb;
  v_escalated_unhandled integer;
  v_stale integer;
  v_seq_ended integer;
  v_unassigned integer;
  v_threads jsonb;
  v_activity jsonb;
begin
  ---------------------------------------------------------------------------
  -- KPI tile counts
  ---------------------------------------------------------------------------
  select count(*) into v_total_leads
  from properties
  where deleted_at is null
    and status not in ('dead');

  select count(*) into v_new_this_week
  from properties
  where deleted_at is null
    and created_at >= now() - interval '7 days';

  select count(*) into v_not_in_drip
  from properties p
  where p.deleted_at is null
    and p.status not in ('closed', 'dead', 'prospect')
    and not exists (
      select 1 from sequence_enrollments e
      where e.property_id = p.id and e.status = 'active'
    );

  select count(*) into v_hot_num
  from properties
  where deleted_at is null
    and status in ('interested', 'offer_sent');

  select count(*) into v_funnel_base
  from properties
  where deleted_at is null
    and status not in ('closed', 'dead', 'prospect');

  select count(distinct p.id) into v_traced_num
  from properties p
  join skip_trace_cache c on c.address_normalized = p.address_normalized
  where p.deleted_at is null
    and p.address_normalized is not null;

  select count(*) into v_traced_den
  from properties
  where deleted_at is null;

  ---------------------------------------------------------------------------
  -- Assigned-by-user breakdown
  ---------------------------------------------------------------------------
  select coalesce(jsonb_agg(jsonb_build_object(
    'user_id', sub.assigned_user_id,
    'email', u.email,
    'count', sub.cnt
  ) order by sub.cnt desc), '[]'::jsonb)
  into v_assigned
  from (
    select assigned_user_id, count(*) as cnt
    from properties
    where deleted_at is null
      and assigned_user_id is not null
      and status not in ('closed', 'dead')
    group by assigned_user_id
  ) sub
  left join auth.users u on u.id = sub.assigned_user_id;

  ---------------------------------------------------------------------------
  -- Needs Attention counts
  ---------------------------------------------------------------------------
  select count(*) into v_escalated_unhandled
  from properties p
  where p.deleted_at is null
    and p.needs_human_attention = true
    and p.last_ai_escalation_at is not null
    and p.last_ai_escalation_at < now() - interval '1 hour'
    and not exists (
      select 1 from messages m
      where m.property_id = p.id
        and m.direction = 'outbound'
        and m.created_at > p.last_ai_escalation_at
    );

  select count(*) into v_stale
  from properties p
  where p.deleted_at is null
    and p.status not in ('closed', 'dead', 'under_contract', 'prospect')
    and exists (
      select 1 from messages m
      where m.property_id = p.id
        and m.direction = 'inbound'
        and m.created_at < now() - interval '7 days'
    )
    and not exists (
      select 1 from messages m
      where m.property_id = p.id
        and m.direction = 'outbound'
        and m.created_at > (
          select max(m2.created_at) from messages m2
          where m2.property_id = p.id and m2.direction = 'inbound'
        )
    );

  select count(distinct e.property_id) into v_seq_ended
  from sequence_enrollments e
  join properties p on p.id = e.property_id
  where p.deleted_at is null
    and e.status = 'completed'
    and e.completed_at < now() - interval '24 hours'
    and not exists (
      select 1 from messages m
      where m.property_id = e.property_id
        and m.direction = 'outbound'
        and m.created_at > e.completed_at
    );

  select count(*) into v_unassigned
  from properties
  where deleted_at is null
    and assigned_user_id is null
    and status not in ('closed', 'dead', 'prospect');

  ---------------------------------------------------------------------------
  -- Right rail: top 5 threads needing attention
  ---------------------------------------------------------------------------
  select coalesce(jsonb_agg(t order by t->>'last_ai_escalation_at' desc), '[]'::jsonb)
  into v_threads
  from (
    select jsonb_build_object(
      'property_id', p.id,
      'address', p.address,
      'city', p.city,
      'state', p.state,
      'last_ai_escalation_at', p.last_ai_escalation_at,
      'last_ai_escalation_reason', p.last_ai_escalation_reason,
      'homeowner_first_name', c.first_name,
      'homeowner_last_name', c.last_name,
      'homeowner_entity_name', c.entity_name
    ) as t
    from properties p
    left join contacts c on c.id = p.homeowner_contact_id
    where p.deleted_at is null
      and p.needs_human_attention = true
    order by p.last_ai_escalation_at desc nulls last
    limit 5
  ) sub;

  ---------------------------------------------------------------------------
  -- Right rail: recent activity (10 newest events across surfaces)
  ---------------------------------------------------------------------------
  select coalesce(jsonb_agg(a order by a->>'at' desc), '[]'::jsonb)
  into v_activity
  from (
    -- New inbound messages
    select jsonb_build_object(
      'kind', 'inbound_message',
      'at', m.created_at,
      'property_id', m.property_id,
      'address', p.address,
      'city', p.city,
      'state', p.state,
      'preview', left(m.body, 80)
    ) as a
    from messages m
    left join properties p on p.id = m.property_id
    where m.direction = 'inbound'
      and m.created_at >= now() - interval '7 days'
    order by m.created_at desc
    limit 10

    union all

    -- Sequence completions
    select jsonb_build_object(
      'kind', 'sequence_completed',
      'at', e.completed_at,
      'property_id', e.property_id,
      'sequence_name', s.name
    ) as a
    from sequence_enrollments e
    join sequences s on s.id = e.sequence_id
    where e.status = 'completed'
      and e.completed_at >= now() - interval '7 days'
    order by e.completed_at desc
    limit 10

    union all

    -- Skip-trace + import jobs (completed)
    select jsonb_build_object(
      'kind', case j.type when 'skip_trace' then 'skip_trace_done' else 'import_done' end,
      'at', j.updated_at,
      'job_type', j.type,
      'job_status', j.status
    ) as a
    from jobs j
    where j.status = 'completed'
      and j.type in ('skip_trace', 'csv_import')
      and j.updated_at >= now() - interval '7 days'
    order by j.updated_at desc
    limit 10

    union all

    -- AI escalations (newest)
    select jsonb_build_object(
      'kind', 'ai_escalation',
      'at', p.last_ai_escalation_at,
      'property_id', p.id,
      'address', p.address,
      'city', p.city,
      'state', p.state,
      'reason', p.last_ai_escalation_reason
    ) as a
    from properties p
    where p.needs_human_attention = true
      and p.last_ai_escalation_at is not null
      and p.last_ai_escalation_at >= now() - interval '7 days'
    order by p.last_ai_escalation_at desc
    limit 10
  ) all_events
  limit 10;

  ---------------------------------------------------------------------------
  -- Assemble
  ---------------------------------------------------------------------------
  return jsonb_build_object(
    'total_leads', v_total_leads,
    'new_this_week', v_new_this_week,
    'not_in_drip', v_not_in_drip,
    'hot_leads', jsonb_build_object(
      'numerator', v_hot_num,
      'denominator', v_funnel_base
    ),
    'skip_trace_coverage', jsonb_build_object(
      'numerator', v_traced_num,
      'denominator', v_traced_den
    ),
    'assigned', v_assigned,
    'needs_attention', jsonb_build_object(
      'escalated_unhandled', v_escalated_unhandled,
      'stale_conversations', v_stale,
      'sequence_ended_no_followup', v_seq_ended,
      'unassigned', v_unassigned
    ),
    'threads_needing_attention', v_threads,
    'recent_activity', v_activity
  );
end;
$$;

revoke execute on function dashboard_summary() from public;
grant execute on function dashboard_summary() to authenticated;
