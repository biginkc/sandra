alter table public.ai_responder_configs
  add column reply_delay_min_seconds integer not null default 0
    check (reply_delay_min_seconds >= 0),
  add column reply_delay_max_seconds integer not null default 0
    check (reply_delay_max_seconds >= 0 and reply_delay_max_seconds <= 900);

alter table public.ai_responder_configs
  add constraint ai_responder_reply_delay_range
    check (reply_delay_max_seconds >= reply_delay_min_seconds);
