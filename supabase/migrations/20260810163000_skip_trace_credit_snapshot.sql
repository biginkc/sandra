-- Persist skip-trace provider credit readings without allowing an older,
-- slower request to overwrite a newer reading. Vercel cron deliveries and
-- intentional manual refreshes can overlap, so the ordering check belongs in
-- the same atomic statement as the write.

create or replace function public.upsert_skip_trace_credit_snapshot(
  p_credits integer,
  p_captured_at timestamptz
)
returns boolean
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_changed_count integer;
begin
  if p_credits < 0 then
    raise exception 'upsert_skip_trace_credit_snapshot: credits must be non-negative';
  end if;

  insert into public.metric_snapshots (
    metric_key,
    numerator,
    denominator,
    captured_on,
    captured_at
  )
  values (
    'skip_trace_credits',
    p_credits,
    0,
    (p_captured_at at time zone 'UTC')::date,
    p_captured_at
  )
  on conflict (metric_key, captured_on) do update
    set numerator = excluded.numerator,
        denominator = excluded.denominator,
        captured_at = excluded.captured_at
    where excluded.captured_at > metric_snapshots.captured_at;

  get diagnostics v_changed_count = row_count;
  return v_changed_count > 0;
end;
$$;

revoke all on function public.upsert_skip_trace_credit_snapshot(integer, timestamptz)
  from public, anon, authenticated;
grant execute on function public.upsert_skip_trace_credit_snapshot(integer, timestamptz)
  to service_role;
