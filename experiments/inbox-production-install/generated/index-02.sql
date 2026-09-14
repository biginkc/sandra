CREATE INDEX CONCURRENTLY inbox_parent_message_contact ON public.messages(org_id,contact_id,id);
