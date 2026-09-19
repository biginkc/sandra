begin;

set local lock_timeout = '5s';
set local statement_timeout = '120s';

-- Rep-SMS human takeover checks only need the newest scoped inbound/outbound
-- rows within the bounded 50-row lookup horizon. Keep those queries bounded by
-- the conversation identity and event ordering instead of scanning a long SMS
-- history for each webhook retry.
create index if not exists idx_messages_rep_sms_takeover_lookup
  on public.messages (
    conversation_id,
    property_id,
    contact_id,
    direction,
    sent_at desc,
    created_at desc,
    id desc
  )
  where channel = 'sms'
    and conversation_id is not null
    and property_id is not null
    and contact_id is not null;

comment on index public.idx_messages_rep_sms_takeover_lookup is
  'Supports rep-SMS human takeover source and prior-inbound lookups within a bounded 50-row horizon per timestamp branch.';

commit;
