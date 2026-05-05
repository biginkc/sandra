-- Migration 042: Seed BMH opener template pool (Opener - Homeowner)
--
-- Adds 15 carrier-safe cold opener variants. All are Touch-1 ownership-
-- verification questions with no sell/buy/offer/looking keywords (per A2P
-- 10DLC carrier filter guidance from docs/sms-templates.md). Pipe-fallbacks
-- on {{first_name}} so cold lists with missing names render gracefully.
--
-- Category 'Opener - Homeowner' is distinct from 'Outreach - Homeowner'
-- (Touch 1-5 sequence templates). Sequence step 0 can reference this pool
-- via template_category = 'Opener - Homeowner' (added in migration 041),
-- and the runner picks a deterministic variant per enrollment using a
-- SHA-256 hash of enrollment.id so no two back-to-back sends are identical.

DO $$
DECLARE
  v_org_id uuid;
BEGIN
  SELECT id INTO v_org_id FROM public.organizations WHERE name = 'BMH Group' LIMIT 1;
  IF v_org_id IS NULL THEN
    RAISE NOTICE 'BMH Group org not found — skipping opener template seed';
    RETURN;
  END IF;

  INSERT INTO public.sms_templates (org_id, name, content, category, system_managed) VALUES
  (v_org_id, 'Opener: still owner (casual)',       'Hey {{first_name | there}}, are you still the owner over on {{property_address}}?',                                         'Opener - Homeowner', true),
  (v_org_id, 'Opener: quick question (direct)',     '{{first_name | Hi}}, quick question, do you still own {{property_address}}?',                                               'Opener - Homeowner', true),
  (v_org_id, 'Opener: still yours (brief)',         '{{first_name | Hey}}, is the house on {{property_address}} still yours?',                                                   'Opener - Homeowner', true),
  (v_org_id, 'Opener: named sender + owner check', 'Hi {{first_name | there}}, this is {{my_first_name}}. You still the owner at {{property_address}}?',                        'Opener - Homeowner', true),
  (v_org_id, 'Opener: named sender + quick one',   '{{first_name | Hey}}, {{my_first_name}} here. Quick one, are you the owner of {{property_address}}?',                       'Opener - Homeowner', true),
  (v_org_id, 'Opener: random question',            'Hi {{first_name | there}}, random question, is {{property_address}} still your place?',                                     'Opener - Homeowner', true),
  (v_org_id, 'Opener: out of the blue',            '{{first_name | Hey}}, sorry to text out of the blue. You still own {{property_address}}?',                                  'Opener - Homeowner', true),
  (v_org_id, 'Opener: hope not too random',        'Hey {{first_name | there}}, hope this isn''t too random. Still your house at {{property_address}}?',                        'Opener - Homeowner', true),
  (v_org_id, 'Opener: weird text + confirm',       '{{first_name | Hi}}, I know this is a weird text. Is {{property_address}} still yours?',                                    'Opener - Homeowner', true),
  (v_org_id, 'Opener: local sender + tied to',     'Hi {{first_name | there}}, {{my_first_name}} in {{city | your area}}. Quick question, still tied to {{property_address}}?', 'Opener - Homeowner', true),
  (v_org_id, 'Opener: right person',               '{{first_name | Hey}}, hope I have the right person. You own the place on {{property_address}}?',                            'Opener - Homeowner', true),
  (v_org_id, 'Opener: still linked',               'Hey {{first_name | there}}, are you still linked to {{property_address}}?',                                                 'Opener - Homeowner', true),
  (v_org_id, 'Opener: named + is this yours',      '{{first_name | Hi}}, {{my_first_name}} here. Is {{property_address}} your house?',                                          'Opener - Homeowner', true),
  (v_org_id, 'Opener: apology + still own',        'Hi {{first_name | there}}, apologies for the cold text. Still own over at {{property_address}}?',                           'Opener - Homeowner', true),
  (v_org_id, 'Opener: local area + do you own',    '{{first_name | Hey}}, {{my_first_name}} in {{city | the area}}. Do you still own {{property_address}}?',                    'Opener - Homeowner', true)
  ON CONFLICT (org_id, name) DO NOTHING;
END;
$$;
