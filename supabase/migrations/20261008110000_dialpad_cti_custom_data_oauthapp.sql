-- Dialpad CTI: accept the custom_data wrapper Dialpad really sends on call events.
--
-- Production evidence (2026-10-06): Dialpad returns the value passed to
-- `initiate_call` as a single-key object keyed by the OAuth app, e.g.
--   {"OAuthApp:<cti_client_id>": "sandra.dialpad.v1.<48 hex>"}
-- not as `{"open_cti": ...}`. 20260929200000 only knew `open_cti`, so the operator
-- leg's custom_data normalized to NULL while present = true, the matcher read it as
-- `unknown_custom_data` and the call was never attributed to its intent.
--
-- This migration extends only the normalizer dialpad_cti_custom_data. It now accepts
-- three shapes and nothing else:
--   * a nonempty JSON string (unchanged);
--   * a single-key object `open_cti` -> nonempty string (unchanged);
--   * a single-key object whose key is `OAuthApp:` followed by an id of the same
--     shape the connection stores (^[A-Za-z0-9_-]{1,200}$, see
--     dialpad_org_connections.cti_client_id) and whose value is a string matching
--     ^sandra\.dialpad\.v1\.[0-9a-f]{48}$ exactly.
--
-- The key is checked for the connection id's shape, not for equality with one
-- connection's cti_client_id: this function is a pure immutable normalizer with no
-- org or connection context (both callers pass only the payload). The security
-- decision is unchanged: the extracted token must equal the secret custom_data of
-- an intent in the event's own org, and the target user, number and window checks
-- still run. Extra keys, nesting, arrays, non-strings, empty values, a malformed id
-- or a token that is not the exact sandra.dialpad.v1 format stay present-but-NULL,
-- i.e. fail closed as `unknown_custom_data`.
--
-- fn_match_dialpad_call_event and dialpad_cti_resolve_event are not touched; they
-- already read this normalizer. No data is changed.

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
        case when (select count(*) from jsonb_object_keys(p_value)) = 1 then
          case
            when jsonb_typeof(p_value -> 'open_cti') = 'string'
              then nullif(p_value ->> 'open_cti', '')
            else (
              select e.value #>> '{}'
                from jsonb_each(p_value) e
                where e.key ~ '^OAuthApp:[A-Za-z0-9_-]{1,200}$'
                  and jsonb_typeof(e.value) = 'string'
                  and (e.value #>> '{}') ~ '^sandra\.dialpad\.v1\.[0-9a-f]{48}$'
            )
          end
        end
    end;
$$;

revoke all on function public.dialpad_cti_custom_data(jsonb) from public, anon, authenticated;

commit;
