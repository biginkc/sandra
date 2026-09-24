-- Add truthful attribution for properties exported from Assigns.
-- Preserve every existing source value and the existing NULL allowance.
ALTER TABLE public.properties DROP CONSTRAINT properties_source_check;
ALTER TABLE public.properties ADD CONSTRAINT properties_source_check
  CHECK (source IS NULL OR source = ANY (ARRAY[
    'assigns', 'dealmachine', 'propstream', 'titlepro', 'reisift', 'agent_outreach',
    'driving_for_dollars', 'referral', 'cold_call', 'sms', 'web_form',
    'direct_mail', 'zillow'
  ]::text[]));
