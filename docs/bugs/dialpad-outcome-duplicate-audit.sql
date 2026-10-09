-- Read-only candidate audit. Equal URLs are evidence for review, not permission to merge/delete.
-- Does not detect missing/different URLs; does not return recording URLs or note contents.
select a.org_id, a.property_id, a.actor_user_id,
       a.id as automatic_attempt_id, a.call_activity_id,
       m.id as manual_attempt_id,
       a.outcome as automatic_outcome, m.outcome as manual_outcome,
       a.occurred_at as automatic_occurred_at, m.occurred_at as manual_occurred_at,
       a.prompt_acknowledged_at,
       a.assignment_episode_id = m.assignment_episode_id as same_episode,
       nullif(btrim(m.note),'') is not null as manual_has_note,
       (select count(*) from public.rep_sms_obligations o where o.attempt_id=m.id) as manual_obligations,
       (select count(*) from public.acquisition_commands c where c.org_id=m.org_id and c.result->>'attemptId'=m.id::text) as manual_receipts
from public.acquisition_attempts a
join public.acquisition_attempts m
  on m.org_id=a.org_id and m.property_id=a.property_id and m.actor_user_id=a.actor_user_id
 and btrim(m.recording_url)=btrim(a.recording_url)
where a.source='dialpad' and a.call_activity_id is not null
  and public.dialpad_cti_is_ledger_key(a.provider_attempt_key)
  and m.source='dialpad' and m.call_activity_id is null
  and nullif(btrim(a.recording_url),'') is not null
order by a.org_id, a.property_id, a.occurred_at;
