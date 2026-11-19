-- Messages v2 redesign, PR 3: per-org engine switch.
--
-- 'outcome_v1' is today's eight-answer Jev path and the default, so nothing changes
-- for any org until an owner sets 'nine_questions' (Jarrad's nine yes/no questions).
-- Additive, no data step. A missing column reads as 'outcome_v1' in code.
begin;

alter table public.ai_responder_configs
  add column if not exists classifier_engine text not null default 'outcome_v1';

do $$
begin
  if not exists (
    select 1 from pg_constraint where conname = 'ai_responder_configs_classifier_engine_check'
  ) then
    alter table public.ai_responder_configs
      add constraint ai_responder_configs_classifier_engine_check
      check (classifier_engine in ('outcome_v1', 'nine_questions'));
  end if;
end $$;

comment on column public.ai_responder_configs.classifier_engine is
  'Which Jev question set decides inbound replies: outcome_v1 (eight answers, default) or nine_questions (Messages v2 PR 3). Only applies while classifier_provider = jev.';

commit;
