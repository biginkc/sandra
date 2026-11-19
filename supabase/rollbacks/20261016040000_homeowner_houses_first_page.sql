-- Roll back 20261016040000: removes fn_homeowner_houses_first_page (nothing else depends on it).
begin;

drop function if exists public.fn_homeowner_houses_first_page(uuid, uuid[]);

commit;
