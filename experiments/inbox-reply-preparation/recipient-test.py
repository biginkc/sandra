#!/usr/bin/env python3
"""Canonical recipient capture proof; no provider, public grant or durable job."""
import hashlib,json,subprocess,sys
from pathlib import Path
P=Path(__file__).resolve().parent
sys.path.insert(0,str(P.parent/'inbox-projection'/'fixture'))
from guards import validate_container,validate_cron
if sys.argv[1:]!=['--run-owned-fixture']:raise SystemExit('Explicit owned fixture required')
D=['docker','--host','unix:///Users/jarradhenry/.colima/inbox-redesign-20260913/docker.sock'];N='sandra-inbox-projection-t2-db'
validate_container(json.loads(subprocess.check_output(D+['inspect',N],text=True))[0])
def sql(q):
 r=subprocess.run(D+['exec','-i',N,'psql','-XqAt','-U','postgres','-d','postgres','-v','ON_ERROR_STOP=1'],input=q,text=True,capture_output=True,timeout=30)
 if r.returncode:raise RuntimeError(r.stderr)
 return r.stdout.strip()
validate_cron(sql('SHOW cron.launch_active_jobs'))
if sql('SELECT marker FROM inbox_t2_fixture.identity')!='sandra-inbox-projection-t2-owned-synthetic':raise RuntimeError('Wrong fixture')
if sql("SELECT to_regnamespace('inbox_reply_context') IS NULL AND to_regnamespace('inbox_reply_preparation') IS NULL")!='t':raise RuntimeError('Refusing existing reply schema')
context=(P.parent/'inbox-reply-boundary'/'context.sql').read_text();recipient=(P/'recipient.sql').read_text();batch=(P/'batch.sql').read_text()
if not all(s.endswith('COMMIT;\n') and '\nBEGIN;\n' in s for s in [context,recipient,batch]):raise RuntimeError('Expected source transaction boundary')
test=r"""
DO $test$
DECLARE o uuid:=gen_random_uuid();foreign_org uuid:=gen_random_uuid();p uuid:=gen_random_uuid();c uuid:=gen_random_uuid();contact uuid:=gen_random_uuid();m uuid:=gen_random_uuid();sender uuid:=gen_random_uuid();missing uuid:=gen_random_uuid();c2 uuid:=gen_random_uuid();no_consent_contact uuid:=gen_random_uuid();no_consent_property uuid:=gen_random_uuid();no_consent_conversation uuid:=gen_random_uuid();a jsonb;b jsonb;before_count bigint;
BEGIN
 INSERT INTO organizations(id,name) VALUES(o,'Owned reply preparation'),(foreign_org,'Foreign reply preparation');
 INSERT INTO contacts(id,org_id,first_name,phone_1,phone_1_type) VALUES(contact,o,'Ada','(816) 555-0100','mobile');
 INSERT INTO properties(id,org_id,address,state,market,homeowner_contact_id) VALUES(p,o,'Owned reply property','MO','KC',contact);
 INSERT INTO provider_sender_numbers(id,org_id,provider,phone_e164,status) VALUES(sender,o,'sendillo','+18165550101','active');
 INSERT INTO messages(id,org_id,conversation_id,contact_id,property_id,channel,direction,status,body,from_address,to_address) VALUES(m,o,c,contact,p,'sms','inbound','received','Owned inbound','+18165550100','+18165550101');
 -- Baseline eligibility requires an affirmative opt-in on file (fail-closed
 -- consent, B2); without this the very first assertion below would now fail.
 INSERT INTO consent_events(org_id,contact_id,channel,event_type,source) VALUES(o,contact,'sms','opt_in_confirmed','owned_reply_test');
 a:=inbox_reply_preparation.recipient(o,c);
 IF a->>'exclusion' IS NOT NULL OR a->>'from'<>'+18165550101' OR a->>'to'<>'+18165550100' OR a->'variables'->>'first_name'<>'Ada' OR a->'variables'->>'market'<>'KC' THEN RAISE EXCEPTION 'Canonical route/personalization mismatch: %',a;END IF;

 INSERT INTO messages(org_id,conversation_id,contact_id,property_id,channel,direction,status,body,from_address,to_address) VALUES(o,c2,contact,p,'sms','inbound','received','Second owned inbound','+18165550100','+18165550101');
 b:=inbox_reply_preparation.batch(o,ARRAY[c,c2,missing]);
 IF b->>'has_duplicate_destinations'<>'true' OR b->>'distinct_recipient_count'<>'1' OR (SELECT count(*) FROM jsonb_array_elements(b->'items') WHERE value->>'duplicate_destination'='true')<>2 THEN RAISE EXCEPTION 'Duplicate destination conflict missing: %',b;END IF;
 BEGIN PERFORM inbox_reply_preparation.batch(o,ARRAY[c,c]);RAISE EXCEPTION 'Duplicate target admitted' USING ERRCODE='ZX001';EXCEPTION WHEN raise_exception THEN NULL;END;
 BEGIN PERFORM inbox_reply_preparation.batch(o,ARRAY[c,NULL]);RAISE EXCEPTION 'Null target admitted' USING ERRCODE='ZX001';EXCEPTION WHEN raise_exception THEN NULL;END;
 BEGIN PERFORM inbox_reply_preparation.batch(o,ARRAY[]::uuid[]);RAISE EXCEPTION 'Empty targets admitted' USING ERRCODE='ZX001';EXCEPTION WHEN raise_exception THEN NULL;END;
 IF inbox_reply_preparation.quiet_hours('MO','2026-01-15T14:00:00Z')->>'ok'<>'true' OR inbox_reply_preparation.quiet_hours('MO','2026-01-15T13:59:59Z')->>'ok'<>'false' OR inbox_reply_preparation.quiet_hours('MO','2026-01-16T03:00:00Z')->>'ok'<>'false' THEN RAISE EXCEPTION 'Winter window boundary wrong';END IF;
 IF inbox_reply_preparation.quiet_hours(' mo ','2026-07-15T13:00:00Z')->>'ok'<>'true' OR inbox_reply_preparation.quiet_hours('MO','2026-07-16T02:00:00Z')->>'ok'<>'false' OR inbox_reply_preparation.quiet_hours('ZZ',clock_timestamp())->>'ok'<>'false' OR inbox_reply_preparation.quiet_hours('GU','2026-07-14T22:00:00Z')->>'ok'<>'true' THEN RAISE EXCEPTION 'Summer/territory/state window wrong';END IF;
 UPDATE messages SET read_at=clock_timestamp() WHERE id=m;
 b:=inbox_reply_preparation.recipient(o,c);
 IF b->>'exclusion' IS NOT NULL OR a->'dependencies'->>'known_reply' IS DISTINCT FROM b->'dependencies'->>'known_reply' THEN RAISE EXCEPTION 'Read status invalidated reply content';END IF;
 UPDATE messages SET body='Edited inbound' WHERE id=m;
 b:=inbox_reply_preparation.recipient(o,c);
 IF a->'dependencies'->>'known_reply'=b->'dependencies'->>'known_reply' THEN RAISE EXCEPTION 'Inbound edit missing revision';END IF;
 SELECT count(*) INTO before_count FROM public.inbox_inbound_heads;
 IF inbox_reply_preparation.recipient(foreign_org,c)->>'exclusion' IS DISTINCT FROM 'conversation_unavailable' OR inbox_reply_preparation.recipient(o,missing)->>'exclusion' IS DISTINCT FROM 'conversation_unavailable' THEN RAISE EXCEPTION 'Foreign/missing target admitted';END IF;
 IF (SELECT count(*) FROM public.inbox_inbound_heads)<>before_count THEN RAISE EXCEPTION 'Missing target allocated head';END IF;
 UPDATE contacts SET phone_1_type='landline' WHERE id=contact;
 IF inbox_reply_preparation.recipient(o,c)->>'exclusion' IS DISTINCT FROM 'landline' THEN RAISE EXCEPTION 'Landline admitted';END IF;
 -- B1: a saved but never-classified line type must fail closed too, not
 -- fall through as eligible just because it isn't specifically 'landline'.
 UPDATE contacts SET phone_1_type='unknown' WHERE id=contact;
 IF inbox_reply_preparation.recipient(o,c)->>'exclusion' IS DISTINCT FROM 'unclassified_phone' THEN RAISE EXCEPTION 'Unclassified line type admitted';END IF;
 UPDATE contacts SET phone_1_type='mobile',phone_1='+18165550999' WHERE id=contact;
 IF inbox_reply_preparation.recipient(o,c)->>'exclusion' IS DISTINCT FROM 'phone_not_saved' THEN RAISE EXCEPTION 'Unsaved route admitted';END IF;
 UPDATE contacts SET phone_1='+18165550100' WHERE id=contact;
 -- B1 (round 3): a CONFLICTING duplicate save — the same destination number
 -- saved twice, once as mobile and once as landline — must fail closed on
 -- every matching slot, not just whichever comes first by ordinal.
 UPDATE contacts SET phone_2='+18165550100',phone_2_type='landline' WHERE id=contact;
 IF inbox_reply_preparation.recipient(o,c)->>'exclusion' IS DISTINCT FROM 'landline' THEN RAISE EXCEPTION 'Conflicting mobile+landline duplicate slot admitted: %',inbox_reply_preparation.recipient(o,c);END IF;
 UPDATE contacts SET phone_2=NULL WHERE id=contact;
 UPDATE provider_sender_numbers SET status='inactive' WHERE id=sender;
 IF inbox_reply_preparation.recipient(o,c)->>'exclusion' IS DISTINCT FROM 'sender_unavailable' THEN RAISE EXCEPTION 'Inactive sender admitted';END IF;
 UPDATE provider_sender_numbers SET status='active' WHERE id=sender;
 INSERT INTO consent_events(org_id,contact_id,channel,event_type,source) VALUES(o,contact,'sms','opt_out','owned_reply_test');
 IF inbox_reply_preparation.recipient(o,c)->>'exclusion' IS DISTINCT FROM 'sms_suppressed' THEN RAISE EXCEPTION 'Opt-out admitted';END IF;
 -- B2: a saved mobile with a clean record but NO consent event at all must
 -- fail closed, not default to eligible the way send.ts/bulk-queue.ts do.
 INSERT INTO contacts(id,org_id,first_name,phone_1,phone_1_type) VALUES(no_consent_contact,o,'Bea','+18165550222','mobile');
 INSERT INTO properties(id,org_id,address,state,homeowner_contact_id) VALUES(no_consent_property,o,'Owned no-consent property','MO',no_consent_contact);
 INSERT INTO messages(org_id,conversation_id,contact_id,property_id,channel,direction,status,body,from_address,to_address) VALUES(o,no_consent_conversation,no_consent_contact,no_consent_property,'sms','inbound','received','Owned no-consent inbound','+18165550222','+18165550101');
 IF inbox_reply_preparation.recipient(o,no_consent_conversation)->>'exclusion' IS DISTINCT FROM 'no_consent' THEN RAISE EXCEPTION 'No-consent contact admitted';END IF;
 IF has_schema_privilege('authenticated','inbox_reply_preparation','USAGE') OR has_function_privilege('authenticated','inbox_reply_preparation.recipient(uuid,uuid)','EXECUTE') THEN RAISE EXCEPTION 'Private recipient exposed';END IF;
END $test$;
DO $cap$
DECLARE o uuid:=gen_random_uuid();p uuid;contact uuid;c uuid;ids uuid[]:='{}';first_contact uuid;a jsonb;i integer;destination text;
BEGIN
 INSERT INTO organizations(id,name) VALUES(o,'Owned 51-recipient cap');
 INSERT INTO provider_sender_numbers(org_id,provider,phone_e164,status) VALUES(o,'sendillo','+18165550101','active');
 FOR i IN 1..51 LOOP
  p:=gen_random_uuid();contact:=gen_random_uuid();c:=gen_random_uuid();ids:=array_append(ids,c);destination:='+120255501'||lpad(i::text,2,'0');
  IF i=1 THEN first_contact:=contact;END IF;
  INSERT INTO contacts(id,org_id,phone_1,phone_1_type) VALUES(contact,o,destination,'mobile');
  INSERT INTO consent_events(org_id,contact_id,channel,event_type,source) VALUES(o,contact,'sms','opt_in_confirmed','owned_reply_test');
  INSERT INTO properties(id,org_id,address,state,homeowner_contact_id) VALUES(p,o,'Owned cap property','MO',contact);
  INSERT INTO messages(org_id,conversation_id,contact_id,property_id,channel,direction,status,body,from_address,to_address) VALUES(o,c,contact,p,'sms','inbound','received','Owned cap inbound',destination,'+18165550101');
 END LOOP;
 a:=inbox_reply_preparation.batch(o,ids);
 IF a->>'distinct_recipient_count'<>'51' OR a->>'over_recipient_limit'<>'true' THEN RAISE EXCEPTION '51 recipients not blocked: %',a->>'distinct_recipient_count';END IF;
 UPDATE contacts SET sms_opted_out=true WHERE id=first_contact;
 a:=inbox_reply_preparation.batch(o,ids);
 IF a->>'distinct_recipient_count'<>'50' OR a->>'over_recipient_limit'<>'false' OR jsonb_array_length(a->'items')<>51 THEN RAISE EXCEPTION 'Cap evaluated before canonical exclusions';END IF;
 BEGIN PERFORM inbox_reply_preparation.batch(o,array_fill(gen_random_uuid(),ARRAY[501]));RAISE EXCEPTION '501 target envelope admitted' USING ERRCODE='ZX001';EXCEPTION WHEN raise_exception THEN NULL;END;
END $cap$;
-- E1-E4 convergence matrix (round 4): destination_policy() exercised
-- directly, isolated from the rest of recipient()'s conversation-identity
-- plumbing, so each of its steps is independently mutation-checked: insert
-- the fact, assert the exclusion; remove/omit it, assert eligible again.
DO $policy$
DECLARE o uuid:=gen_random_uuid();canonical uuid:=gen_random_uuid();second uuid:=gen_random_uuid();third uuid:=gen_random_uuid();fourth uuid:=gen_random_uuid();r jsonb;
BEGIN
 INSERT INTO organizations(id,name) VALUES(o,'Owned destination policy matrix');
 INSERT INTO contacts(id,org_id,phone_1,phone_1_type) VALUES(canonical,o,'+18165550300','mobile');
 INSERT INTO consent_events(org_id,contact_id,channel,event_type,source) VALUES(o,canonical,'sms','opt_in_confirmed','owned_policy_test');
 r:=inbox_reply_preparation.destination_policy(o,'+18165550300',canonical,true);
 IF r->>'exclusion' IS DISTINCT FROM NULL THEN RAISE EXCEPTION 'Baseline eligible destination excluded (strict): %',r;END IF;
 r:=inbox_reply_preparation.destination_policy(o,'+18165550300',canonical,false);
 IF r->>'exclusion' IS DISTINCT FROM NULL THEN RAISE EXCEPTION 'Baseline eligible destination excluded (non-strict): %',r;END IF;

 -- New (round 5): a destination NO contact in the org has ever saved on any
 -- slot must fail closed under strict — bool_or over the empty slot-set is
 -- NULL, not false, so this is the case that catches a vacuous fail-open in
 -- the strict guard (coalesce(any_non_mobile,true)). This is exactly the
 -- shape the acceptance re-run (E4) hits for a destination cleared/deleted
 -- between capture and accept.
 r:=inbox_reply_preparation.destination_policy(o,'+18165559999',canonical,true);
 IF r->>'exclusion' IS DISTINCT FROM 'unclassified_phone' THEN RAISE EXCEPTION 'Strict must fail closed on an unsaved destination (no affirmative mobile evidence): %',r;END IF;

 -- Step 1: explicit sms_phone_suppressions row.
 INSERT INTO sms_phone_suppressions(org_id,phone_e164,source) VALUES(o,'+18165550300','owned_policy_test');
 r:=inbox_reply_preparation.destination_policy(o,'+18165550300',canonical,true);
 IF r->>'exclusion' IS DISTINCT FROM 'sms_suppressed' THEN RAISE EXCEPTION 'Step 1 phone suppression not enforced: %',r;END IF;
 DELETE FROM sms_phone_suppressions WHERE org_id=o AND phone_e164='+18165550300';
 r:=inbox_reply_preparation.destination_policy(o,'+18165550300',canonical,true);
 IF r->>'exclusion' IS DISTINCT FROM NULL THEN RAISE EXCEPTION 'Step 1 removal did not restore eligibility: %',r;END IF;

 -- Step 2: global_phone_dnc_registry — append-only (no DELETE/UPDATE), so
 -- "removed" is proven by a second, otherwise-identical destination that
 -- was never registered rather than by mutating this row. This is also
 -- round-4 case (b): a registry hit with NO matching contact flag at all
 -- still excludes.
 INSERT INTO contacts(id,org_id,phone_1,phone_1_type) VALUES(second,o,'+18165550301','mobile');
 INSERT INTO consent_events(org_id,contact_id,channel,event_type,source) VALUES(o,second,'sms','opt_in_confirmed','owned_policy_test');
 INSERT INTO global_phone_dnc_registry(org_id,phone_e164,first_consumer_id,first_source_event_id,first_evidence_sha256) VALUES(o,'+18165550301',gen_random_uuid(),'owned_policy_test_event',encode(sha256('owned_policy_test'::bytea),'hex'));
 r:=inbox_reply_preparation.destination_policy(o,'+18165550301',second,true);
 IF r->>'exclusion' IS DISTINCT FROM 'sms_suppressed' THEN RAISE EXCEPTION 'Step 2 global DNC registry not enforced despite no contact-level suppression flag: %',r;END IF;
 r:=inbox_reply_preparation.destination_policy(o,'+18165550300',canonical,true);
 IF r->>'exclusion' IS DISTINCT FROM NULL THEN RAISE EXCEPTION 'Unregistered destination wrongly excluded by another number''s DNC entry: %',r;END IF;

 -- Step 3: cross-contact bleed — a DIFFERENT contact record sharing the
 -- canonical destination (saved in ITS phone_2, since phone_1 has a global
 -- unique index) is flagged sms_opted_out. The canonical contact itself
 -- carries no suppression flag. (do_not_contact is deliberately excluded
 -- from this round-trip: contacts_true_dnc_lock_guard makes it a one-way
 -- lock once set, matching real compliance behavior — proven separately as
 -- insertion-only below, not toggled off.) Saved with a non-E.164 spelling
 -- (round 5) — byte-identical to the queried destination would never
 -- exercise inbox_reply_preparation.phone() normalization on this
 -- cross-contact match path; a passing match here PROVES normalization.
 INSERT INTO contacts(id,org_id,phone_2,phone_2_type,sms_opted_out) VALUES(third,o,'816-555-0300','mobile',true);
 r:=inbox_reply_preparation.destination_policy(o,'+18165550300',canonical,true);
 IF r->>'exclusion' IS DISTINCT FROM 'sms_suppressed' THEN RAISE EXCEPTION 'Step 3 cross-contact sms_opted_out bleed not enforced: %',r;END IF;
 UPDATE contacts SET sms_opted_out=false WHERE id=third;
 r:=inbox_reply_preparation.destination_policy(o,'+18165550300',canonical,true);
 IF r->>'exclusion' IS DISTINCT FROM NULL THEN RAISE EXCEPTION 'Step 3 removal did not restore eligibility: %',r;END IF;

 -- Step 4 / round-4 case (a): the SAME cross-contact slot, now saved as
 -- landline instead of flagged, still excludes — across contacts, not just
 -- across a single contact's own duplicate slots (round 3's case).
 UPDATE contacts SET phone_2_type='landline' WHERE id=third;
 r:=inbox_reply_preparation.destination_policy(o,'+18165550300',canonical,true);
 IF r->>'exclusion' IS DISTINCT FROM 'landline' THEN RAISE EXCEPTION 'Step 4 cross-contact landline slot not enforced: %',r;END IF;
 UPDATE contacts SET phone_2_type='unknown' WHERE id=third;
 r:=inbox_reply_preparation.destination_policy(o,'+18165550300',canonical,true);
 IF r->>'exclusion' IS DISTINCT FROM 'unclassified_phone' THEN RAISE EXCEPTION 'Step 4/strict cross-contact unclassified slot not enforced: %',r;END IF;
 r:=inbox_reply_preparation.destination_policy(o,'+18165550300',canonical,false);
 IF r->>'exclusion' IS DISTINCT FROM NULL THEN RAISE EXCEPTION 'Non-strict wrongly excluded an unclassified (non-landline) cross-contact slot: %',r;END IF;
 UPDATE contacts SET phone_2=NULL WHERE id=third;
 r:=inbox_reply_preparation.destination_policy(o,'+18165550300',canonical,true);
 IF r->>'exclusion' IS DISTINCT FROM NULL THEN RAISE EXCEPTION 'Step 4 removal did not restore eligibility: %',r;END IF;

 -- Strict gate, canonical no-consent: independent of steps 1-4, gated only
 -- by strict. The canonical contact here has never had a consent_events row.
 DELETE FROM consent_events WHERE org_id=o AND contact_id=canonical;
 r:=inbox_reply_preparation.destination_policy(o,'+18165550300',canonical,true);
 IF r->>'exclusion' IS DISTINCT FROM 'no_consent' THEN RAISE EXCEPTION 'Strict no-consent gate not enforced: %',r;END IF;
 r:=inbox_reply_preparation.destination_policy(o,'+18165550300',canonical,false);
 IF r->>'exclusion' IS DISTINCT FROM NULL THEN RAISE EXCEPTION 'Non-strict wrongly excluded a no-consent-but-otherwise-clean destination: %',r;END IF;
 INSERT INTO consent_events(org_id,contact_id,channel,event_type,source) VALUES(o,canonical,'sms','opt_in_confirmed','owned_policy_test');
 r:=inbox_reply_preparation.destination_policy(o,'+18165550300',canonical,true);
 IF r->>'exclusion' IS DISTINCT FROM NULL THEN RAISE EXCEPTION 'Restoring consent did not restore eligibility: %',r;END IF;

 -- Step 3, do_not_contact variant, insertion-only and LAST: once set,
 -- contacts_true_dnc_lock_guard makes do_not_contact a one-way lock (cannot
 -- be cleared, and a locked contact cannot be deleted either), so this
 -- permanently excludes the destination for the rest of this block — proven
 -- on a dedicated fourth contact rather than reusing 'third' or 'canonical'.
 INSERT INTO contacts(id,org_id,phone_2,phone_2_type,do_not_contact) VALUES(fourth,o,'+18165550300','mobile',true);
 r:=inbox_reply_preparation.destination_policy(o,'+18165550300',canonical,true);
 IF r->>'exclusion' IS DISTINCT FROM 'sms_suppressed' THEN RAISE EXCEPTION 'Step 3 cross-contact do_not_contact bleed not enforced: %',r;END IF;
END $policy$;
-- Round 6: canonical-keyed suppression closes the reproduced fail-open where
-- a canonical contact's OWN suppression flag/opt-out is invisible because
-- its phone slot was cleared while a SECOND org contact still saves the
-- destination on another slot, keeping the cross-contact scan matching (and
-- therefore eligible) purely on the second contact's clean record.
DO $canonical$
DECLARE o uuid:=gen_random_uuid();foreign_org uuid:=gen_random_uuid();canonical uuid:=gen_random_uuid();second uuid:=gen_random_uuid();fresh uuid:=gen_random_uuid();foreign_contact uuid:=gen_random_uuid();dest text:='+18165550400';r jsonb;
BEGIN
 INSERT INTO organizations(id,name) VALUES(o,'Owned canonical suppression'),(foreign_org,'Foreign canonical suppression');
 INSERT INTO contacts(id,org_id,phone_1,phone_1_type) VALUES(canonical,o,dest,'mobile');
 INSERT INTO consent_events(org_id,contact_id,channel,event_type,source) VALUES(o,canonical,'sms','opt_in_confirmed','owned_canonical_test');
 -- Second org contact keeps the destination alive on its own slot, clean and
 -- opted in, so the pre-existing cross-contact scan alone stays satisfied
 -- throughout R1-R3 below and cannot be the thing masking a failure.
 INSERT INTO contacts(id,org_id,phone_2,phone_2_type) VALUES(second,o,dest,'mobile');
 INSERT INTO consent_events(org_id,contact_id,channel,event_type,source) VALUES(o,second,'sms','opt_in_confirmed','owned_canonical_test');

 -- R0 control: slot present, opted in.
 r:=inbox_reply_preparation.destination_policy(o,dest,canonical,true);
 IF r->>'exclusion' IS DISTINCT FROM NULL THEN RAISE EXCEPTION 'R0 control excluded (strict): %',r;END IF;
 r:=inbox_reply_preparation.destination_policy(o,dest,canonical,false);
 IF r->>'exclusion' IS DISTINCT FROM NULL THEN RAISE EXCEPTION 'R0 control excluded (non-strict): %',r;END IF;

 -- R1: clear the canonical's own slot AND flag it sms_opted_out. Proves the
 -- FLAG drives the result, not the (now cleared) slot.
 UPDATE contacts SET phone_1=NULL,sms_opted_out=true WHERE id=canonical;
 r:=inbox_reply_preparation.destination_policy(o,dest,canonical,true);
 IF r->>'exclusion' IS DISTINCT FROM 'sms_suppressed' THEN RAISE EXCEPTION 'R1 cleared-slot sms_opted_out canonical admitted (strict): %',r;END IF;
 r:=inbox_reply_preparation.destination_policy(o,dest,canonical,false);
 IF r->>'exclusion' IS DISTINCT FROM 'sms_suppressed' THEN RAISE EXCEPTION 'R1 cleared-slot sms_opted_out canonical admitted (non-strict): %',r;END IF;
 UPDATE contacts SET sms_opted_out=false WHERE id=canonical;
 r:=inbox_reply_preparation.destination_policy(o,dest,canonical,true);
 IF r->>'exclusion' IS DISTINCT FROM NULL THEN RAISE EXCEPTION 'R1 flag removal did not restore eligibility (strict): %',r;END IF;
 r:=inbox_reply_preparation.destination_policy(o,dest,canonical,false);
 IF r->>'exclusion' IS DISTINCT FROM NULL THEN RAISE EXCEPTION 'R1 flag removal did not restore eligibility (non-strict): %',r;END IF;

 -- R2: slot still cleared (from R1). Insert a consent opt_out. Proves
 -- "latest", not "any" — a later opt-in must override it.
 INSERT INTO consent_events(org_id,contact_id,channel,event_type,source) VALUES(o,canonical,'sms','opt_out','owned_canonical_test');
 r:=inbox_reply_preparation.destination_policy(o,dest,canonical,true);
 IF r->>'exclusion' IS DISTINCT FROM 'sms_suppressed' THEN RAISE EXCEPTION 'R2 cleared-slot latest opt_out canonical admitted (strict): %',r;END IF;
 r:=inbox_reply_preparation.destination_policy(o,dest,canonical,false);
 IF r->>'exclusion' IS DISTINCT FROM 'sms_suppressed' THEN RAISE EXCEPTION 'R2 cleared-slot latest opt_out canonical admitted (non-strict): %',r;END IF;
 -- occurred_at defaults to now(), fixed for the whole transaction, so both
 -- events would tie without an explicit later timestamp; the tie-break
 -- itself prefers opt-out, which would mask this proving "latest" at all.
 INSERT INTO consent_events(org_id,contact_id,channel,event_type,source,occurred_at) VALUES(o,canonical,'sms','opt_in_confirmed','owned_canonical_test',clock_timestamp()+interval '1 second');
 r:=inbox_reply_preparation.destination_policy(o,dest,canonical,true);
 IF r->>'exclusion' IS DISTINCT FROM NULL THEN RAISE EXCEPTION 'R2 later opt-in did not restore eligibility (strict): %',r;END IF;
 r:=inbox_reply_preparation.destination_policy(o,dest,canonical,false);
 IF r->>'exclusion' IS DISTINCT FROM NULL THEN RAISE EXCEPTION 'R2 later opt-in did not restore eligibility (non-strict): %',r;END IF;

 -- R3: a FRESH canonical contact. Clear its slot in ONE statement, then set
 -- do_not_contact in a SEPARATE statement — contacts_true_dnc_lock_guard
 -- rejects combining them. Insertion-only (do_not_contact is a one-way
 -- lock), placed LAST.
 INSERT INTO contacts(id,org_id,phone_3,phone_3_type) VALUES(fresh,o,dest,'mobile');
 INSERT INTO consent_events(org_id,contact_id,channel,event_type,source) VALUES(o,fresh,'sms','opt_in_confirmed','owned_canonical_test');
 UPDATE contacts SET phone_3=NULL WHERE id=fresh;
 UPDATE contacts SET do_not_contact=true WHERE id=fresh;
 r:=inbox_reply_preparation.destination_policy(o,dest,fresh,true);
 IF r->>'exclusion' IS DISTINCT FROM 'sms_suppressed' THEN RAISE EXCEPTION 'R3 cleared-slot do_not_contact canonical admitted (strict): %',r;END IF;
 r:=inbox_reply_preparation.destination_policy(o,dest,fresh,false);
 IF r->>'exclusion' IS DISTINCT FROM 'sms_suppressed' THEN RAISE EXCEPTION 'R3 cleared-slot do_not_contact canonical admitted (non-strict): %',r;END IF;

 -- R4: a canonical contact id that does not resolve in this org at all —
 -- nonexistent, and a real contact that exists but in a DIFFERENT org.
 INSERT INTO contacts(id,org_id,phone_1,phone_1_type) VALUES(foreign_contact,foreign_org,'+18165550401','mobile');
 r:=inbox_reply_preparation.destination_policy(o,dest,gen_random_uuid(),true);
 IF r->>'exclusion' IS DISTINCT FROM 'contact_unavailable' THEN RAISE EXCEPTION 'R4 nonexistent canonical contact admitted (strict): %',r;END IF;
 r:=inbox_reply_preparation.destination_policy(o,dest,gen_random_uuid(),false);
 IF r->>'exclusion' IS DISTINCT FROM 'contact_unavailable' THEN RAISE EXCEPTION 'R4 nonexistent canonical contact admitted (non-strict): %',r;END IF;
 r:=inbox_reply_preparation.destination_policy(o,dest,foreign_contact,true);
 IF r->>'exclusion' IS DISTINCT FROM 'contact_unavailable' THEN RAISE EXCEPTION 'R4 cross-org canonical contact admitted (strict): %',r;END IF;
 r:=inbox_reply_preparation.destination_policy(o,dest,foreign_contact,false);
 IF r->>'exclusion' IS DISTINCT FROM 'contact_unavailable' THEN RAISE EXCEPTION 'R4 cross-org canonical contact admitted (non-strict): %',r;END IF;
END $canonical$;
ROLLBACK;
"""
sql(context.removesuffix('COMMIT;\n')+recipient.removesuffix('COMMIT;\n').replace('\nBEGIN;\n','\n',1)+batch.removesuffix('COMMIT;\n').replace('\nBEGIN;\n','\n',1)+test)
if sql("SELECT to_regnamespace('inbox_reply_context') IS NULL AND to_regnamespace('inbox_reply_preparation') IS NULL")!='t':raise RuntimeError('Rollback failed')
(P/'recipient-evidence.json').write_text(json.dumps({'source_sha256':hashlib.sha256(recipient.encode()).hexdigest(),'batch_sha256':hashlib.sha256(batch.encode()).hexdigest(),'context_sha256':hashlib.sha256(context.encode()).hexdigest(),'runner_sha256':hashlib.sha256(Path(__file__).read_bytes()).hexdigest(),'checks':['canonical contact, normalized saved destination, sender inventory and variables','read status leaves known-reply content revision unchanged','edited inbound advances reply revision','foreign and missing target denied without head allocation','landline and unsaved destination excluded','never-classified line type fails closed (unclassified_phone), not silently eligible','conflicting duplicate save (same destination saved as mobile AND landline) fails closed on every matching slot, not just the first by ordinal','inactive inventory sender excluded','canonical consent opt-out excluded','saved mobile with zero consent history fails closed (no_consent), not silently eligible','private API grants denied; whole proof rolled back','same destination flags every affected conversation; no silent deduplication','duplicate/null/empty target rejection','winter opening and closing boundaries','summer DST, territory and unknown state policy','51 canonical destinations blocked, 50 after one opt-out exclusion retained in review','501 target envelope rejected','destination_policy() E1-E4 convergence matrix: sms_phone_suppressions, global_phone_dnc_registry with no contact-level flag (round-4 case b), cross-contact do_not_contact/sms_opted_out bleed, cross-contact landline/unclassified slot on a SECOND contact saved with a non-E.164 spelling to prove phone() normalization on the cross-contact match path (round-4 case a), both strict-only gates (unclassified-phone, canonical no-consent) each independently inserted-and-excluded then removed-and-eligible-again, and (round 5) a destination NO contact has ever saved on any slot failing closed under strict (empty slot-set, bool_or NULL coalesced to true — the vacuous fail-open the acceptance re-run path would hit without recipient()\'s own masks)','(round 6) canonical-keyed suppression: R0 control eligible both modes; R1 a cleared-slot canonical flagged sms_opted_out excluded both modes purely on the flag (kept eligible by a second org contact still saving the destination), restored on flag removal; R2 the same cleared-slot canonical with a latest consent opt_out excluded both modes, restored by a strictly LATER opt_in_confirmed (proving latest-wins, not any-wins); R3 a fresh canonical with its slot cleared then do_not_contact set in a separate statement (DNC ratchet trigger) excluded both modes, insertion-only; R4 a nonexistent and a cross-org canonical contact id both return the new contact_unavailable fail-closed label, both modes; and the latest_sms_consent(o,for_contact) helper extraction itself caught a real parameter/column name collision bug (ce.contact_id=contact_id resolving to the column, not the argument) via this same mutation pass'],'limits':['Private recipient capture only; not public preparation or dispatch authorization','Batch limit signal is not acceptance enforcement; immutable approval and actual dispatch still required','No provider call or production change']},indent=2)+'\n')
print('Nineteen actual canonical recipient/batch groups passed; all new schema/data rolled back')
