-- Addresses advisor warning `function_search_path_mutable` for both
-- SECURITY DEFINER functions defined in migration 001.
alter function public.merge_duplicate_properties(uuid, uuid)
  set search_path = public, pg_temp;

alter function public.delete_contact(uuid, text)
  set search_path = public, pg_temp;
