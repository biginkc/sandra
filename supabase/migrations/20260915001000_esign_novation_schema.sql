-- Add the exact novation packet field set and allow repeated placements of its sender values.
begin;

create or replace function public.esign_merge_fields_are_valid(p_fields text[])
returns boolean language sql immutable set search_path = public, pg_temp as $$
  select coalesce((select array_agg(field order by field) from unnest(p_fields) field)
    in (array['closing_date', 'earnest_money', 'offer_price', 'property_address', 'seller_name']::text[], array['additional_terms', 'buyer_name', 'cash_balance', 'closing_date', 'earnest_money', 'earnest_money_holder', 'legal_description', 'offer_price', 'property_address', 'property_city', 'property_state', 'property_zip', 'seller_name']::text[], array['acceptance_date', 'access_days_per_week', 'access_hours_per_visit', 'agreement_date', 'attorney_in_fact', 'buyer_email', 'buyer_name', 'buyer_phone', 'closing_agent_address', 'closing_agent_name', 'closing_agent_phone', 'closing_date', 'due_diligence_days', 'earnest_money', 'earnest_money_holder', 'legal_description', 'offer_expiration', 'offer_price', 'property_address', 'property_state', 'release_date', 'seller_closing_cost_cap', 'seller_email', 'seller_name', 'seller_phone']::text[]), false);
$$;

create or replace function public.esign_website_sender_field_names(p_metadata jsonb)
returns text[] language sql immutable set search_path = public, pg_temp as $$
  select array_agg(distinct field ->> 'name' order by field ->> 'name')
  from jsonb_array_elements(case when jsonb_typeof(p_metadata -> 'documents') = 'array'
    then p_metadata -> 'documents' else '[]'::jsonb end) document
  cross join lateral jsonb_array_elements(case when jsonb_typeof(document -> 'customFields') = 'array'
    then document -> 'customFields' else '[]'::jsonb end) field
  where field ->> 'assignedTo' = 'sender';
$$;

create or replace function public.esign_website_template_metadata_is_valid(
  p_provider_template_id text,
  p_provider_account_id text,
  p_metadata jsonb
)
returns boolean
language sql
immutable
set search_path = public, pg_temp
as $$
  with documents as (
    select document.value as document
    from jsonb_array_elements(
      case
        when jsonb_typeof(p_metadata -> 'documents') = 'array'
          then p_metadata -> 'documents'
        else '[]'::jsonb
      end
    ) document(value)
  ),
  custom_fields as (
    select field.value as field
    from documents
    cross join lateral jsonb_array_elements(
      case
        when jsonb_typeof(documents.document -> 'customFields') = 'array'
          then documents.document -> 'customFields'
        else '[]'::jsonb
      end
    ) field(value)
  ),
  sender_custom_fields as (
    select field.value as field
    from documents
    cross join lateral jsonb_array_elements(
      case
        when jsonb_typeof(documents.document -> 'customFields') = 'array'
          then documents.document -> 'customFields'
        else '[]'::jsonb
      end
    ) field(value)
    where field.value ->> 'assignedTo' = 'sender'
  ),
  sender_merge_fields as (
    select field
    from sender_custom_fields
    where field ->> 'assignedTo' = 'sender'
      and field ->> 'type' = 'text'
      and btrim(coalesce(field ->> 'apiId', '')) <> ''

  ),
  all_required_signature_fields as (
    select field.value as field,
      field.value ->> 'signerRoleName' as role_name
    from documents
    cross join lateral jsonb_array_elements(
      case
        when jsonb_typeof(documents.document -> 'formFields') = 'array'
          then documents.document -> 'formFields'
        else '[]'::jsonb
      end
    ) field(value)
    where field.value ->> 'type' = 'signature'
      and field.value -> 'required' = 'true'::jsonb
  ),
  required_signature_fields as (
    select role_name
    from all_required_signature_fields
    where field ->> 'assignedTo' = 'signer'
      and btrim(coalesce(field ->> 'apiId', '')) <> ''
      and field ->> 'signerRoleName' in ('Seller', 'Buyer')
  )
  select coalesce(btrim(coalesce(p_provider_template_id, '')) <> ''
    and btrim(coalesce(p_provider_account_id, '')) <> ''
    and jsonb_typeof(p_metadata) = 'object'
    and p_metadata ->> 'providerTemplateId' = p_provider_template_id
    and p_metadata -> 'isEmbedded' = 'false'::jsonb
    and p_metadata -> 'isLocked' = 'false'::jsonb
    and exists (
      select 1
      from jsonb_array_elements(
        case
          when jsonb_typeof(p_metadata -> 'accounts') = 'array'
            then p_metadata -> 'accounts'
          else '[]'::jsonb
        end
      ) account(value)
      where account.value ->> 'accountId' = p_provider_account_id
    )
    and p_metadata -> 'signerRoles' =
      jsonb_build_array(
        jsonb_build_object('name', 'Seller', 'order', 0),
        jsonb_build_object('name', 'Buyer', 'order', 1)
      )
    and exists (select 1 from documents)
    and public.esign_merge_fields_are_valid(public.esign_website_sender_field_names(p_metadata))
    and (select count(*) from custom_fields) = (select count(*) from sender_custom_fields)
    and (select count(*) from sender_merge_fields) = (select count(*) from sender_custom_fields)
    and (cardinality(public.esign_website_sender_field_names(p_metadata)) = 25
      or (select count(*) from sender_custom_fields) = cardinality(public.esign_website_sender_field_names(p_metadata)))
    and (cardinality(public.esign_website_sender_field_names(p_metadata)) <> 13 or not exists (
      select 1 from sender_custom_fields
      where field -> 'required' is distinct from to_jsonb(field ->> 'name' <> 'additional_terms')
    ))
    and (cardinality(public.esign_website_sender_field_names(p_metadata)) <> 25 or not exists (
      select 1 from sender_custom_fields where field -> 'required' is distinct from 'true'::jsonb
    ))
    and not exists (
      select 1
      from all_required_signature_fields
      where field ->> 'assignedTo' is distinct from 'signer'
        or role_name is null
        or role_name not in ('Seller', 'Buyer')
    )
    and exists (
      select 1 from required_signature_fields where role_name = 'Seller'
    )
    and exists (
      select 1 from required_signature_fields where role_name = 'Buyer'
    ), false);
$$;

commit;
