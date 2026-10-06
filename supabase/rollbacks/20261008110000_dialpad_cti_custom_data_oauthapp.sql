-- Rollback for 20261008110000_dialpad_cti_custom_data_oauthapp.
-- Restores the exact prior normalizer body from 20260929200000_dialpad_cti_custom_data.sql
-- (string or single-key `open_cti` object only). Events already matched stay matched.
begin;

create or replace function public.dialpad_cti_custom_data(p_value jsonb, out present boolean, out value text)
language sql
immutable
set search_path = ''
as $$
  select
    p_value is not null and p_value <> 'null'::jsonb and p_value <> '""'::jsonb,
    case jsonb_typeof(p_value)
      when 'string' then nullif(p_value #>> '{}', '')
      when 'object' then
        case when (select count(*) from jsonb_object_keys(p_value)) = 1
              and jsonb_typeof(p_value -> 'open_cti') = 'string'
          then nullif(p_value ->> 'open_cti', '')
        end
    end;
$$;

revoke all on function public.dialpad_cti_custom_data(jsonb) from public, anon, authenticated;

commit;
