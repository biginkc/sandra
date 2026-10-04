-- Rollback for 20261006100700_dialpad_api_dial_support. Turn click_to_dial off first.
-- Restores the eligibility requirement in both dial functions, removes dialpadUserId from the dial
-- release, drops the pre-check function and the two connection columns.
begin;
drop function if exists public.fn_dialpad_call_slots(uuid, uuid, uuid, uuid);
do $patch$
declare
  r record;
  v_def text;
begin
  for r in select * from (values
    ('public.fn_prepare_dialpad_call_intent(uuid,uuid,uuid,uuid,smallint,uuid,uuid,integer)',
      E'  if not found or v_episode.assignee_user_id <> p_rep_user_id\n',
      E'  if not found or v_episode.assignee_user_id <> p_rep_user_id or not v_episode.eligible\n'),
    ('public.fn_authorize_dialpad_dispatch(uuid,uuid,uuid)',
      E'  elsif v_episode.id is null or v_episode.assignee_user_id <> p_rep_user_id\n',
      E'  elsif v_episode.id is null or v_episode.assignee_user_id <> p_rep_user_id or not v_episode.eligible\n'),
    ('public.fn_authorize_dialpad_dispatch(uuid,uuid,uuid)',
      E'      ''dialpadUserId'', v_intent.dialpad_user_id,\n',
      '')
  ) as t(sig, anchor, repl)
  loop
    v_def := pg_get_functiondef(r.sig::regprocedure);
    if position(r.anchor in v_def) = 0 then continue; end if;
    execute replace(v_def, r.anchor, r.repl);
  end loop;
end $patch$;
alter table public.dialpad_org_connections drop column if exists dial_api_key_ref, drop column if exists dial_endpoint;
commit;
