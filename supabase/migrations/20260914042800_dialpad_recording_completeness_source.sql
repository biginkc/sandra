begin;
-- A manifest only proves completeness after signed source and frozen company
-- routing were processed. Legacy source-less receipts cannot supply this proof.
create or replace function public.dialpad_has_complete_owned_recording(p_org uuid,p_call text)
returns boolean language sql stable security invoker set search_path='' as $$
  with manifests as materialized (
    select e.payload->'recording_details' as details
    from public.dialpad_voice_event_inbox e
    join public.dialpad_voice_intents i on i.org_id=e.org_id and i.provider_call_id=p_call
    join public.dialpad_intent_configuration cfg on cfg.org_id=i.org_id and cfg.intent_id=i.id
    join public.dialpad_connection_revisions frozen on frozen.org_id=cfg.org_id
      and frozen.connection_id=cfg.connection_id and frozen.config_version=cfg.connection_version
    join public.dialpad_voice_webhook_sources source on source.org_id=e.org_id and source.id=e.webhook_source_id
    join public.dialpad_connection_revisions signer on signer.org_id=source.org_id
      and signer.connection_id=source.connection_id and signer.config_version=source.connection_version
    where e.org_id=p_org and e.payload->>'call_id'=p_call
      and e.payload->>'state'='recording' and e.status='processed'
      and signer.provider_company_id=frozen.provider_company_id
      -- An early readiness event may omit details; later enrichment can supply
      -- the complete manifest. Empty/missing lists never prove completeness.
      and case when jsonb_typeof(e.payload->'recording_details')='array'
        then jsonb_array_length(e.payload->'recording_details')>0 else false end
      and lower(e.payload#>>'{target,type}')='user'
      and e.payload#>>'{target,id}'=i.dialpad_user_id
      and e.payload->>'direction'='outbound'
      and e.payload->>'custom_data'=i.id::text
      and e.payload->>'internal_number'=i.caller_id_e164
      and e.payload->>'external_number'=i.destination_e164
  ), segments as materialized (
    select segment from manifests m cross join lateral
      jsonb_array_elements(case when jsonb_typeof(m.details)='array' then m.details else '[]'::jsonb end) segment
  ), known_ids as (
    select segment->>'id' as id from segments
    union
    select provider_recording_id from public.dialpad_recording_artifacts where org_id=p_org and provider_call_id=p_call
  )
  select exists(select 1 from manifests)
    and not exists(select 1 from segments where jsonb_typeof(segment)<>'object'
      or coalesce(jsonb_typeof(segment->'id'),'null') not in ('string','number')
      or nullif(btrim(segment->>'id'),'') is null)
    and exists(select 1 from known_ids)
    and not exists(
      select 1 from known_ids k where not exists(
        select 1 from public.dialpad_recording_artifacts a
        join storage.buckets b on b.id=a.storage_bucket and b.public is false
        where a.org_id=p_org and a.provider_call_id=p_call and a.provider_recording_id=k.id
          and a.status='available' and a.verified_at is not null and isfinite(a.verified_at)
          and a.byte_count>0 and a.decoded_duration_seconds>0
          and a.decoded_duration_seconds<'Infinity'::numeric
          and a.content_sha256 ~ '^[0-9a-f]{64}$'
          and a.media_type in ('audio/mpeg','audio/mp3','audio/wav','audio/x-wav','audio/wave','audio/ogg','application/ogg','audio/flac','audio/x-flac')
          and a.storage_path in (
            p_org::text||'/'||p_call||'/'||a.id::text||'/'||a.content_sha256||'.mp3',
            p_org::text||'/'||p_call||'/'||a.id::text||'/'||a.content_sha256||'.wav',
            p_org::text||'/'||p_call||'/'||a.id::text||'/'||a.content_sha256||'.ogg',
            p_org::text||'/'||p_call||'/'||a.id::text||'/'||a.content_sha256||'.flac')
      )
    );
$$;
commit;
