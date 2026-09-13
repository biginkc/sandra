#!/usr/bin/env python3
"""Canonical-trigger proof, entirely rolled back in the marked owned database."""
import hashlib,json,subprocess,sys
from pathlib import Path
P=Path(__file__).resolve().parent
sys.path.insert(0,str(P.parent/'inbox-projection'/'fixture'))
from guards import validate_container,validate_cron
if sys.argv[1:]!=['--run-owned-fixture']: raise SystemExit('Explicit owned fixture required')
D=['docker','--host','unix:///Users/jarradhenry/.colima/inbox-redesign-20260913/docker.sock']
N='sandra-inbox-projection-t2-db'
validate_container(json.loads(subprocess.check_output(D+['inspect',N],text=True))[0])
def sql(q):
 r=subprocess.run(D+['exec','-i',N,'psql','-XqAt','-U','postgres','-d','postgres','-v','ON_ERROR_STOP=1'],input=q,text=True,capture_output=True,timeout=35)
 if r.returncode: raise RuntimeError(r.stderr)
 return r.stdout.strip()
validate_cron(sql('SHOW cron.launch_active_jobs'))
if sql('SELECT marker FROM inbox_t2_fixture.identity')!='sandra-inbox-projection-t2-owned-synthetic': raise RuntimeError('Wrong fixture')
if sql("SELECT to_regnamespace('inbox_reply_context') IS NULL")!='t': raise RuntimeError('Refusing existing context schema')
source=(P/'context.sql').read_text()
if not source.endswith('COMMIT;\n'): raise RuntimeError('Expected transaction boundary')
test=r"""
DO $test$
DECLARE o uuid:=gen_random_uuid();foreign_org uuid:=gen_random_uuid();sender uuid:=gen_random_uuid();p uuid:=gen_random_uuid();missing uuid:=gen_random_uuid();before_count bigint;before_version bigint;value jsonb;role_name text;
BEGIN
 INSERT INTO public.organizations(id,name) VALUES(o,'Reply context owned'),(foreign_org,'Reply context foreign');
 INSERT INTO public.provider_sender_numbers(id,org_id,provider,phone_e164,status) VALUES(sender,o,'sendillo','+15550008888','active');
 INSERT INTO public.properties(id,org_id,address,state,market) VALUES(p,o,'Owned reply context','MO','KC');
 SELECT revision INTO before_version FROM inbox_reply_context.versions WHERE org_id=o AND namespace='sender_inventory' AND target_id=sender;
 UPDATE public.provider_sender_numbers SET last_synced_at=clock_timestamp(),raw='{"irrelevant":true}' WHERE id=sender;
 IF (SELECT revision FROM inbox_reply_context.versions WHERE org_id=o AND namespace='sender_inventory' AND target_id=sender)<>before_version THEN RAISE EXCEPTION 'Display sync invalidated reply';END IF;
 UPDATE public.provider_sender_numbers SET status='inactive' WHERE id=sender;
 UPDATE public.provider_sender_numbers SET status='active' WHERE id=sender;
 IF (SELECT revision FROM inbox_reply_context.versions WHERE org_id=o AND namespace='sender_inventory' AND target_id=sender)<>before_version+2 THEN RAISE EXCEPTION 'Sender ABA lost';END IF;
 DELETE FROM public.provider_sender_numbers WHERE id=sender;
 INSERT INTO public.provider_sender_numbers(id,org_id,provider,phone_e164,status) VALUES(sender,o,'sendillo','+15550008888','active');
 IF (SELECT revision FROM inbox_reply_context.versions WHERE org_id=o AND namespace='sender_inventory' AND target_id=sender)<>before_version+4 THEN RAISE EXCEPTION 'Delete reinsert reset counter';END IF;
 UPDATE public.provider_sender_numbers SET org_id=foreign_org WHERE id=sender;
 UPDATE public.provider_sender_numbers SET org_id=o WHERE id=sender;
 IF (SELECT revision FROM inbox_reply_context.versions WHERE org_id=o AND namespace='sender_inventory' AND target_id=sender)<>before_version+6 OR (SELECT revision FROM inbox_reply_context.versions WHERE org_id=foreign_org AND namespace='sender_inventory' AND target_id=sender)<>2 THEN RAISE EXCEPTION 'Tenant move ABA lost';END IF;
 UPDATE public.organizations SET name='Renamed' WHERE id=o;
 UPDATE public.properties SET market='STL' WHERE id=p;
 IF (SELECT revision FROM inbox_reply_context.versions WHERE org_id=o AND namespace='organization_name' AND target_id=o)<>2 OR (SELECT revision FROM inbox_reply_context.versions WHERE org_id=o AND namespace='property_market' AND target_id=p)<>2 THEN RAISE EXCEPTION 'Personalization dependency lost';END IF;
 SELECT count(*) INTO before_count FROM inbox_reply_context.versions;
 IF inbox_reply_context.snapshot(o,'sender_inventory',missing) IS NOT NULL OR inbox_reply_context.snapshot(foreign_org,'property_market',p) IS NOT NULL THEN RAISE EXCEPTION 'Invalid source admitted';END IF;
 IF (SELECT count(*) FROM inbox_reply_context.versions)<>before_count THEN RAISE EXCEPTION 'Missing source allocated persistent counter';END IF;
 -- Remove only our new test row's counter to model an existing pre-trigger row.
 DELETE FROM inbox_reply_context.versions WHERE org_id=o AND namespace='property_market' AND target_id=p;
 value:=inbox_reply_context.snapshot(o,'property_market',p);
 IF value->>'revision'<>'1' OR value->'value'->>'market'<>'STL' THEN RAISE EXCEPTION 'Historical baseline not established';END IF;
 UPDATE public.properties SET market='KC' WHERE id=p;
 value:=inbox_reply_context.snapshot(o,'property_market',p);
 IF value->>'revision'<>'2' OR value->'value'->>'market'<>'KC' THEN RAISE EXCEPTION 'Snapshot reset existing revision';END IF;
 FOREACH role_name IN ARRAY ARRAY['anon','authenticated','service_role'] LOOP
  IF has_schema_privilege(role_name,'inbox_reply_context','USAGE') OR EXISTS(SELECT 1 FROM pg_proc f JOIN pg_namespace n ON n.oid=f.pronamespace WHERE n.nspname='inbox_reply_context' AND has_function_privilege(role_name,f.oid,'EXECUTE')) THEN RAISE EXCEPTION 'Private context browser privilege';END IF;
 END LOOP;
END $test$;
ROLLBACK;
"""
sql(source.removesuffix('COMMIT;\n')+test)
if sql("SELECT to_regnamespace('inbox_reply_context') IS NULL")!='t': raise RuntimeError('Proof failed rollback')
checks=['sender sync metadata does not invalidate route','sender status ABA and deletion/reinsert retain monotonic revisions','tenant move-out/back captures both identities','organization name and property market changes captured','missing/foreign sources allocate no counters','historical baseline insert-once and current snapshot','private effective grants denied','entire schema and canonical test data rolled back']
(P/'context-evidence.json').write_text(json.dumps({'source_sha256':hashlib.sha256(source.encode()).hexdigest(),'runner_sha256':hashlib.sha256(Path(__file__).read_bytes()).hexdigest(),'checks':checks,'limitations':['No actual concurrent snapshot wait proof yet','No production schema or reply activation','Dispatch eligibility and sender provider contract remain separate gates']},indent=2)+'\n')
print('Eight actual canonical reply-context groups passed; all changes rolled back')
