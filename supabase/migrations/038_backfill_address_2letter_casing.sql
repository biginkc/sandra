-- Migration 037 applied initcap() to address fields, which incorrectly
-- lowercased 2-letter tokens like state abbreviations (MO→Mo) and
-- directionals (NW→Nw). This migration corrects them by uppercasing
-- any 2-letter alphabetic token within those fields.

CREATE OR REPLACE FUNCTION public.fix_display_casing(val text)
RETURNS text
LANGUAGE sql IMMUTABLE STRICT AS $$
  SELECT string_agg(
    CASE
      WHEN length(regexp_replace(word, '[^A-Za-z]', '', 'g')) = 2
      THEN upper(word)
      ELSE word
    END,
    ' '
  )
  FROM unnest(string_to_array(val, ' ')) AS word
$$;

UPDATE properties
SET address = public.fix_display_casing(address)
WHERE address IS NOT NULL;

UPDATE properties
SET city = public.fix_display_casing(city)
WHERE city IS NOT NULL;

UPDATE homeowner_details
SET mailing_address = public.fix_display_casing(mailing_address)
WHERE mailing_address IS NOT NULL;

UPDATE homeowner_details
SET mailing_city = public.fix_display_casing(mailing_city)
WHERE mailing_city IS NOT NULL;

DROP FUNCTION public.fix_display_casing(text);
