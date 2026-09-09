-- Add truthful attribution for FSBO listings collected from Zillow.
-- Preserve every existing source value and the existing NULL allowance.
ALTER TABLE public.properties DROP CONSTRAINT properties_source_check;
ALTER TABLE public.properties ADD CONSTRAINT properties_source_check
  CHECK (source IS NULL OR source = ANY (ARRAY[
    'dealmachine', 'propstream', 'titlepro', 'reisift', 'agent_outreach',
    'driving_for_dollars', 'referral', 'cold_call', 'sms', 'web_form',
    'direct_mail', 'zillow'
  ]::text[]));
