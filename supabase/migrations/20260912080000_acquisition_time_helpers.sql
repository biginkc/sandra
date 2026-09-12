-- My Leads working-time arithmetic. Pure helpers; no scheduler or persisted stale flags.
begin;
create or replace function public.acquisition_working_minutes(p_start timestamptz, p_end timestamptz)
returns double precision language plpgsql stable strict set search_path = '' as $$
declare
  v_day date := (p_start at time zone 'America/Chicago')::date;
  v_end_day date := (p_end at time zone 'America/Chicago')::date;
  v_open timestamptz;
  v_close timestamptz;
  v_seconds double precision := 0;
begin
  if not pg_catalog.isfinite(p_start) or not pg_catalog.isfinite(p_end) then
    raise exception 'Invalid instant' using errcode = '22023';
  end if;
  if p_end <= p_start then return 0; end if;
  while v_day <= v_end_day loop
    if extract(isodow from v_day) <= 5 then
      v_open := (v_day + time '09:00') at time zone 'America/Chicago';
      v_close := (v_day + time '17:00') at time zone 'America/Chicago';
      v_seconds := v_seconds + greatest(0, extract(epoch from (least(p_end, v_close) - greatest(p_start, v_open))));
    end if;
    v_day := v_day + 1;
  end loop;
  return v_seconds / 60;
end;
$$;
create or replace function public.acquisition_working_deadline(p_start timestamptz, p_minutes double precision default 30)
returns timestamptz language plpgsql stable strict set search_path = '' as $$
declare
  v_day date := (p_start at time zone 'America/Chicago')::date;
  v_from timestamptz;
  v_close timestamptz;
  v_remaining double precision := p_minutes * 60;
  v_available double precision;
begin
  if not pg_catalog.isfinite(p_start) or p_minutes < 0 or p_minutes in ('Infinity'::double precision, '-Infinity'::double precision, 'NaN'::double precision) then
    raise exception 'Invalid working duration or instant' using errcode = '22023';
  end if;
  if p_minutes = 0 then return p_start; end if;
  loop
    if extract(isodow from v_day) <= 5 then
      v_from := greatest(p_start, (v_day + time '09:00') at time zone 'America/Chicago');
      v_close := (v_day + time '17:00') at time zone 'America/Chicago';
      v_available := greatest(0, extract(epoch from (v_close - v_from)));
      if v_available >= v_remaining then
        return v_from + v_remaining * interval '1 second';
      end if;
      v_remaining := v_remaining - v_available;
    end if;
    v_day := v_day + 1;
  end loop;
end;
$$;
revoke all on function public.acquisition_working_minutes(timestamptz,timestamptz) from public, anon, authenticated;
revoke all on function public.acquisition_working_deadline(timestamptz,double precision) from public, anon, authenticated;
grant execute on function public.acquisition_working_minutes(timestamptz,timestamptz) to service_role;
grant execute on function public.acquisition_working_deadline(timestamptz,double precision) to service_role;
commit;
