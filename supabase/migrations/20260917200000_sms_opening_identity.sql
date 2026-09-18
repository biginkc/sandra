-- Migration 20260917200000: make approved opening SMS identify Mel with BMH.
--
-- This is a forward data migration for the BMH Group tenant only. It updates
-- seeded opening sources when they still contain the exact historical copy;
-- already-updated rows and later custom edits are intentionally left alone.
-- It does not create externally-seeded FSBO rows, and it does not touch
-- messages (sent, queued, or otherwise).

do $$
declare
  v_org_id uuid := '00000000-0000-0000-0000-000000000bbb';
  v_updated integer;
begin
  if not exists (
    select 1
    from public.organizations
    where id = v_org_id
      and name = 'BMH Group'
  ) then
    raise notice 'BMH Group organization not found — skipping opening identity migration';
    return;
  end if;

  -- The 15 rows seeded by migration 042. Match both category and exact old
  -- copy so a future edit to a system-managed row is never overwritten.
  with opener_changes(name, category, old_content, new_content) as (
    values
      ('Opener: still owner (casual)', 'Opener - Homeowner',
       'Hey {{first_name | there}}, are you still the owner over on {{property_address}}?',
       'Hi {{first_name | there}}, Mel with BMH here. We''re local home buyers. Any interest in a cash offer for {{property_address}}?'),
      ('Opener: quick question (direct)', 'Opener - Homeowner',
       '{{first_name | Hi}}, quick question, do you still own {{property_address}}?',
       'Hey {{first_name | there}}, I''m Mel with BMH. We buy homes locally. Would you consider a cash offer on {{property_address}}?'),
      ('Opener: still yours (brief)', 'Opener - Homeowner',
       '{{first_name | Hey}}, is the house on {{property_address}} still yours?',
       'Hi {{first_name | there}}, I''m Mel with BMH, a local home-buying team. Open to a cash offer for {{property_address}}?'),
      ('Opener: named sender + owner check', 'Opener - Homeowner',
       'Hi {{first_name | there}}, this is {{my_first_name}}. You still the owner at {{property_address}}?',
       'Hey {{first_name | there}}, Mel with BMH here. We''re local cash buyers. Have you thought about selling {{property_address}}?'),
      ('Opener: named sender + quick one', 'Opener - Homeowner',
       '{{first_name | Hey}}, {{my_first_name}} here. Quick one, are you the owner of {{property_address}}?',
       'Hi {{first_name | there}}, I''m Mel with BMH. We''re local home buyers. Would you like a cash offer on {{property_address}}?'),
      ('Opener: random question', 'Opener - Homeowner',
       'Hi {{first_name | there}}, random question, is {{property_address}} still your place?',
       'Hi {{first_name | there}}, Mel with BMH here. We buy homes locally. Would selling {{property_address}} for cash interest you?'),
      ('Opener: out of the blue', 'Opener - Homeowner',
       '{{first_name | Hey}}, sorry to text out of the blue. You still own {{property_address}}?',
       'Hey {{first_name | there}}, I''m Mel with BMH, a local home-buying team. Would you consider selling {{property_address}}?'),
      ('Opener: hope not too random', 'Opener - Homeowner',
       'Hey {{first_name | there}}, hope this isn''t too random. Still your house at {{property_address}}?',
       'Hi {{first_name | there}}, Mel with BMH here. We''re local cash buyers. Open to discussing an offer for {{property_address}}?'),
      ('Opener: weird text + confirm', 'Opener - Homeowner',
       '{{first_name | Hi}}, I know this is a weird text. Is {{property_address}} still yours?',
       'Hi {{first_name | there}}, I''m Mel with BMH. We buy homes locally. Is a cash offer for {{property_address}} worth discussing?'),
      ('Opener: local sender + tied to', 'Opener - Homeowner',
       'Hi {{first_name | there}}, {{my_first_name}} in {{city | your area}}. Quick question, still tied to {{property_address}}?',
       'Hey {{first_name | there}}, Mel with BMH here. We''re local home buyers. Would a cash offer on {{property_address}} interest you?'),
      ('Opener: right person', 'Opener - Homeowner',
       '{{first_name | Hey}}, hope I have the right person. You own the place on {{property_address}}?',
       'Hi {{first_name | there}}, I''m Mel with BMH. We''re local cash buyers. Can we discuss a cash offer for {{property_address}}?'),
      ('Opener: still linked', 'Opener - Homeowner',
       'Hey {{first_name | there}}, are you still linked to {{property_address}}?',
       'Hey {{first_name | there}}, I''m Mel with BMH. We buy houses locally. Is selling {{property_address}} something you''d consider?'),
      ('Opener: named + is this yours', 'Opener - Homeowner',
       '{{first_name | Hi}}, {{my_first_name}} here. Is {{property_address}} your house?',
       'Hi {{first_name | there}}, Mel with BMH here. We''re local home buyers. Interested in hearing a cash offer for {{property_address}}?'),
      ('Opener: apology + still own', 'Opener - Homeowner',
       'Hi {{first_name | there}}, apologies for the cold text. Still own over at {{property_address}}?',
       'Hi {{first_name | there}}, I''m Mel with BMH. We buy homes locally for cash. Are you considering selling {{property_address}}?'),
      ('Opener: local area + do you own', 'Opener - Homeowner',
       '{{first_name | Hey}}, {{my_first_name}} in {{city | the area}}. Do you still own {{property_address}}?',
       'Hey {{first_name | there}}, Mel with BMH here. We''re local home buyers. Could we talk about a cash offer for {{property_address}}?')
  )
  update public.sms_templates as t
  set content = c.new_content
  from opener_changes as c
  where t.org_id = v_org_id
    and t.name = c.name
    and t.category = c.category
    and t.deleted_at is null
    and t.content = c.old_content;

  get diagnostics v_updated = row_count;
  raise notice 'updated % BMH Opener - Homeowner templates', v_updated;

  -- These rows are externally seeded and may be absent on a fresh install;
  -- update them only when the exact expected source copy is present.
  with additional_changes(name, old_content, new_content) as (
    values
      ('Opener: FSBO + start a conversation',
       'Hi, this is {{my_first_name | Mel}} with BMH Group. I''m interested in {{property_address | your property}}. Would you be open to chatting about it?',
       'Hi, this is Mel with BMH. I''m interested in {{property_address | your property}}. Would you be open to chatting about it?'),
      ('Awkward owner check',
       '{{first_name | Hey there}}, sorry to bother. I think you might own {{property_address}}? - {{my_first_name}}',
       'Hi {{first_name | there}}, I''m Mel with BMH, a local home buyer. Do you own {{property_address}}?'),
      ('First-message identification',
       '{{my_first_name}} with {{company_name}}. Reply STOP to opt out.',
       'Mel with BMH. Reply STOP to opt out.'),
      ('Agent: Active listing post-VM',
       'Hi {{first_name | there}}, {{my_first_name}} here, left you a VM on your listing at {{property_address}}. Active cash buyer locally, got 2 min?',
       'Hi {{first_name | there}}, Mel with BMH here. I left you a VM on your listing at {{property_address}}. We''re local cash buyers. Got 2 min?'),
      ('Opener: FSBO + listing reference',
       'Hi, this is {{my_first_name | Mel}} with BMH Group. I saw your listing for {{property_address | your property}} and wanted to reach out. Are you still looking for a buyer?',
       'Hi, this is Mel with BMH. I saw your listing for {{property_address | your property}} and wanted to reach out. Are you still looking for a buyer?'),
      ('Random + owner check',
       'Hi {{first_name | there}}, I know this is random. Looking for the owner of {{property_address}}. That you?',
       'Hi {{first_name | there}}, Mel with BMH here. We buy homes locally. Are you the owner of {{property_address}}?'),
      ('Soft tied-to check',
       'Hey {{first_name | there}}, quick one - are you still tied to {{property_address}}? - {{my_first_name}}',
       'Hey {{first_name | there}}, Mel with BMH here. We''re local home buyers. Are you still tied to {{property_address}}?'),
      ('Opener: FSBO + owner confirmation',
       'Hi, this is {{my_first_name | Mel}} with BMH Group. I''m reaching out about {{property_address | your property}}. Are you the owner?',
       'Hi, this is Mel with BMH. I''m reaching out about {{property_address | your property}}. Are you the owner?'),
      ('Agent: Expired listing',
       'Hi {{first_name}}, saw {{property_address}} expired. Active cash buyer in {{market | the area}}, interested if your seller is still open.',
       'Hi {{first_name | there}}, I''m Mel with BMH. We''re local cash buyers. I saw {{property_address}} expired. Is your seller still open to an offer?'),
      ('Owner check (consensus)',
       'Are you the owner of {{property_address}}?',
       'Mel with BMH here. We''re local home buyers. Are you the owner of {{property_address}}?'),
      ('Opener: FSBO + still available',
       'Hi, this is {{my_first_name | Mel}} with BMH Group. I''m interested in {{property_address | your property}}. Is it still available?',
       'Hi, this is Mel with BMH. I''m interested in {{property_address | your property}}. Is it still available?'),
      ('Opener: FSBO + text preference',
       'Hi, this is {{my_first_name | Mel}} with BMH Group. Your listing for {{property_address | your property}} caught my attention. Is text a good way to connect about it?',
       'Hi, this is Mel with BMH. Your listing for {{property_address | your property}} caught my attention. Is text a good way to connect about it?'),
      ('Local sender + still own',
       '{{first_name | Hi}}, {{my_first_name}} here in {{city | your area}}. Quick question: still own the place at {{property_address}}?',
       'Hi {{first_name | there}}, I''m Mel with BMH. We''re local home buyers. Do you still own {{property_address}}?')
  )
  update public.sms_templates as t
  set content = c.new_content
  from additional_changes as c
  where t.org_id = v_org_id
    and t.name = c.name
    and t.deleted_at is null
    and t.content = c.old_content;

  get diagnostics v_updated = row_count;
  raise notice 'updated % additional BMH opener templates when present', v_updated;

  -- The starter sequence is present on fresh installs and can be customized
  -- later. Match the exact historical body before changing step 0.
  update public.sequence_steps as step
  set template_body = '{{#if first_name}}Hi {{first_name}}, {{/if}}this is Mel with BMH. I saw your property at {{property_address}}. Would you consider a cash offer? {{opt_out}}'
  from public.sequences as seq
  where step.sequence_id = seq.id
    and seq.org_id = v_org_id
    and lower(seq.name) = lower('First touch new lead')
    and step.step_index = 0
    and step.action_type = 'send_sms'
    and step.template_body = '{{#if first_name}}Hi {{first_name}}, {{/if}}this is {{my_first_name}} with {{company_name}}. I saw your property at {{property_address}}. Would you consider a cash offer? {{opt_out}}';

  get diagnostics v_updated = row_count;
  raise notice 'updated % BMH first-touch step 0 bodies', v_updated;
end;
$$;
