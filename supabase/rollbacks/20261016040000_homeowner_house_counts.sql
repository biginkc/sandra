-- Roll back 20261016040000: removes fn_homeowner_house_counts (nothing else depends on it).
begin;

drop function if exists public.fn_homeowner_house_counts(uuid, uuid[]);

commit;
