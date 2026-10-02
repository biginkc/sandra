-- Keep the independent browser watchdog sweeping terminal calls while a leg or
-- unresolved Dial cleanup row is still open. A webhook can mark the call ended
-- after confirming only one leg; the other obligation must remain autonomous.
-- Apply with the direct-call feature disabled/drained and the matching app release.

begin;

create index if not exists direct_calls_watchdog_terminal_expiry_idx
  on public.direct_calls (browser_watchdog_expires_at)
  where browser_watchdog_expires_at is not null and status in ('ended', 'failed');

create or replace function public.direct_call_watchdog_claim_expired(p_limit integer)
returns table(call_id uuid, operator_user_id uuid, browser_watchdog_session_id uuid)
language plpgsql security invoker set search_path = public as $$
declare r public.direct_calls;
begin
  if p_limit is null or p_limit < 1 or p_limit > 20 then return; end if;
  for r in
    select * from public.direct_calls c
     where c.browser_watchdog_expires_at <= now()
       and (
         c.status in ('browser_connecting', 'seller_dialing', 'connected', 'ending')
         or (
           c.status in ('ended', 'failed')
           and exists (
             select 1 from public.direct_call_cleanups k
              where k.direct_call_id = c.id and k.confirmed_at is null
           )
         )
       )
       and c.browser_watchdog_session_id is not null
       and (c.browser_watchdog_claimed_at is null or c.browser_watchdog_claimed_at <= now() - interval '15 seconds')
     order by c.browser_watchdog_expires_at
     limit p_limit
     for update skip locked
  loop
    update public.direct_calls
       set browser_watchdog_claimed_at = now(),
           browser_watchdog_expires_at = now() + interval '15 seconds',
           updated_at = now()
     where id = r.id;
    call_id := r.id;
    operator_user_id := r.operator_user_id;
    browser_watchdog_session_id := r.browser_watchdog_session_id;
    return next;
  end loop;
end;
$$;

revoke all on function public.direct_call_watchdog_claim_expired(integer) from public, anon, authenticated;
grant execute on function public.direct_call_watchdog_claim_expired(integer) to service_role;

commit;
